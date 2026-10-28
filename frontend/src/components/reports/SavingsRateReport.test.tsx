import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@/test/render';
import { SavingsRateReport } from './SavingsRateReport';
import type { Budget, SavingsRatePoint } from '@/types/budget';

const mockGetAll = vi.fn();
const mockGetSavingsRate = vi.fn();
const mockExportToPdf = vi.fn();

vi.mock('@/lib/budgets', () => ({
  budgetsApi: {
    getAll: (...args: any[]) => mockGetAll(...args),
    getSavingsRate: (...args: any[]) => mockGetSavingsRate(...args),
  },
}));

vi.mock('@/hooks/useNumberFormat', async () => {
  const { numberFormatMockDefaults } = await import('@/test/number-format-mock');
  return {
    useNumberFormat: () => ({
      ...numberFormatMockDefaults(),
      formatCurrency: (n: number) => `$${n.toFixed(2)}`,
      formatCurrencyCompact: (n: number) => `$${Math.round(n)}`,
      formatCurrencyAxis: (n: number) => `$${n}`,
      defaultCurrency: 'USD',
    }),
  };
});
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('@/lib/pdf-export', () => ({
  exportToPdf: (...args: any[]) => mockExportToPdf(...args),
}));

// The month column renders through the user's date preference and the chart
// axis through the chart month formatter, so both are pinned here. The table
// labels are deliberately anti-chronological in alphabetical order (Zulu,
// Yankee, Xray for Jan, Feb, Mar): a sort that reads the LABEL instead of the
// key shows up as a reversed table.
vi.mock('@/hooks/useDateFormat', () => ({
  useDateFormat: () => ({
    formatMonth: (monthKey: string) =>
      ({ '2025-01': 'Zulu month', '2025-02': 'Yankee month', '2025-03': 'Xray month' })[
        monthKey as '2025-01' | '2025-02' | '2025-03'
      ] ?? `localized:${monthKey}`,
  }),
}));

vi.mock('@/hooks/useChartMonthFormat', () => ({
  useChartMonthFormat: () => (monthKey: string) => `chart:${monthKey}`,
}));

vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }: any) => <div>{children}</div>,
  LineChart: ({ children }: any) => <div data-testid="line-chart">{children}</div>,
  Line: () => null,
  XAxis: () => null,
  YAxis: () => null,
  CartesianGrid: () => null,
  Legend: () => null,
  ReferenceLine: () => null,
  Tooltip: ({ content }: any) => {
    const C = content;
    if (!C) return null;
    const samples = [
      { active: true, payload: [{ payload: { monthKey: '2025-01', income: 100, expenses: 50, savings: 50, savingsRate: 50 } }], label: '2025-01' },
      { active: true, payload: [{ payload: { monthKey: '2025-02', income: 100, expenses: 90, savings: 10, savingsRate: 10 } }], label: '2025-02' },
      { active: false, payload: [], label: '' },
      { active: true, payload: [{ payload: undefined }], label: 'no payload' },
    ];
    return <div>{samples.map((s, i) => <div key={i}>{C(s)}</div>)}</div>;
  },
}));

const makeBudget = (overrides: Partial<Budget> = {}): Budget =>
  ({ id: 'b-1', name: 'Default', isActive: true, ...overrides } as Budget);

const makePoint = (
  monthKey: string,
  income: number,
  expenses: number,
): SavingsRatePoint => ({
  monthKey,
  income,
  expenses,
  savings: income - expenses,
  savingsRate: income > 0 ? ((income - expenses) / income) * 100 : 0,
});

async function renderReport() {
  let result: ReturnType<typeof render>;
  await act(async () => {
    result = render(<SavingsRateReport />);
  });
  return result!;
}

describe('SavingsRateReport', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExportToPdf.mockResolvedValue(undefined);
  });

  it('shows loading skeleton', async () => {
    mockGetAll.mockResolvedValue([makeBudget()]);
    mockGetSavingsRate.mockReturnValue(new Promise(() => {}));
    let container: HTMLElement;
    await act(async () => {
      const r = render(<SavingsRateReport />);
      container = r.container;
    });
    expect(container!.querySelector('.animate-pulse')).toBeTruthy();
  });

  it('renders no-budgets state', async () => {
    mockGetAll.mockResolvedValue([]);
    await renderReport();
    await waitFor(() => {
      expect(screen.getByText(/No budgets found/i)).toBeInTheDocument();
    });
  });

  it('renders empty data message and zero summary cards', async () => {
    mockGetAll.mockResolvedValue([makeBudget()]);
    mockGetSavingsRate.mockResolvedValue([]);
    await renderReport();
    await waitFor(() => {
      expect(screen.getByText(/No savings rate data/i)).toBeInTheDocument();
    });
    expect(screen.getAllByText('0.0%').length).toBeGreaterThan(0);
  });

  it('falls back to first budget when none active', async () => {
    mockGetAll.mockResolvedValue([
      makeBudget({ id: 'a', isActive: false }),
      makeBudget({ id: 'b', isActive: false }),
    ]);
    mockGetSavingsRate.mockResolvedValue([]);
    await renderReport();
    await waitFor(() =>
      expect(mockGetSavingsRate).toHaveBeenCalledWith('a', 12),
    );
  });

  it('renders summary, chart, and breakdown table covering positive/negative savings', async () => {
    mockGetAll.mockResolvedValue([makeBudget()]);
    mockGetSavingsRate.mockResolvedValue([
      makePoint('2025-01', 1000, 800), // 20% rate, positive savings
      makePoint('2025-02', 1000, 1200), // -20% rate, negative savings
      makePoint('2025-03', 1000, 950), // 5% positive but below target
    ]);
    await renderReport();
    await waitFor(() => {
      expect(screen.getByText('Monthly Breakdown')).toBeInTheDocument();
    });
    // The user reads a localized month, never the structural key the server
    // now sends.
    expect(screen.getByText('Zulu month')).toBeInTheDocument();
    expect(screen.getByText('Yankee month')).toBeInTheDocument();
    expect(screen.getByText('Xray month')).toBeInTheDocument();
    expect(screen.queryByText('2025-01')).not.toBeInTheDocument();

    // Ascending is the default, and these labels sort alphabetically in the
    // opposite order -- so January staying first proves the sort reads the key.
    const renderedMonths = Array.from(document.querySelectorAll('tbody tr')).map(
      (row) => row.querySelector('td')?.textContent,
    );
    expect(renderedMonths).toEqual(['Zulu month', 'Yankee month', 'Xray month']);

    // The chart axis uses the chart formatter, not the table's.
    expect(screen.getByText('chart:2025-01')).toBeInTheDocument();
  });

  it('reflects target selector affecting meets-target color', async () => {
    mockGetAll.mockResolvedValue([makeBudget()]);
    mockGetSavingsRate.mockResolvedValue([
      makePoint('2025-01', 1000, 850), // 15% rate
    ]);
    await renderReport();
    await waitFor(() => {
      expect(screen.getByText(/Monthly Breakdown/)).toBeInTheDocument();
    });
    const selects = document.querySelectorAll('select');
    // selects: budget, months, target
    await act(async () => {
      fireEvent.change(selects[2], { target: { value: '10' } });
    });
    // 15% > 10% => meets target
    expect(screen.getAllByText('15.0%').length).toBeGreaterThan(0);
  });

  it('switches budget and months selectors and refetches', async () => {
    mockGetAll.mockResolvedValue([
      makeBudget({ id: 'b-1', name: 'A' }),
      makeBudget({ id: 'b-2', name: 'B', isActive: false }),
    ]);
    mockGetSavingsRate.mockResolvedValue([]);
    await renderReport();
    await waitFor(() =>
      expect(mockGetSavingsRate).toHaveBeenCalledWith('b-1', 12),
    );
    // Re-query the selects after each reload: the loading skeleton briefly
    // unmounts the controls during a refetch, so a reference captured before
    // the change would be detached from the live DOM.
    await act(async () => {
      fireEvent.change(document.querySelectorAll('select')[0], { target: { value: 'b-2' } });
    });
    await waitFor(() =>
      expect(mockGetSavingsRate).toHaveBeenCalledWith('b-2', 12),
    );
    await act(async () => {
      fireEvent.change(document.querySelectorAll('select')[1], { target: { value: '6' } });
    });
    await waitFor(() =>
      expect(mockGetSavingsRate).toHaveBeenCalledWith('b-2', 6),
    );
  });

  it('shows a retryable budget load failure and distinguishes an empty success', async () => {
    mockGetAll.mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce([]);
    await renderReport();
    await screen.findByText(/Failed to load report data/i);
    expect(screen.queryByText(/No budgets found/i)).not.toBeInTheDocument();
    await act(async () => { fireEvent.click(screen.getByRole('button', {name:'Try again'})); });
    await screen.findByText(/No budgets found/i);
    expect(mockGetAll).toHaveBeenCalledTimes(2);
  });

  it('handles getSavingsRate error gracefully', async () => {
    mockGetAll.mockResolvedValue([makeBudget()]);
    mockGetSavingsRate.mockRejectedValue(new Error('boom'));
    await renderReport();
    await waitFor(() => {
      expect(screen.getByText(/Failed to load report data/i)).toBeInTheDocument();
    });
  });

  it('exports to PDF with summary and breakdown table', async () => {
    mockGetAll.mockResolvedValue([makeBudget()]);
    mockGetSavingsRate.mockResolvedValue([makePoint('2025-01', 1000, 800)]);
    await renderReport();
    const exportBtn = await screen.findByTitle('Export PDF');
    await act(async () => { fireEvent.click(exportBtn); });
    await waitFor(() => expect(mockExportToPdf).toHaveBeenCalled());
    const arg = mockExportToPdf.mock.calls[0][0];
    expect(arg.title).toBe('Savings Rate');
    expect(arg.summaryCards.length).toBe(4);
    expect(arg.additionalTables[0].title).toBe('Monthly Breakdown');
    // The PDF is a reading surface, so its month column is localized too.
    expect(arg.additionalTables[0].rows[0][0]).toBe('Zulu month');
  });

  it('exports to PDF with no additional tables when no data', async () => {
    mockGetAll.mockResolvedValue([makeBudget()]);
    mockGetSavingsRate.mockResolvedValue([]);
    await renderReport();
    const exportBtn = await screen.findByTitle('Export PDF');
    await act(async () => { fireEvent.click(exportBtn); });
    await waitFor(() => expect(mockExportToPdf).toHaveBeenCalled());
    const arg = mockExportToPdf.mock.calls[0][0];
    expect(arg.additionalTables).toBeUndefined();
  });
});
