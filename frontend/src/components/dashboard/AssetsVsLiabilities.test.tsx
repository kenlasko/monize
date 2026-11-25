import type { ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, screen, within } from '@testing-library/react';
import { render } from '@/test/render';
import { AssetsVsLiabilities } from './AssetsVsLiabilities';
import type { AssetsLiabilitiesConfig } from './widget-config';
import { MonthlyNetWorth } from '@/types/net-worth';

// What the donut was last given: its slices and its tooltip, so a case can
// render the tooltip the chart would show over one slice.
const drawn = vi.hoisted(() => ({
  slices: [] as Array<{ key: string; value: number }>,
  tooltip: null as null | ((props: { active: boolean; payload: Array<{ payload: unknown }> }) => ReactNode),
}));
vi.mock('recharts', async () => ({
  ...(await import('@/test/recharts-mock')).rechartsMock(),
  Pie: ({ data }: { data: Array<{ key: string; value: number }> }) => {
    drawn.slices = data;
    return null;
  },
  Tooltip: ({ content }: { content: typeof drawn.tooltip }) => {
    drawn.tooltip = content;
    return null;
  },
}));

const updateConfig = vi.fn();
const configState: { current: AssetsLiabilitiesConfig } = { current: { view: 'legend' } };
vi.mock('@/hooks/useWidgetConfig', () => ({
  useWidgetConfig: () => ({ config: configState.current, updateConfig }),
}));

vi.mock('@/hooks/useNumberFormat', async () => {
  const { numberFormatMockDefaults } = await import('@/test/number-format-mock');
  return {
    useNumberFormat: () => ({
      ...numberFormatMockDefaults(),
      formatCurrencyCompact: (n: number) => `$${n.toFixed(0)}`,
      formatCurrencyTight: (n: number) => `$${(n / 1000).toFixed(1)}K`,
      defaultCurrency: 'USD',
    }),
  };
});

const months: MonthlyNetWorth[] = [
  { month: '2026-04-01', assets: 90000, liabilities: 40000, netWorth: 50000 },
  { month: '2026-05-01', assets: 120000, liabilities: 30000, netWorth: 90000 },
];

/** A ResizeObserver that reports the given content box as soon as it observes. */
function observeAs(width: number, height: number) {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(private readonly callback: ResizeObserverCallback) {}
      observe() {
        this.callback(
          [{ contentRect: { width, height } } as ResizeObserverEntry],
          this as unknown as ResizeObserver,
        );
      }
      unobserve() {}
      disconnect() {}
    },
  );
}

describe('AssetsVsLiabilities', () => {
  beforeEach(() => {
    updateConfig.mockReset();
    configState.current = { view: 'legend' };
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders loading skeleton with title', () => {
    render(<AssetsVsLiabilities data={[]} isLoading={true} />);
    expect(screen.getByText('Assets vs Liabilities')).toBeInTheDocument();
    expect(document.querySelector('.animate-pulse')).toBeInTheDocument();
  });

  it('says the load failed, not that there is no data, when the net worth request failed', () => {
    render(<AssetsVsLiabilities data={[]} isLoading={false} error />);
    expect(
      screen.getByText("Couldn't load your net worth history. Reload the dashboard to try again."),
    ).toBeInTheDocument();
    expect(screen.queryByText('No net worth data available yet.')).not.toBeInTheDocument();
  });

  it('keeps the empty-state copy for a successful empty answer', () => {
    render(<AssetsVsLiabilities data={[]} isLoading={false} error={false} />);
    expect(screen.getByText('No net worth data available yet.')).toBeInTheDocument();
  });

  it('renders empty state when there is no data', () => {
    render(<AssetsVsLiabilities data={[]} isLoading={false} />);
    expect(screen.getByText('No net worth data available yet.')).toBeInTheDocument();
  });

  it('uses the latest month for the assets/liabilities split and net worth', () => {
    render(<AssetsVsLiabilities data={months} isLoading={false} />);
    // Latest month (May): assets 120000, liabilities 30000, net 90000
    expect(screen.getByRole('button', { name: /^Assets/ })).toHaveTextContent('$120000');
    expect(screen.getByRole('button', { name: /^Liabilities/ })).toHaveTextContent('$30000');
    expect(within(screen.getByTestId('donut-chart-area')).getByText('$90000')).toBeInTheDocument();
  });

  it('omits a zero-valued slice (no liabilities)', () => {
    render(
      <AssetsVsLiabilities
        data={[{ month: '2026-05-01', assets: 100000, liabilities: 0, netWorth: 100000 }]}
        isLoading={false}
      />,
    );
    expect(screen.getByRole('button', { name: /^Assets/ })).toBeInTheDocument();
    expect(screen.queryByText('Liabilities')).not.toBeInTheDocument();
  });

  describe('figures from the server, not from whole units (issue #2412)', () => {
    // 100.40 of assets against 0.40 owed: rounded to whole units the
    // liabilities read 0 and their slice was dropped, net worth read 100
    // where the month's own is 100.00, and each share was over 100 rather
    // than the 100.80 the two sides come to.
    const month: MonthlyNetWorth = { month: '2026-05-01', assets: 100.4, liabilities: 0.4, netWorth: 100 };

    it('keeps a slice under half a unit', () => {
      render(<AssetsVsLiabilities data={[month]} isLoading={false} />);
      expect(screen.getByRole('button', { name: /^Liabilities/ })).toHaveTextContent('$0');
      expect(drawn.slices.map((slice) => [slice.key, slice.value])).toEqual([
        ['assets', 100.4],
        ['liabilities', 0.4],
      ]);
    });

    it("shares each slice over the server's two figures", () => {
      render(<AssetsVsLiabilities data={[{ ...month, assets: 99.4, liabilities: 0.6, netWorth: 98.8 }]} isLoading={false} />);
      const assets = drawn.slices.find((slice) => slice.key === 'assets')!;
      render(<>{drawn.tooltip!({ active: true, payload: [{ payload: assets }] })}</>);
      // 99.40 over 100.00 is 99.4%; over the whole units 99 + 1 it was 99.0%.
      expect(screen.getByText(/\(99\.4%\)/)).toBeInTheDocument();
    });
  });

  it('puts net worth inside the donut, compact in the callout view and in full in the legend', () => {
    observeAs(520, 280);
    for (const [view, figure] of [
      ['callouts', '$90.0K'],
      ['legend', '$90000'],
    ] as const) {
      configState.current = { view };
      const { unmount } = render(<AssetsVsLiabilities data={months} isLoading={false} />);
      const area = screen.getByTestId('donut-chart-area');
      expect(within(area).getByText('Net Worth')).toBeInTheDocument();
      expect(within(area).getByText(figure)).toBeInTheDocument();
      unmount();
    }
  });

  it('renders negative net worth in red', () => {
    render(
      <AssetsVsLiabilities
        data={[{ month: '2026-05-01', assets: 10000, liabilities: 25000, netWorth: -15000 }]}
        isLoading={false}
      />,
    );
    const netEl = within(screen.getByTestId('donut-chart-area')).getByText('$-15000');
    expect(netEl.className).toContain('text-red');
  });

  it('links the title to the net worth report', () => {
    render(<AssetsVsLiabilities data={months} isLoading={false} />);
    expect(screen.getByRole('link', { name: 'Assets vs Liabilities' })).toHaveAttribute(
      'href',
      '/reports/net-worth',
    );
  });

  describe('callout view', () => {
    beforeEach(() => {
      configState.current = { view: 'callouts' };
    });

    it('draws a box per slice beside the chart when they fit', () => {
      observeAs(520, 280);
      render(<AssetsVsLiabilities data={months} isLoading={false} />);
      const callouts = screen.getByRole('list', { name: 'Assets vs Liabilities' });
      expect(within(callouts).getAllByRole('listitem')).toHaveLength(2);
      expect(within(callouts).getByText('Assets')).toBeInTheDocument();
      expect(within(callouts).getByText('$120000')).toBeInTheDocument();
      expect(within(callouts).getByText('$30000')).toBeInTheDocument();
      // No legend beneath it.
      expect(screen.queryByRole('button', { name: /^Assets/ })).not.toBeInTheDocument();
    });

    it('falls back to the legend where the boxes would not fit', () => {
      observeAs(240, 240);
      render(<AssetsVsLiabilities data={months} isLoading={false} />);
      expect(screen.queryByRole('list', { name: 'Assets vs Liabilities' })).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: /^Assets/ })).toHaveTextContent('$120000');
    });
  });

  it('switches between labels and legend in its settings', async () => {
    render(<AssetsVsLiabilities data={months} isLoading={false} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Configure Assets vs Liabilities' }));
    });
    // Says where the labels will not appear, rather than leaving a phone
    // user to wonder why choosing them changed nothing.
    expect(screen.getByText("Labels need a wider screen. Where they don't fit, the legend is shown.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Labels' }));
    expect(updateConfig).toHaveBeenCalledWith({ view: 'callouts' });
  });

  describe('a latest month the server could not fully convert', () => {
    const partial = (over: Partial<MonthlyNetWorth>): MonthlyNetWorth[] => [
      months[0],
      { ...months[1], fxComplete: false, missingRatePairs: ['ZZZ->USD'], ...over },
    ];

    it('marks the net worth in the donut partial and names the currency', () => {
      render(<AssetsVsLiabilities data={partial({})} isLoading={false} />);
      const centre = within(screen.getByTestId('donut-chart-area'));
      const marker = centre.getByTestId('partial-total');
      expect(marker).toHaveTextContent('$90000');
      expect(within(marker).getByRole('button').getAttribute('aria-label')).toContain('ZZZ');
    });

    it('labels the side whose flag is false as partial and not the other', () => {
      render(
        <AssetsVsLiabilities
          data={partial({ assetsFxComplete: false, liabilitiesFxComplete: true })}
          isLoading={false}
        />,
      );
      expect(screen.getByRole('button', { name: /^Assets \(partial\)/ })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /^Liabilities/ })).not.toHaveTextContent('(partial)');
    });

    it('falls back to the month flag when the per-side flags are absent', () => {
      render(<AssetsVsLiabilities data={partial({})} isLoading={false} />);
      expect(screen.getByRole('button', { name: /^Assets \(partial\)/ })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /^Liabilities \(partial\)/ })).toBeInTheDocument();
    });

    it('marks nothing on a complete month', () => {
      render(<AssetsVsLiabilities data={months} isLoading={false} />);
      expect(screen.queryByTestId('partial-total')).not.toBeInTheDocument();
      expect(screen.queryByText(/\(partial\)/)).not.toBeInTheDocument();
    });
  });
});
