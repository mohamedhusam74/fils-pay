/**
 * L4-C01 control (both revisions must pass): the pure harness loads the
 * revision's own parseAdjustmentAmountFils / parseAdjustmentCsv (through
 * @filspay/money resolved INSIDE the copied tree), the frozen packages/money
 * and the migrations are byte-identical to the base commit in this checkout,
 * and benign inputs whose result the patch must not change behave the same.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseAdjustmentAmountFils, parseAdjustmentCsv } from "../src/admin/adjustmentCsvParsing.js";
import { attempt, diag, finish, run } from "./_lib.js";

run(() => {
  const failures: string[] = [];
  const tree = fs.realpathSync(process.env.L4_TREE ?? "");
  const checkout = process.env.L4_CHECKOUT ?? "";

  // 1. Module resolution stays inside the copied tree of this revision.
  const resolved = [
    import.meta.resolve("@filspay/money"),
    import.meta.resolve("../src/admin/adjustmentCsvParsing.js"),
    import.meta.resolve("../src/lib/errors.js"),
  ];
  for (const url of resolved) {
    const file = fileURLToPath(url);
    const real = fs.existsSync(file) ? fs.realpathSync(file) : file;
    diag(`resolved ${url} -> ${real}`);
    if (!real.startsWith(tree + path.sep)) failures.push(`${url} resolves outside the tree under test: ${real}`);
  }

  // 2. Frozen package and migrations are unchanged relative to the base commit (HEAD of the checkout).
  for (const p of ["packages/money", "db/migrations", "apps/api/src/admin/adjustmentImport.ts", "apps/api/src/routes/adminAdjustmentImport.ts"]) {
    const r = spawnSync("git", ["-C", checkout, "diff", "--quiet", "HEAD", "--", p]);
    if (r.status !== 0) failures.push(`${p} differs from HEAD in this checkout (git diff exit ${r.status})`);
  }

  // 3. Benign behavior of the changed component that must be identical on both revisions.
  const zero = attempt(parseAdjustmentAmountFils, "0");
  if (!(zero.ok && Object.is(zero.value, 0))) failures.push(`parse("0") = ${JSON.stringify(zero)}, expected +0`);
  const abc = attempt(parseAdjustmentAmountFils, "abc");
  if (abc.ok || abc.statusCode !== 400 || abc.code !== "invalid_amount") {
    failures.push(`parse("abc") = ${JSON.stringify(abc)}, expected a 400 invalid_amount rejection`);
  }
  const rows = parseAdjustmentCsv("merchantId,amount,reason\nm-1,1.00,ok\nm-2,0\n");
  const expectedRows = [
    { merchantId: "m-1", amount: "1.00", reason: "ok" },
    { merchantId: "m-2", amount: "0" },
  ];
  if (JSON.stringify(rows) !== JSON.stringify(expectedRows)) failures.push(`parseAdjustmentCsv = ${JSON.stringify(rows)}`);

  finish(failures);
});
