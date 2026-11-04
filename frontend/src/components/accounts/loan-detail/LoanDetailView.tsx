'use client';

import {
  useCallback,
  useLayoutEffect,
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
import {
  PaymentMatchingPanel,
  type LoanSettlementsState,
} from '@/components/accounts/loan-detail/PaymentMatchingPanel';
import { ComparisonSummaryCards } from '@/components/accounts/loan-detail/ComparisonSummaryCards';
import { LoanFeesPanel } from '@/components/accounts/loan-detail/LoanFeesPanel';
import { SavedScenariosPanel } from '@/components/accounts/loan-detail/SavedScenariosPanel';
import {
  hasKnownInterestSaved,
  type ScenarioChartOutcome,
  type ScenarioOutcome,
} from '@/components/accounts/loan-detail/ScenarioComparisonChart';
import { createScenarioLabels } from '@/components/accounts/loan-detail/loan-scenario-labels';
import { sanitizeFilename } from '@/lib/export-filename';
import { buildScheduleDisplayRows, type DisplayRow } from '@/lib/loan-schedule-rows';
import type { CellValue, PdfTableSection } from '@/lib/pdf-export';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { useChartDateFormat } from '@/hooks/useChartDateFormat';
import { useDateFormat } from '@/hooks/useDateFormat';
import { useFinancialToday } from '@/hooks/useFinancialToday';
import { PastImpactSection } from '@/components/accounts/loan-detail/PastImpactSection';
import { useLoanRateEditing } from '@/components/accounts/loan-detail/useLoanRateEditing';
import {
  buildLoanProjectionInput,
  deriveLoanPaymentHistory,
  diagnoseLoanProjection,
  resolveCurrentLoanTerms,
} from '@/lib/loan-history';
import { SimulatorUnavailableNotice } from '@/components/accounts/loan-detail/SimulatorUnavailableNotice';
import { LoanNotAmortizingNotice } from '@/components/accounts/loan-detail/LoanNotAmortizingNotice';
import { loanNotAmortizingReason } from '@/lib/loan-figures';
import { computePastImpact } from '@/lib/loan-past-impact';
import {
  OverpaymentPlan,
  ScenarioComparison,
  compareSchedules,
  effectiveOverpaymentMode,
  generateLoanSchedule,
} from '@/lib/loan-schedule';
import { scenarioToPlan } from '@/lib/loan-scenarios';
import type { Account, MortgageType } from '@/types/account';
import type { LoanProjectionAnchor } from '@/types/scheduled-transaction';
import type { Transaction } from '@/types/transaction';
import type { LoanScenario } from '@/types/loan-scenario';
import type { LoanRateChange } from '@/types/loan-rate-change';

interface LoanDetailViewProps {
  account: Account;
  transactions: Transaction[];
  scenarios: LoanScenario[];
  rateChanges: LoanRateChange[];
  /**
   * The next scheduled installment's boundary (date + ledger debt through it),
   * from the server. This page's schedule table prints per-installment
   * interest, so it prices the same installment the amortization report does
   * and anchors on the same boundary -- INV-LOAN-006. Null when the loan has
   * no active scheduled payment, which keeps the today-anchored projection.
   */
  projectionAnchor?: LoanProjectionAnchor | null;
  /** Separate interest expenses (see fetchLoanInterestTransactions), for exact
   *  per-row interest including overpayments. */
  interestTransactions?: Transaction[];
  onScenariosChanged: () => void;
  onRateChangesChanged: () => void;
  /**
   * The loan's PDF export handler is published here for the container to
   * trigger -- the account detail header renders it beside View Transactions,
   * the overpayment simulator report in its account-selector card. This view
   * draws no export button of its own: a loose button above the summary cards
   * sat outside the card every other control was in, worst on a phone.
   */
  exportPdfRef: MutableRefObject<(() => Promise<void>) | null>;
  /**
   * Opens the container's account edit form with a detected mortgage type
   * preselected (the Rate History panel's "Detect mortgage type"). A container
   * without an edit form leaves it out, and the action is not offered.
   */
  onUseMortgageType?: (type: MortgageType) => void;
  /**
   * The Payment matching panel's data and reload, from a container that
   * loads the loan's settled installments with its history (the account
   * page). Absent, the panel is not rendered.
   */
  paymentMatching?: {
    settlements: LoanSettlementsState;
    onChanged: () => void | Promise<void>;
  };
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
  projectionAnchor = null,
  interestTransactions = [],
  onScenariosChanged,
  onRateChangesChanged,
  exportPdfRef,
  onUseMortgageType,
  paymentMatching,
}: LoanDetailViewProps) {
  const t = useTranslations('accounts');
  const { formatCurrency, formatPercentTrimmed } = useNumberFormat();
  const formatChartDate = useChartDateFormat();
  const { formatDate } = useDateFormat();
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

  // The user's calendar day -- what decides whether the anchor is still ahead
  // of them. The backend prices the same installment against its own
  // request-timezone `todayYMD()`, so reading UTC here would put the schedule
  // table and the bill on two different calendars. It also bounds the history:
  // a VOID or future-dated row has moved no balance yet (A26-M28).
  const todayYmd = useFinancialToday();

  // Overpayment recognition settings (category / memo / payee) now live in the
  // account edit form, so the `account` prop always carries the saved values.
  const history = useMemo(
    () =>
      deriveLoanPaymentHistory(
        account,
        transactions,
        rateChanges,
        interestTransactions,
        todayYmd,
      ),
    [account, transactions, rateChanges, interestTransactions, todayYmd],
  );

  // The borrower's real current installment (principal + interest) from the
  // payment history, shown on the summary card and used to seed the projection.
  // The stored paymentAmount is often principal-only for separately-booked
  // interest, so it is only a fallback when there is no usable history yet --
  // and the same resolution the projection is seeded with, so the card and the
  // payoff beside it cannot describe two different installments.
  const currentTerms = useMemo(
    () =>
      resolveCurrentLoanTerms(
        account,
        history,
        rateChanges,
        projectionAnchor,
        todayYmd,
      ),
    [account, history, rateChanges, projectionAnchor, todayYmd],
  );
  const currentInstallment = currentTerms.payment;

  const projectionInput = useMemo(
    () =>
      buildLoanProjectionInput(
        account,
        history,
        rateChanges,
        projectionAnchor,
        todayYmd,
      ),
    [account, history, rateChanges, projectionAnchor, todayYmd],
  );

  // When there is no projection, why -- so the simulator's absence is explained
  // rather than a blank space. Shares the projection gate's own evaluation, so
  // this reason and `projectionInput` cannot disagree about whether a schedule
  // exists.
  const projectionUnavailableReason = useMemo(
    () =>
      projectionInput
        ? null
        : diagnoseLoanProjection(
            account,
            history,
            rateChanges,
            projectionAnchor,
            todayYmd,
          ),
    [projectionInput, account, history, rateChanges, projectionAnchor, todayYmd],
  );

  const baseline = useMemo(
    () => (projectionInput ? generateLoanSchedule(projectionInput) : null),
    [projectionInput],
  );

  // The projection built but does not reach payoff (so the payoff date and
  // remaining interest are unknown). Why -- so the "unknown" on the cards is
  // explained rather than left as a dead end. Reads the same baseline the cards
  // do, so it never claims a reason the figures do not have.
  const notAmortizing = useMemo(
    () => loanNotAmortizingReason(projectionInput, baseline),
    [projectionInput, baseline],
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
  // Only scenarios with a known interest saving can be drawn (the arc's height
  // IS that saving), so the "more than one scenario" test counts drawable ones --
  // and the count left out travels to the panel, which says so rather than
  // letting rows or the whole toggle vanish unexplained.
  const { scenarioChartOutcomes, scenarioChartExcluded } = useMemo(() => {
    if (!baseline) {
      return { scenarioChartOutcomes: [] as ScenarioChartOutcome[], scenarioChartExcluded: 0 };
    }
    const drawable = scenarioOutcomes.filter(hasKnownInterestSaved);
    // Only report an exclusion when an unknown saving is actually why the chart
    // is short. With a single saved scenario the chart is hidden for the count,
    // and blaming an unknown saving would be the wrong reason.
    const excluded =
      scenarioOutcomes.length >= 2 ? scenarioOutcomes.length - drawable.length : 0;
    return {
      scenarioChartOutcomes: drawable.length < 2 ? [] : drawable,
      scenarioChartExcluded: excluded,
    };
  }, [scenarioOutcomes, baseline]);

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
      formatPercentTrimmed,
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
          // Dated for a method whose installment changes every due date, as
          // the card on the page is.
          label:
            currentInstallment != null && currentTerms.paymentDate != null
              ? t('loanDetail.summary.nextInstallmentDue', {
                  date: formatDate(currentTerms.paymentDate),
                })
              : t('loanDetail.summary.payment'),
          value:
            currentInstallment != null
              ? formatCurrency(currentInstallment, account.currencyCode)
              : t('loanDetail.summary.notSet'),
          color: '#2563eb',
        },
        ...(currentTerms.finalPayment
          ? [
              {
                label: t('loanDetail.summary.finalPaymentDue', {
                  date: formatDate(currentTerms.finalPayment.date),
                }),
                value: formatCurrency(currentTerms.finalPayment.amount, account.currencyCode),
                color: '#2563eb',
              },
            ]
          : []),
        {
          label: t('loanDetail.summary.interestRate'),
          value:
            currentTerms.annualRate != null
              ? formatPercentTrimmed(currentTerms.annualRate)
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

  // Published to the container so it can render the export button in its own
  // control row. Reassigned after every commit so the latest closure -- with
  // the current scenarios/schedule -- is always what fires on click.
  useLayoutEffect(() => {
    exportPdfRef.current = handleExportPdf;
  });

  // Beside the Rate History panel, wherever that sits. Keyed by the loan, so
  // a Process history result never outlives the loan it ran on.
  const paymentMatchingPanel = paymentMatching ? (
    <PaymentMatchingPanel
      key={account.id}
      account={account}
      settlements={paymentMatching.settlements}
      onChanged={paymentMatching.onChanged}
    />
  ) : null;
  // A mortgage's fees (docs/specs/mortgage-fees.md), beside the payment
  // matching panel: both describe what the scheduled payment collects.
  const loanFeesPanel =
    account.accountType === 'MORTGAGE' ? (
      <LoanFeesPanel key={`fees-${account.id}`} account={account} onChanged={paymentMatching?.onChanged} />
    ) : null;

  return (
    <div className="space-y-6" ref={viewRef}>
      <LoanSummaryCards
        account={account}
        startingBalance={history.startingBalance}
        currentInstallment={currentInstallment}
        currentInstallmentDate={currentTerms.paymentDate}
        finalPayment={currentTerms.finalPayment}
        currentAnnualRate={currentTerms.annualRate}
        baseline={baseline}
      />

      {notAmortizing && (
        <LoanNotAmortizingNotice
          reason={notAmortizing}
          currencyCode={account.currencyCode}
        />
      )}

      <PastImpactSection account={account} impact={impact} />

      {/* Active loan: the Rate History panel sits full-width above the
          Overpayment Simulator, never beside it. When the loan cannot be
          projected, the simulator's place shows why (the Rate History panel
          then moves full-width below the schedule, in the block near the end). */}
      {!projectionInput && projectionUnavailableReason && (
        <SimulatorUnavailableNotice reason={projectionUnavailableReason} />
      )}
      {projectionInput && (
        <div className="flex flex-col gap-6">
          <RateHistorySidebar
            account={account}
            rateChanges={rateChanges}
            editing={rateEditing}
            onUseMortgageType={onUseMortgageType}
          />
          {paymentMatchingPanel}
          {loanFeesPanel}
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
                          plan
                            ? {
                                amount: plan.recurringExtra?.amount ?? 0,
                                frequency: plan.recurringExtra?.frequency,
                                // The mode travels with the plan rather than
                                // being inferred from the installment drop,
                                // which is unknown on a truncated schedule --
                                // and it is read off the whole plan, because a
                                // budget or a lump sum carries its own. Keyed on
                                // `plan` rather than `plan.recurringExtra` for
                                // the same reason: a budget-only plan has no
                                // recurring extra and used to arrive with no
                                // mode at all.
                                mode: effectiveOverpaymentMode(plan) ?? undefined,
                              }
                            : undefined
                        }
                        loanFrequency={projectionInput?.frequency}
                        fixedMonthlyPayment={plan?.targetMonthlyPayment}
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
                    chartExcludedCount={scenarioChartExcluded}
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
        <>
          <RateHistorySidebar
            account={account}
            rateChanges={rateChanges}
            editing={rateEditing}
            onUseMortgageType={onUseMortgageType}
          />
          {paymentMatchingPanel}
          {loanFeesPanel}
        </>
      )}
    </div>
  );
}

interface LoanReportTableDeps {
  t(key: string, values?: Record<string, string | number>): string;
  formatCurrency(amount: number, currency?: string): string;
  // A rate is as user-facing in the PDF as it is on screen, and this builder is
  // a plain function, so the reader's formatter comes in as a dependency.
  formatPercentTrimmed(value: number): string;
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
  formatPercentTrimmed,
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
        formatPercentTrimmed(change.annualRate),
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
      row.annualRate != null ? formatPercentTrimmed(row.annualRate) : '—',
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
