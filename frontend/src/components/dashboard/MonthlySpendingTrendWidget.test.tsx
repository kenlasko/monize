import type { ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, screen } from '@testing-library/react';
import { render } from '@/test/render';
import { MonthlySpendingTrendWidget } from './MonthlySpendingTrendWidget';

// What the chart was last given: its rows and its tooltip, so a test can
// render what the reader sees on hover.
const drawn = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  tooltip: null as null | ((props: { active: boolean; payload: unknown[] }) => ReactNode),
}));
vi.mock('recharts', async () => ({
  ...(await import('@/test/recharts-mock')).rechartsMock(),
  LineChart: ({ children, data }: { children?: ReactNode; data: Array<Record<string, unknown>> }) => {
    drawn.rows = data;
    return <div>{children}</div>;
  },
  Tooltip: ({ content }: { content: typeof drawn.tooltip }) => {
    drawn.tooltip = content;
    return null;
  },
}));

vi.mock('@/hooks/useWidgetConfig', () => ({
  useWidgetConfig: () => ({ config: { range: '1y' }, updateConfig: vi.fn() }),
}));
vi.mock('@/hooks/useChartDateFormat', () => ({
  useChartDateFormat: () => () => 'Jan 2026',
}));
vi.mock('@/hooks/useNumberFormat', async () => {
  const { numberFormatMockDefaults } = await import('@/test/number-format-mock');
  return {
    useNumberFormat: () => ({
      ...numberFormatMockDefaults(),
      formatCurrency: (n: number) => `$${n}`,
      formatCurrencyAxis: (n: number) => `$${n}`,
    }),
  };
});
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
      data: [{ period: '2026-01', periodStart: '2026-01-01', periodEnd: '2026-01-31', income: 5000, expenses: 3000, net: 2000 }],
      totals: { income: 5000, expenses: 3000, net: 2000, knownIncome: 5000, knownExpenses: 3000, knownNet: 2000 },
    });
    await renderWidget();
    expect(screen.getByText('Monthly Spending Trend')).toBeInTheDocument();
    expect(screen.getByText('1Y')).toBeInTheDocument();
    expect(getIncomeVsExpenses).toHaveBeenCalled();
    expect(screen.getByTestId('responsive-container')).toBeInTheDocument();
  });

  it('tells the reader when rows without a rate were left out', async () => {
    getIncomeVsExpenses.mockResolvedValue({
      data: [{ period: '2026-01', periodStart: '2026-01-01', periodEnd: '2026-01-31', income: 5000, expenses: 3000, net: 2000 }],
      totals: { income: null, expenses: null, net: null, knownIncome: 5000, knownExpenses: 3000, knownNet: 2000 },
      currency: 'USD',
      missingCurrencies: ['JPY'],
      excludedCount: 1,
    });
    await renderWidget();
    expect(screen.getByText(/JPY/)).toBeInTheDocument();
  });

  it("prints the server's figures in the tooltip, not their whole units (issue #2412)", async () => {
    // Rounded to whole units, 1,234.56 and 10.40 were printed at full precision
    // as 1,235 and 10.
    getIncomeVsExpenses.mockResolvedValue({
      data: [{ period: '2026-01', periodStart: '2026-01-01', periodEnd: '2026-01-31', income: 1234.56, expenses: 10.4, net: 1224.16 }],
      totals: { income: 1234.56, expenses: 10.4, net: 1224.16, knownIncome: 1234.56, knownExpenses: 10.4, knownNet: 1224.16 },
    });
    await renderWidget();
    const row = drawn.rows[0];
    render(
      <>
        {drawn.tooltip!({
          active: true,
          payload: [
            { name: 'Expenses', value: row.Expenses, color: '#000', payload: row },
            { name: 'Income', value: row.Income, color: '#000', payload: row },
          ],
        })}
      </>,
    );
    expect(screen.getByText(/\$10\.4$/)).toBeInTheDocument();
    expect(screen.getByText(/\$1234\.56$/)).toBeInTheDocument();
  });

  it('shows the empty state with no data', async () => {
    getIncomeVsExpenses.mockResolvedValue({ data: [], totals: { income: 0, expenses: 0, net: 0, knownIncome: 0, knownExpenses: 0, knownNet: 0 } });
    await renderWidget();
    expect(screen.getByText('No data for this period.')).toBeInTheDocument();
  });
});
