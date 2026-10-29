-- Additional suspense accounts for future reconciliation lanes.
-- chart_of_accounts (0007) is (id, name, kind); suspense accounts use kind
-- 'asset', like scheme_rounding_residue in 0007.
--   fx_rounding_difference: rounding differences between fils and scheme-file BD amounts.
--   chargeback_suspense:    chargeback amounts pending acquirer confirmation.

INSERT INTO chart_of_accounts (id, name, kind)
VALUES
  ('fx_rounding_difference', 'FX Rounding Difference', 'asset'),
  ('chargeback_suspense', 'Chargeback Suspense', 'asset')
ON CONFLICT (id) DO NOTHING;
