import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@/test/render';
import { PortfolioSummaryCard } from './PortfolioSummaryCard';

// Like the real hook, getRate returns null for an unresolved pair -- the card
// must treat that as unknown, never as an implicit 1:1 (review #1133).
const mockGetRate = vi.fn(
  (from: string, to?: string): number | null =>
    from === (to || mockDefaultCurrency) ? 1 : 2,
);
let mockDefaultCurrency = 'CAD';

vi.mock('@/hooks/useNumberFormat', async () => {
  const { numberFormatMockDefaults } = await import('@/test/number-format-mock');
  return {
    useNumberFormat: () => ({
      ...numberFormatMockDefaults(),
      formatCurrency: (n: number, _currency?: string) => `$${n.toFixed(2)}`,
      formatSignedPercent: (n: number, decimals = 2) =>
        `${n >= 0 ? '+' : ''}${n.toFixed(decimals)}%`,
    }),
  };
});
vi.mock('@/hooks/useExchangeRates', () => ({
  useExchangeRates: () => ({
    getRate: mockGetRate,
    defaultCurrency: mockDefaultCurrency,
  }),
}));

beforeEach(() => {
  mockGetRate.mockImplementation((from: string, to?: string) =>
    from === (to || mockDefaultCurrency) ? 1 : 2,
  );
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
  timeWeightedReturnReasons: [],
  timeWeightedReturnSince: '2025-06-14',
  moneyWeightedReturn: 11.7,
  moneyWeightedReturnReasons: [],
  cagr: 10.5,
  // The API always sends these; a fixture without them is a payload the server
  // cannot produce, and with them the completeness branches are actually exercised.
  fxComplete: true,
  missingRatePairs: [],
  pricesComplete: true,
  unpricedSecurityIds: [],
  valuationComplete: true,
  holdings: [],
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
      fxComplete: true,
      missingRatePairs: [],
      pricesComplete: true,
      unpricedSecurityIds: [],
      valuationComplete: true,
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
    expect(screen.getByText('TWR')).toBeInTheDocument();
    expect(screen.getByText('MWR')).toBeInTheDocument();
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

  // A withheld return names its cause through the same marker the chart uses;
  // "N/A" with no cause leaves the reader nothing to do (#1392).
  it('marks a withheld TWR as unknown and names the repair', () => {
    render(
      <PortfolioSummaryCard
        summary={makeSummary({
          timeWeightedReturn: null,
          timeWeightedReturnReasons: ['incompletePrices'],
        })}
        isLoading={false}
      />,
    );
    expect(screen.getByTestId('unknown-amount')).toBeInTheDocument();
    expect(screen.queryByText('N/A')).not.toBeInTheDocument();
  });

  it('renders the money-weighted return beside the time-weighted one', () => {
    render(
      <PortfolioSummaryCard
        summary={makeSummary({ timeWeightedReturn: 15.32, moneyWeightedReturn: 11.7 })}
        isLoading={false}
      />,
    );
    expect(screen.getByText('MWR')).toBeInTheDocument();
    expect(screen.getByText('(Money-Weighted)')).toBeInTheDocument();
    expect(screen.getByText('+15.32%')).toBeInTheDocument();
    expect(screen.getByText('+11.70%')).toBeInTheDocument();
  });

  // Withheld the same way the TWR is: a portfolio younger than a month has no
  // annual rate, and the marker names that rather than printing "N/A" or,
  // worse, the time-weighted figure under this caption.
  it('marks a withheld MWR as unknown while the TWR is still printed', () => {
    render(
      <PortfolioSummaryCard
        summary={makeSummary({
          timeWeightedReturn: 1.4,
          moneyWeightedReturn: null,
          moneyWeightedReturnReasons: ['windowTooShort'],
        })}
        isLoading={false}
      />,
    );
    expect(screen.getByText('+1.40%')).toBeInTheDocument();
    expect(screen.getByTestId('unknown-amount')).toBeInTheDocument();
    expect(screen.queryByText('N/A')).not.toBeInTheDocument();
  });

  /**
   * A marker saying "no price" is a dead end: the reader has to guess which of
   * their funds it is. The server names and dates each gap; the card renders
   * them with the same list the report uses, linked to the price history where
   * the missing close is entered (#1392).
   */
  describe('withheld returns name their gaps', () => {
    const withGaps = (overrides?: Record<string, any>) =>
      makeSummary({
        timeWeightedReturn: null,
        timeWeightedReturnReasons: ['incompletePrices'],
        moneyWeightedReturn: null,
        moneyWeightedReturnReasons: ['incompletePrices'],
        returnDiagnostics: {
          since: '2025-06-14',
          prices: [
            {
              securityId: 'sec-9',
              symbol: 'PPK',
              name: 'PPK Fund',
              start: '2026-03-02',
              end: '2026-05-30',
            },
          ],
          rates: [],
          cash: [],
          truncated: { prices: false, rates: false, cash: false },
        },
        ...overrides,
      });

    it('names the security and its dates, and links to its price history', () => {
      render(<PortfolioSummaryCard summary={withGaps()} isLoading={false} />);

      expect(
        screen.getByText(
          'TWR and MWR are withheld because the history has gaps:',
        ),
      ).toBeInTheDocument();
      const panel = screen.getByTestId('incomplete-data-details');
      expect(panel).toHaveTextContent('PPK');
      expect(panel).not.toHaveTextContent('sec-9');
      expect(screen.getByRole('link', { name: 'PPK' })).toHaveAttribute(
        'href',
        '/securities/sec-9?tab=prices',
      );
    });

    it('tells the reader to price the security, and names no filter that is not there', () => {
      render(<PortfolioSummaryCard summary={withGaps()} isLoading={false} />);

      expect(
        screen.getByText(/Add the missing prices on each security/),
      ).toBeInTheDocument();
      expect(
        screen.queryByText(/with the account filter above/),
      ).not.toBeInTheDocument();
    });

    it('offers the account filter where the screen has one', () => {
      render(
        <PortfolioSummaryCard
          summary={withGaps()}
          isLoading={false}
          hasAccountFilter
        />,
      );

      expect(
        screen.getByText(
          /leave those accounts out of the view with the account filter above/,
        ),
      ).toBeInTheDocument();
    });

    it('names a missing rate and a cash account with no balance', () => {
      render(
        <PortfolioSummaryCard
          summary={withGaps({
            timeWeightedReturnReasons: ['missingRatePairs', 'incompleteCash'],
            moneyWeightedReturnReasons: ['missingRatePairs'],
            returnDiagnostics: {
              since: '2025-06-14',
              prices: [],
              rates: [
                { pair: 'USD->PLN', start: '2026-01-02', end: '2026-01-09' },
              ],
              cash: [
                {
                  accountId: 'acct-1',
                  name: 'IKE account',
                  start: '2026-01-02',
                  end: '2026-01-02',
                },
              ],
              truncated: { prices: false, rates: false, cash: false },
            },
          })}
          isLoading={false}
        />,
      );

      const panel = screen.getByTestId('incomplete-data-details');
      expect(panel).toHaveTextContent('USD->PLN');
      expect(panel).toHaveTextContent('IKE account');
      expect(panel).not.toHaveTextContent('acct-1');
    });

    it('shows nothing extra when the window is merely too short to annualise', () => {
      // Nothing is missing, so there is no repair to offer; the marker beside
      // the figure is the whole answer.
      render(
        <PortfolioSummaryCard
          summary={withGaps({
            timeWeightedReturn: 1.4,
            timeWeightedReturnReasons: [],
            moneyWeightedReturnReasons: ['windowTooShort'],
            returnDiagnostics: {
              since: '2026-09-01',
              prices: [],
              rates: [],
              cash: [],
              truncated: { prices: false, rates: false, cash: false },
            },
          })}
          isLoading={false}
        />,
      );

      expect(screen.queryByTestId('return-diagnostics')).not.toBeInTheDocument();
    });

    it('shows nothing extra when a return is withheld with no ranges at all', () => {
      render(
        <PortfolioSummaryCard
          summary={withGaps({
            returnDiagnostics: {
              since: '2025-06-14',
              prices: [],
              rates: [],
              cash: [],
              truncated: { prices: false, rates: false, cash: false },
            },
          })}
          isLoading={false}
        />,
      );

      expect(screen.queryByTestId('return-diagnostics')).not.toBeInTheDocument();
    });

    it('shows nothing extra for a payload that carries no diagnostics', () => {
      // A rolling deploy's older backend: absent is no information, which must
      // not render as an empty promise of a list.
      render(
        <PortfolioSummaryCard
          summary={withGaps({ returnDiagnostics: undefined })}
          isLoading={false}
        />,
      );

      expect(screen.queryByTestId('return-diagnostics')).not.toBeInTheDocument();
    });
  });

  it('explains what the money-weighted return weights, and what it leaves out', () => {
    render(<PortfolioSummaryCard summary={makeSummary()} isLoading={false} />);
    expect(
      screen.getByText(
        /Money-weighted return \(XIRR\) of your investments since the first transaction/,
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Deposits, withdrawals and uninvested cash are left out/),
    ).toBeInTheDocument();
  });

  it('warns in the Simple Return tooltip that a purchase moves it on its own', () => {
    render(<PortfolioSummaryCard summary={makeSummary()} isLoading={false} />);
    expect(
      screen.getByText(/It ignores when money arrived, so it jumps on every purchase/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/TWR and MWR do not have this jump/),
    ).toBeInTheDocument();
  });

  it('renders N/A for CAGR when it is null, which is not a period figure', () => {
    render(<PortfolioSummaryCard summary={makeSummary({ cagr: null })} isLoading={false} />);
    const naElements = screen.getAllByText('N/A');
    expect(naElements.length).toBeGreaterThanOrEqual(1);
  });

  it('says the return is since the first transaction and excludes cash', () => {
    render(<PortfolioSummaryCard summary={makeSummary()} isLoading={false} />);
    expect(
      screen.getByText(/Time-weighted return of your investments since the first transaction/),
    ).toBeInTheDocument();
  });

  it('renders info tooltip icons for all metrics', () => {
    const { container } = render(<PortfolioSummaryCard summary={makeSummary()} isLoading={false} />);
    // Each InfoTooltip renders its question-mark icon inside its trigger, which
    // is a button: a focusable span has the generic role, so screen readers
    // dropped its aria-label and announced a nameless tab stop.
    const tooltipIcons = container.querySelectorAll('button.cursor-help svg');
    // Holdings Value, Cash Balance, Total Gain, Net Invested, Cost Basis,
    // Gain/Loss, Simple Return, TWR, MWR, CAGR
    expect(tooltipIcons.length).toBe(10);
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

  it("reads the server's Total Gain rather than the difference of two readings (issue #2410)", () => {
    // Value 100.004 and net invested 99.996 read 100.00 each; their difference
    // of readings is 0.00 and neutral, the server's one rounding 0.01.
    render(
      <PortfolioSummaryCard
        summary={makeSummary({
          totalPortfolioValue: 100,
          totalNetInvested: 100,
          totalGainOverNetInvested: 0.01,
        })}
        isLoading={false}
      />,
    );
    const gain = screen.getByText('$0.01');
    expect(gain.className).toContain('text-green-600');
    expect(gain.getAttribute('data-sign')).toBe('up');
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

  it('uses backend totals (live FX) in the default-currency view, not the stale frontend rate', () => {
    // The frontend rate hook holds a stale/different rate (x2 by default in
    // this file's mock). The default-currency view must show the backend's
    // already-converted totals so it stays in sync with the Portfolio Value
    // Over Time chart, rather than re-converting per account with this rate.
    const summary = makeSummary({
      totalHoldingsValue: 45000,
      totalCashValue: 5000,
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
    render(<PortfolioSummaryCard summary={summary} isLoading={false} />);
    // Backend total is shown ($45000.00), not the re-converted 45000 * 2.
    expect(screen.getByText('$45000.00')).toBeInTheDocument();
    expect(screen.queryByText('$90000.00')).not.toBeInTheDocument();
    // The default-currency view must not re-convert through the rate hook.
    expect(mockGetRate).not.toHaveBeenCalled();
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

  it('suppresses the approx line when the account->default rate is missing (review #1133)', () => {
    // convertToDefault used to pass the amount through unchanged for an
    // unresolved pair, so a JPY total with no JPY->CAD rate rendered as
    // "~ $15,000.00 CAD" -- an implicit rate of 1. No rate means the
    // approximation is unknown, and unknown does not render.
    mockGetRate.mockImplementation((from: string, to?: string) =>
      from === (to || mockDefaultCurrency) ? 1 : null,
    );
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
          fxComplete: true,
          missingRatePairs: [],
          pricesComplete: true,
          unpricedSecurityIds: [],
          valuationComplete: true,
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
    // The account-currency total still renders; only the approximation is
    // withheld.
    expect(screen.getAllByText(/USD/).length).toBeGreaterThan(0);
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
    const marker = screen.getByTestId('unknown-amount');
    const twrContainer = marker.closest('div[class*="text-"]');
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

  describe('single foreign account completeness (recheck RR5-001)', () => {
    it('warns from the account-currency state, not the global flag', () => {
      // The portfolio is complete at the top (default-currency totals converted
      // fine) but the selected JPY account could not be valued in JPY. The card
      // shows account-currency subtotals here, so it must warn from the account's
      // own state -- reading the global flag rendered 0 JPY as a complete total.
      const summary = makeSummary({
        // top-level complete
        fxComplete: true,
        pricesComplete: true,
        valuationComplete: true,
        holdingsByAccount: [
          {
            accountId: 'jpy-1',
            currencyCode: 'JPY',
            totalMarketValue: 0,
            totalCostBasis: 0,
            cashBalance: 0,
            totalGainLoss: 0,
            totalGainLossPercent: 0,
            netInvested: 0,
            holdings: [],
            // ...but incomplete in the account's own currency
            fxComplete: false,
            missingRatePairs: ['EUR->JPY'],
            pricesComplete: true,
            unpricedSecurityIds: [],
            valuationComplete: false,
          },
        ],
      });

      render(
        <PortfolioSummaryCard
          summary={summary}
          isLoading={false}
          singleAccountCurrency="JPY"
        />,
      );

      expect(screen.getByText('These figures are incomplete')).toBeInTheDocument();
      expect(screen.getByText(/EUR->JPY/)).toBeInTheDocument();
      expect(screen.getByText('Portfolio Value (partial)')).toBeInTheDocument();
    });

    it('stays quiet when the selected foreign account is complete', () => {
      const summary = makeSummary({
        holdingsByAccount: [
          {
            accountId: 'jpy-1',
            currencyCode: 'JPY',
            totalMarketValue: 1000,
            totalCostBasis: 800,
            cashBalance: 0,
            totalGainLoss: 200,
            totalGainLossPercent: 25,
            netInvested: 800,
            holdings: [],
            fxComplete: true,
            missingRatePairs: [],
            pricesComplete: true,
            unpricedSecurityIds: [],
            valuationComplete: true,
          },
        ],
      });

      render(
        <PortfolioSummaryCard
          summary={summary}
          isLoading={false}
          singleAccountCurrency="JPY"
        />,
      );

      expect(
        screen.queryByText('These figures are incomplete'),
      ).not.toBeInTheDocument();
    });
  });

  describe('gain over the priced holdings (A26-M38)', () => {
    // Priced A: value 100,000, cost 80,000. Unpriced B: cost 50,000. The server's
    // gain is +20,000 / +25% over A; value less every cost read -30,000.
    const partialSummary = (overrides?: Record<string, any>) =>
      makeSummary({
        totalPortfolioValue: 100000,
        totalHoldingsValue: 100000,
        totalCashValue: 0,
        totalCostBasis: 130000,
        gainCostBasis: 80000,
        unpricedCostBasis: 50000,
        totalGainLoss: 20000,
        totalGainLossPercent: 25,
        pricesComplete: false,
        unpricedSecurityIds: ['sec-u'],
        valuationComplete: false,
        holdings: [{ securityId: 'sec-u', symbol: 'UNPRICED' }],
        holdingsByAccount: [
          {
            accountId: 'a1',
            currencyCode: 'CAD',
            totalMarketValue: 100000,
            totalCostBasis: 130000,
            gainCostBasis: 80000,
            unpricedCostBasis: 50000,
            cashBalance: 0,
            totalGainLoss: 20000,
            totalGainLossPercent: 25,
            netInvested: 100000,
            holdings: [],
            fxComplete: true,
            missingRatePairs: [],
            pricesComplete: false,
            unpricedSecurityIds: ['sec-u'],
            valuationComplete: false,
          },
        ],
        ...overrides,
      });

    it('prints the known subtotal under the partial label when the server withholds the totals (audit #2365 p)', () => {
      render(
        <PortfolioSummaryCard
          summary={partialSummary({
            totalPortfolioValue: null,
            knownPortfolioValueSubtotal: 100000,
            totalHoldingsValue: null,
            knownHoldingsValueSubtotal: 100000,
            totalGainLoss: null,
            knownGainLossSubtotal: 20000,
            totalGainOverNetInvested: null,
            knownGainOverNetInvestedSubtotal: 20000,
          })}
          isLoading={false}
        />,
      );

      // The known subtotal is shown, not a blank, and the gain stays marked partial.
      expect(screen.getAllByText('$100000.00').length).toBeGreaterThan(0);
      expect(
        screen.getByText('+25.00%').closest('[data-testid="partial-total"]'),
      ).not.toBeNull();
    });

    it('marks the gain and the simple return as partial and prints the server figure', () => {
      render(<PortfolioSummaryCard summary={partialSummary()} isLoading={false} />);

      expect(screen.queryByText('$-30000.00')).not.toBeInTheDocument();
      expect(screen.queryByText('-$30000.00')).not.toBeInTheDocument();
      const gain = screen.getByText('$20000.00');
      expect(gain.closest('[data-testid="partial-total"]')).not.toBeNull();
      const simpleReturn = screen.getByText('+25.00%');
      expect(simpleReturn.closest('[data-testid="partial-total"]')).not.toBeNull();
    });

    it('reads the per-account gain, not value less cost, in the single foreign-account view', () => {
      mockDefaultCurrency = 'CAD';
      const summary = partialSummary({
        holdingsByAccount: [
          {
            accountId: 'a1',
            currencyCode: 'USD',
            totalMarketValue: 100000,
            totalCostBasis: 130000,
            gainCostBasis: 80000,
            unpricedCostBasis: 50000,
            cashBalance: 0,
            totalGainLoss: 20000,
            totalGainLossPercent: 25,
            netInvested: 100000,
            holdings: [],
            fxComplete: true,
            missingRatePairs: [],
            pricesComplete: false,
            unpricedSecurityIds: ['sec-u'],
            valuationComplete: false,
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

      expect(screen.queryByText('$-30000.00 USD')).not.toBeInTheDocument();
      expect(screen.queryByText('-$30000.00 USD')).not.toBeInTheDocument();
      expect(screen.getByText('$20000.00 USD')).toBeInTheDocument();
      expect(screen.getByText('+25.00%')).toBeInTheDocument();
    });

    it('leaves a complete portfolio unmarked', () => {
      render(<PortfolioSummaryCard summary={makeSummary()} isLoading={false} />);

      expect(screen.queryByTestId('partial-total')).not.toBeInTheDocument();
    });
  });

  describe('valuation completeness (recheck RR4-002)', () => {
    it('labels the value as partial and names the unpriced security', () => {
      // The server said the total was a subtotal and this card rendered the number
      // under "Total Portfolio Value" regardless, because the frontend type had
      // dropped the fields.
      const summary = makeSummary({
        totalPortfolioValue: 100,
        pricesComplete: false,
        unpricedSecurityIds: ['sec-u'],
        valuationComplete: false,
        holdings: [
          { securityId: 'sec-u', symbol: 'UNPRICED' },
          { securityId: 'sec-p', symbol: 'PRICED' },
        ],
      });

      render(<PortfolioSummaryCard summary={summary} isLoading={false} />);

      expect(
        screen.queryByText('Total Portfolio Value'),
      ).not.toBeInTheDocument();
      expect(screen.getByText('Portfolio Value (partial)')).toBeInTheDocument();
      expect(screen.getByText('These figures are incomplete')).toBeInTheDocument();
      expect(screen.getByText(/UNPRICED/)).toBeInTheDocument();
    });

    it('names the missing exchange rate pair when FX is what is incomplete', () => {
      const summary = makeSummary({
        fxComplete: false,
        missingRatePairs: ['EUR->USD'],
        valuationComplete: false,
      });

      render(<PortfolioSummaryCard summary={summary} isLoading={false} />);

      expect(screen.getByText(/EUR->USD/)).toBeInTheDocument();
    });

    it('says nothing when the valuation is complete', () => {
      render(<PortfolioSummaryCard summary={makeSummary()} isLoading={false} />);

      expect(screen.getByText('Total Portfolio Value')).toBeInTheDocument();
      expect(
        screen.queryByText('These figures are incomplete'),
      ).not.toBeInTheDocument();
    });

    it('does not claim incomplete when an older payload omits the fields', () => {
      // A rolling deploy can briefly serve a response with none of these fields.
      // Absent is "no information", not "incomplete", and must not crash the page.
      const summary = makeSummary();
      delete summary.fxComplete;
      delete summary.pricesComplete;
      delete summary.valuationComplete;
      delete summary.missingRatePairs;
      delete summary.unpricedSecurityIds;

      render(<PortfolioSummaryCard summary={summary} isLoading={false} />);

      expect(screen.getByText('Total Portfolio Value')).toBeInTheDocument();
      expect(
        screen.queryByText('These figures are incomplete'),
      ).not.toBeInTheDocument();
    });
  });
});

