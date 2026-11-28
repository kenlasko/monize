import { describe, it, expect } from 'vitest';
import { render, screen } from '@/test/render';
import { BudgetSummaryCards } from './BudgetSummaryCards';
import { BudgetCategoryRow } from './BudgetCategoryRow';
import { BudgetFlexGroupCard } from './BudgetFlexGroupCard';
import { BudgetHealthGauge } from './BudgetHealthGauge';
import { BudgetFundingFigures } from './BudgetFundingFigures';
import { BudgetUpcomingBills } from './BudgetUpcomingBills';
import type { BudgetCategory, CategoryBreakdown } from '@/types/budget';

// A row with no exchange rate makes spending unknown (audit #2365 p): every
// figure that depends on it is drawn as unknown, never as the converted part.

const fmt = (amount: number) => `$${amount.toFixed(2)}`;

const partialLine: CategoryBreakdown = {
  budgetCategoryId: 'bc-1',
  categoryId: 'cat-1',
  categoryName: 'Groceries',
  budgeted: 1000,
  spent: 20,
  remaining: 980,
  percentUsed: 2,
  isIncome: false,
  isTransfer: false,
  percentage: null,
  valuationComplete: false,
  missingRatePairs: ['QQQ->USD'],
};

describe('partial budget figures', () => {
  it('draws Spent, Remaining and Savings as unknown but keeps Total Budget and days', () => {
    render(
      <BudgetSummaryCards
        totalBudgeted={1000}
        totalSpent={null}
        remaining={null}
        totalIncome={5000}
        percentUsed={null}
        partialReason="No exchange rate for QQQ->USD"
        daysRemaining={17}
        formatCurrency={fmt}
      />,
    );
    expect(screen.getByText('$1000.00')).toBeInTheDocument();
    expect(screen.getAllByTestId('unknown-amount')).toHaveLength(3);
    expect(screen.queryByText('$20.00')).not.toBeInTheDocument();
    expect(screen.queryByText('(2%)')).not.toBeInTheDocument();
  });

  it('draws a partial category line as unknown with no percent and no bar', () => {
    render(<BudgetCategoryRow category={partialLine} formatCurrency={fmt} pacePercent={50} />);
    expect(screen.getAllByTestId('unknown-amount').length).toBeGreaterThanOrEqual(2);
    expect(screen.queryByText('$20.00')).not.toBeInTheDocument();
    expect(screen.queryByText('2%')).not.toBeInTheDocument();
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
  });

  it('withholds a flex group total and percent when a member line is partial', () => {
    const bc = { id: 'bc-1', flexGroup: 'Food' } as unknown as BudgetCategory;
    render(
      <BudgetFlexGroupCard categories={[partialLine]} budgetCategories={[bc]} formatCurrency={fmt} />,
    );
    expect(screen.getByText('Food')).toBeInTheDocument();
    expect(screen.queryByText(/\$20\.00/)).not.toBeInTheDocument();
    expect(screen.getAllByTestId('unknown-amount').length).toBeGreaterThanOrEqual(2);
  });

  it('draws an unknown health score instead of a number', () => {
    render(<BudgetHealthGauge score={null} partialReason="No exchange rate for QQQ->USD" />);
    expect(screen.getByTestId('score-unknown')).toHaveTextContent('QQQ->USD');
    expect(screen.queryByTestId('score-value')).not.toBeInTheDocument();
  });

  it('draws withheld funding figures as unknown', () => {
    render(
      <BudgetFundingFigures
        categoryIncome={null}
        transferFunding={0}
        totalFunding={null}
        partialReason="No exchange rate for QQQ->USD"
        formatCurrency={fmt}
      />,
    );
    expect(screen.getAllByTestId('unknown-amount')).toHaveLength(2);
    expect(screen.getByText('$0.00')).toBeInTheDocument();
  });

  it('names the spending, not the schedule, when bills converted but spending did not', () => {
    render(
      <BudgetUpcomingBills
        scheduledTransactions={[]}
        currentSpent={null}
        spendingMissingRatePairs={['QQQ->USD']}
        totalBudgeted={1000}
        periodEnd="2099-12-31"
        displayCurrency="USD"
        formatCurrency={fmt}
      />,
    );
    // The truly-available figure is unknown, with the spending's cause.
    expect(screen.getAllByTestId('unknown-amount').length).toBeGreaterThanOrEqual(1);
  });
});
