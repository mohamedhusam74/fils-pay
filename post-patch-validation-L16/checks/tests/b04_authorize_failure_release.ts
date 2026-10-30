/**
 * L16-B04 behavior (byte-identical stdout on both revisions): authorize-stage
 * failures through the public route keep their exact status and body
 * (402 card_declined/do_not_honor for PAN ...0002, 502 acquirer_unavailable
 * for PAN ...0069), and the reservation is released (now through the
 * reservation-bound release) so an immediate retry with an approved card
 * pays. Where the 0073 columns exist they must be NULL after the release
 * (checked silently).
 */
import { randomUUID } from "node:crypto";
import { canonical, finish, out, run } from "./_lib.js";
import {
  CARDS,
  CaptureLedger,
  closeHarness,
  createLink,
  injectPay,
  instrumentAppAcquirer,
  linkCapturedEvents,
  linkState,
  openHarness,
  stableBody,
} from "./_h.js";

run(async () => {
  const h = await openHarness({ app: true });
  const failures: string[] = [];
  try {
    const app = h.app!;
    const ledger = new CaptureLedger();
    instrumentAppAcquirer(app, ledger, {});
    for (const [label, card] of [["decline-0002", CARDS.declined], ["error-0069", CARDS.error]] as const) {
      const link = await createLink(h);
      const failed = await injectPay(app, label, link.token, card, randomUUID());
      const s = await linkState(h, link.linkId);
      out(canonical({ case: label, statusCode: failed.statusCode, body: stableBody(failed.body), link: { status: s.status, reservedAtNull: s.reservedAtNull } }));
      if (s.reservationId !== undefined && s.reservationId !== null) failures.push(`${label}: reservation_id left set after release`);
      if (s.captureStartedAt !== undefined && s.captureStartedAt !== null) failures.push(`${label}: capture_started_at left set after release`);
      const retry = await injectPay(app, `${label}-retry`, link.token, CARDS.approved, randomUUID());
      const s2 = await linkState(h, link.linkId);
      out(canonical({
        case: `${label}-retry`,
        statusCode: retry.statusCode,
        body: stableBody(retry.body),
        link: s2.status,
        matches: retry.body.transactionId === s2.transactionId,
        captures: await linkCapturedEvents(h, link.linkId),
      }));
    }
  } finally {
    await closeHarness(h);
  }
  finish(failures);
});
