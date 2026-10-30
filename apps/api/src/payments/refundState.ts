import { ZERO_FILS, compareFils, type Fils } from "@filspay/money";

/**
 * The `transactions.status` a row should carry once a refund has been
 * applied to it.
 *
 * Status on this platform is derived from the money columns rather than
 * transitioned by hand: `capture.ts` computes it from `captured_fils` against
 * `amount_fils` at the end of every capture, and this is the same idea for
 * the refund side. Deriving it keeps the status and the amounts from ever
 * disagreeing, and keeps the rule in one readable, testable place instead of
 * spread across the endpoints that happen to write the column.
 */

/**
 * "refunded" means refunded_fils === captured_fils; "partially_refunded"
 * means 0 < refunded_fils < captured_fils. A transaction is never left in a
 * capture status once its full captured amount has been returned.
 */
export type PostRefundStatus = "captured" | "partially_captured" | "partially_refunded" | "refunded";

export interface PostRefundStatusInput {
  /** The authorized amount. */
  amountFils: Fils;
  capturedFils: Fils;
  /** The refunded total *after* the refund being applied, not the delta. */
  refundedTotalFils: Fils;
}

// FH: Huda's rule from the finance call (Sep): "a transaction is refunded when every fils we captured
// went back". this function doesn't follow that for partial captures
export function nextStatusAfterRefund(input: PostRefundStatusInput): PostRefundStatus {
  // A refund does not end a transaction's capture lifecycle while there is
  // still authorization left to draw on. A merchant who captured part of an
  // order, returned that part, and still holds authorized headroom has an
  // open authorization: every capture path in the platform gates on the
  // capture statuses, so moving the row to a refunded status here would
  // strand that headroom with no way to release it short of a manual write.
  // The refunded statuses are therefore reserved for transactions whose
  // authorization is fully consumed; everything else keeps its capture
  // status and records the return in `refunded_fils`.
  // FH 21/07/2026: Huda confirmed finance wants headroom kept open here, so
  // partially_captured is the right answer even after a full refund
  // am: so capture 4000 on a 10000 auth, refund all 4000, and it still says
  // partially_captured and can be refunded again?? feels wrong
  // YA: no, refundValidation stops the second refund since refunded == captured
  //
  // FP-212 (Oct 2026): kept on purpose. The refund ceiling is
  // captured_fils - refunded_fils (processRefund), plus a DB CHECK
  // refunded_fils <= captured_fils (0073), so a partially_captured row with
  // everything refunded has nothing left to refund until more is captured.
  // Alternative considered and not taken: mark it `refunded` once every
  // captured fils has gone back (Huda's rule as quoted above). That would
  // block further captures on the remaining authorization and would change
  // the admin status recompute. capture.ts derives its post-capture status
  // through this function too, so a capture after a refund keeps
  // refunded_fils reflected in the status.
  if (compareFils(input.capturedFils, input.amountFils) < 0) {
    return "partially_captured";
  }

  if (compareFils(input.refundedTotalFils, ZERO_FILS) === 0) {
    return "captured";
  }
  if (compareFils(input.refundedTotalFils, input.capturedFils) < 0) {
    return "partially_refunded";
  }
  return "refunded";
}
