/**
 * L16-V01 variant: release ownership on the decline teardown path.
 * Buyer 1 (a card the acquirer will decline, then one it errors on) stalls in
 * authorize; its reservation times out; buyer 2 (approved card) re-claims and
 * stalls in authorize too. Buyer 1's authorize then fails and its
 * releaseReservation runs. If that release is not bound to buyer 1's own
 * reservation it reopens the link under buyer 2, buyer 3 claims and pays,
 * and buyer 2 then also captures.
 *
 * Safety assertion (single-use invariant only), per link. Side-blind.
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
  type Card,
  type Harness,
  type PayResponse,
} from "./_h.js";

async function scenario(h: Harness, label: string, failingCard: Card, violations: string[]): Promise<void> {
  const link = await createLink(h);
  const ledger = new CaptureLedger();
  const b1 = makeBuyer(h.sim, ledger, { stallAt: "authorize" });
  const b2 = makeBuyer(h.sim, ledger, { stallAt: "authorize" });
  const b3 = makeBuyer(h.sim, ledger, {});

  const p1 = settle(pay(h, b1.acquirer, link.token, failingCard));
  await b1.waitParked(`${label} buyer1`);
  await age(h, link.linkId, 61);
  const p2 = settle(pay(h, b2.acquirer, link.token, CARDS.approved));
  await b2.waitParked(`${label} buyer2`);
  b1.release();
  const r1 = await p1;
  const afterRelease = await linkState(h, link.linkId);
  const r3 = await settle(pay(h, b3.acquirer, link.token, CARDS.approved3));
  b2.release();
  const r2 = await p2;

  const responses: PayResponse[] = [];
  for (const [name, r] of [["buyer1", r1], ["buyer2", r2], ["buyer3", r3]] as const) {
    if (!r.ok) throw new Error(`${label} ${name} rejected unexpectedly: ${errorMessage(r.error)}`);
    responses.push(asResponse(name, r.value));
  }
  diag(`${label}: ${summarize(responses)} afterBuyer1Release=${JSON.stringify(afterRelease)} approved=${ledger.approvedCount}`);
  out(`${label}: ${summarize(responses)}`);
  for (const v of await singleUseViolations(h, link.linkId, ledger, responses)) violations.push(`${label}: ${v}`);
}

run(async () => {
  const h = await openHarness();
  const violations: string[] = [];
  try {
    await scenario(h, "decline-0002", CARDS.declined, violations);
    await scenario(h, "error-0069", CARDS.error, violations);
  } finally {
    await closeHarness(h);
  }
  reached();
  finish(violations);
});
