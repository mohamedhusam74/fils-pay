-- FP-212 refunds: the schema pieces the refund flow needs beyond 0042-0044.
--
-- 1. A database-level refund ceiling. 0043 left the ceiling to the
--    application, but "never refund more than was captured" only needs the
--    row itself. processRefund also enforces it under a row lock; this
--    constraint is the backstop if any other writer gets it wrong.
--    NOT VALID: rows written before this migration (finance's manual Q1
--    refunds) are not re-checked here; new and updated rows are. Validate
--    once production data has been checked (see docs/DEPLOY-DILMUNE.md).
ALTER TABLE transactions
    ADD CONSTRAINT transactions_refunded_within_captured
    CHECK (refunded_fils <= captured_fils) NOT VALID;

-- 2. Settlement batches net refunds against captures.
--    net_payout_fils = gross_fils - fee_fils
--                      - refund_fils + refund_fee_reversed_fils
--                      + carried_in_fils
--    A day whose refunds exceed its captures closes with a negative net.
--    That deficit is carried into the merchant's next batch: the next
--    CloseBatch adds it as carried_in_fils (always <= 0) and stamps the
--    negative batch with carried_to_batch_id, so each deficit is absorbed
--    exactly once.
ALTER TABLE settlement_batches
    ADD COLUMN refund_fils              BIGINT NOT NULL DEFAULT 0 CHECK (refund_fils >= 0),
    ADD COLUMN refund_fee_reversed_fils BIGINT NOT NULL DEFAULT 0 CHECK (refund_fee_reversed_fils >= 0),
    ADD COLUMN carried_in_fils          BIGINT NOT NULL DEFAULT 0 CHECK (carried_in_fils <= 0),
    ADD COLUMN carried_to_batch_id      UUID REFERENCES settlement_batches (id);

-- The lookup CloseBatch makes: "this merchant's negative batches not yet
-- carried into a later one".
CREATE INDEX idx_settlement_batches_uncarried_deficit
    ON settlement_batches (merchant_id)
    WHERE net_payout_fils < 0 AND carried_to_batch_id IS NULL;

-- 3. Refund figures on the reporting rollup (apps/reporting applies
--    refund.succeeded here, bucketed by Asia/Bahrain date like captures).
ALTER TABLE merchant_daily_volume
    ADD COLUMN refund_count      INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN refund_gross_fils BIGINT  NOT NULL DEFAULT 0;

-- 4. Rebuild refund_merchant_summary (0072). It joined transactions on
--    t.id = r.id, which never matches, and summed captured_fils once per
--    refund row, which double-counts a transaction refunded more than once.
--    Same columns and grain as before.
DROP MATERIALIZED VIEW refund_merchant_summary;

CREATE MATERIALIZED VIEW refund_merchant_summary AS
WITH daily AS (
    SELECT r.merchant_id,
           date_trunc('day', r.occurred_at AT TIME ZONE 'Asia/Bahrain') AS business_date,
           r.transaction_id,
           r.amount_fils,
           r.fee_reversed_fils
      FROM refunds r
     WHERE r.status = 'succeeded'
)
SELECT d.merchant_id,
       d.business_date,
       COUNT(*)                  AS refund_count,
       SUM(d.amount_fils)        AS total_refunded_fils,
       SUM(d.fee_reversed_fils)  AS total_fee_reversed_fils,
       (SELECT COALESCE(SUM(t.captured_fils), 0)
          FROM transactions t
         WHERE t.id IN (SELECT d2.transaction_id
                          FROM daily d2
                         WHERE d2.merchant_id = d.merchant_id
                           AND d2.business_date = d.business_date)) AS original_captured_fils
  FROM daily d
 GROUP BY d.merchant_id, d.business_date;

CREATE UNIQUE INDEX idx_refund_merchant_summary_pk
    ON refund_merchant_summary (merchant_id, business_date);
