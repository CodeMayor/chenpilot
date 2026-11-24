import { parseDecimal, roundToScale, toDecimalString } from "../fixedDecimal";
import {
  buildDisplayedTotals,
  currencyPrecision,
  displayAssetQuantity,
  displayCurrencyAmount,
  roundingPolicyFor,
} from "../roundingPolicy";

const round = (v: string, scale: number, mode: "half_even" | "half_up" | "down") =>
  toDecimalString(roundToScale(parseDecimal(v)!, scale, mode));

const sumDisplayed = (rows: Array<{ displayed: string | null }>, scale: number) =>
  toDecimalString(
    rows
      .filter((r) => r.displayed !== null)
      .map((r) => roundToScale(parseDecimal(r.displayed)!, scale, "down"))
      .reduce((a, b) => ({ units: a.units + b.units, scale }), { units: 0n, scale })
  );

describe("rounding policy (#1100)", () => {
  it("defines precision per valuation currency with banker's rounding", () => {
    expect(roundingPolicyFor("usd")).toEqual({ currency: "USD", precision: 2, mode: "half_even" });
    expect(currencyPrecision("JPY")).toBe(0);
    expect(currencyPrecision("XLM")).toBe(7);
    expect(currencyPrecision("BTC")).toBe(8);
    expect(currencyPrecision("ZZZ")).toBe(2); // documented default
  });

  describe("halfway values", () => {
    it.each([
      ["0.125", "0.12"],
      ["0.135", "0.14"],
      ["2.5", "2.50"],
      ["0.005", "0.00"],
      ["0.015", "0.02"],
      ["-0.125", "-0.12"],
      ["-0.135", "-0.14"],
    ])("half_even rounds %s to %s", (input, expected) => {
      expect(displayCurrencyAmount(input, "USD")).toBe(expected);
    });

    it("rounds to whole units for JPY", () => {
      expect(displayCurrencyAmount("2.5", "JPY")).toBe("2");
      expect(displayCurrencyAmount("3.5", "JPY")).toBe("4");
    });

    it("supports half_up and down for comparison", () => {
      expect(round("0.125", 2, "half_up")).toBe("0.13");
      expect(round("-0.125", 2, "half_up")).toBe("-0.13");
      expect(round("0.129", 2, "down")).toBe("0.12");
      expect(round("-0.129", 2, "down")).toBe("-0.12");
    });

    it("shows asset quantities at 7 decimals", () => {
      expect(displayAssetQuantity("1.00000005")).toBe("1.0000000");
      expect(displayAssetQuantity("1.00000015")).toBe("1.0000002");
      expect(displayAssetQuantity(0.1 + 0.2)).toBe("0.3000000");
    });
  });

  describe("consistency between rows and total", () => {
    it("adjusts rows so they add up to the total rounded from the exact sum", () => {
      const result = buildDisplayedTotals(
        [
          { id: "A", value: "0.335" },
          { id: "B", value: "0.335" },
          { id: "C", value: "0.335" },
        ],
        "USD"
      );
      // exact 1.005 → 1.00 (half_even); naive rows 0.34 ×3 = 1.02
      expect(result.total).toEqual({ exact: "1.005", displayed: "1.00" });
      expect(sumDisplayed(result.rows, 2)).toBe("1.00");
      expect(result.adjustedRowIds).toHaveLength(2);
      expect(result.rows.map((r) => r.displayed)).toEqual(["0.33", "0.33", "0.34"]);
    });

    it("adds to the row rounded down the most when the total is higher", () => {
      const result = buildDisplayedTotals(
        [
          { id: "A", value: "0.004" },
          { id: "B", value: "0.004" },
          { id: "C", value: "0.003" },
        ],
        "USD"
      );
      expect(result.total?.displayed).toBe("0.01");
      expect(result.rows.map((r) => r.displayed)).toEqual(["0.01", "0.00", "0.00"]);
      expect(result.adjustedRowIds).toEqual(["A"]);
    });

    it("handles negative adjustments", () => {
      const result = buildDisplayedTotals(
        [
          { id: "holding", value: "100.005" },
          { id: "fee-adjustment", value: "-0.335" },
          { id: "refund", value: "-0.335" },
        ],
        "USD"
      );
      expect(result.total).toEqual({ exact: "99.335", displayed: "99.34" });
      expect(sumDisplayed(result.rows, 2)).toBe("99.34");
    });

    it("keeps rows untouched when they already add up", () => {
      const result = buildDisplayedTotals(
        [
          { id: "A", value: "10.10" },
          { id: "B", value: 5.25 },
        ],
        "USD"
      );
      expect(result.rows.map((r) => r.displayed)).toEqual(["10.10", "5.25"]);
      expect(result.total?.displayed).toBe("15.35");
      expect(result.adjustedRowIds).toEqual([]);
    });

    it("excludes unpriced rows and returns a null total when nothing is priced", () => {
      const partial = buildDisplayedTotals(
        [
          { id: "A", value: "1.234" },
          { id: "B", value: null },
        ],
        "USD"
      );
      expect(partial.rows[1]).toEqual({ id: "B", exact: null, displayed: null });
      expect(partial.total?.displayed).toBe("1.23");

      expect(buildDisplayedTotals([{ id: "A", value: null }], "USD").total).toBeNull();
    });

    it("rows always sum to the total across many random inputs", () => {
      let seed = 1100;
      const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
      for (let i = 0; i < 200; i++) {
        const rows = Array.from({ length: 1 + Math.floor(rand() * 8) }, (_, j) => ({
          id: `r${j}`,
          value: ((rand() - 0.3) * 1000).toFixed(5),
        }));
        const result = buildDisplayedTotals(rows, "USD");
        expect(sumDisplayed(result.rows, 2)).toBe(result.total?.displayed);
      }
    });

    it("rejects malformed amounts instead of displaying them", () => {
      expect(() => buildDisplayedTotals([{ id: "A", value: "1,000.00" }], "USD")).toThrow(/Invalid amount/);
      expect(() => displayCurrencyAmount(Number.NaN, "USD")).toThrow(/Invalid amount/);
    });
  });
});
