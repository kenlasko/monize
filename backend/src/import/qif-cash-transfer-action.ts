/**
 * Whether a QIF investment row is written as a cash transfer between the
 * investment account and another account (`processCashTransfer` in
 * `import-investment-processor.service.ts`) rather than as an investment
 * transaction. XIn and XOut always are; Cash, WithdrwX and ContribX only when
 * the row names the other account. Every other action ignores a named account:
 * its cash stays in the investment account, and the other account's own export
 * carries the matching transfer.
 *
 * The parser reads it too, so a Microsoft Money "Category|[Account]" field
 * lists its account for mapping only where the import will use it.
 */
export function isQifCashTransfer(
  action: string,
  transferAccount: string | null | undefined,
): boolean {
  const normalized = action.trim().toLowerCase();
  if (normalized === "xin" || normalized === "xout") return true;
  return (
    !!transferAccount &&
    (normalized === "cash" ||
      normalized === "withdrwx" ||
      normalized === "contribx")
  );
}
