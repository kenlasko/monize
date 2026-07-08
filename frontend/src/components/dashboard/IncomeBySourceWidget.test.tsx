import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, screen } from '@testing-library/react';
import { render } from '@/test/render';
import { IncomeBySourceWidget } from './IncomeBySourceWidget';

vi.mock('recharts', async () => (await import('@/test/recharts-mock')).rechartsMock());

vi.mock('@/hooks/useWidgetConfig', () => ({
  useWidgetConfig: () => ({ config: { range: '1y', chartType: 'pie' }, updateConfig: vi.fn() }),
}));
vi.mock('@/hooks/useNumberFormat', () => ({
  useNumberFormat: () => ({
    formatCurrencyCompact: (n: number) => `$${n}`,
    formatCurrencyAxis: (n: number) => `$${n}`,
  }),
}));

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
    expect(screen.getByText('$5000')).toBeInTheDocument();
    expect(screen.getByTestId('responsive-container')).toBeInTheDocument();
  });

  it('shows the empty state with no income', async () => {
    getIncomeBySource.mockResolvedValue({ data: [], totalIncome: 0 });
    await renderWidget();
    expect(screen.getByText('No income in this period.')).toBeInTheDocument();
  });
});
