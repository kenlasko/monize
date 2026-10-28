import { HttpException, ServiceUnavailableException } from "@nestjs/common";
const SAFE_CODES = new Set([
  "REPORTING_BASIS_INVALID",
  "REPORTING_BASIS_CONFLICT",
  "REPORTING_BASIS_UNSUPPORTED",
  "REPORTING_TYPE_INVALID",
  "REPORTING_PERIOD_INVALID",
  "REPORTING_FX_INCOMPLETE",
  "REPORTING_BALANCE_HISTORY_INCOMPLETE",
  "REPORTING_ROW_LIMIT",
  "REPORTING_BUDGET_REQUIRED",
  "REPORTING_VALUE_INCOMPLETE",
]);
/** Only reporting-domain repair data can cross the generic 5xx redaction boundary. */
export function reportingFailure(
  error: unknown,
): Record<string, unknown> | null {
  if (!(error instanceof HttpException)) return null;
  const value = error.getResponse();
  if (
    !value ||
    typeof value !== "object" ||
    !("code" in value) ||
    typeof value.code !== "string" ||
    !SAFE_CODES.has(value.code)
  )
    return null;
  const keys = [
    "allowed",
    "code",
    "currency",
    "fxComplete",
    "pricesComplete",
    "valuationComplete",
    "repair",
    "fetchAttempted",
    "accountId",
    "date",
    "dates",
    "missingRatePairs",
    "missingCurrencies",
    "unpricedSymbols",
    "limit",
  ];
  const repairs: Record<string, string> = {
    REPORTING_FX_INCOMPLETE: "currency_rate_history",
    REPORTING_VALUE_INCOMPLETE: "report_source_data",
    REPORTING_BALANCE_HISTORY_INCOMPLETE: "refresh_balance_history",
    REPORTING_ROW_LIMIT: "narrow_report_filters",
    REPORTING_BUDGET_REQUIRED: "create_budget",
  };
  return {
    repair: repairs[value.code] ?? "report_parameters",
    ...Object.fromEntries(
      keys
        .filter((key) => key in value)
        .map((key) => [key, (value as Record<string, unknown>)[key]]),
    ),
  };
}
/** A model must not narrate legacy subtotals as complete totals. Child flags
 * remain authoritative; success without a flag does not manufacture one.
 */
export function assertReportingComplete(value: unknown): void {
  const gaps: unknown[] = [];
  const prices: unknown[] = [];
  let incomplete = false;
  const visit = (item: unknown, depth: number) => {
    if (!item || typeof item !== "object" || depth > 12) return;
    if (Array.isArray(item)) {
      for (const row of item) visit(row, depth + 1);
      return;
    }
    const row = item as Record<string, unknown>;
    if (
      row.fxComplete === false ||
      row.pricesComplete === false ||
      row.valuationComplete === false
    )
      incomplete = true;
    for (const key of ["missingRatePairs", "missingCurrencies"])
      if (Array.isArray(row[key]) && row[key].length) {
        gaps.push(...row[key]);
        incomplete = true;
      }
    if (Array.isArray(row.unpricedSymbols) && row.unpricedSymbols.length) {
      prices.push(...row.unpricedSymbols);
      incomplete = true;
    }
    for (const child of Object.values(row)) visit(child, depth + 1);
  };
  visit(value, 0);
  if (incomplete)
    throw new ServiceUnavailableException({
      code: prices.length
        ? "REPORTING_VALUE_INCOMPLETE"
        : "REPORTING_FX_INCOMPLETE",
      currency:
        typeof (value as Record<string, unknown>).currency === "string"
          ? (value as Record<string, unknown>).currency
          : undefined,
      valuationComplete: false,
      fxComplete: gaps.length === 0,
      missingRatePairs: gaps,
      unpricedSymbols: prices,
      repair: prices.length
        ? "security_price_history"
        : "currency_rate_history",
      fetchAttempted: false,
    });
}

/** A refusal names the missing pairs and the existing Currencies repair. */
export function reportingFailureNote(failure: Record<string, unknown>): string {
  if (
    failure.code !== "REPORTING_FX_INCOMPLETE" ||
    !Array.isArray(failure.missingRatePairs)
  )
    return "";
  const pairs = failure.missingRatePairs
    .map((pair: unknown) => {
      if (typeof pair === "string")
        return pair.includes("->") || typeof failure.currency !== "string"
          ? pair
          : `${pair}->${failure.currency}`;
      if (pair && typeof pair === "object" && "from" in pair && "to" in pair)
        return `${pair.from}->${pair.to}`;
      return "";
    })
    .filter(Boolean);
  return pairs.length
    ? ` Total withheld: no exchange rate for ${pairs.join(", ")}; add it under Currencies.`
    : "";
}
