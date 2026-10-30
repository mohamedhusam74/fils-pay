package settlement

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/filspay/settlement/internal/money"
)

// TestSchemeExportAmountIsTruncatedAmountFils pins ADR-0002: the scheme
// file amount is exactly amount_fils / 1000 at two decimals, where
// amount_fils is the gross truncated to 10 fils. It must never round up,
// or the scheme is asked for more than was captured.
func TestSchemeExportAmountIsTruncatedAmountFils(t *testing.T) {
	pool := mustPool(t)
	const mdrBps = 250
	merchantID := insertActiveMerchant(t, pool, mdrBps)
	businessDate := time.Date(2026, 3, 25, 0, 0, 0, 0, time.UTC)
	start, _ := BusinessDayWindow(businessDate)

	cases := []struct {
		grossFils money.Fils
		want      string
	}{
		{4758, "4.75"},
		{4755, "4.75"},
		{4751, "4.75"},
		{4747, "4.74"},
	}
	txnIDs := make([]uuid.UUID, len(cases))
	for i, c := range cases {
		txnIDs[i], _ = insertCaptureEvent(t, pool, merchantID, mdrBps, c.grossFils, start.Add(time.Duration(i+1)*time.Hour))
	}

	result, err := CloseBatch(context.Background(), pool, merchantID, businessDate)
	if err != nil {
		t.Fatalf("CloseBatch: %v", err)
	}

	// Lines are sequenced by transaction id, so look each one up by id. The
	// stored amount column is what LoadSchemeExportLines emits.
	for i, c := range cases {
		var amount string
		err := pool.QueryRow(context.Background(), `
			SELECT amount::text FROM scheme_export_lines
			 WHERE settlement_batch_id = $1 AND transaction_id = $2
		`, result.BatchID, txnIDs[i]).Scan(&amount)
		if err != nil {
			t.Fatalf("gross %d fils: query scheme_export_lines: %v", c.grossFils, err)
		}
		if amount != c.want {
			t.Errorf("gross %d fils: scheme amount = %q, want %q (truncated, never rounded up)", c.grossFils, amount, c.want)
		}
	}
}
