import { describe, it, expect, vi } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import { render } from '@/test/render';
import { CategorySummaryCards, type CategoryPeriodTotals } from './CategorySummaryCards';
import type { DisplayCurrencyStrategy } from '@/components/transactions/widget-shared';
import type { MonthlyTotal } from '@/types/transaction';
import type { Category, CategoryDetail } from '@/types/category';

const strategy: DisplayCurrencyStrategy = {
  displayCurrency: 'CAD',
  toDisplay: (amount) => amount,
};

function category(overrides: Partial<Category> = {}): Category {
  return {
    id: 'cat-1',
    userId: 'user-1',
    parentId: null,
    parent: null,
    children: [],
    name: 'Groceries',
    description: null,
    icon: null,
    color: null,
    effectiveColor: null,
    effectiveIcon: null,
    autoSign: null,
    effectiveAutoSign: true,
    isIncome: false,
    isSystem: false,
    createdAt: '2024-01-15T00:00:00.000Z',
    ...overrides,
  };
}

function detailFixture(overrides: Partial<CategoryDetail> = {}): CategoryDetail {
  return {
    category: category(),
    stats: {
      transactionCount: 42,
      firstTransactionDate: '2019-03-01',
      lastTransactionDate: '2026-07-15',
      payeeCount: 3,
      subcategoryCount: 0,
    },
    accounts: [],
    largestTransaction: null,
    defaultCategoryForPayees: [],
    ...overrides,
  };
}

const spending: CategoryPeriodTotals = { income: 0, expenses: 900, net: -900 };

function renderCards(
  options: {
    detail?: CategoryDetail;
    lifetime?: CategoryPeriodTotals | null;
    thisYear?: CategoryPeriodTotals | null;
    lastYear?: CategoryPeriodTotals | null;
    monthlyTotals?: MonthlyTotal[];
    isMultiCurrency?: boolean;
  } = {},
) {
  const onTransactionsClick = vi.fn();
  render(
    <CategorySummaryCards
      detail={options.detail ?? detailFixture()}
      lifetimeTotals={options.lifetime ?? spending}
      thisYearTotals={options.thisYear ?? spending}
      lastYearTotals={options.lastYear ?? null}
      monthlyTotals={options.monthlyTotals ?? []}
      currencyStrategy={strategy}
      isMultiCurrency={options.isMultiCurrency ?? false}
      onTransactionsClick={onTransactionsClick}
    />,
  );
  return { onTransactionsClick };
}

describe('CategorySummaryCards', () => {
  it('headlines an expense category as spending, in red', () => {
    renderCards();
    expect(screen.getByText('Spent This Year')).toBeInTheDocument();
    expect(screen.queryByText('Received This Year')).toBeNull();
    expect(screen.getByText(/900\.00/).className).toContain('text-red-600');
  });

  it('headlines an income category as money received, in green', () => {
    const income = { income: 5000, expenses: 0, net: 5000 };
    renderCards({
      detail: detailFixture({ category: category({ isIncome: true }) }),
      lifetime: income,
      thisYear: income,
    });
    expect(screen.getByText('Received This Year')).toBeInTheDocument();
    expect(screen.queryByText('Spent This Year')).toBeNull();
    expect(screen.getByText(/5,000\.00/).className).toContain('text-green-600');
  });

  // Issue #1125: a refund filed against an expense category was dropped from
  // the headline, which then disagreed with the register's own balance.
  it('nets a credit filed against an expense category out of the headline', () => {
    const netted = { income: 6.18, expenses: 23212.25, net: -23206.07 };
    renderCards({ lifetime: netted, thisYear: netted });
    expect(screen.getByText(/23,206\.07/)).toBeInTheDocument();
    expect(screen.queryByText(/23,212\.25/)).toBeNull();
  });

  it('nets a debit filed against an income category out of the headline', () => {
    const netted = { income: 5000, expenses: 250, net: 4750 };
    renderCards({
      detail: detailFixture({ category: category({ isIncome: true }) }),
      lifetime: netted,
      thisYear: netted,
    });
    expect(screen.getByText(/4,750\.00/)).toBeInTheDocument();
    expect(screen.queryByText(/5,000\.00/)).toBeNull();
  });

  it('measures the year-over-year change on the netted figures', () => {
    renderCards({
      thisYear: { income: 200, expenses: 1400, net: -1200 },
      lastYear: { income: 0, expenses: 1000, net: -1000 },
    });
    // 1200 against 1000, not the gross 1400 against 1000.
    expect(
      screen.getByText(/\+20(\.00)?% vs same period last year/),
    ).toBeInTheDocument();
  });

  it('notes the year-over-year change against the same period', () => {
    renderCards({
      thisYear: { income: 0, expenses: 1200, net: -1200 },
      lastYear: { income: 0, expenses: 1000, net: -1000 },
    });
    expect(
      screen.getByText(/\+20(\.00)?% vs same period last year/),
    ).toBeInTheDocument();
  });

  it('says when the category is new against last year', () => {
    renderCards({ lastYear: { income: 0, expenses: 0, net: 0 } });
    expect(screen.getByText('Nothing in this period last year')).toBeInTheDocument();
  });

  it('averages the whole monthly history over the months elapsed', () => {
    renderCards({
      monthlyTotals: [
        { month: '2026-01', total: -100, count: 2 },
        { month: '2026-02', total: -50, count: 1 },
        { month: '2026-03', total: -150, count: 3 },
      ],
    });
    // (100 + 50 + 150) / 3 elapsed months.
    expect(screen.getByText('Monthly Average')).toBeInTheDocument();
    expect(screen.getByText(/100\.00/)).toBeInTheDocument();
  });

  it('counts an empty gap month in the average denominator', () => {
    renderCards({
      monthlyTotals: [
        { month: '2026-01', total: -300, count: 3 },
        { month: '2026-03', total: -300, count: 3 },
      ],
    });
    // 600 over Jan..Mar is three elapsed months, not two populated ones.
    expect(screen.getByText(/200\.00/)).toBeInTheDocument();
  });

  it('withholds the monthly average while a month has no exchange rate', () => {
    renderCards({
      monthlyTotals: [
        { month: '2026-01', total: -300, count: 3 },
        { month: '2026-02', total: null, knownSubtotal: -50, count: 1 },
      ],
    });
    const card = screen.getByText('Monthly Average').closest('article');
    expect(card?.textContent).toContain('—');
    expect(card?.textContent).toContain('Some months have no exchange rate');
  });

  it('shows an em dash instead of an average when there is no history', () => {
    renderCards({ monthlyTotals: [] });
    const card = screen.getByText('Monthly Average').closest('article');
    expect(card?.textContent).toContain('—');
  });

  it('shows the transaction count with its first-seen year', () => {
    renderCards();
    expect(screen.getByText('42')).toBeInTheDocument();
    expect(screen.getByText('Since 2019')).toBeInTheDocument();
  });

  it('opens the transactions tab from the Transactions card', () => {
    const { onTransactionsClick } = renderCards();
    fireEvent.click(screen.getByRole('button', { name: 'Transactions' }));
    expect(onTransactionsClick).toHaveBeenCalled();
  });

  it('notes the conversion currency for a multi-currency category', () => {
    renderCards({ isMultiCurrency: true });
    expect(screen.getAllByText('Converted to CAD').length).toBeGreaterThan(0);
  });

  it('shows no conversion note for a single-currency category', () => {
    renderCards();
    expect(screen.queryByText('Converted to CAD')).toBeNull();
  });
});
