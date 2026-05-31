import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@/test/render';
import { NetWorthReport } from './NetWorthReport';

vi.mock('@/lib/pdf-export', () => ({
  exportToPdf: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/components/ui/ChartViewToggle', () => ({
  ChartViewToggle: ({ value, onChange }: any) => (
    <div data-testid="chart-view-toggle">
      <button onClick={() => onChange('line')}>line</button>
      <button onClick={() => onChange('bar')}>bar</button>
      <button onClick={() => onChange('table')}>table</button>
      <span>val:{value}</span>
    </div>
  ),
}));

vi.mock('@/hooks/useNumberFormat', () => ({
  useNumberFormat: () => ({
    formatSignedPercent: (n: number, decimals = 2) => `${n >= 0 ? '+' : ''}${n.toFixed(decimals)}%`,
    formatCurrencyCompact: (n: number) => `$${n.toFixed(0)}`,
    formatCurrency: (n: number) => `$${n.toFixed(2)}`,
    formatCurrencyAxis: (n: number) => `$${n}`,
    formatCurrencyLabel: (n: number) => `$${n.toFixed(0)}`,
    defaultCurrency: 'CAD',
  }),
}));

const dateRangeMock = vi.hoisted(() => ({ value: '1y' }));
const STABLE_RANGE = { start: '2024-01-01', end: '2025-01-01' };
vi.mock('@/hooks/useDateRange', () => ({
  useDateRange: () => ({
    dateRange: dateRangeMock.value,
    setDateRange: vi.fn(),
    startDate: '',
    setStartDate: vi.fn(),
    endDate: '',
    setEndDate: vi.fn(),
    resolvedRange: STABLE_RANGE,
    isValid: true,
  }),
}));

vi.mock('@/lib/utils', () => ({
  parseLocalDate: (d: string) => new Date(d + 'T00:00:00'),
  cn: (...args: any[]) => args.filter(Boolean).join(' '),
}));

vi.mock('@/components/ui/DateRangeSelector', () => ({
  DateRangeSelector: () => <div data-testid="date-range-selector" />,
}));

vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }: any) => <div data-testid="responsive-container">{children}</div>,
  AreaChart: ({ children }: any) => <div data-testid="area-chart">{children}</div>,
  BarChart: ({ children }: any) => <div data-testid="bar-chart">{children}</div>,
  Area: () => null,
  Bar: ({ children }: any) => <div data-testid="bar">{children}</div>,
  LabelList: ({ formatter, angle }: any) => (
    <div data-testid="label-list" data-angle={angle}>{formatter ? String(formatter(1000)) : ''}</div>
  ),
  XAxis: ({ tickFormatter }: any) => {
    if (tickFormatter) {
      try { tickFormatter('Jan 2024'); tickFormatter('Jul 2024'); tickFormatter('NoSpace'); } catch {}
    }
    return null;
  },
  YAxis: ({ tickFormatter }: any) => <div>{tickFormatter ? tickFormatter(1000) : ''}</div>,
  CartesianGrid: () => null,
  Tooltip: ({ content, formatter }: any) => {
    if (typeof content === 'function') {
      try { content({ active: true, payload: [{ value: 100, name: 'NetWorth', color: '#000', payload: { name: 'Jan', NetWorth: 100, Assets: 200, Liabilities: 100 } }] }); content({ active: false, payload: [] }); } catch {}
    }
    if (formatter) {
      try { formatter(100, 'NetWorth'); } catch {}
    }
    return null;
  },
  Legend: () => null,
  ReferenceLine: () => null,
  ReferenceDot: () => null,
}));

function setMobile(isMobile: boolean) {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: isMobile && query === '(max-width: 639px)',
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
}

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
    dateRangeMock.value = '1y';
    setMobile(false);
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

  it('handles recalculate button click', async () => {
    mockGetMonthly.mockResolvedValue([
      { month: '2024-06-01', assets: 50000, liabilities: 10000, netWorth: 40000 },
    ]);
    mockRecalculate.mockResolvedValue(undefined);
    render(<NetWorthReport />);
    await waitFor(() => {
      expect(screen.getByText('Recalculate')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText('Recalculate'));
    await waitFor(() => {
      expect(mockRecalculate).toHaveBeenCalled();
    });
  });

  it('renders summary with negative net worth', async () => {
    mockGetMonthly.mockResolvedValue([
      { month: '2024-01-01', assets: 5000, liabilities: 50000, netWorth: -45000 },
      { month: '2024-06-01', assets: 6000, liabilities: 48000, netWorth: -42000 },
    ]);
    render(<NetWorthReport />);
    await waitFor(() => {
      expect(screen.getByText('Current Net Worth')).toBeInTheDocument();
    });
    expect(screen.getByText('Change')).toBeInTheDocument();
    expect(screen.getByText('Change %')).toBeInTheDocument();
  });

  it('renders chart with single data point', async () => {
    mockGetMonthly.mockResolvedValue([
      { month: '2024-01-01', assets: 50000, liabilities: 10000, netWorth: 40000 },
    ]);
    render(<NetWorthReport />);
    await waitFor(() => {
      expect(screen.getByText('Current Net Worth')).toBeInTheDocument();
    });
    expect(screen.getByTestId('bar-chart')).toBeInTheDocument();
  });

  it('handles recalculate error', async () => {
    mockGetMonthly.mockResolvedValue([]);
    mockRecalculate.mockRejectedValue(new Error('Recalculate failed'));
    render(<NetWorthReport />);
    await waitFor(() => {
      expect(screen.getByText('Recalculate')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText('Recalculate'));
    await waitFor(() => {
      expect(screen.getByText('Recalculate')).toBeInTheDocument();
    });
  });

  it('switches chart type to bar and back', async () => {
    mockGetMonthly.mockResolvedValue([
      { month: '2024-01-01', assets: 50000, liabilities: 10000, netWorth: 40000 },
      { month: '2024-06-01', assets: 55000, liabilities: 9000, netWorth: 46000 },
    ]);
    render(<NetWorthReport />);
    await waitFor(() => {
      expect(screen.getByText('Current Net Worth')).toBeInTheDocument();
    });
    await act(async () => {
      fireEvent.click(screen.getByText('bar'));
    });
    expect(screen.getByTestId('bar-chart')).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByText('line'));
    });
    expect(screen.getByTestId('area-chart')).toBeInTheDocument();
  });

  it('defaults to the bar chart view', async () => {
    mockGetMonthly.mockResolvedValue([
      { month: '2024-01-01', assets: 50000, liabilities: 10000, netWorth: 40000 },
      { month: '2024-06-01', assets: 55000, liabilities: 9000, netWorth: 46000 },
    ]);
    render(<NetWorthReport />);
    await waitFor(() => {
      expect(screen.getByText('Current Net Worth')).toBeInTheDocument();
    });
    expect(screen.getByTestId('bar-chart')).toBeInTheDocument();
    expect(screen.queryByTestId('area-chart')).not.toBeInTheDocument();
  });

  it('shows abbreviated value labels above bars for the 1-year range', async () => {
    dateRangeMock.value = '1y';
    mockGetMonthly.mockResolvedValue([
      { month: '2024-01-01', assets: 50000, liabilities: 10000, netWorth: 40000 },
      { month: '2024-06-01', assets: 55000, liabilities: 9000, netWorth: 46000 },
    ]);
    render(<NetWorthReport />);
    await waitFor(() => {
      expect(screen.getByText('Current Net Worth')).toBeInTheDocument();
    });
    expect(screen.getByTestId('label-list')).toBeInTheDocument();
  });

  it('keeps 1-year bar labels horizontal on non-mobile screens', async () => {
    dateRangeMock.value = '1y';
    setMobile(false);
    mockGetMonthly.mockResolvedValue([
      { month: '2024-01-01', assets: 50000, liabilities: 10000, netWorth: 40000 },
      { month: '2024-06-01', assets: 55000, liabilities: 9000, netWorth: 46000 },
    ]);
    render(<NetWorthReport />);
    await waitFor(() => {
      expect(screen.getByText('Current Net Worth')).toBeInTheDocument();
    });
    expect(screen.getByTestId('label-list')).toHaveAttribute('data-angle', '0');
  });

  it('rotates 1-year bar labels vertical on mobile', async () => {
    dateRangeMock.value = '1y';
    setMobile(true);
    mockGetMonthly.mockResolvedValue([
      { month: '2024-01-01', assets: 50000, liabilities: 10000, netWorth: 40000 },
      { month: '2024-06-01', assets: 55000, liabilities: 9000, netWorth: 46000 },
    ]);
    render(<NetWorthReport />);
    await waitFor(() => {
      expect(screen.getByText('Current Net Worth')).toBeInTheDocument();
    });
    expect(screen.getByTestId('label-list')).toHaveAttribute('data-angle', '-90');
  });

  it('shows abbreviated value labels above bars for the 2-year range', async () => {
    dateRangeMock.value = '2y';
    mockGetMonthly.mockResolvedValue([
      { month: '2024-01-01', assets: 50000, liabilities: 10000, netWorth: 40000 },
      { month: '2024-06-01', assets: 55000, liabilities: 9000, netWorth: 46000 },
    ]);
    render(<NetWorthReport />);
    await waitFor(() => {
      expect(screen.getByText('Current Net Worth')).toBeInTheDocument();
    });
    expect(screen.getByTestId('label-list')).toBeInTheDocument();
  });

  it('hides bar value labels for ranges longer than two years', async () => {
    dateRangeMock.value = '5y';
    mockGetMonthly.mockResolvedValue([
      { month: '2024-01-01', assets: 50000, liabilities: 10000, netWorth: 40000 },
      { month: '2024-06-01', assets: 55000, liabilities: 9000, netWorth: 46000 },
    ]);
    render(<NetWorthReport />);
    await waitFor(() => {
      expect(screen.getByText('Current Net Worth')).toBeInTheDocument();
    });
    expect(screen.getByTestId('bar-chart')).toBeInTheDocument();
    expect(screen.queryByTestId('label-list')).not.toBeInTheDocument();
  });

  it('exports pdf', async () => {
    const { exportToPdf } = await import('@/lib/pdf-export');
    (exportToPdf as any).mockClear();
    mockGetMonthly.mockResolvedValue([
      { month: '2024-01-01', assets: 50000, liabilities: 10000, netWorth: 40000 },
      { month: '2024-06-01', assets: 55000, liabilities: 9000, netWorth: 46000 },
    ]);
    render(<NetWorthReport />);
    await waitFor(() => {
      expect(screen.getByText('Current Net Worth')).toBeInTheDocument();
    });
    const exportBtn = screen.getByRole('button', { name: /export/i });
    await act(async () => {
      fireEvent.click(exportBtn);
    });
    const pdfBtn = screen.queryByText(/PDF/i);
    if (pdfBtn) {
      await act(async () => {
        fireEvent.click(pdfBtn);
      });
    }
    expect(exportToPdf).toHaveBeenCalled();
  });

  it('handles long ranges (>36 months) for tick formatter', async () => {
    const data = Array.from({ length: 40 }, (_, i) => ({
      month: `${2018 + Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}-01`,
      assets: 50000 + i * 100, liabilities: 10000, netWorth: 40000 + i * 100,
    }));
    mockGetMonthly.mockResolvedValue(data);
    render(<NetWorthReport />);
    await waitFor(() => {
      expect(screen.getByText('Current Net Worth')).toBeInTheDocument();
    });
  });

  it('handles medium ranges (19-36) for tick formatter', async () => {
    const data = Array.from({ length: 24 }, (_, i) => ({
      month: `2023-${String(((i % 12) + 1)).padStart(2, '0')}-01`,
      assets: 50000, liabilities: 10000, netWorth: 40000 + i * 50,
    }));
    mockGetMonthly.mockResolvedValue(data);
    render(<NetWorthReport />);
    await waitFor(() => {
      expect(screen.getByText('Current Net Worth')).toBeInTheDocument();
    });
  });

  it('renders with values that warrant non-zero y-axis domain', async () => {
    mockGetMonthly.mockResolvedValue([
      { month: '2024-01-01', assets: 100000, liabilities: 0, netWorth: 100000 },
      { month: '2024-06-01', assets: 105000, liabilities: 0, netWorth: 105000 },
    ]);
    render(<NetWorthReport />);
    await waitFor(() => {
      expect(screen.getByText('Current Net Worth')).toBeInTheDocument();
    });
  });

  it('handles loadData error', async () => {
    mockGetMonthly.mockRejectedValue(new Error('boom'));
    render(<NetWorthReport />);
    await waitFor(() => {
      expect(screen.getByText('Recalculate')).toBeInTheDocument();
    });
  });

  it('renders date range selector', async () => {
    mockGetMonthly.mockResolvedValue([]);
    render(<NetWorthReport />);
    await waitFor(() => {
      expect(screen.getByTestId('date-range-selector')).toBeInTheDocument();
    });
  });

  it('sorts table by date chronologically (not alphabetically)', async () => {
    // Months that would sort wrong alphabetically: "Apr 2021" < "Aug 2020".
    mockGetMonthly.mockResolvedValue([
      { month: '2020-08-01', assets: 1, liabilities: 0, netWorth: 1 },
      { month: '2021-04-01', assets: 2, liabilities: 0, netWorth: 2 },
      { month: '2020-04-01', assets: 3, liabilities: 0, netWorth: 3 },
      { month: '2021-08-01', assets: 4, liabilities: 0, netWorth: 4 },
    ]);
    render(<NetWorthReport />);
    await waitFor(() => {
      expect(screen.getByText('Current Net Worth')).toBeInTheDocument();
    });
    // Switch to the table view.
    await act(async () => {
      fireEvent.click(screen.getByText('table'));
    });
    const monthCells = screen.getAllByRole('cell').filter((td) =>
      /\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4}\b/.test(
        td.textContent ?? '',
      ),
    );
    const months = monthCells.map((td) => td.textContent?.trim() ?? '');
    expect(months).toEqual(['Apr 2020', 'Aug 2020', 'Apr 2021', 'Aug 2021']);
  });

  it('exercises every table-mode sort header and CSV export', async () => {
    mockGetMonthly.mockResolvedValue([
      { month: '2024-01-01', assets: 100, liabilities: 50, netWorth: 50 },
      { month: '2024-06-01', assets: 200, liabilities: 30, netWorth: 170 },
    ]);
    const { container } = render(<NetWorthReport />);
    await waitFor(() => expect(screen.getByText('Current Net Worth')).toBeInTheDocument());
    await act(async () => { fireEvent.click(screen.getByText('table')); });
    await waitFor(() => expect(container.querySelector('table')).toBeInTheDocument());
    const headerCount = container.querySelectorAll('th').length;
    for (let __i = 0; __i < headerCount; __i += 1) {
      const __ths = container.querySelectorAll('th');
      if (!__ths[__i]) break;
      await act(async () => { fireEvent.click(__ths[__i]); });
    }
    for (let __i = 0; __i < headerCount; __i += 1) {
      const __ths = container.querySelectorAll('th');
      if (!__ths[__i]) break;
      await act(async () => { fireEvent.click(__ths[__i]); });
    }
    // Find the export-pdf button (this test suite uses the real ExportDropdown,
    // but PDF export is the only mocked entry path)
    const exportBtn = screen.getByRole('button', { name: /export/i });
    await act(async () => { fireEvent.click(exportBtn); });
    // CSV button should appear in the dropdown for the table view path.
    const csvBtn = screen.queryByText(/CSV/i);
    if (csvBtn) {
      await act(async () => { fireEvent.click(csvBtn); });
    }
  });
});
