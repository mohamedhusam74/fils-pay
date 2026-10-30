/**
 * L16-S03 security (must hold on both revisions): an API/terminal client
 * retries with the SAME Idempotency-Key while its first request is still
 * stalled in authorize past the reservation timeout. The retry re-claims
 * the link (rotating the reservation on the patched code) and then blocks
 * on the first request's uncommitted idempotency row (confirmed via
 * pg_stat_activity) until the first request's authorize commits. The
 * patch's reservation rotation must not let one key produce two
 * authorizations or two captures. Repeated 3 times. Asserts the single-use
 * invariant and exactly one transaction for the merchant.
 */
import { randomUUID } from "node:crypto";
import { diag, finish, run } from "./_lib.js";
import {
  CARDS,
  CaptureLedger,
  age,
  asResponse,
  closeHarness,
  createLink,
  errorMessage,
  makeBuyer,
  openHarness,
  pay,
  settle,
  singleUseViolations,
  summarize,
  transactionCount,
  waitFor,
  type PayResponse,
} from "./_h.js";

run(async () => {
  const h = await openHarness();
  const failures: string[] = [];
  try {
    for (let i = 1; i <= 3; i++) {
      const link = await createLink(h);
      const ledger = new CaptureLedger();
      const key = randomUUID();
      const first = makeBuyer(h.sim, ledger, { stallAt: "authorize" });
      const retry = makeBuyer(h.sim, ledger, {});
      const p1 = settle(pay(h, first.acquirer, link.token, CARDS.approved, key));
      await first.waitParked(`run ${i} first request`);
      await age(h, link.linkId, 61);
      const p2 = settle(pay(h, retry.acquirer, link.token, CARDS.approved, key));
      await waitFor(async () => {
        const r = await h.pool.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM pg_stat_activity
            WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE '%INSERT INTO idempotency_keys%'`,
        );
        return (r.rows[0]?.n ?? 0) >= 1;
      }, `run ${i} retry blocked on the first request's idempotency row`, 1000, 10);
      first.release();
      const [r1, r2] = await Promise.all([p1, p2]);
      const responses: PayResponse[] = [];
      for (const [name, r] of [["first", r1], ["retry", r2]] as const) {
        if (!r.ok) throw new Error(`run ${i} ${name} rejected unexpectedly: ${errorMessage(r.error)}`);
        responses.push(asResponse(name, r.value));
      }
      const txns = await transactionCount(h, link.merchantId);
      diag(`run ${i}: ${summarize(responses)} transactions=${txns} approved=${ledger.approvedCount}`);
      for (const v of await singleUseViolations(h, link.linkId, ledger, responses)) failures.push(`run ${i}: ${v}`);
      if (txns !== 1) failures.push(`run ${i}: one idempotency key produced ${txns} transactions`);
    }
  } finally {
    await closeHarness(h);
  }
  finish(failures);
});
