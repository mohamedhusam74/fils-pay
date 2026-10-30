/**
 * L16-R04 regression (must pass on both). Capture failures after the pin
 * are the only path that releases a pinned reservation. After buyer 1's
 * capture is declined (402) or errors (502), the link must be fully
 * reopened: 'active', reserved_at cleared and, where the 0073 columns exist,
 * reservation_id and capture_started_at cleared too. Otherwise a later
 * reservation would inherit the pin. Then buyer 2 claims and stalls in
 * authorize (no pin yet), its reservation is backdated past the timeout,
 * and buyer 3 must be able to claim and pay (200). Buyer 2 is released
 * afterwards and its answer is only logged; a stale holder capturing is the
 * exploit checks' concern.
 */
import { diag, finish, run } from "./_lib.js";
import {
  CARDS,
  CaptureLedger,
  age,
  closeHarness,
  createLink,
  errorMessage,
  linkState,
  makeBuyer,
  openHarness,
  pay,
  settle,
  type Harness,
} from "./_h.js";

async function scenario(h: Harness, mode: "declined" | "error", failures: string[]) {
  const link = await createLink(h);
  const ledger = new CaptureLedger();
  const r1 = await pay(h, makeBuyer(h.sim, ledger, { capture: mode }).acquirer, link.token, CARDS.approved);
  const expected = mode === "declined" ? 402 : 502;
  const body1 = r1.body as Record<string, unknown>;
  if (r1.statusCode !== expected || body1.stage !== "capture") failures.push(`${mode}: buyer1 answered ${r1.statusCode} ${JSON.stringify(body1)}, expected ${expected} at stage capture`);
  const s = await linkState(h, link.linkId);
  diag(`${mode}: after buyer1 link=${JSON.stringify(s)}`);
  if (s.status !== "active" || !s.reservedAtNull) failures.push(`${mode}: link not reopened after the capture failure: ${JSON.stringify(s)}`);
  if (s.reservationId !== undefined && s.reservationId !== null) failures.push(`${mode}: reservation_id left set after release`);
  if (s.captureStartedAt !== undefined && s.captureStartedAt !== null) failures.push(`${mode}: capture_started_at left set after release`);

  const b2 = makeBuyer(h.sim, ledger, { stallAt: "authorize" });
  const p2 = settle(pay(h, b2.acquirer, link.token, CARDS.approved2));
  await b2.waitParked(`${mode} buyer2`);
  await age(h, link.linkId, 61);
  const r3 = await pay(h, makeBuyer(h.sim, ledger, {}).acquirer, link.token, CARDS.approved3);
  const body3 = r3.body as Record<string, unknown>;
  const s3 = await linkState(h, link.linkId);
  if (r3.statusCode !== 200 || body3.status !== "paid") failures.push(`${mode}: buyer3 could not take over a timed-out unpinned reservation: ${r3.statusCode} ${JSON.stringify(body3)}`);
  if (s3.status !== "paid" || s3.transactionId !== body3.transactionId) failures.push(`${mode}: link did not record buyer3's payment: ${JSON.stringify(s3)}`);
  b2.release();
  const r2 = await p2;
  diag(`${mode}: buyer3 ${r3.statusCode}; buyer2 (released afterwards) ${r2.ok ? r2.value.statusCode : `rejected ${errorMessage(r2.error)}`}`);
}

run(async () => {
  const h = await openHarness();
  const failures: string[] = [];
  try {
    await scenario(h, "declined", failures);
    await scenario(h, "error", failures);
  } finally {
    await closeHarness(h);
  }
  finish(failures);
});
