/**
 * `POST /v1/refunds` end to end through the Fastify app (app.inject) against
 * a real, migrated Postgres: authorize and capture through the real routes,
 * refund through the route, then read the result back through the
 * transaction detail and timeline routes. Requires `DATABASE_URL`.
 */
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { issueApiKey } from "../apiKeys/issue.js";
import { recordKycReview } from "../onboarding/review.js";
import { startImpersonation } from "../admin/impersonation.js";
import { sha256Hex } from "../lib/crypto.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("refunds.test.ts requires DATABASE_URL to point at a real, migrated Postgres");
}

const config = loadConfig({
  DATABASE_URL: databaseUrl,
  NODE_ENV: "test",
  INTERNAL_API_TOKEN: "test-internal-token",
  ACQUIRER_FAILURE_RATE: "0",
  ACQUIRER_LATENCY_MIN_MS: "5",
  ACQUIRER_LATENCY_MAX_MS: "20",
  WEBHOOK_SECRET_ENCRYPTION_KEY: "Y1ZTGTcYbe30GZJebys9w7T3OYZNKewuOH3SUCEdRQk=",
});

const pool = new Pool({ connectionString: databaseUrl, max: 10 });
const app = buildApp(config, pool);

test.after(async () => {
  await app.close();
  await pool.end();
});

const VALID_CARD = { pan: "4242424242424242", expiryMonth: 12, expiryYear: 2030, cvv: "123" };

interface TestMerchant {
  merchantId: string;
  ownerUserId: string;
  rawKey: string;
}

async function createMerchant(label: string): Promise<TestMerchant> {
  const merchant = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`,
    [`Refund Route ${label} ${randomUUID()}`],
  );
  const merchantId = merchant.rows[0]!.id;
  const user = await pool.query<{ id: string }>(
    `INSERT INTO merchant_users (merchant_id, email, role, password_hash)
     VALUES ($1, $2, 'owner', 'unused-in-these-tests') RETURNING id`,
    [merchantId, `owner-${randomUUID()}@example.test`],
  );
  await recordKycReview(pool, { merchantId, outcome: "approved", reviewerIdentifier: "test" });
  const issued = await issueApiKey(pool, config, { merchantId, createdBy: user.rows[0]!.id, label });
  return { merchantId, ownerUserId: user.rows[0]!.id, rawKey: issued.rawKey };
}

/** An authenticated (post-OTP) merchant session for a user with `role`. */
async function sessionCookie(merchantId: string, role: "owner" | "finance" | "support"): Promise<string> {
  const user = await pool.query<{ id: string }>(
    `INSERT INTO merchant_users (merchant_id, email, role, password_hash)
     VALUES ($1, $2, $3, 'unused-in-these-tests') RETURNING id`,
    [merchantId, `${role}-${randomUUID()}@example.test`, role],
  );
  const raw = randomBytes(32).toString("hex");
  await pool.query(
    `INSERT INTO sessions (merchant_user_id, token_hash, authenticated, authenticated_at, expires_at)
     VALUES ($1, $2, true, now(), now() + interval '1 hour')`,
    [user.rows[0]!.id, sha256Hex(raw)],
  );
  return `${config.cookieName}=${raw}`;
}

function bearer(rawKey: string, idempotencyKey: string | null = randomUUID()): Record<string, string> {
  return idempotencyKey === null
    ? { authorization: `Bearer ${rawKey}` }
    : { authorization: `Bearer ${rawKey}`, "idempotency-key": idempotencyKey };
}

async function capturedTransaction(merchant: TestMerchant, amountFils: number, captureFils?: number): Promise<string> {
  const auth = await app.inject({
    method: "POST",
    url: "/v1/transactions",
    headers: bearer(merchant.rawKey),
    payload: { amountFils, card: VALID_CARD, reference: "refund-route" },
  });
  assert.equal(auth.statusCode, 201, auth.body);
  const id = (auth.json() as { id: string }).id;
  const cap = await app.inject({
    method: "POST",
    url: `/v1/transactions/${id}/capture`,
    headers: bearer(merchant.rawKey),
    payload: captureFils === undefined ? {} : { amountFils: captureFils },
  });
  assert.equal(cap.statusCode, 200, cap.body);
  return id;
}

function postRefund(headers: Record<string, string>, payload: Record<string, unknown>) {
  return app.inject({ method: "POST", url: "/v1/refunds", headers, payload });
}

async function getTransaction(merchant: TestMerchant, id: string) {
  const res = await app.inject({ method: "GET", url: `/v1/transactions/${id}`, headers: bearer(merchant.rawKey, null) });
  assert.equal(res.statusCode, 200, res.body);
  return res.json() as { status: string; capturedFils: number; refundedFils: number };
}

test("full refund through the API: 200, transaction detail and timeline reflect it", async () => {
  const merchant = await createMerchant("full");
  const txnId = await capturedTransaction(merchant, 10_000);

  const res = await postRefund(bearer(merchant.rawKey), { transactionId: txnId, reason: "customer_request" });
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json() as Record<string, unknown>;
  assert.equal(body.amountFils, 10_000);
  assert.equal(body.feeReversedFils, 250);
  assert.equal(body.transactionStatus, "refunded");
  assert.equal(body.reason, "customer_request");

  const txn = await getTransaction(merchant, txnId);
  assert.equal(txn.status, "refunded");
  assert.equal(txn.refundedFils, 10_000);

  const events = await app.inject({
    method: "GET",
    url: `/v1/transactions/${txnId}/events`,
    headers: bearer(merchant.rawKey, null),
  });
  const timeline = events.json() as Array<{ eventType: string; amountFils: number | null }>;
  assert.deepEqual(
    timeline.map((e) => e.eventType),
    ["authorized", "captured", "refunded"],
  );
  assert.equal(timeline[2]!.amountFils, -10_000);
  assert.equal(timeline.reduce((sum, e) => sum + (e.amountFils ?? 0), 0), 0, "timeline nets to zero");
});

test("partial then multiple partial refunds through the API, ending exactly at captured", async () => {
  const merchant = await createMerchant("partials");
  const txnId = await capturedTransaction(merchant, 1_000);

  const fees: number[] = [];
  for (const amountFils of [333, 333, 334]) {
    const res = await postRefund(bearer(merchant.rawKey), { transactionId: txnId, amountFils });
    assert.equal(res.statusCode, 200, res.body);
    fees.push((res.json() as { feeReversedFils: number }).feeReversedFils);
  }
  assert.equal(
    fees.reduce((a, b) => a + b, 0),
    25,
    "exactly the 25-fil fee charged on 1.000 BD at 250 bps",
  );
  const txn = await getTransaction(merchant, txnId);
  assert.equal(txn.status, "refunded");
  assert.equal(txn.refundedFils, 1_000);

  const over = await postRefund(bearer(merchant.rawKey), { transactionId: txnId, amountFils: 1 });
  assert.equal(over.statusCode, 409, over.body);
  assert.equal((over.json() as { code: string }).code, "transaction_not_refundable");
});

test("a refund above the captured amount is a 422 with the refundable ceiling", async () => {
  const merchant = await createMerchant("over");
  const txnId = await capturedTransaction(merchant, 10_000, 4_000);

  const res = await postRefund(bearer(merchant.rawKey), { transactionId: txnId, amountFils: 6_000 });
  assert.equal(res.statusCode, 422, res.body);
  assert.deepEqual(res.json(), { ok: false, code: "refund_exceeds_refundable", refundableFils: 4_000 });
  assert.equal((await getTransaction(merchant, txnId)).refundedFils, 0);
});

test("concurrent refunds through the API with different keys refund at most the captured amount", async () => {
  const merchant = await createMerchant("concurrent");
  const txnId = await capturedTransaction(merchant, 9_000);

  const responses = await Promise.all(
    Array.from({ length: 5 }, () => postRefund(bearer(merchant.rawKey), { transactionId: txnId, amountFils: 4_000 })),
  );
  const ok = responses.filter((r) => r.statusCode === 200);
  const refused = responses.filter((r) => r.statusCode === 422);
  assert.equal(ok.length, 2, responses.map((r) => `${r.statusCode} ${r.body}`).join("\n"));
  assert.equal(refused.length, 3);

  const txn = await getTransaction(merchant, txnId);
  assert.equal(txn.refundedFils, 8_000);
  const refunds = await pool.query<{ total: string }>(
    `SELECT COALESCE(SUM(amount_fils), 0)::text AS total FROM refunds WHERE transaction_id = $1`,
    [txnId],
  );
  assert.equal(Number(refunds.rows[0]!.total), 8_000);
});

test("retrying with the same Idempotency-Key replays the first response", async () => {
  const merchant = await createMerchant("replay");
  const txnId = await capturedTransaction(merchant, 5_000);
  const headers = bearer(merchant.rawKey);

  const first = await postRefund(headers, { transactionId: txnId, amountFils: 1_000 });
  const second = await postRefund(headers, { transactionId: txnId, amountFils: 1_000 });
  assert.equal(first.statusCode, 200, first.body);
  assert.equal(second.statusCode, 200, second.body);
  assert.deepEqual(second.json(), first.json());
  assert.equal((await getTransaction(merchant, txnId)).refundedFils, 1_000);

  const reused = await postRefund(headers, { transactionId: txnId, amountFils: 2_000 });
  assert.equal(reused.statusCode, 422, "same key, different body");
});

test("another merchant's transaction is a 404 and is not refunded", async () => {
  const owner = await createMerchant("victim");
  const other = await createMerchant("other");
  const txnId = await capturedTransaction(owner, 5_000);

  const res = await postRefund(bearer(other.rawKey), { transactionId: txnId });
  assert.equal(res.statusCode, 404, res.body);
  assert.equal((await getTransaction(owner, txnId)).refundedFils, 0);
});

test("request validation: Idempotency-Key, transactionId and amountFils", async () => {
  const merchant = await createMerchant("validation");
  const txnId = await capturedTransaction(merchant, 2_000);

  const noKey = await postRefund(bearer(merchant.rawKey, null), { transactionId: txnId });
  assert.equal(noKey.statusCode, 400, noKey.body);

  const badId = await postRefund(bearer(merchant.rawKey), { transactionId: "not-a-uuid" });
  assert.equal(badId.statusCode, 400, badId.body);

  const fractional = await postRefund(bearer(merchant.rawKey), { transactionId: txnId, amountFils: 10.5 });
  assert.equal(fractional.statusCode, 400, fractional.body);

  const negative = await postRefund(bearer(merchant.rawKey), { transactionId: txnId, amountFils: -5 });
  assert.equal(negative.statusCode, 422, negative.body);

  const unauthenticated = await app.inject({ method: "POST", url: "/v1/refunds", payload: { transactionId: txnId } });
  assert.equal(unauthenticated.statusCode, 401);
});

test("session roles: owner and finance may refund, support may not", async () => {
  const merchant = await createMerchant("roles");
  const txnId = await capturedTransaction(merchant, 3_000);

  const support = await postRefund(
    { cookie: await sessionCookie(merchant.merchantId, "support"), "idempotency-key": randomUUID() },
    { transactionId: txnId, amountFils: 1_000 },
  );
  assert.equal(support.statusCode, 403, support.body);

  for (const role of ["owner", "finance"] as const) {
    const res = await postRefund(
      { cookie: await sessionCookie(merchant.merchantId, role), "idempotency-key": randomUUID() },
      { transactionId: txnId, amountFils: 1_000 },
    );
    assert.equal(res.statusCode, 200, `${role}: ${res.body}`);
  }
});

test("an admin impersonation grant cannot refund, even as super_admin (mapped to owner)", async () => {
  const merchant = await createMerchant("impersonation");
  const txnId = await capturedTransaction(merchant, 3_000);
  const admin = await pool.query<{ id: string }>(
    `INSERT INTO admin_users (email, password_hash, display_name, role)
     VALUES ($1, 'unused', 'Refund Test Admin', 'super_admin') RETURNING id`,
    [`admin-${randomUUID()}@example.test`],
  );
  const grant = await startImpersonation(pool, {
    adminUserId: admin.rows[0]!.id,
    merchantId: merchant.merchantId,
    ttlMinutes: 10,
  });

  const res = await postRefund(
    { cookie: `${config.impersonationCookieName}=${grant.rawToken}`, "idempotency-key": randomUUID() },
    { transactionId: txnId },
  );
  assert.equal(res.statusCode, 403, res.body);
  assert.equal((await getTransaction(merchant, txnId)).refundedFils, 0);
});
