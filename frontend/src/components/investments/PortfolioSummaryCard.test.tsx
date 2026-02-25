import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@/test/render';
import { PortfolioSummaryCard } from './PortfolioSummaryCard';

vi.mock('@/hooks/useNumberFormat', () => ({
  useNumberFormat: () => ({
    formatCurrency: (n: number) => `$${n.toFixed(2)}`,
  }),
}));

vi.mock('@/hooks/useExchangeRates', () => ({
  useExchangeRates: () => ({
    convertToDefault: (n: number) => n,
    defaultCurrency: 'CAD',
  }),
}));

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
    expect(screen.getByText('Time-Weighted Return')).toBeInTheDocument();
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
    const tooltipIcons = container.querySelectorAll('svg.cursor-help');
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
});
