import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@/test/render';
import { IncomeExpensesBarChart } from './IncomeExpensesBarChart';

vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }: any) => <div data-testid="responsive-container">{children}</div>,
  BarChart: ({ children }: any) => <div data-testid="bar-chart">{children}</div>,
  Bar: () => null,
  XAxis: () => null,
  YAxis: () => null,
  CartesianGrid: () => null,
  Tooltip: () => null,
  Legend: () => null,
}));

vi.mock('@/hooks/useDateFormat', () => ({
  useDateFormat: () => ({ formatDate: (d: string) => d }),
}));

vi.mock('@/hooks/useNumberFormat', () => ({
  useNumberFormat: () => ({
    formatCurrencyCompact: (n: number) => `$${n.toFixed(0)}`,
    formatCurrencyAxis: (n: number) => `$${n}`,
  }),
}));

vi.mock('@/hooks/useExchangeRates', () => ({
  useExchangeRates: () => ({
    convertToDefault: (n: number) => n,
  }),
}));

vi.mock('@/lib/utils', () => ({
  parseLocalDate: (d: string) => new Date(d + 'T00:00:00'),
  cn: (...args: any[]) => args.filter(Boolean).join(' '),
}));

describe('IncomeExpensesBarChart', () => {
  it('renders loading state', () => {
    render(<IncomeExpensesBarChart transactions={[]} isLoading={true} />);
    expect(screen.getByText('Income vs Expenses')).toBeInTheDocument();
    expect(document.querySelector('.animate-pulse')).toBeInTheDocument();
  });

  it('renders chart when not loading', () => {
    render(<IncomeExpensesBarChart transactions={[]} isLoading={false} />);
    expect(screen.getByText('Income vs Expenses')).toBeInTheDocument();
    expect(screen.getByText('Past 30 days')).toBeInTheDocument();
    expect(screen.getByTestId('bar-chart')).toBeInTheDocument();
  });

  it('shows income, expenses, and net totals', () => {
    render(<IncomeExpensesBarChart transactions={[]} isLoading={false} />);
    expect(screen.getByText('Income')).toBeInTheDocument();
    expect(screen.getByText('Expenses')).toBeInTheDocument();
    expect(screen.getByText('Net')).toBeInTheDocument();
  });
});
