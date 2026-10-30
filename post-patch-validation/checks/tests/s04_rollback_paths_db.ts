/**
 * L4-S04 security (must pass on both revisions): amounts are parsed inside
 * the per-row loop, after INSERT adjustment_imports and after earlier rows'
 * ledger, cache and row writes; ROLLBACK in withTransaction is the only
 * cleanup. Two cleanup paths, both revisions:
 *  (A) AppError: merchant A has a prior committed balance C0. Uploads of
 *      [A '5.00', B '2.00', A <bad>] with <bad> rejected on both revisions
 *      ('abc', '4.75abc', '90071992547409.92') are not 2xx and leave A's
 *      rows/legs/cache exactly as before, nothing for B, no import header
 *      and no audit row for the filename.
 *  (B) non-AppError: 11 rows of '9000000000000.000' overflow addFils's
 *      safe-integer total after that row's writes ran (row 11 on base,
 *      row 2 on the patch). Not 2xx, no internal detail in the body, and
 *      nothing persisted.
 */
import { cachedPayable, closeHarness, createMerchant, csv, openHarness, postCsv, signedInAdmin, sinkCounts, uniqueFilename } from "./_db.js";
import { diag, finish, run } from "./_lib.js";

run(async () => {
  const failures: string[] = [];
  const h = await openHarness();
  try {
    const admin = await signedInAdmin(h, "finance");
    const a = await createMerchant(h);
    const seed = await postCsv(h, admin.cookie, csv([[a, "1.00", "seed"]]), uniqueFilename("s04-seed"));
    if (seed.statusCode !== 201) throw new Error(`seed upload failed: ${seed.statusCode} ${seed.body}`);
    const c0 = await cachedPayable(h, a);
    const before = await sinkCounts(h, { merchantIds: [a] });
    for (const bad of ["abc", "4.75abc", "90071992547409.92"]) {
      const b = await createMerchant(h);
      const filename = uniqueFilename("s04a");
      const res = await postCsv(h, admin.cookie, csv([[a, "5.00", "x"], [b, "2.00", "y"], [a, bad, "z"]]), filename);
      const afterA = await sinkCounts(h, { merchantIds: [a] });
      const forB = await sinkCounts(h, { merchantIds: [b], filename });
      const cache = await cachedPayable(h, a);
      diag(`(A) ${JSON.stringify(bad)}: ${res.statusCode} ${res.body}; A ${JSON.stringify(afterA)} cache ${cache} (C0 ${c0}); B/file ${JSON.stringify(forB)}`);
      if (res.statusCode >= 200 && res.statusCode < 300) failures.push(`(A) ${bad}: upload committed (${res.statusCode})`);
      for (const t of ["ledger_entries", "merchant_balances", "adjustment_import_rows"]) {
        if (afterA[t] !== before[t]) failures.push(`(A) ${bad}: merchant A ${t} ${before[t]} -> ${afterA[t]}`);
      }
      if (cache !== c0) failures.push(`(A) ${bad}: merchant A cache ${c0} -> ${cache}`);
      for (const [t, n] of Object.entries(forB)) if (n !== 0) failures.push(`(A) ${bad}: ${n} row(s) in ${t} for B/filename`);
    }

    const m = await createMerchant(h);
    const filename = uniqueFilename("s04b");
    const rows = Array.from({ length: 11 }, (_, i): [string, string, string] => [m, "9000000000000.000", `big ${i + 1}`]);
    const res = await postCsv(h, admin.cookie, csv(rows), filename);
    const counts = await sinkCounts(h, { merchantIds: [m], filename });
    diag(`(B) overflow: ${res.statusCode} ${res.body}; ${JSON.stringify(counts)}`);
    if (res.statusCode >= 200 && res.statusCode < 300) failures.push(`(B) overflowing batch committed (${res.statusCode})`);
    for (const leak of ["toFils", "safe integer", "9000000000000", "RangeError"]) {
      if (res.body.includes(leak)) failures.push(`(B) response body leaks ${JSON.stringify(leak)}: ${res.body}`);
    }
    for (const [t, n] of Object.entries(counts)) if (n !== 0) failures.push(`(B) ${n} row(s) left in ${t}`);
  } finally {
    await closeHarness(h);
  }
  finish(failures);
});
