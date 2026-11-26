/** Undefined is an older response without shares; null is an explicitly unavailable share. */
export function reportBreakdownShare(item: { value: number; percentage?: number | null }, total: number): number | null {
  if (item.percentage !== undefined) return item.percentage;
  return total > 0 ? (item.value / total) * 100 : 0;
}

export function amountWithShare(amount: string, share: number | null, formatPercent: (value: number, decimals: number) => string): string {
  return share === null ? amount : `${amount} (${formatPercent(share, 1)})`;
}
