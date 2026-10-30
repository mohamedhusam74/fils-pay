/**
 * L16-V03 variant: capture outcome unknown to the API. The acquirer approves
 * buyer 1's capture, then the local capture fails (transport error after the
 * acquirer's response): captureTransaction's transaction rolls back and
 * payPaymentLink rejects without releasing or finalizing. After the
 * reservation timeout a second buyer tries the same link. If the link can
 * be re-claimed while buyer 1's capture outcome is unknown, the acquirer
 * approves a second capture for one single-use link.
 *
 * Safety assertion: approved acquirer captures for the link's buyers <= 1
 * (plus the rest of the single-use invariant). Side-blind.
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
      const b1 = makeBuyer(h.sim, ledger, { capture: "throw-after" });
      const b2 = makeBuyer(h.sim, ledger, {});
      const r1 = await settle(pay(h, b1.acquirer, link.token, CARDS.approved));
      if (r1.ok) throw new Error(`run ${i}: buyer1 was expected to reject (capture threw) but returned ${r1.value.statusCode}`);
      diag(`run ${i}: buyer1 rejected: ${errorMessage(r1.error)} approvedSoFar=${ledger.approvedCount} link=${JSON.stringify(await linkState(h, link.linkId))}`);
      await age(h, link.linkId, 61);
      const r2 = await settle(pay(h, b2.acquirer, link.token, CARDS.approved2));
      if (!r2.ok) throw new Error(`run ${i}: buyer2 rejected unexpectedly: ${errorMessage(r2.error)}`);
      const responses: PayResponse[] = [asResponse("buyer2", r2.value)];
      diag(`run ${i}: ${summarize(responses)} approved=${ledger.approvedCount} link=${JSON.stringify(await linkState(h, link.linkId))}`);
      out(`run ${i}: buyer1=rejected ${summarize(responses)}`);
      for (const v of await singleUseViolations(h, link.linkId, ledger, responses)) violations.push(`run ${i}: ${v}`);
    }
  } finally {
    await closeHarness(h);
  }
  reached();
  finish(violations);
});
