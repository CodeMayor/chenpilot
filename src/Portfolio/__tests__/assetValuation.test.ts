import { valueHolding, valueHoldings, type PriceQuoteOutcome } from "../assetValuation";
import { buildPortfolioReconciliationView } from "../portfolioReconciliation";
import type { ReconciliationReport } from "../../services/reconciliation.service";

const NOW = "2026-11-23T12:00:00.000Z";

const report = (): ReconciliationReport =>
  ({
    id: "report-1",
    userId: "user-42",
    scope: {},
    startedAt: NOW,
    completedAt: NOW,
    driftItems: [],
    summary: { total: 0, critical: 0, major: 0, minor: 0, none: 0 },
    status: "clean",
  }) as unknown as ReconciliationReport;

describe("valueHolding (#1101)", () => {
  it("prices a supported asset exactly", () => {
    const v = valueHolding(
      { assetCode: "XLM", balance: "100.5" },
      { kind: "quote", price: "0.1234", quotedAt: NOW },
      "USD"
    );
    expect(v).toMatchObject({ status: "priced", price: "0.1234", value: "12.40170", quotedAt: NOW });
  });

  it("reports a provider outage as quote_unavailable, not zero", () => {
    const v = valueHolding({ assetCode: "USDC", balance: "50" }, { kind: "unavailable", error: "HTTP 503" }, "USD");
    expect(v.status).toBe("quote_unavailable");
    expect(v.value).toBeNull();
    expect(v.reason).toContain("HTTP 503");
    expect(v.reason).toMatch(/temporarily unknown/);
  });

  it("reports an unpriceable token as unsupported_asset", () => {
    const v = valueHolding({ assetCode: "MEMECOIN", balance: "1000" }, { kind: "unsupported" }, "USD");
    expect(v).toMatchObject({ status: "unsupported_asset", value: null, price: null });
    expect(v.reason).toMatch(/unknown, not zero/);
  });

  it.each<[string, unknown]>([
    ["non-numeric string", "abc"],
    ["negative", "-1.5"],
    ["zero", "0"],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["exponent form", 1e-9],
    ["object", { usd: 1 }],
    ["null", null],
  ])("reports a malformed price (%s) as malformed_price", (_label, price) => {
    const v = valueHolding({ assetCode: "XLM", balance: "10" }, { kind: "quote", price }, "USD");
    expect(v.status).toBe("malformed_price");
    expect(v.value).toBeNull();
  });

  it("distinguishes a zero balance from a missing quote (boundary)", () => {
    const outage: PriceQuoteOutcome = { kind: "unavailable", error: "timeout" };
    expect(valueHolding({ assetCode: "XLM", balance: "0.0000000" }, outage, "USD")).toMatchObject({
      status: "zero_balance",
      value: "0",
    });
    expect(valueHolding({ assetCode: "XLM", balance: "0.0000001" }, outage, "USD").status).toBe(
      "quote_unavailable"
    );
  });

  it("rejects a malformed balance instead of guessing", () => {
    expect(() => valueHolding({ assetCode: "XLM", balance: "1,000" }, { kind: "quote", price: "1" }, "USD")).toThrow(
      /Malformed balance/
    );
  });
});

describe("valuation in reconciliation output (#1101)", () => {
  it("turns a thrown provider error into quote_unavailable for that asset only", async () => {
    const getQuote = jest.fn(async (asset: string): Promise<PriceQuoteOutcome> => {
      if (asset === "USDC") throw new Error("ECONNREFUSED");
      if (asset === "MEME") return { kind: "unsupported" };
      return { kind: "quote", price: "0.10" };
    });

    const assets = await valueHoldings(
      [
        { assetCode: "XLM", balance: "200" },
        { assetCode: "USDC", balance: "5" },
        { assetCode: "MEME", balance: "9" },
        { assetCode: "AQUA", balance: "0" },
      ],
      getQuote,
      "USD"
    );
    const view = buildPortfolioReconciliationView(report(), { currency: "USD", assets });

    expect(view.valuation?.assets.map((a) => [a.assetCode, a.status])).toEqual([
      ["XLM", "priced"],
      ["USDC", "quote_unavailable"],
      ["MEME", "unsupported_asset"],
      ["AQUA", "zero_balance"],
    ]);
    expect(view.valuation).toMatchObject({
      currency: "USD",
      valuedTotal: "20.00",
      complete: false,
      byStatus: { priced: 1, zero_balance: 1, unsupported_asset: 1, quote_unavailable: 1, malformed_price: 0 },
    });
  });

  it("is complete when every asset is priced or zero", () => {
    const assets = [
      valueHolding({ assetCode: "XLM", balance: "1" }, { kind: "quote", price: "0.5" }, "USD"),
      valueHolding({ assetCode: "USDC", balance: "0" }, { kind: "unsupported" }, "USD"),
    ];
    const view = buildPortfolioReconciliationView(report(), { currency: "USD", assets });
    expect(view.valuation).toMatchObject({ complete: true, valuedTotal: "0.5" });
  });

  it("omits the valuation section when no valuations are supplied", () => {
    expect(buildPortfolioReconciliationView(report())).not.toHaveProperty("valuation");
  });
});
