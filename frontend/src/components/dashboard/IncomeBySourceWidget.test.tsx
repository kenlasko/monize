import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, screen } from '@testing-library/react';
import { render } from '@/test/render';
import { IncomeBySourceWidget } from './IncomeBySourceWidget';

vi.mock('recharts', async () => {
  const base = (await import('@/test/recharts-mock')).rechartsMock();
  return {
    ...base,
    Pie: ({ data }: { data: Array<{ name: string; value: number }> }) => (
      <div data-testid="pie-data" data-slices={JSON.stringify(data)} />
    ),
  };
});

vi.mock('@/hooks/useWidgetConfig', () => ({
  useWidgetConfig: () => ({ config: { range: '1y', chartType: 'pie' }, updateConfig: vi.fn() }),
}));
vi.mock('@/hooks/useNumberFormat', async () => {
  const { numberFormatMockDefaults } = await import('@/test/number-format-mock');
  return {
    useNumberFormat: () => ({
      ...numberFormatMockDefaults(),
      formatCurrencyCompact: (n: number) => `$${n}`,
      formatCurrencyAxis: (n: number) => `$${n}`,
    }),
  };
});
const getIncomeBySource = vi.fn();
vi.mock('@/lib/built-in-reports', () => ({
  builtInReportsApi: { getIncomeBySource: (...a: unknown[]) => getIncomeBySource(...a) },
}));

async function renderWidget() {
  await act(async () => {
    render(<IncomeBySourceWidget isLoading={false} />);
  });
}

describe('IncomeBySourceWidget', () => {
  beforeEach(() => getIncomeBySource.mockReset());

  it('renders income total and chart', async () => {
    getIncomeBySource.mockResolvedValue({
      data: [{ categoryId: 'c1', categoryName: 'Salary', color: null, total: 5000 }],
      totalIncome: 5000,
    });
    await renderWidget();
    expect(screen.getByText('Income by Source')).toBeInTheDocument();
    expect(screen.getByText('1Y')).toBeInTheDocument();
    expect(screen.getByText('$5000')).toBeInTheDocument();
    expect(screen.getByTestId('responsive-container')).toBeInTheDocument();
  });

  it('shows the empty state with no income', async () => {
    getIncomeBySource.mockResolvedValue({ data: [], totalIncome: 0 });
    await renderWidget();
    expect(screen.getByText('No income in this period.')).toBeInTheDocument();
  });

  it('marks the total a subtotal when an income row was left out', async () => {
    getIncomeBySource.mockResolvedValue({
      data: [{ categoryId: 'c1', categoryName: 'Salary', color: null, total: 50 }],
      totalIncome: null,
      knownIncome: 50,
      currency: 'CAD',
      missingCurrencies: ['JPY'],
      excludedCount: 1,
    });
    await renderWidget();
    expect(screen.getByTestId('partial-total')).toHaveTextContent('$50');
    expect(screen.queryByText('$0')).not.toBeInTheDocument();
  });

  it('keeps every signed source accessible in the bounded bar chart', async () => {
    const data = Array.from({ length: 20 }, (_, i) => ({
      categoryId: `c${i}`, categoryName: `Source ${i}`,
      total: i === 19 ? -50 : 10, percentage: null,
    }));
    getIncomeBySource.mockResolvedValue({ data, totalIncome: 140 });
    await renderWidget();
    expect(screen.queryByTestId('pie-data')).not.toBeInTheDocument();
    expect(screen.getByTestId('responsive-container').parentElement).toHaveClass('overflow-y-auto');
    expect(screen.getByText('$140')).toBeInTheDocument();
  });

  it('merges sources past the fifteenth into Other so the slices add up to the total', async () => {
    const data = Array.from({ length: 20 }, (_, i) => ({
      categoryId: `c${i}`,
      categoryName: `Source ${i}`,
      color: null,
      total: 100,
    }));
    getIncomeBySource.mockResolvedValue({ data, totalIncome: 2000 });
    await renderWidget();
    const slices = JSON.parse(screen.getByTestId('pie-data').dataset.slices!);
    expect(slices).toHaveLength(16);
    expect(slices[15]).toMatchObject({ name: 'Other', value: 500 });
    expect(slices.reduce((s: number, x: { value: number }) => s + x.value, 0)).toBe(2000);
    expect(screen.getByText('$2000')).toBeInTheDocument();
  });

  it("carries each source's server share to its slice, and the merged slice's as their sum (issue #2414)", async () => {
    // Two equal sources of 1.2474 read 1.25 over 2.49 (50.2% by the readings);
    // the server's share of each is 50, which the tooltip reads.
    const data = Array.from({ length: 17 }, (_, i) => ({
      categoryId: `c${i}`,
      categoryName: `Source ${i}`,
      color: null,
      total: 1.25,
      percentage: i < 15 ? 5 : 12.5,
    }));
    getIncomeBySource.mockResolvedValue({ data, totalIncome: 21.21 });
    await renderWidget();
    const slices = JSON.parse(screen.getByTestId('pie-data').dataset.slices!);
    expect(slices[0].percentage).toBe(5);
    expect(slices[15]).toMatchObject({ name: 'Other', percentage: 25 });
  });
});

