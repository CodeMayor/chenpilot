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

export type RoundingMode = "half_even" | "half_up" | "down";

/**
 * Round to `scale` fractional digits.
 *  - half_even: ties go to the even neighbour (banker's rounding)
 *  - half_up:   ties go away from zero
 *  - down:      truncate toward zero
 * Negative values round symmetrically (by magnitude).
 */
export function roundToScale(d: FixedDecimal, scale: number, mode: RoundingMode): FixedDecimal {
  if (d.scale <= scale) return upscale(d, scale);

  const divisor = 10n ** BigInt(d.scale - scale);
  const negative = d.units < 0n;
  const magnitude = negative ? -d.units : d.units;
  let quotient = magnitude / divisor;
  const remainder = magnitude % divisor;

  if (mode !== "down" && remainder !== 0n) {
    const twice = remainder * 2n;
    if (twice > divisor) quotient += 1n;
    else if (twice === divisor) {
      if (mode === "half_up" || quotient % 2n === 1n) quotient += 1n;
    }
  }

  return { units: negative ? -quotient : quotient, scale };
}

/** Convert a JS number to a decimal (12 fractional digits; rounding noise beyond that is dropped). */
export function numberToDecimal(n: number): FixedDecimal | null {
  if (!Number.isFinite(n) || Math.abs(n) >= 1e21) return null;
  return parseDecimal(n.toFixed(12));
}

export function subtract(a: FixedDecimal, b: FixedDecimal): FixedDecimal {
  return add(a, { units: -b.units, scale: b.scale });
}
