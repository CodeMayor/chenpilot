# Rounding Policy for Displayed Financial Totals (#1100)

Values are computed exactly (BigInt decimals in `src/Portfolio/fixedDecimal.ts`).
Rounding happens only when producing **display** strings
(`src/Portfolio/roundingPolicy.ts`).

## Precision and mode

| Displayed amount | Precision | Mode |
|---|---|---|
| Value in USD, EUR, GBP, NGN, USDC | 2 dp | half_even |
| Value in JPY | 0 dp | half_even |
| Value in XLM | 7 dp | half_even |
| Value in BTC, ETH | 8 dp | half_even |
| Value in any other currency | 2 dp (default) | half_even |
| Asset quantity (any asset) | 7 dp (Stellar precision) | half_even |

**half_even** (banker's rounding) sends exact ties to the even neighbour, so
`0.125 → 0.12` and `0.135 → 0.14`. This avoids the upward drift that half-up
rounding causes when many halfway values are summed. Negative values round
symmetrically by magnitude: `-0.125 → -0.12`.

## Rows and totals

1. The **total** is rounded once from the exact sum of the exact row values.
2. Each **row** is rounded on its own.
3. If the rounded rows don't add up to the displayed total, the difference is
   spread one minimal unit (e.g. 0.01 USD) at a time. It goes first to the rows
   with the largest rounding error in the opposite direction (largest remainder
   method), and ties keep row order. Adjusted rows are listed in
   `adjustedRowIds` (`display.adjustedAssets` in the portfolio API).
4. Unpriced rows display `null` and are excluded from the total. If nothing is
   priced, the total is `null`, not `0`.
5. A malformed amount raises an error instead of being displayed.

## API

`PortfolioService.getPortfolio()` now also returns `display`, a new field that
leaves the existing fields unchanged:

```json
{
  "policy": { "currency": "USD", "precision": 2, "mode": "half_even", "assetQuantityPrecision": 7 },
  "assets": [{ "code": "XLM", "issuer": "", "amount": "100.5000000", "valueInCurrency": "12.40" }],
  "totalValue": "12.40",
  "adjustedAssets": []
}
```

The numeric `totalValue` and `valueInCurrency` fields stay unrounded for
calculations. UIs should render `display`.

Tests: `src/Portfolio/__tests__/roundingPolicy.test.ts`.
