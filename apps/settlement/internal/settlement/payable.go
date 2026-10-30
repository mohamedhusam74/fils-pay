package settlement

import (
	"github.com/filspay/settlement/internal/money"
)

// NetPayableFils derives the net payout from frozen gross and fee totals, in
// integer fils. It used to go through float32 BD, which carries about seven
// significant digits and so lost fils on any batch above ~10,000 BD.
func NetPayableFils(grossFils, feeFils money.Fils) money.Fils {
	return grossFils - feeFils
}
