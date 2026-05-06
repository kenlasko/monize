import { describe, it, expect } from 'vitest';
import { render, screen } from '@/test/render';
import { CashFlowLegendSwatch, CashFlowMarker, FanChartTooltip } from './MonteCarloChartParts';

describe('CashFlowLegendSwatch', () => {
  it('renders income start triangle in green', () => {
    const { container } = render(
      <svg>
        <CashFlowLegendSwatch role="start" income={true} />
      </svg>,
    );
    const polygon = container.querySelector('polygon');
    expect(polygon?.getAttribute('fill')).toBe('#16a34a');
  });

  it('renders expense end triangle in red', () => {
    const { container } = render(
      <svg>
        <CashFlowLegendSwatch role="end" income={false} />
      </svg>,
    );
    const polygon = container.querySelector('polygon');
    expect(polygon?.getAttribute('fill')).toBe('#dc2626');
  });
});

describe('CashFlowMarker', () => {
  it('renders income start marker (up triangle, green)', () => {
    const { container } = render(
      <svg>
        <CashFlowMarker cx={50} cy={50} role="start" income={true} />
      </svg>,
    );
    const polygon = container.querySelector('polygon');
    expect(polygon?.getAttribute('fill')).toBe('#16a34a');
  });

  it('renders expense end marker (down triangle, red)', () => {
    const { container } = render(
      <svg>
        <CashFlowMarker cx={20} cy={30} role="end" income={false} />
      </svg>,
    );
    const polygon = container.querySelector('polygon');
    expect(polygon?.getAttribute('fill')).toBe('#dc2626');
  });
});

const fmt = (v: number) => `$${v.toFixed(0)}`;

describe('FanChartTooltip', () => {
  it('returns null when not active', () => {
    const { container } = render(
      <FanChartTooltip active={false} payload={[]} fmt={fmt} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('returns null when payload is empty', () => {
    const { container } = render(<FanChartTooltip active={true} payload={[]} fmt={fmt} />);
    expect(container.firstChild).toBeNull();
  });

  it('returns null when payload row is missing', () => {
    const { container } = render(
      <FanChartTooltip active={true} payload={[{}]} fmt={fmt} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders percentile rows without events', () => {
    render(
      <FanChartTooltip
        active={true}
        label="2030"
        payload={[{ payload: { p10: 1, p25: 2, p50: 3, p75: 4, p90: 5 } }]}
        fmt={fmt}
      />,
    );
    expect(screen.getByText('2030')).toBeInTheDocument();
    expect(screen.getByText('Median (50th)')).toBeInTheDocument();
    expect(screen.getByText('$3')).toBeInTheDocument();
  });

  it('renders one-time event with no inflation adjustment', () => {
    render(
      <FanChartTooltip
        active={true}
        label="2030"
        payload={[{ payload: { p10: 0, p25: 0, p50: 0, p75: 0, p90: 0 } }]}
        fmt={fmt}
        events={[
          {
            role: 'start',
            income: true,
            name: 'Bonus',
            amount: 1000,
            flowType: 'ONE_TIME',
            startYear: 2030,
            inflationAdjust: false,
          },
        ]}
      />,
    );
    expect(screen.getByText('Bonus')).toBeInTheDocument();
    expect(screen.getByText(/One-time/i)).toBeInTheDocument();
  });

  it('renders recurring start event with inflation adjustment and end year', () => {
    render(
      <FanChartTooltip
        active={true}
        label="2030"
        payload={[{ payload: { p10: 0, p25: 0, p50: 0, p75: 0, p90: 0 } }]}
        fmt={fmt}
        events={[
          {
            role: 'start',
            income: false,
            name: 'Mortgage',
            amount: 500,
            flowType: 'RECURRING',
            startYear: 2030,
            endYear: 2050,
            inflationAdjust: true,
          },
        ]}
      />,
    );
    expect(screen.getByText('Starts: Mortgage')).toBeInTheDocument();
    expect(screen.getByText(/inflated/i)).toBeInTheDocument();
    expect(screen.getByText(/year 2030–2050/)).toBeInTheDocument();
  });

  it('renders recurring start event without end year (open-ended +)', () => {
    render(
      <FanChartTooltip
        active={true}
        label="2030"
        payload={[{ payload: { p10: 0, p25: 0, p50: 0, p75: 0, p90: 0 } }]}
        fmt={fmt}
        events={[
          {
            role: 'end',
            income: true,
            name: 'Salary',
            amount: 2000,
            flowType: 'RECURRING',
            startYear: 2025,
            endYear: null,
            inflationAdjust: false,
          },
        ]}
      />,
    );
    expect(screen.getByText('Ends: Salary')).toBeInTheDocument();
    expect(screen.getByText(/year 2025\+/)).toBeInTheDocument();
  });
});
