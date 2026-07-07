import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, screen } from '@testing-library/react';
import { render } from '@/test/render';
import { RecurringExpensesWidget } from './RecurringExpensesWidget';

vi.mock('recharts', async () => (await import('@/test/recharts-mock')).rechartsMock());
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));

const updateConfig = vi.fn();
vi.mock('@/hooks/useWidgetConfig', () => ({
  useWidgetConfig: () => ({ config: { minOccurrences: 3 }, updateConfig }),
}));
vi.mock('@/hooks/useNumberFormat', () => ({
  useNumberFormat: () => ({
    formatCurrency: (n: number) => `$${n}`,
    formatCurrencyCompact: (n: number) => `$${n}`,
  }),
}));

const getRecurringExpenses = vi.fn();
vi.mock('@/lib/built-in-reports', () => ({
  builtInReportsApi: { getRecurringExpenses: (...a: unknown[]) => getRecurringExpenses(...a) },
}));

async function renderWidget() {
  await act(async () => {
    render(<RecurringExpensesWidget isLoading={false} />);
  });
}

describe('RecurringExpensesWidget', () => {
  beforeEach(() => {
    getRecurringExpenses.mockReset();
    updateConfig.mockReset();
  });

  it('fetches with the configured minimum occurrences and renders the estimate', async () => {
    getRecurringExpenses.mockResolvedValue({
      data: [
        { payeeName: 'Netflix', payeeId: 'p1', occurrences: 6, totalAmount: 90, averageAmount: 15, lastTransactionDate: '2026-06-01', frequency: 'monthly', categoryName: 'Streaming' },
      ],
      summary: { totalRecurring: 90, monthlyEstimate: 15, uniquePayees: 1 },
    });
    await renderWidget();
    expect(screen.getByText('Top Recurring Expenses')).toBeInTheDocument();
    expect(getRecurringExpenses).toHaveBeenCalledWith(3);
    expect(screen.getByTestId('responsive-container')).toBeInTheDocument();
    expect(screen.getByText('$15')).toBeInTheDocument();
  });

  it('shows the empty state with no recurring expenses', async () => {
    getRecurringExpenses.mockResolvedValue({
      data: [],
      summary: { totalRecurring: 0, monthlyEstimate: 0, uniquePayees: 0 },
    });
    await renderWidget();
    expect(screen.getByText('No recurring expenses found.')).toBeInTheDocument();
  });
});
