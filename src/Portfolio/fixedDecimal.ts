/**
 * Minimal exact decimal arithmetic on BigInt for financial values.
 * Values are `{ units, scale }` meaning `units / 10^scale`. No floating point.
 */
export interface FixedDecimal {
  units: bigint;
  scale: number;
}

const DECIMAL_RE = /^([+-])?(\d+)(?:\.(\d+))?$/;

/** Parse a plain decimal string ("12", "-0.5", "3.1400"). Returns null if malformed. */
export function parseDecimal(input: unknown): FixedDecimal | null {
  if (typeof input === "number") {
    if (!Number.isFinite(input)) return null;
    // Use the shortest round-trip representation; reject exponent forms.
    input = String(input);
    if (/e/i.test(input as string)) return null;
  }
  if (typeof input !== "string") return null;
  const match = DECIMAL_RE.exec(input.trim());
  if (!match) return null;
  const [, sign, intPart, fracPart = ""] = match;
  const units = BigInt(intPart + fracPart) * (sign === "-" ? -1n : 1n);
  return { units, scale: fracPart.length };
}

export function isZero(d: FixedDecimal): boolean {
  return d.units === 0n;
}

export function isPositive(d: FixedDecimal): boolean {
  return d.units > 0n;
}

/** Rescale to a larger scale without loss. */
export function upscale(d: FixedDecimal, scale: number): FixedDecimal {
  if (scale < d.scale) throw new Error("upscale cannot reduce scale");
  return { units: d.units * 10n ** BigInt(scale - d.scale), scale };
}

export function add(a: FixedDecimal, b: FixedDecimal): FixedDecimal {
  const scale = Math.max(a.scale, b.scale);
  return { units: upscale(a, scale).units + upscale(b, scale).units, scale };
}

export function multiply(a: FixedDecimal, b: FixedDecimal): FixedDecimal {
  return { units: a.units * b.units, scale: a.scale + b.scale };
}

/** Exact string form, keeping all fractional digits. */
export function toDecimalString(d: FixedDecimal): string {
  const negative = d.units < 0n;
  const digits = (negative ? -d.units : d.units).toString().padStart(d.scale + 1, "0");
  const intPart = d.scale === 0 ? digits : digits.slice(0, digits.length - d.scale);
  const fracPart = d.scale === 0 ? "" : digits.slice(digits.length - d.scale);
  return `${negative ? "-" : ""}${intPart}${fracPart ? `.${fracPart}` : ""}`;
}
