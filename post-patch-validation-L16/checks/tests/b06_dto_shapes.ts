/**
 * L16-B06 behavior (byte-identical stdout on both revisions): the two new
 * payment_links columns are reachable from SELECT * (query.ts list) and
 * RETURNING * (create.ts), and status.ts/read.ts were not updated. The
 * merchant DTOs (create, list, list?status=reserved), the public DTO (GET
 * /v1/payment-links/:token) and the analytics top-links DTO must keep
 * exactly the same keys and non-volatile values. Links are put in the
 * states active, reserved now, reserved 2 minutes ago (never pinned), paid,
 * canceled and expired using existing columns only.
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
  openHarness,
  routeCreateLink,
  stableBody,
} from "./_h.js";

run(async () => {
  const h = await openHarness({ app: true });
  try {
    const app = h.app!;
    instrumentAppAcquirer(app, new CaptureLedger(), {});
    const m = await createApiMerchant(h);
    const auth = { authorization: `Bearer ${m.rawKey}` };
    const names = ["a-active", "b-reserved-now", "c-reserved-stale", "d-paid", "e-canceled", "f-expired"];
    const links: Record<string, { id: string; token: string }> = {};
    for (const [i, name] of names.entries()) {
      const created = await routeCreateLink(app, m, { amountFils: 100_000 + i, reference: name, description: `Invoice ${name}` });
      out(canonical({ dto: "create", reference: name, statusCode: created.statusCode, keys: Object.keys(created.body), body: stableBody(created.body) }));
      links[name] = { id: String(created.body.id), token: String(created.body.token) };
    }
    await h.pool.query(`UPDATE payment_links SET status = 'reserved', reserved_at = now() WHERE id = $1`, [links["b-reserved-now"]!.id]);
    await h.pool.query(`UPDATE payment_links SET status = 'reserved', reserved_at = now() - interval '2 minutes' WHERE id = $1`, [links["c-reserved-stale"]!.id]);
    const paid = await injectPay(app, "pay", links["d-paid"]!.token, CARDS.approved, randomUUID());
    out(canonical({ dto: "pay", statusCode: paid.statusCode, keys: Object.keys(paid.body) }));
    const del = await app.inject({ method: "DELETE", url: `/v1/merchants/${m.merchantId}/payment-links/${links["e-canceled"]!.id}`, headers: auth });
    out(canonical({ dto: "cancel", statusCode: del.statusCode, body: del.body }));
    await h.pool.query(`UPDATE payment_links SET expires_at = now() - interval '1 minute' WHERE id = $1`, [links["f-expired"]!.id]);

    for (const query of ["", "?status=reserved", "?status=active&status=paid"]) {
      const res = await app.inject({ method: "GET", url: `/v1/merchants/${m.merchantId}/payment-links${query}`, headers: auth });
      const body = res.json() as { paymentLinks: Array<Record<string, unknown>>; [k: string]: unknown };
      const items = [...body.paymentLinks]
        .sort((a, b) => String(a.reference).localeCompare(String(b.reference)))
        .map((l) => ({ keys: Object.keys(l), body: stableBody(l), hasTransaction: l.transactionId !== null }));
      out(canonical({ dto: `list${query}`, statusCode: res.statusCode, topKeys: Object.keys(body), items }));
    }
    for (const name of names) {
      const pub = await getPublic(app, links[name]!.token);
      const b = pub.body;
      out(canonical({
        dto: "public",
        reference: name,
        statusCode: pub.statusCode,
        keys: Object.keys(b),
        status: b.status,
        amountFils: b.amountFils,
        currency: b.currency,
        description: b.description,
        merchantDisplayNamePresent: typeof b.merchantDisplayName === "string",
      }));
    }
    const top = await app.inject({ method: "GET", url: `/v1/analytics/top-links`, headers: auth });
    const tb = top.json() as { links: Array<Record<string, unknown>>; [k: string]: unknown };
    out(canonical({
      dto: "analytics-top-links",
      statusCode: top.statusCode,
      topKeys: Object.keys(tb),
      live: tb.live,
      links: tb.links.map((l) => ({ keys: Object.keys(l), reference: l.reference, amountFils: l.amountFils })),
    }));
  } finally {
    await closeHarness(h);
  }
  finish([]);
});
