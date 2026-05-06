import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@/test/render';
import { InvestmentPerformanceReport } from './InvestmentPerformanceReport';

vi.mock('@/hooks/useNumberFormat', () => ({
  useNumberFormat: () => ({
    formatCurrencyCompact: (n: number) => `$${n.toFixed(0)}`,
    formatCurrency: (n: number, _currency?: string) => `$${n.toFixed(2)}`,
    defaultCurrency: 'CAD',
  }),
}));

vi.mock('@/hooks/useExchangeRates', () => ({
  useExchangeRates: () => ({
    convertToDefault: (amount: number, _currency: string) => amount,
    defaultCurrency: 'CAD',
  }),
}));

vi.mock('@/lib/chart-colours', () => ({
  CHART_COLOURS: ['#3b82f6', '#ef4444', '#22c55e'],
}));

vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }: any) => <div data-testid="responsive-container">{children}</div>,
  PieChart: ({ children }: any) => <div data-testid="pie-chart">{children}</div>,
  Pie: ({ children }: any) => <div data-testid="pie">{children}</div>,
  Cell: () => null,
  Tooltip: ({ content }: any) => {
    if (content && content.type) {
      const C = content.type;
      return (
        <div data-testid="tooltip">
          <C active={true} payload={[{ name: 'V', value: 100, color: '#000', payload: { name: 'Equities', symbol: 'VFV', marketValue: 100, gainLoss: 10, gainLossPercent: 5, currencyCode: 'CAD', value: 100, percentage: 50 } }]} />
          <C active={false} payload={[]} />
          <C active={true} payload={[{ name: 'X', value: 50, color: '#000', payload: { name: 'Bonds', symbol: 'XIC', marketValue: -50, gainLoss: -10, gainLossPercent: -5, currencyCode: 'USD', value: 50, percentage: 25 } }]} />
        </div>
      );
    }
    return null;
  },
  Legend: () => null,
}));

const mockGetPortfolioSummary = vi.fn();
const mockGetInvestmentAccounts = vi.fn();

vi.mock('@/lib/investments', () => ({
  investmentsApi: {
    getPortfolioSummary: (...args: any[]) => mockGetPortfolioSummary(...args),
    getInvestmentAccounts: (...args: any[]) => mockGetInvestmentAccounts(...args),
  },
}));

vi.mock('@/lib/pdf-export', () => ({
  exportToPdf: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  }),
}));

const fullPortfolio = {
  holdings: [
    {
      id: 'h-1',
      securityId: 'sec-vfv',
      accountId: 'acc-1',
      symbol: 'VFV',
      name: 'Vanguard S&P 500',
      quantity: 100,
      averageCost: 90,
      currentPrice: 100,
      marketValue: 10000,
      costBasis: 9000,
      costBasisAccountCurrency: 9000,
      gainLoss: 1000,
      gainLossPercent: 11.11,
      currencyCode: 'CAD',
    },
    {
      id: 'h-2',
      securityId: 'sec-vfv',
      accountId: 'acc-2',
      symbol: 'VFV',
      name: 'Vanguard S&P 500',
      quantity: 50,
      averageCost: 95,
      currentPrice: 100,
      marketValue: 5000,
      costBasis: 4750,
      costBasisAccountCurrency: 4750,
      gainLoss: 250,
      gainLossPercent: 5.26,
      currencyCode: 'CAD',
    },
    {
      id: 'h-3',
      securityId: 'sec-xic',
      accountId: 'acc-1',
      symbol: 'XIC',
      name: 'iShares S&P/TSX',
      quantity: 0,
      averageCost: null,
      currentPrice: null,
      marketValue: null,
      costBasis: 0,
      costBasisAccountCurrency: 0,
      gainLoss: null,
      gainLossPercent: null,
      currencyCode: 'CAD',
    },
    {
      id: 'h-4',
      securityId: 'sec-aapl',
      accountId: 'acc-3',
      symbol: 'AAPL',
      name: 'Apple Inc',
      quantity: 10,
      averageCost: 150,
      currentPrice: 140,
      marketValue: 1400,
      costBasis: 1500,
      costBasisAccountCurrency: 1500,
      gainLoss: -100,
      gainLossPercent: -6.67,
      currencyCode: 'USD',
    },
  ],
  holdingsByAccount: [
    { accountId: 'acc-1', totalMarketValue: 10000, cashBalance: 500, totalCostBasis: 9000 },
    { accountId: 'acc-2', totalMarketValue: 5000, cashBalance: 0, totalCostBasis: 4750 },
  ],
  allocation: [
    { name: 'Equities', value: 15000, percentage: 80, color: '#3b82f6' },
    { name: 'Bonds', value: 1400, percentage: 20, symbol: 'XBND' },
  ],
  totalPortfolioValue: 16400,
  totalCostBasis: 15250,
  totalGainLoss: 1150,
  totalGainLossPercent: 7.54,
};

describe('InvestmentPerformanceReport', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows loading state initially', () => {
    mockGetPortfolioSummary.mockReturnValue(new Promise(() => {}));
    mockGetInvestmentAccounts.mockReturnValue(new Promise(() => {}));
    render(<InvestmentPerformanceReport />);
    expect(document.querySelector('.animate-pulse')).toBeTruthy();
  });

  it('renders empty state when no holdings', async () => {
    mockGetPortfolioSummary.mockResolvedValue({
      holdings: [],
      holdingsByAccount: [],
      allocation: [],
      totalPortfolioValue: 0,
      totalCostBasis: 0,
      totalGainLoss: 0,
      totalGainLossPercent: 0,
    });
    mockGetInvestmentAccounts.mockResolvedValue([]);
    render(<InvestmentPerformanceReport />);
    await waitFor(() => {
      expect(screen.getByText(/No investment holdings found/)).toBeInTheDocument();
    });
  });

  it('handles error in loadData gracefully', async () => {
    mockGetPortfolioSummary.mockRejectedValue(new Error('boom'));
    mockGetInvestmentAccounts.mockRejectedValue(new Error('boom'));
    render(<InvestmentPerformanceReport />);
    await waitFor(() => {
      expect(screen.getByText(/No investment holdings found/)).toBeInTheDocument();
    });
  });

  it('renders portfolio summary, holdings, allocation toggle, expand and export', async () => {
    mockGetPortfolioSummary.mockResolvedValue(fullPortfolio);
    mockGetInvestmentAccounts.mockResolvedValue([
      { id: 'acc-1', name: 'TFSA - Brokerage', currencyCode: 'CAD', accountSubType: 'INVESTMENT_BROKERAGE' },
      { id: 'acc-2', name: 'TFSA - Cash', currencyCode: 'CAD', accountSubType: 'INVESTMENT_CASH' },
      { id: 'acc-3', name: 'RRSP', currencyCode: 'USD', accountSubType: 'INVESTMENT_CASH' },
    ]);
    render(<InvestmentPerformanceReport />);
    await waitFor(() => {
      expect(screen.getByText('Total Value')).toBeInTheDocument();
    });
    // expand multi-account VFV
    const expandableRow = screen.getAllByText('VFV')[0];
    await act(async () => {
      fireEvent.click(expandableRow);
    });
    // collapse it
    await act(async () => {
      fireEvent.click(expandableRow);
    });
    // switch to allocation view
    await act(async () => {
      fireEvent.click(screen.getByText('Allocation'));
    });
    expect(screen.getByText('Asset Allocation')).toBeInTheDocument();
    // back to performance
    await act(async () => {
      fireEvent.click(screen.getByText('Holdings'));
    });
    // change account filter
    const select = document.querySelector('select') as HTMLSelectElement;
    await act(async () => {
      fireEvent.change(select, { target: { value: 'acc-1' } });
    });
    // also test foreign currency summary by switching to USD-only account
    await act(async () => {
      fireEvent.change(select, { target: { value: 'acc-3' } });
    });
    // export pdf
    const exportBtn = screen.getByRole('button', { name: /export/i });
    await act(async () => {
      fireEvent.click(exportBtn);
    });
    const pdfBtn = screen.queryByText(/PDF/i);
    if (pdfBtn) {
      await act(async () => {
        fireEvent.click(pdfBtn);
      });
    }
  });

  it('handles loss case (negative totalGainLoss)', async () => {
    mockGetPortfolioSummary.mockResolvedValue({
      ...fullPortfolio,
      totalGainLoss: -500,
      totalGainLossPercent: -3.5,
    });
    mockGetInvestmentAccounts.mockResolvedValue([]);
    render(<InvestmentPerformanceReport />);
    await waitFor(() => {
      expect(screen.getByText('Total Value')).toBeInTheDocument();
    });
  });

  it('handles unknown account in expansion mapping', async () => {
    mockGetPortfolioSummary.mockResolvedValue(fullPortfolio);
    mockGetInvestmentAccounts.mockResolvedValue([]);
    render(<InvestmentPerformanceReport />);
    await waitFor(() => {
      expect(screen.getByText('Total Value')).toBeInTheDocument();
    });
    // Find VFV row and click it
    const vfvCells = screen.getAllByText('VFV').filter((el) => el.closest('tr'));
    const row = vfvCells[0].closest('tr');
    await act(async () => {
      fireEvent.click(row!);
    });
    expect(screen.getAllByText(/Unknown account/i).length).toBeGreaterThan(0);
  });
});
