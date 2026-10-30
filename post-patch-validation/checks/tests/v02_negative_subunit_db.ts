/**
 * L4-V02 variant (fails on base, passes on patch): the negative branch.
 * Base turns '-0.005' into -0, which hits `amountFils === 0` in
 * postLedgerAdjustment, silently dropping a real debit, and posts '-1.001'
 * as -100. ADR-0001: rows parse to [-5, -1001], each gets a ledger group
 * of merchant_payable debit / contra credit of |amount|, the cache moves by
 * -1006 and the ledger-walk rebuild agrees.
 */
import { cachedPayable, closeHarness, createMerchant, csv, groupProblems, importRowsDb, ledgerLegs, openHarness, postCsv, rebuildBalance, signedInAdmin, uniqueFilename } from "./_db.js";
import { diag, finish, reached, run } from "./_lib.js";

run(async () => {
  const h = await openHarness();
  try {
    const admin = await signedInAdmin(h, "finance");
    const merchantId = await createMerchant(h);
    const res = await postCsv(h, admin.cookie, csv([[merchantId, "-0.005", "debit a"], [merchantId, "-1.001", "debit b"]]), uniqueFilename("v02"));
    diag(`POST: ${res.statusCode} ${res.body}`);
    const body = JSON.parse(res.body) as { importId?: string };
    const rows = body.importId ? await importRowsDb(h, body.importId) : [];
    const legs = await ledgerLegs(h, merchantId);
    const cache = await cachedPayable(h, merchantId);
    const rebuild = await rebuildBalance(h, merchantId);
    diag(`rows ${JSON.stringify(rows.map((r) => ({ raw: r.raw, parsed: r.parsed, group: r.group !== null })))}`);
    diag(`legs ${JSON.stringify(legs.map((l) => [l.account, l.direction, l.amount]))} cache ${cache} rebuild ${rebuild}`);

    reached();
    const failures: string[] = [];
    if (res.statusCode !== 201) failures.push(`upload returned ${res.statusCode}, expected 201`);
    if (JSON.stringify(rows.map((r) => r.parsed)) !== JSON.stringify(["-5", "-1001"])) failures.push(`parsed_amount_fils ${JSON.stringify(rows.map((r) => r.parsed))}, expected ["-5","-1001"]`);
    rows.forEach((r, i) => {
      const want = [5, 1001][i] as number;
      if (r.group === null) failures.push(`row ${r.rowNumber} (${r.raw}) has no ledger group (debit dropped)`);
      else failures.push(...groupProblems(legs, r.group, want, -1));
    });
    if (cache !== "-1006") failures.push(`cached_payable_fils ${cache}, expected -1006`);
    if (rebuild !== "-1006") failures.push(`ledger-walk rebuild ${rebuild}, expected -1006`);
    finish(failures);
  } finally {
    await closeHarness(h);
  }
});
