import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@/test/render';
import { LoanSummaryCards } from './LoanSummaryCards';
import { generateLoanSchedule } from '@/lib/loan-schedule';
import { Account } from '@/types/account';

vi.mock('@/hooks/useNumberFormat', async () => {
  const { numberFormatMockDefaults } = await import('@/test/number-format-mock');
  return {
    useNumberFormat: () => ({
      ...numberFormatMockDefaults(),
      formatCurrency: (amount: number) => `$${amount.toFixed(2)}`,
    }),
  };
});
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
    mortgageType: 'ANNUITY',
    ...overrides,
  } as Account;
}

function makeBaseline() {
  return generateLoanSchedule({
    startingBalance: 8000,
    annualRate: 6,
    paymentAmount: 500,
    frequency: 'MONTHLY',
    firstPaymentDate: new Date(2026, 7, 15),
  });
}

describe('LoanSummaryCards', () => {
  it('shows the rate in effect, not the account scalar', () => {
    // The scalar is the OLD rate on any loan whose rate was changed through the
    // rate-history UI (recording a change deliberately never writes it), so the
    // card used to print 5% beside a payoff the projection had refused at 12%.
    // Every other fixture here passes a rate equal to the account's, which is
    // why reverting this to account.interestRate left them all green.
    render(
      <LoanSummaryCards
        account={makeAccount({ interestRate: 5 })}
        startingBalance={10000}
        currentInstallment={500}
        currentAnnualRate={12}
        baseline={null}
      />,
    );
    expect(screen.getByText('12%')).toBeInTheDocument();
    expect(screen.queryByText('5%')).not.toBeInTheDocument();
  });

  it('renders balance, original amount, rate, and payment figures', () => {
    render(
      <LoanSummaryCards
        account={makeAccount()}
        startingBalance={10000}
        currentInstallment={500}
        currentAnnualRate={6}
        baseline={makeBaseline()}
      />,
    );

    expect(screen.getByText('Current Balance')).toBeInTheDocument();
    expect(screen.getByText('$8000.00')).toBeInTheDocument();
    expect(screen.getByText('Original Amount')).toBeInTheDocument();
    expect(screen.getByText('$10000.00')).toBeInTheDocument();
    expect(screen.getByText('6%')).toBeInTheDocument();
    expect(screen.getByText('$500.00')).toBeInTheDocument();
    expect(screen.getByText('Monthly')).toBeInTheDocument();
  });

  it('shows payoff date and remaining interest from the baseline projection', () => {
    const baseline = makeBaseline();
    render(
      <LoanSummaryCards
        account={makeAccount()}
        startingBalance={10000}
        currentInstallment={500}
        currentAnnualRate={6}
        baseline={baseline}
      />,
    );

    expect(screen.getByText('Est. Payoff')).toBeInTheDocument();
    // 8000 at 6% with $500/mo pays off in ~17 payments from Aug 2026
    expect(screen.getByText(/2027/)).toBeInTheDocument();
    expect(screen.getByText(`$${baseline.totalInterest.toFixed(2)}`)).toBeInTheDocument();
  });

  it('shows the effective rate note for Canadian fixed mortgages', () => {
    render(
      <LoanSummaryCards
        account={makeAccount({ accountType: 'MORTGAGE', mortgageType: 'CANADIAN_FIXED', interestRate: 5 })}
        startingBalance={10000}
        currentInstallment={500}
        currentAnnualRate={5}
        baseline={null}
      />,
    );

    // (1 + 0.05/2)^2 - 1 = 5.0625%
    expect(screen.getByText(/5\.062\d?% effective/)).toBeInTheDocument();
  });

  it('omits the effective rate for an ANNUITY mortgage', () => {
    render(
      <LoanSummaryCards
        account={makeAccount({
          accountType: 'MORTGAGE',
          mortgageType: 'ANNUITY',
          interestRate: 5,
        })}
        startingBalance={10000}
        currentInstallment={500}
        currentAnnualRate={5}
        baseline={null}
      />,
    );

    expect(screen.queryByText(/effective/)).not.toBeInTheDocument();
  });

  it('falls back to N/A and Not set when data is missing', () => {
    render(
      <LoanSummaryCards
        account={makeAccount({ interestRate: null, paymentAmount: null, paymentFrequency: null })}
        startingBalance={10000}
        currentInstallment={null}
        currentAnnualRate={null}
        baseline={null}
      />,
    );

    expect(screen.getAllByText('Not set').length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText('N/A').length).toBeGreaterThanOrEqual(2);
  });

  it('does not resolve the payment a second time from the account scalar', () => {
    // The resolved installment is the only source. The card used to fall back to
    // `account.paymentAmount`, which `resolveCurrentLoanTerms` already ranks --
    // a second place the payment gets decided, and the only value the fallback
    // could ever contribute is the non-positive one the resolver rejected.
    render(
      <LoanSummaryCards
        account={makeAccount({ paymentAmount: 0 })}
        startingBalance={10000}
        currentInstallment={null}
        currentAnnualRate={6}
        baseline={null}
      />,
    );

    expect(screen.queryByText('$0.00')).not.toBeInTheDocument();
    expect(screen.getAllByText('Not set').length).toBeGreaterThanOrEqual(1);
  });

  it('shows Paid off when the balance is zero', () => {
    render(
      <LoanSummaryCards
        account={makeAccount({ currentBalance: 0 })}
        startingBalance={10000}
        currentInstallment={500}
        currentAnnualRate={6}
        baseline={null}
      />,
    );

    expect(screen.getByText('Paid off')).toBeInTheDocument();
    // A settled loan owes no more interest -- a known zero, not "N/A", which
    // would report a finished loan as one that could not be worked out. The
    // balance card also reads $0.00, so pick the remaining-interest card by its
    // own colour rather than by the shared text.
    const remainingInterest = screen
      .getAllByText('$0.00')
      .find((node) => node.className.includes('text-orange-600'));
    expect(remainingInterest).toBeDefined();
  });

  // A liability in credit owes nothing either. Taking the magnitude of the
  // balance read the overpayment as debt of the same size.
  it('shows Paid off for an overpaid loan sitting in credit', () => {
    render(
      <LoanSummaryCards
        account={makeAccount({ currentBalance: 42 })}
        startingBalance={10000}
        currentInstallment={500}
        currentAnnualRate={6}
        baseline={null}
      />,
    );

    expect(screen.getByText('Paid off')).toBeInTheDocument();
  });

  // The schedule stops at its horizon when the installment never amortizes, so
  // its accumulated interest is the interest over that horizon rather than the
  // interest remaining -- a subtotal under a total's label.
  it('withholds the remaining interest when the projection never pays off', () => {
    const baseline = generateLoanSchedule({
      startingBalance: 8000,
      annualRate: 20,
      paymentAmount: 50,
      frequency: 'MONTHLY',
      firstPaymentDate: new Date(2026, 7, 15),
    });
    expect(baseline.paidOff).toBe(false);

    render(
      <LoanSummaryCards
        account={makeAccount()}
        startingBalance={10000}
        currentInstallment={50}
        currentAnnualRate={6}
        baseline={baseline}
      />,
    );

    expect(screen.queryByText(`$${baseline.totalInterest.toFixed(2)}`)).not.toBeInTheDocument();
    expect(screen.getAllByText('N/A').length).toBeGreaterThanOrEqual(2);
  });

  describe('a mortgage without a constant payment', () => {
    const linear = () =>
      makeAccount({
        accountType: 'MORTGAGE',
        mortgageType: 'LINEAR',
        paymentAmount: null,
        currentBalance: -265000,
      });

    it('captions the installment as the next one, with its due date', () => {
      render(
        <LoanSummaryCards
          account={linear()}
          startingBalance={300000}
          currentInstallment={1275}
          currentInstallmentDate="2025-07-01"
          currentAnnualRate={2}
          baseline={null}
        />,
      );
      expect(screen.getByText('Next Installment')).toBeInTheDocument();
      expect(screen.queryByText('Payment')).not.toBeInTheDocument();
      expect(screen.getByText('$1275.00')).toBeInTheDocument();
      expect(screen.getByText(/^Due .*2025/)).toBeInTheDocument();
      expect(screen.queryByText('Final Payment')).not.toBeInTheDocument();
    });

    it('shows an interest-only bullet beside the installment', () => {
      render(
        <LoanSummaryCards
          account={linear()}
          startingBalance={300000}
          currentInstallment={441.67}
          currentInstallmentDate="2025-07-01"
          finalPayment={{ amount: 265441.67, date: '2053-12-01' }}
          currentAnnualRate={2}
          baseline={null}
        />,
      );
      expect(screen.getByText('Final Payment')).toBeInTheDocument();
      expect(screen.getByText('$265441.67')).toBeInTheDocument();
      expect(screen.getByText(/^Due .*2053/)).toBeInTheDocument();
    });

    it('keeps the plain Payment caption for an annuity', () => {
      render(
        <LoanSummaryCards
          account={makeAccount()}
          startingBalance={10000}
          currentInstallment={500}
          currentInstallmentDate={null}
          currentAnnualRate={6}
          baseline={null}
        />,
      );
      expect(screen.getByText('Payment')).toBeInTheDocument();
      expect(screen.queryByText('Next Installment')).not.toBeInTheDocument();
    });
  });
});
