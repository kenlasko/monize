import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, screen } from '@testing-library/react';
import { render } from '@/test/render';
import { MonthlySpendingTrendWidget } from './MonthlySpendingTrendWidget';

vi.mock('recharts', async () => (await import('@/test/recharts-mock')).rechartsMock());

vi.mock('@/hooks/useWidgetConfig', () => ({
  useWidgetConfig: () => ({ config: { range: '1y' }, updateConfig: vi.fn() }),
}));
vi.mock('@/hooks/useChartDateFormat', () => ({
  useChartDateFormat: () => () => 'Jan 2026',
}));
vi.mock('@/hooks/useNumberFormat', () => ({
  useNumberFormat: () => ({
    formatCurrency: (n: number) => `$${n}`,
    formatCurrencyAxis: (n: number) => `$${n}`,
  }),
}));

const getIncomeVsExpenses = vi.fn();
vi.mock('@/lib/built-in-reports', () => ({
  builtInReportsApi: { getIncomeVsExpenses: (...a: unknown[]) => getIncomeVsExpenses(...a) },
}));

async function renderWidget() {
  await act(async () => {
    render(<MonthlySpendingTrendWidget isLoading={false} />);
  });
}

describe('MonthlySpendingTrendWidget', () => {
  beforeEach(() => getIncomeVsExpenses.mockReset());

  it('renders the chart for the configured month range', async () => {
    getIncomeVsExpenses.mockResolvedValue({
      data: [{ month: '2026-01', income: 5000, expenses: 3000, net: 2000 }],
      totals: { income: 5000, expenses: 3000, net: 2000 },
    });
    await renderWidget();
    expect(screen.getByText('Monthly Spending Trend')).toBeInTheDocument();
    expect(getIncomeVsExpenses).toHaveBeenCalled();
    expect(screen.getByTestId('responsive-container')).toBeInTheDocument();
  });

  it('shows the empty state with no data', async () => {
    getIncomeVsExpenses.mockResolvedValue({ data: [], totals: { income: 0, expenses: 0, net: 0 } });
    await renderWidget();
    expect(screen.getByText('No data for this period.')).toBeInTheDocument();
  });
});
