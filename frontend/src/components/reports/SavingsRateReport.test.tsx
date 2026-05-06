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
      { active: true, payload: [{ payload: { month: 'tip-x', income: 100, expenses: 50, savings: 50, savingsRate: 50 } }], label: 'tip-x' },
      { active: true, payload: [{ payload: { month: 'tip-y', income: 100, expenses: 90, savings: 10, savingsRate: 10 } }], label: 'tip-y' },
      { active: false, payload: [], label: '' },
      { active: true, payload: [{ payload: undefined }], label: 'no payload' },
    ];
    return <div>{samples.map((s, i) => <div key={i}>{C(s)}</div>)}</div>;
  },
}));

const makeBudget = (overrides: Partial<Budget> = {}): Budget =>
  ({ id: 'b-1', name: 'Default', isActive: true, ...overrides } as Budget);

const makePoint = (
  month: string,
  income: number,
  expenses: number,
): SavingsRatePoint => ({
  month,
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
    expect(screen.getByText('2025-01')).toBeInTheDocument();
    expect(screen.getByText('2025-02')).toBeInTheDocument();
    expect(screen.getByText('2025-03')).toBeInTheDocument();
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
    const selects = document.querySelectorAll('select');
    await act(async () => {
      fireEvent.change(selects[0], { target: { value: 'b-2' } });
    });
    await waitFor(() =>
      expect(mockGetSavingsRate).toHaveBeenCalledWith('b-2', 12),
    );
    await act(async () => {
      fireEvent.change(selects[1], { target: { value: '6' } });
    });
    await waitFor(() =>
      expect(mockGetSavingsRate).toHaveBeenCalledWith('b-2', 6),
    );
  });

  it('handles getAll error gracefully', async () => {
    mockGetAll.mockRejectedValue(new Error('boom'));
    await renderReport();
    await waitFor(() => {
      expect(screen.getByText(/No budgets found/i)).toBeInTheDocument();
    });
  });

  it('handles getSavingsRate error gracefully', async () => {
    mockGetAll.mockResolvedValue([makeBudget()]);
    mockGetSavingsRate.mockRejectedValue(new Error('boom'));
    await renderReport();
    await waitFor(() => {
      expect(screen.getByText(/No savings rate data/i)).toBeInTheDocument();
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
