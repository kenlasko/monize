import apiClient from "./api";
import { isUuid } from "./uuid";
export interface ReportingDetailsInput {
  startDate: string;
  endDate: string;
  basis: "cash" | "accrual";
  sourceTransactionIds?: string[];
  accountIds?: string[];
  categoryIds?: string[];
  payeeIds?: string[];
  tagIds?: string[];
  categoryType?: "income" | "expense";
  uncategorized?: boolean;
  kind?: "ordinary" | "transfer" | "investment" | "all";
  limit?: number;
}
export interface ReportingFact {
  sourceTransactionId: string;
  sourceSplitId: string | null;
  scheduleId: string | null;
  cashDate: string;
  effectiveDate: string;
  nativeAmount: string;
  sourceAmount: string;
  currencyCode: string;
  convertedAmount: number | null;
  accountId: string;
  kind: string;
  readOnly: true;
}
export interface ReportingDetails {
  basis: "cash" | "accrual";
  currency: string;
  readOnly: true;
  fxComplete: boolean;
  total: number | null;
  knownSubtotal: number;
  missingRatePairs: unknown[];
  rows: ReportingFact[];
}
export const reportingDetailsApi = {
  get: async (input: ReportingDetailsInput): Promise<ReportingDetails> => {
    const response = await apiClient.get<ReportingDetails>(
      "/accruals/reporting-details",
      { params: input, paramsSerializer: { indexes: null } },
    );
    return response.data;
  },
};
/** Refuse unknown/ambiguous filters; never widen a report selection silently. */
export function reportingDetailsFromUrl(
  href: string,
): ReportingDetailsInput | null {
  const url = new URL(href, "https://internal.invalid");
  if (url.pathname !== "/transactions") return null;
  const q = url.searchParams;
  for (const key of ["startDate", "endDate", "categoryType", "accountStatus"])
    if (q.getAll(key).length > 1) throw new Error("unsupported");
  const allowed = new Set([
    "startDate",
    "endDate",
    "categoryId",
    "categoryIds",
    "categoryType",
    "payeeId",
    "payeeIds",
    "accountId",
    "accountIds",
    "tagId",
    "tagIds",
    "accountStatus",
  ]);
  for (const key of q.keys())
    if (!allowed.has(key)) throw new Error("unsupported");
  if (q.get("accountStatus") && q.get("accountStatus") !== "all")
    throw new Error("unsupported");
  const result: ReportingDetailsInput = {
    basis: "accrual",
    startDate: q.get("startDate") || "0001-01-01",
    endDate: q.get("endDate") || "9999-12-31",
    limit: 2000,
  };
  for (const [singular, plural] of [
    ["accountId", "accountIds"],
    ["categoryId", "categoryIds"],
    ["payeeId", "payeeIds"],
    ["tagId", "tagIds"],
  ] as const) {
    const values = [...q.getAll(singular), ...q.getAll(plural)]
      .flatMap((value) => value.split(","))
      .filter(Boolean);
    if (!values.length) continue;
    if (plural === "categoryIds" && values.length === 1) {
      if (values[0] === "uncategorized") {
        result.uncategorized = true;
        continue;
      }
      if (values[0] === "transfer") {
        result.kind = "transfer";
        continue;
      }
      if (values[0] === "income" || values[0] === "expense") {
        result.categoryType = values[0];
        continue;
      }
    }
    if (values.some((value) => !isUuid(value))) throw new Error("unsupported");
    if (values.length > 200) throw new Error("unsupported");
    result[plural] = [...new Set(values)];
  }
  const categoryType = q.get("categoryType");
  if (categoryType) {
    if (categoryType !== "income" && categoryType !== "expense")
      throw new Error("unsupported");
    if (result.categoryType && result.categoryType !== categoryType)
      throw new Error("unsupported");
    result.categoryType = categoryType;
  }
  return result;
}
