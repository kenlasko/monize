import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@/test/render';
import { BudgetSeasonalPatternsReport } from './BudgetSeasonalPatternsReport';
import type { Budget, SeasonalPattern } from '@/types/budget';

const mockGetAll = vi.fn();
const mockGetSeasonalPatterns = vi.fn();
const mockExportToPdf = vi.fn();

vi.mock('@/lib/budgets', () => ({
  budgetsApi: {
    getAll: (...args: any[]) => mockGetAll(...args),
    getSeasonalPatterns: (...args: any[]) => mockGetSeasonalPatterns(...args),
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
  BarChart: ({ children }: any) => <div data-testid="bar-chart">{children}</div>,
  Bar: ({ children }: any) => <>{children}</>,
  Cell: () => null,
  XAxis: () => null,
  YAxis: () => null,
  CartesianGrid: () => null,
  Tooltip: ({ content }: any) => {
    const C = content;
    if (!C) return null;
    const samples = [
      { active: true, payload: [{ payload: { month: 'Jan', amount: 100, isHigh: true } }], label: 'Jan' },
      { active: true, payload: [{ payload: { month: 'Feb', amount: 50, isHigh: false } }], label: 'Feb' },
      { active: false, payload: [], label: '' },
      { active: true, payload: [], label: 'empty' },
    ];
    return <div>{samples.map((s, i) => <div key={i}>{C(s)}</div>)}</div>;
  },
}));

const makeBudget = (overrides: Partial<Budget> = {}): Budget =>
  ({ id: 'b-1', name: 'Default', isActive: true, ...overrides } as Budget);

const makePattern = (id: string, name: string, highMonths: number[] = [], typical = 100): SeasonalPattern => ({
  categoryId: id,
  categoryName: name,
  monthlyAverages: Array.from({ length: 12 }, (_, i) => ({
    month: i + 1,
    monthName: ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'][i],
    average: 50 + i * 10,
  })) as any,
  highMonths,
  typicalMonthlySpend: typical,
});

async function renderReport() {
  let result: ReturnType<typeof render>;
  await act(async () => {
    result = render(<BudgetSeasonalPatternsReport />);
  });
  return result!;
}

describe('BudgetSeasonalPatternsReport', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExportToPdf.mockResolvedValue(undefined);
  });

  it('renders loading skeleton initially', async () => {
    mockGetAll.mockResolvedValue([makeBudget()]);
    mockGetSeasonalPatterns.mockReturnValue(new Promise(() => {}));
    let container: HTMLElement;
    await act(async () => {
      const r = render(<BudgetSeasonalPatternsReport />);
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

  it('renders empty patterns state', async () => {
    mockGetAll.mockResolvedValue([makeBudget()]);
    mockGetSeasonalPatterns.mockResolvedValue([]);
    await renderReport();
    await waitFor(() => {
      expect(screen.getByText(/Not enough historical data/i)).toBeInTheDocument();
    });
  });

  it('renders patterns with chart and table; clicking a row selects category', async () => {
    mockGetAll.mockResolvedValue([makeBudget()]);
    mockGetSeasonalPatterns.mockResolvedValue([
      makePattern('a', 'Groceries', [6, 12], 100),
      makePattern('b', 'Travel', [], 200),
    ]);
    await renderReport();
    await waitFor(() => {
      expect(screen.getByText('All Category Patterns')).toBeInTheDocument();
    });
    expect(screen.getByText(/Groceries - Monthly Spending/i)).toBeInTheDocument();
    expect(screen.getByText('None detected')).toBeInTheDocument();
    // Click on Travel row (cell, not select option) to select it
    const travelCells = screen.getAllByText('Travel');
    // The td will be the one not within an option
    const travelTd = travelCells.find((el) => el.tagName === 'TD');
    await act(async () => {
      fireEvent.click(travelTd!);
    });
    await waitFor(() => {
      expect(screen.getByText(/Travel - Monthly Spending/i)).toBeInTheDocument();
    });
  });

  it('switches budget selector and clears category selection', async () => {
    mockGetAll.mockResolvedValue([
      makeBudget({ id: 'b-1' }),
      makeBudget({ id: 'b-2', isActive: false }),
    ]);
    mockGetSeasonalPatterns.mockResolvedValue([makePattern('a', 'A')]);
    await renderReport();
    await waitFor(() => {
      expect(screen.getByText('All Category Patterns')).toBeInTheDocument();
    });
    const select = document.querySelector('select')!;
    await act(async () => { fireEvent.change(select, { target: { value: 'b-2' } }); });
    await waitFor(() => expect(mockGetSeasonalPatterns).toHaveBeenCalledWith('b-2'));
  });

  it('changes selected category via category dropdown', async () => {
    mockGetAll.mockResolvedValue([makeBudget()]);
    mockGetSeasonalPatterns.mockResolvedValue([
      makePattern('a', 'Cat A'),
      makePattern('b', 'Cat B'),
    ]);
    await renderReport();
    await waitFor(() => {
      expect(screen.getByText('All Category Patterns')).toBeInTheDocument();
    });
    const selects = document.querySelectorAll('select');
    await act(async () => { fireEvent.change(selects[1], { target: { value: 'b' } }); });
    await waitFor(() => {
      expect(screen.getByText(/Cat B - Monthly Spending/i)).toBeInTheDocument();
    });
  });

  it('handles error gracefully', async () => {
    mockGetAll.mockResolvedValue([makeBudget()]);
    mockGetSeasonalPatterns.mockRejectedValue(new Error('boom'));
    await renderReport();
    await waitFor(() => {
      expect(screen.getByText(/Not enough historical data/i)).toBeInTheDocument();
    });
  });

  it('exports to PDF', async () => {
    mockGetAll.mockResolvedValue([makeBudget()]);
    mockGetSeasonalPatterns.mockResolvedValue([makePattern('a', 'Cat', [3, 7])]);
    await renderReport();
    const exportBtn = await screen.findByTitle('Export PDF');
    await act(async () => { fireEvent.click(exportBtn); });
    await waitFor(() => expect(mockExportToPdf).toHaveBeenCalled());
    expect(mockExportToPdf.mock.calls[0][0].title).toBe('Budget Seasonal Patterns');
  });
});
