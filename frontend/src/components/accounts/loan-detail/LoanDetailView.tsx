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
import { useLoanRateEditing } from '@/components/accounts/loan-detail/useLoanRateEditing';
import { deriveCurrentInstallment, deriveLoanPaymentHistory } from '@/lib/loan-history';
import {
  OverpaymentMode,
  OverpaymentPlan,
  ScheduleFrequency,
  advanceDate,
  buildRateTimeline,
  compareSchedules,
  generateLoanSchedule,
  getPeriodicRate,
  getPeriodsPerYear,
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
  const [plan, setPlan] = useState<OverpaymentPlan | null>(null);
  const [mode, setMode] = useState<OverpaymentMode>('SHORTEN_TERM');
  const [loadedPlan, setLoadedPlan] = useState<OverpaymentPlan | null>(null);
  const [loadedPlanVersion, setLoadedPlanVersion] = useState(0);
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
    // Seed the projection from the installment actually in effect (the latest
    // recorded payment change), not the original contractual paymentAmount --
    // otherwise a loan whose installment the lender lowered (PL obniżenie raty)
    // projects too high a payment and too short a remaining term.
    const installment = deriveCurrentInstallment(history, account.paymentAmount!);
    const seededPayment = futureTimeline.startingPaymentAmount ?? installment;
    // A recorded payment amount (stored or from a detected rate row) can be
    // principal-only for loans that book interest separately -- below the
    // period's interest, so the projection never amortizes. When it does not
    // cover the interest, fall back to the real installment (principal +
    // interest), which always does.
    const periodicRate = getPeriodicRate(
      account.interestRate!,
      getPeriodsPerYear(frequency),
      account.isCanadianMortgage || false,
      account.isVariableRate || false,
    );
    const firstPeriodInterest = history.currentBalance * periodicRate;
    const currentPayment =
      seededPayment > firstPeriodInterest ? seededPayment : installment;
    return {
      startingBalance: history.currentBalance,
      annualRate: account.interestRate!,
      paymentAmount: currentPayment,
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
        ? generateLoanSchedule({
            ...projectionInput,
            overpayments: plan,
            overpaymentMode: mode,
          })
        : null,
    [projectionInput, plan, mode],
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
        currentInstallment={currentInstallment}
        baseline={baseline}
      />

      {projectionInput && (
        <OverpaymentSimulator
          accountId={account.id}
          currencyCode={account.currencyCode}
          onPlanChange={setPlan}
          mode={mode}
          onModeChange={setMode}
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

      <PastImpactSection
        account={account}
        history={history}
        rateChanges={rateChanges}
      />

      <AmortizationScheduleTable
        historyEvents={history.events}
        projectionRows={(scenario ?? baseline)?.rows ?? []}
        currencyCode={account.currencyCode}
        rateChanges={rateChanges}
        fallbackAnnualRate={account.interestRate}
        editing={rateEditing}
      />
    </div>
  );
}
