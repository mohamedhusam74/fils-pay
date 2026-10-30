/**
 * L16-S01 security (must hold on both revisions): the reverse lock order of
 * L16-V04. Buyer 1 stalls in authorize; its reservation is backdated past
 * the timeout; buyer 1 is released and its second `UPDATE payment_links`
 * (the pin on the patched code, the finalize on the base code) runs inside
 * an explicit transaction kept uncommitted. Buyer 2's timeout re-claim then
 * blocks on that row lock (confirmed via pg_stat_activity) before the held
 * statement commits. Postgres re-checks buyer 2's WHERE clause against the
 * committed row: the patch must not open a new double-capture window here.
 * Repeated 10 times. Asserts the single-use invariant and that exactly one
 * buyer was answered 200.
 */
import { diag, finish, run } from "./_lib.js";
import {
  CARDS,
  CaptureLedger,
  age,
  asResponse,
  closeHarness,
  createLink,
  errorMessage,
  holdNthLinkUpdate,
  makeBuyer,
  openHarness,
  pay,
  settle,
  singleUseViolations,
  summarize,
  waitLockWaiters,
  type PayResponse,
} from "./_h.js";

run(async () => {
  const h = await openHarness({ poolMax: 16 });
  const failures: string[] = [];
  try {
    for (let i = 1; i <= 10; i++) {
      const link = await createLink(h);
      const ledger = new CaptureLedger();
      const b1 = makeBuyer(h.sim, ledger, { stallAt: "authorize" });
      const b2 = makeBuyer(h.sim, ledger, {});
      const held = holdNthLinkUpdate(h.pool, 2);
      const p1 = settle(pay(h, b1.acquirer, link.token, CARDS.approved, undefined, held.pool));
      await b1.waitParked(`run ${i} buyer1`);
      await age(h, link.linkId, 61);
      b1.release();
      await held.waitHeld(`run ${i} buyer1's second payment_links UPDATE`);
      const p2 = settle(pay(h, b2.acquirer, link.token, CARDS.approved2));
      await waitLockWaiters(h.pool, 1, `run ${i} buyer2's claim`);
      held.commit();
      const [r1, r2] = await Promise.all([p1, p2]);
      const responses: PayResponse[] = [];
      for (const [name, r] of [["buyer1", r1], ["buyer2", r2]] as const) {
        if (!r.ok) throw new Error(`run ${i} ${name} rejected unexpectedly: ${errorMessage(r.error)}`);
        responses.push(asResponse(name, r.value));
      }
      diag(`run ${i}: ${summarize(responses)} approved=${ledger.approvedCount}`);
      for (const v of await singleUseViolations(h, link.linkId, ledger, responses)) failures.push(`run ${i}: ${v}`);
      const oks = responses.filter((r) => r.statusCode === 200).length;
      if (oks !== 1) failures.push(`run ${i}: ${oks} buyers were answered 200 (expected exactly 1): ${summarize(responses)}`);
    }
  } finally {
    await closeHarness(h);
  }
  finish(failures);
});
