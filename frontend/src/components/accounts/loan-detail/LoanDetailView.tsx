'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
}: LoanDetailViewProps) {
  const t = useTranslations('accounts');
  const { formatCurrency } = useNumberFormat();
  const formatChartDate = useChartDateFormat();
  const [plan, setPlan] = useState<OverpaymentPlan | null>(null);
  const [loadedPlan, setLoadedPlan] = useState<OverpaymentPlan | null>(null);
  const [loadedPlanVersion, setLoadedPlanVersion] = useState(0);
  const rateEditing = useLoanRateEditing(account, onRateChangesChanged);
  const viewRef = useRef<HTMLDivElement>(null);

  // Rate History sits beside the simulator as a 30% sidebar, but a tall
  // simulator (many saved scenarios, the comparison chart open) leaves that
  // column mostly empty. When the panel fills less than half the simulator's
  // height it moves above the simulator at full width instead; hysteresis
  // between the two thresholds keeps it from flip-flopping at the boundary.
  const simulatorColRef = useRef<HTMLDivElement>(null);
  const rateColRef = useRef<HTMLDivElement>(null);
  const [rateStacked, setRateStacked] = useState(false);

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
        lumpSumCount: saved.lumpSums.length,
        interestSaved: scenarioComparison.interestSaved,
        payoffDate: scenarioSchedule.payoffDate,
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

  const hasSimulator = !!projectionInput;

  useEffect(() => {
    const sim = simulatorColRef.current;
    const rate = rateColRef.current;
    if (!sim || !rate || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      const simHeight = sim.offsetHeight;
      const rateHeight = rate.offsetHeight;
      if (simHeight <= 0) return;
      const fill = rateHeight / simHeight;
      setRateStacked((prev) => {
        if (!prev && fill < 0.5) return true;
        if (prev && fill > 0.58) return false;
        return prev;
      });
    });
    observer.observe(sim);
    observer.observe(rate);
    return () => observer.disconnect();
  }, [hasSimulator]);

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
      filename: sanitizeFilename(account.name, 'loan'),
    });
  };

  return (
    <div className="space-y-6" ref={viewRef}>
      <div className="flex justify-end">
        <ExportDropdown onExportPdf={handleExportPdf} />
      </div>

      <LoanSummaryCards
        account={account}
        startingBalance={history.startingBalance}
        currentInstallment={currentInstallment}
        baseline={baseline}
      />

      <PastImpactSection account={account} impact={impact} />

      {/* Active loan: simulator with the Rate History panel beside it (30%
          sidebar), or -- when the sidebar would sit more than half empty --
          stacked above the now full-width simulator. Both children stay
          mounted across the switch (only their flex order/width change), so
          the simulator keeps its form state. */}
      {projectionInput && (
        <div
          className={
            rateStacked
              ? 'flex flex-col gap-6'
              : 'flex flex-col lg:flex-row gap-6 lg:items-start'
          }
        >
          <div
            ref={simulatorColRef}
            className={rateStacked ? 'w-full order-2' : 'w-full lg:w-[70%]'}
          >
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
          <div
            ref={rateColRef}
            className={rateStacked ? 'w-full order-1' : 'w-full lg:w-[30%]'}
          >
            <RateHistorySidebar
              account={account}
              rateChanges={rateChanges}
              editing={rateEditing}
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
