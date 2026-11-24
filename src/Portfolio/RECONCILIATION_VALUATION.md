# Valuation Status in Reconciliation Output (#1101)

`buildPortfolioReconciliationView(report, { currency, assets })` adds a
`valuation` section when you supply valuations from `valueHoldings()` in
`src/Portfolio/assetValuation.ts`.

## Per-asset `status` and `reason`

| `status` | When | `value` |
|---|---|---|
| `priced` | Valid positive price received | `balance × price`, exact |
| `zero_balance` | Balance is exactly zero, whatever the quote | `"0"` |
| `unsupported_asset` | No price source supports the asset in this currency | `null` (unknown, not zero) |
| `quote_unavailable` | The provider failed: outage, timeout or a thrown error | `null` (temporarily unknown) |
| `malformed_price` | The provider returned a non-numeric, non-positive, non-finite or exponent-form price | `null` |

Each asset also carries:
- `reason`, a human-readable explanation of the status;
- `price` and `quotedAt`;
- `balance` and `currency`.

A malformed balance is not a pricing problem and raises an error.

## Summary fields

- `valuedTotal` is the exact sum of `priced` and `zero_balance` values only.
- `complete` is `false` if any asset's value is unknown. The total then
  understates the holdings and should be shown as partial.
- `byStatus` counts assets per status.

A provider error for one asset never fails the whole reconciliation. Only
that asset is marked `quote_unavailable`.

Tests: `src/Portfolio/__tests__/assetValuation.test.ts`.
