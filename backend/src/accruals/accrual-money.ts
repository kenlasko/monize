/** Exact decimal(20,4) arithmetic; money crosses this boundary as strings. */
export const ACCRUAL_MONEY_SCALE = 10_000n;
const MAX_UNITS = 99_999_999_999_999_999_999n;

export function parseAccrualMoney(value: string): bigint {
  if (typeof value !== "string" || !/^-?\d{1,16}(?:\.\d{1,4})?$/.test(value)) {
    throw new Error("Invalid accrual decimal");
  }
  const negative = value.startsWith("-");
  const [whole, fraction = ""] = (negative ? value.slice(1) : value).split(".");
  const units =
    BigInt(whole) * ACCRUAL_MONEY_SCALE + BigInt(fraction.padEnd(4, "0"));
  if (units > MAX_UNITS) throw new Error("Accrual decimal out of range");
  return negative ? -units : units;
}

export function formatAccrualMoney(units: bigint): string {
  const magnitude = units < 0n ? -units : units;
  if (magnitude > MAX_UNITS) throw new Error("Accrual decimal out of range");
  return `${units < 0n ? "-" : ""}${magnitude / ACCRUAL_MONEY_SCALE}.${String(magnitude % ACCRUAL_MONEY_SCALE).padStart(4, "0")}`;
}

/** Preserve valid source precision beyond the currency's normal minor unit. */
export function accrualAllocationQuantum(
  units: bigint,
  currencyDecimals: number,
): bigint {
  if (
    !Number.isInteger(currencyDecimals) ||
    currencyDecimals < 0 ||
    currencyDecimals > 4
  ) {
    throw new Error("Unsupported accrual currency precision");
  }
  const normal = 10n ** BigInt(4 - currencyDecimals);
  return units % normal === 0n ? normal : 1n;
}
