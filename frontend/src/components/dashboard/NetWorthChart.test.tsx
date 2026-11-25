import { cloneElement, type ReactElement } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act } from '@testing-library/react';
import { render, screen, fireEvent, within } from '@/test/render';
import { NetWorthChart } from './NetWorthChart';
import type { NetWorthConfig } from './widget-config';

const updateConfig = vi.fn();
const configState: { current: NetWorthConfig } = {
  current: { range: '1y', barStyle: 'accountType' },
};
vi.mock('@/hooks/useWidgetConfig', () => ({
  useWidgetConfig: () => ({ config: configState.current, updateConfig }),
}));

const getMonthly = vi.fn();
vi.mock('@/lib/net-worth', () => ({
  netWorthApi: { getMonthly: (...a: unknown[]) => getMonthly(...a) },
}));

// The last tooltip element the chart was given, so a case can render it over
// a row the chart was handed.
let lastTooltip: ReactElement | null = null;

vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }: any) => <div data-testid="responsive-container">{children}</div>,
  BarChart: ({ children, data }: any) => <div data-testid="bar-chart" data-points={JSON.stringify(data)}>{children}</div>,
  ComposedChart: ({ children, stackOffset, data }: any) => (
    <div data-testid="composed-chart" data-stack-offset={stackOffset} data-points={JSON.stringify(data)}>{children}</div>
  ),
  Bar: ({ children, name, dataKey }: any) => (
    <div data-testid="bar" data-name={name} data-key={typeof dataKey === 'string' ? dataKey : 'fn'}>{children}</div>
  ),
  Line: ({ children, name }: any) => <div data-testid="line" data-name={name}>{children}</div>,
  LabelList: ({ formatter }: any) => (
    <div data-testid="label-list">{formatter ? String(formatter(1000)) : ''}</div>
  ),
  Legend: () => <div data-testid="legend" />,
  CartesianGrid: () => null,
  ReferenceLine: () => null,
  XAxis: ({ ticks }: any) => <div data-testid="x-axis" data-ticks={JSON.stringify(ticks ?? null)} />,
  YAxis: ({ domain }: any) => (
    <div data-testid="y-axis" data-domain={JSON.stringify(domain)} />
  ),
  Tooltip: ({ content }: any) => {
    lastTooltip = content;
    // `content` is a React element; invoke its function component so the
    // tooltip's render branches are exercised.
    const fn = content?.type;
    if (typeof fn === 'function') {
      try {
        fn({ active: true, payload: [{ payload: { name: 'Jan 2024', netWorth: 100, assets: 200, liabilities: 100 } }] });
        fn({ active: false, payload: [] });
      } catch {}
    }
    return null;
  },
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

vi.mock('@/hooks/useNumberFormat', async () => {
  const { numberFormatMockDefaults } = await import('@/test/number-format-mock');
  return {
    useNumberFormat: () => ({
      ...numberFormatMockDefaults(),
      formatCurrencyCompact: (n: number) => `$${n.toFixed(0)}`,
      formatCurrencyLabel: (n: number) => `$${n}`,
      defaultCurrency: 'USD',
    }),
  };
});
vi.mock('@/lib/utils', async (importActual) => ({
  ...(await importActual<typeof import('@/lib/utils')>()),
  parseLocalDate: (d: string) => new Date(d + 'T00:00:00'),
  cn: (...args: any[]) => args.filter(Boolean).join(' '),
}));

describe('NetWorthChart', () => {
  beforeEach(() => {
    window.localStorage.clear();
    setMobile(false);
    updateConfig.mockReset();
    getMonthly.mockReset();
    configState.current = { range: '1y', barStyle: 'accountType' };
  });

  async function renderWidget(data: unknown[] | Error, isLoading = false) {
    if (data instanceof Error) getMonthly.mockRejectedValue(data);
    else getMonthly.mockResolvedValue(data);
    await act(async () => {
      render(<NetWorthChart isLoading={isLoading} />);
    });
  }

  const twoMonths = [
    { month: '2024-01-01', assets: 10000, liabilities: 0, netWorth: 10000 },
    { month: '2024-06-01', assets: 15000, liabilities: 0, netWorth: 15000 },
  ];

  it('renders loading state with title and pulse skeleton', async () => {
    await renderWidget([], true);
    expect(screen.getByText('Net Worth')).toBeInTheDocument();
    expect(document.querySelector('.animate-pulse')).toBeInTheDocument();
    expect(screen.queryByTestId('composed-chart')).not.toBeInTheDocument();
  });

  it('renders empty state when no data', async () => {
    await renderWidget([]);
    expect(screen.getByText('No net worth data available yet.')).toBeInTheDocument();
    expect(screen.queryByTestId('composed-chart')).not.toBeInTheDocument();
  });

  it('says the history failed to load rather than showing it as empty', async () => {
    await renderWidget(new Error('boom'));
    expect(screen.getByText(/Couldn't load your net worth history/)).toBeInTheDocument();
    expect(screen.queryByText('No net worth data available yet.')).not.toBeInTheDocument();
  });

  it('renders chart with data and shows current net worth', async () => {
    await renderWidget(twoMonths);
    expect(screen.getByTestId('composed-chart')).toBeInTheDocument();
    // The header names the window.
    expect(screen.getByText('1Y')).toBeInTheDocument();
    expect(screen.getByText('$15000')).toBeInTheDocument();
    // The title is the way to the report; there is no second link under the chart.
    expect(screen.queryByText('View full report')).not.toBeInTheDocument();
  });

  it('asks for the history again when a price refresh wrote new prices, keeping the chart meanwhile', async () => {
    getMonthly.mockResolvedValue(twoMonths);
    let view!: ReturnType<typeof render>;
    await act(async () => {
      view = render(<NetWorthChart isLoading={false} refreshKey={0} />);
    });
    expect(screen.getByText('$15000')).toBeInTheDocument();

    let answer: (value: unknown[]) => void = () => {};
    getMonthly.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    await act(async () => {
      view.rerender(<NetWorthChart isLoading={false} refreshKey={1} />);
    });
    expect(getMonthly).toHaveBeenCalledTimes(2);
    // The same question asked again: the chart drawn stays until it answers.
    expect(screen.getByTestId('composed-chart')).toBeInTheDocument();
    expect(screen.getByText('$15000')).toBeInTheDocument();

    await act(async () => {
      answer([twoMonths[0], { ...twoMonths[1], assets: 16000, netWorth: 16000 }]);
    });
    expect(screen.getByText('$16000')).toBeInTheDocument();
  });

  it('fetches the configured window, month-aligned', async () => {
    configState.current = { range: '10y', barStyle: 'accountType' };
    await renderWidget(twoMonths);
    expect(screen.getByText('10Y')).toBeInTheDocument();
    const [{ startDate, endDate }] = getMonthly.mock.calls[0] as [{ startDate: string; endDate: string }];
    expect(startDate).toMatch(/-01$/);
    const years = Number(endDate.slice(0, 4)) - Number(startDate.slice(0, 4));
    expect(years).toBeGreaterThanOrEqual(9);
    expect(years).toBeLessThanOrEqual(10);
  });

  it('names each January by its year over a long window, without value labels', async () => {
    configState.current = { range: '5y', barStyle: 'accountType' };
    const months = Array.from({ length: 48 }, (_, i) => {
      const year = 2021 + Math.floor(i / 12);
      const month = String((i % 12) + 1).padStart(2, '0');
      return { month: `${year}-${month}-01`, assets: 1000 + i, liabilities: 0, netWorth: 1000 + i };
    });
    await renderWidget(months);
    expect(JSON.parse(screen.getByTestId('x-axis').getAttribute('data-ticks')!)).toEqual([
      '2021-01-01',
      '2022-01-01',
      '2023-01-01',
      '2024-01-01',
    ]);
    expect(screen.queryByTestId('label-list')).not.toBeInTheDocument();
  });

  it('toggles to the 100% stacked composition chart and persists the choice', async () => {
    await renderWidget(twoMonths);
    // The header switcher is the widget's own control, the gear's height.
    expect(screen.getByRole('group', { name: 'View' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Bar Chart' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByTitle('100% Stacked Bar'));
    // The stacked view renders two series (assets + liabilities).
    expect(screen.getAllByTestId('bar')).toHaveLength(2);
    expect(window.localStorage.getItem('dashboard.net-worth.chartType')).toBe('"stacked"');
  });

  it('restores the stacked composition view from localStorage', async () => {
    window.localStorage.setItem('dashboard.net-worth.chartType', '"stacked"');
    await renderWidget(twoMonths);
    expect(screen.getAllByTestId('bar')).toHaveLength(2);
  });

  it('renders abbreviated value labels above the bars', async () => {
    await renderWidget(twoMonths);
    // A LabelList at the top of each bar formats each value via
    // formatCurrencyLabel (mocked here as `$<value>`).
    expect(screen.getByTestId('label-list')).toBeInTheDocument();
    expect(screen.getByText('$1000')).toBeInTheDocument();
  });

  it('shows positive change with plus sign and green styling', async () => {
    await renderWidget(twoMonths);
    // Change is +5000, 50%
    const changeEl = screen.getByText(/\+\$5000/);
    expect(changeEl).toBeInTheDocument();
    expect(changeEl.className).toContain('text-green');
  });

  it('shows negative change with red styling', async () => {
    await renderWidget([...twoMonths].reverse().map((m, i) => ({ ...m, month: twoMonths[i].month })));
    // Change is -5000
    const changeEl = screen.getByText(/\$-5000/);
    expect(changeEl).toBeInTheDocument();
    expect(changeEl.className).toContain('text-red');
  });

  it('links the title to the net worth report', async () => {
    await renderWidget(twoMonths);
    expect(screen.getByRole('link', { name: 'Net Worth' })).toHaveAttribute(
      'href',
      '/reports/net-worth',
    );
  });

  it('links the title to the report in the loading and empty states', async () => {
    await renderWidget([], true);
    expect(screen.getByRole('link', { name: 'Net Worth' })).toHaveAttribute('href', '/reports/net-worth');
  });

  it('shows negative net worth with red styling', async () => {
    await renderWidget([
      { month: '2024-01-01', assets: 0, liabilities: 5000, netWorth: -5000 },
      { month: '2024-06-01', assets: 0, liabilities: 3000, netWorth: -3000 },
    ]);
    const currentEl = screen.getByText('$-3000');
    expect(currentEl.className).toContain('text-red');
  });

  const byType = [
    {
      month: '2024-01-01',
      assets: 210000,
      liabilities: 150000,
      netWorth: 60000,
      byAccountType: { CHEQUING: 5000, INVESTMENT: 205000, MORTGAGE: -150000 },
    },
    {
      month: '2024-02-01',
      assets: 214000,
      liabilities: 149000,
      netWorth: 65000,
      byAccountType: { CHEQUING: 4000, SAVINGS: 5000, INVESTMENT: 205000, MORTGAGE: -149000 },
    },
  ];

  it('stacks the bars by account type, with a legend and the net worth line', async () => {
    await renderWidget(byType);
    // Liabilities stack below zero, assets above it.
    expect(screen.getByTestId('composed-chart')).toHaveAttribute('data-stack-offset', 'sign');
    expect(screen.getAllByTestId('bar').map((bar) => bar.getAttribute('data-name'))).toEqual([
      'Chequing',
      'Savings',
      'Investment',
      'Mortgage',
    ]);
    expect(screen.getByTestId('legend')).toBeInTheDocument();
    expect(
      screen.getAllByTestId('line').some((line) => line.getAttribute('data-name') === 'Net Worth'),
    ).toBe(true);
  });

  it('draws one solid net worth bar a month when that style is chosen', async () => {
    configState.current = { range: '1y', barStyle: 'netWorth' };
    await renderWidget(byType);
    const bars = screen.getAllByTestId('bar');
    expect(bars).toHaveLength(1);
    expect(bars[0]).toHaveAttribute('data-key', 'netWorth');
  });

  describe('settings', () => {
    async function openSettings() {
      await renderWidget(twoMonths);
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Configure Net Worth' }));
      });
    }

    it('offers 1Y to 10Y and stores the window chosen', async () => {
      await openSettings();
      for (const label of ['1Y', '2Y', '5Y', '10Y']) {
        expect(screen.getAllByRole('button', { name: label }).length).toBeGreaterThan(0);
      }
      fireEvent.click(screen.getByRole('button', { name: '10Y' }));
      expect(updateConfig).toHaveBeenCalledWith({ range: '10y' });
    });

    it('switches between a solid net worth bar and stacked by account type', async () => {
      await openSettings();
      fireEvent.click(screen.getByRole('button', { name: 'Net worth' }));
      expect(updateConfig).toHaveBeenCalledWith({ barStyle: 'netWorth' });
    });
  });

  it('handles single data point correctly', async () => {
    await renderWidget([{ month: '2024-01-01', assets: 10000, liabilities: 0, netWorth: 10000 }]);
    // Single data point: change = 0, percent = 0
    expect(screen.getByText('$10000')).toBeInTheDocument();
    expect(screen.getByTestId('composed-chart')).toBeInTheDocument();
  });

  describe('figures from the server, not from whole units (issue #2412)', () => {
    // 100.404 and 100.898 read 100.40 and 100.90: rounded to whole units they
    // were 100 and 101, a change of 1, and half a unit apart as readings; the
    // server's change, 0.494, reads 0.49. The last month's sides, 10.60 and
    // 0.40, read 11 and 0 in whole units, where its own net worth is 10.20.
    const months = [
      { month: '2024-01-01', assets: 100.4, liabilities: 0, netWorth: 100.4, netWorthChangeFromStart: 0 },
      { month: '2024-06-01', assets: 10.6, liabilities: 0.4, netWorth: 100.9, netWorthChangeFromStart: 0.49 },
    ];

    it("reads the window's change from the server", async () => {
      await renderWidget(months);
      expect(screen.getByText(/\+\$0 /)).toBeInTheDocument();
      expect(screen.queryByText(/\+\$1 /)).not.toBeInTheDocument();
    });

    it("prints the month's own net worth in the composition tooltip", async () => {
      await renderWidget([months[0], { ...months[1], netWorth: 10.2 }]);
      fireEvent.click(screen.getByTitle('100% Stacked Bar'));
      const rows = JSON.parse(screen.getByTestId('bar-chart').getAttribute('data-points')!);
      render(cloneElement(lastTooltip as ReactElement<any>, { active: true, payload: [{ payload: rows[1] }] }));
      const lines = Array.from(document.querySelectorAll('p')).map((p) => p.textContent);
      expect(lines).toContain('Net Worth: $10');
    });
  });

  describe('a month the server could not fully convert', () => {
    const partialMonths = [
      { month: '2024-01-01', assets: 10000, liabilities: 0, netWorth: 10000, fxComplete: true, missingRatePairs: [] },
      { month: '2024-06-01', assets: 10000, liabilities: 0, netWorth: 10000, fxComplete: false, missingRatePairs: ['ZZZ->USD'] },
    ];

    it('marks the headline partial and names the currency', async () => {
      await renderWidget(partialMonths);
      const marker = screen.getByTestId('partial-total');
      expect(within(marker).getByText('$10000')).toBeInTheDocument();
      expect(within(marker).getByRole('button').getAttribute('aria-label')).toContain('ZZZ');
    });

    it('withholds the change rather than printing a measured one', async () => {
      await renderWidget(partialMonths);
      expect(screen.getByTestId('unknown-amount')).toBeInTheDocument();
      expect(screen.queryByText(/\+\$0/)).not.toBeInTheDocument();
    });

    it('draws the partial month as null in the bar and the stacked views', async () => {
      await renderWidget(partialMonths);
      const bars = JSON.parse(screen.getByTestId('composed-chart').getAttribute('data-points')!);
      expect(bars.map((p: { netWorth: number | null }) => p.netWorth)).toEqual([10000, null]);
      expect(bars[1].byAccountType).toBeUndefined();

      fireEvent.click(screen.getByTitle('100% Stacked Bar'));
      const stacked = JSON.parse(screen.getByTestId('bar-chart').getAttribute('data-points')!);
      expect(stacked[1].assets).toBeNull();
      expect(stacked[1].liabilities).toBeNull();
    });

    it('marks nothing on a complete series', async () => {
      await renderWidget(twoMonths);
      expect(screen.queryByTestId('partial-total')).not.toBeInTheDocument();
      expect(screen.queryByTestId('unknown-amount')).not.toBeInTheDocument();
    });
  });
});
