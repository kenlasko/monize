import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@/test/render';
import { SeasonalSpendingMapReport } from './SeasonalSpendingMapReport';
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

const makeBudget = (overrides: Partial<Budget> = {}): Budget =>
  ({
    id: 'b-1',
    name: 'Default Budget',
    isActive: true,
    ...overrides,
  } as Budget);

const makePattern = (
  id: string,
  name: string,
  monthlyAverages: { month: number; average: number }[],
  highMonths: number[] = [],
  typical = 100,
): SeasonalPattern => ({
  categoryId: id,
  categoryName: name,
  monthlyAverages: monthlyAverages.map((m) => ({ month: m.month, average: m.average })) as any,
  highMonths,
  typicalMonthlySpend: typical,
});

async function renderReport() {
  let result: ReturnType<typeof render>;
  await act(async () => {
    result = render(<SeasonalSpendingMapReport />);
  });
  return result!;
}

describe('SeasonalSpendingMapReport', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExportToPdf.mockResolvedValue(undefined);
  });

  it('renders loading skeleton while patterns fetch', async () => {
    mockGetAll.mockResolvedValue([makeBudget()]);
    mockGetSeasonalPatterns.mockReturnValue(new Promise(() => {}));
    let container: HTMLElement;
    await act(async () => {
      const r = render(<SeasonalSpendingMapReport />);
      container = r.container;
    });
    expect(container!.querySelector('.animate-pulse')).toBeTruthy();
  });

  it('renders no-budgets empty state', async () => {
    mockGetAll.mockResolvedValue([]);
    await renderReport();
    await waitFor(() => {
      expect(screen.getByText(/No budgets found/i)).toBeInTheDocument();
    });
  });

  it('falls back to first budget when no active budget exists', async () => {
    mockGetAll.mockResolvedValue([
      makeBudget({ id: 'a', name: 'A', isActive: false }),
      makeBudget({ id: 'b', name: 'B', isActive: false }),
    ]);
    mockGetSeasonalPatterns.mockResolvedValue([]);
    await renderReport();
    await waitFor(() => {
      expect(mockGetSeasonalPatterns).toHaveBeenCalledWith('a');
    });
  });

  it('shows empty heatmap message when no patterns', async () => {
    mockGetAll.mockResolvedValue([makeBudget()]);
    mockGetSeasonalPatterns.mockResolvedValue([]);
    await renderReport();
    await waitFor(() => {
      expect(screen.getByText(/Not enough historical data/i)).toBeInTheDocument();
    });
  });

  it('renders heatmap with all intensity buckets and high-month rings', async () => {
    mockGetAll.mockResolvedValue([makeBudget()]);
    mockGetSeasonalPatterns.mockResolvedValue([
      // Cat A: covers all intensity ranges from 0 to max
      makePattern(
        'a',
        'Groceries',
        [
          { month: 1, average: 0 },
          { month: 2, average: 50 }, // 0.05 -> green-100
          { month: 3, average: 250 }, // 0.25 -> green-200
          { month: 4, average: 500 }, // 0.5 -> yellow
          { month: 5, average: 700 }, // 0.7 -> orange
          { month: 6, average: 1000 }, // 1.0 -> red
        ],
        [6],
        500,
      ),
      makePattern('b', 'Transport', [{ month: 1, average: 0 }], [], 0),
    ]);
    await renderReport();
    await waitFor(() => {
      expect(screen.getByText('Groceries')).toBeInTheDocument();
    });
    expect(screen.getByText('Transport')).toBeInTheDocument();
    // Month headers
    expect(screen.getByText('Jan')).toBeInTheDocument();
    expect(screen.getByText('Dec')).toBeInTheDocument();
    // Legend
    expect(screen.getByText('Intensity:')).toBeInTheDocument();
    expect(screen.getByText('High')).toBeInTheDocument();
    expect(screen.getByText('High Spending Month')).toBeInTheDocument();
    // High month value of 1000 should show
    expect(screen.getByText('$1000')).toBeInTheDocument();
  });

  it('switches budget selector and refetches', async () => {
    mockGetAll.mockResolvedValue([
      makeBudget({ id: 'b-1', name: 'A' }),
      makeBudget({ id: 'b-2', name: 'B', isActive: false }),
    ]);
    mockGetSeasonalPatterns.mockResolvedValue([]);
    await renderReport();
    await waitFor(() => expect(mockGetSeasonalPatterns).toHaveBeenCalledWith('b-1'));
    const select = document.querySelector('select')!;
    await act(async () => {
      fireEvent.change(select, { target: { value: 'b-2' } });
    });
    await waitFor(() => expect(mockGetSeasonalPatterns).toHaveBeenCalledWith('b-2'));
  });

  it('surfaces a retryable error state when getAll fails', async () => {
    mockGetAll.mockRejectedValue(new Error('boom'));
    await renderReport();
    await waitFor(() => {
      expect(screen.getByText(/failed to load report data/i)).toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
  });

  it('surfaces a retryable error state when getSeasonalPatterns fails', async () => {
    mockGetAll.mockResolvedValue([makeBudget()]);
    mockGetSeasonalPatterns.mockRejectedValue(new Error('boom'));
    await renderReport();
    await waitFor(() => {
      expect(screen.getByText(/failed to load report data/i)).toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
  });

  it('exports to PDF covering all intensity buckets including zero', async () => {
    mockGetAll.mockResolvedValue([makeBudget()]);
    mockGetSeasonalPatterns.mockResolvedValue([
      makePattern(
        'a',
        'Cat A',
        [
          { month: 1, average: 0 },
          { month: 2, average: 50 },
          { month: 3, average: 250 },
          { month: 4, average: 500 },
          { month: 5, average: 700 },
          { month: 6, average: 1000 },
        ],
        [6],
      ),
    ]);
    await renderReport();
    const exportBtn = await screen.findByTitle('Export PDF');
    await act(async () => { fireEvent.click(exportBtn); });
    await waitFor(() => expect(mockExportToPdf).toHaveBeenCalled());
    const arg = mockExportToPdf.mock.calls[0][0];
    expect(arg.title).toBe('Seasonal Spending Map');
    expect(arg.tableData.headers[0]).toBe('Category');
    // First row: category name + 12 monthly cells + typical
    expect(arg.tableData.rows[0].length).toBe(14);
  });

  it('exports to PDF when global max is zero (all values 0)', async () => {
    mockGetAll.mockResolvedValue([makeBudget()]);
    mockGetSeasonalPatterns.mockResolvedValue([
      makePattern('a', 'Empty', [{ month: 1, average: 0 }], []),
    ]);
    await renderReport();
    const exportBtn = await screen.findByTitle('Export PDF');
    await act(async () => { fireEvent.click(exportBtn); });
    await waitFor(() => expect(mockExportToPdf).toHaveBeenCalled());
  });
});
