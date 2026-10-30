/**
 * L4-R02 regression (both revisions must pass): the largest value a
 * revision accepts must round-trip with no precision loss through pg BIGINT,
 * JSON and the ledger, and the first value past its bound must be a clean
 * 4xx, never a 500. Single row '9007199254740.991': 201, and the response
 * totalPostedFils, parsed_amount_fils::text, both ledger legs'
 * amount_fils::text, cached_payable_fils::text, the audit total and GET
 * /:id/rows all carry the same safe integer. Single row
 * '9007199254740.992': either 201 with the same consistency, or exactly
 * 400 invalid_amount with nothing persisted.
 */
import { auditMetadata, cachedPayable, closeHarness, createMerchant, csv, getRows, ledgerLegs, openHarness, postCsv, signedInAdmin, sinkCounts, uniqueFilename } from "./_db.js";
import { diag, finish, run } from "./_lib.js";

run(async () => {
  const failures: string[] = [];
  const h = await openHarness();
  try {
    const admin = await signedInAdmin(h, "finance");
    for (const amt of ["9007199254740.991", "9007199254740.992"]) {
      const m = await createMerchant(h);
      const filename = uniqueFilename("r02");
      const res = await postCsv(h, admin.cookie, csv([[m, amt, "boundary"]]), filename);
      diag(`${amt}: ${res.statusCode} ${res.body}`);
      if (res.statusCode === 201) {
        const body = JSON.parse(res.body) as { importId: string; totalPostedFils: number };
        const total = body.totalPostedFils;
        const parsed = await h.pool.query<{ p: string }>(`SELECT parsed_amount_fils::text AS p FROM adjustment_import_rows WHERE adjustment_import_id = $1`, [body.importId]);
        const legs = await ledgerLegs(h, m);
        const cache = await cachedPayable(h, m);
        const audit = await auditMetadata(h, filename);
        const api = JSON.parse((await getRows(h, admin.cookie, body.importId)).body) as { rows: Array<{ parsedAmountFils: number }> };
        const values = {
          response: String(total),
          parsed: parsed.rows[0]?.p,
          legs: legs.map((l) => l.amount),
          cache,
          audit: String(audit[0]?.totalPostedFils),
          api: String(api.rows[0]?.parsedAmountFils),
        };
        diag(`${amt}: ${JSON.stringify(values)}`);
        if (!Number.isSafeInteger(total)) failures.push(`${amt}: totalPostedFils ${total} is not a safe integer`);
        const all = [values.response, values.parsed, ...values.legs, values.cache, values.audit, values.api];
        if (legs.length !== 2 || all.some((v) => v !== values.response)) failures.push(`${amt}: sinks disagree ${JSON.stringify(values)}`);
      } else {
        const want = JSON.stringify({ error: "invalid_amount", message: `could not parse amount "${amt}"` });
        if (res.statusCode !== 400 || res.body !== want) failures.push(`${amt}: got ${res.statusCode} ${res.body}, expected 201 or 400 ${want}`);
        const counts = await sinkCounts(h, { merchantIds: [m], filename });
        for (const [table, n] of Object.entries(counts)) if (n !== 0) failures.push(`${amt}: rejected upload left ${n} row(s) in ${table}`);
      }
    }
  } finally {
    await closeHarness(h);
  }
  finish(failures);
});
