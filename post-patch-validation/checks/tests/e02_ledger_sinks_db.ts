/**
 * L4-E02 exploit (fails on base, passes on patch): the harm in the money
 * sinks, through the real route. A finance admin uploads rows '4.755' and
 * '0.005' for a fresh merchant. ADR-0001 requires every sink to carry the
 * exact fils: adjustment_import_rows.parsed_amount_fils [4755, 5], a
 * ledger group for BOTH rows (base skips '0.005' as 0), balanced legs of
 * 4755 and 5 (contra debit / merchant_payable credit),
 * merchant_balances.cached_payable_fils 4760, the response and audit
 * totalPostedFils 4760, GET /:id/rows parsedAmountFils [4755, 5], and the
 * Go settlement ledger-walk rebuild (apps/settlement/internal/ledger/rebuild.go
 * SQL, verbatim) 4760, so cache and ledger agree.
 */
import {
  auditMetadata,
  cachedPayable,
  closeHarness,
  createMerchant,
  csv,
  getRows,
  groupProblems,
  importRowsDb,
  ledgerLegs,
  openHarness,
  postCsv,
  rebuildBalance,
  signedInAdmin,
  uniqueFilename,
} from "./_db.js";
import { diag, finish, reached, run } from "./_lib.js";

run(async () => {
  const h = await openHarness();
  try {
    const admin = await signedInAdmin(h, "finance");
    const merchantId = await createMerchant(h);
    const filename = uniqueFilename("e02");
    const res = await postCsv(h, admin.cookie, csv([[merchantId, "4.755", "sub-unit a"], [merchantId, "0.005", "sub-unit b"]]), filename);
    diag(`POST: ${res.statusCode} ${res.body}`);
    const body = JSON.parse(res.body) as { importId?: string; totalPostedFils?: number };
    const rows = body.importId ? await importRowsDb(h, body.importId) : [];
    const api = body.importId ? await getRows(h, admin.cookie, body.importId) : null;
    const apiParsed = api && api.statusCode === 200 ? (JSON.parse(api.body) as { rows: Array<{ parsedAmountFils: number }> }).rows.map((r) => r.parsedAmountFils) : null;
    const legs = await ledgerLegs(h, merchantId);
    const cache = await cachedPayable(h, merchantId);
    const rebuild = await rebuildBalance(h, merchantId);
    const audit = await auditMetadata(h, filename);
    diag(`rows ${JSON.stringify(rows.map((r) => ({ raw: r.raw, parsed: r.parsed, group: r.group !== null })))}`);
    diag(`legs ${JSON.stringify(legs.map((l) => [l.account, l.direction, l.amount]))}`);
    diag(`cache ${cache} rebuild ${rebuild} audit ${JSON.stringify(audit)} GET rows parsed ${JSON.stringify(apiParsed)}`);

    reached();
    const failures: string[] = [];
    if (res.statusCode !== 201) failures.push(`upload returned ${res.statusCode}, expected 201`);
    if (body.totalPostedFils !== 4760) failures.push(`response totalPostedFils ${body.totalPostedFils}, expected 4760`);
    if (JSON.stringify(rows.map((r) => r.parsed)) !== JSON.stringify(["4755", "5"])) failures.push(`parsed_amount_fils ${JSON.stringify(rows.map((r) => r.parsed))}, expected ["4755","5"]`);
    rows.forEach((r, i) => {
      const want = [4755, 5][i] as number;
      if (r.group === null) failures.push(`row ${r.rowNumber} (${r.raw}) has no ledger group`);
      else failures.push(...groupProblems(legs, r.group, want, 1));
    });
    if (legs.length !== 4) failures.push(`${legs.length} ledger legs, expected 4`);
    if (cache !== "4760") failures.push(`cached_payable_fils ${cache}, expected 4760`);
    if (rebuild !== "4760") failures.push(`ledger-walk rebuild ${rebuild}, expected 4760`);
    if (audit.length !== 1 || audit[0]!.totalPostedFils !== 4760) failures.push(`audit metadata ${JSON.stringify(audit)}, expected one row with totalPostedFils 4760`);
    if (JSON.stringify(apiParsed) !== "[4755,5]") failures.push(`GET /:id/rows parsedAmountFils ${JSON.stringify(apiParsed)}, expected [4755,5]`);
    finish(failures);
  } finally {
    await closeHarness(h);
  }
});
