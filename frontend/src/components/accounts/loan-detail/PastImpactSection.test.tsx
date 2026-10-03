import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@/test/render';
import { PastImpactSection } from './PastImpactSection';
import { computePastImpact } from '@/lib/loan-past-impact';
import { generateLoanSchedule } from '@/lib/loan-schedule';
import { deriveLoanPaymentHistory } from '@/lib/loan-history';
import { Account } from '@/types/account';
import { Transaction } from '@/types/transaction';

vi.mock('@/hooks/useNumberFormat', async () => {
  const { numberFormatMockDefaults } = await import('@/test/number-format-mock');
  return {
    useNumberFormat: () => ({
      ...numberFormatMockDefaults(),
      formatCurrency: (amount: number) => `$${amount.toFixed(2)}`,
    }),
  };
});
vi.mock('@/hooks/useChartDateFormat', () => ({
  useChartDateFormat: () => (date: string) => date.slice(0, 7),
}));

function makeAccount(overrides: Partial<Account> = {}): Account {
  return {
    id: 'loan-1',
    accountType: 'LOAN',
    name: 'Car Loan',
    currencyCode: 'CAD',
    openingBalance: -10000,
    currentBalance: -6000,
    interestRate: 6,
    paymentAmount: 500,
    paymentFrequency: 'MONTHLY',
    paymentStartDate: '2025-01-15',
    originalPrincipal: 10000,
    amortizationMonths: 21,
    mortgageType: 'ANNUITY',
    ...overrides,
  } as Account;
}

function makeHistory(account: Account) {
  const transactions = [1000, 1000, 1000, 1000].map(
    (amount, i) =>
      ({
        id: `tx-${i}`,
        accountId: account.id,
        transactionDate: `2025-${String(i + 1).padStart(2, '0')}-15`,
        amount,
        linkedTransaction: null,
      }) as Transaction,
  );
  return deriveLoanPaymentHistory(account, transactions);
}

/**
 * The forward projection the real caller (LoanDetailView) always supplies. With
 * it, "time already saved" and "interest already saved" are knowable; without it
 * they are unknown, which the two tests below cover.
 */
function makeProjection(account: Account) {
  return generateLoanSchedule({
    startingBalance: Math.abs(account.currentBalance),
    annualRate: account.interestRate!,
    paymentAmount: account.paymentAmount!,
    frequency: 'MONTHLY',
    firstPaymentDate: new Date(2025, 4, 15),
  });
}

describe('PastImpactSection', () => {
  it('shows extra principal paid plus months and interest saved', () => {
    const account = makeAccount();
    const impact = computePastImpact(
      account,
      makeHistory(account),
      makeProjection(account),
    );
    render(<PastImpactSection account={account} impact={impact} />);

    expect(screen.getByText('Extra Principal Paid')).toBeInTheDocument();
    expect(
      screen.getByText('Total extra principal paid on top of your scheduled payments'),
    ).toBeInTheDocument();
    expect(screen.getByText('Time Already Saved')).toBeInTheDocument();
    expect(screen.getByText(/\d+ months?/)).toBeInTheDocument();
    expect(screen.getByText('Interest Already Saved')).toBeInTheDocument();
    expect(screen.getByText(/Originally .+, now .+/)).toBeInTheDocument();
  });

  it('still renders when only the opening balance is set (no originalPrincipal)', () => {
    const account = makeAccount({ originalPrincipal: null });
    const impact = computePastImpact(
      account,
      makeHistory(account),
      makeProjection(account),
    );
    render(<PastImpactSection account={account} impact={impact} />);

    // Falls back to the opening balance; the section renders rather than hinting
    expect(screen.getByText('Extra Principal Paid')).toBeInTheDocument();
    expect(
      screen.queryByText(/needs an interest rate, a payment frequency/),
    ).not.toBeInTheDocument();
  });

  it('says Unknown for both savings when the remaining interest is unknown', () => {
    // No forward projection and a balance still outstanding: what is left to pay
    // is not known, so neither the months nor the interest saved is a number.
    // Zero here would tell the borrower their overpayments bought nothing.
    const account = makeAccount();
    // No forward projection at all -- exactly what the caller passes when the
    // account cannot be projected.
    const impact = computePastImpact(account, makeHistory(account));

    expect(impact!.monthsAlreadySaved).toBeNull();
    expect(impact!.interestAlreadySaved).toBeNull();

    render(<PastImpactSection account={account} impact={impact} />);

    expect(screen.getByText('Time Already Saved')).toBeInTheDocument();
    expect(screen.getByText('Interest Already Saved')).toBeInTheDocument();
    // One Unknown for each of the two savings; neither renders as a zero.
    expect(screen.getAllByText('Unknown')).toHaveLength(2);
    expect(screen.queryByText(/^\d+ months?$/)).not.toBeInTheDocument();
  });

  it('drops the "vs originally projected" note when the original never paid off', () => {
    // The note quotes originalSchedule.totalInterest, which on a truncated
    // schedule is the interest over the horizon rather than the loan's lifetime.
    const account = makeAccount();
    const impact = computePastImpact(
      account,
      makeHistory(account),
      makeProjection(account),
    );
    const truncated = {
      ...impact!,
      interestAlreadySaved: null,
      originalSchedule: { ...impact!.originalSchedule, paidOff: false, payoffDate: null },
    };
    render(<PastImpactSection account={account} impact={truncated} />);

    expect(screen.getByText('Interest Already Saved')).toBeInTheDocument();
    // The note quotes the original schedule's lifetime interest; a truncated one
    // has only a horizon subtotal, so the note is dropped rather than quoting it.
    // (The payoff-date note on the months card is a different string and stays.)
    expect(
      screen.queryByText(/originally projected/),
    ).not.toBeInTheDocument();
  });

  it('renders nothing when the impact cannot be computed', () => {
    const { container } = render(
      <PastImpactSection account={makeAccount()} impact={null} />,
    );

    expect(screen.queryByText('Extra Principal Paid')).not.toBeInTheDocument();
    expect(container).toBeEmptyDOMElement();
  });
});
