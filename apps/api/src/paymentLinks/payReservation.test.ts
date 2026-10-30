/**
 * A payment link is single-use: however slow the acquirer, at most one buyer
 * can ever capture it. A buyer whose reservation timed out mid-payment must
 * not capture after another buyer re-claimed the link. Requires DATABASE_URL
 * to point at a real, migrated Postgres (run `npm run migrate` first).
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { Pool } from "pg";
import { loadConfig } from "../config.js";
import { createAcquirerSimulator } from "../acquirer/simulator.js";
import type { AcquirerSimulator } from "../acquirer/types.js";
import { recordKycReview } from "../onboarding/review.js";
import { payPaymentLink } from "./pay.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error(
    "payReservation.test.ts requires DATABASE_URL to point at a real, migrated Postgres (run `npm run migrate` first)",
  );
}

const config = loadConfig({
  DATABASE_URL: databaseUrl,
  NODE_ENV: "test",
  ACQUIRER_FAILURE_RATE: "0",
  ACQUIRER_LATENCY_MIN_MS: "0",
  ACQUIRER_LATENCY_MAX_MS: "1",
  PAYMENT_LINK_RESERVATION_TIMEOUT_SECONDS: "60",
  WEBHOOK_SECRET_ENCRYPTION_KEY: "Y1ZTGTcYbe30GZJebys9w7T3OYZNKewuOH3SUCEdRQk=",
});

const pool = new Pool({ connectionString: databaseUrl, max: 5 });

test.after(async () => {
  await pool.end();
});

const CARD = { pan: "4242424242424242", expiryMonth: 12, expiryYear: 2030, cvv: "123" };
const LINK_AMOUNT_FILS = 128_450;

// ---------------------------------------------------------------- fixtures

async function createLink(): Promise<{ linkId: string; token: string; merchantId: string }> {
  const merchant = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`,
    [`Pay Reservation ${randomUUID().slice(0, 8)}`],
  );
  const merchantId = merchant.rows[0]!.id;
  await recordKycReview(pool, { merchantId, outcome: "approved", reviewerIdentifier: "test" });

  const token = `plt_${randomUUID()}`;
  const link = await pool.query<{ id: string }>(
    `INSERT INTO payment_links (merchant_id, token, amount_fils, expires_at, created_by_type, created_by_id)
     VALUES ($1, $2, $3, now() + interval '1 day', 'merchant_api_key', $4) RETURNING id`,
    [merchantId, token, LINK_AMOUNT_FILS, randomUUID()],
  );
  return { linkId: link.rows[0]!.id, token, merchantId };
}

/** The simulator, with the first call of `step` held until `release()`. */
function stallFirst(step: "authorize" | "capture") {
  const real = createAcquirerSimulator(config);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let stalled = false;
  const reached = { value: false };
  const acquirer: AcquirerSimulator = {
    ...real,
    [step]: async (req: never) => {
      if (!stalled) {
        stalled = true;
        reached.value = true;
        await gate;
      }
      return (real[step] as (r: never) => Promise<unknown>)(req);
    },
  } as AcquirerSimulator;
  return { acquirer, release, reached };
}

async function waitFor(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 500 && !condition(); i++) await delay(10);
  assert.ok(condition(), "timed out waiting for the stalled acquirer call");
}

async function capturedFils(merchantId: string): Promise<number> {
  const result = await pool.query<{ total: string }>(
    `SELECT COALESCE(SUM(te.amount_fils), 0)::text AS total
       FROM transaction_events te JOIN transactions t ON t.id = te.transaction_id
      WHERE t.merchant_id = $1 AND te.event_type IN ('captured', 'partially_captured')`,
    [merchantId],
  );
  return Number(result.rows[0]!.total);
}

/** Buyer 1 stalls at `step`; its reservation times out; buyer 2 tries to pay. */
async function raceTwoBuyers(step: "authorize" | "capture") {
  const { linkId, token, merchantId } = await createLink();
  const { acquirer, release, reached } = stallFirst(step);

  const buyer1 = payPaymentLink(pool, acquirer, config, { token, card: CARD, idempotencyKey: randomUUID() });
  await waitFor(() => reached.value);
  await pool.query(`UPDATE payment_links SET reserved_at = now() - interval '61 seconds' WHERE id = $1`, [linkId]);

  const buyer2 = await payPaymentLink(pool, acquirer, config, { token, card: CARD, idempotencyKey: randomUUID() });
  release();
  const buyer1Result = await buyer1;

  return { buyer1: buyer1Result, buyer2, capturedFils: await capturedFils(merchantId) };
}

// ------------------------------------------------------------------ tests

test("a buyer whose reservation timed out during authorize cannot capture after another buyer paid", async () => {
  const { buyer1, buyer2, capturedFils: captured } = await raceTwoBuyers("authorize");

  assert.equal(buyer2.statusCode, 200, JSON.stringify(buyer2.body));
  assert.equal(buyer1.statusCode, 409, JSON.stringify(buyer1.body));
  assert.equal(captured, LINK_AMOUNT_FILS, "the link must be captured exactly once");
});

test("a reservation whose capture is in flight cannot be re-claimed by timeout", async () => {
  const { buyer1, buyer2, capturedFils: captured } = await raceTwoBuyers("capture");

  assert.equal(buyer2.statusCode, 409, JSON.stringify(buyer2.body));
  assert.equal(buyer1.statusCode, 200, JSON.stringify(buyer1.body));
  assert.equal(captured, LINK_AMOUNT_FILS, "the link must be captured exactly once");
});
