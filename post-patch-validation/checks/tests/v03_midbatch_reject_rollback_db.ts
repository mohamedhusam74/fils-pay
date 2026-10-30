/**
 * L4-V03 variant (fails on base, passes on patch): the error/teardown path
 * of the newly rejected class. Rows [A '5.000', B '2.000', A '4.7555']:
 * by the time row 3 is parsed, rows 1-2 have already written
 * adjustment_imports, ledger_entries, merchant_balances and
 * adjustment_import_rows inside the transaction. '4.7555' BD is not a whole
 * number of fils, so the import must not commit anything: the response is
 * not 2xx and every sink is empty for A, B, the filename and the admin.
 * Base truncates it to 475 and commits the whole batch.
 */
import { closeHarness, createMerchant, csv, openHarness, postCsv, signedInAdmin, sinkCounts, uniqueFilename } from "./_db.js";
import { diag, finish, reached, run } from "./_lib.js";

run(async () => {
  const h = await openHarness();
  try {
    const admin = await signedInAdmin(h, "finance");
    const a = await createMerchant(h);
    const b = await createMerchant(h);
    const filename = uniqueFilename("v03");
    const res = await postCsv(h, admin.cookie, csv([[a, "5.000", "ok"], [b, "2.000", "ok"], [a, "4.7555", "bad"]]), filename);
    diag(`POST: ${res.statusCode} ${res.body}`);
    const counts = await sinkCounts(h, { merchantIds: [a, b], filename, adminId: admin.id });
    diag(`sink counts ${JSON.stringify(counts)}`);

    reached();
    const failures: string[] = [];
    if (res.statusCode >= 200 && res.statusCode < 300) failures.push(`a batch containing 4.7555 BD committed (${res.statusCode})`);
    for (const [table, n] of Object.entries(counts)) if (n !== 0) failures.push(`${n} row(s) left in ${table}`);
    finish(failures);
  } finally {
    await closeHarness(h);
  }
});
