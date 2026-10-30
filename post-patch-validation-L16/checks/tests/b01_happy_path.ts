/**
 * L16-B01 behavior (byte-identical stdout on both revisions): the dominant
 * production flow. A merchant creates a link through the route, one buyer
 * pays it through the public route, then the public read and a second pay
 * are observed. Emits only deterministic facts: status codes, body key
 * order and stable values, equality booleans against the database, the
 * link row's state, capture counts/sums, the transaction's event types and
 * the idempotency key shapes with ids replaced by placeholders. Where the
 * 0073 columns exist they must be NULL after finalize (checked silently,
 * so the output stays identical).
 */
import { randomUUID } from "node:crypto";
import { canonical, finish, out, run } from "./_lib.js";
import {
  CARDS,
  CaptureLedger,
  closeHarness,
  createApiMerchant,
  getPublic,
  injectPay,
  instrumentAppAcquirer,
  linkCapturedEvents,
  linkState,
  openHarness,
  routeCreateLink,
  stableBody,
} from "./_h.js";

run(async () => {
  const h = await openHarness({ app: true });
  const failures: string[] = [];
  try {
    const app = h.app!;
    instrumentAppAcquirer(app, new CaptureLedger(), {});
    const m = await createApiMerchant(h);
    const created = await routeCreateLink(app, m, { amountFils: 128_450, reference: "order-1042", description: "Invoice #1042" });
    out(canonical({ step: "create", statusCode: created.statusCode, keys: Object.keys(created.body), body: stableBody(created.body) }));
    const linkId = String(created.body.id);
    const token = String(created.body.token);

    const before = await getPublic(app, token);
    out(canonical({ step: "public-before", statusCode: before.statusCode, keys: Object.keys(before.body), status: before.body.status, amountFils: before.body.amountFils }));

    const key = randomUUID();
    const paid = await injectPay(app, "buyer", token, CARDS.approved, key);
    const state = await linkState(h, linkId);
    const row = await h.pool.query<{ paid_at: Date }>(`SELECT paid_at FROM payment_links WHERE id = $1`, [linkId]);
    out(canonical({
      step: "pay",
      statusCode: paid.statusCode,
      keys: Object.keys(paid.body),
      status: paid.body.status,
      amountFils: paid.body.amountFils,
      transactionIdMatchesLink: paid.body.transactionId === state.transactionId,
      paidAtMatchesLink: paid.body.paidAt === row.rows[0]?.paid_at?.toISOString(),
    }));
    out(canonical({ step: "link", status: state.status, reservedAtNull: state.reservedAtNull, paidAtNull: state.paidAtNull }));
    if (state.reservationId !== undefined && state.reservationId !== null) failures.push("reservation_id left set after finalize");
    if (state.captureStartedAt !== undefined && state.captureStartedAt !== null) failures.push("capture_started_at left set after finalize");

    out(canonical({ step: "captures", ...(await linkCapturedEvents(h, linkId)) }));
    const events = await h.pool.query<{ event_type: string; actor_type: string }>(
      `SELECT event_type, actor_type FROM transaction_events WHERE transaction_id = $1 ORDER BY event_type`,
      [state.transactionId],
    );
    out(canonical({ step: "events", events: events.rows }));
    const keys = await h.pool.query<{ endpoint: string; key: string; status: string; response_status_code: number; has_resource: boolean }>(
      `SELECT endpoint, key, status, response_status_code, resource_id IS NOT NULL AS has_resource
         FROM idempotency_keys WHERE merchant_id = $1 ORDER BY endpoint, key`,
      [m.merchantId],
    );
    out(canonical({
      step: "idempotency",
      rows: keys.rows.map((r) => ({ ...r, key: r.key.replace(linkId, "<linkId>").replace(key, "<key>") })),
    }));

    const after = await getPublic(app, token);
    out(canonical({ step: "public-after", statusCode: after.statusCode, status: after.body.status }));
    const again = await injectPay(app, "again", token, CARDS.approved2, randomUUID());
    out(canonical({ step: "pay-again", statusCode: again.statusCode, body: again.body }));
  } finally {
    await closeHarness(h);
  }
  finish(failures);
});
