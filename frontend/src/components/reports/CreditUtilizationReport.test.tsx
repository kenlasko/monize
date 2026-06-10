import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@/test/render';
import { CreditUtilizationReport } from './CreditUtilizationReport';

vi.mock('@/lib/pdf-export', () => ({
  exportToPdf: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/hooks/useNumberFormat', () => ({
  useNumberFormat: () => ({
    formatCurrency: (n: number, c?: string) => `${c ?? 'CAD'} ${n.toFixed(2)}`,
    formatCurrencyAxis: (n: number) => `$${n}`,
  }),
}));

// CAD is home; USD converts at 1.365. Conversion is identity-ish so the test
// can reason about magnitudes.
vi.mock('@/hooks/useExchangeRates', () => ({
  useExchangeRates: () => ({
    defaultCurrency: 'CAD',
    convert: (amount: number, from: string, to?: string) => {
      const target = to ?? 'CAD';
      if (from === target) return amount;
      if (from === 'USD' && target === 'CAD') return amount * 1.365;
      if (from === 'CAD' && target === 'USD') return amount / 1.365;
      return amount;
    },
  }),
}));

vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }: any) => <div data-testid="responsive-container">{children}</div>,
  BarChart: ({ children }: any) => <div data-testid="bar-chart">{children}</div>,
  Bar: ({ children }: any) => <div data-testid="bar">{children}</div>,
  PieChart: ({ children }: any) => <div data-testid="pie-chart">{children}</div>,
  Pie: ({ children }: any) => <div data-testid="pie">{children}</div>,
  Cell: () => null,
  XAxis: () => null,
  YAxis: () => null,
  CartesianGrid: () => null,
  ReferenceLine: () => null,
  Tooltip: ({ content }: any) => {
    if (typeof content === 'function') {
      // One payload shape serves both tooltips: the bar tooltip reads
      // used/available/utilizationPercent, the pie tooltip reads value/percent.
      return (
        <div>
          {content({ active: true, payload: [{ payload: { id: 'tip', name: 'TooltipAccount', used: 500, available: 4500, utilizationPercent: 10, value: 500, percent: 10 } }] })}
          {content({ active: false, payload: [] })}
        </div>
      );
    }
    return null;
  },
}));

const mockGetAll = vi.fn();

vi.mock('@/lib/accounts', () => ({
  accountsApi: {
    getAll: (...args: any[]) => mockGetAll(...args),
  },
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }),
}));

// Visa: CAD, owes 500 of 5000 (10%). Line of credit: CAD, owes 6000 of 10000 (60%).
const cadAccounts = [
  {
    id: 'a-1',
    name: 'Visa',
    accountType: 'CREDIT_CARD',
    accountSubType: null,
    currencyCode: 'CAD',
    currentBalance: -500,
    creditLimit: 5000,
    isClosed: false,
  },
  {
    id: 'a-2',
    name: 'Home LOC',
    accountType: 'LINE_OF_CREDIT',
    accountSubType: null,
    currencyCode: 'CAD',
    currentBalance: -6000,
    creditLimit: 10000,
    isClosed: false,
  },
];

// Adds a USD card so the mix forces conversion to the home currency.
const mixedAccounts = [
  ...cadAccounts,
  {
    id: 'a-3',
    name: 'US Amex',
    accountType: 'CREDIT_CARD',
    accountSubType: null,
    currencyCode: 'USD',
    currentBalance: -1000,
    creditLimit: 4000,
    isClosed: false,
  },
];

describe('CreditUtilizationReport', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows loading state initially', () => {
    mockGetAll.mockReturnValue(new Promise(() => {}));
    render(<CreditUtilizationReport />);
    expect(document.querySelector('.animate-pulse')).toBeTruthy();
  });

  it('renders empty state when no credit accounts', async () => {
    mockGetAll.mockResolvedValue([]);
    render(<CreditUtilizationReport />);
    await waitFor(() => {
      expect(screen.getByText(/No credit card or line of credit accounts/)).toBeInTheDocument();
    });
  });

  it('renders summary cards and per-account rows', async () => {
    mockGetAll.mockResolvedValue(cadAccounts);
    render(<CreditUtilizationReport />);
    await waitFor(() => {
      expect(screen.getByText('Total Credit Limit')).toBeInTheDocument();
    });
    expect(screen.getByText('Total Used')).toBeInTheDocument();
    expect(screen.getByText('Total Available')).toBeInTheDocument();
    expect(screen.getByText('Overall Utilization')).toBeInTheDocument();
    expect(screen.getByText('Visa')).toBeInTheDocument();
    expect(screen.getByText('Home LOC')).toBeInTheDocument();
  });

  it('computes overall utilization across accounts (6500 / 15000 = 43.3%)', async () => {
    mockGetAll.mockResolvedValue(cadAccounts);
    render(<CreditUtilizationReport />);
    await waitFor(() => {
      expect(screen.getByText('Total Credit Limit')).toBeInTheDocument();
    });
    // 6500 used / 15000 limit = 43.3%
    expect(screen.getAllByText('43.3%').length).toBeGreaterThanOrEqual(1);
    // Per-account utilization: Visa 10%, LOC 60%
    expect(screen.getByText('10.0%')).toBeInTheDocument();
    expect(screen.getByText('60.0%')).toBeInTheDocument();
  });

  it('shows amounts in the single shared currency without a conversion note', async () => {
    mockGetAll.mockResolvedValue(cadAccounts);
    render(<CreditUtilizationReport />);
    await waitFor(() => {
      expect(screen.getByText('Total Credit Limit')).toBeInTheDocument();
    });
    // All CAD: total limit 15000 rendered in CAD.
    expect(screen.getAllByText('CAD 15000.00').length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByText(/Amounts shown in/)).not.toBeInTheDocument();
  });

  it('falls back to home currency and shows a note for a mixed-currency selection', async () => {
    mockGetAll.mockResolvedValue(mixedAccounts);
    render(<CreditUtilizationReport />);
    await waitFor(() => {
      expect(screen.getByText('Total Credit Limit')).toBeInTheDocument();
    });
    // Mixed CAD + USD -> converted to CAD, note shown.
    expect(screen.getByText('Amounts shown in CAD.')).toBeInTheDocument();
  });

  it('renders the utilization bar chart', async () => {
    mockGetAll.mockResolvedValue(cadAccounts);
    render(<CreditUtilizationReport />);
    await waitFor(() => {
      expect(screen.getByText('Utilization by Account')).toBeInTheDocument();
    });
    expect(screen.getByTestId('bar-chart')).toBeInTheDocument();
  });

  it('renders the total utilization pie chart alongside the bar chart', async () => {
    mockGetAll.mockResolvedValue(cadAccounts);
    render(<CreditUtilizationReport />);
    await waitFor(() => {
      expect(screen.getByText('Total Utilization')).toBeInTheDocument();
    });
    expect(screen.getByTestId('pie-chart')).toBeInTheDocument();
    // Donut centre repeats the overall utilization (6500 / 15000 = 43.3%),
    // which also appears in the summary card and the table footer.
    expect(screen.getAllByText('43.3%').length).toBeGreaterThanOrEqual(3);
    // Legend lists used and available totals next to their slice labels.
    expect(screen.getAllByText('Used').length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText('Available').length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText('CAD 6500.00').length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText('CAD 8500.00').length).toBeGreaterThanOrEqual(2);
  });

  it('exports pdf through the export pipeline', async () => {
    const { exportToPdf } = await import('@/lib/pdf-export');
    (exportToPdf as any).mockClear();
    mockGetAll.mockResolvedValue(cadAccounts);
    render(<CreditUtilizationReport />);
    await waitFor(() => {
      expect(screen.getByText('Total Credit Limit')).toBeInTheDocument();
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /export pdf/i }));
    });
    await waitFor(() => expect(exportToPdf).toHaveBeenCalledTimes(1));
    const arg = (exportToPdf as any).mock.calls[0][0];
    expect(arg.title).toBe('Credit Utilization');
    expect(arg.filename).toBe('credit-utilization');
    expect(arg.tableData.rows.length).toBe(2);
  });

  it('exercises every sortable column', async () => {
    mockGetAll.mockResolvedValue(cadAccounts);
    let container!: HTMLElement;
    await act(async () => {
      ({ container } = render(<CreditUtilizationReport />));
    });
    await waitFor(() => expect(container.querySelector('table')).toBeInTheDocument());
    const headerCount = container.querySelectorAll('table thead th').length;
    expect(headerCount).toBeGreaterThan(0);
    for (let pass = 0; pass < 2; pass += 1) {
      for (let i = 0; i < headerCount; i += 1) {
        const ths = container.querySelectorAll('table thead th');
        if (!ths[i]) break;
        await act(async () => { fireEvent.click(ths[i]); });
      }
    }
  });

  it('handles a load error', async () => {
    mockGetAll.mockRejectedValue(new Error('boom'));
    render(<CreditUtilizationReport />);
    await waitFor(() => {
      expect(screen.getByText(/Failed to load report data/)).toBeInTheDocument();
    });
  });
});
