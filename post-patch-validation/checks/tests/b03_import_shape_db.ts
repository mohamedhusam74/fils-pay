/**
 * L4-B03 behavior (stdout byte-identical on both revisions): persistence and
 * HTTP contracts the patch must not change, printed as canonical JSON with
 * every random id replaced by a placeholder.
 *  (a) zero family '0', '0.00', '-0', '-0.000': 201, every row recorded
 *      with parsedAmountFils 0 and a null ledger group, no ledger legs, a
 *      zero cache row, audit totalPostedFils 0 (base's -0 must not leak).
 *  (b) amounts rejected on both revisions, after a valid first row: exact
 *      status and raw body, and nothing left in any sink.
 *  (c) non-amount columns: response key set, rowCount, per-row rowNumber,
 *      rawAmountText (verbatim, including a service-level ' 4.75 '), reason
 *      and whether a ledger group exists. Amount values are excluded: they
 *      change x10 by design.
 */
import { applyAdjustmentImport } from "../src/admin/adjustmentImport.js";
import { auditMetadata, cachedPayable, closeHarness, createMerchant, csv, getRows, ledgerLegs, openHarness, postCsv, signedInAdmin, sinkCounts, uniqueFilename } from "./_db.js";
import { canonical, out, run } from "./_lib.js";

interface RowDetail {
  rowNumber: number;
  merchantId: string;
  rawAmountText: string;
  parsedAmountFils: number;
  reason: string | null;
  ledgerEntryGroupId: string | null;
}

run(async () => {
  const h = await openHarness();
  try {
    const admin = await signedInAdmin(h, "finance");

    // (a) zero family
    {
      const m = await createMerchant(h);
      const filename = uniqueFilename("b03a");
      const res = await postCsv(h, admin.cookie, csv([[m, "0", "z1"], [m, "0.00", "z2"], [m, "-0", "z3"], [m, "-0.000", "z4"]]), filename);
      const body = JSON.parse(res.body) as { importId?: string; rowCount?: number; totalPostedFils?: number };
      const rows = body.importId ? await getRows(h, admin.cookie, body.importId) : null;
      const detail = rows ? (JSON.parse(rows.body) as { rows: RowDetail[] }).rows.map((r) => ({ ...r, merchantId: r.merchantId === m ? "<m>" : r.merchantId })) : null;
      const audit = (await auditMetadata(h, filename)).map((a) => ({ ...a, originalFilename: a.originalFilename === filename ? "<file>" : a.originalFilename }));
      out(`zero-family ${canonical({
        status: res.statusCode,
        body: { ...body, importId: body.importId ? "<id>" : null },
        rowsStatus: rows?.statusCode ?? null,
        rows: detail,
        rowsBodyHasMinusZero: rows ? rows.body.includes("-0") : null,
        responseHasMinusZero: res.body.includes(":-0"),
        ledgerLegs: (await ledgerLegs(h, m)).length,
        cachedPayable: await cachedPayable(h, m),
        audit,
      })}`);
    }

    // (b) rejected on both revisions
    for (const bad of ["abc", "4.75abc", "+1.00", ".5", "1e3", "Infinity"]) {
      const m = await createMerchant(h);
      const filename = uniqueFilename("b03b");
      const res = await postCsv(h, admin.cookie, csv([[m, "1.00", "ok"], [m, bad, "bad"]]), filename);
      const counts = await sinkCounts(h, { merchantIds: [m], filename });
      out(`rejected ${JSON.stringify(bad)} ${canonical({ status: res.statusCode, body: res.body, counts })}`);
    }

    // (c) non-amount columns
    {
      const m = await createMerchant(h);
      const res = await postCsv(
        h,
        admin.cookie,
        csv([[m, "4.750", "statement correction"], [m, "4.75"], [m, "007.5", "x"], [m, "120", "y"], [m, "-1.25", "z"]]),
        uniqueFilename("b03c"),
      );
      const body = JSON.parse(res.body) as { importId?: string; rowCount?: number };
      const rows = body.importId ? await getRows(h, admin.cookie, body.importId) : null;
      const projected = rows
        ? (JSON.parse(rows.body) as { rows: RowDetail[] }).rows.map((r) => ({
            rowNumber: r.rowNumber,
            merchant: r.merchantId === m ? "<m>" : r.merchantId,
            rawAmountText: r.rawAmountText,
            reason: r.reason,
            hasLedgerGroup: r.ledgerEntryGroupId !== null,
            keys: Object.keys(r),
          }))
        : null;
      out(`columns ${canonical({ status: res.statusCode, responseKeys: Object.keys(body), rowCount: body.rowCount, rowsStatus: rows?.statusCode ?? null, rows: projected })}`);

      const direct = await applyAdjustmentImport(h.pool, {
        adminUserId: admin.id,
        originalFilename: uniqueFilename("b03c-direct"),
        rows: [{ merchantId: m, amount: " 4.75 " }],
      });
      const raw = await h.pool.query<{ raw_amount_text: string }>(`SELECT raw_amount_text FROM adjustment_import_rows WHERE adjustment_import_id = $1`, [direct.importId]);
      out(`verbatim-raw ${canonical({ resultKeys: Object.keys(direct), rowCount: direct.rowCount, raw: raw.rows.map((r) => r.raw_amount_text) })}`);
    }
  } finally {
    await closeHarness(h);
  }
  process.exit(0);
});
