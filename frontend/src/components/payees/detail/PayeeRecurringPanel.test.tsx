import { describe, it, expect, vi } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import { render } from '@/test/render';
import { PayeeRecurringPanel } from './PayeeRecurringPanel';
import type { DisplayCurrencyStrategy } from '@/components/transactions/widget-shared';
import type { RecurringChargeInfo } from '@/types/transaction';

const mockPush = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush, replace: vi.fn() }),
  usePathname: () => '/payees/payee-1',
  useSearchParams: () => new URLSearchParams(),
}));

const strategy: DisplayCurrencyStrategy = {
  displayCurrency: 'CAD',
  converted: false,
};

function charge(overrides: Partial<RecurringChargeInfo> = {}): RecurringChargeInfo {
  return {
    payeeName: 'Netflix',
    payeeId: 'payee-1',
    amounts: [14.99, 14.99, 16.99],
    dates: ['2026-04-15', '2026-05-15', '2026-06-15'],
    frequency: 'monthly',
    currentAmount: 16.99,
    previousAmount: 14.99,
    categoryName: 'Entertainment',
    categoryId: 'cat-1',
    ...overrides,
  };
}

function renderPanel(
  charges: RecurringChargeInfo[],
  nextBill: { date: string; amount: number; currencyCode: string; payeeName: string | null } | null = null,
) {
  render(
    <PayeeRecurringPanel
      charges={charges}
      nextBill={nextBill}
      currencyStrategy={strategy}
      isLoading={false}
    />,
  );
}

describe('PayeeRecurringPanel', () => {
  it('shows the empty state when nothing recurs', () => {
    renderPanel([]);
    expect(
      screen.getByText('No recurring pattern detected in the last 12 months'),
    ).toBeInTheDocument();
  });

  it('ignores rows whose frequency is not a real cadence', () => {
    renderPanel([charge({ frequency: 'irregular' })]);
    expect(
      screen.getByText('No recurring pattern detected in the last 12 months'),
    ).toBeInTheDocument();
  });

  it('shows the cadence, category and price change', () => {
    renderPanel([charge()]);
    expect(screen.getByText(/Monthly/)).toBeInTheDocument();
    expect(screen.getByText(/Entertainment/)).toBeInTheDocument();
    expect(screen.getByText(/was .*14\.99/)).toBeInTheDocument();
  });

  it('omits the price change when the amount is steady', () => {
    renderPanel([charge({ previousAmount: 16.99 })]);
    expect(screen.queryByText(/was /)).toBeNull();
  });

  it('names the usual billing day for a monthly charge', () => {
    renderPanel([charge()]);
    expect(screen.getByText(/day 15 of the month/)).toBeInTheDocument();
  });

  it('does not claim a usual day when every date differs', () => {
    renderPanel([
      charge({ dates: ['2026-04-03', '2026-05-15', '2026-06-27'] }),
    ]);
    expect(screen.queryByText(/of the month/)).toBeNull();
  });

  it('shows the next scheduled bill and links to Bills & Deposits', () => {
    renderPanel([], {
      date: '2026-08-15',
      amount: -16.99,
      currencyCode: 'CAD',
      payeeName: 'Netflix',
    });
    expect(screen.getByText('Next Bill')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Next Bill/ }));
    expect(mockPush).toHaveBeenCalledWith('/bills');
  });
});
