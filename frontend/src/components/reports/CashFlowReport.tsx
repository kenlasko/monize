"use client";

import { useReportExportMetadata } from '@/hooks/useReportExportMetadata';
import { useMemo, useRef, useState } from "react";
import { Skeleton } from '@/components/ui/LoadingSkeleton';
import { useRouter } from "next/navigation";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
  ReferenceLine,
} from "recharts";
import { parseISO } from "date-fns";
import { builtInReportsApi } from "@/lib/built-in-reports";
import type { Account } from "@/types/account";
import { accountsApi } from "@/lib/accounts";
import { usePersistedAccountFilter } from "@/hooks/usePersistedAccountFilter";
import { transferScopeFor, transferScopeKey } from '@/lib/transfer-scope';
import { ReportAccountMultiSelect } from "@/components/reports/ReportAccountMultiSelect";
import {
  IncomeExpensePeriodItem,
  CategorySpendingItem,
  IncomeSourceItem,
} from "@/types/built-in-reports";
import { useNumberFormat } from "@/hooks/useNumberFormat";
import { useChartDateFormat } from "@/hooks/useChartDateFormat";
import { useDateRange } from "@/hooks/useDateRange";
import { useReportData } from "@/hooks/useReportData";
import { DateRangeSelector } from "@/components/ui/DateRangeSelector";
import { ReportToolbarActions } from '@/components/reports/ReportToolbarActions';
import { ChartTooltip } from "@/components/reports/ChartTooltip";
import { ReportError } from "@/components/reports/ReportError";
import { chartColors } from "@/lib/chart-colors";
import { useTranslations } from 'next-intl';
import { useExchangeRates } from "@/hooks/useExchangeRates";
import { useTagKeys } from "@/hooks/useTagKeys";
import { usePartialTotalNote } from "@/hooks/usePartialTotalNote";
import { isComplete, reportTotal, type ConvertedTotal } from "@/lib/currency-total";
import { TagKeyBreakdownSelect } from "@/components/reports/TagKeyBreakdownSelect";
import { TagKeyBreakdownBuckets } from "@/components/reports/TagKeyBreakdownBuckets";
import { IncludeTaggedTransfersToggle } from "@/components/reports/IncludeTaggedTransfersToggle";
import { CashFlowSummaryCards } from "@/components/reports/CashFlowSummaryCards";
import { TaggedBalanceTooltip, type BalanceTooltipEntry } from "@/components/reports/TaggedBalanceTooltip";
import { periodBalanceFields, taggedBalanceWindow } from "@/lib/tagged-balance";
import { useTaggedFlowBucket } from "@/hooks/useTaggedFlowBucket";
import { useLocalStorage } from "@/hooks/useLocalStorage";
import { flowBarStack } from "@/lib/tagged-flow-stack";

const ACCOUNTS_STORAGE_KEY = 'monize-reports-cash-flow-accounts';
const INCLUDE_TRANSFERS_STORAGE_KEY = 'monize-reports-cash-flow-stack-tagged';

// Same account list Income vs Expenses offers: an investment account's cash
// legs are excluded from these reports by linkage.
const nonInvestmentAccounts = (a: Account) => a.accountType !== 'INVESTMENT';

interface ChartDataItem {
  name: string;
  fullName: string;
  Income: number;
  Expenses: number;
  Net: number;
  /** Balance view only: `taggedBalance` of the period (spec section 10.9). */
  Balance?: number;
  BalancePercent?: number | null;
  /** Tagged transfer flows of the active bucket; absent when no flow series is shown. */
  TaggedInflows?: number;
  TaggedOutflows?: number;
  monthStart: string;
  monthEnd: string;
}

interface CashFlowTooltipProps {
  active?: boolean;
  payload?: Array<{
    name: string;
    value: number;
    color: string;
    payload: { fullName: string };
  }>;
  formatCurrency: (value: number) => string;
  formatPercent: (value: number, decimals: number) => string;
  /** The Balance view (spec 10.9) reads each bar's tagged flows and Balance. */
  balanceView: boolean;
}

function CashFlowTooltip({
  active,
  payload,
  formatCurrency,
  formatPercent,
  balanceView,
}: CashFlowTooltipProps) {
  if (balanceView) {
    return (
      <TaggedBalanceTooltip
        active={active}
        payload={payload as unknown as BalanceTooltipEntry[]}
        formatValue={(v) => formatCurrency(v)}
        formatPercent={(p) => formatPercent(p, 2)}
      />
    );
  }
  return (
    <ChartTooltip
      active={active}
      label={payload?.[0]?.payload?.fullName}
      payload={payload}
      formatValue={(v) => formatCurrency(v)}
    />
  );
}

export function CashFlowReport() {
  const { withPdfBasis } = useReportExportMetadata('cash');
  const t = useTranslations('reports');
  const router = useRouter();
  const chartRef = useRef<HTMLDivElement>(null);
  const { formatCurrencyCompact: formatCurrency, formatCurrencyAxis, formatPercent } =
    useNumberFormat();
  const formatChartDate = useChartDateFormat();
  const { defaultCurrency } = useExchangeRates();
  const {
    dateRange,
    setDateRange,
    startDate,
    setStartDate,
    endDate,
    setEndDate,
    resolvedRange,
    isValid,
  } = useDateRange({ defaultRange: "6m", alignment: "month" });
  const tagKeys = useTagKeys();
  const [tagKey, setTagKey] = useState('');
  // Which tag-key bucket is selected. Owned here so the main chart can follow
  // the tab; TagKeyBreakdownBuckets is controlled by it.
  const [activeBucketValue, setActiveBucketValue] = useState('');

  const { start: rangeStart, end: rangeEnd } = resolvedRange;

  const { data: accountsData, error: accountsError } = useReportData(
    () => accountsApi.getAll(),
    [],
  );
  const offeredAccounts = useMemo(
    () => (accountsData ?? []).filter(nonInvestmentAccounts),
    [accountsData],
  );
  // Persisted so the report opens on the accounts the user last chose; empty
  // means every account, which is the report as it always was.
  const [selectedAccountIds, setSelectedAccountIds] = usePersistedAccountFilter(
    ACCOUNTS_STORAGE_KEY,
    offeredAccounts,
  );
  const accountIdsKey = selectedAccountIds.join(',');
  // "All Accounts" bounds the tagged flows by every offered account, so it reads
  // them as an explicit every-account selection does (spec 10.8.1). While the
  // offered accounts load, the breakdown is not asked for: the unbounded flows
  // are not a figure to show first.
  const offeredIds = useMemo(
    () =>
      accountsData !== null || accountsError !== null
        ? offeredAccounts.map((a) => a.id)
        : null,
    [accountsData, accountsError, offeredAccounts],
  );
  const transferScope = transferScopeFor(selectedAccountIds, offeredIds);
  const breakdownKey = transferScope.pending ? '' : tagKey;
  // Without a breakdown the boundary changes nothing, so it must not refetch.
  const scopeKey = breakdownKey ? transferScopeKey(transferScope) : '';

  const { data: response, isLoading, error, reload } = useReportData(
    async () => {
      if (!isValid) return null;
      // All three reads take the same account scope, or the cards, the chart
      // and the two category lists would describe different sets of accounts.
      const params = {
        startDate: rangeStart || undefined,
        endDate: rangeEnd,
        ...(selectedAccountIds.length > 0 ? { accountIds: selectedAccountIds } : {}),
      };
      // Fetch all data in parallel
      const [cashFlowResponse, incomeResponse, spendingResponse] =
        await Promise.all([
          builtInReportsApi.getCashFlow({
            ...params,
            ...(breakdownKey ? { tagKey: breakdownKey } : {}),
            // Only the tagged flows take the boundary; the two sibling reads
            // and the cash-flow totals keep the page's own scope.
            ...(breakdownKey && transferScope.accountIds
              ? { transferScopeAccountIds: transferScope.accountIds }
              : {}),
          }),
          builtInReportsApi.getIncomeBySource(params),
          builtInReportsApi.getSpendingByCategory(params),
        ]);
      return { cashFlowResponse, incomeResponse, spendingResponse };
    },
    [isValid, rangeStart, rangeEnd, breakdownKey, accountIdsKey, scopeKey],
  );

  const { activeBucket, flowBucket, flowsByPeriod } = useTaggedFlowBucket(
    response?.cashFlowResponse,
    activeBucketValue,
  );
  const showFlows = flowBucket !== undefined;
  // Opt-in, off by default: stacks the tagged flows on the bars and replaces
  // Net with Balance and Balance % (spec sections 10.7 and 10.9). Income,
  // expenses and net stay the server's values either way (INV-REPORT-003).
  const [includeTransfersPref, setIncludeTransfersPref] = useLocalStorage<boolean>(
    INCLUDE_TRANSFERS_STORAGE_KEY,
    false,
  );
  const balanceView = showFlows && includeTransfersPref === true;
  const stackFlows = balanceView;

  // Map monthly data. `name` must be unique across the dataset (used as
  // the XAxis category key); a non-unique value like "May" causes Recharts
  // to resolve the tooltip's payload to the first matching row, showing data
  // from the wrong year on multi-year ranges.
  const monthlyData = useMemo<ChartDataItem[]>(
    () =>
      (response?.cashFlowResponse.data ?? []).map((item: IncomeExpensePeriodItem) => {
        return {
          name: item.period,
          fullName: formatChartDate(parseISO(item.periodStart), "MMM yyyy"),
          Income: Math.round(item.income),
          Expenses: Math.round(item.expenses),
          Net: Math.round(item.net),
          ...(balanceView ? periodBalanceFields(item, flowsByPeriod.get(item.period)) : {}),
          // Flows ride beside the bars and never enter income, expenses or net
          // (INV-REPORT-003). A period the bucket has no row for had no tagged
          // transfer in it, which is a known zero.
          ...(flowBucket
            ? {
                TaggedInflows: Math.round(flowsByPeriod.get(item.period)?.taggedInflows ?? 0),
                TaggedOutflows: Math.round(flowsByPeriod.get(item.period)?.taggedOutflows ?? 0),
              }
            : {}),
          // The dates the bucket covers come from the server that chose it.
          monthStart: item.periodStart,
          monthEnd: item.periodEnd,
        };
      }),
    [response, formatChartDate, flowBucket, flowsByPeriod, balanceView],
  );

  const incomeItems = useMemo<IncomeSourceItem[]>(
    () => response?.incomeResponse.data ?? [],
    [response],
  );
  const expenseItems = useMemo<CategorySpendingItem[]>(
    () => response?.spendingResponse.data ?? [],
    [response],
  );
  // Each total is `null` when a row could not be converted -- a missing rate
  // makes it unknowable, never smaller -- and the part that did convert comes as
  // its `known*` sibling. What is shown is that subtotal, marked, and a total
  // that did convert is complete whatever its neighbours are. No response at all
  // is no figures, not three zeros.
  const totals = useMemo(() => {
    const cashFlow = response?.cashFlowResponse;
    if (!cashFlow) return null;
    const figure = (value: number | null, known: number): ConvertedTotal => {
      if (value !== null) return { value, missingCurrencies: [], excludedCount: 0 };
      const withheld = reportTotal(known, cashFlow);
      // A withheld total is partial even if the response named nothing.
      return isComplete(withheld) ? { ...withheld, excludedCount: 1 } : withheld;
    };
    return {
      income: figure(cashFlow.totals.income, cashFlow.totals.knownIncome),
      expenses: figure(cashFlow.totals.expenses, cashFlow.totals.knownExpenses),
      net: figure(cashFlow.totals.net, cashFlow.totals.knownNet),
    };
  }, [response]);
  const { noteFor, cellFor } = usePartialTotalNote();
  const reportingCurrency = response?.cashFlowResponse.currency ?? defaultCurrency;
  // The Balance view's window figure and what it is built from: the part of the
  // All totals that converted plus the active bucket's own flows.
  const balance = useMemo(() => {
    const cashFlow = response?.cashFlowResponse;
    if (!balanceView || !flowBucket || !cashFlow) return undefined;
    const completeness = {
      missingCurrencies: cashFlow.missingCurrencies,
      excludedCount: cashFlow.excludedCount,
    };
    return {
      bucket: flowBucket,
      knownIncome: cashFlow.totals.knownIncome,
      knownExpenses: cashFlow.totals.knownExpenses,
      completeness,
      window: taggedBalanceWindow(
        {
          income: cashFlow.totals.knownIncome,
          expenses: cashFlow.totals.knownExpenses,
          taggedInflows: flowBucket.taggedInflows,
          taggedOutflows: flowBucket.taggedOutflows,
        },
        cashFlow.totals.income !== null && cashFlow.totals.expenses !== null,
        completeness,
        flowBucket,
      ),
    };
  }, [balanceView, flowBucket, response]);

  const handleExportPdf = async () => {
    // The toolbar is disabled without a response; this is the same refusal for a
    // caller that gets here another way, so no document carries three zeros.
    if (!totals) return;
    const { exportToPdf } = await import("@/lib/pdf-export");

    const inflowRows = incomeItems.map((item) => [item.categoryName, formatCurrency(item.total)]);
    const outflowRows = expenseItems.map((item) => [item.categoryName, formatCurrency(item.total)]);

    await exportToPdf(withPdfBasis({
      title: t('cashFlow.monthlyCashFlow'),
      summaryCards: balance
        ? [
            { label: t('cashFlow.totalInflows'), value: formatCurrency(balance.knownIncome), color: "#16a34a" },
            { label: t('tagBreakdown.inflows'), value: formatCurrency(balance.bucket.taggedInflows), color: "#4f46e5" },
            { label: t('cashFlow.totalOutflows'), value: formatCurrency(balance.knownExpenses), color: "#dc2626" },
            ...(balance.bucket.taggedOutflows !== 0
              ? [{ label: t('tagBreakdown.outflows'), value: formatCurrency(balance.bucket.taggedOutflows), color: "#4f46e5" }]
              : []),
            { label: t('tagBreakdown.balance'), value: `${formatCurrency(balance.window.balance ?? 0)}${balance.window.complete ? "" : "*"}`, color: (balance.window.balance ?? 0) >= 0 ? "#2563eb" : "#ea580c" },
            { label: t('tagBreakdown.balancePercent'), value: balance.window.balancePercent === null ? "\u2014" : formatPercent(balance.window.balancePercent, 2), color: (balance.window.balancePercent ?? 0) >= 0 ? "#9333ea" : "#ea580c" },
          ]
        : [
            { label: t('cashFlow.totalInflows'), value: formatCurrency(totals.income.value), color: "#16a34a", note: noteFor(totals.income) },
            { label: t('cashFlow.totalOutflows'), value: formatCurrency(totals.expenses.value), color: "#dc2626", note: noteFor(totals.expenses) },
            { label: t('cashFlow.netCashFlow'), value: `${totals.net.value >= 0 ? "+" : ""}${formatCurrency(totals.net.value)}`, color: totals.net.value >= 0 ? "#2563eb" : "#ea580c", note: noteFor(totals.net) },
          ],
      chartContainer: chartRef.current,
      additionalTables: [
        ...(inflowRows.length > 0 ? [{
          title: t('cashFlow.inflowsByCategory'),
          headers: ["Category", "Amount"],
          rows: inflowRows,
          totalRow: [t('cashFlow.totalInflows'), cellFor(formatCurrency(totals.income.value), totals.income)],
        }] : []),
        ...(outflowRows.length > 0 ? [{
          title: t('cashFlow.outflowsByCategory'),
          headers: ["Category", "Amount"],
          rows: outflowRows,
          totalRow: [t('cashFlow.totalOutflows'), cellFor(formatCurrency(totals.expenses.value), totals.expenses)],
        }] : []),
      ],
      filename: "cash-flow",
    }));
  };

  const handleChartClick = (state: any) => {
    const label = state?.activeLabel;
    if (!label) return;
    const item = monthlyData.find((d) => d.name === label);
    if (item?.monthStart && item?.monthEnd) {
      router.push(
        `/transactions?startDate=${item.monthStart}&endDate=${item.monthEnd}`,
      );
    }
  };

  const handleCategoryClick = (categoryId: string | null) => {
    if (!categoryId) return;
    const { start, end } = resolvedRange;
    const params = new URLSearchParams();
    params.set("categoryId", categoryId);
    if (start) params.set("startDate", start);
    if (end) params.set("endDate", end);
    router.push(`/transactions?${params.toString()}`);
  };

  // Loading and error render inside this tree, never as an early return: a
  // second tree unmounts the controls block and ejects focus from the date
  // field being typed into (issue #1201).
  const dataUnavailable = isLoading || !!error;
  // The export is refused while there is nothing true to export: loading, failed
  // or absent (an invalid custom range answers `null`).
  const exportDisabled = dataUnavailable || !response;

  return (
    <div className="space-y-6">
      {/* Summary Cards */}
      {dataUnavailable ? (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
      ) : (
      <CashFlowSummaryCards totals={totals} reportingCurrency={reportingCurrency} balance={balance} />
      )}

      {/* Controls -- always rendered so focus inside DateInput survives reloads.
          It sits between the cards and the chart, and both of those change with
          the data, so it can only stay mounted if this is the one tree the
          component ever returns. */}
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4">
        <div className="flex flex-wrap gap-4 items-center justify-between">
          <ReportAccountMultiSelect
            accounts={offeredAccounts}
            value={selectedAccountIds}
            onChange={setSelectedAccountIds}
            filter={nonInvestmentAccounts}
          />
          <DateRangeSelector
            ranges={["3m", "6m", "1y"]}
            value={dateRange}
            onChange={setDateRange}
            showCustom
            customStartDate={startDate}
            onCustomStartDateChange={setStartDate}
            customEndDate={endDate}
            onCustomEndDateChange={setEndDate}
          />
          <TagKeyBreakdownSelect tagKeys={tagKeys} value={tagKey} onChange={setTagKey} />
          {showFlows && (
            <IncludeTaggedTransfersToggle checked={balanceView} onChange={setIncludeTransfersPref} />
          )}
          <ReportToolbarActions onExportPdf={handleExportPdf} disabled={exportDisabled} />
        </div>
      </div>

      {error ? (
        <ReportError onRetry={reload} />
      ) : isLoading ? (
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-6">
          <div className="space-y-4">
            <Skeleton className="h-8 w-1/3" />
            <Skeleton className="h-64 w-full" />
          </div>
        </div>
      ) : (
        <>
      {/* Monthly Chart */}
      <div ref={chartRef} className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 px-2 py-4 sm:p-6">
        <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4 px-1 sm:px-0">
          {t('cashFlow.monthlyCashFlow')}
        </h3>
        <div className="h-80">
          <ResponsiveContainer width="100%" height="100%" minWidth={0}>
            <BarChart
              data={monthlyData}
              margin={{ top: 20, right: 10, left: 0, bottom: 5 }}
              onClick={handleChartClick}
              style={{ cursor: "pointer" }}
            >
              <CartesianGrid strokeDasharray="3 3" stroke={chartColors.grid} />
              <XAxis
                dataKey="name"
                tick={{ fontSize: 12 }}
                tickFormatter={(value: string) =>
                  formatChartDate(`${value}-01`, "MMM")
                }
              />
              <YAxis
                tickFormatter={formatCurrencyAxis}
                tick={{ fontSize: 12 }}
              />
              <Tooltip content={<CashFlowTooltip formatCurrency={formatCurrency} formatPercent={formatPercent} balanceView={balanceView} />} />
              <Legend />
              <ReferenceLine y={0} stroke={chartColors.axis} />
              <Bar
                dataKey="Income"
                fill={chartColors.income}
                name={t('cashFlow.seriesInflows')}
                {...flowBarStack(stackFlows, 'inflows', 'base')}
              />
              <Bar
                dataKey="Expenses"
                fill={chartColors.expense}
                name={t('cashFlow.seriesOutflows')}
                {...flowBarStack(stackFlows, 'outflows', 'base')}
              />
              {/* Balance view: the period's Balance, drawn after the bars it
                  is made of. */}
              {balanceView && (
                <Bar
                  dataKey="Balance"
                  fill={chartColors.primary}
                  name={t('tagBreakdown.balance')}
                  radius={[4, 4, 0, 0]}
                />
              )}
              {/* The funding series: the active tag bucket's transfer flows, in
                  the indigo pair the breakdown card uses so they never read as
                  income or expenses. Absent without a tag key or on the
                  untagged tab. */}
              {flowBucket && (
                <Bar
                  dataKey="TaggedInflows"
                  fill={chartColors.inflow}
                  name={t('tagBreakdown.inflowsSeries', { value: flowBucket.value })}
                  {...flowBarStack(stackFlows, 'inflows', 'tagged')}
                />
              )}
              {flowBucket && (
                <Bar
                  dataKey="TaggedOutflows"
                  fill={chartColors.outflow}
                  name={t('tagBreakdown.outflowsSeries', { value: flowBucket.value })}
                  {...flowBarStack(stackFlows, 'outflows', 'tagged')}
                />
              )}
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Breakdown Tables */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Inflows */}
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 overflow-hidden">
          <div className="px-6 py-4 bg-green-50 dark:bg-green-900/20 border-b border-gray-200 dark:border-gray-700">
            <h3 className="text-lg font-semibold text-green-700 dark:text-green-300">
              {t('cashFlow.inflowsByCategory')}
            </h3>
          </div>
          <div className="divide-y divide-gray-200 dark:divide-gray-700 max-h-96 overflow-y-auto">
            {incomeItems.length === 0 ? (
              <p className="px-6 py-4 text-gray-500 dark:text-gray-400">
                {t('cashFlow.noIncome')}
              </p>
            ) : (
              incomeItems.map((item, index) => (
                <div
                  key={index}
                  className={`px-6 py-3 flex items-center justify-between ${item.categoryId ? "cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-700/50" : ""}`}
                  onClick={() => handleCategoryClick(item.categoryId)}
                >
                  <span className="text-gray-900 dark:text-gray-100">
                    {item.categoryName}
                  </span>
                  <span className="font-medium text-green-600 dark:text-green-400">
                    {formatCurrency(item.total)}
                  </span>
                </div>
              ))
            )}
          </div>
        </div>

        {/* Outflows */}
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 overflow-hidden">
          <div className="px-6 py-4 bg-red-50 dark:bg-red-900/20 border-b border-gray-200 dark:border-gray-700">
            <h3 className="text-lg font-semibold text-red-700 dark:text-red-300">
              {t('cashFlow.outflowsByCategory')}
            </h3>
          </div>
          <div className="divide-y divide-gray-200 dark:divide-gray-700 max-h-96 overflow-y-auto">
            {expenseItems.length === 0 ? (
              <p className="px-6 py-4 text-gray-500 dark:text-gray-400">
                {t('cashFlow.noExpenses')}
              </p>
            ) : (
              expenseItems.map((item, index) => (
                <div
                  key={index}
                  className={`px-6 py-3 flex items-center justify-between ${item.categoryId ? "cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-700/50" : ""}`}
                  onClick={() => handleCategoryClick(item.categoryId)}
                >
                  <span className="text-gray-900 dark:text-gray-100">
                    {item.categoryName}
                  </span>
                  <span className="font-medium text-red-600 dark:text-red-400">
                    {formatCurrency(item.total)}
                  </span>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
        </>
      )}

      {!isLoading && !error && response?.cashFlowResponse.tagKey && response.cashFlowResponse.buckets && (
        <TagKeyBreakdownBuckets
          tagKey={response.cashFlowResponse.tagKey}
          buckets={response.cashFlowResponse.buckets}
          reportingCurrency={reportingCurrency}
          idPrefix="cash-flow-tag"
          activeValue={activeBucket?.value}
          onActiveValueChange={setActiveBucketValue}
        />
      )}
    </div>
  );
}
