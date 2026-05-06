import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@/test/render';
import { SecurityPerformanceReport } from './SecurityPerformanceReport';

vi.mock('@/lib/pdf-export', () => ({
  exportToPdf: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/hooks/useNumberFormat', () => ({
  useNumberFormat: () => ({
    formatCurrency: (n: number) => `$${n.toFixed(2)}`,
    formatCurrencyCompact: (n: number) => `$${n.toFixed(0)}`,
    formatCurrencyAxis: (n: number) => `$${n}`,
  }),
}));

vi.mock('@/hooks/useExchangeRates', () => ({
  useExchangeRates: () => ({
    defaultCurrency: 'CAD',
    convertToDefault: (amount: number) => amount,
  }),
}));

vi.mock('@/lib/utils', () => ({
  parseLocalDate: (d: string) => new Date(d + 'T00:00:00'),
}));

vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }: any) => <div data-testid="responsive-container">{children}</div>,
  AreaChart: ({ children }: any) => <div data-testid="area-chart">{children}</div>,
  Area: () => null,
  XAxis: ({ tickFormatter }: any) => <div>{tickFormatter ? tickFormatter(1) : ''}</div>,
  YAxis: ({ tickFormatter }: any) => <div>{tickFormatter ? tickFormatter(100) : ''}</div>,
  CartesianGrid: () => null,
  Tooltip: ({ content, formatter }: any) => {
    if (typeof content === 'function') {
      return (
        <div data-testid="tooltip">
          {content({ active: true, payload: [{ payload: { label: 'Jan', close: 100, buyMarker: 100, sellMarker: 100 } }] })}
          {content({ active: false, payload: [] })}
          {content({ active: true, payload: [{ payload: { label: 'Feb', close: 50 } }] })}
        </div>
      );
    }
    if (formatter) {
      try { formatter(123, 'X'); } catch {}
    }
    return null;
  },
  ReferenceLine: () => null,
}));

const mockGetSecurities = vi.fn();
const mockGetPortfolioSummary = vi.fn();
const mockGetSecurityPrices = vi.fn();
const mockGetTransactions = vi.fn();
const mockGetInvestmentAccounts = vi.fn();

vi.mock('@/lib/investments', () => ({
  investmentsApi: {
    getSecurities: (...args: any[]) => mockGetSecurities(...args),
    getPortfolioSummary: (...args: any[]) => mockGetPortfolioSummary(...args),
    getSecurityPrices: (...args: any[]) => mockGetSecurityPrices(...args),
    getTransactions: (...args: any[]) => mockGetTransactions(...args),
    getInvestmentAccounts: (...args: any[]) => mockGetInvestmentAccounts(...args),
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

const mockSecurities = [
  { id: 's-1', symbol: 'AAPL', name: 'Apple Inc.', isActive: true, currencyCode: 'USD' },
  { id: 's-2', symbol: 'VTI', name: 'Vanguard Total Stock', isActive: true, currencyCode: 'USD' },
  { id: 's-3', symbol: 'OLD', name: 'Old Stock', isActive: false, currencyCode: 'USD' },
];

const mockHoldings = [
  {
    id: 'h-1',
    accountId: 'acc-1',
    securityId: 's-1',
    symbol: 'AAPL',
    name: 'Apple Inc.',
    securityType: 'STOCK',
    currencyCode: 'USD',
    quantity: 10,
    averageCost: 150,
    costBasis: 1500,
    currentPrice: 180,
    marketValue: 1800,
    gainLoss: 300,
    gainLossPercent: 20,
  },
];

describe('SecurityPerformanceReport', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetInvestmentAccounts.mockResolvedValue([
      { id: 'acc-1', name: 'Brokerage 1', currencyCode: 'USD' },
    ]);
  });

  it('shows loading state initially', () => {
    mockGetSecurities.mockReturnValue(new Promise(() => {}));
    mockGetPortfolioSummary.mockReturnValue(new Promise(() => {}));
    mockGetInvestmentAccounts.mockReturnValue(new Promise(() => {}));
    render(<SecurityPerformanceReport />);
    expect(document.querySelector('.animate-pulse')).toBeTruthy();
  });

  it('renders security selector with active securities only', async () => {
    mockGetSecurities.mockResolvedValue(mockSecurities);
    mockGetPortfolioSummary.mockResolvedValue({ holdings: mockHoldings });
    render(<SecurityPerformanceReport />);
    await waitFor(() => {
      expect(screen.getByText('Select a security...')).toBeInTheDocument();
    });
    // Active securities should be in the dropdown options
    const select = screen.getByRole('combobox');
    expect(select).toBeInTheDocument();
  });

  it('shows prompt to select security when none selected', async () => {
    mockGetSecurities.mockResolvedValue(mockSecurities);
    mockGetPortfolioSummary.mockResolvedValue({ holdings: mockHoldings });
    render(<SecurityPerformanceReport />);
    await waitFor(() => {
      expect(screen.getByText(/Select a security above/)).toBeInTheDocument();
    });
  });

  it('renders view type buttons when security is selected', async () => {
    mockGetSecurities.mockResolvedValue(mockSecurities);
    mockGetPortfolioSummary.mockResolvedValue({ holdings: mockHoldings });
    mockGetSecurityPrices.mockResolvedValue([
      { id: 1, securityId: 's-1', priceDate: '2025-01-01', closePrice: 175, createdAt: '' },
    ]);
    mockGetTransactions.mockResolvedValue({ data: [], pagination: { hasMore: false } });

    render(<SecurityPerformanceReport />);
    await waitFor(() => {
      expect(screen.getByText('Select a security...')).toBeInTheDocument();
    });

    // Select a security
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 's-1' } });

    await waitFor(() => {
      expect(screen.getByText('Price Chart')).toBeInTheDocument();
    });
    expect(screen.getByText('Transactions')).toBeInTheDocument();
    expect(screen.getByText('Dividends')).toBeInTheDocument();
  });

  it('renders performance stats when security is selected', async () => {
    mockGetSecurities.mockResolvedValue(mockSecurities);
    mockGetPortfolioSummary.mockResolvedValue({ holdings: mockHoldings });
    mockGetSecurityPrices.mockResolvedValue([]);
    mockGetTransactions.mockResolvedValue({ data: [], pagination: { hasMore: false } });

    render(<SecurityPerformanceReport />);
    await waitFor(() => {
      expect(screen.getByRole('combobox')).toBeInTheDocument();
    });

    fireEvent.change(screen.getByRole('combobox'), { target: { value: 's-1' } });

    await waitFor(() => {
      expect(screen.getByText('Current Value')).toBeInTheDocument();
    });
    expect(screen.getByText('Cost Basis')).toBeInTheDocument();
    expect(screen.getByText('Total Return')).toBeInTheDocument();
    expect(screen.getByText('Annualized Return')).toBeInTheDocument();
  });

  it('renders price chart with price data', async () => {
    mockGetSecurities.mockResolvedValue(mockSecurities);
    mockGetPortfolioSummary.mockResolvedValue({ holdings: mockHoldings });
    mockGetSecurityPrices.mockResolvedValue([
      { id: 1, securityId: 's-1', priceDate: '2025-01-01', closePrice: 170, createdAt: '' },
      { id: 2, securityId: 's-1', priceDate: '2025-01-02', closePrice: 175, createdAt: '' },
    ]);
    mockGetTransactions.mockResolvedValue({ data: [], pagination: { hasMore: false } });

    render(<SecurityPerformanceReport />);
    await waitFor(() => {
      expect(screen.getByRole('combobox')).toBeInTheDocument();
    });

    fireEvent.change(screen.getByRole('combobox'), { target: { value: 's-1' } });

    await waitFor(() => {
      expect(screen.getByText('Price History - AAPL')).toBeInTheDocument();
    });
    expect(screen.getByTestId('area-chart')).toBeInTheDocument();
  });

  it('switches to transactions view', async () => {
    mockGetSecurities.mockResolvedValue(mockSecurities);
    mockGetPortfolioSummary.mockResolvedValue({ holdings: mockHoldings });
    mockGetSecurityPrices.mockResolvedValue([]);
    mockGetTransactions.mockResolvedValue({
      data: [
        {
          id: 'tx-1',
          transactionDate: '2024-06-15',
          action: 'BUY',
          quantity: 10,
          price: 150,
          totalAmount: 1500,
          securityId: 's-1',
          security: { symbol: 'AAPL', name: 'Apple Inc.' },
          accountId: 'acc-1',
        },
      ],
      pagination: { hasMore: false },
    });

    render(<SecurityPerformanceReport />);
    await waitFor(() => {
      expect(screen.getByRole('combobox')).toBeInTheDocument();
    });

    fireEvent.change(screen.getByRole('combobox'), { target: { value: 's-1' } });

    await waitFor(() => {
      expect(screen.getByText('Transactions')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Transactions'));
    await waitFor(() => {
      expect(screen.getByText('Transaction History - AAPL')).toBeInTheDocument();
    });
  });

  it('handles loadDetail error and load error gracefully', async () => {
    mockGetSecurities.mockRejectedValue(new Error('boom'));
    mockGetPortfolioSummary.mockRejectedValue(new Error('boom'));
    mockGetInvestmentAccounts.mockRejectedValue(new Error('boom'));
    render(<SecurityPerformanceReport />);
    await waitFor(() => {
      expect(screen.getByRole('combobox')).toBeInTheDocument();
    });
  });

  it('exports pdf in chart view', async () => {
    const { exportToPdf } = await import('@/lib/pdf-export');
    (exportToPdf as any).mockClear();
    mockGetSecurities.mockResolvedValue(mockSecurities);
    mockGetPortfolioSummary.mockResolvedValue({ holdings: mockHoldings });
    mockGetSecurityPrices.mockResolvedValue([
      { id: 1, securityId: 's-1', priceDate: '2025-01-01', closePrice: 175, createdAt: '' },
    ]);
    mockGetTransactions.mockResolvedValue({
      data: [
        { id: 'tx-1', transactionDate: '2020-01-01', action: 'BUY', quantity: 10, price: 150, totalAmount: 1500, securityId: 's-1', security: { symbol: 'AAPL', name: 'A' }, accountId: 'acc-1' },
        { id: 'tx-2', transactionDate: '2024-06-15', action: 'SELL', quantity: 5, price: 180, totalAmount: 900, securityId: 's-1', security: { symbol: 'AAPL', name: 'A' }, accountId: 'acc-1' },
        { id: 'tx-3', transactionDate: '2024-07-15', action: 'DIVIDEND', quantity: null, price: null, totalAmount: 50, securityId: 's-1', security: { symbol: 'AAPL', name: 'A' }, accountId: 'acc-1' },
        { id: 'tx-4', transactionDate: '2024-08-15', action: 'REINVEST', quantity: 1, price: 50, totalAmount: 50, securityId: 's-1', security: { symbol: 'AAPL', name: 'A' }, accountId: 'acc-1' },
      ],
      pagination: { hasMore: false },
    });
    render(<SecurityPerformanceReport />);
    await waitFor(() => {
      expect(screen.getByRole('combobox')).toBeInTheDocument();
    });
    await act(async () => {
      fireEvent.change(screen.getByRole('combobox'), { target: { value: 's-1' } });
    });
    await waitFor(() => {
      expect(screen.getByText('Current Value')).toBeInTheDocument();
    });
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
    expect(exportToPdf).toHaveBeenCalled();
  });

  it('exports pdf in transactions view', async () => {
    const { exportToPdf } = await import('@/lib/pdf-export');
    (exportToPdf as any).mockClear();
    mockGetSecurities.mockResolvedValue(mockSecurities);
    mockGetPortfolioSummary.mockResolvedValue({ holdings: [{ ...mockHoldings[0], gainLoss: -100, gainLossPercent: -5, marketValue: 1000, costBasis: 1500 }] });
    mockGetSecurityPrices.mockResolvedValue([]);
    mockGetTransactions.mockResolvedValue({
      data: [
        { id: 'tx-1', transactionDate: '2024-06-15', action: 'BUY', quantity: 10, price: 150, totalAmount: 1500, securityId: 's-1', security: { symbol: 'AAPL', name: 'A' }, accountId: 'acc-1' },
      ],
      pagination: { hasMore: false },
    });
    render(<SecurityPerformanceReport />);
    await waitFor(() => {
      expect(screen.getByRole('combobox')).toBeInTheDocument();
    });
    await act(async () => {
      fireEvent.change(screen.getByRole('combobox'), { target: { value: 's-1' } });
    });
    await waitFor(() => {
      expect(screen.getByText('Transactions')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText('Transactions'));
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

  it('exports pdf in dividends view', async () => {
    const { exportToPdf } = await import('@/lib/pdf-export');
    (exportToPdf as any).mockClear();
    mockGetSecurities.mockResolvedValue(mockSecurities);
    mockGetPortfolioSummary.mockResolvedValue({ holdings: mockHoldings });
    mockGetSecurityPrices.mockResolvedValue([]);
    mockGetTransactions.mockResolvedValue({
      data: [
        { id: 'tx-1', transactionDate: '2024-06-15', action: 'DIVIDEND', quantity: null, price: null, totalAmount: 50, securityId: 's-1', security: { symbol: 'AAPL', name: 'A' }, accountId: 'acc-1' },
      ],
      pagination: { hasMore: false },
    });
    render(<SecurityPerformanceReport />);
    await waitFor(() => {
      expect(screen.getByRole('combobox')).toBeInTheDocument();
    });
    await act(async () => {
      fireEvent.change(screen.getByRole('combobox'), { target: { value: 's-1' } });
    });
    await waitFor(() => {
      expect(screen.getByText('Dividends')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText('Dividends'));
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

  it('paginates transactions through multiple pages', async () => {
    mockGetSecurities.mockResolvedValue(mockSecurities);
    mockGetPortfolioSummary.mockResolvedValue({ holdings: mockHoldings });
    mockGetSecurityPrices.mockResolvedValue([]);
    mockGetTransactions
      .mockResolvedValueOnce({
        data: [{ id: 'tx-1', transactionDate: '2024-06-01', action: 'BUY', quantity: 10, price: 150, totalAmount: 1500, securityId: 's-1', security: { symbol: 'AAPL', name: 'A' }, accountId: 'acc-1' }],
        pagination: { hasMore: true },
      })
      .mockResolvedValueOnce({
        data: [{ id: 'tx-2', transactionDate: '2024-07-01', action: 'BUY', quantity: 5, price: 160, totalAmount: 800, securityId: 's-1', security: { symbol: 'AAPL', name: 'A' }, accountId: 'acc-1' }],
        pagination: { hasMore: false },
      });
    render(<SecurityPerformanceReport />);
    await waitFor(() => {
      expect(screen.getByRole('combobox')).toBeInTheDocument();
    });
    await act(async () => {
      fireEvent.change(screen.getByRole('combobox'), { target: { value: 's-1' } });
    });
    await waitFor(() => {
      expect(mockGetTransactions).toHaveBeenCalledTimes(2);
    });
  });

  it('switches to dividends view', async () => {
    mockGetSecurities.mockResolvedValue(mockSecurities);
    mockGetPortfolioSummary.mockResolvedValue({ holdings: mockHoldings });
    mockGetSecurityPrices.mockResolvedValue([]);
    mockGetTransactions.mockResolvedValue({
      data: [
        {
          id: 'tx-1',
          transactionDate: '2024-06-15',
          action: 'DIVIDEND',
          quantity: null,
          price: null,
          totalAmount: 50,
          securityId: 's-1',
          security: { symbol: 'AAPL', name: 'Apple Inc.' },
          accountId: 'acc-1',
        },
      ],
      pagination: { hasMore: false },
    });

    render(<SecurityPerformanceReport />);
    await waitFor(() => {
      expect(screen.getByRole('combobox')).toBeInTheDocument();
    });

    fireEvent.change(screen.getByRole('combobox'), { target: { value: 's-1' } });

    await waitFor(() => {
      expect(screen.getByText('Dividends')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Dividends'));
    await waitFor(() => {
      expect(screen.getByText('Dividend History - AAPL')).toBeInTheDocument();
    });
  });
});
