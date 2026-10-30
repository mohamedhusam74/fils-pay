/**
 * L4-U01 suite (patched first; baseline only if it fails): the project's
 * own tests for the changed component, run with its runner exactly as
 * `npm test` does (tsx --test --test-concurrency=1), against this check's
 * throwaway, freshly migrated Postgres: adjustmentCsvParsing.test.ts,
 * adjustmentAmountFils.test.ts (added by the patch; skipped where absent),
 * adjustmentImport.test.ts and routes/adminAdjustmentImport.test.ts (edited
 * by the patch), plus the frozen packages/money suite. Passes iff every
 * runner exits 0 with a complete summary and no failures.
 */
import fs from "node:fs";
import path from "node:path";
import { diag, finish, out, run, runProjectTests } from "./_lib.js";

run(async () => {
  const failures: string[] = [];
  const tree = process.env.L4_TREE ?? "";
  const apiDir = path.join(tree, "apps", "api");
  const apiFiles = [
    "src/admin/adjustmentCsvParsing.test.ts",
    "src/admin/adjustmentAmountFils.test.ts",
    "src/admin/adjustmentImport.test.ts",
    "src/routes/adminAdjustmentImport.test.ts",
  ].filter((f) => {
    const present = fs.existsSync(path.join(apiDir, f));
    if (!present) diag(`${f} is not present in this revision; skipped`);
    return present;
  });
  const moneyDir = path.join(tree, "packages", "money");
  const moneyFiles = fs.readdirSync(path.join(moneyDir, "src")).filter((f) => f.endsWith(".test.ts")).sort().map((f) => `src/${f}`);
  for (const [label, cwd, files] of [["apps/api", apiDir, apiFiles], ["packages/money", moneyDir, moneyFiles]] as const) {
    const r = await runProjectTests(cwd, [...files]);
    for (const t of r.tests.filter((x) => !x.ok)) out(`not ok: ${label} :: ${t.name}`);
    out(`${label}: exit ${r.code} ${JSON.stringify(r.summary)}`);
    if (r.code !== 0 || r.summary.fail !== 0 || !r.summary.pass) failures.push(`${label}: exit ${r.code} ${JSON.stringify(r.summary)}`);
  }
  finish(failures);
});
