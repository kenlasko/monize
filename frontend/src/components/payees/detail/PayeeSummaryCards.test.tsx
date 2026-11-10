import { describe, it, expect, vi } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import { render } from '@/test/render';
import { PayeeSummaryCards, type PayeePeriodTotals } from './PayeeSummaryCards';
import type { DisplayCurrencyStrategy } from '@/components/transactions/widget-shared';
import type { PayeeDetail } from '@/types/payee';

const strategy: DisplayCurrencyStrategy = {
  displayCurrency: 'CAD',
  converted: false,
};

function detailFixture(overrides: Partial<PayeeDetail> = {}): PayeeDetail {
  return {
    payee: {
      id: 'payee-1',
      userId: 'user-1',
      name: 'Starbucks',
      defaultCategoryId: 'cat-1',
      defaultCategory: null,
      notes: null,
      website: null,
      hasLogo: false,
      logoFetchedAt: null,
      contactLookupAt: null,
      contactLookupSource: null,
      address: null,
      email: null,
      phone: null,
      isActive: true,
      createdAt: '2024-01-01T00:00:00.000Z',
    },
    stats: {
      transactionCount: 42,
      firstTransactionDate: '2019-03-01',
      lastTransactionDate: '2026-07-15',
      uncategorizedCount: 0,
      aliasCount: 0,
    },
    accounts: [],
    largestTransaction: null,
    overpaymentForAccounts: [],
    ...overrides,
  };
}

const spending: PayeePeriodTotals = { income: 0, expenses: 1200, net: -1200 };

function renderCards(
  options: {
    detail?: PayeeDetail;
    lifetime?: PayeePeriodTotals | null;
    thisYear?: PayeePeriodTotals | null;
    lastYear?: PayeePeriodTotals | null;
    recurring?: { cadence: string; amount: number; previousAmount: number } | null;
    isMultiCurrency?: boolean;
  } = {},
) {
  const onUncategorizedClick = vi.fn();
  render(
    <PayeeSummaryCards
      detail={options.detail ?? detailFixture()}
      lifetimeTotals={options.lifetime ?? spending}
      thisYearTotals={options.thisYear ?? spending}
      lastYearTotals={options.lastYear ?? null}
      recurring={options.recurring ?? null}
      currencyStrategy={strategy}
      isMultiCurrency={options.isMultiCurrency ?? false}
      onUncategorizedClick={onUncategorizedClick}
    />,
  );
  return { onUncategorizedClick };
}

describe('PayeeSummaryCards', () => {
  it('frames an expense payee as spending', () => {
    renderCards();
    expect(screen.getByText('Spent This Year')).toBeInTheDocument();
    expect(screen.queryByText('Received This Year')).toBeNull();
  });

  it('frames an income payee (an employer) as money received', () => {
    const income = { income: 5000, expenses: 0, net: 5000 };
    renderCards({ lifetime: income, thisYear: income });
    expect(screen.getByText('Received This Year')).toBeInTheDocument();
    expect(screen.queryByText('Spent This Year')).toBeNull();
  });

  it('notes the year-over-year change against the same period', () => {
    renderCards({
      thisYear: { income: 0, expenses: 1200, net: -1200 },
      lastYear: { income: 0, expenses: 1000, net: -1000 },
    });
    expect(screen.getByText(/\+20(\.00)?% vs same period last year/)).toBeInTheDocument();
  });

  it('says when the payee is new against last year', () => {
    renderCards({ lastYear: { income: 0, expenses: 0, net: 0 } });
    expect(screen.getByText('Nothing in this period last year')).toBeInTheDocument();
  });

  it('shows the transaction count with its first-seen year', () => {
    renderCards();
    expect(screen.getByText('42')).toBeInTheDocument();
    expect(screen.getByText('Since 2019')).toBeInTheDocument();
  });

  it('shows the detected cadence with a price-increase note', () => {
    renderCards({
      recurring: { cadence: 'monthly', amount: 16.99, previousAmount: 14.99 },
    });
    expect(screen.getByText('Recurring')).toBeInTheDocument();
    expect(screen.getByText(/Monthly/)).toBeInTheDocument();
    expect(screen.getByText(/Up from/)).toBeInTheDocument();
  });

  it('omits the recurring card when no cadence was detected', () => {
    renderCards();
    expect(screen.queryByText('Recurring')).toBeNull();
  });

  it('surfaces uncategorized transactions as a clickable card', () => {
    const { onUncategorizedClick } = renderCards({
      detail: detailFixture({
        stats: {
          transactionCount: 42,
          firstTransactionDate: '2019-03-01',
          lastTransactionDate: '2026-07-15',
          uncategorizedCount: 5,
          aliasCount: 0,
        },
      }),
    });
    expect(screen.getByText('Click to apply the default category')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Uncategorized' }));
    expect(onUncategorizedClick).toHaveBeenCalled();
  });

  it('asks for a default category when the payee has none', () => {
    renderCards({
      detail: detailFixture({
        payee: {
          id: 'payee-1',
          userId: 'user-1',
          name: 'Starbucks',
          defaultCategoryId: null,
          defaultCategory: null,
          notes: null,
          website: null,
          hasLogo: false,
          logoFetchedAt: null,
          contactLookupAt: null,
          contactLookupSource: null,
          address: null,
          email: null,
          phone: null,
          isActive: true,
          createdAt: '2024-01-01T00:00:00.000Z',
        },
        stats: {
          transactionCount: 42,
          firstTransactionDate: '2019-03-01',
          lastTransactionDate: '2026-07-15',
          uncategorizedCount: 5,
          aliasCount: 0,
        },
      }),
    });
    expect(screen.getByText('Click to set a default category')).toBeInTheDocument();
  });

  it('hides the uncategorized card when everything is categorized', () => {
    renderCards();
    expect(screen.queryByText('Uncategorized')).toBeNull();
  });

  it('notes the conversion currency for a multi-currency payee', () => {
    renderCards({ isMultiCurrency: true });
    expect(screen.getAllByText('Converted to CAD').length).toBeGreaterThan(0);
  });
});
