/**
 * refund.succeeded reaches the merchant's webhook endpoint through the
 * outbox, correctly enveloped and signed over the exact bytes sent.
 * Requires `DATABASE_URL` (a real, migrated Postgres).
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { issueApiKey } from "../apiKeys/issue.js";
import { recordKycReview } from "../onboarding/review.js";
import { createWebhookEndpoint } from "./create.js";
import { runDispatchPass } from "./dispatcher.js";
import { verifyRawBodySignature } from "./sign.js";
import { WEBHOOK_DELIVERY_ID_HEADER, WEBHOOK_SIGNATURE_HEADER } from "./headers.js";
import type { WebhookTransport, WebhookTransportRequest } from "./transport.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("refundWebhook.test.ts requires DATABASE_URL to point at a real, migrated Postgres");
}

const config = loadConfig({
  DATABASE_URL: databaseUrl,
  NODE_ENV: "test",
  INTERNAL_API_TOKEN: "test-internal-token",
  ACQUIRER_FAILURE_RATE: "0",
  ACQUIRER_LATENCY_MIN_MS: "0",
  ACQUIRER_LATENCY_MAX_MS: "1",
  WEBHOOK_SECRET_ENCRYPTION_KEY: "Y1ZTGTcYbe30GZJebys9w7T3OYZNKewuOH3SUCEdRQk=",
});

const pool = new Pool({ connectionString: databaseUrl, max: 5 });
const app = buildApp(config, pool);

test.after(async () => {
  await app.close();
  await pool.end();
});

const VALID_CARD = { pan: "4242424242424242", expiryMonth: 12, expiryYear: 2030, cvv: "123" };

test("a partial refund delivers one signed refund.succeeded webhook whose raw body verifies", async () => {
  const merchant = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`,
    [`Refund Webhook ${randomUUID()}`],
  );
  const merchantId = merchant.rows[0]!.id;
  const user = await pool.query<{ id: string }>(
    `INSERT INTO merchant_users (merchant_id, email, role, password_hash)
     VALUES ($1, $2, 'owner', 'unused') RETURNING id`,
    [merchantId, `owner-${randomUUID()}@example.test`],
  );
  await recordKycReview(pool, { merchantId, outcome: "approved", reviewerIdentifier: "test" });
  const { rawKey } = await issueApiKey(pool, config, { merchantId, createdBy: user.rows[0]!.id, label: "webhook" });
  const endpointUrl = `https://refund-${randomUUID()}.example.com/hook`;
  const endpoint = await createWebhookEndpoint(pool, config, {
    merchantId,
    url: endpointUrl,
    createdByType: "merchant_session",
    createdById: randomUUID(),
  });
  const headers = (): Record<string, string> => ({
    authorization: `Bearer ${rawKey}`,
    "idempotency-key": randomUUID(),
  });

  const auth = await app.inject({
    method: "POST",
    url: "/v1/transactions",
    headers: headers(),
    payload: { amountFils: 7_500, card: VALID_CARD, reference: "refund-webhook" },
  });
  const txnId = (auth.json() as { id: string }).id;
  const cap = await app.inject({ method: "POST", url: `/v1/transactions/${txnId}/capture`, headers: headers(), payload: {} });
  assert.equal(cap.statusCode, 200, cap.body);
  const refund = await app.inject({
    method: "POST",
    url: "/v1/refunds",
    headers: headers(),
    payload: { transactionId: txnId, amountFils: 2_500, reason: "damaged item" },
  });
  assert.equal(refund.statusCode, 200, refund.body);
  const refundBody = refund.json() as { id: string; feeReversedFils: number };

  const sent: WebhookTransportRequest[] = [];
  const transport: WebhookTransport = async (req) => {
    if (req.url === endpointUrl) sent.push(req);
    return { statusCode: 200, body: "ok" };
  };
  await runDispatchPass(pool, transport, config);
  await runDispatchPass(pool, transport, config); // a second pass must not re-send

  const refundDeliveries = sent.filter((r) => (JSON.parse(r.body) as { type: string }).type === "refund.succeeded");
  assert.equal(refundDeliveries.length, 1);
  const req = refundDeliveries[0]!;

  // A receiver verifies the raw bytes it received, without re-parsing.
  const verified = verifyRawBodySignature(req.body, req.headers[WEBHOOK_SIGNATURE_HEADER]!, endpoint.secret);
  assert.deepEqual(verified, { valid: true });
  const tampered = verifyRawBodySignature(
    req.body.replace("2500", "25000"),
    req.headers[WEBHOOK_SIGNATURE_HEADER]!,
    endpoint.secret,
  );
  assert.equal(tampered.valid, false);

  const envelope = JSON.parse(req.body) as { id: string; type: string; data: Record<string, unknown> };
  assert.equal(envelope.id, req.headers[WEBHOOK_DELIVERY_ID_HEADER]);
  assert.deepEqual(
    { ...envelope.data, occurredAt: undefined },
    {
      refundId: refundBody.id,
      transactionId: txnId,
      merchantId,
      amountFils: 2_500,
      feeReversedFils: refundBody.feeReversedFils,
      refundedTotalFils: 2_500,
      transactionStatus: "partially_refunded",
      reason: "damaged item",
      occurredAt: undefined,
    },
  );
  assert.equal(refundBody.feeReversedFils, 63, "7,500 at 250 bps = 188 (187.5 to even); 2,500/7,500 of it = 62.67 -> 63");
});
