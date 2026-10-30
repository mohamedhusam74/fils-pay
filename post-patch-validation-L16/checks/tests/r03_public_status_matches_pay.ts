/**
 * L16-R03 regression (must pass on both). status.ts and read.ts promise
 * that GET /v1/payment-links/:token and the pay endpoint "can never
 * disagree" about a link's state; the checkout page renders the pay form
 * when the public status is 'active'. A reservation whose capture step
 * threw (no money moved) is backdated past the timeout. Then, through the
 * real routes: the public GET status is read and a new buyer pays.
 * Expected: 'active' iff pay can claim the link, 'processing' iff pay
 * answers 409 payment_link_processing. Also checked with a reservation
 * that never reached capture (authorize threw), which must stay consistent.
 */
import { randomUUID } from "node:crypto";
import { diag, finish, run } from "./_lib.js";
import {
  CARDS,
  CaptureLedger,
  age,
  closeHarness,
  createLink,
  getPublic,
  injectPay,
  instrumentAppAcquirer,
  linkState,
  makeBuyer,
  openHarness,
  pay,
  settle,
  type BuyerOptions,
  type Harness,
} from "./_h.js";

async function scenario(h: Harness, label: string, crash: BuyerOptions, failures: string[]) {
  const link = await createLink(h);
  const ledger = new CaptureLedger();
  const r1 = await settle(pay(h, makeBuyer(h.sim, ledger, crash).acquirer, link.token, CARDS.approved));
  if (r1.ok) failures.push(`${label}: harness: first attempt was expected to throw`);
  await age(h, link.linkId, 61);
  const pub = await getPublic(h.app!, link.token);
  const payRes = await injectPay(h.app!, `${label}-buyer2`, link.token, CARDS.approved2, randomUUID());
  const publicStatus = String(pub.body.status);
  const payProcessing = payRes.statusCode === 409 && payRes.body.error === "payment_link_processing";
  diag(`${label}: public=${publicStatus} pay=${payRes.statusCode} ${JSON.stringify(payRes.body)} link=${JSON.stringify(await linkState(h, link.linkId))}`);
  if (publicStatus === "active" && payProcessing) failures.push(`${label}: GET reports 'active' (checkout shows the pay form) but pay answers 409 payment_link_processing`);
  if (publicStatus === "processing" && !payProcessing) failures.push(`${label}: GET reports 'processing' but pay answered ${payRes.statusCode}`);
  if (publicStatus !== "active" && publicStatus !== "processing") failures.push(`${label}: unexpected public status ${publicStatus}`);
}

run(async () => {
  const h = await openHarness({ app: true });
  const failures: string[] = [];
  try {
    instrumentAppAcquirer(h.app!, new CaptureLedger(), {});
    await scenario(h, "capture-threw", { capture: "throw-before" }, failures);
    await scenario(h, "authorize-threw", { authorize: "throw" }, failures);
  } finally {
    await closeHarness(h);
  }
  finish(failures);
});
