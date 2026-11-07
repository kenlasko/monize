'use client';

import { useState, useMemo, useRef } from 'react';
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
  AreaChart,
  Area,
  ReferenceLine,
} from 'recharts';
import { accountsApi } from '@/lib/accounts';
import { loanRateChangesApi, supportsRateChanges } from '@/lib/loan-rate-changes';
import type { LoanRateChange } from '@/types/loan-rate-change';
import { Transaction } from '@/types/transaction';
import { generateLoanSchedule } from '@/lib/loan-schedule';
import {
  buildLoanProjectionInput,
  deriveLoanPaymentHistory,
  fetchAllAccountTransactions,
  fetchLoanInterestTransactions,
  historicalPaymentCount,
  resolveCurrentLoanTerms,
} from '@/lib/loan-history';
import {
  axisKeyFor,
  axisTickLabel,
  bucketFlowSeries,
  sampleStockSeries,
} from '@/lib/chart-sampling';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { useReportData } from '@/hooks/useReportData';
import { usePersistedAccountId } from '@/hooks/usePersistedAccountFilter';
import { ReportToolbarActions } from '@/components/reports/ReportToolbarActions';
import { ReportError } from '@/components/reports/ReportError';
import { chartColors } from '@/lib/chart-colors';
import { useChartDateFormat } from '@/hooks/useChartDateFormat';
import { useFinancialToday } from '@/hooks/useFinancialToday';
import { useTranslations } from 'next-intl';
import { useDateFormat } from '@/hooks/useDateFormat';
import { EmptyState } from '@/components/ui/EmptyState';
import { SEGMENTED_GROUP_CLASS, segmentClass } from '@/components/ui/segmented-control';
import { CHART_GRID_PROPS, CHART_TOOLTIP_CLASS } from '@/lib/chart-style';
import { ChartActiveDot } from '@/components/ui/ChartActiveDot';

interface PayoffScheduleItem {
  date: string;
  label: string;
  /**
   * What the category axis, the tooltip lookup and every ReferenceLine key on.
   *
   * Not the label: a month is no longer unique. A weekly, biweekly or
   * semi-monthly loan routinely has a real payment and a projected one in the
   * same calendar month, and that month is one row on each side of the
   * history/projection line -- two rows, one label. Recharts keys a category
   * axis on the datum's own value, so two rows sharing a label collapse onto
   * one category and the "Today" divider lands on whichever came first.
   * `axisKeyFor` prefixes the row's position; `axisTickLabel` prints the label
   * back, so the tick still reads "Aug 2026".
   */
  axisKey: string;
  balance: number;
  historicalBalance?: number;
  projectedBalance?: number;
  principalPaid: number;
  interestPaid: number;
  cumulativePrincipal: number;
  cumulativeInterest: number;
  isProjected: boolean;
}

/**
 * A payment before month aggregation: no axis identity yet, because a chart row
 * is what gets one and these are the events a chart row is built FROM.
 */
type SchedulePoint = Omit<PayoffScheduleItem, 'axisKey'>;

interface DebtPayoffTooltipProps {
  active?: boolean;
  payload?: Array<{ name: string; value: number; color: string; dataKey: string }>;
  label?: string;
  payoffSchedule: PayoffScheduleItem[];
  formatCurrency: (value: number) => string;
  t: ReturnType<typeof useTranslations<'reports'>>;
}

function DebtPayoffTooltip({ active, payload, label, payoffSchedule, formatCurrency, t }: DebtPayoffTooltipProps) {
  if (active && payload && payload.length) {
    // Check if this point is projected. `label` is the axis KEY recharts was
    // given, so the lookup is on that; the heading prints the month back.
    const chartData = payoffSchedule.find((item) => item.axisKey === label);
    const isProjected = chartData?.isProjected ?? false;
    // Deduplicate entries that overlap at the transition point
    const seen = new Set<string>();
    const deduped = payload.filter((entry) => {
      if (entry.value === undefined || entry.value === null) return false;
      const key = entry.name;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    return (
      <div className={CHART_TOOLTIP_CLASS}>
        <p className="font-medium text-gray-900 dark:text-gray-100 mb-1">
          {label === undefined ? '' : axisTickLabel(label)}{' '}
          {isProjected && <span className="text-xs text-blue-500 dark:text-blue-400">{t('debtPayoff.projected')}</span>}
        </p>
        {deduped.map((entry, index) => (
          <p key={index} className="text-sm" style={{ color: entry.color }}>
            {entry.name}: {formatCurrency(entry.value)}
          </p>
        ))}
      </div>
    );
  }
  return null;
}

const ACCOUNT_STORAGE_KEY = 'monize-reports-debt-payoff-timeline-account';

export function DebtPayoffTimelineReport() {
  const t = useTranslations('reports');
  const { formatDate } = useDateFormat();
  const formatChartDate = useChartDateFormat();
  const { formatCurrencyCompact: formatCurrency, formatCurrencyAxis, formatPercent, formatPercentTrimmed } = useNumberFormat();
  const chartRef = useRef<HTMLDivElement>(null);
  // Today-anchored (see `loan-projection-anchor.guard.test.ts`), but still the
  // USER's today: the payoff date this report draws per account is the one the
  // loan detail page prints, and two calendars would separate them by a period.
  const todayYmd = useFinancialToday();
  const [viewType, setViewType] = useState<'balance' | 'breakdown' | 'distribution'>('balance');

  const {
    data: accountsData,
    isLoading: accountsLoading,
    error: accountsError,
    reload: reloadAccounts,
  } = useReportData(
    () =>
      accountsApi.getAll(true).then((allAccounts) =>
        allAccounts.filter(
          (a) =>
            a.accountType === 'LOAN' ||
            a.accountType === 'MORTGAGE' ||
            a.accountType === 'LINE_OF_CREDIT',
        ),
      ),
    [],
  );

  const accounts = useMemo(() => accountsData ?? [], [accountsData]);

  // Persisted so the report reopens on the account the user last looked at.
  const [persistedAccountId, setSelectedAccountId] = usePersistedAccountId(
    ACCOUNT_STORAGE_KEY,
    accounts,
  );

  // Auto-select the first debt account until the user picks one. Derived during
  // render rather than via setState-in-effect.
  const selectedAccountId = persistedAccountId || accounts[0]?.id || '';
  const selectedAccount = accounts.find((a) => a.id === selectedAccountId);

  // Load transactions from the loan account, paginating through all pages
  // (API limit is 200 per page).
  const {
    data: transactionsData,
    dataKey: transactionsKey,
    isLoading: transactionsLoading,
    error: transactionsError,
    reload: reloadTransactions,
  } = useReportData(
    async () => {
      if (!selectedAccountId) return [] as Transaction[];
      return fetchAllAccountTransactions(selectedAccountId);
    },
    [selectedAccountId],
    { requestKey: selectedAccountId },
  );

  // Each payload carries the account it answers for. Without that, the one
  // render between a selection change and the effect that refetches draws the
  // previous loan's rows -- and for the rate history that means projecting one
  // loan's rate onto another. The sibling LoanAmortizationReport guards the same
  // way.
  const transactions = useMemo<Transaction[]>(
    () => (transactionsKey === selectedAccountId ? (transactionsData ?? []) : []),
    [transactionsData, transactionsKey, selectedAccountId],
  );

  // The loan's separately-booked interest expenses, so derived interest matches
  // the loan detail page (see #893). Folded into the combined isLoading/error/
  // reload below like the other loaders: an interest list that has not arrived
  // is indistinguishable from one that is genuinely empty, so the schedule must
  // not paint at zero interest and then snap to the booked figures -- and a
  // failed fetch must reach the error state rather than settle at that zero.
  const {
    data: interestData,
    dataKey: interestKey,
    isLoading: interestLoading,
    error: interestError,
    reload: reloadInterest,
  } = useReportData(
    async () => {
      const account = accounts.find((a) => a.id === selectedAccountId);
      if (!account) return [] as Transaction[];
      return fetchLoanInterestTransactions(account);
    },
    [selectedAccountId, accounts],
    { requestKey: selectedAccountId },
  );
  const interestTransactions = useMemo<Transaction[]>(
    () => (interestKey === selectedAccountId ? (interestData ?? []) : []),
    [interestData, interestKey, selectedAccountId],
  );

  // The recorded rate history. Load-bearing for the projection, not decoration:
  // recording a rate change never writes the account's own interestRate, so
  // without these rows this report projects at whatever stale scalar the account
  // still holds while the loan detail page projects at the real one -- the same
  // loan, two payoff dates. Folded into the shared error/retry state for the
  // same reason as the interest list: [] is a claim, not a neutral default.
  const {
    data: rateChangeData,
    dataKey: rateChangesKey,
    isLoading: rateChangesLoading,
    error: rateChangesError,
    reload: reloadRateChanges,
  } = useReportData(
    async () => {
      // A line of credit has no rate history and the endpoint answers 400 for
      // one, which would replace this whole report with its error state.
      const account = accounts.find((a) => a.id === selectedAccountId);
      if (!selectedAccountId || !supportsRateChanges(account)) {
        return [] as LoanRateChange[];
      }
      return loanRateChangesApi.getAll(selectedAccountId);
    },
    [selectedAccountId, accounts],
    { requestKey: selectedAccountId },
  );
  const rateChanges = useMemo<LoanRateChange[]>(
    () => (rateChangesKey === selectedAccountId ? (rateChangeData ?? []) : []),
    [rateChangeData, rateChangesKey, selectedAccountId],
  );

  const isLoading =
    accountsLoading || transactionsLoading || interestLoading || rateChangesLoading;
  const error = accountsError || transactionsError || interestError || rateChangesError;
  const reload = () => {
    reloadAccounts();
    reloadTransactions();
    reloadInterest();
    reloadRateChanges();
  };

  // One derivation for both readers below. Replaying the register twice per
  // render is not merely wasted work: the curve and the terms strip beside it
  // would be two independent answers, so a change to how history is derived
  // could move one and leave the other.
  const history = useMemo(
    () =>
      selectedAccount
        ? deriveLoanPaymentHistory(
            selectedAccount,
            transactions,
            rateChanges,
            interestTransactions,
            todayYmd,
          )
        : null,
    [selectedAccount, transactions, rateChanges, interestTransactions, todayYmd],
  );

  // The count of payments the borrower actually made. Derived from the payment
  // events themselves, never from a chart series: a month is not a payment (a
  // biweekly loan makes 26 a year), and a chart series has additionally been
  // reduced to fit an axis (issue #1244).
  const paymentsMade = history ? historicalPaymentCount(history) : 0;

  // Build payment timeline from actual transactions + projected future payments.
  //
  // Two series, deliberately separate: `payoffSchedule` holds every month the
  // loan has and is what any figure is read from, while `chartSchedule` is that
  // series reduced to fit the axis and is read by nothing but a chart. They were
  // one array, so every total and count downstream described the reduction.
  const { payoffSchedule, chartSchedule, projectionStartAxisKey, hasProjection, projectionPaidOff } = useMemo((): {
    /** Every month, historical and projected. The series figures come from. */
    payoffSchedule: PayoffScheduleItem[];
    /** `payoffSchedule` reduced to fit the axis. Rendering only. */
    chartSchedule: PayoffScheduleItem[];
    /** Whether a forward projection was produced at all. Read from the
     *  projection itself, never from whether monthly aggregation happened to
     *  leave an all-projected row: a loan paying off inside the month of its
     *  last real payment has a projection whose every row shares that month. */
    hasProjection: boolean;
    /** Whether the forward projection reached payoff, or stopped at the
     *  projection horizon. False also when there is no projection at all --
     *  the flag only ever gates a figure derived from one. */
    projectionPaidOff: boolean;
    /** The axis key of the first projected row -- what the "Today" divider is
     *  drawn at. An axis key, not a month: see `PayoffScheduleItem.axisKey`. */
    projectionStartAxisKey: string | null;
  } => {
    // Both guards: upstream's `projectionPaidOff` must be in every return, and
    // `history` is now a hoisted memo that is null until an account is selected.
    if (!selectedAccount || !history)
      return {
        payoffSchedule: [],
        chartSchedule: [],
        projectionStartAxisKey: null,
        hasProjection: false,
        projectionPaidOff: false,
      };

    // --- Historical payments from actual transactions ---
    const schedule: SchedulePoint[] = history.events.map((event) => ({
      date: event.date,
      label: formatChartDate(event.date, 'MMM yyyy'),
      balance: event.balance,
      principalPaid: event.principal,
      interestPaid: event.interest,
      cumulativePrincipal: event.cumulativePrincipal,
      cumulativeInterest: event.cumulativeInterest,
      isProjected: false,
    }));

    // --- Project future payments ---
    let projectionPaidOff = false;
    let hasProjection = false;
    // `rateChanges` is this branch's addition and is not optional decoration:
    // without it the projection runs at whatever stale scalar the account still
    // holds, so this report and the loan detail page gave the same loan two
    // different payoff dates.
    const projectionInput = buildLoanProjectionInput(
      selectedAccount,
      history,
      rateChanges,
      null,
      todayYmd,
    );
    if (projectionInput) {
      const projection = generateLoanSchedule({
        ...projectionInput,
        initialCumulativePrincipal: history.cumulativePrincipal,
        initialCumulativeInterest: history.cumulativeInterest,
      });
      // A projection that stopped at the horizon has no payoff and its running
      // interest is a subtotal, so the summary below cannot report either as a
      // lifetime figure (INV-LOAN-002).
      projectionPaidOff = projection.paidOff;
      // Asked of the projection, not of the aggregated series it feeds: the
      // rows are the fact, and whether any of them survives into a month of its
      // own is a question about buckets.
      hasProjection = projection.rows.length > 0;

      for (const row of projection.rows) {
        schedule.push({
          date: row.date,
          label: formatChartDate(row.date, 'MMM yyyy'),
          balance: row.balance,
          principalPaid: row.principal,
          interestPaid: row.interest,
          cumulativePrincipal: row.cumulativePrincipal,
          cumulativeInterest: row.cumulativeInterest,
          isProjected: true,
        });
      }
    }

    // --- Aggregate by month AND provenance (a chart granularity, never a count) ---
    // Every event in a month folds into one row: the flows sum, the stocks take
    // the month's last value. Nothing counts these rows -- two payments in one
    // month are one row here and two payments in `paymentsMade`.
    //
    // Which side of the history/projection line a row is on is part of the
    // GROUP'S IDENTITY, not a property computed from its members. A weekly,
    // biweekly or semi-monthly loan routinely has a real payment and a projected
    // one in the same calendar month -- an ordinary state, not malformed input.
    // Keyed on the month alone the two merged, and the merged row was called
    // historical whenever it held any historical entry: August's forecast
    // principal was drawn as measured history, the projection's end-of-month
    // balance was published as the historical one, and a loan that pays off
    // inside that month left no projected row at all, so the "Today" divider and
    // the Est. Payoff card both vanished. `bucketFlowSeries`'s boundary cannot
    // recover any of that -- by the time it runs the provenance is already gone.
    //
    // Groups are contiguous RUNS over a date-ordered series rather than a lookup
    // by key, so a future-dated posted payment landing among the projected rows
    // opens its own run instead of being folded back into a month it no longer
    // sits beside.
    const chronological = [...schedule].sort((a, b) =>
      a.date.slice(0, 10).localeCompare(b.date.slice(0, 10)),
    );
    const monthGroups: SchedulePoint[][] = [];
    let currentGroupKey: string | null = null;
    for (const item of chronological) {
      const key = `${item.isProjected ? 'projected' : 'historical'}\u0000${item.label}`;
      if (key !== currentGroupKey) {
        monthGroups.push([]);
        currentGroupKey = key;
      }
      monthGroups[monthGroups.length - 1].push(item);
    }
    const monthlySchedule: SchedulePoint[] = monthGroups.map((group) => {
      // Spread the month's LAST entry: `balance` and the cumulative totals are
      // end-of-month values, and `date` travels with them so every field on the
      // row describes the same moment. `isProjected` comes with it and is the
      // whole group's, since the group is keyed on it.
      const last = group[group.length - 1];
      return {
        ...last,
        principalPaid: group.reduce((sum, item) => sum + item.principalPaid, 0),
        interestPaid: group.reduce((sum, item) => sum + item.interestPaid, 0),
      };
    });

    // --- Post-process: set historicalBalance / projectedBalance for chart ---
    const firstProjectedIdx = monthlySchedule.findIndex((item) => item.isProjected);
    const lastHistoricalIdx =
      firstProjectedIdx === -1 ? monthlySchedule.length - 1 : firstProjectedIdx - 1;
    const decorated: PayoffScheduleItem[] = monthlySchedule.map((item, index) => ({
      ...item,
      // The month is no longer an identity now that it can appear on both sides
      // of the line, so the position supplies one. The tick still prints the
      // month (`axisTickLabel`).
      axisKey: axisKeyFor(index, item.label),
      historicalBalance: item.isProjected ? undefined : item.balance,
      // The last historical point also carries a projected value, so the two
      // areas meet instead of leaving a gap at the transition.
      projectedBalance:
        item.isProjected || (firstProjectedIdx > 0 && index === lastHistoricalIdx)
          ? item.balance
          : undefined,
    }));
    const startKey = firstProjectedIdx === -1 ? null : decorated[firstProjectedIdx].axisKey;

    // --- Reduce for rendering only ---
    // The two transition rows are kept whatever the stride: the "Today" line is
    // drawn at `projectionStartAxisKey` and the areas join on the row before it,
    // so sampling either away moves a semantic marker onto whichever month the
    // stride happened to retain -- on a 30-year mortgage, years off.
    const chartSchedule = sampleStockSeries(decorated, {
      keep: (_row, index) => index === firstProjectedIdx || index === lastHistoricalIdx,
    });

    return {
      payoffSchedule: decorated,
      chartSchedule,
      projectionStartAxisKey: startKey,
      hasProjection,
      projectionPaidOff,
    };
    // `history` replaces the raw `transactions`/`interestTransactions` deps: the
    // register is now replayed once in a hoisted memo that both this schedule and
    // the terms strip below read, so a change to how history is derived cannot
    // move one and leave the other. `rateChanges` is a dep because the projection
    // above is built from it.
  }, [selectedAccount, history, rateChanges, formatChartDate, todayYmd]);

  // The terms in effect, from the same history the curve is projected from.
  const currentTerms = useMemo(() => {
    if (!selectedAccount || !history) {
      return { annualRate: null, payment: null, paymentDate: null, finalPayment: null };
    }
    return resolveCurrentLoanTerms(
      selectedAccount,
      history,
      rateChanges,
      null,
      todayYmd,
    );
  }, [selectedAccount, history, rateChanges, todayYmd]);

  const summary = useMemo(() => {
    if (payoffSchedule.length === 0 || !selectedAccount) return null;
    // `payoffSchedule` here is the full monthly series, so the last row is the
    // loan's real last month rather than the last month sampling happened to
    // keep, and every cumulative figure below is the loan's own.
    const lastItem = payoffSchedule[payoffSchedule.length - 1];
    const currentBalance = Math.abs(selectedAccount.currentBalance);
    const totalPrincipalPaid = lastItem.cumulativePrincipal;
    // Use openingBalance if set, otherwise derive from principal paid + remaining balance
    const originalBalance = Math.abs(selectedAccount.openingBalance) || (totalPrincipalPaid + currentBalance);
    // A projected figure is only a payoff, or a lifetime interest total, when the
    // projection actually reached payoff. Truncated at the horizon, the last
    // row's date is 50 years out with a balance still owing and its cumulative
    // interest is a subtotal -- both unknown, not measured (INV-LOAN-002).
    const projectionComplete = hasProjection && projectionPaidOff;
    const projectedPayoffDate = projectionComplete ? lastItem.label : null;
    return {
      lastPaymentDate: lastItem.label,
      // Interest over the rows shown: a lifetime total only when the projection
      // completed, which is why the headline reads it through `hasLifetimeTotal`.
      totalInterest: lastItem.cumulativeInterest,
      hasLifetimeTotal: !hasProjection || projectionPaidOff,
      totalPrincipalPaid,
      originalBalance,
      currentBalance,
      percentPaid: originalBalance > 0 ? ((originalBalance - currentBalance) / originalBalance) * 100 : 0,
      hasProjection,
      projectedPayoffDate,
    };
  }, [payoffSchedule, selectedAccount, hasProjection, projectionPaidOff]);

  // The interest figure's caption has to match what the figure is: history alone,
  // a lifetime estimate, or -- when the projection stopped at the horizon -- the
  // interest across the rows shown, which is neither. Relabelling a partial
  // figure is the rule; leaving a total's caption over it is the defect.
  const interestLabel = (s: { hasProjection: boolean; hasLifetimeTotal: boolean }) =>
    !s.hasProjection
      ? t('debtPayoff.interestPaid')
      : s.hasLifetimeTotal
        ? t('debtPayoff.estTotalInterest')
        : t('debtPayoff.interestOverProjection');

  // Every month that moved money, unsampled.
  const distributionMonths = useMemo(
    () => payoffSchedule.filter((item) => item.principalPaid + item.interestPaid > 0),
    [payoffSchedule],
  );

  // Principal vs interest is a FLOW: each bar is what a period paid, so a bar
  // dropped to fit the axis deletes the months it stood for and the chart shows
  // a subset labelled as the whole. Contiguous months are summed into one bar
  // instead, so every month reaches the chart -- `bucketFlowSeries` is a no-op
  // while the series fits. A bucket never straddles the history/projection line:
  // one bar cannot honestly be half measured and half predicted.
  const distributionData = useMemo(
    () =>
      bucketFlowSeries(
        distributionMonths,
        (group, index) => {
          const principalPaid = group.reduce((sum, item) => sum + item.principalPaid, 0);
          const interestPaid = group.reduce((sum, item) => sum + item.interestPaid, 0);
          const total = principalPaid + interestPaid;
          const first = group[0];
          const last = group[group.length - 1];
          const label =
            group.length === 1
              ? first.label
              : t('debtPayoff.periodRange', { start: first.label, end: last.label });
          return {
            label,
            // Two buckets can share a label: the month a real payment and a
            // projected one both fall in is one bucket on each side of the
            // boundary. The bucket's position is what makes it addressable.
            axisKey: axisKeyFor(index, label),
            principalPercent: (principalPaid / total) * 100,
            interestPercent: (interestPaid / total) * 100,
            principalPaid,
            interestPaid,
            months: group.length,
            // The boundary below keeps a group on one side of the line, so the
            // first row speaks for the whole bar.
            isProjected: first.isProjected,
          };
        },
        { boundary: (item) => item.isProjected },
      ),
    [distributionMonths, t],
  );

  // The distribution chart's "Today" divider. It cannot reuse
  // `projectionStartAxisKey`: that addresses a row of the BALANCE series, and
  // these are different rows -- a bucket spans a range of months and carries a
  // position among the buckets. A ReferenceLine whose value matches no category
  // on its own axis is silently not drawn, exactly on the long loans bucketing
  // exists for. A bucket never straddles the boundary, so the first projected
  // bucket is the transition.
  const distributionProjectionStartAxisKey = useMemo(
    () => distributionData.find((bucket) => bucket.isProjected)?.axisKey ?? null,
    [distributionData],
  );

  const handleExportPdf = async () => {
    const { exportToPdf } = await import('@/lib/pdf-export');
    // The table's fifth column held the installment amount under a "Payments
    // Made" heading, and its first two columns shared one heading -- so the
    // export named neither the account nor the count it claimed to carry.
    const headers = [
      t('debtPayoff.colAccount'),
      t('debtPayoff.colAccountType'),
      t('debtPayoff.currentBalance'),
      t('debtPayoff.colInterestRate'),
      t('debtPayoff.colPayment'),
      t('debtPayoff.colPaymentsMade'),
    ];
    const rows = selectedAccount ? [[
      selectedAccount.name,
      selectedAccount.accountType === 'LINE_OF_CREDIT'
        ? t('accountBalances.accountTypes.LINE_OF_CREDIT' as Parameters<typeof t>[0])
        : selectedAccount.accountType.charAt(0) + selectedAccount.accountType.slice(1).toLowerCase(),
      formatCurrency(Math.abs(selectedAccount.currentBalance)),
      currentTerms.annualRate != null
        ? `${formatPercentTrimmed(currentTerms.annualRate)}`
        : t('debtPayoff.notSet'),
      // A LINEAR or INTEREST_ONLY installment is dated: it is the next one,
      // and an interest-only mortgage's bullet travels with it.
      currentTerms.payment && currentTerms.paymentDate
        ? currentTerms.finalPayment
          ? t('debtPayoff.installmentAndFinal', {
              installment: t('loanAmortization.amountDueOn', {
                amount: formatCurrency(currentTerms.payment),
                date: formatDate(currentTerms.paymentDate),
              }),
              final: t('loanAmortization.amountDueOn', {
                amount: formatCurrency(currentTerms.finalPayment.amount),
                date: formatDate(currentTerms.finalPayment.date),
              }),
            })
          : t('loanAmortization.amountDueOn', {
              amount: formatCurrency(currentTerms.payment),
              date: formatDate(currentTerms.paymentDate),
            })
        : currentTerms.payment
          ? formatCurrency(currentTerms.payment)
          : t('debtPayoff.notSet'),
      String(paymentsMade),
    ]] : [];
    await exportToPdf({
      title: t('page.names.debt-payoff-timeline' as Parameters<typeof t>[0]),
      summaryCards: summary ? [
        { label: t('debtPayoff.currentBalance'), value: formatCurrency(summary.currentBalance), color: '#dc2626' },
        { label: t('debtPayoff.principalPaid'), value: formatCurrency(summary.totalPrincipalPaid), color: '#16a34a' },
        { label: interestLabel(summary), value: formatCurrency(summary.totalInterest), color: '#ea580c' },
        { label: t('debtPayoff.progress'), value: formatPercent(summary.percentPaid, 1), color: '#2563eb' },
      ] : undefined,
      chartContainer: chartRef.current,
      tableData: { headers, rows },
      filename: 'debt-payoff-timeline',
    });
  };

  if (error) {
    return <ReportError onRetry={reload} />;
  }

  if (isLoading) {
    return (
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-6">
        <div className="space-y-4">
          <Skeleton className="h-8 w-1/3" />
          <Skeleton className="h-64 w-full" />
        </div>
      </div>
    );
  }

  if (accounts.length === 0) {
    return (
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-6">
        <EmptyState title={t('debtPayoff.empty')} />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Controls */}
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4">
        <div className="flex flex-wrap gap-4 items-center justify-between">
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              {t('debtPayoff.labelSelectAccount')}
            </label>
            <select
              value={selectedAccountId}
              onChange={(e) => setSelectedAccountId(e.target.value)}
              className="rounded-md border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 min-w-[200px]"
            >
              {accounts
                .slice()
                .sort((a, b) => a.name.localeCompare(b.name))
                .map((account) => (
                  <option key={account.id} value={account.id}>
                    {account.name}
                  </option>
                ))}
            </select>
          </div>
          <div
            className={`${SEGMENTED_GROUP_CLASS} flex-wrap`}
            role="group"
            aria-label={t('reportPage.viewLabel')}
          >
            <button
              type="button"
              onClick={() => setViewType('balance')}
              aria-pressed={viewType === 'balance'}
              className={segmentClass(viewType === 'balance')}
            >
              {t('debtPayoff.balanceOverTime')}
            </button>
            <button
              type="button"
              onClick={() => setViewType('breakdown')}
              aria-pressed={viewType === 'breakdown'}
              className={segmentClass(viewType === 'breakdown')}
            >
              {t('debtPayoff.paymentBreakdown')}
            </button>
            <button
              type="button"
              onClick={() => setViewType('distribution')}
              aria-pressed={viewType === 'distribution'}
              className={segmentClass(viewType === 'distribution')}
            >
              {t('debtPayoff.viewPrincipalVsInterest')}
            </button>
          </div>
          <ReportToolbarActions onExportPdf={handleExportPdf} />
        </div>
      </div>

      {/* Summary Cards */}
      {summary && (
        // The fifth column exists only when the fifth card does. Sizing on
        // `hasProjection` while the card also requires a payoff date left a
        // blank column for a projection truncated at the horizon.
        <div
          className={`grid grid-cols-2 ${
            summary.projectedPayoffDate ? 'md:grid-cols-5' : 'md:grid-cols-4'
          } gap-4`}
        >
          <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4">
            <div className="text-sm text-gray-500 dark:text-gray-400">{t('debtPayoff.currentBalance')}</div>
            <div className="text-xl font-bold text-red-600 dark:text-red-400">
              {formatCurrency(summary.currentBalance)}
            </div>
          </div>
          <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4">
            <div className="text-sm text-gray-500 dark:text-gray-400">{t('debtPayoff.principalPaid')}</div>
            <div className="text-xl font-bold text-green-600 dark:text-green-400">
              {formatCurrency(summary.totalPrincipalPaid)}
            </div>
          </div>
          <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4">
            <div className="text-sm text-gray-500 dark:text-gray-400">
              {interestLabel(summary)}
            </div>
            <div className="text-xl font-bold text-orange-600 dark:text-orange-400">
              {formatCurrency(summary.totalInterest)}
            </div>
          </div>
          <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4">
            <div className="text-sm text-gray-500 dark:text-gray-400">{t('debtPayoff.progress')}</div>
            <div className="text-xl font-bold text-blue-600 dark:text-blue-400">
              {formatPercent(summary.percentPaid, 1)}
            </div>
          </div>
          {summary.projectedPayoffDate && (
            <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4">
              <div className="text-sm text-gray-500 dark:text-gray-400">{t('debtPayoff.estPayoff')}</div>
              <div className="text-xl font-bold text-purple-600 dark:text-purple-400">
                {summary.projectedPayoffDate}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Chart */}
      <div ref={chartRef} className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 px-2 py-4 sm:p-6">
        {payoffSchedule.length === 0 ? (
          <EmptyState title={t('debtPayoff.noPaymentHistory')} />
        ) : (
          <>
            {viewType === 'balance' && (
              <div className="h-80">
                <ResponsiveContainer width="100%" height="100%" minWidth={0}>
                  <AreaChart data={chartSchedule}>
                    <CartesianGrid {...CHART_GRID_PROPS} />
                    <XAxis
                      dataKey="axisKey"
                      tickFormatter={axisTickLabel}
                      tick={{ fontSize: 11 }}
                      interval="preserveStartEnd"
                    />
                    <YAxis
                      tickFormatter={formatCurrencyAxis}
                      tick={{ fontSize: 12 }}
                    />
                    <Tooltip
                      content={
                        <DebtPayoffTooltip
                          payoffSchedule={payoffSchedule}
                          formatCurrency={formatCurrency}
                          t={t}
                        />
                      }
                    />
                    <Area
                      activeDot={ChartActiveDot}
                      type="monotone"
                      dataKey="historicalBalance"
                      stroke={chartColors.expense}
                      fill={chartColors.expense}
                      fillOpacity={0.3}
                      name={t('debtPayoff.seriesRemainingBalance')}
                      strokeWidth={2}
                      connectNulls={false}
                    />
                    {projectionStartAxisKey && (
                      <Area
                        activeDot={ChartActiveDot}
                        type="monotone"
                        dataKey="projectedBalance"
                        stroke={chartColors.primary}
                        fill={chartColors.primary}
                        name={t('debtPayoff.seriesProjectedBalance')}
                        strokeWidth={2}
                        strokeDasharray="6 3"
                        fillOpacity={0.15}
                        connectNulls={false}
                      />
                    )}
                    {projectionStartAxisKey && (
                      <ReferenceLine
                        x={projectionStartAxisKey}
                        stroke={chartColors.axis}
                        strokeDasharray="4 4"
                        strokeWidth={2}
                        label={{
                          value: t('debtPayoff.today'),
                          position: 'top',
                          fill: chartColors.axis,
                          fontSize: 12,
                          fontWeight: 600,
                        }}
                      />
                    )}
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            )}
            {viewType === 'breakdown' && (
              <div className="h-80">
                <ResponsiveContainer width="100%" height="100%" minWidth={0}>
                  <BarChart data={chartSchedule}>
                    <CartesianGrid {...CHART_GRID_PROPS} />
                    <XAxis
                      dataKey="axisKey"
                      tickFormatter={axisTickLabel}
                      tick={{ fontSize: 11 }}
                      interval="preserveStartEnd"
                    />
                    <YAxis
                      tickFormatter={formatCurrencyAxis}
                      tick={{ fontSize: 12 }}
                    />
                    <Tooltip
                      content={
                        <DebtPayoffTooltip
                          payoffSchedule={payoffSchedule}
                          formatCurrency={formatCurrency}
                          t={t}
                        />
                      }
                    />
                    <Legend />
                    <Bar
                      dataKey="cumulativePrincipal"
                      stackId="a"
                      fill={chartColors.income}
                      name={t('debtPayoff.seriesPrincipalPaid')}
                    />
                    <Bar
                      dataKey="cumulativeInterest"
                      stackId="a"
                      fill={chartColors.warning}
                      name={t('debtPayoff.seriesInterestPaid')}
                    />
                    {projectionStartAxisKey && (
                      <ReferenceLine
                        x={projectionStartAxisKey}
                        stroke={chartColors.axis}
                        strokeDasharray="4 4"
                        strokeWidth={2}
                        label={{
                          value: t('debtPayoff.today'),
                          position: 'top',
                          fill: chartColors.axis,
                          fontSize: 12,
                          fontWeight: 600,
                        }}
                      />
                    )}
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}
            {viewType === 'distribution' && (
              <div className="h-80">
                <ResponsiveContainer width="100%" height="100%" minWidth={0}>
                  <BarChart data={distributionData}>
                    <CartesianGrid {...CHART_GRID_PROPS} />
                    <XAxis
                      dataKey="axisKey"
                      tickFormatter={axisTickLabel}
                      tick={{ fontSize: 11 }}
                      interval="preserveStartEnd"
                    />
                    <YAxis
                      tickFormatter={(value: number) => `${formatPercentTrimmed(value)}`}
                      tick={{ fontSize: 12 }}
                      domain={[0, 100]}
                    />
                    <Tooltip
                      content={({ active, payload, label: tooltipLabel }) => {
                        if (active && payload && payload.length) {
                          const data = distributionData.find((d) => d.axisKey === tooltipLabel);
                          return (
                            <div className={CHART_TOOLTIP_CLASS}>
                              <p className="font-medium text-gray-900 dark:text-gray-100 mb-1">
                                {data?.label ?? tooltipLabel}{' '}
                                {data?.isProjected && (
                                  <span className="text-xs text-blue-500 dark:text-blue-400">{t('debtPayoff.projected')}</span>
                                )}
                              </p>
                              <p className="text-sm text-green-600 dark:text-green-400">
                                {t('debtPayoff.seriesPrincipal')}: {data ? formatPercent(data.principalPercent, 1) : '—'} ({formatCurrency(data?.principalPaid ?? 0)})
                              </p>
                              <p className="text-sm text-orange-500 dark:text-orange-400">
                                {t('debtPayoff.seriesInterest')}: {data ? formatPercent(data.interestPercent, 1) : '—'} ({formatCurrency(data?.interestPaid ?? 0)})
                              </p>
                            </div>
                          );
                        }
                        return null;
                      }}
                    />
                    <Legend />
                    <Bar
                      dataKey="principalPercent"
                      stackId="a"
                      fill={chartColors.income}
                      name={t('debtPayoff.seriesPrincipal')}
                    />
                    <Bar
                      dataKey="interestPercent"
                      stackId="a"
                      fill={chartColors.warning}
                      name={t('debtPayoff.seriesInterest')}
                    />
                    {distributionProjectionStartAxisKey && (
                      <ReferenceLine
                        x={distributionProjectionStartAxisKey}
                        stroke={chartColors.axis}
                        strokeDasharray="4 4"
                        strokeWidth={2}
                        label={{
                          value: t('debtPayoff.today'),
                          position: 'top',
                          fill: chartColors.axis,
                          fontSize: 12,
                          fontWeight: 600,
                        }}
                      />
                    )}
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}
            {projectionStartAxisKey && (
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-2 text-center">
                {t('debtPayoff.projectionNote')}
              </p>
            )}
          </>
        )}
      </div>

      {/* Account Details */}
      {selectedAccount && (
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-6">
          <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">
            {t('debtPayoff.accountDetails')}
          </h3>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
            <div>
              <span className="text-gray-500 dark:text-gray-400">{t('debtPayoff.colAccountType')}</span>
              <p className="font-medium text-gray-900 dark:text-gray-100">
                {selectedAccount.accountType === 'LINE_OF_CREDIT'
                    ? t('accountBalances.accountTypes.LINE_OF_CREDIT' as Parameters<typeof t>[0])
                    : selectedAccount.accountType.charAt(0) + selectedAccount.accountType.slice(1).toLowerCase()}
              </p>
            </div>
            <div>
              <span className="text-gray-500 dark:text-gray-400">{t('debtPayoff.colOriginalAmount')}</span>
              <p className="font-medium text-gray-900 dark:text-gray-100">
                {formatCurrency(Math.abs(selectedAccount.openingBalance))}
              </p>
            </div>
            <div>
              <span className="text-gray-500 dark:text-gray-400">{t('debtPayoff.colInterestRate')}</span>
              <p className="font-medium text-gray-900 dark:text-gray-100">
                {currentTerms.annualRate != null
                  ? `${formatPercentTrimmed(currentTerms.annualRate)}`
                  : t('debtPayoff.notSet')}
              </p>
            </div>
            <div>
              <span className="text-gray-500 dark:text-gray-400">{t('debtPayoff.colPaymentsMade')}</span>
              <p className="font-medium text-gray-900 dark:text-gray-100">
                {paymentsMade}
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
