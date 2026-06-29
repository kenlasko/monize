import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, act } from '@/test/render';
import { AllSecuritiesChart, buildPerformanceData } from './AllSecuritiesChart';
import type { Security, SecurityPrice } from '@/types/investment';

vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  LineChart: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="line-chart">{children}</div>
  ),
  Line: ({ name }: { name?: string }) => <div data-testid="line" data-name={name} />,
  XAxis: () => null,
  YAxis: () => null,
  CartesianGrid: () => null,
  Tooltip: () => null,
  Legend: () => null,
}));

const mockGetSecurityPrices = vi.fn();
vi.mock('@/lib/investments', () => ({
  investmentsApi: {
    getSecurityPrices: (...args: unknown[]) => mockGetSecurityPrices(...args),
  },
}));

vi.mock('@/hooks/useChartDateFormat', () => ({
  useChartDateFormat: () => (d: Date) => d.toISOString().slice(0, 10),
}));
vi.mock('@/hooks/useNumberFormat', () => ({
  useNumberFormat: () => ({
    formatSignedPercent: (n: number) => `${n >= 0 ? '+' : ''}${n.toFixed(1)}%`,
  }),
}));
vi.mock('@/lib/utils', async (importActual) => ({
  ...(await importActual<typeof import('@/lib/utils')>()),
  parseLocalDate: (d: string) => new Date(d + 'T00:00:00'),
}));

function sec(id: string, symbol: string): Security {
  return {
    id,
    symbol,
    name: `${symbol} Inc`,
    currencyCode: 'USD',
    isActive: true,
  } as Security;
}
function price(priceDate: string, closePrice: number): SecurityPrice {
  return { priceDate, closePrice } as SecurityPrice;
}

describe('buildPerformanceData', () => {
  it('rebases each security to 0% at its first price and merges by date', () => {
    const { rows, series } = buildPerformanceData([
      { security: sec('s1', 'AAA'), prices: [price('2024-01-01', 10), price('2024-02-01', 15)] },
      { security: sec('s2', 'BBB'), prices: [price('2024-02-01', 100)] },
    ]);
    expect(series.map((s) => s.symbol)).toEqual(['AAA', 'BBB']);
    expect(rows).toHaveLength(2);
    // Earliest date: only AAA present, rebased to 0%.
    expect(rows[0].s1).toBe(0);
    expect(rows[0].s2).toBeUndefined();
    // Second date: AAA +50% (15/10), BBB rebased to 0% at its own first price.
    expect(rows[1].s1).toBe(50);
    expect(rows[1].s2).toBe(0);
  });

  it('drops a security with no prices or a non-positive base price', () => {
    const { series } = buildPerformanceData([
      { security: sec('s1', 'AAA'), prices: [] },
      { security: sec('s2', 'BBB'), prices: [price('2024-01-01', 0)] },
    ]);
    expect(series).toHaveLength(0);
  });
});

describe('AllSecuritiesChart', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  async function renderChart(securities: Security[]) {
    await act(async () => {
      render(<AllSecuritiesChart securities={securities} />);
    });
  }

  it('renders one line per security that has usable prices', async () => {
    mockGetSecurityPrices.mockImplementation((id: string) =>
      Promise.resolve(
        id === 's1'
          ? [price('2024-01-01', 10), price('2024-02-01', 12)]
          : [price('2024-01-01', 100), price('2024-02-01', 90)],
      ),
    );
    await renderChart([sec('s1', 'AAA'), sec('s2', 'BBB')]);

    await waitFor(() => expect(screen.getAllByTestId('line')).toHaveLength(2));
    const names = screen.getAllByTestId('line').map((l) => l.getAttribute('data-name'));
    expect(names).toEqual(expect.arrayContaining(['AAA', 'BBB']));
  });

  it('shows the no-data message when no security has price history', async () => {
    mockGetSecurityPrices.mockResolvedValue([]);
    await renderChart([sec('s1', 'AAA')]);

    await waitFor(() =>
      expect(
        screen.getByText(/No price history is available/i),
      ).toBeInTheDocument(),
    );
  });
});
