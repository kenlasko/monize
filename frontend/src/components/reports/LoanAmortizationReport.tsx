'use client';

import { useState, useMemo, Fragment } from 'react';
import { Skeleton } from '@/components/ui/LoadingSkeleton';
import { format, parseISO } from 'date-fns';
import { accountsApi } from '@/lib/accounts';
import { loanRateChangesApi, supportsRateChanges } from '@/lib/loan-rate-changes';
import { scheduledTransactionsApi } from '@/lib/scheduled-transactions';
import type { LoanRateChange } from '@/types/loan-rate-change';
import type { LoanProjectionAnchor } from '@/types/scheduled-transaction';
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
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { useFinancialToday } from '@/hooks/useFinancialToday';
import { exportToCsv } from '@/lib/csv-export';
import { ReportToolbarActions } from '@/components/reports/ReportToolbarActions';
import { LabelSpacer } from '@/components/ui/LabelSpacer';
import { SortableHeader } from '@/components/ui/SortableHeader';
import { useSortableTable, compareValues } from '@/hooks/useSortableTable';
import { useReportData } from '@/hooks/useReportData';
import { usePersistedAccountId } from '@/hooks/usePersistedAccountFilter';
import { ReportError } from '@/components/reports/ReportError';
import { useTranslations } from 'next-intl';
import { useDateFormat } from '@/hooks/useDateFormat';
import { useChartDateFormat } from '@/hooks/useChartDateFormat';
import { EmptyState } from '@/components/ui/EmptyState';
import { AccountSelect } from '@/components/accounts/shared/AccountSelect';
import { accountSelectOption } from '@/lib/account-utils';
import { CARD_CLASS } from '@/components/ui/Card';


type AmortizationSortField = 'paymentNumber' | 'date' | 'payment' | 'principal' | 'interest' | 'balance';

interface PaymentRow {
  paymentNumber: number;
  date: string;
  payment: number;
  principal: number;
  interest: number;
  balance: number;
  isProjected: boolean;
}

const ACCOUNT_STORAGE_KEY = 'monize-reports-loan-amortization-account';

/** Stable empty lists, so "nothing loaded yet" is not a new dependency each render. */
const NO_TRANSACTIONS: Transaction[] = [];
const NO_RATE_CHANGES: LoanRateChange[] = [];

export function LoanAmortizationReport() {
  const t = useTranslations('reports');
  const { formatDate } = useDateFormat();
  const formatChartDate = useChartDateFormat();
  const { formatCurrency, formatPercentTrimmed } = useNumberFormat();

  const friendlyAccountType = (type: string): string => {
    switch (type) {
      case 'LINE_OF_CREDIT': return t('loanAmortization.typeLineOfCredit');
      case 'LOAN': return t('loanAmortization.typeLoan');
      case 'MORTGAGE': return t('loanAmortization.typeMortgage');
      default: return type.charAt(0) + type.slice(1).toLowerCase();
    }
  };
  const [showAllRows, setShowAllRows] = useState(false);
  const { sortField, sortDirection, handleSort } = useSortableTable<AmortizationSortField>(
    'reports.loan-amortization.sort',
    { field: 'paymentNumber', direction: 'asc' },
  );

  // Load all accounts and filter for loans.
  const { data: fetchedAccounts, isLoading, error, reload } = useReportData(
    () => accountsApi.getAll(true),
    [],
  );

  const accounts = useMemo(
    () =>
      (fetchedAccounts ?? []).filter(
        (a) => a.accountType === 'LOAN' || a.accountType === 'MORTGAGE' || a.accountType === 'LINE_OF_CREDIT',
      ),
    [fetchedAccounts],
  );

  // Persisted so the report reopens on the loan the user last looked at.
  const [selectedAccountId, setSelectedAccountId] = usePersistedAccountId(
    ACCOUNT_STORAGE_KEY,
    accounts,
  );

  // Default the selection to the first loan once accounts arrive and nothing
  // usable is persisted. Seeded during render (not in an effect) so the
  // transactions fetch carries it immediately.
  const [seededAccounts, setSeededAccounts] = useState(false);
  if (!seededAccounts && accounts.length > 0) {
    setSeededAccounts(true);
    if (!selectedAccountId) setSelectedAccountId(accounts[0].id);
  }

  const selectedAccount = accounts.find((a) => a.id === selectedAccountId);

  // Load the loan account's transactions plus its separately-booked interest
  // expenses, so the derived interest matches the loan detail page (see #893).
  //
  // Through `useReportData`, like every other loader on this surface and like
  // the Debt Payoff Timeline's own interest load. It was a bare effect whose
  // `catch` replaced BOTH arrays with `[]` and carried on -- so a failed history
  // load rendered as a loan with no payments and no booked interest, and the
  // derived rows took the analytic estimate. A failed lookup is not an empty
  // dataset; the report has an error-and-retry state and this now reaches it.
  const {
    data: historyData,
    dataKey: historyKey,
    isLoading: historyLoading,
    error: historyError,
    reload: reloadHistory,
  } = useReportData(
    async () => {
      if (!selectedAccountId) {
        return {
          transactions: [] as Transaction[],
          interest: [] as Transaction[],
          rateChanges: [] as LoanRateChange[],
          anchor: null as LoanProjectionAnchor | null,
        };
      }
      const account = accounts.find((a) => a.id === selectedAccountId);
      // The rate history rides in the same request key as the rest. It is not
      // decoration: recording a rate change never writes the account's own
      // interestRate, so projecting without these rows uses a stale scalar and
      // gives the same loan a different payoff date here than on its detail page.
      const [transactions, interest, rateChanges, anchor] = await Promise.all([
        fetchAllAccountTransactions(selectedAccountId),
        account ? fetchLoanInterestTransactions(account) : Promise.resolve([] as Transaction[]),
        // A line of credit is in this report's account list and the endpoint
        // answers 400 for one, which would replace the report with its error
        // state -- persisted, so it would stay broken across reloads with no
        // in-page way to pick another account.
        supportsRateChanges(account)
          ? loanRateChangesApi.getAll(selectedAccountId)
          : Promise.resolve([] as LoanRateChange[]),
        // The projection anchor is a prerequisite, not decoration, for the
        // same reason as the rate history: without it the schedule projects
        // from today's balance while the next bill prices the ledger through
        // its due date, and the two disagree for exactly the future-dated
        // principal payments issue #1253 is about. A failed fetch reaches the
        // report's error-and-retry state rather than degrading to "no anchor".
        scheduledTransactionsApi.getLoanProjectionAnchor(selectedAccountId),
      ]);
      return { transactions, interest, rateChanges, anchor };
    },
    [selectedAccountId, accounts],
    { requestKey: selectedAccountId },
  );

  // The payload and the request it answers travel together: until the held data
  // belongs to the loan on screen there is nothing to draw for this selection.
  // Without this, the one render between a selection change and the refetch drew
  // the previous loan's rows -- and for the rate history that means projecting
  // one loan's rate onto another.
  const historyForSelection = useMemo(
    () => (historyKey === selectedAccountId ? historyData : null),
    [historyData, historyKey, selectedAccountId],
  );
  const transactions = useMemo<Transaction[]>(
    () => historyForSelection?.transactions ?? NO_TRANSACTIONS,
    [historyForSelection],
  );
  const interestTransactions = useMemo<Transaction[]>(
    () => historyForSelection?.interest ?? NO_TRANSACTIONS,
    [historyForSelection],
  );
  const rateChanges = useMemo<LoanRateChange[]>(
    () => historyForSelection?.rateChanges ?? NO_RATE_CHANGES,
    [historyForSelection],
  );
  const projectionAnchor = useMemo<LoanProjectionAnchor | null>(
    () => historyForSelection?.anchor ?? null,
    [historyForSelection],
  );
  // The user's calendar day, which is what decides whether the anchor above is
  // still ahead of them -- the backend prices the same installment against its
  // own request-timezone `todayYMD()`, so a UTC reading here is a disagreement
  // about money for as long as the two calendars differ.
  const todayYmd = useFinancialToday();

  // One derivation, shared by the schedule and the terms shown above it. It was
  // computed twice per render, which is both wasted work over the whole ledger
  // and two chances for the two to disagree. `todayYmd` keeps VOID and
  // future-dated rows out of it (A26-M28).
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

  // Build payment history from actual transactions + projected future payments.
  // `projectionPaidOff` travels with the rows because the summary below cannot
  // tell a completed projection from one truncated at the horizon by looking at
  // them -- and only the first yields a payoff date or a lifetime interest total
  // (INV-LOAN-002).
  const { paymentHistory, projectionPaidOff } = useMemo((): {
    paymentHistory: PaymentRow[];
    projectionPaidOff: boolean;
  } => {
    if (!selectedAccount || !history)
      return { paymentHistory: [], projectionPaidOff: false };
    let projectionPaidOff = false;

    // --- Historical payments from the hoisted derivation above ---
    const payments: PaymentRow[] = history.events.map((event, index) => ({
      paymentNumber: index + 1,
      date: event.date,
      payment: event.principal + event.interest,
      principal: event.principal,
      interest: event.interest,
      balance: event.balance,
      isProjected: false,
    }));

    // --- Project future payments ---
    // Anchored on the next scheduled installment (date + ledger debt through
    // it) so the first projected row and the next bill price the same balance
    // (issue #1253); a loan with no scheduled payment projects from today.
    const projectionInput = buildLoanProjectionInput(
      selectedAccount,
      history,
      rateChanges,
      projectionAnchor,
      todayYmd,
    );
    if (projectionInput) {
      const projection = generateLoanSchedule(projectionInput);
      projectionPaidOff = projection.paidOff;

      for (const row of projection.rows) {
        payments.push({
          paymentNumber: history.events.length + row.paymentNumber,
          date: row.date,
          payment: row.payment,
          principal: row.principal,
          interest: row.interest,
          balance: row.balance,
          isProjected: true,
        });
      }
    }

    return { paymentHistory: payments, projectionPaidOff };
  }, [selectedAccount, history, rateChanges, projectionAnchor, todayYmd]);

  // The terms in effect, from the same history the schedule above is built from.
  // `selectedAccount.interestRate` / `.paymentAmount` are the scalars a
  // rate-change mutation deliberately never writes, so printing them put
  // "5% / $500" directly above a projection withheld because the real rate is 12%.
  const currentTerms = useMemo(
    () =>
      selectedAccount && history
        ? resolveCurrentLoanTerms(
            selectedAccount,
            history,
            rateChanges,
            projectionAnchor,
            todayYmd,
          )
        : { annualRate: null, payment: null, paymentDate: null, finalPayment: null },
    [selectedAccount, history, rateChanges, projectionAnchor, todayYmd],
  );

  // The shared derivation, so this report and the Debt Payoff Timeline cannot
  // give one loan two answers to "Payments Made". A no-op here -- this report
  // already lists one row per event -- and the point of moving it: the count
  // now comes from the events rather than from whatever the rows happen to be.
  const historicalCount = useMemo(
    () => (history ? historicalPaymentCount(history) : 0),
    [history],
  );
  const hasProjection = useMemo(() => paymentHistory.some((r) => r.isProjected), [paymentHistory]);

  const summary = useMemo(() => {
    if (paymentHistory.length === 0 || !selectedAccount || !history) return null;

    const totalInterest = paymentHistory.reduce((sum, row) => sum + row.interest, 0);
    const totalPrincipal = paymentHistory.reduce((sum, row) => sum + row.principal, 0);
    const totalPaymentAmount = paymentHistory.reduce((sum, row) => sum + row.payment, 0);
    const lastRow = paymentHistory[paymentHistory.length - 1];
    // The history's own figure, not `totalPrincipal + currentBalance`: that sum
    // includes the PROJECTED principal and counts the balance twice (A26-L25).
    const originalBalance =
      Math.abs(selectedAccount.openingBalance) || history.startingBalance;

    return {
      totalPayments: totalPaymentAmount,
      totalPrincipal,
      totalInterest,
      numberOfPayments: historicalCount,
      lastPaymentDate: lastRow.date,
      originalBalance,
      hasProjection,
      // Only a completed projection has a payoff date; truncated at the horizon
      // the last row is 50 years out with a balance still owing.
      projectedPayoffDate: hasProjection && projectionPaidOff ? lastRow.date : null,
      /** Whether `totalInterest` is the loan's lifetime interest rather than the
       *  interest over a projection that never reached payoff. */
      hasLifetimeTotal: !hasProjection || projectionPaidOff,
    };
  }, [paymentHistory, selectedAccount, history, historicalCount, hasProjection, projectionPaidOff]);

  // See DebtPayoffTimelineReport: the caption names what the figure is, and an
  // interest total over a projection that never paid off is not a lifetime one.
  const interestLabel = (
    s: { hasProjection: boolean; hasLifetimeTotal: boolean } | null,
  ) =>
    !s?.hasProjection
      ? t('loanAmortization.totalInterestPaid')
      : s.hasLifetimeTotal
        ? t('loanAmortization.estTotalInterest')
        : t('loanAmortization.interestOverProjection');

  const getExportData = (formatted: boolean) => {
    const headers = [t('loanAmortization.colNumber'), t('loanAmortization.colDate'), t('loanAmortization.colPayment'), t('loanAmortization.colPrincipal'), t('loanAmortization.colInterest'), t('loanAmortization.colBalance'), t('loanAmortization.colType')];
    const currency = selectedAccount?.currencyCode;
    const rows = paymentHistory.map((row) => [
      row.paymentNumber,
      format(parseISO(row.date), 'yyyy-MM-dd'),
      formatted ? formatCurrency(row.payment, currency) : row.payment,
      formatted ? formatCurrency(row.principal, currency) : row.principal,
      formatted ? formatCurrency(row.interest, currency) : row.interest,
      formatted ? formatCurrency(row.balance, currency) : row.balance,
      row.isProjected ? t('loanAmortization.typeProjected') : t('loanAmortization.typeActual'),
    ]);
    return { headers, rows };
  };

  const handleExportCsv = () => {
    const { headers, rows } = getExportData(false);
    const accountName = selectedAccount?.name?.replace(/[^a-zA-Z0-9]/g, '-') || 'loan';
    exportToCsv(`amortization-${accountName}`, headers, rows);
  };

  const handleExportPdf = async () => {
    const { exportToPdf } = await import('@/lib/pdf-export');
    const currency = selectedAccount?.currencyCode;
    const { headers, rows } = getExportData(true);
    const accountName = selectedAccount?.name?.replace(/[^a-zA-Z0-9]/g, '-') || 'loan';
    const cards = [];
    if (selectedAccount) {
      cards.push(
        { label: t('loanAmortization.currentBalance'), value: formatCurrency(Math.abs(selectedAccount.currentBalance), currency), color: '#dc2626' },
        { label: t('loanAmortization.originalAmount'), value: formatCurrency(summary?.originalBalance || Math.abs(selectedAccount.openingBalance), currency), color: '#111827' },
        { label: t('loanAmortization.interestRate'), value: currentTerms.annualRate != null ? `${formatPercentTrimmed(currentTerms.annualRate)}` : t('loanAmortization.notSet'), color: '#111827' },
        { label: interestLabel(summary), value: formatCurrency(summary?.totalInterest || 0, currency), color: '#ea580c' },
        { label: t('loanAmortization.paymentsMade'), value: String(historicalCount), color: '#16a34a' },
      );
      if (summary?.projectedPayoffDate) {
        cards.push({ label: t('loanAmortization.estPayoff'), value: formatChartDate(summary.projectedPayoffDate, 'MMM yyyy'), color: '#9333ea' });
      }
    }
    await exportToPdf({
      title: `${t('loanAmortization.pdfTitlePrefix')}${selectedAccount?.name || t('loanAmortization.typeLoan')}`,
      // Only a lifetime figure goes under the "total interest" wording; a
      // projection truncated at the horizon is RELABELLED, exactly as the card
      // beside it is, rather than dropped -- the PDF is the artifact the reader
      // keeps, and withholding the line took the payments-made count (which is
      // perfectly known) away with the interest figure, so the export and the
      // screen disagreed about what could be shown.
      subtitle: summary
        ? t(
            summary.hasLifetimeTotal
              ? 'loanAmortization.pdfSubtitlePaymentsSummary'
              : 'loanAmortization.pdfSubtitlePaymentsProjection',
            {
              count: historicalCount,
              interest: formatCurrency(summary.totalInterest, currency),
            },
          )
        : undefined,
      summaryCards: cards.length > 0 ? cards : undefined,
      tableData: { headers, rows },
      filename: `amortization-${accountName}`,
    });
  };

  const sortedPaymentHistory = useMemo(() => {
    const sorted = [...paymentHistory];
    sorted.sort((a, b) => {
      let comparison = 0;
      switch (sortField) {
        case 'paymentNumber':
          comparison = compareValues(a.paymentNumber, b.paymentNumber);
          break;
        case 'date':
          comparison = compareValues(a.date, b.date);
          break;
        case 'payment':
          comparison = compareValues(a.payment, b.payment);
          break;
        case 'principal':
          comparison = compareValues(a.principal, b.principal);
          break;
        case 'interest':
          comparison = compareValues(a.interest, b.interest);
          break;
        case 'balance':
          comparison = compareValues(a.balance, b.balance);
          break;
      }
      return sortDirection === 'asc' ? comparison : -comparison;
    });
    return sorted;
  }, [paymentHistory, sortField, sortDirection]);

  const displayedRows = showAllRows
    ? sortedPaymentHistory
    : sortedPaymentHistory.slice(0, 24);

  // Two error scopes, because they need different screens. Without the ACCOUNT
  // LIST there is no report at all, so that one replaces it. A failure loading
  // ONE loan's data must keep the picker on screen instead: the selection is
  // persisted, so replacing the whole report leaves that loan's error restored
  // on every visit with no way to choose another account -- which is exactly the
  // trap the line-of-credit 400 fell into. `historyError` is rendered inline
  // below, beneath the picker.
  if (error) {
    return (
      <ReportError
        onRetry={() => {
          reload();
          reloadHistory();
        }}
      />
    );
  }

  if (isLoading || historyLoading) {
    return (
      <div className={`${CARD_CLASS} p-6`}>
        <div className="space-y-4">
          <Skeleton className="h-8 w-1/3" />
          <Skeleton className="h-64 w-full" />
        </div>
      </div>
    );
  }

  if (accounts.length === 0) {
    return (
      <div className={`${CARD_CLASS} p-6`}>
        <EmptyState title={t('loanAmortization.empty')} />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Account Selector */}
      <div className={`${CARD_CLASS} p-4`}>
        <div className="flex flex-wrap gap-4 items-end">
          <div className="flex-1 min-w-[200px]">
            <AccountSelect
              label={t('loanAmortization.labelSelectLoan')}
              value={selectedAccountId}
              onChange={(e) => setSelectedAccountId(e.target.value)}
              options={accounts
                .slice()
                .sort((a, b) => a.name.localeCompare(b.name))
                .map((account) => accountSelectOption(account, account.name))}
            />
          </div>
          {/* The export stands beside a LABELLED field, so from `sm` up it is
              the height of the field, not of the field plus its label: reserve
              the label's own space above it and let the actions row stretch
              into what is left, rather than matching the select's padding with
              a figure that drifts the next time either control's type scale
              changes. Below `sm` the spacer collapses with the row. */}
          <div className="flex w-full flex-col sm:ml-auto sm:w-auto">
            {/* The reserved label space is the desktop's alone: on a phone the
                export is a row of its own and has no field beside it. */}
            <div className="hidden sm:block">
              <LabelSpacer />
            </div>
            <ReportToolbarActions
              onExportCsv={handleExportCsv}
              onExportPdf={handleExportPdf}
              // The schedule is drawn from the history, so an export while it is
              // loading or failed would write an empty one (A26-S15-08); a failed
              // load also keeps the previous loan's rows in the hook, figures that
              // are not this loan's.
              disabled={historyLoading || historyError != null}
              className="sm:flex-1"
            />
          </div>
        </div>
      </div>

      {/* A failure loading THIS loan's history keeps the picker above it usable,
          so the user can select a different account. */}
      {historyError && <ReportError onRetry={reloadHistory} />}

      {/* Summary Cards */}
      {!historyError && selectedAccount && (
        // The sixth column exists only when the sixth card does; sizing on
        // `hasProjection` alone left a blank column for a truncated projection.
        <div
          className={`grid grid-cols-2 ${
            summary?.projectedPayoffDate ? 'md:grid-cols-6' : 'md:grid-cols-5'
          } gap-4`}
        >
          <div className={`${CARD_CLASS} ui-rep-tile p-4`}>
            <div className="text-sm text-gray-500 dark:text-gray-400">{t('loanAmortization.currentBalance')}</div>
            <div className="text-lg font-bold text-red-600 dark:text-red-400">
              {formatCurrency(Math.abs(selectedAccount.currentBalance))}
            </div>
          </div>
          <div className={`${CARD_CLASS} ui-rep-tile p-4`}>
            <div className="text-sm text-gray-500 dark:text-gray-400">{t('loanAmortization.originalAmount')}</div>
            <div className="text-lg font-bold text-gray-900 dark:text-gray-100">
              {formatCurrency(summary?.originalBalance || Math.abs(selectedAccount.openingBalance))}
            </div>
          </div>
          <div className={`${CARD_CLASS} ui-rep-tile p-4`}>
            <div className="text-sm text-gray-500 dark:text-gray-400">{t('loanAmortization.interestRate')}</div>
            <div className="text-lg font-bold text-gray-900 dark:text-gray-100">
              {currentTerms.annualRate != null
                ? `${formatPercentTrimmed(currentTerms.annualRate)}`
                : t('loanAmortization.notSet')}
            </div>
          </div>
          <div className={`${CARD_CLASS} ui-rep-tile p-4`}>
            <div className="text-sm text-gray-500 dark:text-gray-400">
              {interestLabel(summary)}
            </div>
            <div className="text-lg font-bold text-orange-600 dark:text-orange-400">
              {formatCurrency(summary?.totalInterest || 0)}
            </div>
          </div>
          <div className={`${CARD_CLASS} ui-rep-tile p-4`}>
            <div className="text-sm text-gray-500 dark:text-gray-400">{t('loanAmortization.paymentsMade')}</div>
            <div className="text-lg font-bold text-green-600 dark:text-green-400">
              {historicalCount}
            </div>
          </div>
          {summary?.projectedPayoffDate && (
            <div className={`${CARD_CLASS} ui-rep-tile p-4`}>
              <div className="text-sm text-gray-500 dark:text-gray-400">{t('loanAmortization.estPayoff')}</div>
              <div className="text-lg font-bold text-purple-600 dark:text-purple-400">
                {formatChartDate(summary.projectedPayoffDate, 'MMM yyyy')}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Account Details */}
      {!historyError && selectedAccount && (
        <div className={`${CARD_CLASS} p-4`}>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
            <div>
              <span className="text-gray-500 dark:text-gray-400">{t('loanAmortization.accountType')}</span>
              <p className="font-medium text-gray-900 dark:text-gray-100">
                {friendlyAccountType(selectedAccount.accountType)}
              </p>
            </div>
            <div>
              <span className="text-gray-500 dark:text-gray-400">{t('loanAmortization.paymentFrequency')}</span>
              <p className="font-medium text-gray-900 dark:text-gray-100">
                {selectedAccount.paymentFrequency
                  ? selectedAccount.paymentFrequency.charAt(0) + selectedAccount.paymentFrequency.slice(1).toLowerCase().replace('_', '-')
                  : t('loanAmortization.notSet')}
              </p>
            </div>
            {/* A LINEAR or INTEREST_ONLY installment changes from one due
                date to the next: it is the next one, with its date, and an
                interest-only mortgage's bullet stands beside it. */}
            {currentTerms.payment && currentTerms.paymentDate ? (
              <div>
                <span className="text-gray-500 dark:text-gray-400">{t('loanAmortization.nextInstallment')}</span>
                <p className="font-medium text-gray-900 dark:text-gray-100">
                  {t('loanAmortization.amountDueOn', {
                    amount: formatCurrency(currentTerms.payment),
                    date: formatDate(currentTerms.paymentDate),
                  })}
                </p>
              </div>
            ) : (
              <div>
                <span className="text-gray-500 dark:text-gray-400">{t('loanAmortization.paymentAmount')}</span>
                <p className="font-medium text-gray-900 dark:text-gray-100">
                  {currentTerms.payment ? formatCurrency(currentTerms.payment) : t('loanAmortization.notSet')}
                </p>
              </div>
            )}
            {currentTerms.finalPayment && (
              <div>
                <span className="text-gray-500 dark:text-gray-400">{t('loanAmortization.finalPayment')}</span>
                <p className="font-medium text-gray-900 dark:text-gray-100">
                  {t('loanAmortization.amountDueOn', {
                    amount: formatCurrency(currentTerms.finalPayment.amount),
                    date: formatDate(currentTerms.finalPayment.date),
                  })}
                </p>
              </div>
            )}
            <div>
              <span className="text-gray-500 dark:text-gray-400">{t('loanAmortization.status')}</span>
              <p className="font-medium text-gray-900 dark:text-gray-100">
                {selectedAccount.isClosed ? t('loanAmortization.statusClosed') : t('loanAmortization.statusActive')}
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Payment History Table -- withheld while this loan's history failed to
          load, so an empty schedule is never mistaken for a loan that has made
          no payments. */}
      {!historyError && (
      <div className={`${CARD_CLASS} overflow-hidden`}>
        <div className="px-6 py-4 border-b border-gray-200 dark:border-gray-700">
          <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
            {hasProjection ? t('loanAmortization.paymentHistoryProjection') : t('loanAmortization.paymentHistory')}
          </h3>
          {summary && (
            <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
              {t('loanAmortization.paymentsMadeSummary', { count: historicalCount })}
              {hasProjection && ` ${t('loanAmortization.plusProjected', { count: paymentHistory.length - historicalCount })}`}
              {' '}{t('loanAmortization.totalingSuffix', { amount: formatCurrency(summary.totalPayments) })}
            </p>
          )}
        </div>

        {paymentHistory.length === 0 ? (
          <p className="px-6 py-8 text-gray-500 dark:text-gray-400 text-center">
            {t('loanAmortization.noPayments')}
          </p>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
                <thead className="bg-gray-50 dark:bg-gray-900/50">
                  <tr>
                    <SortableHeader<AmortizationSortField>
                      field="paymentNumber"
                      sortField={sortField}
                      sortDirection={sortDirection}
                      onSort={handleSort}
                      className="px-4 py-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider"
                    >
                      {t('loanAmortization.colNumber')}
                    </SortableHeader>
                    <SortableHeader<AmortizationSortField>
                      field="date"
                      sortField={sortField}
                      sortDirection={sortDirection}
                      onSort={handleSort}
                      className="px-4 py-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider"
                    >
                      {t('loanAmortization.colDate')}
                    </SortableHeader>
                    <SortableHeader<AmortizationSortField>
                      field="payment"
                      sortField={sortField}
                      sortDirection={sortDirection}
                      onSort={handleSort}
                      align="right"
                      className="px-4 py-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider"
                    >
                      {t('loanAmortization.colPayment')}
                    </SortableHeader>
                    <SortableHeader<AmortizationSortField>
                      field="principal"
                      sortField={sortField}
                      sortDirection={sortDirection}
                      onSort={handleSort}
                      align="right"
                      className="px-4 py-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider"
                    >
                      {t('loanAmortization.colPrincipal')}
                    </SortableHeader>
                    <SortableHeader<AmortizationSortField>
                      field="interest"
                      sortField={sortField}
                      sortDirection={sortDirection}
                      onSort={handleSort}
                      align="right"
                      className="px-4 py-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider"
                    >
                      {t('loanAmortization.colInterest')}
                    </SortableHeader>
                    <SortableHeader<AmortizationSortField>
                      field="balance"
                      sortField={sortField}
                      sortDirection={sortDirection}
                      onSort={handleSort}
                      align="right"
                      className="px-4 py-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider"
                    >
                      {t('loanAmortization.colBalance')}
                    </SortableHeader>
                  </tr>
                </thead>
                <tbody className="bg-white dark:bg-gray-800 divide-y divide-gray-200 dark:divide-gray-700">
                  {displayedRows.map((row, idx) => {
                    // Show a separator row when transitioning from historical to projected
                    const prevRow = idx > 0 ? displayedRows[idx - 1] : null;
                    const showSeparator = row.isProjected && prevRow && !prevRow.isProjected;
                    return (
                      <Fragment key={row.paymentNumber}>
                        {showSeparator && (
                          <tr className="bg-gray-100 dark:bg-gray-700">
                            <td colSpan={6} className="px-4 py-2 text-center text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                              {t('loanAmortization.projectedFuturePayments')}
                            </td>
                          </tr>
                        )}
                        <tr
                          className={`hover:bg-gray-50 dark:hover:bg-gray-700/50 ${
                            row.isProjected ? 'bg-blue-50/50 dark:bg-blue-900/10' : ''
                          }`}
                        >
                          <td className="px-4 py-3 whitespace-nowrap text-sm text-gray-500 dark:text-gray-400">
                            {row.paymentNumber}
                          </td>
                          <td className="px-4 py-3 whitespace-nowrap text-sm text-gray-900 dark:text-gray-100">
                            {formatDate(row.date)}
                            {row.isProjected && (
                              <span className="ml-1.5 text-xs text-blue-500 dark:text-blue-400">*</span>
                            )}
                          </td>
                          <td className="px-4 py-3 whitespace-nowrap text-sm text-right text-gray-900 dark:text-gray-100">
                            {formatCurrency(row.payment)}
                          </td>
                          <td className="px-4 py-3 whitespace-nowrap text-sm text-right text-green-600 dark:text-green-400">
                            {formatCurrency(row.principal)}
                          </td>
                          <td className="px-4 py-3 whitespace-nowrap text-sm text-right text-orange-600 dark:text-orange-400">
                            {formatCurrency(row.interest)}
                          </td>
                          <td className="px-4 py-3 whitespace-nowrap text-sm text-right font-medium text-gray-900 dark:text-gray-100">
                            {formatCurrency(row.balance)}
                          </td>
                        </tr>
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {paymentHistory.length > 24 && (
              <div className="px-6 py-4 border-t border-gray-200 dark:border-gray-700">
                <button
                  onClick={() => setShowAllRows(!showAllRows)}
                  className="text-blue-600 dark:text-blue-400 text-sm font-medium hover:underline"
                >
                  {showAllRows
                    ? t('loanAmortization.showLess')
                    : t('loanAmortization.showAll', { count: paymentHistory.length })}
                </button>
              </div>
            )}
          </>
        )}
      </div>
      )}
    </div>
  );
}
