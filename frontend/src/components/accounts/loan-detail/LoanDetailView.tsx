'use client';

import {
  useCallback,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
} from 'react';
import { useTranslations } from 'next-intl';
import { LoanSummaryCards } from '@/components/accounts/loan-detail/LoanSummaryCards';
import { AmortizationScheduleTable } from '@/components/accounts/loan-detail/AmortizationScheduleTable';
import { OverpaymentSimulator } from '@/components/accounts/loan-detail/OverpaymentSimulator';
import { PayoffComparisonChart } from '@/components/accounts/loan-detail/PayoffComparisonChart';
import { RateHistorySidebar } from '@/components/accounts/loan-detail/RateHistorySidebar';
import { ComparisonSummaryCards } from '@/components/accounts/loan-detail/ComparisonSummaryCards';
import { SavedScenariosPanel } from '@/components/accounts/loan-detail/SavedScenariosPanel';
import type { ScenarioOutcome } from '@/components/accounts/loan-detail/ScenarioComparisonChart';
import { createScenarioLabels } from '@/components/accounts/loan-detail/loan-scenario-labels';
import { ExportDropdown } from '@/components/ui/ExportDropdown';
import { sanitizeFilename } from '@/lib/export-filename';
import { buildScheduleDisplayRows, type DisplayRow } from '@/lib/loan-schedule-rows';
import type { CellValue, PdfTableSection } from '@/lib/pdf-export';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { useChartDateFormat } from '@/hooks/useChartDateFormat';
import { PastImpactSection } from '@/components/accounts/loan-detail/PastImpactSection';
import { useLoanRateEditing } from '@/components/accounts/loan-detail/useLoanRateEditing';
import {
  buildLoanProjectionInput,
  deriveCurrentInstallment,
  deriveLoanPaymentHistory,
} from '@/lib/loan-history';
import { computePastImpact } from '@/lib/loan-past-impact';
import {
  OverpaymentPlan,
  ScenarioComparison,
  compareSchedules,
  generateLoanSchedule,
} from '@/lib/loan-schedule';
import { scenarioToPlan } from '@/lib/loan-scenarios';
import type { Account } from '@/types/account';
import type { Transaction } from '@/types/transaction';
import type { LoanScenario } from '@/types/loan-scenario';
import type { LoanRateChange } from '@/types/loan-rate-change';

interface LoanDetailViewProps {
  account: Account;
  transactions: Transaction[];
  scenarios: LoanScenario[];
  rateChanges: LoanRateChange[];
  /** Separate interest expenses (see fetchLoanInterestTransactions), for exact
   *  per-row interest including overpayments. */
  interestTransactions?: Transaction[];
  onScenariosChanged: () => void;
  onRateChangesChanged: () => void;
  /**
   * When provided, the loan's PDF export handler is published here (so a parent
   * -- e.g. the account detail header -- can trigger it) and the inline export
   * button is not rendered. Left unset on the reports surface, which keeps the
   * inline button.
   */
  exportPdfRef?: MutableRefObject<(() => Promise<void>) | null>;
}

/**
 * The amortizing loan/mortgage detail body: key figures, the overpayment
 * simulator with saved scenarios, the baseline-vs-scenario comparison and
 * payoff chart, past-impact, and the installment schedule. Rendered by both
 * the /accounts/[id] route and the Loan Overpayment Simulator report, so it
 * owns only the simulation state and leaves data loading and page chrome to
 * its container.
 */
export function LoanDetailView({
  account,
  transactions,
  scenarios,
  rateChanges,
  interestTransactions = [],
  onScenariosChanged,
  onRateChangesChanged,
  exportPdfRef,
}: LoanDetailViewProps) {
  const t = useTranslations('accounts');
  const { formatCurrency } = useNumberFormat();
  const formatChartDate = useChartDateFormat();
  const [plan, setPlan] = useState<OverpaymentPlan | null>(null);
  const [loadedPlan, setLoadedPlan] = useState<OverpaymentPlan | null>(null);
  const [loadedPlanVersion, setLoadedPlanVersion] = useState(0);
  const rateEditing = useLoanRateEditing(account, onRateChangesChanged);
  const viewRef = useRef<HTMLDivElement>(null);

  const handleLoadScenario = useCallback((loaded: OverpaymentPlan | null) => {
    setPlan(loaded);
    setLoadedPlan(loaded);
    setLoadedPlanVersion((version) => version + 1);
  }, []);

  // Overpayment recognition settings (category / memo / payee) now live in the
  // account edit form, so the `account` prop always carries the saved values.
  const history = useMemo(
    () =>
      deriveLoanPaymentHistory(
        account,
        transactions,
        rateChanges,
        interestTransactions,
      ),
    [account, transactions, rateChanges, interestTransactions],
  );

  // The borrower's real current installment (principal + interest) from the
  // payment history, shown on the summary card and used to seed the projection.
  // The stored paymentAmount is often principal-only for separately-booked
  // interest, so it is only a fallback when there is no usable history yet.
  const currentInstallment = useMemo(() => {
    const derived = deriveCurrentInstallment(history, account.paymentAmount ?? 0);
    return derived > 0 ? derived : account.paymentAmount ?? null;
  }, [history, account.paymentAmount]);

  const projectionInput = useMemo(
    () => buildLoanProjectionInput(account, history, rateChanges),
    [account, history, rateChanges],
  );

  const baseline = useMemo(
    () => (projectionInput ? generateLoanSchedule(projectionInput) : null),
    [projectionInput],
  );

  const scenario = useMemo(
    () =>
      projectionInput && plan
        ? generateLoanSchedule({ ...projectionInput, overpayments: plan })
        : null,
    [projectionInput, plan],
  );

  const comparison = useMemo(
    () => (baseline && scenario ? compareSchedules(baseline, scenario) : null),
    [baseline, scenario],
  );

  // Each saved scenario's outcome vs the baseline, so the list can show a
  // comparison table without loading each one. Each scenario's overpayments
  // carry their own mode (shorten term / lower installment).
  const { scenarioComparisons, scenarioOutcomes } = useMemo(() => {
    const map = new Map<string, ScenarioComparison | null>();
    const outcomes: ScenarioOutcome[] = [];
    if (!projectionInput || !baseline) {
      return { scenarioComparisons: map, scenarioOutcomes: outcomes };
    }
    for (const saved of scenarios) {
      const scenarioSchedule = generateLoanSchedule({
        ...projectionInput,
        overpayments: scenarioToPlan(saved) ?? undefined,
      });
      const scenarioComparison = compareSchedules(baseline, scenarioSchedule);
      map.set(saved.id, scenarioComparison);
      outcomes.push({
        id: saved.id,
        name: saved.name,
        recurringExtra: saved.recurringExtraAmount,
        recurringFrequency: saved.recurringExtraFrequency ?? undefined,
        lumpSumCount: saved.lumpSums.length,
        interestSaved: scenarioComparison.interestSaved,
        payoffDate: scenarioSchedule.payoffDate,
        startDate: scenarioOverpaymentStart(saved),
      });
    }
    return { scenarioComparisons: map, scenarioOutcomes: outcomes };
  }, [scenarios, projectionInput, baseline]);

  // The comparison chart is only meaningful with more than one saved scenario;
  // the no-overpayment baseline renders as a context line, not a bar.
  const scenarioChartOutcomes = useMemo<ScenarioOutcome[]>(
    () => (scenarioOutcomes.length < 2 || !baseline ? [] : scenarioOutcomes),
    [scenarioOutcomes, baseline],
  );

  // Past impact of overpayments. It reuses the baseline (no-overpayment)
  // projection as the current projection -- computed once here, not twice --
  // and its original contractual schedule also feeds the payoff chart's
  // contractual curve, so the views stay consistent.
  const impact = useMemo(
    () => computePastImpact(account, history, baseline, rateChanges),
    [account, history, baseline, rateChanges],
  );

  // The whole loan page as a PDF report: headline cards, every chart
  // currently rendered on the page (payoff timeline + the scenario comparison
  // when its toggle is open) and the saved-scenarios comparison table.
  const handleExportPdf = async () => {
    const { exportToPdf } = await import('@/lib/pdf-export');
    const labels = createScenarioLabels({
      t,
      formatCurrency,
      formatChartDate,
      currencyCode: account.currencyCode,
    });
    const additionalTables = buildLoanReportTables({
      t,
      formatCurrency,
      formatChartDate,
      currencyCode: account.currencyCode,
      rateChanges,
      scheduleRows: buildScheduleDisplayRows(
        history.events,
        (scenario ?? baseline)?.rows ?? [],
        rateChanges,
      ),
    });
    await exportToPdf({
      title: account.name,
      summaryCards: [
        {
          label: t('loanDetail.summary.currentBalance'),
          value: formatCurrency(Math.abs(account.currentBalance), account.currencyCode),
          color: '#dc2626',
        },
        {
          label: t('loanDetail.summary.payment'),
          value:
            currentInstallment != null
              ? formatCurrency(currentInstallment, account.currencyCode)
              : t('loanDetail.summary.notSet'),
          color: '#2563eb',
        },
        {
          label: t('loanDetail.summary.interestRate'),
          value:
            account.interestRate != null
              ? `${account.interestRate}%`
              : t('loanDetail.summary.notSet'),
          color: '#ea580c',
        },
        ...(baseline?.payoffDate
          ? [
              {
                label: t('loanDetail.summary.estPayoff'),
                value: formatChartDate(baseline.payoffDate, 'MMM yyyy'),
                color: '#9333ea',
              },
            ]
          : []),
      ],
      chartContainer: viewRef.current,
      tableData:
        scenarios.length > 0
          ? labels.comparisonTable(scenarios, scenarioComparisons)
          : undefined,
      additionalTables,
      filename: sanitizeFilename(account.name, 'loan'),
    });
  };

  // Published to the parent (account header) so it can render the export button
  // on the same row as View Transactions; when set, the inline button below is
  // suppressed. Assigned during render (not in an effect) so the latest closure
  // -- with the current scenarios/schedule -- is always what fires on click.
  if (exportPdfRef) exportPdfRef.current = handleExportPdf;

  return (
    <div className="space-y-6" ref={viewRef}>
      {!exportPdfRef && (
        <div className="flex justify-end">
          <ExportDropdown onExportPdf={handleExportPdf} />
        </div>
      )}

      <LoanSummaryCards
        account={account}
        startingBalance={history.startingBalance}
        currentInstallment={currentInstallment}
        baseline={baseline}
      />

      <PastImpactSection account={account} impact={impact} />

      {/* Active loan: the Rate History panel sits full-width above the
          Overpayment Simulator, never beside it. */}
      {projectionInput && (
        <div className="flex flex-col gap-6">
          <RateHistorySidebar
            account={account}
            rateChanges={rateChanges}
            editing={rateEditing}
          />
          <div className="w-full">
            <OverpaymentSimulator
              accountId={account.id}
              currencyCode={account.currencyCode}
              onPlanChange={setPlan}
              loadedPlan={loadedPlan}
              loadedPlanVersion={loadedPlanVersion}
              projectionInput={projectionInput}
              footer={
                <>
                  {comparison && (
                    <div className="mt-6 pt-5 border-t border-gray-200 dark:border-gray-700">
                      <h4 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-3">
                        {t('loanDetail.comparison.title')}
                      </h4>
                      <ComparisonSummaryCards
                        comparison={comparison}
                        currencyCode={account.currencyCode}
                        recurringOverpayment={
                          plan?.recurringExtra
                            ? {
                                amount: plan.recurringExtra.amount,
                                frequency: plan.recurringExtra.frequency,
                              }
                            : undefined
                        }
                        loanFrequency={projectionInput?.frequency}
                      />
                    </div>
                  )}
                  <SavedScenariosPanel
                    accountId={account.id}
                    scenarios={scenarios}
                    comparisons={scenarioComparisons}
                    currencyCode={account.currencyCode}
                    activePlan={plan}
                    chartOutcomes={scenarioChartOutcomes}
                    chartBaseline={
                      baseline ? { payoffDate: baseline.payoffDate } : null
                    }
                    onLoad={handleLoadScenario}
                    onScenariosChanged={onScenariosChanged}
                  />
                </>
              }
            />
          </div>
        </div>
      )}

      <PayoffComparisonChart
        historyEvents={history.events}
        baseline={baseline}
        scenario={scenario}
        original={impact?.originalSchedule ?? null}
      />

      <AmortizationScheduleTable
        historyEvents={history.events}
        projectionRows={(scenario ?? baseline)?.rows ?? []}
        currencyCode={account.currencyCode}
        rateChanges={rateChanges}
        editing={rateEditing}
      />

      {/* Finished loan (no simulator): the Rate History panel goes full-width
          below the schedule. */}
      {!projectionInput && (
        <RateHistorySidebar
          account={account}
          rateChanges={rateChanges}
          editing={rateEditing}
        />
      )}
    </div>
  );
}

interface LoanReportTableDeps {
  t(key: string, values?: Record<string, string | number>): string;
  formatCurrency(amount: number, currency?: string): string;
  formatChartDate(date: string, format: 'MMM d, yyyy'): string;
  currencyCode: string;
  rateChanges: LoanRateChange[];
  scheduleRows: DisplayRow[];
}

/**
 * The rate-history timeline and the full per-payment schedule as PDF tables.
 * Both are rendered fully expanded -- every recorded rate change and every
 * payment on its own row -- regardless of what is collapsed on screen, so the
 * exported report is self-contained.
 */
function buildLoanReportTables({
  t,
  formatCurrency,
  formatChartDate,
  currencyCode,
  rateChanges,
  scheduleRows,
}: LoanReportTableDeps): PdfTableSection[] {
  const money = (amount: number) => formatCurrency(amount, currencyCode);
  const day = (date: string) => formatChartDate(date.split('T')[0], 'MMM d, yyyy');
  const tables: PdfTableSection[] = [];

  const sortedRates = [...rateChanges].sort((a, b) =>
    a.effectiveDate.localeCompare(b.effectiveDate),
  );
  if (sortedRates.length > 0) {
    const sourceLabel = (change: LoanRateChange) => {
      if (change.source === 'inferred') return t('loanDetail.rateHistory.badgeInferred');
      if (change.source === 'initial') return t('loanDetail.rateHistory.badgeInitial');
      return t('loanDetail.rateHistory.sourceManual');
    };
    tables.push({
      title: t('loanDetail.rateHistory.title'),
      headers: [
        t('loanDetail.rateHistory.colDate'),
        t('loanDetail.rateHistory.colRate'),
        t('loanDetail.rateHistory.colSource'),
        t('loanDetail.rateHistory.colPayment'),
        t('loanDetail.rateHistory.colNote'),
      ],
      rows: sortedRates.map((change) => [
        day(change.effectiveDate),
        `${change.annualRate}%`,
        sourceLabel(change),
        change.newPaymentAmount != null
          ? money(change.newPaymentAmount)
          : t('loanDetail.rateHistory.paymentUnchanged'),
        change.note ?? '',
      ]),
    });
  }

  if (scheduleRows.length > 0) {
    const showExtra = scheduleRows.some((row) => row.extraPrincipal > 0);
    const sum = (field: 'payment' | 'interest' | 'principal' | 'extraPrincipal') =>
      scheduleRows.reduce((acc, row) => acc + Math.round(Number(row[field]) * 10000), 0) / 10000;
    const rows: CellValue[][] = scheduleRows.map((row) => [
      row.paymentNumber,
      day(row.date),
      row.isProjected
        ? t('loanDetail.schedule.typeProjected')
        : t('loanDetail.schedule.typeHistorical'),
      money(row.payment),
      money(row.interest),
      money(row.principal),
      ...(showExtra ? [row.extraPrincipal > 0 ? money(row.extraPrincipal) : '—'] : []),
      row.annualRate != null ? `${row.annualRate}%` : '—',
      money(row.balance),
    ]);
    const totalRow: (string | number)[] = [
      t('loanDetail.schedule.total'),
      '',
      '',
      money(sum('payment')),
      money(sum('interest')),
      money(sum('principal')),
      ...(showExtra ? [money(sum('extraPrincipal'))] : []),
      '',
      '',
    ];
    tables.push({
      title: t('loanDetail.schedule.title'),
      headers: [
        t('loanDetail.schedule.colNumber'),
        t('loanDetail.schedule.colDate'),
        t('loanDetail.schedule.colType'),
        t('loanDetail.schedule.colPayment'),
        t('loanDetail.schedule.colInterest'),
        t('loanDetail.schedule.colPrincipal'),
        ...(showExtra ? [t('loanDetail.schedule.colExtra')] : []),
        t('loanDetail.schedule.colRate'),
        t('loanDetail.schedule.colBalance'),
      ],
      rows,
      totalRow,
    });
  }

  return tables;
}

/**
 * The date a saved scenario's overpayments first apply -- the earliest of a
 * recurring extra's start date and any lump-sum dates. Undefined when a
 * recurring extra runs from origination (it applies from today), so the
 * comparison chart's arc simply starts at today.
 */
function scenarioOverpaymentStart(scenario: LoanScenario): string | undefined {
  const hasRecurring = !!scenario.recurringExtraAmount && scenario.recurringExtraAmount > 0;
  // A recurring extra without a start date is active from today.
  if (hasRecurring && !scenario.recurringExtraStartDate) return undefined;
  const dates: string[] = [];
  if (hasRecurring && scenario.recurringExtraStartDate) {
    dates.push(scenario.recurringExtraStartDate);
  }
  for (const lump of scenario.lumpSums) dates.push(lump.date);
  return dates.length ? dates.reduce((a, b) => (a < b ? a : b)) : undefined;
}
