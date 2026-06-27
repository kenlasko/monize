import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@/test/render';
import { NetWorthChart } from './NetWorthChart';

const mockPush = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
}));

vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }: any) => <div data-testid="responsive-container">{children}</div>,
  BarChart: ({ children }: any) => <div data-testid="bar-chart">{children}</div>,
  Bar: ({ children }: any) => <div data-testid="bar">{children}</div>,
  LabelList: ({ formatter }: any) => (
    <div data-testid="label-list">{formatter ? String(formatter(1000)) : ''}</div>
  ),
  XAxis: () => null,
  YAxis: ({ domain }: any) => (
    <div data-testid="y-axis" data-domain={JSON.stringify(domain)} />
  ),
  Tooltip: ({ content }: any) => {
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

vi.mock('@/hooks/useNumberFormat', () => ({
  useNumberFormat: () => ({
    formatCurrencyCompact: (n: number) => `$${n.toFixed(0)}`,
    formatCurrencyLabel: (n: number) => `$${n}`,
  }),
}));

vi.mock('@/lib/utils', async (importActual) => ({
  ...(await importActual<typeof import('@/lib/utils')>()),
  parseLocalDate: (d: string) => new Date(d + 'T00:00:00'),
  cn: (...args: any[]) => args.filter(Boolean).join(' '),
}));

describe('NetWorthChart', () => {
  beforeEach(() => {
    mockPush.mockClear();
    window.localStorage.clear();
    setMobile(false);
  });

  it('renders loading state with title and pulse skeleton', () => {
    render(<NetWorthChart data={[]} isLoading={true} />);
    expect(screen.getByText('Net Worth')).toBeInTheDocument();
    expect(document.querySelector('.animate-pulse')).toBeInTheDocument();
    expect(screen.queryByTestId('bar-chart')).not.toBeInTheDocument();
  });

  it('renders empty state when no data', () => {
    render(<NetWorthChart data={[]} isLoading={false} />);
    expect(screen.getByText('No net worth data available yet.')).toBeInTheDocument();
    expect(screen.queryByTestId('bar-chart')).not.toBeInTheDocument();
  });

  it('renders chart with data and shows current net worth', () => {
    const data = [
      { month: '2024-01-01', netWorth: 10000 },
      { month: '2024-06-01', netWorth: 15000 },
    ] as any[];

    render(<NetWorthChart data={data} isLoading={false} />);
    expect(screen.getByTestId('bar-chart')).toBeInTheDocument();
    expect(screen.getByText('Past 12 months')).toBeInTheDocument();
    expect(screen.getByText('View full report')).toBeInTheDocument();
    expect(screen.getByText('$15000')).toBeInTheDocument();
  });

  it('toggles to the 100% stacked composition chart and persists the choice', () => {
    const data = [
      { month: '2024-01-01', assets: 50000, liabilities: 10000, netWorth: 40000 },
      { month: '2024-06-01', assets: 55000, liabilities: 9000, netWorth: 46000 },
    ] as any[];

    render(<NetWorthChart data={data} isLoading={false} />);
    fireEvent.click(screen.getByTitle('100% Stacked Bar'));
    // The stacked view renders two series (assets + liabilities).
    expect(screen.getAllByTestId('bar')).toHaveLength(2);
    expect(window.localStorage.getItem('dashboard.net-worth.chartType')).toBe('"stacked"');
  });

  it('restores the stacked composition view from localStorage', () => {
    window.localStorage.setItem('dashboard.net-worth.chartType', '"stacked"');
    const data = [
      { month: '2024-01-01', assets: 50000, liabilities: 10000, netWorth: 40000 },
      { month: '2024-06-01', assets: 55000, liabilities: 9000, netWorth: 46000 },
    ] as any[];

    render(<NetWorthChart data={data} isLoading={false} />);
    expect(screen.getAllByTestId('bar')).toHaveLength(2);
  });

  it('renders abbreviated value labels above the bars', () => {
    const data = [
      { month: '2024-01-01', netWorth: 10000 },
      { month: '2024-06-01', netWorth: 15000 },
    ] as any[];

    render(<NetWorthChart data={data} isLoading={false} />);
    // The Bar renders a LabelList child that formats each value via
    // formatCurrencyLabel (mocked here as `$<value>`).
    expect(screen.getByTestId('label-list')).toBeInTheDocument();
    expect(screen.getByText('$1000')).toBeInTheDocument();
  });

  it('shows positive change with plus sign and green styling', () => {
    const data = [
      { month: '2024-01-01', netWorth: 10000 },
      { month: '2024-06-01', netWorth: 15000 },
    ] as any[];

    render(<NetWorthChart data={data} isLoading={false} />);
    // Change is +5000, 50%
    const changeEl = screen.getByText(/\+\$5000/);
    expect(changeEl).toBeInTheDocument();
    expect(changeEl.className).toContain('text-green');
  });

  it('shows negative change with red styling', () => {
    const data = [
      { month: '2024-01-01', netWorth: 15000 },
      { month: '2024-06-01', netWorth: 10000 },
    ] as any[];

    render(<NetWorthChart data={data} isLoading={false} />);
    // Change is -5000
    const changeEl = screen.getByText(/\$-5000/);
    expect(changeEl).toBeInTheDocument();
    expect(changeEl.className).toContain('text-red');
  });

  it('navigates to net worth report on title click', () => {
    const data = [
      { month: '2024-01-01', netWorth: 10000 },
      { month: '2024-06-01', netWorth: 15000 },
    ] as any[];

    render(<NetWorthChart data={data} isLoading={false} />);
    fireEvent.click(screen.getByText('Net Worth'));
    expect(mockPush).toHaveBeenCalledWith('/reports/net-worth');
  });

  it('navigates to report on View full report click', () => {
    const data = [
      { month: '2024-01-01', netWorth: 10000 },
      { month: '2024-06-01', netWorth: 15000 },
    ] as any[];

    render(<NetWorthChart data={data} isLoading={false} />);
    fireEvent.click(screen.getByText('View full report'));
    expect(mockPush).toHaveBeenCalledWith('/reports/net-worth');
  });

  it('navigates to report on loading state title click', () => {
    render(<NetWorthChart data={[]} isLoading={true} />);
    fireEvent.click(screen.getByText('Net Worth'));
    expect(mockPush).toHaveBeenCalledWith('/reports/net-worth');
  });

  it('navigates to report on empty state title click', () => {
    render(<NetWorthChart data={[]} isLoading={false} />);
    fireEvent.click(screen.getByText('Net Worth'));
    expect(mockPush).toHaveBeenCalledWith('/reports/net-worth');
  });

  it('shows negative net worth with red styling', () => {
    const data = [
      { month: '2024-01-01', netWorth: -5000 },
      { month: '2024-06-01', netWorth: -3000 },
    ] as any[];

    render(<NetWorthChart data={data} isLoading={false} />);
    const currentEl = screen.getByText('$-3000');
    expect(currentEl.className).toContain('text-red');
  });

  it('uses a tight Y-axis domain above 0 on desktop to surface differences', () => {
    setMobile(false);
    const data = [
      { month: '2024-01-01', netWorth: 500000 },
      { month: '2024-06-01', netWorth: 520000 },
    ] as any[];

    render(<NetWorthChart data={data} isLoading={false} />);
    const domain = JSON.parse(
      screen.getByTestId('y-axis').getAttribute('data-domain') as string,
    );
    // Lower bound is a concrete number padded below the minimum (not 0).
    expect(typeof domain[0]).toBe('number');
    expect(domain[0]).toBeGreaterThan(0);
    expect(domain[0]).toBeLessThan(500000);
    expect(domain[1]).toBe('auto');
  });

  it('uses a tight Y-axis domain above 0 on mobile to surface differences', () => {
    setMobile(true);
    const data = [
      { month: '2024-01-01', netWorth: 500000 },
      { month: '2024-06-01', netWorth: 520000 },
    ] as any[];

    render(<NetWorthChart data={data} isLoading={false} />);
    const domain = JSON.parse(
      screen.getByTestId('y-axis').getAttribute('data-domain') as string,
    );
    // Lower bound is a concrete number padded below the minimum (not 0).
    expect(typeof domain[0]).toBe('number');
    expect(domain[0]).toBeGreaterThan(0);
    expect(domain[0]).toBeLessThan(500000);
    expect(domain[1]).toBe('auto');
  });

  it('falls back to the anchored domain when all values are equal', () => {
    const data = [
      { month: '2024-01-01', netWorth: 500000 },
      { month: '2024-06-01', netWorth: 500000 },
    ] as any[];

    render(<NetWorthChart data={data} isLoading={false} />);
    const domain = screen.getByTestId('y-axis').getAttribute('data-domain');
    expect(domain).toBe('[null,"auto"]');
  });

  it('handles single data point correctly', () => {
    const data = [
      { month: '2024-01-01', netWorth: 10000 },
    ] as any[];

    render(<NetWorthChart data={data} isLoading={false} />);
    // Single data point: change = 0, percent = 0
    expect(screen.getByText('$10000')).toBeInTheDocument();
    expect(screen.getByTestId('bar-chart')).toBeInTheDocument();
  });
});
