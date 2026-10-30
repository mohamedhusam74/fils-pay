/**
 * L16-B05 behavior (byte-identical stdout on both revisions): capture-stage
 * failures after the pin keep their bodies (402 card_captured_declined, 502
 * acquirer_unavailable), reopen the link, and keep the documented same-key
 * retry semantics through the reservation-bound release: a same-key retry
 * after a capture decline replays the 402; after a capture error it captures
 * the SAME authorization (retry_after_failure) and pays; a new key after the
 * decline pays with a new authorization; a third same-key request after
 * payment answers 409 payment_link_already_paid. Where the 0073 columns
 * exist they must be NULL right after each failed attempt (checked
 * silently).
 */
import { randomUUID } from "node:crypto";
import { canonical, finish, out, run } from "./_lib.js";
import {
  CARDS,
  CaptureLedger,
  closeHarness,
  createLink,
  linkAuthorizations,
  linkCapturedEvents,
  linkState,
  makeBuyer,
  openHarness,
  pay,
  stableBody,
  transactionCount,
  type Harness,
} from "./_h.js";

async function snapshot(h: Harness, linkId: string, failures: string[], label: string) {
  const s = await linkState(h, linkId);
  if (s.status !== "paid") {
    if (s.reservationId !== undefined && s.reservationId !== null) failures.push(`${label}: reservation_id left set`);
    if (s.captureStartedAt !== undefined && s.captureStartedAt !== null) failures.push(`${label}: capture_started_at left set`);
  }
  return { status: s.status, reservedAtNull: s.reservedAtNull };
}

run(async () => {
  const h = await openHarness();
  const failures: string[] = [];
  try {
    for (const mode of ["declined", "error"] as const) {
      const link = await createLink(h);
      const ledger = new CaptureLedger();
      const buyer = makeBuyer(h.sim, ledger, { capture: mode }); // only its first capture call is overridden
      const key = randomUUID();
      const steps: Array<[string, string]> = [["first", key], ["same-key-retry", key]];
      if (mode === "declined") steps.push(["new-key", randomUUID()]);
      steps.push(["same-key-after", key]);
      for (const [label, k] of steps) {
        const r = await pay(h, buyer.acquirer, link.token, CARDS.approved, k);
        const body = (r.body ?? {}) as Record<string, unknown>;
        const auths = await linkAuthorizations(h, link.merchantId, link.linkId);
        out(canonical({
          mode,
          step: label,
          statusCode: r.statusCode,
          body: stableBody(body),
          link: await snapshot(h, link.linkId, failures, `${mode} ${label}`),
          paidWithFirstAuthorization: body.transactionId === undefined ? null : body.transactionId === auths[0],
          authorizations: auths.length,
          transactions: await transactionCount(h, link.merchantId),
          captures: await linkCapturedEvents(h, link.linkId),
        }));
      }
    }
  } finally {
    await closeHarness(h);
  }
  finish(failures);
});
