/**
 * L16-C01 control (both revisions must pass). Proves the harness works on the
 * changed component before any differential result is interpreted:
 *  - the throwaway DB was migrated by this revision's own db/migrate.ts
 *    (patched: payment_links.reservation_id uuid + capture_started_at
 *    timestamptz exist; base: they do not — no cross-contamination);
 *  - a single buyer pays a link (direct payPaymentLink and via the real
 *    Fastify route), with no stall, with a stall at authorize, with a stall at
 *    capture, and with a stall that is backdated past the timeout while no one
 *    else competes: each answers 200 'paid', the link records exactly that
 *    transaction, the counting acquirer approves exactly one capture, exactly
 *    one pay-path capture event exists, and no invariant-violation log fires.
 */
import { randomUUID } from "node:crypto";
import { diag, finish, run } from "./_lib.js";
import {
  CARDS,
  CaptureLedger,
  LINK_AMOUNT_FILS,
  age,
  asResponse,
  closeHarness,
  createLink,
  hasColumn,
  injectPay,
  instrumentAppAcquirer,
  linkCapturedEvents,
  linkState,
  makeBuyer,
  openHarness,
  pay,
  spyFinalizeInvariantLog,
  type BuyerOptions,
  type Harness,
  type PayResponse,
} from "./_h.js";

async function expectSinglePaid(
  h: Harness,
  label: string,
  linkId: string,
  ledger: CaptureLedger,
  r: PayResponse,
  failures: string[],
): Promise<void> {
  const state = await linkState(h, linkId);
  const events = await linkCapturedEvents(h, linkId);
  diag(`${label}: ${r.statusCode} ${JSON.stringify(r.body)} link=${JSON.stringify(state)} events=${JSON.stringify(events)} approved=${ledger.approvedCount}`);
  if (r.statusCode !== 200 || r.body.status !== "paid") failures.push(`${label}: expected 200 paid, got ${r.statusCode} ${JSON.stringify(r.body)}`);
  if (state.status !== "paid") failures.push(`${label}: link status ${state.status}, expected paid`);
  if (state.transactionId === null || state.transactionId !== r.body.transactionId) failures.push(`${label}: link transaction does not match the response`);
  if (!state.reservedAtNull) failures.push(`${label}: reserved_at not cleared`);
  if (ledger.approvedCount !== 1) failures.push(`${label}: acquirer approved ${ledger.approvedCount} captures, expected 1`);
  if (events.count !== 1 || events.sum !== LINK_AMOUNT_FILS) failures.push(`${label}: pay-path capture events ${JSON.stringify(events)}, expected 1 / ${LINK_AMOUNT_FILS}`);
  if (r.body.amountFils !== LINK_AMOUNT_FILS) failures.push(`${label}: amountFils ${String(r.body.amountFils)}`);
  if (state.reservationId !== undefined && state.reservationId !== null) failures.push(`${label}: reservation_id left set after finalize`);
  if (state.captureStartedAt !== undefined && state.captureStartedAt !== null) failures.push(`${label}: capture_started_at left set after finalize`);
}

async function direct(h: Harness, label: string, opts: BuyerOptions, backdate: boolean, failures: string[]): Promise<void> {
  const link = await createLink(h);
  const ledger = new CaptureLedger();
  const buyer = makeBuyer(h.sim, ledger, opts);
  const pending = pay(h, buyer.acquirer, link.token, CARDS.approved);
  if (opts.stallAt) {
    await buyer.waitParked(label);
    if (backdate) {
      await age(h, link.linkId, 61);
      const stale = await h.pool.query(
        `SELECT 1 FROM payment_links WHERE id = $1 AND status = 'reserved' AND reserved_at < now() - interval '60 seconds'`,
        [link.linkId],
      );
      if (stale.rowCount !== 1) failures.push(`${label}: backdating did not make the reservation look timed out`);
    }
    buyer.release();
  }
  await expectSinglePaid(h, label, link.linkId, ledger, asResponse(label, await pending), failures);
}

run(async () => {
  const failures: string[] = [];
  const spy = spyFinalizeInvariantLog();
  const h = await openHarness({ app: true });
  try {
    const side = process.env.PPV_SIDE;
    const hasReservationId = await hasColumn(h, "payment_links", "reservation_id");
    const hasCaptureStarted = await hasColumn(h, "payment_links", "capture_started_at");
    const types = await h.pool.query<{ column_name: string; data_type: string; is_nullable: string; column_default: string | null }>(
      `SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'payment_links'
          AND column_name IN ('reservation_id', 'capture_started_at') ORDER BY column_name`,
    );
    diag(`side=${side ?? "(unset)"} new columns=${JSON.stringify(types.rows)}`);
    if (side === "patched") {
      const byName = Object.fromEntries(types.rows.map((r) => [r.column_name, r]));
      if (byName.reservation_id?.data_type !== "uuid" || byName.reservation_id?.is_nullable !== "YES" || byName.reservation_id?.column_default !== null) {
        failures.push(`patched schema: reservation_id is ${JSON.stringify(byName.reservation_id ?? null)}`);
      }
      if (byName.capture_started_at?.data_type !== "timestamp with time zone" || byName.capture_started_at?.is_nullable !== "YES" || byName.capture_started_at?.column_default !== null) {
        failures.push(`patched schema: capture_started_at is ${JSON.stringify(byName.capture_started_at ?? null)}`);
      }
    } else if (side === "base") {
      if (hasReservationId || hasCaptureStarted) failures.push("base schema unexpectedly has the 0073 columns");
    } else {
      diag("PPV_SIDE unset: schema-to-revision probe skipped");
    }

    await direct(h, "no-stall", {}, false, failures);
    await direct(h, "stall-authorize", { stallAt: "authorize" }, false, failures);
    await direct(h, "stall-capture", { stallAt: "capture" }, false, failures);
    await direct(h, "stall-authorize-backdated-sole-holder", { stallAt: "authorize" }, true, failures);
    await direct(h, "stall-capture-backdated-sole-holder", { stallAt: "capture" }, true, failures);

    const link = await createLink(h);
    const ledger = new CaptureLedger();
    instrumentAppAcquirer(h.app!, ledger, {});
    const routed = await injectPay(h.app!, "route", link.token, CARDS.approved, randomUUID());
    await expectSinglePaid(h, "route", link.linkId, ledger, routed, failures);

    if (spy.count() !== 0) failures.push(`invariant-violation log fired ${spy.count()} time(s)`);
  } finally {
    await closeHarness(h);
  }
  finish(failures);
});
