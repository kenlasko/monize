import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@/test/render';
import { PortfolioSummaryCard } from './PortfolioSummaryCard';

const mockConvertToDefault = vi.fn((n: number) => n);
let mockDefaultCurrency = 'CAD';

vi.mock('@/hooks/useNumberFormat', () => ({
  useNumberFormat: () => ({
    formatCurrency: (n: number, _currency?: string) => `$${n.toFixed(2)}`,
    formatSignedPercent: (n: number, decimals = 2) =>
      `${n >= 0 ? '+' : ''}${n.toFixed(decimals)}%`,
  }),
}));

vi.mock('@/hooks/useExchangeRates', () => ({
  useExchangeRates: () => ({
    convertToDefault: mockConvertToDefault,
    defaultCurrency: mockDefaultCurrency,
  }),
}));

beforeEach(() => {
  mockConvertToDefault.mockImplementation((n: number) => n);
  mockDefaultCurrency = 'CAD';
});

const makeSummary = (overrides?: Record<string, any>) => ({
  totalPortfolioValue: 50000,
  totalHoldingsValue: 45000,
  totalCashValue: 5000,
  totalGainLoss: 5000,
  totalGainLossPercent: 12.5,
  totalCostBasis: 40000,
  totalNetInvested: 35000,
  timeWeightedReturn: 15.32,
  cagr: 10.5,
  holdingsByAccount: [
    {
      accountId: 'a1',
      currencyCode: 'CAD',
      totalMarketValue: 45000,
      totalCostBasis: 40000,
      cashBalance: 5000,
      totalGainLoss: 5000,
      totalGainLossPercent: 12.5,
      netInvested: 35000,
      holdings: [],
    },
  ],
  ...overrides,
} as any);

describe('PortfolioSummaryCard', () => {
  it('renders loading state', () => {
    render(<PortfolioSummaryCard summary={null} isLoading={true} />);
    expect(screen.getByText('Portfolio Summary')).toBeInTheDocument();
    expect(document.querySelector('.animate-pulse')).toBeInTheDocument();
  });

  it('renders empty state when no summary', () => {
    render(<PortfolioSummaryCard summary={null} isLoading={false} />);
    expect(screen.getByText('No investment data available.')).toBeInTheDocument();
  });

  it('renders portfolio summary with data', () => {
    render(<PortfolioSummaryCard summary={makeSummary()} isLoading={false} />);
    expect(screen.getByText('Total Portfolio Value')).toBeInTheDocument();
    expect(screen.getByText('Holdings Value')).toBeInTheDocument();
    expect(screen.getByText('Cash Balance')).toBeInTheDocument();
    expect(screen.getByText('Total Gain')).toBeInTheDocument();
    expect(screen.getByText('Net Invested')).toBeInTheDocument();
    expect(screen.getByText('Cost Basis')).toBeInTheDocument();
    expect(screen.getByText('Gain/Loss')).toBeInTheDocument();
  });

  it('renders return metrics section', () => {
    render(<PortfolioSummaryCard summary={makeSummary()} isLoading={false} />);
    expect(screen.getByText('Simple Return')).toBeInTheDocument();
    expect(screen.getByText(/TWR/)).toBeInTheDocument();
    expect(screen.getByText('CAGR')).toBeInTheDocument();
  });

  it('shows simple return percentage', () => {
    render(<PortfolioSummaryCard summary={makeSummary()} isLoading={false} />);
    expect(screen.getByText('+12.50%')).toBeInTheDocument();
  });

  it('renders TWR when available', () => {
    render(<PortfolioSummaryCard summary={makeSummary({ timeWeightedReturn: 15.32 })} isLoading={false} />);
    expect(screen.getByText('+15.32%')).toBeInTheDocument();
  });

  it('renders N/A when TWR is null', () => {
    render(<PortfolioSummaryCard summary={makeSummary({ timeWeightedReturn: null, cagr: null })} isLoading={false} />);
    const naElements = screen.getAllByText('N/A');
    expect(naElements.length).toBeGreaterThanOrEqual(1);
  });

  it('renders info tooltip icons for all metrics', () => {
    const { container } = render(<PortfolioSummaryCard summary={makeSummary()} isLoading={false} />);
    // Each InfoTooltip renders its question-mark icon inside a span.cursor-help.
    const tooltipIcons = container.querySelectorAll('span.cursor-help svg');
    // Holdings Value, Cash Balance, Total Gain, Net Invested, Cost Basis, Gain/Loss, Simple Return, TWR, CAGR
    expect(tooltipIcons.length).toBe(9);
  });

  it('shows negative TWR with correct formatting', () => {
    render(<PortfolioSummaryCard summary={makeSummary({ timeWeightedReturn: -8.5 })} isLoading={false} />);
    expect(screen.getByText('-8.50%')).toBeInTheDocument();
  });

  it('renders section headers for values and returns', () => {
    render(<PortfolioSummaryCard summary={makeSummary()} isLoading={false} />);
    expect(screen.getByText('Values')).toBeInTheDocument();
    expect(screen.getByText('Returns')).toBeInTheDocument();
  });

  it('renders net invested value', () => {
    render(<PortfolioSummaryCard summary={makeSummary()} isLoading={false} />);
    expect(screen.getByText('$35000.00')).toBeInTheDocument();
  });

  it('renders total gain as portfolio value minus net invested', () => {
    // totalPortfolioValue=50000, totalNetInvested=35000, so Total Gain=15000
    render(<PortfolioSummaryCard summary={makeSummary()} isLoading={false} />);
    expect(screen.getByText('$15000.00')).toBeInTheDocument();
  });

  it('renders CAGR when available', () => {
    render(<PortfolioSummaryCard summary={makeSummary({ cagr: 10.5 })} isLoading={false} />);
    expect(screen.getByText('+10.50%')).toBeInTheDocument();
  });

  it('renders N/A when CAGR is null', () => {
    render(<PortfolioSummaryCard summary={makeSummary({ cagr: null })} isLoading={false} />);
    const naElements = screen.getAllByText('N/A');
    expect(naElements.some(el => el.closest('div')?.previousElementSibling?.textContent?.includes('CAGR'))).toBe(true);
  });

  it('shows negative CAGR with correct formatting', () => {
    render(<PortfolioSummaryCard summary={makeSummary({ cagr: -3.25 })} isLoading={false} />);
    expect(screen.getByText('-3.25%')).toBeInTheDocument();
  });

  it('applies green color to positive total gain', () => {
    // Total Gain = 50000 - 35000 = 15000 (positive)
    render(<PortfolioSummaryCard summary={makeSummary()} isLoading={false} />);
    const totalGainValue = screen.getByText('$15000.00');
    expect(totalGainValue.className).toContain('text-green-600');
  });

  it('applies red color to negative total gain', () => {
    // totalPortfolioValue=30000, totalNetInvested=35000, so Total Gain=-5000
    const summary = makeSummary({
      totalPortfolioValue: 30000,
      totalNetInvested: 35000,
      holdingsByAccount: [
        {
          accountId: 'a1',
          currencyCode: 'CAD',
          totalMarketValue: 25000,
          totalCostBasis: 40000,
          cashBalance: 5000,
          totalGainLoss: -15000,
          totalGainLossPercent: -37.5,
          netInvested: 35000,
          holdings: [],
        },
      ],
    });
    render(<PortfolioSummaryCard summary={summary} isLoading={false} />);
    const negativeGain = screen.getByText('$-5000.00');
    expect(negativeGain.className).toContain('text-red-600');
  });

  it('renders titleSuffix in loading state', () => {
    render(<PortfolioSummaryCard summary={null} isLoading={true} titleSuffix="My Account" />);
    expect(screen.getByText('Portfolio Summary (My Account)')).toBeInTheDocument();
  });

  it('renders titleSuffix in empty state', () => {
    render(<PortfolioSummaryCard summary={null} isLoading={false} titleSuffix="My Account" />);
    expect(screen.getByText('Portfolio Summary (My Account)')).toBeInTheDocument();
  });

  it('renders titleSuffix in populated state', () => {
    render(<PortfolioSummaryCard summary={makeSummary()} isLoading={false} titleSuffix="My Account" />);
    expect(screen.getByText('Portfolio Summary (My Account)')).toBeInTheDocument();
  });

  it('renders foreign currency values when singleAccountCurrency differs from default', () => {
    mockDefaultCurrency = 'CAD';
    const summary = makeSummary({
      holdingsByAccount: [
        {
          accountId: 'a1',
          currencyCode: 'USD',
          totalMarketValue: 45000,
          totalCostBasis: 40000,
          cashBalance: 5000,
          totalGainLoss: 5000,
          totalGainLossPercent: 12.5,
          netInvested: 35000,
          holdings: [],
        },
      ],
    });
    render(
      <PortfolioSummaryCard
        summary={summary}
        isLoading={false}
        singleAccountCurrency="USD"
      />,
    );
    // Foreign path: values are raw and appended with currency code (multiple elements expected)
    expect(screen.getAllByText(/USD/).length).toBeGreaterThan(0);
    // The approx default-currency line should appear
    expect(screen.getByText(/≈/)).toBeInTheDocument();
  });

  it('does not show foreign currency line when singleAccountCurrency matches default', () => {
    mockDefaultCurrency = 'CAD';
    render(
      <PortfolioSummaryCard
        summary={makeSummary()}
        isLoading={false}
        singleAccountCurrency="CAD"
      />,
    );
    // singleAccountCurrency === defaultCurrency, so no approx line
    expect(screen.queryByText(/≈/)).not.toBeInTheDocument();
  });

  it('renders zero gainLossPercent when costBasis is zero in default currency path', () => {
    const summary = makeSummary({
      totalGainLossPercent: 0,
      holdingsByAccount: [
        {
          accountId: 'a1',
          currencyCode: 'CAD',
          totalMarketValue: 0,
          totalCostBasis: 0,
          cashBalance: 0,
          totalGainLoss: 0,
          totalGainLossPercent: 0,
          netInvested: 0,
          holdings: [],
        },
      ],
    });
    render(<PortfolioSummaryCard summary={summary} isLoading={false} />);
    // Simple Return shows +0.00% when costBasis is 0
    expect(screen.getByText('+0.00%')).toBeInTheDocument();
  });

  it('renders zero gainLossPercent when costBasis is zero in foreign currency path', () => {
    mockDefaultCurrency = 'CAD';
    const summary = makeSummary({
      totalGainLossPercent: 0,
      holdingsByAccount: [
        {
          accountId: 'a1',
          currencyCode: 'USD',
          totalMarketValue: 0,
          totalCostBasis: 0,
          cashBalance: 0,
          totalGainLoss: 0,
          totalGainLossPercent: 0,
          netInvested: 0,
          holdings: [],
        },
      ],
    });
    render(
      <PortfolioSummaryCard
        summary={summary}
        isLoading={false}
        singleAccountCurrency="USD"
      />,
    );
    expect(screen.getByText('+0.00%')).toBeInTheDocument();
  });

  it('applies gray color class when returnColorClass receives null', () => {
    // TWR null triggers returnColorClass(null) -> text-gray-400
    render(
      <PortfolioSummaryCard
        summary={makeSummary({ timeWeightedReturn: null })}
        isLoading={false}
      />,
    );
    const twrN_a = screen.getAllByText('N/A')[0];
    // The sibling N/A span should be present; the parent div uses gray class
    const twrContainer = twrN_a.closest('div[class*="text-"]');
    expect(twrContainer?.className).toMatch(/text-gray-400/);
  });

  it('multiple accounts aggregate values correctly in foreign currency path', () => {
    mockDefaultCurrency = 'CAD';
    const summary = makeSummary({
      holdingsByAccount: [
        {
          accountId: 'a1',
          currencyCode: 'USD',
          totalMarketValue: 10000,
          totalCostBasis: 8000,
          cashBalance: 2000,
          totalGainLoss: 2000,
          totalGainLossPercent: 25,
          netInvested: 9000,
          holdings: [],
        },
        {
          accountId: 'a2',
          currencyCode: 'USD',
          totalMarketValue: 5000,
          totalCostBasis: 4000,
          cashBalance: 1000,
          totalGainLoss: 1000,
          totalGainLossPercent: 25,
          netInvested: 4500,
          holdings: [],
        },
      ],
    });
    render(
      <PortfolioSummaryCard
        summary={summary}
        isLoading={false}
        singleAccountCurrency="USD"
      />,
    );
    // Total portfolio = 10000+5000 (holdings) + 2000+1000 (cash) = 18000
    expect(screen.getByText('$18000.00 USD')).toBeInTheDocument();
  });
});
