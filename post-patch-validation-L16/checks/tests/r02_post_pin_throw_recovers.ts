/**
 * L16-R02 regression (availability; must pass on both). A pay attempt whose
 * capture step throws before any money moves (captureTransaction's
 * transaction rolls back; payPaymentLink has no try/finally, so nothing
 * releases the reservation) must not leave the single-use link permanently
 * unpayable: per the 0020 lifecycle comment and pay.ts's docstring the
 * reservation self-expires after the timeout and the next buyer can pay.
 * Two throw sources: (a) the acquirer client throws before the capture
 * request is sent (ECONNRESET); (b) a database-side throw inside
 * captureTransaction (its idempotency claim fails with
 * idempotency_key_reused because a row with a different request hash already
 * holds the capture key). After backdating the reservation past the timeout
 * a new buyer pays. Expected: 200 'paid', the link records that
 * transaction, exactly one approved capture.
 */
import { randomUUID } from "node:crypto";
import { diag, finish, run } from "./_lib.js";
import {
  CARDS,
  CaptureLedger,
  age,
  closeHarness,
  createLink,
  errorMessage,
  linkCapturedEvents,
  linkState,
  makeBuyer,
  openHarness,
  pay,
  settle,
  type Harness,
} from "./_h.js";
import { cancelPaymentLink } from "../src/paymentLinks/cancel.js";

async function scenario(h: Harness, label: string, trigger: "acquirer-throw" | "db-throw", failures: string[]) {
  const link = await createLink(h);
  const ledger = new CaptureLedger();
  const key = randomUUID();
  if (trigger === "db-throw") {
    await h.pool.query(
      `INSERT INTO idempotency_keys (merchant_id, endpoint, key, request_hash) VALUES ($1, 'transactions.capture', $2, 'ppv-different-request')`,
      [link.merchantId, `paylink:${link.linkId}:${key}:capture`],
    );
  }
  const b1 = makeBuyer(h.sim, ledger, trigger === "acquirer-throw" ? { capture: "throw-before" } : {});
  const r1 = await settle(pay(h, b1.acquirer, link.token, CARDS.approved, key));
  diag(`${label}: first attempt ${r1.ok ? `answered ${r1.value.statusCode} ${JSON.stringify(r1.value.body)}` : `rejected: ${errorMessage(r1.error)}`}`);
  if (r1.ok) failures.push(`${label}: harness: first attempt was expected to throw`);
  const events = await linkCapturedEvents(h, link.linkId);
  if (ledger.approvedCount !== 0 || events.count !== 0) failures.push(`${label}: harness: money moved on the throwing attempt`);
  diag(`${label}: stuck state=${JSON.stringify(await linkState(h, link.linkId))}`);

  await age(h, link.linkId, 61);
  const b2 = makeBuyer(h.sim, ledger, {});
  const r2 = await pay(h, b2.acquirer, link.token, CARDS.approved2);
  const state = await linkState(h, link.linkId);
  diag(`${label}: next buyer after the timeout: ${r2.statusCode} ${JSON.stringify(r2.body)} link=${JSON.stringify(state)} approved=${ledger.approvedCount}`);
  const body = r2.body as Record<string, unknown>;
  if (r2.statusCode !== 200 || body.status !== "paid") failures.push(`${label}: next buyer after the timeout answered ${r2.statusCode} ${JSON.stringify(body)}, expected 200 paid`);
  if (state.status !== "paid" || state.transactionId !== body.transactionId) failures.push(`${label}: link ended ${state.status}, expected paid with the next buyer's transaction`);
  if (ledger.approvedCount !== 1) failures.push(`${label}: acquirer approved ${ledger.approvedCount} captures, expected 1`);

  if (r2.statusCode !== 200) {
    await age(h, link.linkId, 3600);
    const r3 = await pay(h, makeBuyer(h.sim, ledger, {}).acquirer, link.token, CARDS.approved3);
    const canceled = await cancelPaymentLink(h.pool, { id: link.linkId });
    diag(`${label}: an hour later: pay ${r3.statusCode} ${JSON.stringify(r3.body)}; merchant cancel ${JSON.stringify(canceled)}; link=${JSON.stringify(await linkState(h, link.linkId))}`);
  }
}

run(async () => {
  const h = await openHarness();
  const failures: string[] = [];
  try {
    await scenario(h, "acquirer-throw", "acquirer-throw", failures);
    await scenario(h, "db-throw", "db-throw", failures);
  } finally {
    await closeHarness(h);
  }
  finish(failures);
});
