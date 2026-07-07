import { ReactNode } from 'react';

/**
 * Lightweight Recharts stand-in for widget/chart tests. Recharts'
 * ResponsiveContainer measures its parent (0x0 in jsdom) and renders nothing,
 * so tests mock it out. Chart containers pass children through; leaf marks are
 * no-ops. Use via:
 *   vi.mock('recharts', async () => (await import('@/test/recharts-mock')).rechartsMock());
 */
export function rechartsMock() {
  const Pass = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  const Noop = () => null;
  return {
    ResponsiveContainer: ({ children }: { children?: ReactNode }) => (
      <div data-testid="responsive-container">{children}</div>
    ),
    AreaChart: Pass,
    Area: Noop,
    LineChart: Pass,
    Line: Noop,
    BarChart: Pass,
    Bar: Noop,
    PieChart: Pass,
    Pie: Noop,
    Cell: Noop,
    XAxis: Noop,
    YAxis: Noop,
    CartesianGrid: Noop,
    Tooltip: Noop,
    Legend: Noop,
    ReferenceLine: Noop,
  };
}
