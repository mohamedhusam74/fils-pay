import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { ZERO_FILS, addFils, calculateRefundFee, compareFils, subtractFils, toFils, type Fils } from "@filspay/money";
import { enqueueEvent } from "@filspay/events";
import { withTransaction } from "../db/withTransaction.js";
import type { AcquirerSimulator } from "../acquirer/types.js";
import { claimIdempotencyKey, completeIdempotencyKey, failIdempotencyKey, hashRequest } from "./idempotency.js";
import { recordTransactionEvent } from "../transactions/events.js";
import { nextStatusAfterRefund } from "./refundState.js";
import { validateRefundRequest } from "./refundValidation.js";
import { ConflictError, UnprocessableEntityError } from "../lib/errors.js";

const ENDPOINT = "refunds.create";

/** The value 0070 gives refunds.reason as its column default; its CHECK
 *  rejects an explicit NULL, so an omitted reason is written as this. */
export const DEFAULT_REFUND_REASON = "unspecified";

export interface ProcessRefundInput {
  transactionId: string;
  /** The authenticated merchant. The transaction must belong to it. */
  merchantId: string;
  amountFils?: Fils;
  idempotencyKey: string;
  actor: { type: "merchant_session" | "merchant_api_key"; id: string };
  reason?: string;
}

export interface ProcessRefundResult {
  statusCode: number;
  body: unknown;
}

interface LockedTransactionRow {
  id: string;
  merchant_id: string;
  status: string;
  amount_fils: string | number;
  captured_fils: string | number;
  refunded_fils: string | number;
  acquirer_reference: string;
}

/** What the fee side of this transaction looks like before this refund. */
export interface RefundFeePosition {
  /** Net MDR the transaction was charged: capture fee legs minus the
   *  negotiated-discount rebate and any other fee corrections. */
  originalNetFeeFils: Fils;
  /** Fee already given back by earlier refunds of this transaction. */
  alreadyReversedFils: Fils;
}

/**
 * The fee this refund gives back, computed on the running total rather than
 * per refund: after this refund the transaction has reversed
 * round(originalNetFee * refundedTotalAfter / captured) in total, and this
 * refund's share is that minus what earlier refunds already reversed.
 *
 * Rounding each partial on its own (the old behaviour) drifts: a 25-fil fee
 * refunded as 333/333/334 reversed 8+8+8 = 24, and a 3-fil fee refunded as
 * 500/500 reversed 2+2 = 4. On the running total the last refund always
 * lands the cumulative figure exactly on the original fee, and the total can
 * never exceed it because refundedTotalAfter <= captured.
 */
export function refundFeeReversalFils(input: {
  capturedFils: Fils;
  refundedTotalAfterFils: Fils;
  fee: RefundFeePosition;
}): Fils {
  const { capturedFils, refundedTotalAfterFils, fee } = input;
  if (compareFils(refundedTotalAfterFils, capturedFils) > 0) {
    throw new RangeError("refundFeeReversalFils: refunded total exceeds the captured amount");
  }
  const cumulativeTarget = calculateRefundFee(capturedFils, fee.originalNetFeeFils, refundedTotalAfterFils);
  const delta = subtractFils(cumulativeTarget, fee.alreadyReversedFils);
  // A later capture at a lower rate can pull the pro-rata target below what
  // was already reversed; never claw fee back on a refund.
  return compareFils(delta, ZERO_FILS) < 0 ? ZERO_FILS : delta;
}

/**
 * Reads the fee position from the ledger and the refunds table. Every leg on
 * platform_fee_revenue for this transaction counts: capture's MDR credit, the
 * negotiated-discount debit (discountAdjustment.ts), and earlier refund
 * reversals (debits). Adding the reversals back gives the net fee the
 * transaction was charged.
 */
async function readFeePosition(client: PoolClient, transactionId: string): Promise<RefundFeePosition> {
  const result = await client.query<{ fee_outstanding: string; already_reversed: string }>(
    `SELECT
       (SELECT COALESCE(SUM(CASE WHEN direction = 'credit' THEN amount_fils ELSE -amount_fils END), 0)
          FROM ledger_entries
         WHERE transaction_id = $1 AND account_id = 'platform_fee_revenue')::text AS fee_outstanding,
       (SELECT COALESCE(SUM(fee_reversed_fils), 0)
          FROM refunds
         WHERE transaction_id = $1 AND status = 'succeeded')::text AS already_reversed`,
    [transactionId],
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error("processRefund: fee position query returned no row");
  }
  const alreadyReversedFils = toFils(Number(row.already_reversed));
  const originalNetFee = addFils(toFils(Number(row.fee_outstanding), { allowNegative: true }), alreadyReversedFils);
  return {
    originalNetFeeFils: compareFils(originalNetFee, ZERO_FILS) < 0 ? ZERO_FILS : originalNetFee,
    alreadyReversedFils,
  };
}

/**
 * `POST /v1/refunds` business logic. Same shape as captureTransaction: one
 * database transaction, the transaction row locked `FOR UPDATE` (scoped to
 * the authenticated merchant) before validation and held across the
 * acquirer call. Two refunds of one transaction therefore run one after the
 * other, and the second validates against the first's committed total, so
 * the sum of refunds can never pass captured_fils.
 */
export async function processRefund(
  pool: Pool,
  acquirer: AcquirerSimulator,
  input: ProcessRefundInput,
): Promise<ProcessRefundResult> {
  const requestHash = hashRequest({
    transactionId: input.transactionId,
    amountFils: input.amountFils ?? null,
    reason: input.reason ?? null,
  });

  return withTransaction(pool, async (client) => {
    const claim = await claimIdempotencyKey(client, {
      merchantId: input.merchantId,
      endpoint: ENDPOINT,
      key: input.idempotencyKey,
      requestHash,
    });

    if (claim.outcome === "conflict_hash_mismatch") {
      throw new UnprocessableEntityError("idempotency_key_reused");
    }
    if (claim.outcome === "conflict_in_progress") {
      throw new ConflictError("request_in_progress");
    }
    if (claim.outcome === "replay") {
      return { statusCode: claim.row.responseStatusCode ?? 200, body: claim.row.responseBody };
    }

    // Lock first, scoped to the caller's merchant: another merchant's
    // transaction is indistinguishable from a missing one.
    const lockResult = await client.query<LockedTransactionRow>(
      `SELECT id, merchant_id, status, amount_fils, captured_fils, refunded_fils, acquirer_reference
         FROM transactions
        WHERE id = $1 AND merchant_id = $2
        FOR UPDATE`,
      [input.transactionId, input.merchantId],
    );
    const txn = lockResult.rows[0];
    if (!txn) {
      const body = { error: "transaction_not_found" };
      await completeIdempotencyKey(client, claim.row.id, { statusCode: 404, body });
      return { statusCode: 404, body };
    }

    const amountAuthorized = toFils(Number(txn.amount_fils));
    const capturedFils = toFils(Number(txn.captured_fils));
    const refundedFils = toFils(Number(txn.refunded_fils));

    // The ceiling is what was captured, not what was authorized: money that
    // was only ever authorized never reached the merchant.
    const refundableFils = subtractFils(capturedFils, refundedFils);

    const validation = validateRefundRequest(
      {
        id: txn.id,
        merchantId: txn.merchant_id,
        status: txn.status,
        capturedFils,
        refundableFils: compareFils(refundableFils, ZERO_FILS) < 0 ? ZERO_FILS : refundableFils,
      },
      input.amountFils,
    );

    if (!validation.ok) {
      const statusCode = validation.code === "transaction_not_refundable" ? 409 : 422;
      await completeIdempotencyKey(client, claim.row.id, { statusCode, body: validation });
      return { statusCode, body: validation };
    }

    const requestedAmount = validation.amountFils;
    const feePosition = await readFeePosition(client, txn.id);

    // Acquirer call with the row lock still held. The acquirer key is built
    // from the caller's idempotency key rather than the claim row id, so if
    // this database transaction rolls back after an approval, a retry with
    // the same key reaches the acquirer with the same key and is replayed
    // there instead of refunding twice. attemptCount moves it on only after
    // a recorded transient failure.
    const acquirerResult = await acquirer.refund({
      acquirerReference: txn.acquirer_reference,
      amountFils: requestedAmount,
      idempotencyKey: `refund:${input.merchantId}:${input.idempotencyKey}:${claim.row.attemptCount}`,
    });

    if (acquirerResult.outcome === "declined") {
      const body = { error: "refund_declined" };
      await completeIdempotencyKey(client, claim.row.id, { statusCode: 402, body });
      return { statusCode: 402, body };
    }
    if (acquirerResult.outcome === "error") {
      const body = { error: "acquirer_unavailable" };
      await failIdempotencyKey(client, claim.row.id, { statusCode: 502, body });
      return { statusCode: 502, body };
    }

    const newRefundedTotal = addFils(refundedFils, requestedAmount);
    const newStatus = nextStatusAfterRefund({
      amountFils: amountAuthorized,
      capturedFils,
      refundedTotalFils: newRefundedTotal,
    });
    const feeReversedFils = refundFeeReversalFils({
      capturedFils,
      refundedTotalAfterFils: newRefundedTotal,
      fee: feePosition,
    });
    const reason = input.reason ?? DEFAULT_REFUND_REASON;

    const refundResult = await client.query<{ id: string; occurred_at: Date }>(
      `INSERT INTO refunds
         (transaction_id, merchant_id, amount_fils, fee_reversed_fils, status,
          acquirer_reference, reason, created_by_type, created_by_id)
       VALUES ($1, $2, $3, $4, 'succeeded', $5, $6, $7, $8)
       RETURNING id, occurred_at`,
      [
        txn.id,
        txn.merchant_id,
        requestedAmount,
        feeReversedFils,
        acquirerResult.acquirerReference,
        reason,
        input.actor.type,
        input.actor.id,
      ],
    );
    const refund = refundResult.rows[0];
    if (!refund) {
      throw new Error("processRefund: insert into refunds returned no row");
    }

    // Incremental, and guarded by the ceiling, so this write can never
    // overwrite another refund's total even if the lock above were missing.
    const updateResult = await client.query(
      `UPDATE transactions
          SET refunded_fils = refunded_fils + $2, status = $3
        WHERE id = $1 AND refunded_fils + $2 <= captured_fils`,
      [txn.id, requestedAmount, newStatus],
    );
    if (updateResult.rowCount !== 1) {
      throw new Error("processRefund: refunded_fils update would exceed captured_fils");
    }

    // Double-entry reversal, mirroring capture's legs with the directions
    // swapped. ledger_entries has CHECK (amount_fils > 0), so a reversal
    // flips direction and never the sign.
    const entryGroupId = randomUUID();
    await client.query(
      `INSERT INTO ledger_entries
         (entry_group_id, merchant_id, transaction_id, account_id, direction, amount_fils, occurred_at, description)
       VALUES
         ($1, $2, $3, 'merchant_payable',     'debit',  $4, $5, 'refund: gross'),
         ($1, $2, $3, 'card_scheme_clearing', 'credit', $4, $5, 'refund: gross')`,
      [entryGroupId, txn.merchant_id, txn.id, requestedAmount, refund.occurred_at],
    );
    if (compareFils(feeReversedFils, ZERO_FILS) > 0) {
      await client.query(
        `INSERT INTO ledger_entries
           (entry_group_id, merchant_id, transaction_id, account_id, direction, amount_fils, occurred_at, description)
         VALUES
           ($1, $2, $3, 'platform_fee_revenue', 'debit',  $4, $5, 'refund: MDR fee reversal'),
           ($1, $2, $3, 'merchant_payable',     'credit', $4, $5, 'refund: MDR fee reversal')`,
        [entryGroupId, txn.merchant_id, txn.id, feeReversedFils, refund.occurred_at],
      );
    }

    // The timeline records what this refund did to the captured amount, so
    // it stays readable regardless of what the status column says: either
    // everything captured has now gone back, or only part of it has.
    const eventType = compareFils(newRefundedTotal, capturedFils) >= 0 ? "refunded" : "refund_partial";

    await recordTransactionEvent(client, {
      transactionId: txn.id,
      eventType,
      amountFils: toFils(-requestedAmount, { allowNegative: true }),
      actor: input.actor,
      metadata: {
        refundId: refund.id,
        feeReversedFils,
        refundedTotalFils: newRefundedTotal,
        acquirerReference: acquirerResult.acquirerReference,
      },
    });

    await enqueueEvent(client, {
      eventType: "refund.succeeded",
      aggregateType: "transaction",
      aggregateId: txn.id,
      payload: {
        merchantId: txn.merchant_id,
        refundId: refund.id,
        amountFils: requestedAmount,
        feeReversedFils,
        refundedTotalFils: newRefundedTotal,
        newStatus,
        reason,
        occurredAt: refund.occurred_at.toISOString(),
      },
    });

    const body = {
      id: refund.id,
      transactionId: txn.id,
      merchantId: txn.merchant_id,
      amountFils: requestedAmount,
      feeReversedFils,
      status: "succeeded",
      reason,
      transactionStatus: newStatus,
      refundedTotalFils: newRefundedTotal,
      acquirerReference: acquirerResult.acquirerReference,
      occurredAt: refund.occurred_at.toISOString(),
    };
    await completeIdempotencyKey(client, claim.row.id, {
      statusCode: 200,
      body,
      resourceId: refund.id,
    });
    return { statusCode: 200, body };
  });
}
