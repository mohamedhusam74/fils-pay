/**
 * L4-S05 security (must pass on both revisions): the patch changes which
 * rows count as zero ('0.005', '-0.001' were 0 on base and now post 5 / -1
 * fils) and the scale of the rest. State invariants must hold whatever the
 * scale. Merchant A rows '4.75', '-1.25', '0.00', '0.005', '-0.001', '2';
 * merchant B row '3.333'. For each merchant: a row has a ledger group iff
 * its parsed amount is non-zero; each group is exactly two balanced legs of
 * |parsed| on that row's merchant with the sign-correct direction (credit
 * merchant_payable for > 0, debit for < 0); no group mixes merchants; the
 * cache delta = sum of parsed = the ledger-walk rebuild. Response total =
 * audit total = sum of parsed (signed, as the code computes it), and
 * adjustment_imports.row_count = 7.
 */
import { auditMetadata, cachedPayable, closeHarness, createMerchant, csv, groupProblems, importRowsDb, ledgerLegs, openHarness, postCsv, rebuildBalance, signedInAdmin, uniqueFilename } from "./_db.js";
import { diag, finish, run } from "./_lib.js";

run(async () => {
  const failures: string[] = [];
  const h = await openHarness();
  try {
    const admin = await signedInAdmin(h, "finance");
    const a = await createMerchant(h);
    const b = await createMerchant(h);
    const filename = uniqueFilename("s05");
    const res = await postCsv(
      h,
      admin.cookie,
      csv([[a, "4.75"], [a, "-1.25"], [a, "0.00"], [a, "0.005"], [a, "-0.001"], [a, "2"], [b, "3.333"]]),
      filename,
    );
    diag(`POST: ${res.statusCode} ${res.body}`);
    if (res.statusCode !== 201) throw new Error(`upload failed: ${res.statusCode} ${res.body}`);
    const body = JSON.parse(res.body) as { importId: string; totalPostedFils: number };
    const rows = await importRowsDb(h, body.importId);
    diag(`rows ${JSON.stringify(rows.map((r) => [r.raw, r.parsed, r.group !== null]))}`);
    let grand = 0n;
    for (const merchant of [a, b]) {
      const mine = rows.filter((r) => r.merchantId === merchant);
      const legs = await ledgerLegs(h, merchant);
      const sum = mine.reduce((acc, r) => acc + BigInt(r.parsed), 0n);
      grand += sum;
      for (const r of mine) {
        const p = BigInt(r.parsed);
        if ((p === 0n) !== (r.group === null)) failures.push(`row ${r.rowNumber} (${r.raw}) parsed ${r.parsed} but group ${r.group}`);
        if (r.group !== null) {
          const magnitude = Number(p < 0n ? -p : p);
          failures.push(...groupProblems(legs, r.group, magnitude, p > 0n ? 1 : -1).map((x) => `row ${r.rowNumber}: ${x}`));
        }
      }
      const groups = new Set(mine.filter((r) => r.group !== null).map((r) => r.group));
      for (const l of legs) if (!groups.has(l.group)) failures.push(`merchant leg in group ${l.group} not owned by its rows`);
      const cache = await cachedPayable(h, merchant);
      const rebuild = await rebuildBalance(h, merchant);
      diag(`merchant ${merchant === a ? "A" : "B"}: sum ${sum} cache ${cache} rebuild ${rebuild} legs ${legs.length}`);
      if (cache !== String(sum) || rebuild !== String(sum)) failures.push(`merchant ${merchant === a ? "A" : "B"}: cache ${cache}, rebuild ${rebuild}, sum of parsed ${sum}`);
    }
    const audit = await auditMetadata(h, filename);
    const header = await h.pool.query<{ row_count: number }>(`SELECT row_count FROM adjustment_imports WHERE id = $1`, [body.importId]);
    diag(`response total ${body.totalPostedFils} audit ${JSON.stringify(audit)} row_count ${header.rows[0]?.row_count}`);
    if (String(body.totalPostedFils) !== String(grand)) failures.push(`response totalPostedFils ${body.totalPostedFils} != sum of parsed ${grand}`);
    if (audit.length !== 1 || audit[0]!.totalPostedFils !== body.totalPostedFils) failures.push(`audit ${JSON.stringify(audit)} != response total ${body.totalPostedFils}`);
    if (header.rows[0]?.row_count !== 7) failures.push(`adjustment_imports.row_count ${header.rows[0]?.row_count}, expected 7`);
  } finally {
    await closeHarness(h);
  }
  finish(failures);
});
