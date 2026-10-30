/**
 * L16-U02 suite: deterministic, seeded schedule fuzzer over payPaymentLink
 * (patched first; baseline only if it fails, where it is expected to find
 * counterexamples). Per seed: one fresh link and 2-4 buyers, each with its
 * own Idempotency-Key, card (approved, declined ...0002, or acquirer error
 * ...0069), an optional stall point (authorize or capture) and a teardown
 * outcome (real capture, capture declined/error, capture throws before or
 * after the acquirer approves, authorize throws, or a crash right before the
 * finalize UPDATE). A seeded scheduler interleaves "start next buyer",
 * "backdate the reservation 61 s past the timeout" and "release a parked
 * buyer"; after every step it waits until each started buyer is parked or
 * settled, so interleavings are driven by gates only, never wall-clock
 * races. Safety properties only (liveness is L16-R01/R02's concern), per
 * link: the acquirer approves at most one capture, at most one pay-path
 * capture is recorded, and every 200 'paid' names the transaction the link
 * records. Prints one line per seed and fails listing every violating seed.
 */
import { canonical, diag, finish, mulberry32, out, run } from "./_lib.js";
import {
  CARDS,
  CaptureLedger,
  age,
  asResponse,
  closeHarness,
  crashBefore,
  createLink,
  errorMessage,
  makeBuyer,
  openHarness,
  pay,
  settle,
  singleUseViolations,
  type Buyer,
  type BuyerOptions,
  type Card,
  type Harness,
  type PayResponse,
  type Settled,
} from "./_h.js";
import type { PayPaymentLinkResult } from "../src/paymentLinks/pay.js";
import { setTimeout as delay } from "node:timers/promises";

const SEEDS = 64;
const MAX_OPS = 12;
const APPROVED: Card[] = [
  CARDS.approved,
  CARDS.approved2,
  CARDS.approved3,
  { pan: "4012888888881881", expiryMonth: 12, expiryYear: 2030, cvv: "123" },
];

interface Plan {
  card: string;
  opts: BuyerOptions;
  crashFinalize: boolean;
}

interface Running {
  plan: Plan;
  buyer: Buyer;
  settled: Settled<PayPaymentLinkResult> | null;
}

function pick<T>(rng: () => number, items: readonly T[]): T {
  return items[Math.floor(rng() * items.length)] as T;
}

function planBuyer(rng: () => number, index: number): { plan: Plan; card: Card } {
  const cardRoll = rng();
  const card = cardRoll < 0.15 ? CARDS.declined : cardRoll < 0.22 ? CARDS.error : (APPROVED[index] as Card);
  const stallAt = pick(rng, [undefined, "authorize", "capture"] as const);
  const outcome = pick(rng, ["real", "real", "real", "declined", "error", "throw-before", "throw-after", "authorize-throw", "crash-finalize"] as const);
  const opts: BuyerOptions = { stallAt };
  if (outcome === "declined" || outcome === "error" || outcome === "throw-before" || outcome === "throw-after") opts.capture = outcome;
  if (outcome === "authorize-throw") opts.authorize = "throw";
  return { plan: { card: card.pan.slice(-4), opts, crashFinalize: outcome === "crash-finalize" }, card };
}

async function quiesce(started: Running[], label: string): Promise<void> {
  for (let i = 0; i < 2000; i++) {
    if (started.every((r) => r.settled !== null || r.buyer.isParked())) return;
    await delay(5);
  }
  throw new Error(`schedule did not quiesce (${label})`);
}

async function runSeed(h: Harness, seed: number): Promise<string[]> {
  const rng = mulberry32(seed);
  const link = await createLink(h);
  const ledger = new CaptureLedger();
  const n = 2 + Math.floor(rng() * 3);
  const planned = Array.from({ length: n }, (_, i) => planBuyer(rng, i));
  const started: Running[] = [];
  const ops: string[] = [];

  const start = (i: number) => {
    const { plan, card } = planned[i] as { plan: Plan; card: Card };
    const buyer = makeBuyer(h.sim, ledger, plan.opts);
    const pool = plan.crashFinalize ? crashBefore(h.pool, /SET status = 'paid'/, "ppv: crash before finalize").pool : h.pool;
    const running: Running = { plan, buyer, settled: null };
    started.push(running);
    void settle(pay(h, buyer.acquirer, link.token, card, undefined, pool)).then((s) => {
      running.settled = s;
    });
  };

  for (let op = 0; op < MAX_OPS; op++) {
    const parked = started.map((r, i) => [r, i] as const).filter(([r]) => r.buyer.isParked());
    const choices: string[] = [];
    if (started.length < n) choices.push("start", "start");
    if (started.length > 0) choices.push("age");
    if (parked.length > 0) choices.push("release", "release");
    if (choices.length === 0) break;
    const choice = pick(rng, choices);
    if (choice === "start") {
      ops.push(`start b${started.length + 1}`);
      start(started.length);
    } else if (choice === "age") {
      ops.push("age61");
      await age(h, link.linkId, 61);
    } else {
      const [r, i] = pick(rng, parked);
      ops.push(`release b${i + 1}`);
      r.buyer.release();
    }
    await quiesce(started, `seed ${seed} after ${ops.at(-1)}`);
    if (started.length === n && started.every((r) => r.settled !== null)) break;
  }
  while (started.length < n) {
    ops.push(`start b${started.length + 1}`);
    start(started.length);
    await quiesce(started, `seed ${seed} draining starts`);
  }
  for (;;) {
    const parked = started.map((r, i) => [r, i] as const).filter(([r]) => r.buyer.isParked());
    if (parked.length === 0) break;
    const [r, i] = parked[0]!;
    ops.push(`release b${i + 1}`);
    r.buyer.release();
    await quiesce(started, `seed ${seed} draining releases`);
  }

  const responses: PayResponse[] = [];
  const outcomes: string[] = [];
  started.forEach((r, i) => {
    if (r.settled?.ok) {
      responses.push(asResponse(`b${i + 1}`, r.settled.value));
      const body = r.settled.value.body as Record<string, unknown>;
      outcomes.push(`b${i + 1}=${r.settled.value.statusCode}:${String(body?.error ?? body?.status ?? "")}`);
    } else {
      outcomes.push(`b${i + 1}=threw`);
      diag(`seed ${seed} b${i + 1} rejected: ${r.settled ? errorMessage((r.settled as { error: unknown }).error) : "?"}`);
    }
  });
  const violations = await singleUseViolations(h, link.linkId, ledger, responses);
  out(canonical({ seed, buyers: planned.map((p) => p.plan), ops, outcomes, approved: ledger.approvedCount, violations }));
  return violations.map((v) => `seed ${seed}: ${v}`);
}

run(async () => {
  const h = await openHarness({ poolMax: 16 });
  const failures: string[] = [];
  try {
    for (let seed = 1; seed <= SEEDS; seed++) failures.push(...(await runSeed(h, seed)));
  } finally {
    await closeHarness(h);
  }
  diag(`${SEEDS} seeds, ${failures.length} violation(s)`);
  finish(failures);
});
