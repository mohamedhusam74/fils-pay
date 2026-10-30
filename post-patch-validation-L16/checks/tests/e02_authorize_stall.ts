/**
 * L16-E02 exploit. Buyer 1's authorize outlasts the reservation timeout;
 * buyer 2 re-claims the link and pays; buyer 1 then resumes and (on the
 * vulnerable code) captures and gets 200 'paid' although the link records
 * buyer 2's transaction. Run three times on fresh links.
 *
 * Safety assertion (single-use invariant only): per link, the acquirer
 * approves at most one capture, at most one pay-path capture is recorded,
 * and every 200 'paid' answer names the transaction the link records.
 * Side-blind.
 */
import { diag, finish, out, reached, run } from "./_lib.js";
import { closeHarness, openHarness, raceTwoBuyers, singleUseViolations, spyFinalizeInvariantLog, summarize } from "./_h.js";

run(async () => {
  const spy = spyFinalizeInvariantLog();
  const h = await openHarness();
  const violations: string[] = [];
  try {
    for (let i = 1; i <= 3; i++) {
      const r = await raceTwoBuyers(h, "authorize");
      diag(`run ${i}: ${summarize(r.responses)} rejections=${JSON.stringify(r.rejections)} approved=${r.ledger.approvedCount}`);
      out(`run ${i}: ${summarize(r.responses)}`);
      if (r.rejections.length > 0) throw new Error(`unexpected rejection: ${r.rejections.join("; ")}`);
      for (const v of await singleUseViolations(h, r.link.linkId, r.ledger, r.responses)) violations.push(`run ${i}: ${v}`);
    }
    diag(`finalize-0-rows log count=${spy.count()}`);
  } finally {
    await closeHarness(h);
  }
  reached();
  finish(violations);
});
