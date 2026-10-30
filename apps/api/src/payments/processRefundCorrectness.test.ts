/**
 * FP-212 refund correctness against a real, migrated Postgres: the refund
 * ceiling (audit L9), concurrent refunds (L10), merchant scoping (L11), fee
 * reversal summing exactly to the fee charged, and ledger balances to the
 * fil. Requires `DATABASE_URL` (run `npm run migrate` first).
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { toFils, type Fils } from "@filspay/money";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { issueApiKey } from "../apiKeys/issue.js";
import { recordKycReview } from "../onboarding/review.js";
import type { AcquirerRefundResult, AcquirerSimulator } from "../acquirer/types.js";
import { DEFAULT_REFUND_REASON, processRefund, refundFeeReversalFils } from "./processRefund.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("processRefundCorrectness.test.ts requires DATABASE_URL to point at a real, migrated Postgres");
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

const pool = new Pool({ connectionString: databaseUrl, max: 10 });
const app = buildApp(config, pool);

test.after(async () => {
  await app.close();
  await pool.end();
});

const VALID_CARD = { pan: "4242424242424242", expiryMonth: 12, expiryYear: 2030, cvv: "123" };

/** Approves every refund after `delayMs`, so concurrent callers overlap
 *  while the first one is inside the acquirer call. */
function approvingAcquirer(delayMs = 0): AcquirerSimulator {
  return {
    authorize() {
      throw new Error("approvingAcquirer: authorize is not used by these tests");
    },
    capture() {
      throw new Error("approvingAcquirer: capture is not used by these tests");
    },
    async refund(req): Promise<AcquirerRefundResult> {
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
      return { outcome: "approved", acquirerReference: `${req.acquirerReference}:refund`, latencyMs: delayMs };
    },
  };
}

interface TestMerchant {
  merchantId: string;
  rawKey: string;
  actor: { type: "merchant_api_key"; id: string };
}

async function createMerchant(label: string, mdrBps = 250, discountBps = 0): Promise<TestMerchant> {
  const merchantResult = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps, negotiated_discount_bps) VALUES ($1, $2, $3) RETURNING id`,
    [`Refund Correctness ${label} ${randomUUID()}`, mdrBps, discountBps],
  );
  const merchantId = merchantResult.rows[0]!.id;
  const userResult = await pool.query<{ id: string }>(
    `INSERT INTO merchant_users (merchant_id, email, role, password_hash)
     VALUES ($1, $2, 'owner', 'unused-in-these-tests') RETURNING id`,
    [merchantId, `owner-${randomUUID()}@example.test`],
  );
  await recordKycReview(pool, { merchantId, outcome: "approved", reviewerIdentifier: "test" });
  const issued = await issueApiKey(pool, config, { merchantId, createdBy: userResult.rows[0]!.id, label });
  const key = await pool.query<{ id: string }>(
    `SELECT id FROM api_keys WHERE merchant_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [merchantId],
  );
  return { merchantId, rawKey: issued.rawKey, actor: { type: "merchant_api_key", id: key.rows[0]!.id } };
}

async function authorize(merchant: TestMerchant, amountFils: number): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/v1/transactions",
    headers: { authorization: `Bearer ${merchant.rawKey}`, "idempotency-key": randomUUID() },
    payload: { amountFils, card: VALID_CARD, reference: "refund-correctness" },
  });
  assert.equal(res.statusCode, 201, res.body);
  return (res.json() as { id: string }).id;
}

async function capture(merchant: TestMerchant, transactionId: string, amountFils?: number): Promise<void> {
  const res = await app.inject({
    method: "POST",
    url: `/v1/transactions/${transactionId}/capture`,
    headers: { authorization: `Bearer ${merchant.rawKey}`, "idempotency-key": randomUUID() },
    payload: amountFils === undefined ? {} : { amountFils },
  });
  assert.equal(res.statusCode, 200, res.body);
}

function refund(merchant: TestMerchant, transactionId: string, amountFils?: number, delayMs = 0) {
  return processRefund(pool, approvingAcquirer(delayMs), {
    transactionId,
    merchantId: merchant.merchantId,
    amountFils: amountFils === undefined ? undefined : toFils(amountFils),
    idempotencyKey: randomUUID(),
    actor: merchant.actor,
  });
}

async function transactionRow(id: string): Promise<{ status: string; captured: number; refunded: number }> {
  const r = await pool.query<{ status: string; captured_fils: string; refunded_fils: string }>(
    `SELECT status, captured_fils, refunded_fils FROM transactions WHERE id = $1`,
    [id],
  );
  const row = r.rows[0]!;
  return { status: row.status, captured: Number(row.captured_fils), refunded: Number(row.refunded_fils) };
}

/** Net (credit - debit) per account for one transaction's ledger legs. */
async function ledgerNetByAccount(transactionId: string): Promise<Map<string, number>> {
  const r = await pool.query<{ account_id: string; net: string }>(
    `SELECT account_id, SUM(CASE WHEN direction = 'credit' THEN amount_fils ELSE -amount_fils END)::text AS net
       FROM ledger_entries WHERE transaction_id = $1 GROUP BY account_id`,
    [transactionId],
  );
  return new Map(r.rows.map((row) => [row.account_id, Number(row.net)]));
}

async function refundSums(transactionId: string): Promise<{ count: number; amount: number; feeReversed: number }> {
  const r = await pool.query<{ c: number; amount: string; fee: string }>(
    `SELECT COUNT(*)::int AS c, COALESCE(SUM(amount_fils), 0)::text AS amount,
            COALESCE(SUM(fee_reversed_fils), 0)::text AS fee
       FROM refunds WHERE transaction_id = $1`,
    [transactionId],
  );
  const row = r.rows[0]!;
  return { count: row.c, amount: Number(row.amount), feeReversed: Number(row.fee) };
}

// ---------------------------------------------------------------- pure fee

test("refundFeeReversalFils: partials of any split sum exactly to the original fee", () => {
  let seed = 42;
  const next = (n: number): number => {
    seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
    return seed % n;
  };
  for (let run = 0; run < 2_000; run++) {
    const captured = 1 + next(500_000);
    const fee = next(Math.max(1, Math.floor(captured / 10)));
    let refunded = 0;
    let reversed = 0;
    while (refunded < captured) {
      const part = 1 + next(captured - refunded);
      const after = refunded + part;
      const delta = refundFeeReversalFils({
        capturedFils: toFils(captured),
        refundedTotalAfterFils: toFils(after),
        fee: { originalNetFeeFils: toFils(fee), alreadyReversedFils: toFils(reversed) },
      });
      assert.ok(delta >= 0, "a refund never claws fee back");
      reversed += delta;
      assert.ok(reversed <= fee, `cumulative reversal ${reversed} exceeded fee ${fee}`);
      refunded = after;
    }
    assert.equal(reversed, fee, `captured ${captured}, fee ${fee}`);
  }
});

test("refundFeeReversalFils: the two drifting cases from per-partial rounding are exact", () => {
  const reverse = (captured: number, fee: number, parts: number[]): number[] => {
    const out: number[] = [];
    let refunded = 0;
    let reversed = 0;
    for (const p of parts) {
      refunded += p;
      const d = refundFeeReversalFils({
        capturedFils: toFils(captured),
        refundedTotalAfterFils: toFils(refunded),
        fee: { originalNetFeeFils: toFils(fee), alreadyReversedFils: toFils(reversed) },
      });
      reversed += d;
      out.push(d);
    }
    return out;
  };
  // Per-partial rounding gave 8+8+8 = 24 and 2+2 = 4.
  assert.deepEqual(reverse(1_000, 25, [333, 333, 334]), [8, 9, 8]);
  assert.deepEqual(reverse(1_000, 3, [500, 500]), [2, 1]);
});

test("refundFeeReversalFils refuses a refunded total above captured", () => {
  assert.throws(
    () =>
      refundFeeReversalFils({
        capturedFils: toFils(100),
        refundedTotalAfterFils: toFils(101),
        fee: { originalNetFeeFils: toFils(3), alreadyReversedFils: toFils(0) },
      }),
    RangeError,
  );
});

// ------------------------------------------------------------ L9: ceiling

test("L9: a refund larger than the captured amount is refused (partial capture)", async () => {
  const merchant = await createMerchant("l9-over");
  const txnId = await authorize(merchant, 10_000);
  await capture(merchant, txnId, 4_000);

  const result = await refund(merchant, txnId, 4_001);
  assert.equal(result.statusCode, 422);
  assert.deepEqual(result.body, { ok: false, code: "refund_exceeds_refundable", refundableFils: 4_000 });
  assert.equal((await refundSums(txnId)).count, 0);
});

test("L9: after refunding everything captured, nothing more is refundable", async () => {
  const merchant = await createMerchant("l9-drain");
  const txnId = await authorize(merchant, 10_000);
  await capture(merchant, txnId, 4_000);

  const first = await refund(merchant, txnId);
  assert.equal(first.statusCode, 200, JSON.stringify(first.body));
  assert.equal((first.body as { amountFils: number }).amountFils, 4_000, "omitted amount refunds the captured remainder");
  // Decision 1: a partially captured row keeps its capture status.
  assert.deepEqual(await transactionRow(txnId), { status: "partially_captured", captured: 4_000, refunded: 4_000 });

  const second = await refund(merchant, txnId, 6_000);
  assert.equal(second.statusCode, 422);
  assert.deepEqual(second.body, { ok: false, code: "refund_exceeds_refundable", refundableFils: 0 });

  const sums = await refundSums(txnId);
  assert.equal(sums.amount, 4_000);
  assert.equal(sums.feeReversed, 100, "4,000 at 250 bps: exactly the 100-fil fee, never 250");
});

test("L9: the database refuses refunded_fils above captured_fils", async () => {
  const merchant = await createMerchant("l9-db");
  const txnId = await authorize(merchant, 5_000);
  await capture(merchant, txnId, 2_000);
  await assert.rejects(
    () => pool.query(`UPDATE transactions SET refunded_fils = 2_001 WHERE id = $1`, [txnId]),
    /transactions_refunded_within_captured/,
  );
});

test("capturing more after a full refund of a partial capture keeps the refund in the status", async () => {
  const merchant = await createMerchant("capture-after-refund");
  const txnId = await authorize(merchant, 10_000);
  await capture(merchant, txnId, 4_000);
  assert.equal((await refund(merchant, txnId, 4_000)).statusCode, 200);

  await capture(merchant, txnId); // the remaining 6,000
  assert.deepEqual(await transactionRow(txnId), { status: "partially_refunded", captured: 10_000, refunded: 4_000 });

  assert.equal((await refund(merchant, txnId)).statusCode, 200);
  assert.deepEqual(await transactionRow(txnId), { status: "refunded", captured: 10_000, refunded: 10_000 });

  const sums = await refundSums(txnId);
  assert.equal(sums.amount, 10_000);
  assert.equal(sums.feeReversed, 250, "both captures' fees come back, exactly");
  const net = await ledgerNetByAccount(txnId);
  assert.equal(net.get("merchant_payable"), 0);
  assert.equal(net.get("platform_fee_revenue"), 0);
  assert.equal(net.get("card_scheme_clearing"), 0);
});

// ---------------------------------------------------- L10: concurrency

test("L10: two simultaneous refunds with different keys cannot both succeed", async () => {
  const merchant = await createMerchant("l10-pair");
  const txnId = await authorize(merchant, 10_000);
  await capture(merchant, txnId);

  const results = await Promise.all([refund(merchant, txnId, 6_000, 50), refund(merchant, txnId, 6_000, 50)]);
  const codes = results.map((r) => r.statusCode).sort();
  assert.deepEqual(codes, [200, 422]);

  assert.deepEqual(await transactionRow(txnId), { status: "partially_refunded", captured: 10_000, refunded: 6_000 });
  const sums = await refundSums(txnId);
  assert.equal(sums.count, 1);
  assert.equal(sums.amount, 6_000);
  const gross = await pool.query<{ total: string }>(
    `SELECT COALESCE(SUM(amount_fils), 0)::text AS total FROM ledger_entries
      WHERE transaction_id = $1 AND description = 'refund: gross' AND direction = 'debit'`,
    [txnId],
  );
  assert.equal(Number(gross.rows[0]!.total), 6_000);
});

test("L10: a burst of concurrent partial refunds stops exactly at the captured amount", async () => {
  const merchant = await createMerchant("l10-burst", 250);
  const txnId = await authorize(merchant, 10_000);
  await capture(merchant, txnId);

  const results = await Promise.all(Array.from({ length: 6 }, () => refund(merchant, txnId, 3_000, 20)));
  assert.equal(results.filter((r) => r.statusCode === 200).length, 3);
  assert.equal(results.filter((r) => r.statusCode === 422).length, 3);

  const remainder = await refund(merchant, txnId);
  assert.equal(remainder.statusCode, 200);
  assert.equal((remainder.body as { amountFils: number }).amountFils, 1_000);

  assert.deepEqual(await transactionRow(txnId), { status: "refunded", captured: 10_000, refunded: 10_000 });
  const sums = await refundSums(txnId);
  assert.equal(sums.amount, 10_000);
  assert.equal(sums.feeReversed, 250);
});

test("L10: the same idempotency key sent twice at once refunds once", async () => {
  const merchant = await createMerchant("l10-same-key");
  const txnId = await authorize(merchant, 8_000);
  await capture(merchant, txnId);
  const key = randomUUID();
  const send = () =>
    processRefund(pool, approvingAcquirer(50), {
      transactionId: txnId,
      merchantId: merchant.merchantId,
      amountFils: toFils(3_000),
      idempotencyKey: key,
      actor: merchant.actor,
    });

  const [a, b] = await Promise.all([send(), send()]);
  assert.equal(a.statusCode, 200, JSON.stringify(a.body));
  assert.equal(b.statusCode, 200, JSON.stringify(b.body));
  assert.deepEqual(a.body, b.body);
  assert.equal((await refundSums(txnId)).count, 1);
  assert.equal((await transactionRow(txnId)).refunded, 3_000);
});

// ---------------------------------------------------- L11: merchant scope

test("L11: a merchant cannot refund another merchant's transaction", async () => {
  const owner = await createMerchant("l11-owner");
  const attacker = await createMerchant("l11-attacker");
  const txnId = await authorize(owner, 5_000);
  await capture(owner, txnId);

  const result = await refund(attacker, txnId, 5_000);
  assert.equal(result.statusCode, 404);
  assert.deepEqual(result.body, { error: "transaction_not_found" });

  assert.equal((await refundSums(txnId)).count, 0);
  assert.deepEqual(await transactionRow(txnId), { status: "captured", captured: 5_000, refunded: 0 });
  const ownerKeys = await pool.query<{ c: number }>(
    `SELECT COUNT(*)::int AS c FROM idempotency_keys WHERE merchant_id = $1 AND endpoint = 'refunds.create'`,
    [owner.merchantId],
  );
  assert.equal(ownerKeys.rows[0]!.c, 0, "nothing is filed under the victim merchant");
});

// ------------------------------------------------------- fees and ledger

test("multiple partial refunds reverse exactly the fee charged (333/333/334 on a 25-fil fee)", async () => {
  const merchant = await createMerchant("fee-thirds", 250);
  const txnId = await authorize(merchant, 1_000);
  await capture(merchant, txnId);

  const reversals: number[] = [];
  for (const part of [333, 333, 334]) {
    const result = await refund(merchant, txnId, part);
    assert.equal(result.statusCode, 200, JSON.stringify(result.body));
    reversals.push((result.body as { feeReversedFils: number }).feeReversedFils);
  }
  assert.deepEqual(reversals, [8, 9, 8]);
  assert.equal((await refundSums(txnId)).feeReversed, 25);

  const net = await ledgerNetByAccount(txnId);
  assert.equal(net.get("merchant_payable"), 0);
  assert.equal(net.get("platform_fee_revenue"), 0);
  assert.equal(net.get("card_scheme_clearing"), 0);
});

test("a negotiated-discount merchant gets back the net fee it paid, not the gross MDR", async () => {
  // 10,000 at 250 bps = 250 fee; 2,000 bps discount off the fee = 50 rebate.
  const merchant = await createMerchant("fee-discount", 250, 2_000);
  const txnId = await authorize(merchant, 10_000);
  await capture(merchant, txnId);

  const before = await ledgerNetByAccount(txnId);
  assert.equal(before.get("platform_fee_revenue"), 200, "capture fee 250 less the 50 discount rebate");

  const half = await refund(merchant, txnId, 5_000);
  assert.equal((half.body as { feeReversedFils: number }).feeReversedFils, 100);
  const rest = await refund(merchant, txnId);
  assert.equal((rest.body as { feeReversedFils: number }).feeReversedFils, 100);

  const net = await ledgerNetByAccount(txnId);
  assert.equal(net.get("merchant_payable"), 0, "merchant ends exactly where it started");
  assert.equal(net.get("platform_fee_revenue"), 0);
});

test("a refund without a reason is stored with the 0070 default instead of failing", async () => {
  const merchant = await createMerchant("reason-default");
  const txnId = await authorize(merchant, 2_000);
  await capture(merchant, txnId);

  const result = await refund(merchant, txnId);
  assert.equal(result.statusCode, 200, JSON.stringify(result.body));
  const row = await pool.query<{ reason: string }>(`SELECT reason FROM refunds WHERE transaction_id = $1`, [txnId]);
  assert.equal(row.rows[0]!.reason, DEFAULT_REFUND_REASON);
});

test("a full refund leaves every account for the transaction at zero, to the fil", async () => {
  const merchant = await createMerchant("ledger-zero", 275);
  const txnId = await authorize(merchant, 12_345);
  await capture(merchant, txnId);

  const result = await refund(merchant, txnId);
  assert.equal(result.statusCode, 200, JSON.stringify(result.body));
  const body = result.body as { amountFils: Fils; feeReversedFils: Fils; refundedTotalFils: Fils };
  assert.equal(body.amountFils, 12_345);
  assert.equal(body.refundedTotalFils, 12_345);

  const net = await ledgerNetByAccount(txnId);
  for (const [account, value] of net) {
    assert.equal(value, 0, `${account} nets to ${value}`);
  }
});
