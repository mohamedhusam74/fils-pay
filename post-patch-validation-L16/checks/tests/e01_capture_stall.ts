/**
 * L16-E01 exploit (incident 2026-05-14 shape). Buyer 1's capture outlasts
 * PAYMENT_LINK_RESERVATION_TIMEOUT_SECONDS; buyer 2 tries to pay the same
 * single-use link meanwhile; buyer 1 then resumes. Run twice: through the
 * real public route (POST /v1/payment-links/:token/pay via app.inject, the
 * app's own simulator instrumented) and through payPaymentLink directly.
 *
 * Safety assertion (single-use invariant only): per link, the acquirer
 * approves at most one capture, at most one pay-path capture is recorded,
 * and every 200 'paid' answer names the transaction the link records.
 * Side-blind: never reads PPV_SIDE or the schema.
 */
import { randomUUID } from "node:crypto";
import { diag, finish, out, reached, run } from "./_lib.js";
import {
  CARDS,
  CaptureLedger,
  age,
  closeHarness,
  createLink,
  errorMessage,
  injectPay,
  instrumentAppAcquirer,
  linkState,
  openHarness,
  raceTwoBuyers,
  settle,
  singleUseViolations,
  spyFinalizeInvariantLog,
  summarize,
  type PayResponse,
} from "./_h.js";

run(async () => {
  const spy = spyFinalizeInvariantLog();
  const h = await openHarness({ app: true });
  const violations: string[] = [];
  try {
    // (a) through the HTTP route
    const link = await createLink(h);
    const ledger = new CaptureLedger();
    const gate = instrumentAppAcquirer(h.app!, ledger, { stallAt: "capture" });
    const p1 = settle(injectPay(h.app!, "route-buyer1", link.token, CARDS.approved, randomUUID()));
    await gate.waitParked("route buyer1 at capture");
    await age(h, link.linkId, 61);
    const r2 = await injectPay(h.app!, "route-buyer2", link.token, CARDS.approved2, randomUUID());
    gate.release();
    const r1 = await p1;
    if (!r1.ok) throw new Error(`route buyer1 inject failed: ${errorMessage(r1.error)}`);
    const routeResponses: PayResponse[] = [r1.value, r2];
    diag(`route: ${summarize(routeResponses)} approved=${ledger.approvedCount} link=${JSON.stringify(await linkState(h, link.linkId))}`);
    out(`route: ${summarize(routeResponses)}`);
    for (const v of await singleUseViolations(h, link.linkId, ledger, routeResponses)) violations.push(`route: ${v}`);

    // (b) payPaymentLink directly
    const direct = await raceTwoBuyers(h, "capture");
    diag(`direct: ${summarize(direct.responses)} rejections=${JSON.stringify(direct.rejections)} approved=${direct.ledger.approvedCount}`);
    out(`direct: ${summarize(direct.responses)}`);
    if (direct.rejections.length > 0) throw new Error(`unexpected rejection: ${direct.rejections.join("; ")}`);
    for (const v of await singleUseViolations(h, direct.link.linkId, direct.ledger, direct.responses)) violations.push(`direct: ${v}`);
    diag(`finalize-0-rows log count=${spy.count()}`);
  } finally {
    await closeHarness(h);
  }
  reached();
  finish(violations);
});
