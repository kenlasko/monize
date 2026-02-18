import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@/test/render';
import { ResultChart } from './ResultChart';

// Mock recharts to avoid SVG rendering issues in jsdom
vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }: any) => (
    <div data-testid="responsive-container">{children}</div>
  ),
  BarChart: ({ children }: any) => (
    <div data-testid="bar-chart">{children}</div>
  ),
  Bar: () => null,
  PieChart: ({ children }: any) => (
    <div data-testid="pie-chart">{children}</div>
  ),
  Pie: () => null,
  Cell: () => null,
  XAxis: () => null,
  YAxis: () => null,
  CartesianGrid: () => null,
  Tooltip: () => null,
  AreaChart: ({ children }: any) => (
    <div data-testid="area-chart">{children}</div>
  ),
  Area: () => null,
}));

const sampleData = [
  { label: 'Groceries', value: 500 },
  { label: 'Dining Out', value: 300 },
  { label: 'Transport', value: 200 },
];

describe('ResultChart', () => {
  it('renders nothing when data is empty', () => {
    const { container } = render(
      <ResultChart type="bar" title="Test Chart" data={[]} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing when data is null/undefined', () => {
    const { container } = render(
      <ResultChart type="bar" title="Test Chart" data={null as any} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders the chart title', () => {
    render(<ResultChart type="bar" title="Spending Breakdown" data={sampleData} />);
    expect(screen.getByText('Spending Breakdown')).toBeInTheDocument();
  });

  it('renders a bar chart when type is bar', () => {
    render(<ResultChart type="bar" title="Bar Chart" data={sampleData} />);
    expect(screen.getByTestId('bar-chart')).toBeInTheDocument();
  });

  it('renders a pie chart when type is pie', () => {
    render(<ResultChart type="pie" title="Pie Chart" data={sampleData} />);
    expect(screen.getByTestId('pie-chart')).toBeInTheDocument();
  });

  it('renders an area chart when type is area', () => {
    render(<ResultChart type="area" title="Area Chart" data={sampleData} />);
    expect(screen.getByTestId('area-chart')).toBeInTheDocument();
  });

  it('renders an area chart when type is line', () => {
    render(<ResultChart type="line" title="Line Chart" data={sampleData} />);
    expect(screen.getByTestId('area-chart')).toBeInTheDocument();
  });

  it('wraps chart in ResponsiveContainer', () => {
    render(<ResultChart type="bar" title="Test" data={sampleData} />);
    expect(screen.getByTestId('responsive-container')).toBeInTheDocument();
  });

  it('renders with single data point', () => {
    render(
      <ResultChart
        type="bar"
        title="Single"
        data={[{ label: 'Only', value: 100 }]}
      />,
    );
    expect(screen.getByText('Single')).toBeInTheDocument();
    expect(screen.getByTestId('bar-chart')).toBeInTheDocument();
  });
});
