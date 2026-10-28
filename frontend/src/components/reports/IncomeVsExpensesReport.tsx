"use client";

import { useReportExportMetadata } from '@/hooks/useReportExportMetadata';
import { useReportingBasis, useReportingRouter } from './ReportingBasis';
import { useState, useMemo, useRef } from "react";
import { Skeleton } from '@/components/ui/LoadingSkeleton';

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
import { IncomeExpensePeriodItem } from "@/types/built-in-reports";
import type { Account } from "@/types/account";
import { accountsApi } from "@/lib/accounts";
import { usePersistedAccountFilter } from "@/hooks/usePersistedAccountFilter";
import { transferScopeFor, transferScopeKey } from '@/lib/transfer-scope';
import { ReportAccountMultiSelect } from "@/components/reports/ReportAccountMultiSelect";
import { useNumberFormat } from "@/hooks/useNumberFormat";
import { useDateRange } from "@/hooks/useDateRange";
import { useReportData } from "@/hooks/useReportData";
import { useSortableTable, compareValues } from "@/hooks/useSortableTable";
import { DateRangeSelector } from "@/components/ui/DateRangeSelector";
import { ChartViewToggle } from "@/components/ui/ChartViewToggle";
import { ReportToolbarActions } from '@/components/reports/ReportToolbarActions';
import { ChartTooltip } from "@/components/reports/ChartTooltip";
import { ReportError } from "@/components/reports/ReportError";
import { chartColors } from "@/lib/chart-colors";
import { useChartDateFormat } from "@/hooks/useChartDateFormat";
import { useTranslations } from 'next-intl';
import { useExchangeRates } from "@/hooks/useExchangeRates";
import { usePartialTotalNote } from "@/hooks/usePartialTotalNote";
import { useTagKeys } from "@/hooks/useTagKeys";
import { TagKeyBreakdownSelect } from "@/components/reports/TagKeyBreakdownSelect";
import { TagKeyBreakdownBuckets } from "@/components/reports/TagKeyBreakdownBuckets";
import { IncludeTaggedTransfersToggle } from "@/components/reports/IncludeTaggedTransfersToggle";
import { IncomeVsExpensesSummaryCards } from "@/components/reports/IncomeVsExpensesSummaryCards";
import { TaggedBalanceTooltip, type BalanceTooltipEntry } from "@/components/reports/TaggedBalanceTooltip";
import { periodBalanceFields, taggedBalanceWindow } from "@/lib/tagged-balance";
import { useTaggedFlowBucket } from "@/hooks/useTaggedFlowBucket";
import { useLocalStorage } from "@/hooks/useLocalStorage";
import { flowBarStack } from "@/lib/tagged-flow-stack";
import {
  IncomeVsExpensesTable,
  isFieldVisible,
  type ChartDataItem,
  type IncomeVsExpensesSortField,
} from "@/components/reports/IncomeVsExpensesTable";

const ACCOUNTS_STORAGE_KEY = 'monize-reports-income-vs-expenses-accounts';
const INCLUDE_TRANSFERS_STORAGE_KEY = 'monize-reports-income-vs-expenses-stack-tagged';

// Same account list the dashboard's Income vs Expenses widget offers: an
// investment account's cash legs are excluded from the report by linkage.
const nonInvestmentAccounts = (a: Account) => a.accountType !== 'INVESTMENT';

interface IncomeVsExpensesTooltipProps {
  active?: boolean;
  payload?: Array<{
    name: string;
    value: number;
    color: string;
    payload: { fullName: string; SavingsRate: number };
  }>;
  label?: string;
  formatCurrency: (value: number) => string;
  formatPercent: (value: number, decimals: number) => string;
  t: ReturnType<typeof useTranslations<'reports'>>;
  /** The Balance view (spec 10.9) reads each bar's tagged flows and Balance. */
  balanceView: boolean;
}

function IncomeVsExpensesTooltip({
  active,
  payload,
  formatCurrency,
  formatPercent,
  t,
  balanceView,
}: IncomeVsExpensesTooltipProps) {
  const data = payload?.[0]?.payload;
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
      label={data?.fullName}
      payload={payload}
      formatValue={(v) => formatCurrency(v)}
    >
      {data && (
        <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">
          {t('incomeVsExpenses.savingsRateTooltip', { rate: data.SavingsRate })}
        </p>
      )}
    </ChartTooltip>
  );
}

export function IncomeVsExpensesReport() {
  const { exportCsvWithBasis, withPdfBasis } = useReportExportMetadata();
  const basis = useReportingBasis();
  const t = useTranslations('reports');
  const formatChartDate = useChartDateFormat();
  const router = useReportingRouter();
  const chartRef = useRef<HTMLDivElement>(null);
  const { formatCurrencyCompact: formatCurrency, formatCurrencyAxis, formatPercent, formatPercentTrimmed } =
    useNumberFormat();
  const { defaultCurrency } = useExchangeRates();
  const [viewType, setViewType] = useState<'bar' | 'table'>('bar');
  const tagKeys = useTagKeys();
  const [tagKey, setTagKey] = useState('');
  // Which tag-key bucket is selected. Owned here so the main chart can follow
  // the tab; TagKeyBreakdownBuckets is controlled by it.
  const [activeBucketValue, setActiveBucketValue] = useState('');
  const {
    dateRange,
    setDateRange,
    startDate,
    setStartDate,
    endDate,
    setEndDate,
    resolvedRange,
    isValid,
  } = useDateRange({ defaultRange: "1y", alignment: "month" });
  const { sortField, sortDirection, handleSort } = useSortableTable<IncomeVsExpensesSortField>(
    'reports.income-vs-expenses.table.sort',
    { field: 'name', direction: 'asc' },
  );

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
    () =>
      isValid
        ? builtInReportsApi.getIncomeVsExpenses({
            ...(basis ? { basis } : {}),
            startDate: rangeStart || undefined,
            endDate: rangeEnd,
            ...(selectedAccountIds.length > 0 ? { accountIds: selectedAccountIds } : {}),
            ...(breakdownKey ? { tagKey: breakdownKey } : {}),
            ...(breakdownKey && transferScope.accountIds
              ? { transferScopeAccountIds: transferScope.accountIds }
              : {}),
          })
        : Promise.resolve(null),
    [isValid, rangeStart, rangeEnd, breakdownKey, accountIdsKey, scopeKey, basis],
    { requestKey: JSON.stringify([isValid, rangeStart, rangeEnd, breakdownKey, accountIdsKey, scopeKey, basis]), maskStaleData: true },
  );

  // The bucket the breakdown card shows, and so the one whose tagged flows the
  // main chart draws; the untagged bucket has no flows, so it adds no series.
  const { activeBucket, flowBucket, flowsByPeriod } = useTaggedFlowBucket(
    response,
    activeBucketValue,
  );
  const showFlows = flowBucket !== undefined;
  // Opt-in, off by default: a user whose KEY:VALUE tags mean something else
  // would otherwise see the income and expense bars grow unasked, and Savings
  // replaced by a Balance they did not ask for. ON stacks the tagged flows on
  // the bars and shows Balance and Balance % in place of Savings and Savings
  // Rate (spec sections 10.7 and 10.9); income, expenses and net stay the
  // server's values either way (INV-REPORT-003).
  const [includeTransfersPref, setIncludeTransfersPref] = useLocalStorage<boolean>(
    INCLUDE_TRANSFERS_STORAGE_KEY,
    false,
  );
  const balanceView = showFlows && includeTransfersPref === true;
  const stackFlows = balanceView;

  // Map response to chart data. `name` must be unique across the dataset
  // (used as the XAxis category key); a non-unique value like "May" causes
  // Recharts to resolve the tooltip's payload to the first matching row,
  // showing data from the wrong year on multi-year ranges.
  const chartData = useMemo<ChartDataItem[]>(
    () =>
      (response?.data ?? []).map((item: IncomeExpensePeriodItem) => {
        const savings = item.income - item.expenses;
        const savingsRate =
          item.income > 0 ? Math.round((savings / item.income) * 100) : 0;
        // Flows ride beside the bars and never enter income, expenses or the
        // savings above (INV-REPORT-003). A period the bucket has no row for
        // had no tagged transfer in it, which is a known zero.
        const flows = flowsByPeriod.get(item.period);
        return {
          name: item.period,
          fullName: formatChartDate(parseISO(item.periodStart), "MMM yyyy"),
          Income: Math.round(item.income),
          Expenses: Math.round(item.expenses),
          Savings: Math.round(savings),
          SavingsRate: savingsRate,
          ...(balanceView ? periodBalanceFields(item, flows) : {}),
          ...(flowBucket
            ? {
                TaggedInflows: Math.round(flows ? flows.taggedInflows : 0),
                TaggedOutflows: Math.round(flows ? flows.taggedOutflows : 0),
              }
            : {}),
          // The dates the bar covers come from the server, which decided the
          // bucket; deriving them again here is a second definition of it.
          monthStart: item.periodStart,
          monthEnd: item.periodEnd,
        };
      }),
    [response, formatChartDate, flowBucket, flowsByPeriod, balanceView],
  );

  /**
   * The window's figures, and whether they are the whole story.
   *
   * The server withholds each total when a row could not be converted and sends
   * the part that did convert beside it, so what is shown is the subtotal and
   * the marker says so. Sharing one `ConvertedTotal` across all four keeps them
   * from disagreeing about their own completeness.
   */
  const totals = useMemo(() => {
    const totalIncome = response?.totals.knownIncome ?? 0;
    const totalExpenses = response?.totals.knownExpenses ?? 0;
    const totalSavings = totalIncome - totalExpenses;
    const savingsRate = totalIncome > 0 ? (totalSavings / totalIncome) * 100 : 0;
    return { totalIncome, totalExpenses, totalSavings, savingsRate };
  }, [response]);

  const completeness = useMemo(
    () => ({
      missingCurrencies: response?.missingCurrencies ?? [],
      excludedCount: response?.excludedCount ?? 0,
    }),
    [response],
  );
  // The window's Balance: a total only when the All totals are known and the
  // active bucket is complete; otherwise a subtotal that says so.
  const balanceWindow = useMemo(
    () =>
      balanceView && flowBucket && response
        ? taggedBalanceWindow(
            {
              income: totals.totalIncome,
              expenses: totals.totalExpenses,
              taggedInflows: flowBucket.taggedInflows,
              taggedOutflows: flowBucket.taggedOutflows,
            },
            response.totals.income !== null && response.totals.expenses !== null,
            completeness,
            flowBucket,
          )
        : undefined,
    [balanceView, flowBucket, response, totals, completeness],
  );
  const reportingCurrency = response?.currency ?? defaultCurrency;
  // The screen marks income, expenses and savings with `PartialTotal`; the PDF
  // writes the same three under a note, since a document has no hover.
  const { noteFor } = usePartialTotalNote();

  // A stored sort on a flow column falls back to the month when that column is
  // not on the screen.
  const columnMode = {
    showFlows,
    balanceView,
    showOutflows: balanceView && flowBucket !== undefined && flowBucket.taggedOutflows !== 0,
  };
  const effectiveSortField = isFieldVisible(sortField, columnMode) ? sortField : 'name';

  const sortedTableData = useMemo(() => {
    const sorted = [...chartData];
    sorted.sort((a, b) => {
      let comparison = 0;
      switch (effectiveSortField) {
        case 'name':
          comparison = compareValues(a.name, b.name);
          break;
        case 'income':
          comparison = compareValues(a.Income, b.Income);
          break;
        case 'expenses':
          comparison = compareValues(a.Expenses, b.Expenses);
          break;
        case 'savings':
          comparison = compareValues(a.Savings, b.Savings);
          break;
        case 'savingsRate':
          comparison = compareValues(a.SavingsRate, b.SavingsRate);
          break;
        case 'balance':
          comparison = compareValues(a.Balance, b.Balance);
          break;
        case 'balancePercent':
          comparison = compareValues(a.BalancePercent, b.BalancePercent);
          break;
        case 'taggedInflows':
          comparison = compareValues(a.TaggedInflows, b.TaggedInflows);
          break;
        case 'taggedOutflows':
          comparison = compareValues(a.TaggedOutflows, b.TaggedOutflows);
          break;
      }
      return sortDirection === 'asc' ? comparison : -comparison;
    });
    return sorted;
  }, [chartData, effectiveSortField, sortDirection]);


  // The row's primary action, named once so the pointer and the keyboard cannot
  // come to run two slightly different pushes.
  const openMonth = (row: ChartDataItem) =>
    router.push(`/transactions?startDate=${row.monthStart}&endDate=${row.monthEnd}`);

  const handleExportPdf = async () => {
    const { exportToPdf } = await import("@/lib/pdf-export");
    const partialNote = noteFor({ value: totals.totalIncome, ...completeness });
    await exportToPdf(withPdfBasis({
      title: t('page.names.income-vs-expenses' as Parameters<typeof t>[0]),
      summaryCards: balanceWindow && flowBucket
        ? [
            { label: t('incomeVsExpenses.totalIncome'), value: formatCurrency(totals.totalIncome), color: "#16a34a" },
            { label: t('tagBreakdown.inflows'), value: formatCurrency(flowBucket.taggedInflows), color: "#4f46e5" },
            { label: t('incomeVsExpenses.totalExpenses'), value: formatCurrency(totals.totalExpenses), color: "#dc2626" },
            ...(flowBucket.taggedOutflows !== 0
              ? [{ label: t('tagBreakdown.outflows'), value: formatCurrency(flowBucket.taggedOutflows), color: "#4f46e5" }]
              : []),
            { label: t('tagBreakdown.balance'), value: `${formatCurrency(balanceWindow.balance ?? 0)}${balanceWindow.complete ? "" : "*"}`, color: (balanceWindow.balance ?? 0) >= 0 ? "#2563eb" : "#ea580c" },
            { label: t('tagBreakdown.balancePercent'), value: balanceWindow.balancePercent === null ? "\u2014" : formatPercent(balanceWindow.balancePercent, 2), color: (balanceWindow.balancePercent ?? 0) >= 0 ? "#9333ea" : "#ea580c" },
          ]
        : [
            { label: t('incomeVsExpenses.totalIncome'), value: formatCurrency(totals.totalIncome), color: "#16a34a", note: partialNote },
            { label: t('incomeVsExpenses.totalExpenses'), value: formatCurrency(totals.totalExpenses), color: "#dc2626", note: partialNote },
            { label: t('incomeVsExpenses.totalSavings'), value: formatCurrency(totals.totalSavings), color: totals.totalSavings >= 0 ? "#2563eb" : "#ea580c", note: partialNote },
            { label: t('incomeVsExpenses.savingsRate'), value: formatPercent(totals.savingsRate, 1), color: totals.savingsRate >= 0 ? "#9333ea" : "#ea580c" },
          ],
      chartContainer: chartRef.current,
      filename: "income-vs-expenses",
    }));
  };

  const handleExportCsv = () => {
    if (balanceView) {
      // Same columns, same order as the table: Income, Tagged inflows,
      // Expenses, Tagged outflows (only when there are some), Balance, Balance %.
      const withOutflows = columnMode.showOutflows;
      const headers = [
        t('incomeVsExpenses.colMonth'),
        t('incomeVsExpenses.colIncome'),
        t('tagBreakdown.inflows'),
        t('incomeVsExpenses.colExpenses'),
        ...(withOutflows ? [t('tagBreakdown.outflows')] : []),
        t('tagBreakdown.balance'),
        t('tagBreakdown.balancePercent'),
      ];
      const rows = sortedTableData.map((d) => [
        d.fullName,
        d.Income,
        d.TaggedInflows ?? null,
        d.Expenses,
        ...(withOutflows ? [d.TaggedOutflows ?? null] : []),
        d.Balance ?? null,
        d.BalancePercent == null ? null : formatPercentTrimmed(d.BalancePercent),
      ]);
      exportCsvWithBasis('income-vs-expenses', headers, rows);
      return;
    }
    const headers = [t('incomeVsExpenses.colMonth'), t('incomeVsExpenses.colIncome'), t('incomeVsExpenses.colExpenses'), t('incomeVsExpenses.colSavings'), t('incomeVsExpenses.colSavingsRate'), ...(showFlows ? [t('tagBreakdown.inflows'), t('tagBreakdown.outflows')] : [])];
    const rows = sortedTableData.map((d) => [
      d.fullName,
      d.Income,
      d.Expenses,
      d.Savings,
      `${formatPercentTrimmed(d.SavingsRate)}`,
      ...(showFlows ? [d.TaggedInflows ?? null, d.TaggedOutflows ?? null] : []),
    ]);
    exportCsvWithBasis('income-vs-expenses', headers, rows);
  };

  const barClickedRef = useRef(false);

  const handleBarClick = (categoryType: 'income' | 'expense') => (data: { payload?: { monthStart?: string; monthEnd?: string } }) => {
    barClickedRef.current = true;
    const monthStart = data.payload?.monthStart;
    const monthEnd = data.payload?.monthEnd;
    if (monthStart && monthEnd) {
      router.push(
        `/transactions?startDate=${monthStart}&endDate=${monthEnd}&categoryType=${categoryType}`,
      );
    }
  };

  const handleChartClick = (state: any) => {
    if (barClickedRef.current) {
      barClickedRef.current = false;
      return;
    }
    const label = state?.activeLabel;
    if (!label) return;
    const item = chartData.find((d) => d.name === label);
    if (item?.monthStart && item?.monthEnd) {
      router.push(
        `/transactions?startDate=${item.monthStart}&endDate=${item.monthEnd}`,
      );
    }
  };

  return (
    <div className="space-y-6">
      {/* Controls -- always rendered so focus inside DateInput survives reloads */}
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4">
        <div className="flex flex-wrap gap-4 items-center justify-between">
          <ReportAccountMultiSelect
            accounts={offeredAccounts}
            value={selectedAccountIds}
            onChange={setSelectedAccountIds}
            filter={nonInvestmentAccounts}
          />
          <DateRangeSelector
            ranges={["6m", "1y", "2y"]}
            value={dateRange}
            onChange={setDateRange}
            showCustom
            customStartDate={startDate}
            onCustomStartDateChange={setStartDate}
            customEndDate={endDate}
            onCustomEndDateChange={setEndDate}
          />
          <div className="flex items-center gap-4">
            <ChartViewToggle
              value={viewType}
              onChange={(v) => setViewType(v as 'bar' | 'table')}
              options={['bar', 'table']}
            />
            <TagKeyBreakdownSelect tagKeys={tagKeys} value={tagKey} onChange={setTagKey} />
            {showFlows && (
              <IncludeTaggedTransfersToggle checked={balanceView} onChange={setIncludeTransfersPref} />
            )}
          </div>
          <ReportToolbarActions
            onExportPdf={handleExportPdf}
            onExportCsv={handleExportCsv}
            disabled={isLoading || !!error || chartData.length === 0}
          />
        </div>
      </div>

      {/* Chart */}
      <div ref={chartRef} className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 px-2 py-4 sm:p-6">
        {isLoading ? (
          <div className="space-y-4">
            <Skeleton className="h-8 w-1/3" />
            <Skeleton className="h-96 w-full" />
          </div>
        ) : error ? (
          <ReportError onRetry={reload} />
        ) : chartData.length === 0 ? (
          <p className="text-gray-500 dark:text-gray-400 text-center py-8">
            {t('incomeVsExpenses.noData')}
          </p>
        ) : viewType === 'table' ? (
          <IncomeVsExpensesTable
            rows={sortedTableData}
            sortField={sortField}
            sortDirection={sortDirection}
            onSort={handleSort}
            totals={totals}
            completeness={completeness}
            reportingCurrency={reportingCurrency}
            flowBucket={flowBucket}
            balanceWindow={balanceWindow}
            onOpenMonth={openMonth}
          />
        ) : (
          <>
            <div className="h-96">
              <ResponsiveContainer width="100%" height="100%" minWidth={0}>
                <BarChart
                  data={chartData}
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
                  <Tooltip content={<IncomeVsExpensesTooltip formatCurrency={formatCurrency} formatPercent={formatPercent} t={t} balanceView={balanceView} />} />
                  <Legend />
                  <ReferenceLine y={0} stroke={chartColors.axis} />
                  <Bar
                    dataKey="Income"
                    name={t('incomeVsExpenses.seriesIncome')}
                    fill={chartColors.income}
                    {...flowBarStack(stackFlows, 'income', 'base')}
                    cursor="pointer"
                    onClick={handleBarClick('income')}
                  />
                  <Bar
                    dataKey="Expenses"
                    name={t('incomeVsExpenses.seriesExpenses')}
                    fill={chartColors.expense}
                    {...flowBarStack(stackFlows, 'expenses', 'base')}
                    cursor="pointer"
                    onClick={handleBarClick('expense')}
                  />
                  <Bar
                    dataKey={balanceView ? "Balance" : "Savings"}
                    name={balanceView ? t('tagBreakdown.balance') : t('incomeVsExpenses.seriesSavings')}
                    fill={chartColors.primary}
                    radius={[4, 4, 0, 0]}
                    cursor="pointer"
                  />
                  {/* The funding series: the active tag bucket's transfer flows,
                      drawn in the indigo pair the breakdown card uses so they
                      never read as income or expenses. Absent without a tag
                      key or on the untagged tab. */}
                  {flowBucket && (
                    <Bar
                      dataKey="TaggedInflows"
                      name={t('tagBreakdown.inflowsSeries', { value: flowBucket.value })}
                      fill={chartColors.inflow}
                      {...flowBarStack(stackFlows, 'income', 'tagged')}
                    />
                  )}
                  {flowBucket && (
                    <Bar
                      dataKey="TaggedOutflows"
                      name={t('tagBreakdown.outflowsSeries', { value: flowBucket.value })}
                      fill={chartColors.outflow}
                      {...flowBarStack(stackFlows, 'expenses', 'tagged')}
                    />
                  )}
                </BarChart>
              </ResponsiveContainer>
            </div>

            <IncomeVsExpensesSummaryCards
              totals={totals}
              completeness={completeness}
              reportingCurrency={reportingCurrency}
              balance={balanceWindow && flowBucket ? { bucket: flowBucket, window: balanceWindow } : undefined}
            />
          </>
        )}
      </div>

      {!isLoading && !error && response?.tagKey && response.buckets && (
        <TagKeyBreakdownBuckets
          tagKey={response.tagKey}
          buckets={response.buckets}
          reportingCurrency={reportingCurrency}
          idPrefix="income-vs-expenses-tag"
          activeValue={activeBucket?.value}
          onActiveValueChange={setActiveBucketValue}
        />
      )}
    </div>
  );
}
