import { cloneElement, type ReactElement } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act, within } from '@/test/render';
import { NetWorthReport } from './NetWorthReport';

vi.mock('@/lib/pdf-export', () => ({
  exportToPdf: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/csv-export', () => ({
  exportToCsv: vi.fn(),
}));

vi.mock('@/components/ui/ChartViewToggle', () => ({
  ChartViewToggle: ({ value, onChange }: any) => (
    <div data-testid="chart-view-toggle">
      <button onClick={() => onChange('line')}>line</button>
      <button onClick={() => onChange('bar')}>bar</button>
      <button onClick={() => onChange('stacked')}>stacked</button>
      <button onClick={() => onChange('table')}>table</button>
      <span>val:{value}</span>
    </div>
  ),
}));

vi.mock('@/hooks/useNumberFormat', async () => {
  const { numberFormatMockDefaults } = await import('@/test/number-format-mock');
  return {
    useNumberFormat: () => ({
      ...numberFormatMockDefaults(),
      formatSignedPercent: (n: number, decimals = 2) => `${n >= 0 ? '+' : ''}${n.toFixed(decimals)}%`,
      formatCurrencyCompact: (n: number) => `$${n.toFixed(0)}`,
      formatCurrency: (n: number) => `$${n.toFixed(2)}`,
      formatCurrencyAxis: (n: number) => `$${n}`,
      formatCurrencyLabel: (n: number) => `$${n.toFixed(0)}`,
      defaultCurrency: 'CAD',
    }),
  };
});
const dateRangeMock = vi.hoisted(() => ({ value: '1y' }));
// The selection the mocked range hook reports; a test moves it and re-renders.
const rangeMock = { end: '2025-01-01' };
const STABLE_RANGE = {
  start: '2024-01-01',
  get end() { return rangeMock.end; },
};
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

vi.mock('@/lib/utils', async (importActual) => ({
  ...(await importActual<typeof import('@/lib/utils')>()),
  parseLocalDate: (d: string) => new Date(d + 'T00:00:00'),
  cn: (...args: any[]) => args.filter(Boolean).join(' '),
}));

vi.mock('@/components/ui/DateRangeSelector', () => ({
  DateRangeSelector: ({ ranges }: any) => (
    <div data-testid="date-range-selector" data-ranges={(ranges ?? []).join(',')} />
  ),
}));

// The composition view's tooltip element, so a case can render it over a row
// the chart was given.
let lastCompositionTooltip: ReactElement | null = null;

vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }: any) => <div data-testid="responsive-container">{children}</div>,
  AreaChart: ({ children, data }: any) => <div data-testid="area-chart" data-points={JSON.stringify(data)}>{children}</div>,
  BarChart: ({ children, data }: any) => <div data-testid="bar-chart" data-points={JSON.stringify(data)}>{children}</div>,
  ComposedChart: ({ children, data }: any) => <div data-testid="composed-chart" data-points={JSON.stringify(data)}>{children}</div>,
  Line: ({ children }: any) => <div>{children}</div>,
  Area: () => null,
  Bar: ({ children }: any) => <div data-testid="bar">{children}</div>,
  LabelList: ({ formatter, angle }: any) => (
    <div data-testid="label-list" data-angle={angle}>{formatter ? String(formatter(1000)) : ''}</div>
  ),
  XAxis: ({ tickFormatter }: any) => {
    if (tickFormatter) {
      // The axis is keyed off the raw ISO month (YYYY-MM-DD), so exercise the
      // formatter with raw values rather than pre-localized labels.
      try { tickFormatter('2024-01-01'); tickFormatter('2024-07-01'); } catch {}
    }
    return null;
  },
  YAxis: ({ tickFormatter }: any) => <div>{tickFormatter ? tickFormatter(1000) : ''}</div>,
  CartesianGrid: () => null,
  Tooltip: ({ content, formatter }: any) => {
    if (content?.type?.name === 'CompositionTooltip') lastCompositionTooltip = content;
    // `content` is a React element (e.g. <NetWorthTooltip formatCurrency={...} />);
    // invoke its function component with the element's own props, as Recharts
    // does, so the tooltip's render branches are exercised in tests.
    const fn = typeof content === 'function' ? content : content?.type;
    if (typeof fn === 'function') {
      const props = typeof content === 'function' ? {} : content?.props;
      try { fn({ ...props, active: true, payload: [{ value: 100, name: 'NetWorth', color: '#000', payload: { name: 'Jan', NetWorth: 100, Assets: 200, Liabilities: 100 } }] }); fn({ ...props, active: false, payload: [] }); } catch {}
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
    window.localStorage.clear();
    dateRangeMock.value = '1y';
    rangeMock.end = '2025-01-01';
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
    expect(screen.getByTestId('composed-chart')).toBeInTheDocument();
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
    expect(screen.getByTestId('composed-chart')).toBeInTheDocument();
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
    expect(screen.getByTestId('composed-chart')).toBeInTheDocument();
    expect(screen.queryByTestId('area-chart')).not.toBeInTheDocument();
  });

  it('stacks the bar view by account type from the server breakdown', async () => {
    mockGetMonthly.mockResolvedValue([
      {
        month: '2024-01-01',
        assets: 55000,
        liabilities: 10000,
        netWorth: 45000,
        byAccountType: { CHEQUING: 5000, INVESTMENT: 50000, CREDIT_CARD: -10000 },
      },
      {
        month: '2024-06-01',
        assets: 60000,
        liabilities: 9000,
        netWorth: 51000,
        byAccountType: { CHEQUING: 6000, INVESTMENT: 54000, CREDIT_CARD: -9000 },
      },
    ]);
    render(<NetWorthReport />);
    await waitFor(() => {
      expect(screen.getByText('Current Net Worth')).toBeInTheDocument();
    });
    expect(screen.getByTestId('composed-chart')).toBeInTheDocument();
    // One stacked series per account type held.
    expect(screen.getAllByTestId('bar')).toHaveLength(3);
  });

  it('switches the bar view to one solid net worth bar a month and persists the choice', async () => {
    mockGetMonthly.mockResolvedValue([
      {
        month: '2024-01-01',
        assets: 55000,
        liabilities: 10000,
        netWorth: 45000,
        byAccountType: { CHEQUING: 5000, INVESTMENT: 50000, CREDIT_CARD: -10000 },
      },
      {
        month: '2024-06-01',
        assets: 60000,
        liabilities: 9000,
        netWorth: 51000,
        byAccountType: { CHEQUING: 6000, INVESTMENT: 54000, CREDIT_CARD: -9000 },
      },
    ]);
    render(<NetWorthReport />);
    await waitFor(() => {
      expect(screen.getByText('Current Net Worth')).toBeInTheDocument();
    });
    const group = screen.getByRole('group', { name: 'Bar style' });
    expect(screen.getByRole('button', { name: 'By account type' })).toHaveAttribute('aria-pressed', 'true');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Net worth' }));
    });
    expect(screen.getAllByTestId('bar')).toHaveLength(1);
    expect(window.localStorage.getItem('reports.net-worth.barStyle')).toBe('"netWorth"');
    expect(group).toBeInTheDocument();
  });

  it('offers the bar style only in the bar view', async () => {
    mockGetMonthly.mockResolvedValue([
      { month: '2024-01-01', assets: 50000, liabilities: 10000, netWorth: 40000 },
      { month: '2024-06-01', assets: 55000, liabilities: 9000, netWorth: 46000 },
    ]);
    render(<NetWorthReport />);
    await waitFor(() => {
      expect(screen.getByText('Current Net Worth')).toBeInTheDocument();
    });
    await act(async () => {
      fireEvent.click(screen.getByText('line'));
    });
    expect(screen.queryByRole('group', { name: 'Bar style' })).not.toBeInTheDocument();
  });

  it('offers a ten-year window', async () => {
    mockGetMonthly.mockResolvedValue([]);
    render(<NetWorthReport />);
    await waitFor(() => {
      expect(screen.getByTestId('date-range-selector')).toHaveAttribute('data-ranges', '1y,2y,5y,10y,all');
    });
  });

  it('switches to the 100% stacked composition view and persists the choice', async () => {
    mockGetMonthly.mockResolvedValue([
      { month: '2024-01-01', assets: 50000, liabilities: 10000, netWorth: 40000 },
      { month: '2024-06-01', assets: 55000, liabilities: 9000, netWorth: 46000 },
    ]);
    render(<NetWorthReport />);
    await waitFor(() => {
      expect(screen.getByText('Current Net Worth')).toBeInTheDocument();
    });
    await act(async () => {
      fireEvent.click(screen.getByText('stacked'));
    });
    // The stacked view renders two series (Assets + Liabilities) rather than one.
    expect(screen.getByTestId('bar-chart')).toBeInTheDocument();
    expect(screen.getAllByTestId('bar')).toHaveLength(2);
    expect(window.localStorage.getItem('reports.net-worth.chartType')).toBe('"stacked"');
  });

  it('restores the stacked composition view from localStorage', async () => {
    window.localStorage.setItem('reports.net-worth.chartType', '"stacked"');
    mockGetMonthly.mockResolvedValue([
      { month: '2024-01-01', assets: 50000, liabilities: 10000, netWorth: 40000 },
      { month: '2024-06-01', assets: 55000, liabilities: 9000, netWorth: 46000 },
    ]);
    render(<NetWorthReport />);
    await waitFor(() => {
      expect(screen.getByText('Current Net Worth')).toBeInTheDocument();
    });
    expect(screen.getAllByTestId('bar')).toHaveLength(2);
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
    expect(screen.getByTestId('composed-chart')).toBeInTheDocument();
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
      expect(screen.getByText(/Failed to load report data/i)).toBeInTheDocument();
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

describe('NetWorthReport completeness', () => {
  const complete = {
    month: '2024-11-01', assets: 50000, liabilities: 0, netWorth: 50000,
    fxComplete: true, missingRatePairs: [] as string[],
  };
  const partial = {
    month: '2024-12-01', assets: 50000, liabilities: 0, netWorth: 50000,
    fxComplete: false, missingRatePairs: ['ZZZ->USD'],
  };

  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    dateRangeMock.value = '1y';
    setMobile(false);
  });

  async function renderReport(months: unknown[]) {
    mockGetMonthly.mockResolvedValue(months);
    await act(async () => {
      render(<NetWorthReport />);
    });
    await waitFor(() => expect(screen.getByText('Current Net Worth')).toBeInTheDocument());
  }

  const card = (label: string) => screen.getByText(label).parentElement as HTMLElement;

  async function exportAs(kind: RegExp) {
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /export/i }));
    });
    await act(async () => {
      fireEvent.click(screen.getByText(kind));
    });
  }

  it('marks the headline partial and names the missing currency when the latest month is a subtotal', async () => {
    await renderReport([complete, partial]);
    const headline = card('Current Net Worth');
    expect(within(headline).getByTestId('partial-total')).toBeInTheDocument();
    expect(within(headline).getByRole('button').getAttribute('aria-label')).toContain('ZZZ');
    expect(screen.getByTestId('partial-data-notice')).toHaveTextContent('ZZZ');
  });

  it('withholds the change and the percent when an end month is partial', async () => {
    await renderReport([complete, partial]);
    expect(within(card('Change')).getByTestId('unknown-amount')).toBeInTheDocument();
    expect(card('Change')).not.toHaveTextContent('$0');
    expect(within(card('Change %')).getByTestId('unknown-amount')).toBeInTheDocument();
    expect(card('Change %')).not.toHaveTextContent(/\d%/);
  });

  it('withholds the change when only the first month is partial', async () => {
    await renderReport([partial, { ...complete, month: '2025-01-01' }]);
    expect(within(card('Change')).getByTestId('unknown-amount')).toBeInTheDocument();
    expect(within(card('Current Net Worth')).queryByTestId('partial-total')).not.toBeInTheDocument();
  });

  it('renders no marker for a complete series', async () => {
    await renderReport([complete, { ...complete, month: '2024-12-01', netWorth: 52000 }]);
    expect(screen.queryByTestId('partial-total')).not.toBeInTheDocument();
    expect(screen.queryByTestId('unknown-amount')).not.toBeInTheDocument();
    expect(screen.queryByTestId('partial-data-notice')).not.toBeInTheDocument();
    expect(card('Change')).toHaveTextContent('+$2000');
  });

  it('reads an absent flag as no information, not as partial', async () => {
    await renderReport([
      { month: '2024-11-01', assets: 1, liabilities: 0, netWorth: 1 },
      { month: '2024-12-01', assets: 2, liabilities: 0, netWorth: 2 },
    ]);
    expect(screen.queryByTestId('partial-total')).not.toBeInTheDocument();
    expect(screen.queryByTestId('unknown-amount')).not.toBeInTheDocument();
  });

  it('marks only the partial month in the table', async () => {
    await renderReport([complete, partial]);
    await act(async () => { fireEvent.click(screen.getByText('table')); });
    const rows = screen.getAllByRole('row').slice(1);
    expect(rows).toHaveLength(2);
    const byMonth = (label: string) =>
      rows.find((r) => r.textContent?.includes(label)) as HTMLElement;
    expect(within(byMonth('Dec 2024')).getAllByTestId('partial-total').length).toBeGreaterThan(0);
    expect(within(byMonth('Nov 2024')).queryByTestId('partial-total')).not.toBeInTheDocument();
  });

  it('draws a partial month as null, never as a measured dip', async () => {
    await renderReport([complete, partial]);
    const bar = JSON.parse(screen.getByTestId('composed-chart').getAttribute('data-points')!);
    expect(bar.map((p: { netWorth: number | null }) => p.netWorth)).toEqual([50000, null]);
    expect(bar[1].byAccountType).toBeUndefined();

    await act(async () => { fireEvent.click(screen.getByText('line')); });
    const area = JSON.parse(screen.getByTestId('area-chart').getAttribute('data-points')!);
    expect(area.map((p: { NetWorth: number | null }) => p.NetWorth)).toEqual([50000, null]);
    expect(area[1].Assets).toBeNull();
    expect(area[1].Liabilities).toBeNull();
  });

  it('labels the partial figure in the PDF and withholds the change', async () => {
    const { exportToPdf } = await import('@/lib/pdf-export');
    await renderReport([complete, partial]);
    await exportAs(/PDF/i);
    expect(exportToPdf).toHaveBeenCalledTimes(1);
    const cards = (exportToPdf as any).mock.calls[0][0].summaryCards as Array<{ label: string; value: string; note?: string }>;
    const current = cards.find((c) => c.label === 'Current Net Worth')!;
    expect(current.note).toContain('ZZZ');
    expect(cards.find((c) => c.label === 'Change')!.value).not.toContain('$0');
    expect(cards.find((c) => c.label === 'Change %')!.value).not.toMatch(/\d%/);
  });

  it('adds no note to the PDF of a complete series', async () => {
    const { exportToPdf } = await import('@/lib/pdf-export');
    await renderReport([complete, { ...complete, month: '2024-12-01', netWorth: 52000 }]);
    await exportAs(/PDF/i);
    const cards = (exportToPdf as any).mock.calls[0][0].summaryCards as Array<{ note?: string }>;
    expect(cards.every((c) => c.note === undefined)).toBe(true);
  });

  it('marks the partial month in the CSV', async () => {
    const { exportToCsv } = await import('@/lib/csv-export');
    await renderReport([complete, partial]);
    await act(async () => { fireEvent.click(screen.getByText('table')); });
    await exportAs(/CSV/i);
    const [, headers, rows] = (exportToCsv as any).mock.calls[0] as [string, string[], unknown[][]];
    expect(headers).toContain('Note');
    const dec = rows.find((r) => String(r[0]).includes('Dec 2024'))!;
    const nov = rows.find((r) => String(r[0]).includes('Nov 2024'))!;
    expect(String(dec[dec.length - 1])).toContain('ZZZ');
    expect(nov[nov.length - 1]).toBe('');
  });
});


describe('NetWorthReport: figures from the server, not from whole units (issue #2412)', () => {
  // Each figure sits a fraction off a whole unit: rounded to whole units, the
  // first month read 100 and the last 101, a change of 1; the server's change
  // is 0.20. The last month's sides, 10.60 and 0.40, read 11 and 0, a net of
  // 11 where the month's own net worth is 10.20.
  const first = { month: '2024-11-01', assets: 100.4, liabilities: 0, netWorth: 100.4, fxComplete: true, missingRatePairs: [] };
  const last = {
    month: '2024-12-01', assets: 100.6, liabilities: 0, netWorth: 100.6,
    fxComplete: true, missingRatePairs: [], netWorthChange: 0.2, netWorthChangeFromStart: 0.2,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    dateRangeMock.value = '1y';
    rangeMock.end = '2025-01-01';
    setMobile(false);
  });

  async function renderReport(months: unknown[]) {
    mockGetMonthly.mockResolvedValue(months);
    await act(async () => {
      render(<NetWorthReport />);
    });
    await waitFor(() => expect(screen.getByText('Current Net Worth')).toBeInTheDocument());
  }

  const card = (label: string) => screen.getByText(label).parentElement as HTMLElement;

  it("reads the window's change from the server", async () => {
    // 100.404 and 100.898 read 100.40 and 100.90, half a unit apart; the
    // change itself, 0.494, reads 0.49.
    await renderReport([first, { ...last, assets: 100.9, netWorth: 100.9, netWorthChangeFromStart: 0.49 }]);
    expect(card('Change')).toHaveTextContent('+$0');
    expect(card('Change')).not.toHaveTextContent('+$1');
  });

  it('takes the difference of the two readings from an older backend, not of whole units', async () => {
    const { netWorthChangeFromStart: _omitted, ...older } = last;
    await renderReport([first, older]);
    expect(card('Change')).toHaveTextContent('+$0');
  });

  it("prints the month's own net worth in the composition tooltip", async () => {
    await renderReport([first, { ...last, assets: 10.6, liabilities: 0.4, netWorth: 10.2 }]);
    await act(async () => { fireEvent.click(screen.getByText('stacked')); });
    const rows = JSON.parse(screen.getByTestId('bar-chart').getAttribute('data-points')!);
    render(cloneElement(lastCompositionTooltip as ReactElement<any>, { active: true, payload: [{ payload: rows[1] }] }));
    const lines = Array.from(document.querySelectorAll('p')).map((p) => p.textContent);
    expect(lines).toContain('Net Worth: $10');
  });

  it("writes each month's server figures to the CSV", async () => {
    const { exportToCsv } = await import('@/lib/csv-export');
    await renderReport([first, { ...last, assets: 10.6, liabilities: 0.4, netWorth: 10.2 }]);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /export/i }));
    });
    await act(async () => {
      fireEvent.click(screen.getByText(/CSV/i));
    });
    const [, , rows] = (exportToCsv as any).mock.calls[0] as [string, string[], unknown[][]];
    expect(rows.map((r) => r.slice(1, 4))).toEqual([
      [100.4, 0, 100.4],
      [10.6, 0.4, 10.2],
    ]);
  });
});

describe('NetWorthReport: a reload is not the previous answer', () => {
  const answer = [
    { month: '2024-01-01', assets: 50000, liabilities: 10000, netWorth: 40000 },
    { month: '2024-06-01', assets: 55000, liabilities: 9000, netWorth: 46000 },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    dateRangeMock.value = '1y';
    rangeMock.end = '2025-01-01';
    setMobile(false);
  });

  async function loadThenChangeRange(next: () => unknown) {
    mockGetMonthly.mockResolvedValue(answer);
    let view!: ReturnType<typeof render>;
    await act(async () => {
      view = render(<NetWorthReport />);
    });
    await screen.findByText('Current Net Worth');
    expect(screen.getByTitle('Export report')).toBeEnabled();

    mockGetMonthly.mockImplementation(next);
    rangeMock.end = '2025-02-01';
    await act(async () => {
      view.rerender(<NetWorthReport />);
    });
    await waitFor(() =>
      expect(mockGetMonthly).toHaveBeenLastCalledWith({ startDate: '2024-01-01', endDate: '2025-02-01' }),
    );
  }

  it('disables the export while the next request has failed', async () => {
    await loadThenChangeRange(() => Promise.reject(new Error('500')));
    expect(screen.getByTitle('Export report')).toBeDisabled();
  });

  it('disables the export while the next request is pending', async () => {
    await loadThenChangeRange(() => new Promise(() => {}));
    expect(screen.getByTitle('Export report')).toBeDisabled();
  });
});
