/**
 * L4-V04 variant (fails on base, passes on patch): the integer boundary the
 * x10 rescale moved. Per row: '9007199254740.991' BD is exactly
 * Number.MAX_SAFE_INTEGER fils and '9007199254740.992' is beyond it; each
 * must be parsed exactly or rejected (base posts both as 900719925474099).
 * Across rows: two rows of '9007199254740.991' for one merchant exceed the
 * safe range in the running total; the upload may only succeed if every
 * persisted amount is exact, and if it fails nothing may persist.
 */
import { parseAdjustmentAmountFils } from "../src/admin/adjustmentCsvParsing.js";
import { closeHarness, createMerchant, csv, openHarness, postCsv, signedInAdmin, sinkCounts, uniqueFilename } from "./_db.js";
import { attempt, diag, exactOrRejectViolation, finish, reached, run, showOutcome } from "./_lib.js";

const MAX_BD = "9007199254740.991";

run(async () => {
  const pure = [MAX_BD, "9007199254740.992", `-${MAX_BD}`, "-9007199254740.992"].map((input) => ({ input, got: attempt(parseAdjustmentAmountFils, input) }));
  for (const p of pure) diag(`parseAdjustmentAmountFils(${p.input}) = ${showOutcome(p.got)}`);
  const h = await openHarness();
  try {
    const admin = await signedInAdmin(h, "finance");
    const m = await createMerchant(h);
    const filename = uniqueFilename("v04");
    const res = await postCsv(h, admin.cookie, csv([[m, MAX_BD, "max"], [m, MAX_BD, "max again"]]), filename);
    diag(`POST two max rows: ${res.statusCode} ${res.body}`);
    const counts = await sinkCounts(h, { merchantIds: [m], filename, adminId: admin.id });
    const persisted = await h.pool.query<{ p: string }>(`SELECT parsed_amount_fils::text AS p FROM adjustment_import_rows WHERE merchant_id = $1 ORDER BY row_number`, [m]);
    diag(`sink counts ${JSON.stringify(counts)} persisted ${JSON.stringify(persisted.rows.map((r) => r.p))}`);

    reached();
    const failures = pure.map((p) => exactOrRejectViolation(p.input, p.got)).filter((v): v is string => v !== null);
    const ok = res.statusCode >= 200 && res.statusCode < 300;
    if (ok) {
      for (const r of persisted.rows) if (r.p !== "9007199254740991") failures.push(`committed row posted ${r.p} fils for ${MAX_BD} BD (exact: 9007199254740991)`);
    } else {
      for (const [table, n] of Object.entries(counts)) if (n !== 0) failures.push(`failed upload (${res.statusCode}) left ${n} row(s) in ${table}`);
    }
    finish(failures);
  } finally {
    await closeHarness(h);
  }
});
