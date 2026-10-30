/**
 * L4-U02 suite (patched first; baseline only if it fails): the complete
 * apps/api test suite, run exactly as `npm test -w @filspay/api` does
 * (`tsx --test --test-concurrency=1 "src/**\/*.test.ts"`), serially, against
 * this check's own throwaway Postgres migrated from this revision's
 * db/migrations. Passes iff the runner exits 0 with a complete summary.
 */
import { diag, out, run, runProjectTests } from "./_lib.js";

run(async () => {
  const result = await runProjectTests(process.cwd(), ["src/**/*.test.ts"]);
  const failing = result.tests.filter((t) => !t.ok);
  for (const t of failing) out(`not ok: ${t.file ?? "?"} :: ${t.name}`);
  out(`summary ${JSON.stringify(result.summary)} exit=${result.code}`);
  if (result.summary.tests === undefined || result.summary.fail === undefined) {
    diag("the test runner did not print a complete summary");
    process.exit(3);
  }
  process.exit(result.code === 0 && result.summary.fail === 0 ? 0 : 1);
});
