package settlement

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/filspay/settlement/internal/money"
)

// insertRefund writes what apps/api's processRefund commits for one
// succeeded refund: the refunds row, the refunded_fils bump and the
// balanced reversal legs.
func insertRefund(t *testing.T, pool *pgxpool.Pool, merchantID, txnID uuid.UUID, amountFils, feeReversedFils money.Fils, occurredAt time.Time) uuid.UUID {
	t.Helper()
	ctx := context.Background()
	var refundID uuid.UUID
	err := pool.QueryRow(ctx, `
		INSERT INTO refunds (transaction_id, merchant_id, amount_fils, fee_reversed_fils, status,
		                     acquirer_reference, created_by_type, created_by_id, occurred_at)
		VALUES ($1, $2, $3, $4, 'succeeded', 'acq-refund', 'merchant_api_key', $5, $6)
		RETURNING id
	`, txnID, merchantID, int64(amountFils), int64(feeReversedFils), uuid.New(), occurredAt).Scan(&refundID)
	if err != nil {
		t.Fatalf("insertRefund: insert refund: %v", err)
	}
	if _, err := pool.Exec(ctx, `UPDATE transactions SET refunded_fils = refunded_fils + $2 WHERE id = $1`, txnID, int64(amountFils)); err != nil {
		t.Fatalf("insertRefund: bump refunded_fils: %v", err)
	}
	groupID := uuid.New()
	_, err = pool.Exec(ctx, `
		INSERT INTO ledger_entries
		  (entry_group_id, merchant_id, transaction_id, account_id, direction, amount_fils, occurred_at, description)
		VALUES
		  ($1, $2, $3, 'merchant_payable',     'debit',  $4, $6, 'refund: gross'),
		  ($1, $2, $3, 'card_scheme_clearing', 'credit', $4, $6, 'refund: gross'),
		  ($1, $2, $3, 'platform_fee_revenue', 'debit',  $5, $6, 'refund: MDR fee reversal'),
		  ($1, $2, $3, 'merchant_payable',     'credit', $5, $6, 'refund: MDR fee reversal')
	`, groupID, merchantID, txnID, int64(amountFils), int64(feeReversedFils), occurredAt)
	if err != nil {
		t.Fatalf("insertRefund: insert ledger legs: %v", err)
	}
	return refundID
}

func closeAndPay(t *testing.T, pool *pgxpool.Pool, merchantID uuid.UUID, businessDate time.Time) BatchResult {
	t.Helper()
	result, err := CloseBatch(context.Background(), pool, merchantID, businessDate)
	if err != nil {
		t.Fatalf("CloseBatch(%s): %v", businessDate.Format("2006-01-02"), err)
	}
	if _, err := PayoutBatch(context.Background(), pool, result.BatchID); err != nil {
		t.Fatalf("PayoutBatch(%s): %v", businessDate.Format("2006-01-02"), err)
	}
	return result
}

func queryInt(t *testing.T, pool *pgxpool.Pool, query string, args ...any) int64 {
	t.Helper()
	var v int64
	if err := pool.QueryRow(context.Background(), query, args...).Scan(&v); err != nil {
		t.Fatalf("queryInt %q: %v", query, err)
	}
	return v
}

func TestCloseBatch_NetsSameDayRefund(t *testing.T) {
	pool := mustPool(t)
	const mdrBps = 250
	merchantID := insertActiveMerchant(t, pool, mdrBps)
	businessDate := time.Date(2026, 4, 2, 0, 0, 0, 0, time.UTC)
	start, _ := BusinessDayWindow(businessDate)

	txnID, fee := insertCaptureEvent(t, pool, merchantID, mdrBps, 10_000, start.Add(time.Hour))
	refundID := insertRefund(t, pool, merchantID, txnID, 4_000, 100, start.Add(2*time.Hour))

	result := closeAndPay(t, pool, merchantID, businessDate)
	if result.RefundFils != 4_000 || result.RefundFeeReversedFils != 100 || result.RefundCount != 1 {
		t.Fatalf("refunds netted = %d/%d (count %d), want 4000/100 (1)", result.RefundFils, result.RefundFeeReversedFils, result.RefundCount)
	}
	wantNet := money.Fils(10_000) - fee - 4_000 + 100
	if result.NetPayoutFils != wantNet {
		t.Fatalf("NetPayoutFils = %d, want %d", result.NetPayoutFils, wantNet)
	}
	if got := queryInt(t, pool, `SELECT refund_fils FROM settlement_batches WHERE id = $1`, result.BatchID); got != 4_000 {
		t.Errorf("settlement_batches.refund_fils = %d, want 4000", got)
	}
	var claimedBy uuid.UUID
	if err := pool.QueryRow(context.Background(), `SELECT settlement_batch_id FROM refunds WHERE id = $1`, refundID).Scan(&claimedBy); err != nil {
		t.Fatalf("refund not claimed: %v", err)
	}
	if claimedBy != result.BatchID {
		t.Errorf("refund claimed by %s, want %s", claimedBy, result.BatchID)
	}
	// The merchant's payable nets to zero once the batch is paid.
	if got := queryInt(t, pool, `
		SELECT COALESCE(SUM(CASE WHEN direction = 'credit' THEN amount_fils ELSE -amount_fils END), 0)
		  FROM ledger_entries WHERE merchant_id = $1 AND account_id = 'merchant_payable'`, merchantID); got != 0 {
		t.Errorf("ledger merchant_payable after payout = %d, want 0", got)
	}

	// Re-closing the day is a no-op, and the next day does not re-claim it.
	again, err := CloseBatch(context.Background(), pool, merchantID, businessDate)
	if err != nil || !again.AlreadyClosed {
		t.Fatalf("re-close: %+v, %v", again, err)
	}
	next := closeAndPay(t, pool, merchantID, businessDate.AddDate(0, 0, 1))
	if next.RefundFils != 0 || next.NetPayoutFils != 0 {
		t.Errorf("next day netted refund %d, net %d; want 0, 0", next.RefundFils, next.NetPayoutFils)
	}
}

func TestCloseBatch_StragglerRefundIsNettedByTheNextBatch(t *testing.T) {
	pool := mustPool(t)
	const mdrBps = 250
	merchantID := insertActiveMerchant(t, pool, mdrBps)
	businessDate := time.Date(2026, 4, 10, 0, 0, 0, 0, time.UTC)
	start, _ := BusinessDayWindow(businessDate)

	// A refund timestamped on an earlier day that no batch claimed (it was
	// still in flight when that day closed).
	oldTxn, _ := insertCaptureEvent(t, pool, merchantID, mdrBps, 5_000, start.Add(-72*time.Hour))
	if _, err := pool.Exec(context.Background(), `UPDATE transaction_events SET settlement_batch_id = NULL WHERE transaction_id = $1`, oldTxn); err != nil {
		t.Fatal(err)
	}
	insertRefund(t, pool, merchantID, oldTxn, 1_000, 25, start.Add(-time.Minute))
	insertCaptureEvent(t, pool, merchantID, mdrBps, 8_000, start.Add(time.Hour))

	result := closeAndPay(t, pool, merchantID, businessDate)
	if result.RefundFils != 1_000 || result.RefundFeeReversedFils != 25 {
		t.Fatalf("straggler not netted: refund %d, reversed %d", result.RefundFils, result.RefundFeeReversedFils)
	}
}

func TestCloseBatch_NegativeDayCarriesIntoNextBatch(t *testing.T) {
	pool := mustPool(t)
	ctx := context.Background()
	const mdrBps = 250
	merchantID := insertActiveMerchant(t, pool, mdrBps)
	day0 := time.Date(2026, 5, 4, 0, 0, 0, 0, time.UTC)
	day1, day2, day3 := day0.AddDate(0, 0, 1), day0.AddDate(0, 0, 2), day0.AddDate(0, 0, 3)
	start0, _ := BusinessDayWindow(day0)
	start1, _ := BusinessDayWindow(day1)
	start2, _ := BusinessDayWindow(day2)

	// Day 0: a 10.000 BD sale, settled and paid out.
	bigTxn, _ := insertCaptureEvent(t, pool, merchantID, mdrBps, 10_000, start0.Add(time.Hour))
	b0 := closeAndPay(t, pool, merchantID, day0)
	if b0.NetPayoutFils != 9_750 {
		t.Fatalf("day0 net = %d, want 9750", b0.NetPayoutFils)
	}

	// Day 1: small sale, large refund of day 0's sale -> negative day.
	insertCaptureEvent(t, pool, merchantID, mdrBps, 1_000, start1.Add(time.Hour))
	insertRefund(t, pool, merchantID, bigTxn, 8_000, 200, start1.Add(2*time.Hour))
	b1 := closeAndPay(t, pool, merchantID, day1)
	if b1.NetPayoutFils != 1_000-25-8_000+200 {
		t.Fatalf("day1 net = %d, want -6825", b1.NetPayoutFils)
	}
	if n := queryInt(t, pool, `SELECT count(*) FROM ledger_entries WHERE settlement_batch_id = $1`, b1.BatchID); n != 0 {
		t.Errorf("a negative batch posted %d payout legs, want 0", n)
	}
	if got := queryInt(t, pool, `SELECT cached_payable_fils FROM merchant_balances WHERE merchant_id = $1`, merchantID); got != -6_825 {
		t.Errorf("cache after negative day = %d, want -6825 (owed by the merchant)", got)
	}

	// Day 2: the deficit is recovered from the next payout, exactly once.
	insertCaptureEvent(t, pool, merchantID, mdrBps, 20_000, start2.Add(time.Hour))
	b2 := closeAndPay(t, pool, merchantID, day2)
	if b2.CarriedInFils != -6_825 || b2.NetPayoutFils != 19_500-6_825 {
		t.Fatalf("day2 carried %d net %d, want -6825 and 12675", b2.CarriedInFils, b2.NetPayoutFils)
	}
	var carriedTo uuid.UUID
	if err := pool.QueryRow(ctx, `SELECT carried_to_batch_id FROM settlement_batches WHERE id = $1`, b1.BatchID).Scan(&carriedTo); err != nil || carriedTo != b2.BatchID {
		t.Fatalf("day1 carried_to_batch_id = %s (%v), want %s", carriedTo, err, b2.BatchID)
	}
	if got := queryInt(t, pool, `SELECT amount_fils FROM ledger_entries WHERE settlement_batch_id = $1 AND direction = 'debit'`, b2.BatchID); got != 12_675 {
		t.Errorf("day2 payout leg = %d, want 12675", got)
	}

	b3 := closeAndPay(t, pool, merchantID, day3)
	if b3.CarriedInFils != 0 {
		t.Errorf("deficit carried twice: day3 carried_in = %d", b3.CarriedInFils)
	}

	// Ledger, cache and payouts agree to the fil.
	if got := queryInt(t, pool, `
		SELECT COALESCE(SUM(CASE WHEN direction = 'credit' THEN amount_fils ELSE -amount_fils END), 0)
		  FROM ledger_entries WHERE merchant_id = $1 AND account_id = 'merchant_payable'`, merchantID); got != 0 {
		t.Errorf("ledger merchant_payable = %d, want 0", got)
	}
	if got := queryInt(t, pool, `SELECT cached_payable_fils FROM merchant_balances WHERE merchant_id = $1`, merchantID); got != 0 {
		t.Errorf("cached_payable_fils = %d, want 0", got)
	}
	paid := queryInt(t, pool, `SELECT COALESCE(SUM(amount_fils), 0) FROM ledger_entries
		WHERE merchant_id = $1 AND description = 'settlement payout: batch paid' AND direction = 'debit'`, merchantID)
	if paid != 9_750+12_675 {
		t.Errorf("total paid out = %d, want %d", paid, 9_750+12_675)
	}
}

func TestRecalculateMDR_KeepsRefundsInTheNet(t *testing.T) {
	pool := mustPool(t)
	const mdrBps = 250
	merchantID := insertActiveMerchant(t, pool, mdrBps)
	businessDate := time.Date(2026, 6, 8, 0, 0, 0, 0, time.UTC)
	start, _ := BusinessDayWindow(businessDate)

	txnID, _ := insertCaptureEvent(t, pool, merchantID, mdrBps, 10_000, start.Add(time.Hour))
	insertRefund(t, pool, merchantID, txnID, 4_000, 100, start.Add(2*time.Hour))
	b := closeAndPay(t, pool, merchantID, businessDate)

	if _, err := pool.Exec(context.Background(), `UPDATE merchants SET mdr_bps = 300 WHERE id = $1`, merchantID); err != nil {
		t.Fatal(err)
	}
	if _, err := RecalculateMDR(context.Background(), pool, merchantID, businessDate, businessDate.AddDate(0, 0, 1)); err != nil {
		t.Fatalf("RecalculateMDR: %v", err)
	}
	if got := queryInt(t, pool, `SELECT net_payout_fils FROM settlement_batches WHERE id = $1`, b.BatchID); got != 10_000-300-4_000+100 {
		t.Errorf("net after recalculation = %d, want 5800 (refund still netted)", got)
	}
}

func TestNetPayableFils_ExactForLargeBatches(t *testing.T) {
	// 123,456.789 BD less 2.345 BD: float32 BD arithmetic cannot represent
	// this to the fil.
	if got := NetPayableFils(123_456_789, 2_345); got != 123_454_444 {
		t.Fatalf("NetPayableFils = %d, want 123454444", got)
	}
}
