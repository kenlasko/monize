import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@/test/render';
import { CustomReportViewer } from './CustomReportViewer';

vi.mock('@/hooks/useNumberFormat', () => ({
  useNumberFormat: () => ({
    formatCurrency: (n: number) => `$${n.toFixed(2)}`,
    formatCurrencyCompact: (n: number) => `$${n.toFixed(0)}`,
    defaultCurrency: 'CAD',
  }),
}));

vi.mock('@/hooks/useDateFormat', () => ({
  useDateFormat: () => ({
    formatDate: (d: string) => d,
  }),
}));

vi.mock('@/components/ui/Button', () => ({
  Button: ({ children, ...props }: any) => <button {...props}>{children}</button>,
}));

vi.mock('@/components/ui/Select', () => ({
  Select: ({ label, options, ...props }: any) => (
    <div>
      <label>{label}</label>
      <select {...props}>
        {options?.map((o: any) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
    </div>
  ),
}));

vi.mock('@/components/reports/ReportChart', () => ({
  ReportChart: () => <div data-testid="report-chart" />,
}));

vi.mock('@/components/ui/IconPicker', () => ({
  getIconComponent: () => <span data-testid="icon" />,
}));

const mockGetById = vi.fn();
const mockExecute = vi.fn();

vi.mock('@/lib/custom-reports', () => ({
  customReportsApi: {
    getById: (...args: any[]) => mockGetById(...args),
    execute: (...args: any[]) => mockExecute(...args),
  },
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  }),
}));

describe('CustomReportViewer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows loading state initially', () => {
    mockGetById.mockReturnValue(new Promise(() => {}));
    render(<CustomReportViewer reportId="rpt-1" />);
    expect(document.querySelector('.animate-spin')).toBeTruthy();
  });

  it('renders not found when report fails to load', async () => {
    mockGetById.mockRejectedValue(new Error('Not found'));
    render(<CustomReportViewer reportId="rpt-1" />);
    await waitFor(() => {
      expect(screen.getByText('Report not found')).toBeInTheDocument();
    });
    expect(screen.getByText('Back to Reports')).toBeInTheDocument();
  });

  it('renders report header and results', async () => {
    mockGetById.mockResolvedValue({
      id: 'rpt-1',
      name: 'Monthly Spending',
      description: 'Track monthly spending',
      icon: 'chart-bar',
      backgroundColor: '#3b82f6',
      viewType: 'BAR_CHART',
      timeframeType: 'LAST_3_MONTHS',
      groupBy: 'CATEGORY',
      isFavourite: false,
      config: {
        metric: 'TOTAL_AMOUNT',
        direction: 'EXPENSES_ONLY',
        includeTransfers: false,
      },
      filters: {},
    });
    mockExecute.mockResolvedValue({
      viewType: 'BAR_CHART',
      groupBy: 'CATEGORY',
      data: [
        { label: 'Groceries', value: 500, count: 20, id: 'cat-1' },
      ],
      summary: { total: 500, count: 20 },
      timeframe: {
        label: 'Last 3 months',
        startDate: '2024-10-01',
        endDate: '2025-01-01',
      },
    });
    render(<CustomReportViewer reportId="rpt-1" />);
    await waitFor(() => {
      expect(screen.getByText('Monthly Spending')).toBeInTheDocument();
    });
    expect(screen.getByText('Track monthly spending')).toBeInTheDocument();
    expect(screen.getByText('Edit')).toBeInTheDocument();
  });

  it('renders timeframe selector', async () => {
    mockGetById.mockResolvedValue({
      id: 'rpt-1',
      name: 'Test Report',
      viewType: 'TABLE',
      timeframeType: 'LAST_3_MONTHS',
      groupBy: 'NONE',
      config: {
        metric: 'TOTAL_AMOUNT',
        direction: 'EXPENSES_ONLY',
        includeTransfers: false,
      },
      filters: {},
    });
    mockExecute.mockResolvedValue({
      viewType: 'TABLE',
      groupBy: 'NONE',
      data: [],
      summary: { total: 0, count: 0 },
      timeframe: { label: 'Last 3 months' },
    });
    render(<CustomReportViewer reportId="rpt-1" />);
    await waitFor(() => {
      expect(screen.getByText('Timeframe')).toBeInTheDocument();
    });
  });
});
