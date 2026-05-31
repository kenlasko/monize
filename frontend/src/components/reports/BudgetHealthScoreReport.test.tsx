import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@/test/render';
import { BudgetHealthScoreReport } from './BudgetHealthScoreReport';
import type { Budget, HealthScoreResult } from '@/types/budget';

const mockGetAll = vi.fn();
const mockGetHealthScore = vi.fn();
const mockExportToPdf = vi.fn();

vi.mock('@/lib/budgets', () => ({
  budgetsApi: {
    getAll: (...args: any[]) => mockGetAll(...args),
    getHealthScore: (...args: any[]) => mockGetHealthScore(...args),
  },
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }),
}));

vi.mock('@/lib/pdf-export', () => ({
  exportToPdf: (...args: any[]) => mockExportToPdf(...args),
}));

vi.mock('@/components/budgets/BudgetHealthGauge', () => ({
  BudgetHealthGauge: ({ score }: { score: number }) => (
    <div data-testid="health-gauge">score={score}</div>
  ),
}));

const makeBudget = (overrides: Partial<Budget> = {}): Budget =>
  ({ id: 'b-1', name: 'Default', isActive: true, ...overrides } as Budget);

const makeScore = (overrides: Partial<HealthScoreResult> = {}): HealthScoreResult => ({
  score: 75,
  label: 'Fair',
  breakdown: {
    baseScore: 100,
    overBudgetDeductions: 20,
    underBudgetBonus: 5,
    trendBonus: 0,
    essentialWeightPenalty: 10,
  },
  categoryScores: [
    { categoryId: 'c1', categoryName: 'Groceries', percentUsed: 90, impact: -5, categoryGroup: 'NEED' },
    { categoryId: 'c2', categoryName: 'Dining', percentUsed: 120, impact: -10, categoryGroup: 'WANT' },
    { categoryId: 'c3', categoryName: 'Savings', percentUsed: 80, impact: 5, categoryGroup: 'SAVING' },
    { categoryId: 'c4', categoryName: 'Misc', percentUsed: 50, impact: 0, categoryGroup: null },
  ],
  ...overrides,
});

async function renderReport() {
  let result: ReturnType<typeof render>;
  await act(async () => {
    result = render(<BudgetHealthScoreReport />);
  });
  return result!;
}

describe('BudgetHealthScoreReport', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExportToPdf.mockResolvedValue(undefined);
  });

  it('renders loading skeleton', async () => {
    mockGetAll.mockResolvedValue([makeBudget()]);
    mockGetHealthScore.mockReturnValue(new Promise(() => {}));
    let container: HTMLElement;
    await act(async () => {
      const r = render(<BudgetHealthScoreReport />);
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
    mockGetHealthScore.mockResolvedValue(makeScore());
    await renderReport();
    await waitFor(() => expect(mockGetHealthScore).toHaveBeenCalledWith('a'));
  });

  it('renders gauge, breakdown, and category impact table covering all groups', async () => {
    mockGetAll.mockResolvedValue([makeBudget()]);
    mockGetHealthScore.mockResolvedValue(makeScore());
    await renderReport();
    await waitFor(() => {
      expect(screen.getByText('Score Breakdown')).toBeInTheDocument();
    });
    expect(screen.getByTestId('health-gauge')).toBeInTheDocument();
    expect(screen.getByText('Category Impact')).toBeInTheDocument();
    expect(screen.getByText('Need')).toBeInTheDocument();
    expect(screen.getByText('Want')).toBeInTheDocument();
    expect(screen.getByText('Saving')).toBeInTheDocument();
    expect(screen.getByText('Uncategorized')).toBeInTheDocument();
  });

  it('renders empty categories message when no scores', async () => {
    mockGetAll.mockResolvedValue([makeBudget()]);
    mockGetHealthScore.mockResolvedValue(makeScore({ categoryScores: [] }));
    await renderReport();
    await waitFor(() => {
      expect(screen.getByText('No categories to evaluate.')).toBeInTheDocument();
    });
  });

  it('switches budget selector', async () => {
    mockGetAll.mockResolvedValue([
      makeBudget({ id: 'b-1' }),
      makeBudget({ id: 'b-2', isActive: false }),
    ]);
    mockGetHealthScore.mockResolvedValue(makeScore());
    await renderReport();
    const select = document.querySelector('select')!;
    await act(async () => { fireEvent.change(select, { target: { value: 'b-2' } }); });
    await waitFor(() => expect(mockGetHealthScore).toHaveBeenCalledWith('b-2'));
  });

  it('shows a retryable error when loading the health score fails', async () => {
    mockGetAll.mockResolvedValue([makeBudget()]);
    mockGetHealthScore.mockRejectedValue(new Error('boom'));
    await renderReport();
    await waitFor(() => {
      expect(screen.getByText(/Failed to load report data/i)).toBeInTheDocument();
    });
    expect(screen.queryByText('Score Breakdown')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Try again/i })).toBeInTheDocument();
  });

  it('exports to PDF with category impact rows', async () => {
    mockGetAll.mockResolvedValue([makeBudget()]);
    mockGetHealthScore.mockResolvedValue(makeScore());
    await renderReport();
    const exportBtn = await screen.findByTitle('Export PDF');
    await act(async () => { fireEvent.click(exportBtn); });
    await waitFor(() => expect(mockExportToPdf).toHaveBeenCalled());
    const arg = mockExportToPdf.mock.calls[0][0];
    expect(arg.title).toBe('Budget Health Score');
    expect(arg.additionalTables[0].rows.length).toBe(4);
  });

  it('exports to PDF with no health score (empty case)', async () => {
    mockGetAll.mockResolvedValue([makeBudget()]);
    mockGetHealthScore.mockResolvedValue(null);
    await renderReport();
    const exportBtn = await screen.findByTitle('Export PDF');
    await act(async () => { fireEvent.click(exportBtn); });
    await waitFor(() => expect(mockExportToPdf).toHaveBeenCalled());
    const arg = mockExportToPdf.mock.calls[0][0];
    expect(arg.summaryCards).toBeUndefined();
    expect(arg.additionalTables).toBeUndefined();
  });

  it('exports to PDF with high score (green)', async () => {
    mockGetAll.mockResolvedValue([makeBudget()]);
    mockGetHealthScore.mockResolvedValue(makeScore({ score: 90 }));
    await renderReport();
    const exportBtn = await screen.findByTitle('Export PDF');
    await act(async () => { fireEvent.click(exportBtn); });
    await waitFor(() => expect(mockExportToPdf).toHaveBeenCalled());
    expect(mockExportToPdf.mock.calls[0][0].summaryCards[0].color).toBe('#16a34a');
  });

  it('exports to PDF with low score (red)', async () => {
    mockGetAll.mockResolvedValue([makeBudget()]);
    mockGetHealthScore.mockResolvedValue(makeScore({ score: 40 }));
    await renderReport();
    const exportBtn = await screen.findByTitle('Export PDF');
    await act(async () => { fireEvent.click(exportBtn); });
    await waitFor(() => expect(mockExportToPdf).toHaveBeenCalled());
    expect(mockExportToPdf.mock.calls[0][0].summaryCards[0].color).toBe('#dc2626');
  });
});
