/**
 * L16-B02 behavior (byte-identical stdout on both revisions): every
 * non-claimable state keeps its exact status code and JSON body now that the
 * claim UPDATE's WHERE clause changed, and the submittedAt expiry reference
 * still works. States are set only through existing columns. Cases: unknown
 * token; already paid; canceled; expired; reserved now; reserved 59 s ago
 * (inside the 60 s timeout); expired an hour after an offline terminal's
 * submittedAt (claimable); expired with an unparseable submittedAt.
 */
import { randomUUID } from "node:crypto";
import { canonical, finish, out, run } from "./_lib.js";
import { CARDS, CaptureLedger, closeHarness, createLink, linkState, makeBuyer, openHarness, stableBody, type Harness } from "./_h.js";
import { payPaymentLink } from "../src/paymentLinks/pay.js";
import { cancelPaymentLink } from "../src/paymentLinks/cancel.js";

run(async () => {
  const h = await openHarness();
  const ledger = new CaptureLedger();
  const acquirer = makeBuyer(h.sim, ledger, {}).acquirer;
  const attempt = (token: string, submittedAt?: string) =>
    payPaymentLink(h.pool, acquirer, h.config, { token, card: CARDS.approved, idempotencyKey: randomUUID(), submittedAt });
  const emit = async (name: string, r: { statusCode: number; body: unknown }, linkId?: string) => {
    const state = linkId ? await linkState(h, linkId) : null;
    out(canonical({ case: name, statusCode: r.statusCode, body: stableBody((r.body ?? {}) as Record<string, unknown>), linkStatus: state?.status ?? null }));
  };
  const setSql = async (h2: Harness, linkId: string, sql: string) => h2.pool.query(`UPDATE payment_links SET ${sql} WHERE id = $1`, [linkId]);
  try {
    await emit("01-unknown-token", await attempt(`plt_${randomUUID()}`));

    const paid = await createLink(h);
    await attempt(paid.token);
    await emit("02-already-paid", await attempt(paid.token), paid.linkId);

    const canceled = await createLink(h);
    await cancelPaymentLink(h.pool, { id: canceled.linkId });
    await emit("03-canceled", await attempt(canceled.token), canceled.linkId);

    const expired = await createLink(h);
    await setSql(h, expired.linkId, `expires_at = now() - interval '1 minute'`);
    await emit("04-expired", await attempt(expired.token), expired.linkId);

    const fresh = await createLink(h);
    await setSql(h, fresh.linkId, `status = 'reserved', reserved_at = now()`);
    await emit("05-reserved-now", await attempt(fresh.token), fresh.linkId);

    const inside = await createLink(h);
    await setSql(h, inside.linkId, `status = 'reserved', reserved_at = now() - interval '59 seconds'`);
    await emit("06-reserved-59s", await attempt(inside.token), inside.linkId);

    const offline = await createLink(h);
    await setSql(h, offline.linkId, `expires_at = now() - interval '1 minute'`);
    await emit("07-expired-but-submitted-earlier", await attempt(offline.token, new Date(Date.now() - 3_600_000).toISOString()), offline.linkId);

    const garbage = await createLink(h);
    await setSql(h, garbage.linkId, `expires_at = now() - interval '1 minute'`);
    await emit("08-expired-unparseable-submittedAt", await attempt(garbage.token, "not-a-timestamp"), garbage.linkId);

    out(canonical({ case: "captures", approved: ledger.approvedCount }));
  } finally {
    await closeHarness(h);
  }
  finish([]);
});
