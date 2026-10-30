/**
 * L4-C03 control (both revisions must pass): the project's own test runner
 * executes, in this revision's tree, the tests the patch did not change and
 * that cover the changed component's neighbours without a database:
 * apps/api/src/admin/adjustmentCsvParsing.test.ts (CSV splitter, 'not-a-number'
 * and '' rejection) and the frozen packages/money suite (parseBhdToFils
 * >3-decimal rejection, toFils guards). Proves the per-tree runner, tsx and
 * module resolution work on both sides.
 */
import fs from "node:fs";
import path from "node:path";
import { diag, finish, run, runProjectTests } from "./_lib.js";

run(async () => {
  const failures: string[] = [];
  const tree = process.env.L4_TREE ?? "";
  const api = await runProjectTests(path.join(tree, "apps", "api"), ["src/admin/adjustmentCsvParsing.test.ts"]);
  diag(`apps/api parser tests: exit ${api.code} ${JSON.stringify(api.summary)}`);
  if (api.code !== 0 || api.summary.fail !== 0 || !api.summary.pass) failures.push(`adjustmentCsvParsing.test.ts: exit ${api.code} ${JSON.stringify(api.summary)}`);

  const moneyDir = path.join(tree, "packages", "money");
  const moneyFiles = fs
    .readdirSync(path.join(moneyDir, "src"))
    .filter((f) => f.endsWith(".test.ts"))
    .sort()
    .map((f) => `src/${f}`);
  const money = await runProjectTests(moneyDir, moneyFiles);
  diag(`packages/money tests (${moneyFiles.join(", ")}): exit ${money.code} ${JSON.stringify(money.summary)}`);
  if (money.code !== 0 || money.summary.fail !== 0 || !money.summary.pass) failures.push(`packages/money: exit ${money.code} ${JSON.stringify(money.summary)}`);
  finish(failures);
});
