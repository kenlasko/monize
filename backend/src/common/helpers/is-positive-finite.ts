/**
 * Whether a value is a number that can be a price or a rate: finite and above
 * zero. Zero, a negative, `NaN`, `null` and `undefined` are absent, never a
 * figure to multiply by (INV-FX-001).
 */
export function isPositiveFinite(
  value: number | null | undefined,
): value is number {
  return value != null && Number.isFinite(value) && value > 0;
}
