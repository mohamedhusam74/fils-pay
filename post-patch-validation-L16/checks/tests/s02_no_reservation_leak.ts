/**
 * L16-S02 security (must hold on both revisions): the new ownership columns
 * never reach an API response. reservation_id is the server-side capability
 * that authorizes pin/finalize/release; listPaymentLinks reads SELECT * and
 * createPaymentLink RETURNING *. Collects every response body of: merchant
 * create, merchant list (no filter, and status=reserved while a reservation
 * is live and while a capture is in flight), public GET in those states,
 * public pay (200, 409 processing, and both answers of the authorize-stall
 * race, which include the patch's new 409 body). Asserts no JSON key looks
 * like a reservation/capture-ownership field and no body contains any
 * reservation_id value the database held during the run.
 */
import { randomUUID } from "node:crypto";
import { diag, finish, run } from "./_lib.js";
import {
  CARDS,
  CaptureLedger,
  age,
  closeHarness,
  getPublic,
  injectPay,
  instrumentAppAcquirer,
  openHarness,
  raceTwoBuyers,
  type Harness,
} from "./_h.js";

const FORBIDDEN_KEY = /reservation|capture_?started/i;

function collectKeys(value: unknown, acc: Set<string>): Set<string> {
  if (Array.isArray(value)) value.forEach((v) => collectKeys(v, acc));
  else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      acc.add(k);
      collectKeys(v, acc);
    }
  }
  return acc;
}

async function reservationIds(h: Harness): Promise<string[]> {
  const has = await h.pool.query(
    `SELECT 1 FROM information_schema.columns WHERE table_name = 'payment_links' AND column_name = 'reservation_id'`,
  );
  if (has.rowCount === 0) return [];
  const r = await h.pool.query<{ id: string }>(`SELECT reservation_id::text AS id FROM payment_links WHERE reservation_id IS NOT NULL`);
  return r.rows.map((x) => x.id);
}

run(async () => {
  const h = await openHarness({ app: true });
  const app = h.app!;
  const bodies: Array<{ label: string; text: string }> = [];
  const seenReservationIds = new Set<string>();
  const snapshotIds = async () => (await reservationIds(h)).forEach((id) => seenReservationIds.add(id));
  try {
    const merchant = await h.pool.query<{ id: string }>(`INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`, [
      `PPV L16 leak ${randomUUID().slice(0, 8)}`,
    ]);
    const merchantId = merchant.rows[0]!.id;
    const user = await h.pool.query<{ id: string }>(
      `INSERT INTO merchant_users (merchant_id, email, role, password_hash) VALUES ($1, $2, 'owner', 'x') RETURNING id`,
      [merchantId, `owner-${randomUUID()}@ppv-l16.test`],
    );
    const { recordKycReview } = await import("../src/onboarding/review.js");
    const { issueApiKey } = await import("../src/apiKeys/issue.js");
    await recordKycReview(h.pool, { merchantId, outcome: "approved", reviewerIdentifier: "ppv-l16" });
    const { rawKey } = await issueApiKey(h.pool, h.config, { merchantId, createdBy: user.rows[0]!.id, label: "ppv" });
    const auth = { authorization: `Bearer ${rawKey}` };
    const record = (label: string, text: string) => bodies.push({ label, text });

    const created = await app.inject({
      method: "POST",
      url: `/v1/merchants/${merchantId}/payment-links`,
      headers: auth,
      payload: { amountFils: 128_450, reference: "leak-1", expiresAt: new Date(Date.now() + 3_600_000).toISOString() },
    });
    record("create", created.body);
    const link = created.json() as { id: string; token: string };

    const ledger = new CaptureLedger();
    for (const stallAt of ["authorize", "capture"] as const) {
      const target = stallAt === "authorize" ? link : ((await app.inject({
        method: "POST",
        url: `/v1/merchants/${merchantId}/payment-links`,
        headers: auth,
        payload: { amountFils: 128_450, reference: "leak-2", expiresAt: new Date(Date.now() + 3_600_000).toISOString() },
      })).json() as { id: string; token: string });
      const gate = instrumentAppAcquirer(app, ledger, { stallAt });
      const p1 = injectPay(app, "holder", target.token, CARDS.approved, randomUUID());
      await gate.waitParked(`holder at ${stallAt}`);
      await snapshotIds();
      record(`list-all (${stallAt} in flight)`, (await app.inject({ method: "GET", url: `/v1/merchants/${merchantId}/payment-links`, headers: auth })).body);
      record(`list-reserved (${stallAt} in flight)`, (await app.inject({ method: "GET", url: `/v1/merchants/${merchantId}/payment-links?status=reserved`, headers: auth })).body);
      record(`public (${stallAt} in flight)`, JSON.stringify((await getPublic(app, target.token)).body));
      const contender = await injectPay(app, "contender", target.token, CARDS.approved2, randomUUID());
      record(`pay contender (${stallAt} in flight)`, JSON.stringify(contender.body));
      await age(h, target.id, 61);
      await snapshotIds();
      record(`public (${stallAt} in flight, aged)`, JSON.stringify((await getPublic(app, target.token)).body));
      gate.release();
      record(`pay holder (${stallAt})`, JSON.stringify((await p1).body));
      // restore the app's plain simulator methods for the next round
      const sim = (app as unknown as { acquirer: Record<string, unknown> }).acquirer;
      const fresh = (await import("../src/acquirer/simulator.js")).createAcquirerSimulator(h.config);
      sim.authorize = fresh.authorize;
      sim.capture = fresh.capture;
    }
    record("list-all (final)", (await app.inject({ method: "GET", url: `/v1/merchants/${merchantId}/payment-links`, headers: auth })).body);

    const race = await raceTwoBuyers(h, "authorize");
    await snapshotIds();
    for (const r of race.responses) record(`race ${r.label} ${r.statusCode}`, JSON.stringify(r.body));
    record("public (race link)", JSON.stringify((await getPublic(app, race.link.token)).body));
  } finally {
    await closeHarness(h);
  }

  const failures: string[] = [];
  for (const b of bodies) {
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(b.text);
    } catch {
      failures.push(`${b.label}: response is not JSON: ${b.text.slice(0, 120)}`);
      continue;
    }
    const bad = [...collectKeys(parsed, new Set())].filter((k) => FORBIDDEN_KEY.test(k));
    if (bad.length > 0) failures.push(`${b.label}: response exposes ${bad.join(", ")}`);
    for (const id of seenReservationIds) if (b.text.includes(id)) failures.push(`${b.label}: response contains a reservation_id value`);
    diag(`${b.label}: keys=${JSON.stringify([...collectKeys(parsed, new Set())].sort())}`);
  }
  diag(`checked ${bodies.length} bodies against ${seenReservationIds.size} reservation_id values`);
  if (bodies.length < 12) failures.push(`only ${bodies.length} bodies collected`);
  finish(failures);
});
