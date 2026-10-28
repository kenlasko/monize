"use client";

import { useMemo } from "react";
import { useReportingBasis } from "@/components/reports/ReportingBasis";
import { builtInReportsApi } from "@/lib/built-in-reports";
import { useReportData } from "@/hooks/useReportData";
import { fundingWindow, type FundingWindow } from "@/lib/tagged-funding";
import { transferScopeKey, type TransferScope } from "@/lib/transfer-scope";
import type { IncomeVsExpensesResponse } from "@/types/built-in-reports";

export interface TaggedFundingParams {
  /** False = no request at all (spec F1). */
  enabled: boolean;
  tagKey: string;
  tagValue: string;
  startDate: string | undefined;
  endDate: string;
  /** The page's account scope; empty = every account. */
  accountIds: string[];
  /**
   * The tagged-transfer boundary under "All Accounts" (spec 10.8.1), from
   * `useReportAccountScope` / `useDefaultTransferScope`. While it is pending
   * no request is made: the unbounded flows are not a figure to show first.
   */
  transferScope: TransferScope;
}

export interface TaggedFunding {
  status: "off" | "loading" | "error" | "ready";
  response: IncomeVsExpensesResponse | null;
  /** The chosen value's window figures; null until `status` is `ready`. */
  window: FundingWindow | null;
  reload: () => void;
}

/**
 * The one funding fetch of the other reports (spec section 11.1, F3): Income vs
 * Expenses by month for the page's window and account scope, broken down by the
 * chosen tag key. Makes no request while `enabled` is false.
 */
export function useTaggedFunding({
  enabled,
  tagKey,
  tagValue,
  startDate,
  endDate,
  accountIds,
  transferScope,
}: TaggedFundingParams): TaggedFunding {
  const basis = useReportingBasis();
  const accountIdsKey = accountIds.join(",");
  // A selection carries its own boundary; "All Accounts" waits for the offered one.
  const scopePending = accountIds.length === 0 && transferScope.pending;
  const fetching = enabled && !scopePending;
  // Only a request that is made depends on the boundary; a disabled one must not refetch.
  const scopeKey =
    fetching && accountIds.length === 0 ? transferScopeKey(transferScope) : "";
  const { data, isLoading, error, reload } = useReportData(
    () =>
      fetching
        ? builtInReportsApi.getIncomeVsExpenses({
            ...(basis ? { basis } : {}),
            startDate,
            endDate,
            bucket: "month",
            tagKey,
            ...(accountIds.length > 0
              ? { accountIds }
              : transferScope.accountIds
                ? { transferScopeAccountIds: transferScope.accountIds }
                : {}),
          })
        : Promise.resolve(null),
    [fetching, tagKey, startDate, endDate, accountIdsKey, scopeKey, basis],
    {
      requestKey: JSON.stringify([
        fetching,
        tagKey,
        startDate,
        endDate,
        accountIdsKey,
        scopeKey,
        basis,
      ]),
      maskStaleData: true,
    },
  );

  const window = useMemo(
    () => (fetching && data ? fundingWindow(data, tagValue) : null),
    [fetching, data, tagValue],
  );
  const status: TaggedFunding["status"] = !enabled
    ? "off"
    : scopePending
      ? "loading"
      : error
        ? "error"
        : isLoading || !data
          ? "loading"
          : "ready";
  return { status, response: fetching ? data : null, window, reload };
}
