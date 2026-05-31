import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@/test/render';
import { BudgetTrendReport } from './BudgetTrendReport';
import type { Budget, BudgetTrendPoint } from '@/types/budget';

const mockGetAll = vi.fn();
const mockGetTrend = vi.fn();
const mockExportToPdf = vi.fn();

vi.mock('@/lib/budgets', () => ({
  budgetsApi: {
    getAll: (...args: any[]) => mockGetAll(...args),
    getTrend: (...args: any[]) => mockGetTrend(...args),
  },
}));

vi.mock('@/hooks/useNumberFormat', () => ({
  useNumberFormat: () => ({
    formatCurrency: (n: number) => `$${n.toFixed(2)}`,
    formatCurrencyCompact: (n: number) => `$${Math.round(n)}`,
    formatCurrencyAxis: (n: number) => `$${n}`,
    defaultCurrency: 'USD',
  }),
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }),
}));

vi.mock('@/lib/pdf-export', () => ({
  exportToPdf: (...args: any[]) => mockExportToPdf(...args),
}));

vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }: any) => <div>{children}</div>,
  LineChart: ({ children }: any) => <div data-testid="line-chart">{children}</div>,
  Line: () => null,
  XAxis: () => null,
  YAxis: () => null,
  CartesianGrid: () => null,
  Legend: () => null,
  Tooltip: ({ content }: any) => {
    const C = content;
    if (!C) return null;
    const samples = [
      { active: true, payload: [{ dataKey: 'budgeted', name: 'Budgeted', color: '#3b82f6', value: 1000 }, { dataKey: 'actual', name: 'Actual', color: '#10b981', value: 900 }], label: 'tip-x' },
      { active: false, payload: [], label: '' },
      { active: true, payload: [], label: 'empty' },
    ];
    return <div>{samples.map((s, i) => <div key={i}>{C(s)}</div>)}</div>;
  },
}));

const makeBudget = (overrides: Partial<Budget> = {}): Budget =>
  ({ id: 'b-1', name: 'Default', isActive: true, ...overrides } as Budget);

const makePoint = (
  month: string,
  budgeted: number,
  actual: number,
): BudgetTrendPoint => ({
  month,
  budgeted,
  actual,
  variance: actual - budgeted,
  percentUsed: budgeted > 0 ? Math.round((actual / budgeted) * 100) : 0,
});

async function renderReport() {
  let result: ReturnType<typeof render>;
  await act(async () => {
    result = render(<BudgetTrendReport />);
  });
  return result!;
}

describe('BudgetTrendReport', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExportToPdf.mockResolvedValue(undefined);
  });

  it('renders loading skeleton initially', async () => {
    mockGetAll.mockResolvedValue([makeBudget()]);
    mockGetTrend.mockReturnValue(new Promise(() => {}));
    let container: HTMLElement;
    await act(async () => {
      const r = render(<BudgetTrendReport />);
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

  it('falls back to first budget when no active', async () => {
    mockGetAll.mockResolvedValue([
      makeBudget({ id: 'a', isActive: false }),
      makeBudget({ id: 'b', isActive: false }),
    ]);
    mockGetTrend.mockResolvedValue([]);
    await renderReport();
    await waitFor(() => expect(mockGetTrend).toHaveBeenCalledWith('a', 12));
  });

  it('renders empty trend message', async () => {
    mockGetAll.mockResolvedValue([makeBudget()]);
    mockGetTrend.mockResolvedValue([]);
    await renderReport();
    await waitFor(() => {
      expect(screen.getByText(/No trend data available/i)).toBeInTheDocument();
    });
  });

  it('renders Improving trend with negative variance', async () => {
    mockGetAll.mockResolvedValue([makeBudget()]);
    mockGetTrend.mockResolvedValue([
      makePoint('2025-01', 1000, 1100),
      makePoint('2025-02', 1000, 900),
    ]);
    await renderReport();
    await waitFor(() => {
      expect(screen.getByText('Improving')).toBeInTheDocument();
    });
    expect(screen.getByText('Avg Budgeted')).toBeInTheDocument();
  });

  it('renders Worsening trend with positive variance', async () => {
    mockGetAll.mockResolvedValue([makeBudget()]);
    mockGetTrend.mockResolvedValue([
      makePoint('2025-01', 1000, 900),
      makePoint('2025-02', 1000, 1200),
    ]);
    await renderReport();
    await waitFor(() => {
      expect(screen.getByText('Worsening')).toBeInTheDocument();
    });
  });

  it('switches budget and months selectors and refetches', async () => {
    mockGetAll.mockResolvedValue([
      makeBudget({ id: 'b-1' }),
      makeBudget({ id: 'b-2', isActive: false }),
    ]);
    mockGetTrend.mockResolvedValue([]);
    await renderReport();
    // Re-query selects after each change: a re-render can replace the nodes.
    const selects = () => document.querySelectorAll('select');
    await act(async () => { fireEvent.change(selects()[0], { target: { value: 'b-2' } }); });
    await waitFor(() => expect(mockGetTrend).toHaveBeenCalledWith('b-2', 12));
    await act(async () => { fireEvent.change(selects()[1], { target: { value: '24' } }); });
    await waitFor(() => expect(mockGetTrend).toHaveBeenCalledWith('b-2', 24));
  });

  it('shows a retryable error when loading the trend fails', async () => {
    mockGetAll.mockResolvedValue([makeBudget()]);
    mockGetTrend.mockRejectedValue(new Error('boom'));
    await renderReport();
    await waitFor(() => {
      expect(screen.getByText(/Failed to load report data/i)).toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: /Try again/i })).toBeInTheDocument();
  });

  it('exports to PDF', async () => {
    mockGetAll.mockResolvedValue([makeBudget()]);
    mockGetTrend.mockResolvedValue([makePoint('2025-01', 1000, 800)]);
    await renderReport();
    const exportBtn = await screen.findByTitle('Export PDF');
    await act(async () => { fireEvent.click(exportBtn); });
    await waitFor(() => expect(mockExportToPdf).toHaveBeenCalled());
    const arg = mockExportToPdf.mock.calls[0][0];
    expect(arg.title).toBe('Budget Trend');
    expect(arg.tableData.headers).toContain('Month');
  });
});
