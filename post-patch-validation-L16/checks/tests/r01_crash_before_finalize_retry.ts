/**
 * L16-R01 regression (documented crash recovery; must pass on both).
 * pay.ts's docstring and the 0020 lifecycle comment promise that a link
 * stuck 'reserved' by a crash between claim and finalize self-heals after
 * the reservation timeout, and routes/paymentLinks.test.ts encodes the
 * same-key retry of "a crashed pre-finalize attempt" (but builds that state
 * by hand). Here the crash is produced through the real code path: the
 * first request authorizes and captures (committed, acquirer approved),
 * then the finalize UPDATE fails (pool.query rejects on the statement that
 * sets status = 'paid', as a dropped connection or killed process would).
 * After the timeout the client retries with the same Idempotency-Key and
 * card, once directly and once more through the HTTP route on a second link.
 * Expected: 200 with the original transactionId, link 'paid' recording it,
 * one transaction, one approved capture.
 */
import { randomUUID } from "node:crypto";
import { diag, finish, run } from "./_lib.js";
import {
  CARDS,
  CaptureLedger,
  age,
  asResponse,
  closeHarness,
  crashBefore,
  createLink,
  errorMessage,
  injectPay,
  instrumentAppAcquirer,
  linkAuthorizations,
  linkState,
  makeBuyer,
  openHarness,
  pay,
  settle,
  transactionCount,
  type Harness,
  type PayResponse,
} from "./_h.js";

async function crashFirstAttempt(h: Harness, ledger: CaptureLedger, token: string, key: string, failures: string[], label: string) {
  const buyer = makeBuyer(h.sim, ledger, {});
  const crash = crashBefore(h.pool, /SET status = 'paid'/, "ppv: connection lost before finalize");
  const r = await settle(pay(h, buyer.acquirer, token, CARDS.approved, key, crash.pool));
  if (r.ok) failures.push(`${label}: first attempt was expected to reject at finalize but answered ${r.value.statusCode}`);
  if (!crash.fired()) failures.push(`${label}: the finalize statement was never issued`);
  diag(`${label}: first attempt ${r.ok ? `answered ${r.value.statusCode}` : `rejected: ${errorMessage(r.error)}`}; approved=${ledger.approvedCount}`);
}

async function expectRecovered(h: Harness, label: string, link: { linkId: string; merchantId: string }, retry: PayResponse, ledger: CaptureLedger, failures: string[]) {
  const auths = await linkAuthorizations(h, link.merchantId, link.linkId);
  const state = await linkState(h, link.linkId);
  const txns = await transactionCount(h, link.merchantId);
  diag(`${label}: retry ${retry.statusCode} ${JSON.stringify(retry.body)} link=${JSON.stringify(state)} auths=${auths.length} txns=${txns} approved=${ledger.approvedCount}`);
  if (retry.statusCode !== 200 || retry.body.status !== "paid") failures.push(`${label}: same-key retry answered ${retry.statusCode} ${JSON.stringify(retry.body)}, expected 200 paid`);
  if (auths.length !== 1 || retry.body.transactionId !== auths[0]) failures.push(`${label}: retry transactionId is not the first attempt's transaction`);
  if (state.status !== "paid" || state.transactionId !== auths[0]) failures.push(`${label}: link ended ${state.status} (transaction ${state.transactionId === auths[0] ? "matches" : "does not match"}), expected paid with the charged transaction`);
  if (txns !== 1) failures.push(`${label}: ${txns} transactions, expected 1`);
  if (ledger.approvedCount !== 1) failures.push(`${label}: acquirer approved ${ledger.approvedCount} captures, expected 1`);
}

run(async () => {
  const h = await openHarness({ app: true });
  const failures: string[] = [];
  try {
    // direct
    const link = await createLink(h);
    const ledger = new CaptureLedger();
    const key = randomUUID();
    await crashFirstAttempt(h, ledger, link.token, key, failures, "direct");
    await age(h, link.linkId, 120);
    const retry = await pay(h, makeBuyer(h.sim, ledger, {}).acquirer, link.token, CARDS.approved, key);
    await expectRecovered(h, "direct", link, asResponse("retry", retry), ledger, failures);
    if (retry.statusCode !== 200) {
      await age(h, link.linkId, 86_400);
      const again = await pay(h, makeBuyer(h.sim, ledger, {}).acquirer, link.token, CARDS.approved, key);
      diag(`direct: second retry a day later answered ${again.statusCode} ${JSON.stringify(again.body)} link=${JSON.stringify(await linkState(h, link.linkId))}`);
    }

    // through the HTTP route (the first attempt crashes via the same hook; the retry is a real request)
    const link2 = await createLink(h);
    const ledger2 = new CaptureLedger();
    const key2 = randomUUID();
    await crashFirstAttempt(h, ledger2, link2.token, key2, failures, "route");
    await age(h, link2.linkId, 120);
    instrumentAppAcquirer(h.app!, ledger2, {});
    const routed = await injectPay(h.app!, "route-retry", link2.token, CARDS.approved, key2);
    await expectRecovered(h, "route", link2, routed, ledger2, failures);
  } finally {
    await closeHarness(h);
  }
  finish(failures);
});
