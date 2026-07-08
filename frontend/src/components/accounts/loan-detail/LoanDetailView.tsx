'use client';

import { useCallback, useMemo, useState } from 'react';
import { format } from 'date-fns';
import { LoanSummaryCards } from '@/components/accounts/loan-detail/LoanSummaryCards';
import { AmortizationScheduleTable } from '@/components/accounts/loan-detail/AmortizationScheduleTable';
import { OverpaymentSimulator } from '@/components/accounts/loan-detail/OverpaymentSimulator';
import { PayoffComparisonChart } from '@/components/accounts/loan-detail/PayoffComparisonChart';
import { ComparisonSummaryCards } from '@/components/accounts/loan-detail/ComparisonSummaryCards';
import { SavedScenariosPanel } from '@/components/accounts/loan-detail/SavedScenariosPanel';
import { PastImpactSection } from '@/components/accounts/loan-detail/PastImpactSection';
import { RateHistoryPanel } from '@/components/accounts/loan-detail/RateHistoryPanel';
import { deriveLoanPaymentHistory } from '@/lib/loan-history';
import {
  OverpaymentPlan,
  ScheduleFrequency,
  advanceDate,
  buildRateTimeline,
  compareSchedules,
  generateLoanSchedule,
} from '@/lib/loan-schedule';
import type { Account } from '@/types/account';
import type { Transaction } from '@/types/transaction';
import type { LoanScenario } from '@/types/loan-scenario';
import type { LoanRateChange } from '@/types/loan-rate-change';

interface LoanDetailViewProps {
  account: Account;
  transactions: Transaction[];
  scenarios: LoanScenario[];
  rateChanges: LoanRateChange[];
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
  onScenariosChanged,
  onRateChangesChanged,
}: LoanDetailViewProps) {
  const [plan, setPlan] = useState<OverpaymentPlan | null>(null);
  const [loadedPlan, setLoadedPlan] = useState<OverpaymentPlan | null>(null);
  const [loadedPlanVersion, setLoadedPlanVersion] = useState(0);

  const handleLoadScenario = useCallback((loaded: OverpaymentPlan | null) => {
    setPlan(loaded);
    setLoadedPlan(loaded);
    setLoadedPlanVersion((version) => version + 1);
  }, []);

  const history = useMemo(
    () => deriveLoanPaymentHistory(account, transactions),
    [account, transactions],
  );

  const projectionInput = useMemo(() => {
    const canProject =
      history.currentBalance > 0.01 &&
      account.interestRate != null &&
      account.paymentAmount &&
      account.paymentAmount > 0 &&
      account.paymentFrequency;
    if (!canProject) return null;

    const frequency = account.paymentFrequency as ScheduleFrequency;
    // The account's scalar rate is already current; only future-dated steps
    // from the rate history bend the projection ahead.
    const today = format(new Date(), 'yyyy-MM-dd');
    const futureTimeline = buildRateTimeline(rateChanges, today, account.interestRate!);
    return {
      startingBalance: history.currentBalance,
      annualRate: account.interestRate!,
      paymentAmount: account.paymentAmount!,
      frequency,
      isCanadian: account.isCanadianMortgage || false,
      isVariableRate: account.isVariableRate || false,
      firstPaymentDate: advanceDate(new Date(), frequency),
      rateChanges: futureTimeline.rateChanges,
    };
  }, [account, history, rateChanges]);

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

  return (
    <div className="space-y-6">
      <LoanSummaryCards
        account={account}
        startingBalance={history.startingBalance}
        baseline={baseline}
      />

      <RateHistoryPanel
        account={account}
        rateChanges={rateChanges}
        onChanged={onRateChangesChanged}
      />

      {projectionInput && (
        <OverpaymentSimulator
          accountId={account.id}
          currencyCode={account.currencyCode}
          onPlanChange={setPlan}
          loadedPlan={loadedPlan}
          loadedPlanVersion={loadedPlanVersion}
        />
      )}

      {projectionInput && (
        <SavedScenariosPanel
          accountId={account.id}
          scenarios={scenarios}
          activePlan={plan}
          onLoad={handleLoadScenario}
          onScenariosChanged={onScenariosChanged}
        />
      )}

      {comparison && (
        <ComparisonSummaryCards comparison={comparison} currencyCode={account.currencyCode} />
      )}

      <PayoffComparisonChart
        historyEvents={history.events}
        baseline={baseline}
        scenario={scenario}
      />

      <PastImpactSection account={account} history={history} rateChanges={rateChanges} />

      <AmortizationScheduleTable
        historyEvents={history.events}
        projectionRows={(scenario ?? baseline)?.rows ?? []}
        currencyCode={account.currencyCode}
      />
    </div>
  );
}
