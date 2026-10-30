/**
 * L16-B07 behavior (byte-identical stdout on both revisions): contention
 * inside the reservation timeout looks the same as before. Buyer 1 stalls
 * in authorize (not yet pinned) or in capture (pinned on the patched code);
 * without any backdating, buyer 2 is refused with exactly 409
 * {"error":"payment_link_processing"}; buyer 1 then completes 200 'paid'
 * and the link records one capture of the full amount.
 */
import { canonical, finish, out, run } from "./_lib.js";
import {
  CARDS,
  CaptureLedger,
  asResponse,
  closeHarness,
  createLink,
  errorMessage,
  linkCapturedEvents,
  linkState,
  makeBuyer,
  openHarness,
  pay,
  settle,
  stableBody,
} from "./_h.js";

run(async () => {
  const h = await openHarness();
  try {
    for (const step of ["authorize", "capture"] as const) {
      const link = await createLink(h);
      const ledger = new CaptureLedger();
      const b1 = makeBuyer(h.sim, ledger, { stallAt: step });
      const p1 = settle(pay(h, b1.acquirer, link.token, CARDS.approved));
      await b1.waitParked(`buyer1 at ${step}`);
      const r2 = asResponse("buyer2", await pay(h, makeBuyer(h.sim, ledger, {}).acquirer, link.token, CARDS.approved2));
      b1.release();
      const s1 = await p1;
      if (!s1.ok) throw new Error(`buyer1 rejected: ${errorMessage(s1.error)}`);
      const r1 = asResponse("buyer1", s1.value);
      const state = await linkState(h, link.linkId);
      out(canonical({
        step,
        buyer2: { statusCode: r2.statusCode, body: r2.body },
        buyer1: { statusCode: r1.statusCode, body: stableBody(r1.body), matches: r1.body.transactionId === state.transactionId },
        link: state.status,
        captures: await linkCapturedEvents(h, link.linkId),
        approved: ledger.approvedCount,
      }));
    }
  } finally {
    await closeHarness(h);
  }
  finish([]);
});
