import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@/test/render';
import { NetWorthReport } from './NetWorthReport';

vi.mock('@/hooks/useNumberFormat', () => ({
  useNumberFormat: () => ({
    formatCurrencyCompact: (n: number) => `$${n.toFixed(0)}`,
    formatCurrency: (n: number) => `$${n.toFixed(2)}`,
    formatCurrencyAxis: (n: number) => `$${n}`,
    formatCurrencyLabel: (n: number) => `$${n.toFixed(0)}`,
    defaultCurrency: 'CAD',
  }),
}));

vi.mock('@/hooks/useDateRange', () => ({
  useDateRange: () => ({
    dateRange: '1y',
    setDateRange: vi.fn(),
    startDate: '',
    setStartDate: vi.fn(),
    endDate: '',
    setEndDate: vi.fn(),
    resolvedRange: { start: '2024-01-01', end: '2025-01-01' },
    isValid: true,
  }),
}));

vi.mock('@/lib/utils', () => ({
  parseLocalDate: (d: string) => new Date(d + 'T00:00:00'),
}));

vi.mock('@/components/ui/DateRangeSelector', () => ({
  DateRangeSelector: () => <div data-testid="date-range-selector" />,
}));

vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }: any) => <div data-testid="responsive-container">{children}</div>,
  AreaChart: ({ children }: any) => <div data-testid="area-chart">{children}</div>,
  Area: () => null,
  XAxis: () => null,
  YAxis: () => null,
  CartesianGrid: () => null,
  Tooltip: () => null,
  Legend: () => null,
  ReferenceLine: () => null,
  ReferenceDot: () => null,
}));

const mockGetMonthly = vi.fn();
const mockRecalculate = vi.fn();

vi.mock('@/lib/net-worth', () => ({
  netWorthApi: {
    getMonthly: (...args: any[]) => mockGetMonthly(...args),
    recalculate: (...args: any[]) => mockRecalculate(...args),
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

describe('NetWorthReport', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows loading state initially', () => {
    mockGetMonthly.mockReturnValue(new Promise(() => {}));
    render(<NetWorthReport />);
    expect(document.querySelector('.animate-pulse')).toBeTruthy();
  });

  it('renders empty state when no data', async () => {
    mockGetMonthly.mockResolvedValue([]);
    render(<NetWorthReport />);
    await waitFor(() => {
      expect(screen.getByText('No data for this period.')).toBeInTheDocument();
    });
  });

  it('renders summary cards and chart with data', async () => {
    mockGetMonthly.mockResolvedValue([
      { month: '2024-01-01', assets: 50000, liabilities: 10000, netWorth: 40000 },
      { month: '2024-06-01', assets: 55000, liabilities: 9000, netWorth: 46000 },
    ]);
    render(<NetWorthReport />);
    await waitFor(() => {
      expect(screen.getByText('Current Net Worth')).toBeInTheDocument();
    });
    expect(screen.getByText('Change')).toBeInTheDocument();
    expect(screen.getByText('Change %')).toBeInTheDocument();
  });

  it('renders recalculate button', async () => {
    mockGetMonthly.mockResolvedValue([]);
    render(<NetWorthReport />);
    await waitFor(() => {
      expect(screen.getByText('Recalculate')).toBeInTheDocument();
    });
  });
});
