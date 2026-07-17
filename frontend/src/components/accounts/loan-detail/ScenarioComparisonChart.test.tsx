import { describe, it, expect, vi } from 'vitest';
import type { ReactNode } from 'react';
import { render, screen, fireEvent, act, waitFor } from '@/test/render';
import { captureSvgAsImage } from '@/lib/pdf-export-charts';
import { ScenarioComparisonChart, ScenarioOutcome } from './ScenarioComparisonChart';

vi.mock('@/lib/pdf-export-charts', () => ({
  captureSvgAsImage: vi.fn(),
}));

// Recharts needs a real layout; stub it so the chart renders deterministically
// in jsdom. Lines expose their legend name and hide flag; the Legend stub
// exercises the formatter/click/hover contract for the first scenario series.
vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  LineChart: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Line: ({
    name,
    dataKey,
    hide,
    legendType,
    onMouseEnter,
    onMouseLeave,
  }: {
    name?: string;
    dataKey: string;
    hide?: boolean;
    legendType?: string;
    onMouseEnter?: () => void;
    onMouseLeave?: () => void;
  }) => (
    <div
      data-testid="chart-line"
      data-key={dataKey}
      data-hidden={hide ? 'true' : 'false'}
      data-legend={legendType ?? 'line'}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      {name}
    </div>
  ),
  XAxis: () => null,
  YAxis: () => null,
  CartesianGrid: () => null,
  Legend: ({
    onClick,
    onMouseEnter,
    formatter,
  }: {
    onClick?: (entry: unknown) => void;
    onMouseEnter?: (entry: unknown) => void;
    formatter?: (value: string, entry: unknown) => ReactNode;
  }) => (
    <div>
      <button data-testid="legend-s1" onClick={() => onClick?.({ dataKey: 's1' })}>
        toggle-s1
      </button>
      <button
        data-testid="legend-hover-s1"
        onMouseEnter={() => onMouseEnter?.({ dataKey: 's1' })}
      >
        hover-s1
      </button>
      <span data-testid="legend-label-s1">{formatter?.('Label', { dataKey: 's1' })}</span>
    </div>
  ),
  Tooltip: ({ content }: { content: (props: unknown) => ReactNode }) => (
    <div data-testid="tooltip">
      {content({
        active: true,
        payload: [{ dataKey: 's1' }, { dataKey: 'baseline' }],
        label: 'Jan 2028',
      })}
      {content({ active: false, payload: [], label: '' })}
    </div>
  ),
}));

const outcomes: ScenarioOutcome[] = [
  {
    id: 's1',
    name: 'Aggressive',
    recurringExtra: 1500,
    lumpSumCount: 0,
    interestSaved: 30000,
    payoffDate: '2030-06-15',
  },
  {
    id: 's2',
    name: 'Moderate',
    recurringExtra: 500,
    lumpSumCount: 2,
    interestSaved: 15000,
    payoffDate: '2035-03-15',
  },
];

const baseline = { payoffDate: '2040-01-15' };

function renderChart(
  overrides: Partial<Parameters<typeof ScenarioComparisonChart>[0]> = {},
) {
  return render(
    <ScenarioComparisonChart
      outcomes={outcomes}
      baseline={baseline}
      currencyCode="PLN"
      {...overrides}
    />,
  );
}

describe('ScenarioComparisonChart', () => {
  it('draws a baseline marker and an arc per scenario, named with the overpayment', () => {
    renderChart();

    // Baseline zero-line + one parabola per scenario (the transparent hover
    // hit-lines are excluded from the legend)
    const lines = screen
      .getAllByTestId('chart-line')
      .filter((l) => l.dataset.legend !== 'none');
    expect(lines).toHaveLength(3);
    const legendNames = lines.map((l) => l.textContent).join('|');
    expect(legendNames).toMatch(/No overpayments/);
    expect(legendNames).toMatch(/Aggressive · \+.*1,500.*\/ payment/);
    expect(legendNames).toMatch(/Moderate · \+.*500.*\/ payment \+ 2 lump sums/);
  });

  it('shows the real interest saved and payoff date in the tooltip', () => {
    renderChart();

    // The tooltip lists only the hovered series (s1) with its true figures,
    // not the interpolated arc height.
    const tooltip = screen.getByTestId('tooltip');
    expect(tooltip).toHaveTextContent(/Aggressive/);
    expect(tooltip).toHaveTextContent(/1,500/); // the monthly extra
    expect(tooltip).toHaveTextContent(/30,000/);
    expect(tooltip).toHaveTextContent('Jun 2030');
    expect(tooltip).not.toHaveTextContent(/Moderate/);
  });

  it('bolds the hovered line in the tooltip via its wide hit-line twin', async () => {
    renderChart();

    const tooltip = screen.getByTestId('tooltip');
    expect(tooltip.querySelector('.font-semibold')).toBeNull();

    const hitLine = screen
      .getAllByTestId('chart-line')
      .find((l) => l.dataset.key === 's1' && l.dataset.legend === 'none')!;
    await act(async () => {
      fireEvent.mouseEnter(hitLine);
    });
    const bolded = tooltip.querySelector('.font-semibold');
    expect(bolded).toBeTruthy();
    expect(bolded).toHaveTextContent(/Aggressive/);

    await act(async () => {
      fireEvent.mouseLeave(hitLine);
    });
    expect(tooltip.querySelector('.font-semibold')).toBeNull();
  });

  it('labels a scenario that never pays off within the projection', () => {
    renderChart({ outcomes: [{ ...outcomes[0], payoffDate: null }] });

    expect(screen.getByTestId('tooltip')).toHaveTextContent('Beyond projection');
  });

  it('toggles a line via a legend click and strikes its legend label through', async () => {
    renderChart();

    const lineOf = (key: string) =>
      screen.getAllByTestId('chart-line').find((l) => l.dataset.key === key)!;
    expect(lineOf('s1').dataset.hidden).toBe('false');

    await act(async () => {
      fireEvent.click(screen.getByTestId('legend-s1'));
    });
    expect(lineOf('s1').dataset.hidden).toBe('true');
    expect(
      screen.getByTestId('legend-label-s1').querySelector('.line-through'),
    ).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByTestId('legend-s1'));
    });
    expect(lineOf('s1').dataset.hidden).toBe('false');
  });

  it('emphasizes the hovered series in the legend', async () => {
    renderChart();

    expect(
      screen.getByTestId('legend-label-s1').querySelector('.font-semibold'),
    ).toBeNull();
    await act(async () => {
      fireEvent.mouseEnter(screen.getByTestId('legend-hover-s1'));
    });
    expect(
      screen.getByTestId('legend-label-s1').querySelector('.font-semibold'),
    ).toBeTruthy();
  });

  it('exports the chart as PNG like the payoff chart', async () => {
    vi.mocked(captureSvgAsImage).mockResolvedValue({
      dataUrl: 'data:image/png;base64,x',
      width: 100,
      height: 50,
    });
    renderChart();

    await act(async () => {
      fireEvent.click(
        screen.getByRole('button', { name: /Download Scenario comparison as PNG/i }),
      );
    });
    await waitFor(() => expect(captureSvgAsImage).toHaveBeenCalledTimes(1));
  });
});
