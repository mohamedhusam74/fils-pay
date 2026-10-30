/**
 * L16-V02 variant: the re-claimer declines, so the link goes back to
 * 'active' while the stale holder is still in flight. Buyer 1 (approved)
 * stalls in authorize; its reservation times out; buyer 2 (declined card)
 * re-claims, is declined, and releases the link to 'active'. Buyer 1 then
 * resumes against an 'active' row (not another reservation), and buyer 3
 * pays afterwards. A holder that is not bound to its own reservation
 * captures, finalizes 0 rows, still answers 200 'paid', and leaves the link
 * payable again.
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
  linkState,
  makeBuyer,
  openHarness,
  pay,
  settle,
  singleUseViolations,
  summarize,
  type PayResponse,
} from "./_h.js";

run(async () => {
  const h = await openHarness();
  const violations: string[] = [];
  try {
    for (let i = 1; i <= 2; i++) {
      const link = await createLink(h);
      const ledger = new CaptureLedger();
      const b1 = makeBuyer(h.sim, ledger, { stallAt: "authorize" });
      const b2 = makeBuyer(h.sim, ledger, {});
      const b3 = makeBuyer(h.sim, ledger, {});
      const p1 = settle(pay(h, b1.acquirer, link.token, CARDS.approved));
      await b1.waitParked(`run ${i} buyer1`);
      await age(h, link.linkId, 61);
      const r2 = await settle(pay(h, b2.acquirer, link.token, CARDS.declined));
      const afterDecline = await linkState(h, link.linkId);
      b1.release();
      const r1 = await p1;
      const afterBuyer1 = await linkState(h, link.linkId);
      const r3 = await settle(pay(h, b3.acquirer, link.token, CARDS.approved3));
      const responses: PayResponse[] = [];
      for (const [name, r] of [["buyer1", r1], ["buyer2", r2], ["buyer3", r3]] as const) {
        if (!r.ok) throw new Error(`run ${i} ${name} rejected unexpectedly: ${errorMessage(r.error)}`);
        responses.push(asResponse(name, r.value));
      }
      diag(`run ${i}: ${summarize(responses)} afterDecline=${JSON.stringify(afterDecline)} afterBuyer1=${JSON.stringify(afterBuyer1)} approved=${ledger.approvedCount}`);
      out(`run ${i}: ${summarize(responses)}`);
      for (const v of await singleUseViolations(h, link.linkId, ledger, responses)) violations.push(`run ${i}: ${v}`);
    }
  } finally {
    await closeHarness(h);
  }
  reached();
  finish(violations);
});
