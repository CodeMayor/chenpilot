/**
 * Confirmation summaries for recurring payment changes (#1102).
 *
 * Before a recurring payment is activated (or re-activated after a change),
 * the user is shown a summary of recipient, amount, cadence, next run and
 * cancellation policy. The confirmation is bound to a hash of exactly what was
 * shown; any changed or missing field produces a different summary and
 * invalidates the earlier confirmation.
 */
import crypto from "crypto";
import { parseAmount } from "./money";
import type { MissedRunBehavior, PaymentMandate } from "./recurringMandate.service";

export interface MandateConfirmationSummary {
  mandateId: string;
  recipient: string;
  network: string;
  asset: { code: string; issuer: string | null };
  amount: string;
  cadence: { intervalMs: number; description: string };
  nextRunAt: string;
  cumulativeLimit: string;
  cancellationPolicy: {
    revocableAnytime: true;
    effect: string;
    missedRunBehavior: MissedRunBehavior;
    missedRunDescription: string;
  };
  /** Required fields that are missing or invalid; activation is blocked while non-empty. */
  missingFields: string[];
  /** Hash of everything above; pass it back to confirm. */
  summaryHash: string;
  /** Hash of the payment terms only (excludes nextRunAt, which advances after each run). */
  termsHash: string;
}

export class MandateConfirmationError extends Error {
  constructor(
    message: string,
    public readonly reason: "stale_summary" | "missing_fields" | "not_confirmed",
    public readonly missingFields: string[] = []
  ) {
    super(message);
    this.name = "MandateConfirmationError";
  }
}

const UNITS: Array<[number, string]> = [
  [7 * 24 * 60 * 60 * 1000, "week"],
  [24 * 60 * 60 * 1000, "day"],
  [60 * 60 * 1000, "hour"],
  [60 * 1000, "minute"],
];

export function describeInterval(intervalMs: number): string {
  for (const [size, unit] of UNITS) {
    if (intervalMs >= size && intervalMs % size === 0) {
      const n = intervalMs / size;
      return n === 1 ? `every ${unit}` : `every ${n} ${unit}s`;
    }
  }
  return `every ${intervalMs} ms`;
}

function validAmount(value: unknown): boolean {
  if (typeof value !== "string") return false;
  try {
    return parseAmount(value) > 0n;
  } catch {
    return false;
  }
}

function findMissingFields(m: PaymentMandate): string[] {
  const missing: string[] = [];
  const req = m.requirement ?? ({} as PaymentMandate["requirement"]);
  if (!req.recipient || !String(req.recipient).trim()) missing.push("recipient");
  if (!req.network) missing.push("network");
  if (!req.asset?.code) missing.push("asset");
  if (!validAmount(req.amount)) missing.push("amount");
  if (!Number.isFinite(m.intervalMs) || m.intervalMs <= 0) missing.push("cadence");
  if (!(m.nextRunAt instanceof Date) || Number.isNaN(m.nextRunAt.getTime())) missing.push("nextRunAt");
  if (!validAmount(m.cumulativeLimit)) missing.push("cumulativeLimit");
  if (m.missedRunBehavior !== "skip" && m.missedRunBehavior !== "execute_late") missing.push("missedRunBehavior");
  return missing;
}

function sha256(value: unknown): string {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function buildConfirmationSummary(m: PaymentMandate): MandateConfirmationSummary {
  const req = m.requirement ?? ({} as PaymentMandate["requirement"]);
  const missingFields = findMissingFields(m);
  const nextRunValid = m.nextRunAt instanceof Date && !Number.isNaN(m.nextRunAt.getTime());

  const terms = {
    mandateId: m.id,
    recipient: req.recipient ?? "",
    network: req.network ?? "",
    asset: { code: req.asset?.code ?? "", issuer: req.asset?.issuer ?? null },
    amount: req.amount ?? "",
    intervalMs: m.intervalMs,
    cumulativeLimit: m.cumulativeLimit ?? "",
    missedRunBehavior: m.missedRunBehavior,
  };
  const nextRunAt = nextRunValid ? m.nextRunAt.toISOString() : "";

  return {
    mandateId: m.id,
    recipient: terms.recipient,
    network: terms.network,
    asset: terms.asset,
    amount: terms.amount,
    cadence: {
      intervalMs: m.intervalMs,
      description: missingFields.includes("cadence") ? "invalid" : describeInterval(m.intervalMs),
    },
    nextRunAt,
    cumulativeLimit: terms.cumulativeLimit,
    cancellationPolicy: {
      revocableAnytime: true,
      effect:
        "Cancelling stops all future runs immediately. A run already processing when you cancel is not reversed.",
      missedRunBehavior: m.missedRunBehavior,
      missedRunDescription:
        m.missedRunBehavior === "execute_late"
          ? "If a scheduled run is missed it is executed late, once."
          : "If a scheduled run is missed it is skipped.",
    },
    missingFields,
    summaryHash: sha256({ ...terms, nextRunAt, missingFields }),
    termsHash: sha256(terms),
  };
}
