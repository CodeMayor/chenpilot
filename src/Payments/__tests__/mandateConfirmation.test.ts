import { RecurringPaymentMandateService } from "../recurringMandate.service";
import { MandateConfirmationError, buildConfirmationSummary, describeInterval } from "../mandateConfirmation";
import type { PaymentExecutor } from "../paymentTypes";

const NOW = new Date("2026-11-23T09:00:00Z");
const DAY = 24 * 60 * 60 * 1000;
const clock = { now: () => NOW };

function setup(overrides: Record<string, unknown> = {}) {
  const executor = { executePayment: jest.fn(async () => ({ status: "success", transactionHash: "tx" })) };
  const svc = new RecurringPaymentMandateService(executor as unknown as PaymentExecutor, clock as never);
  svc.createMandate({
    id: "m-1",
    requirement: {
      network: "stellar:testnet",
      asset: { code: "USDC", issuer: "GISSUER" },
      amount: "25.50",
      recipient: "GRECIPIENT",
    },
    intervalMs: 7 * DAY,
    nextRunAt: new Date("2026-11-30T09:00:00Z"),
    cumulativeLimit: "500",
    approvalRequired: true,
    approved: false,
    missedRunBehavior: "skip",
    ...overrides,
  } as never);
  return { svc, executor };
}

describe("recurring payment confirmation summary (#1102)", () => {
  it("shows recipient, amount, cadence, next run and cancellation policy", () => {
    const { svc } = setup();
    const summary = svc.getConfirmationSummary("m-1");

    expect(summary).toMatchObject({
      mandateId: "m-1",
      recipient: "GRECIPIENT",
      network: "stellar:testnet",
      asset: { code: "USDC", issuer: "GISSUER" },
      amount: "25.50",
      cadence: { intervalMs: 7 * DAY, description: "every week" },
      nextRunAt: "2026-11-30T09:00:00.000Z",
      cumulativeLimit: "500",
      cancellationPolicy: {
        revocableAnytime: true,
        missedRunBehavior: "skip",
        missedRunDescription: expect.stringMatching(/skipped/),
        effect: expect.stringMatching(/stops all future runs/),
      },
      missingFields: [],
    });
    expect(summary.summaryHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("activates only with the hash of the summary that was shown", async () => {
    const { svc, executor } = setup({ nextRunAt: NOW });
    const { summaryHash } = svc.getConfirmationSummary("m-1");

    expect(svc.approveMandate("m-1", summaryHash, "user-7")).toMatchObject({
      approved: true,
      confirmedBy: "user-7",
    });
    await svc.runMandateIfDue("m-1", NOW);
    expect(executor.executePayment).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["recipient", { requirement: { network: "stellar:testnet", asset: { code: "USDC", issuer: "GISSUER" }, amount: "25.50", recipient: "GATTACKER" } }],
    ["amount", { requirement: { network: "stellar:testnet", asset: { code: "USDC", issuer: "GISSUER" }, amount: "2550", recipient: "GRECIPIENT" } }],
    ["cadence", { intervalMs: DAY }],
    ["next run", { nextRunAt: new Date("2026-11-24T09:00:00Z") }],
    ["cancellation policy", { missedRunBehavior: "execute_late" }],
    ["limit", { cumulativeLimit: "5000" }],
  ])("a changed %s invalidates the prior confirmation", (_field, change) => {
    const { svc } = setup();
    const shown = svc.getConfirmationSummary("m-1");

    svc.updateMandate("m-1", change as never);

    const err = (() => {
      try {
        svc.approveMandate("m-1", shown.summaryHash);
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(MandateConfirmationError);
    expect((err as MandateConfirmationError).reason).toBe("stale_summary");
    expect(svc.getConfirmationSummary("m-1").summaryHash).not.toBe(shown.summaryHash);
  });

  it("a change after activation revokes the approval until re-confirmed", async () => {
    const { svc, executor } = setup({ nextRunAt: NOW });
    svc.approveMandate("m-1", svc.getConfirmationSummary("m-1").summaryHash);

    svc.updateMandate("m-1", { cumulativeLimit: "1000" });
    await expect(svc.runMandateIfDue("m-1", NOW)).rejects.toMatchObject({ reason: "not_confirmed" });
    expect(executor.executePayment).not.toHaveBeenCalled();

    svc.approveMandate("m-1", svc.getConfirmationSummary("m-1").summaryHash);
    await svc.runMandateIfDue("m-1", NOW);
    expect(executor.executePayment).toHaveBeenCalledTimes(1);
  });

  it("blocks activation while required fields are missing (boundary)", () => {
    const { svc } = setup({
      requirement: { network: "stellar:testnet", asset: { code: "USDC" }, amount: "0", recipient: " " },
      intervalMs: 0,
    });
    const summary = svc.getConfirmationSummary("m-1");

    expect(summary.missingFields).toEqual(["recipient", "amount", "cadence"]);
    expect(() => svc.approveMandate("m-1", summary.summaryHash)).toThrow(
      expect.objectContaining({ reason: "missing_fields", missingFields: ["recipient", "amount", "cadence"] })
    );
  });

  it("keeps the same hash for an unchanged mandate", () => {
    const { svc } = setup();
    expect(svc.getConfirmationSummary("m-1").summaryHash).toBe(svc.getConfirmationSummary("m-1").summaryHash);
  });

  it("describes cadence in plain words", () => {
    expect(describeInterval(DAY)).toBe("every day");
    expect(describeInterval(14 * DAY)).toBe("every 2 weeks");
    expect(describeInterval(90 * 60 * 1000)).toBe("every 90 minutes");
    expect(describeInterval(1500)).toBe("every 1500 ms");
  });

  it("does not depend on object identity", () => {
    const { svc } = setup();
    const m = svc.getMandate("m-1")!;
    expect(buildConfirmationSummary({ ...m }).summaryHash).toBe(svc.getConfirmationSummary("m-1").summaryHash);
  });
});
