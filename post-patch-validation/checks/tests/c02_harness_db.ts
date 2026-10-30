/**
 * L4-C02 control (both revisions must pass): the DB/HTTP harness works.
 * A throwaway Postgres was migrated by the project's own db/migrate.ts, the
 * real Fastify app (buildApp) boots against it, a finance admin can log in
 * through password + OTP, and benign uploads whose outcome the patch must
 * not change behave as expected: a zero-amount row (201, recorded, nothing
 * journaled) and a non-UUID merchant id (400 before anything is applied).
 */
import { closeHarness, createMerchant, csv, getRows, importRowsDb, openHarness, postCsv, signedInAdmin, sinkCounts, uniqueFilename } from "./_db.js";
import { diag, finish, run } from "./_lib.js";

run(async () => {
  const failures: string[] = [];
  const h = await openHarness();
  try {
    const migrations = await h.pool.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM information_schema.tables WHERE table_name IN
         ('adjustment_imports','adjustment_import_rows','ledger_entries','merchant_balances','admin_audit_log')`,
    );
    if (migrations.rows[0]!.n !== "5") failures.push(`expected the 5 import tables to exist, found ${migrations.rows[0]!.n}`);

    const admin = await signedInAdmin(h, "finance");
    const merchantId = await createMerchant(h);
    const filename = uniqueFilename("c02");

    const ok = await postCsv(h, admin.cookie, csv([[merchantId, "0", "control"]]), filename);
    diag(`zero-row upload: ${ok.statusCode} ${ok.body}`);
    if (ok.statusCode !== 201) failures.push(`zero-row upload returned ${ok.statusCode}`);
    const body = JSON.parse(ok.body) as { importId?: string; rowCount?: number; totalPostedFils?: number };
    if (body.rowCount !== 1 || body.totalPostedFils !== 0) failures.push(`zero-row body ${ok.body}`);
    if (body.importId) {
      const rows = await getRows(h, admin.cookie, body.importId);
      if (rows.statusCode !== 200) failures.push(`GET rows returned ${rows.statusCode}`);
      const db = await importRowsDb(h, body.importId);
      if (db.length !== 1 || db[0]!.parsed !== "0" || db[0]!.group !== null || db[0]!.raw !== "0") {
        failures.push(`zero row persisted as ${JSON.stringify(db)}`);
      }
    }

    const other = await createMerchant(h);
    const badFile = uniqueFilename("c02-bad");
    const bad = await postCsv(h, admin.cookie, csv([[other, "1.00", "ok"], ["not-a-uuid", "1.00", "x"]]), badFile);
    diag(`non-uuid upload: ${bad.statusCode} ${bad.body}`);
    if (bad.statusCode !== 400 || (JSON.parse(bad.body) as { error?: string }).error !== "invalid_csv_row") {
      failures.push(`non-UUID upload returned ${bad.statusCode} ${bad.body}`);
    }
    const counts = await sinkCounts(h, { merchantIds: [other], filename: badFile });
    for (const [table, n] of Object.entries(counts)) {
      if (n !== 0) failures.push(`non-UUID upload left ${n} rows in ${table}`);
    }

    const anon = await postCsv(h, null, csv([[other, "1.00"]]));
    if (anon.statusCode !== 401) failures.push(`unauthenticated upload returned ${anon.statusCode}`);
  } finally {
    await closeHarness(h);
  }
  finish(failures);
});
