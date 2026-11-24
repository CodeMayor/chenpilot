/**
 * Structured valuation status for reconciliation output (#1101).
 *
 * Lets users tell apart a zero balance, an asset we cannot price at all, a
 * temporarily unavailable quote, and a quote we received but could not trust.
 * A missing value is never reported as 0 unless the balance itself is 0.
 */
import { isPositive, isZero, multiply, parseDecimal, toDecimalString } from "./fixedDecimal";

export type ValuationStatus =
  | "priced"
  | "zero_balance"
  | "unsupported_asset"
  | "quote_unavailable"
  | "malformed_price";

export interface AssetValuation {
  assetCode: string;
  /** Balance as reported (exact decimal string). */
  balance: string;
  status: ValuationStatus;
  /** Human-readable reason for the status. */
  reason: string;
  /** Valuation currency, e.g. "USD". */
  currency: string;
  /** Unit price used, or null when not priced. */
  price: string | null;
  /** balance × price (exact), "0" for zero balances, null when unknown. */
  value: string | null;
  quotedAt: string | null;
}

/** What a price provider returned for an asset. */
export type PriceQuoteOutcome =
  | { kind: "quote"; price: unknown; quotedAt?: string }
  | { kind: "unsupported"; detail?: string }
  | { kind: "unavailable"; error: string };

export interface Holding {
  assetCode: string;
  balance: string;
}

export function valueHolding(
  holding: Holding,
  quote: PriceQuoteOutcome,
  currency: string
): AssetValuation {
  const base = { assetCode: holding.assetCode, balance: holding.balance, currency, price: null, value: null, quotedAt: null };
  const balance = parseDecimal(holding.balance);

  if (!balance) {
    // Not a valuation problem we can explain to the user as a price issue.
    throw new Error(`Malformed balance for ${holding.assetCode}: ${holding.balance}`);
  }

  if (isZero(balance)) {
    return {
      ...base,
      status: "zero_balance",
      reason: "Balance is zero, so its value is zero regardless of price.",
      value: "0",
    };
  }

  switch (quote.kind) {
    case "unsupported":
      return {
        ...base,
        status: "unsupported_asset",
        reason:
          `No price source supports ${holding.assetCode} in ${currency}` +
          (quote.detail ? ` (${quote.detail})` : "") +
          ". It is excluded from the total; its value is unknown, not zero.",
      };
    case "unavailable":
      return {
        ...base,
        status: "quote_unavailable",
        reason:
          `Price provider could not return a quote for ${holding.assetCode}: ${quote.error}. ` +
          "The value is temporarily unknown and excluded from the total.",
      };
    case "quote": {
      const price = parseDecimal(quote.price);
      if (!price || !isPositive(price)) {
        return {
          ...base,
          status: "malformed_price",
          reason:
            `Price provider returned an invalid price for ${holding.assetCode} ` +
            `(${JSON.stringify(quote.price)}). The value is excluded from the total.`,
          quotedAt: quote.quotedAt ?? null,
        };
      }
      return {
        ...base,
        status: "priced",
        reason: `Priced at ${toDecimalString(price)} ${currency}.`,
        price: toDecimalString(price),
        value: toDecimalString(multiply(balance, price)),
        quotedAt: quote.quotedAt ?? null,
      };
    }
  }
}

/**
 * Value all holdings with a quote function. A thrown provider error (outage,
 * timeout) becomes `quote_unavailable` for that asset instead of failing the
 * whole reconciliation.
 */
export async function valueHoldings(
  holdings: Holding[],
  getQuote: (assetCode: string, currency: string) => Promise<PriceQuoteOutcome>,
  currency: string
): Promise<AssetValuation[]> {
  return Promise.all(
    holdings.map(async (holding) => {
      let quote: PriceQuoteOutcome;
      try {
        quote = await getQuote(holding.assetCode, currency);
      } catch (error) {
        quote = { kind: "unavailable", error: error instanceof Error ? error.message : String(error) };
      }
      return valueHolding(holding, quote, currency);
    })
  );
}
