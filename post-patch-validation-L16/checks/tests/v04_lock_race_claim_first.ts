/**
 * L16-V04 variant: a real row-lock race between a timeout re-claim and the
 * stale holder's next write to the link (Postgres READ COMMITTED re-checks
 * the waiting UPDATE's WHERE clause against the newly committed row).
 * Buyer 1 stalls in authorize; its reservation is backdated past the
 * timeout; buyer 2's claim UPDATE is executed inside an explicit transaction
 * and kept uncommitted (row lock held). Buyer 1 is released: its next
 * `UPDATE payment_links` blocks on that lock (confirmed through
 * pg_stat_activity). Buyer 2's claim then commits and both finish.
 * Repeated 10 times on fresh links.
 *
 * Safety assertion (single-use invariant only), per link. Side-blind.
 */
import { diag, finish, out, reached, run } from "./_lib.js";
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
  const violations: string[] = [];
  try {
    for (let i = 1; i <= 10; i++) {
      const link = await createLink(h);
      const ledger = new CaptureLedger();
      const b1 = makeBuyer(h.sim, ledger, { stallAt: "authorize" });
      const b2 = makeBuyer(h.sim, ledger, {});
      const p1 = settle(pay(h, b1.acquirer, link.token, CARDS.approved));
      await b1.waitParked(`run ${i} buyer1`);
      await age(h, link.linkId, 61);
      const held = holdNthLinkUpdate(h.pool, 1);
      const p2 = settle(pay(h, b2.acquirer, link.token, CARDS.approved2, undefined, held.pool));
      await held.waitHeld(`run ${i} buyer2 claim`);
      b1.release();
      await waitLockWaiters(h.pool, 1, `run ${i} buyer1's next payment_links UPDATE`);
      held.commit();
      const [r1, r2] = await Promise.all([p1, p2]);
      const responses: PayResponse[] = [];
      for (const [name, r] of [["buyer1", r1], ["buyer2", r2]] as const) {
        if (!r.ok) throw new Error(`run ${i} ${name} rejected unexpectedly: ${errorMessage(r.error)}`);
        responses.push(asResponse(name, r.value));
      }
      diag(`run ${i}: ${summarize(responses)} approved=${ledger.approvedCount}`);
      out(`run ${i}: ${summarize(responses)}`);
      for (const v of await singleUseViolations(h, link.linkId, ledger, responses)) violations.push(`run ${i}: ${v}`);
    }
  } finally {
    await closeHarness(h);
  }
  reached();
  finish(violations);
});
