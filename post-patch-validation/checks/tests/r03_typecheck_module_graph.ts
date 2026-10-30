/**
 * L4-R03 regression (both revisions must pass): deleting
 * apps/api/src/lib/decimal.ts must leave no dangling import. tsx strips
 * types without checking them, so: (1) `tsc --noEmit -p apps/api` on this
 * revision's tree exits 0; (2) the full app module graph (src/app.ts ->
 * routes -> admin/adjustmentImport -> admin/adjustmentCsvParsing) loads;
 * (3) every source file that still references lib/decimal or
 * parseDecimalMinor does so only where lib/decimal.ts exists.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { diag, finish, run } from "./_lib.js";

function walk(dir: string, acc: string[]): string[] {
  if (!fs.existsSync(dir)) return acc;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "__ppv__") continue;
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(p, acc);
    else if (/\.(ts|tsx|js|mjs)$/.test(entry.name)) acc.push(p);
  }
  return acc;
}

run(async () => {
  const failures: string[] = [];
  const tree = process.env.L4_TREE ?? "";
  const nm = process.env.L4_NODE_MODULES ?? "";

  const tsc = spawnSync(process.execPath, [path.join(nm, "typescript", "bin", "tsc"), "--noEmit", "-p", path.join(tree, "apps", "api")], {
    cwd: tree,
    encoding: "utf8",
  });
  diag(`tsc --noEmit -p apps/api exit ${tsc.status}\n${tsc.stdout}${tsc.stderr}`);
  if (tsc.status !== 0) failures.push(`tsc --noEmit -p apps/api exited ${tsc.status}: ${tsc.stdout.split("\n").slice(0, 5).join(" | ")}`);

  try {
    const app = (await import("../src/app.js")) as { buildApp?: unknown };
    if (typeof app.buildApp !== "function") failures.push("src/app.ts does not export buildApp");
  } catch (err) {
    failures.push(`loading src/app.ts failed: ${(err as Error).message}`);
  }

  const decimalExists = fs.existsSync(path.join(tree, "apps", "api", "src", "lib", "decimal.ts"));
  const files = ["apps/api/src", "packages", "scripts", "db"].flatMap((d) => walk(path.join(tree, d), []));
  const refs = files.filter((f) => /lib\/decimal|parseDecimalMinor/.test(fs.readFileSync(f, "utf8")));
  const rel = refs.map((f) => path.relative(tree, f)).sort();
  diag(`lib/decimal.ts present: ${decimalExists}; files referencing lib/decimal or parseDecimalMinor: ${JSON.stringify(rel)}`);
  if (!decimalExists && rel.length > 0) failures.push(`lib/decimal.ts is gone but still referenced by ${rel.join(", ")}`);
  finish(failures);
});
