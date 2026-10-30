/**
 * L4-R05 regression (both revisions must pass): the patch rewrote expected
 * values in two existing test files, so those edits are not evidence on
 * their own. This runs the BASE versions of both files (git show HEAD:...,
 * HEAD being the base commit in either checkout) with the project's runner
 * against this revision's code and a fresh DB. Every failing test must be
 * one of the four whose literals the patch rescaled, and every failing
 * assertion must differ only by actual == 10 x expected. On base nothing
 * fails; on the patch exactly the rescaled assertions fail, by 10x. Any
 * other failure means the edits hid a different behaviour change.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { diag, finish, run, runProjectTests } from "./_lib.js";

const FILES = ["src/admin/adjustmentImport.test.ts", "src/routes/adminAdjustmentImport.test.ts"];
const RESCALED = new Set([
  "applyAdjustmentImport records the batch and its rows",
  "applyAdjustmentImport reverses leg direction for a negative amount",
  "applyAdjustmentImport updates the merchant balance cache",
  "a valid CSV upload returns 201 and applies every row",
]);

/** Integers in a YAML key's block (e.g. "expected:"), quoted strings removed. */
function blockInts(lines: string[], key: string): bigint[] | null {
  const i = lines.findIndex((l) => new RegExp(`^\\s*${key}:`).test(l));
  if (i < 0) return null;
  const indent = (lines[i] as string).length - (lines[i] as string).trimStart().length;
  const block = [(lines[i] as string).replace(new RegExp(`^\\s*${key}:`), "")];
  for (let j = i + 1; j < lines.length; j++) {
    const l = lines[j] as string;
    if (l.trim() !== "" && l.length - l.trimStart().length <= indent) break;
    block.push(l);
  }
  return (block.join("\n").replace(/'[^']*'|"[^"]*"/g, "").match(/-?\d+/g) ?? []).map((x) => BigInt(x));
}

run(async () => {
  const failures: string[] = [];
  const tree = process.env.L4_TREE ?? "";
  const checkout = process.env.L4_CHECKOUT ?? "";
  const apiDir = path.join(tree, "apps", "api");
  const copies: string[] = [];
  for (const f of FILES) {
    const shown = spawnSync("git", ["-C", checkout, "show", `HEAD:apps/api/${f}`], { encoding: "utf8" });
    if (shown.status !== 0) throw new Error(`git show HEAD:apps/api/${f} failed: ${shown.stderr}`);
    const copy = f.replace(/\.test\.ts$/, ".ppvbase.test.ts");
    fs.writeFileSync(path.join(apiDir, copy), shown.stdout);
    copies.push(copy);
  }
  const result = await runProjectTests(apiDir, copies);
  diag(`base test files on this revision: exit ${result.code} ${JSON.stringify(result.summary)}`);
  if (result.summary.tests === undefined || !result.summary.pass) failures.push(`runner did not complete: ${JSON.stringify(result.summary)}`);
  for (const t of result.tests.filter((x) => !x.ok)) {
    diag(`not ok: ${t.name}\n${t.diagnostics.join("\n")}`);
    if (!RESCALED.has(t.name)) {
      failures.push(`unexpected failure: ${t.name}`);
      continue;
    }
    const expected = blockInts(t.diagnostics, "expected");
    const actual = blockInts(t.diagnostics, "actual");
    if (!expected || !actual || expected.length === 0 || expected.length !== actual.length) {
      failures.push(`${t.name}: could not pair actual/expected integers (${String(actual)} vs ${String(expected)})`);
      continue;
    }
    let tenX = 0;
    expected.forEach((e, k) => {
      const a = actual[k] as bigint;
      if (a === e * 10n && e !== 0n) tenX++;
      else if (a !== e) failures.push(`${t.name}: actual ${a} vs expected ${e} is not a x10 rescale`);
    });
    if (tenX === 0) failures.push(`${t.name}: failed without any x10 difference`);
    diag(`${t.name}: actual ${actual.join(",")} vs base expected ${expected.join(",")}`);
  }
  finish(failures);
});
