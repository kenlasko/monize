import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@/test/render';
import { YearOverYearReport } from './YearOverYearReport';

vi.mock('@/hooks/useNumberFormat', () => ({
  useNumberFormat: () => ({
    formatCurrencyCompact: (n: number) => `$${n.toFixed(0)}`,
    formatCurrency: (n: number) => `$${n.toFixed(2)}`,
    formatCurrencyAxis: (n: number) => `$${n}`,
    defaultCurrency: 'CAD',
  }),
}));

vi.mock('@/lib/chart-colours', () => ({
  CHART_COLOURS: ['#3b82f6', '#ef4444', '#22c55e', '#f97316'],
}));

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

const mockGetYearOverYear = vi.fn();

vi.mock('@/lib/built-in-reports', () => ({
  builtInReportsApi: {
    getYearOverYear: (...args: any[]) => mockGetYearOverYear(...args),
  },
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  }),
}));

describe('YearOverYearReport', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows loading state initially', () => {
    mockGetYearOverYear.mockReturnValue(new Promise(() => {}));
    render(<YearOverYearReport />);
    expect(document.querySelector('.animate-pulse')).toBeTruthy();
  });

  it('renders year cards and chart with data', async () => {
    mockGetYearOverYear.mockResolvedValue({
      data: [
        { year: 2024, months: [{ month: 1, expenses: 3000, income: 5000, savings: 2000 }], totals: { income: 50000, expenses: 30000, savings: 20000 } },
        { year: 2025, months: [{ month: 1, expenses: 3500, income: 5500, savings: 2000 }], totals: { income: 55000, expenses: 35000, savings: 20000 } },
      ],
    });
    render(<YearOverYearReport />);
    await waitFor(() => {
      expect(screen.getByText('2024')).toBeInTheDocument();
    });
    expect(screen.getByText('2025')).toBeInTheDocument();
  });

  it('renders metric toggle buttons', async () => {
    mockGetYearOverYear.mockResolvedValue({ data: [] });
    render(<YearOverYearReport />);
    await waitFor(() => {
      expect(screen.getByText('expenses')).toBeInTheDocument();
    });
    expect(screen.getByText('income')).toBeInTheDocument();
    expect(screen.getByText('savings')).toBeInTheDocument();
  });

  it('renders year comparison table when multiple years', async () => {
    mockGetYearOverYear.mockResolvedValue({
      data: [
        { year: 2024, months: [], totals: { income: 50000, expenses: 30000, savings: 20000 } },
        { year: 2025, months: [], totals: { income: 55000, expenses: 35000, savings: 20000 } },
      ],
    });
    render(<YearOverYearReport />);
    await waitFor(() => {
      expect(screen.getByText('Year-over-Year Change')).toBeInTheDocument();
    });
  });
});
