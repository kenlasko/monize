import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act } from '@/test/render';
import { LoanDetailView } from './LoanDetailView';
import { Account } from '@/types/account';
import { Transaction } from '@/types/transaction';
import type { ReactNode } from 'react';
import type { OverpaymentPlan } from '@/lib/loan-schedule';

// Mock the presentational children so this test focuses on LoanDetailView's
// wiring (history derivation, projection gating, scenario comparison).
vi.mock('./LoanSummaryCards', () => ({
  LoanSummaryCards: ({ startingBalance }: { startingBalance: number }) => (
    <div data-testid="summary">start:{startingBalance}</div>
  ),
}));
vi.mock('./AmortizationScheduleTable', () => ({
  AmortizationScheduleTable: () => <div data-testid="schedule" />,
}));
vi.mock('./PayoffComparisonChart', () => ({
  PayoffComparisonChart: ({ scenario }: { scenario: unknown }) => (
    <div data-testid="chart">scenario:{scenario ? 'yes' : 'no'}</div>
  ),
}));
vi.mock('./PastImpactSection', () => ({
  PastImpactSection: () => <div data-testid="past-impact" />,
}));
vi.mock('./ComparisonSummaryCards', () => ({
  ComparisonSummaryCards: () => <div data-testid="comparison" />,
}));
vi.mock('./SavedScenariosPanel', () => ({
  SavedScenariosPanel: () => <div data-testid="scenarios-panel" />,
}));

let capturedOnPlanChange: ((plan: OverpaymentPlan | null) => void) | undefined;
vi.mock('./OverpaymentSimulator', () => ({
  OverpaymentSimulator: (props: {
    onPlanChange: (p: OverpaymentPlan | null) => void;
    footer?: ReactNode;
  }) => {
    capturedOnPlanChange = props.onPlanChange;
    // The saved-scenarios panel is now rendered inside the simulator's footer.
    return <div data-testid="simulator">{props.footer}</div>;
  },
}));

function makeAccount(overrides: Partial<Account> = {}): Account {
  return {
    id: 'loan-1',
    accountType: 'LOAN',
    name: 'Car Loan',
    currencyCode: 'CAD',
    openingBalance: -10000,
    currentBalance: -8000,
    interestRate: 6,
    paymentAmount: 500,
    paymentFrequency: 'MONTHLY',
    isCanadianMortgage: false,
    isVariableRate: false,
    ...overrides,
  } as Account;
}

const noTransactions: Transaction[] = [];

function renderView(account: Account) {
  return render(
    <LoanDetailView
      account={account}
      transactions={noTransactions}
      scenarios={[]}
      rateChanges={[]}
      onScenariosChanged={vi.fn()}
      onRateChangesChanged={vi.fn()}
    />,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  capturedOnPlanChange = undefined;
});

describe('LoanDetailView', () => {
  it('always renders the summary, chart, past-impact, and schedule', () => {
    renderView(makeAccount());
    expect(screen.getByTestId('summary')).toBeInTheDocument();
    expect(screen.getByTestId('chart')).toBeInTheDocument();
    expect(screen.getByTestId('past-impact')).toBeInTheDocument();
    expect(screen.getByTestId('schedule')).toBeInTheDocument();
  });

  it('shows the schedule even when the loan cannot be projected', () => {
    renderView(makeAccount({ paymentAmount: null, interestRate: null, paymentFrequency: null }));
    expect(screen.getByTestId('schedule')).toBeInTheDocument();
  });

  it('passes the anchored opening balance to the summary', () => {
    renderView(makeAccount());
    // openingBalance -10000 -> starting magnitude 10000 (not a reconstruction)
    expect(screen.getByTestId('summary')).toHaveTextContent('start:10000');
  });

  it('shows the simulator and saved scenarios when the loan can be projected', () => {
    renderView(makeAccount());
    expect(screen.getByTestId('simulator')).toBeInTheDocument();
    expect(screen.getByTestId('scenarios-panel')).toBeInTheDocument();
  });

  it('hides the simulator when there is no payment configuration', () => {
    renderView(makeAccount({ paymentAmount: null, interestRate: null, paymentFrequency: null }));
    expect(screen.queryByTestId('simulator')).not.toBeInTheDocument();
    expect(screen.queryByTestId('scenarios-panel')).not.toBeInTheDocument();
  });

  it('renders the comparison and a scenario curve once a plan is active', async () => {
    renderView(makeAccount());
    expect(screen.queryByTestId('comparison')).not.toBeInTheDocument();
    expect(screen.getByTestId('chart')).toHaveTextContent('scenario:no');

    await act(async () => {
      capturedOnPlanChange?.({ recurringExtra: { amount: 200 } });
    });

    expect(screen.getByTestId('comparison')).toBeInTheDocument();
    expect(screen.getByTestId('chart')).toHaveTextContent('scenario:yes');
  });
});
