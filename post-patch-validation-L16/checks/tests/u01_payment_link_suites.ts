/**
 * L16-U01 suite (patched first; baseline only if it fails): the project's
 * own tests for the changed component, run with its runner exactly as
 * apps/api's `npm test` does (tsx --test --test-concurrency=1), against
 * this check's throwaway Postgres migrated by this revision's own
 * db/migrate.ts: paymentLinks/pay.test.ts, paymentLinks/status.test.ts,
 * routes/paymentLinks.test.ts (happy path, decline release, expiry, cancel,
 * list, the hand-built timeout-replay test), payments/idempotency.test.ts,
 * routes/analytics.test.ts (explicit-column INSERT into payment_links) and
 * the patch's own paymentLinks/payReservation.test.ts where present (not
 * independent evidence). Then `tsc --noEmit -p apps/api` on this revision's
 * tree (tsx strips types without checking them). Passes iff every runner
 * exits 0 with no failures.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { diag, finish, out, run, runProjectTests } from "./_lib.js";

run(async () => {
  const failures: string[] = [];
  const tree = process.env.L16_TREE ?? "";
  const nm = process.env.L16_NODE_MODULES ?? "";
  const apiDir = path.join(tree, "apps", "api");
  const files = [
    "src/paymentLinks/pay.test.ts",
    "src/paymentLinks/status.test.ts",
    "src/routes/paymentLinks.test.ts",
    "src/payments/idempotency.test.ts",
    "src/routes/analytics.test.ts",
    "src/paymentLinks/payReservation.test.ts",
  ].filter((f) => {
    const present = fs.existsSync(path.join(apiDir, f));
    if (!present) diag(`${f} is not present in this revision; skipped`);
    return present;
  });
  const r = await runProjectTests(apiDir, files);
  for (const t of r.tests) out(`${t.ok ? "ok" : "not ok"}: ${t.name}`);
  out(`apps/api tests: exit ${r.code} ${JSON.stringify(r.summary)}`);
  if (r.code !== 0 || (r.summary.fail ?? 0) !== 0 || !r.summary.pass) failures.push(`apps/api tests: exit ${r.code} ${JSON.stringify(r.summary)}`);
  for (const t of r.tests.filter((x) => !x.ok)) diag(`FAILED ${t.name}\n${t.diagnostics.join("\n")}`);

  const tsc = spawnSync(process.execPath, [path.join(nm, "typescript", "bin", "tsc"), "--noEmit", "-p", apiDir], { cwd: tree, encoding: "utf8" });
  diag(`tsc --noEmit -p apps/api exit ${tsc.status}\n${tsc.stdout}${tsc.stderr}`);
  out(`tsc --noEmit -p apps/api: exit ${tsc.status}`);
  if (tsc.status !== 0) failures.push(`tsc --noEmit -p apps/api exited ${tsc.status}: ${tsc.stdout.split("\n").slice(0, 5).join(" | ")}`);
  finish(failures);
});
