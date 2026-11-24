/**
 * Rounding policy for displayed financial totals (#1100).
 *
 * Internal values stay exact; only the *displayed* strings are rounded:
 *
 *  - Valuation amounts are rounded to the valuation currency's precision
 *    (CURRENCY_PRECISION) with banker's rounding (half_even), which avoids a
 *    systematic upward bias when many halfway values are summed.
 *  - Asset quantities are shown at Stellar's 7-decimal precision, half_even.
 *  - The displayed total is the exact sum of exact row values, rounded once.
 *  - Displayed rows always add up to the displayed total: if independently
 *    rounded rows differ from it, the difference (in whole minimal units) is
 *    allocated to the rows with the largest rounding error (largest remainder
 *    method), and those rows are reported in `adjustedRowIds`.
 *  - Unpriced rows (null) are shown as null and excluded from the total.
 */
import {
  add,
  numberToDecimal,
  parseDecimal,
  roundToScale,
  subtract,
  toDecimalString,
  type FixedDecimal,
  type RoundingMode,
} from "./fixedDecimal";

export const DISPLAY_ROUNDING_MODE: RoundingMode = "half_even";

/** Displayed fractional digits per valuation currency. */
export const CURRENCY_PRECISION: Readonly<Record<string, number>> = {
  USD: 2,
  EUR: 2,
  GBP: 2,
  NGN: 2,
  USDC: 2,
  JPY: 0,
  XLM: 7,
  BTC: 8,
  ETH: 8,
};
export const DEFAULT_CURRENCY_PRECISION = 2;
/** Stellar amounts have 7 decimal places. */
export const ASSET_QUANTITY_PRECISION = 7;

export function currencyPrecision(currency: string): number {
  return CURRENCY_PRECISION[currency.toUpperCase()] ?? DEFAULT_CURRENCY_PRECISION;
}

export interface RoundingPolicy {
  currency: string;
  precision: number;
  mode: RoundingMode;
}

export function roundingPolicyFor(currency: string): RoundingPolicy {
  return { currency: currency.toUpperCase(), precision: currencyPrecision(currency), mode: DISPLAY_ROUNDING_MODE };
}

export interface DisplayRowInput {
  id: string;
  /** Exact value as decimal string or number; null when unpriced. */
  value: string | number | null;
}

export interface DisplayRow {
  id: string;
  exact: string | null;
  displayed: string | null;
}

export interface DisplayedTotals {
  policy: RoundingPolicy;
  rows: DisplayRow[];
  total: { exact: string; displayed: string } | null;
  /** Rows nudged by one minimal unit so rows add up to the displayed total. */
  adjustedRowIds: string[];
}

function toDecimal(value: string | number): FixedDecimal {
  const parsed = typeof value === "number" ? numberToDecimal(value) : parseDecimal(value);
  if (!parsed) throw new Error(`Invalid amount for display: ${String(value)}`);
  return parsed;
}

/** Round one quantity of an asset for display (7 dp, half_even). */
export function displayAssetQuantity(value: string | number): string {
  return toDecimalString(roundToScale(toDecimal(value), ASSET_QUANTITY_PRECISION, DISPLAY_ROUNDING_MODE));
}

/** Round one currency amount for display. */
export function displayCurrencyAmount(value: string | number, currency: string): string {
  const policy = roundingPolicyFor(currency);
  return toDecimalString(roundToScale(toDecimal(value), policy.precision, policy.mode));
}

export function buildDisplayedTotals(rows: DisplayRowInput[], currency: string): DisplayedTotals {
  const policy = roundingPolicyFor(currency);
  const priced = rows
    .map((row, index) => ({ row, index, exact: row.value === null ? null : toDecimal(row.value) }))
    .filter((r): r is { row: DisplayRowInput; index: number; exact: FixedDecimal } => r.exact !== null);

  if (priced.length === 0) {
    return {
      policy,
      rows: rows.map((r) => ({ id: r.id, exact: null, displayed: null })),
      total: null,
      adjustedRowIds: [],
    };
  }

  const exactTotal = priced.reduce<FixedDecimal>((sum, r) => add(sum, r.exact), { units: 0n, scale: 0 });
  const displayedTotal = roundToScale(exactTotal, policy.precision, policy.mode);

  const rounded = priced.map((r) => {
    const value = roundToScale(r.exact, policy.precision, policy.mode);
    // Rounding error in a common scale: exact - rounded (positive → rounded down).
    const error = subtract(r.exact, value);
    return { ...r, value, error };
  });

  const rowSum = rounded.reduce<FixedDecimal>((sum, r) => add(sum, r.value), { units: 0n, scale: policy.precision });
  let diffUnits = displayedTotal.units - rowSum.units; // in minimal display units
  const adjusted = new Set<string>();

  if (diffUnits !== 0n) {
    const step = diffUnits > 0n ? 1n : -1n;
    const scale = Math.max(...rounded.map((r) => r.error.scale));
    const errorUnits = (r: (typeof rounded)[number]) =>
      r.error.units * 10n ** BigInt(scale - r.error.scale);
    // Rows rounded furthest in the opposite direction absorb the difference first;
    // ties keep input order for stability.
    const order = [...rounded].sort((a, b) => {
      const ea = errorUnits(a) * step;
      const eb = errorUnits(b) * step;
      return ea === eb ? a.index - b.index : eb > ea ? 1 : -1;
    });
    for (let i = 0; diffUnits !== 0n; i = (i + 1) % order.length) {
      order[i].value = { units: order[i].value.units + step, scale: policy.precision };
      adjusted.add(order[i].row.id);
      diffUnits -= step;
    }
  }

  const byIndex = new Map(rounded.map((r) => [r.index, r]));
  return {
    policy,
    rows: rows.map((row, index) => {
      const r = byIndex.get(index);
      return r
        ? { id: row.id, exact: toDecimalString(r.exact), displayed: toDecimalString(r.value) }
        : { id: row.id, exact: null, displayed: null };
    }),
    total: { exact: toDecimalString(exactTotal), displayed: toDecimalString(displayedTotal) },
    adjustedRowIds: [...adjusted],
  };
}
