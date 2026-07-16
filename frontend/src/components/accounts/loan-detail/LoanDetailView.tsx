'use client';

import { useCallback, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/Button';
import { LoanSummaryCards } from '@/components/accounts/loan-detail/LoanSummaryCards';
import { AmortizationScheduleTable } from '@/components/accounts/loan-detail/AmortizationScheduleTable';
import { OverpaymentSimulator } from '@/components/accounts/loan-detail/OverpaymentSimulator';
import { PayoffComparisonChart } from '@/components/accounts/loan-detail/PayoffComparisonChart';
import { RateHistorySidebar } from '@/components/accounts/loan-detail/RateHistorySidebar';
import { ComparisonSummaryCards } from '@/components/accounts/loan-detail/ComparisonSummaryCards';
import { SavedScenariosPanel } from '@/components/accounts/loan-detail/SavedScenariosPanel';
import {
  ScenarioComparisonChart,
  ScenarioOutcome,
} from '@/components/accounts/loan-detail/ScenarioComparisonChart';
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
  const [plan, setPlan] = useState<OverpaymentPlan | null>(null);
  const [loadedPlan, setLoadedPlan] = useState<OverpaymentPlan | null>(null);
  const [loadedPlanVersion, setLoadedPlanVersion] = useState(0);
  const [showScenarioChart, setShowScenarioChart] = useState(false);
  const rateEditing = useLoanRateEditing(account, onRateChangesChanged);

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

  return (
    <div className="space-y-6">
      <LoanSummaryCards
        account={account}
        startingBalance={history.startingBalance}
        currentInstallment={currentInstallment}
        baseline={baseline}
      />

      <PastImpactSection account={account} impact={impact} />

      {/* Active loan: simulator (70%) with the Rate History panel beside it
          (30%), stacking on narrow screens. */}
      {projectionInput && (
        <div className="flex flex-col lg:flex-row gap-6 lg:items-stretch">
          <div className="w-full lg:w-[70%]">
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
                    onLoad={handleLoadScenario}
                    onScenariosChanged={onScenariosChanged}
                  />
                </>
              }
            />
          </div>
          <div className="w-full lg:w-[30%]">
            <RateHistorySidebar
              account={account}
              rateChanges={rateChanges}
              editing={rateEditing}
              fillHeight
            />
          </div>
        </div>
      )}

      {scenarioChartOutcomes.length > 0 && baseline && (
        <div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setShowScenarioChart((v) => !v)}
            aria-expanded={showScenarioChart}
          >
            {showScenarioChart
              ? t('loanDetail.scenarioChart.hide')
              : t('loanDetail.scenarioChart.show')}
          </Button>
          {showScenarioChart && (
            <div className="mt-4">
              <ScenarioComparisonChart
                outcomes={scenarioChartOutcomes}
                baseline={{ payoffDate: baseline.payoffDate }}
                currencyCode={account.currencyCode}
              />
            </div>
          )}
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
