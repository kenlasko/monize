import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act, fireEvent, waitFor, within } from '@/test/render';
import SecurityDetailPage from './page';
import type { Security, SecurityDetail } from '@/types/investment';

const mockPush = vi.fn();
const financialToday = { current: '2026-07-28' };
vi.mock('@/hooks/useFinancialToday', () => ({
  useFinancialToday: () => financialToday.current,
}));
/** Mutable so a test can arrive with `?tab=` the way a deep link does. */
const searchParams = { current: new URLSearchParams() };
/**
 * Mutable too: the switcher moves between securities with `router.push` on the
 * same route, so a test has to be able to change the id under a mounted page the
 * way the App Router does.
 */
const routeParams = { current: { id: 'sec-1' } as { id: string } };
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush, replace: vi.fn() }),
  usePathname: () => `/securities/${routeParams.current.id}`,
  useParams: () => routeParams.current,
  useSearchParams: () => searchParams.current,
}));

vi.mock('@/store/authStore', () => ({
  useAuthStore: Object.assign(
    (selector?: (state: unknown) => unknown) => {
      const state = {
        user: {
          id: 'user-1',
          email: 'test@example.com',
          role: 'user',
          hasPassword: true,
        },
        isAuthenticated: true,
        isLoading: false,
        _hasHydrated: true,
        logout: vi.fn(),
      };
      return selector ? selector(state) : state;
    },
    {
      getState: vi.fn(() => ({
        user: { id: 'user-1', email: 'test@example.com', role: 'user' },
        isAuthenticated: true,
        isLoading: false,
        _hasHydrated: true,
      })),
    },
  ),
}));

vi.mock('@/lib/errors', () => ({
  getErrorMessage: vi.fn((_e: unknown, fallback: string) => fallback),
}));

// The chart has its own tests; stub it so this page test does not depend on
// Recharts measuring a zero-size container.
vi.mock('@/components/transactions/BalanceHistoryChart', () => ({
  BalanceHistoryChart: ({ data }: { data: unknown[] }) => (
    <div data-testid="chart">{data.length}</div>
  ),
}));

const mockGetSecurityDetail = vi.fn();
const mockGetSecurityPrices = vi.fn();
const mockGetSecurityTransactionHistory = vi.fn();
const mockSetSecurityFavourite = vi.fn();
const mockBackfillSecurityPrices = vi.fn();
const mockGetSecurities = vi.fn();
const mockGetSecurityDocuments = vi.fn();
const mockGetSecurityNews = vi.fn();
const mockRefreshSelectedPrices = vi.fn();
const mockGetSecurityBondValuation = vi.fn();
const mockGetBondOffer = vi.fn();
const mockListBondPrograms = vi.fn();
const mockGetBondHistory = vi.fn();
const mockGetBondRefreshProgress = vi.fn();

vi.mock('@/lib/investments', () => ({
  investmentsApi: {
    refreshSelectedPrices: (...args: unknown[]) =>
      mockRefreshSelectedPrices(...args),
    getSecurityDetail: (...args: unknown[]) => mockGetSecurityDetail(...args),
    getSecurityPrices: (...args: unknown[]) => mockGetSecurityPrices(...args),
    getSecurityTransactionHistory: (...args: unknown[]) =>
      mockGetSecurityTransactionHistory(...args),
    setSecurityFavourite: (...args: unknown[]) =>
      mockSetSecurityFavourite(...args),
    backfillSecurityPrices: (...args: unknown[]) =>
      mockBackfillSecurityPrices(...args),
    getSecurities: (...args: unknown[]) => mockGetSecurities(...args),
    getSecurityDocuments: (...args: unknown[]) =>
      mockGetSecurityDocuments(...args),
    getSecurityNews: (...args: unknown[]) => mockGetSecurityNews(...args),
    getSecurityBondValuation: (...args: unknown[]) =>
      mockGetSecurityBondValuation(...args),
    getSecurityBondScenarios: vi.fn(),
    getBondOffer: (...args: unknown[]) => mockGetBondOffer(...args),
    listBondPrograms: (...args: unknown[]) => mockListBondPrograms(...args),
    getBondHistory: (...args: unknown[]) => mockGetBondHistory(...args),
    getBondRefreshProgress: (...args: unknown[]) => mockGetBondRefreshProgress(...args),
    recomputeSecurityBondPrices: vi.fn(),
    updateSecurity: vi.fn(),
  },
}));

const security: Security = {
  id: 'sec-1',
  symbol: 'AAPL',
  name: 'Apple Inc.',
  securityType: 'STOCK',
  exchange: 'NASDAQ',
  currencyCode: 'USD',
  description: 'Apple designs and sells consumer electronics.',
  tags: [],
  isActive: true,
  isFavourite: false,
  skipPriceUpdates: false,
  sector: 'Technology',
  industry: 'Consumer Electronics',
  sectorWeightings: null,
  countryWeightings: null,
  assetWeightings: null,
  website: null,
  irWebsite: null,
  quoteProvider: 'yahoo',
  msnInstrumentId: null,
  lastPriceSource: 'yahoo_finance',
  createdAt: '2024-01-01T00:00:00.000Z',
  updatedAt: '2024-01-01T00:00:00.000Z',
};

function detailFixture(overrides: Partial<SecurityDetail> = {}): SecurityDetail {
  return {
    security,
    position: {
      quantity: 100,
      averageCost: 120,
      currentPrice: 150,
      costBasis: 12000,
      marketValue: 15000,
      gainLoss: 3000,
      gainLossPercent: 25,
    },
    accounts: [
      {
        accountId: 'acct-1',
        accountName: 'Brokerage',
        accountCurrencyCode: 'PLN',
        isClosed: false,
        quantity: 60,
        averageCost: 120,
        costBasis: 7200,
        costBasisAccountCurrency: 28800,
        marketValue: 9000,
        gainLoss: 1800,
        gainLossPercent: 25,
      },
      {
        accountId: 'acct-2',
        accountName: 'IKE',
        accountCurrencyCode: 'PLN',
        isClosed: false,
        quantity: 40,
        averageCost: 120,
        costBasis: 4800,
        costBasisAccountCurrency: 19200,
        marketValue: 6000,
        gainLoss: 1200,
        gainLossPercent: 25,
      },
    ],
    activity: {
      firstTransactionDate: '2022-03-12',
      lastTransactionDate: '2026-06-20',
      totalInvested: 12000,
      totalSold: 0,
      dividends: 320.5,
      fees: 48.3,
      realizedGain: null,
      realizedGainCurrency: null,
      realizedGainCurrencies: [],
      realizedSaleCount: 0,
      transactionCount: 4,
    },
    hasTransactions: true,
    isPositionClosed: false,
    dailyChange: null,
    ...overrides,
  };
}

async function renderPage() {
  let result: ReturnType<typeof render>;
  await act(async () => {
    result = render(<SecurityDetailPage />);
  });
  return result!;
}

describe('SecurityDetailPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    searchParams.current = new URLSearchParams();
    routeParams.current = { id: 'sec-1' };
    mockGetSecurityDetail.mockResolvedValue(detailFixture());
    mockGetSecurityPrices.mockResolvedValue([
      {
        id: 2,
        securityId: 'sec-1',
        priceDate: '2026-07-28',
        openPrice: null,
        highPrice: null,
        lowPrice: null,
        closePrice: 150,
        adjustedClose: 150,
        volume: null,
        source: 'yahoo_finance',
        createdAt: '2026-07-28T00:00:00.000Z',
      },
      {
        id: 1,
        securityId: 'sec-1',
        priceDate: '2026-07-27',
        openPrice: null,
        highPrice: null,
        lowPrice: null,
        closePrice: 145,
        adjustedClose: 145,
        volume: null,
        source: 'yahoo_finance',
        createdAt: '2026-07-27T00:00:00.000Z',
      },
    ]);
    mockGetSecurities.mockResolvedValue([security]);
    mockGetSecurityDocuments.mockResolvedValue([]);
    mockGetSecurityNews.mockResolvedValue({ provider: 'yahoo', items: [] });
    mockGetSecurityTransactionHistory.mockResolvedValue({
      securityId: 'sec-1',
      symbol: 'AAPL',
      name: 'Apple Inc.',
      currencyCode: 'USD',
      isActive: true,
      accounts: [],
      transactions: [],
      currentQuantityAll: 100,
    });
    mockGetBondOffer.mockResolvedValue({ countryCode: 'PL', today: '2027-04-15', series: [] });
    mockListBondPrograms.mockResolvedValue([]);
    mockGetBondHistory.mockResolvedValue({ countryCode: 'PL', programs: [] });
    mockGetBondRefreshProgress.mockResolvedValue({
      startedAt: null, phase: null, done: 0, total: 0, seriesCode: null, finishedAt: null,
    });
    mockRefreshSelectedPrices.mockResolvedValue({
      totalSecurities: 1,
      updated: 1,
      failed: 0,
      skipped: 0,
      results: [{ securityId: 'sec-1', symbol: 'AAPL', success: true }],
      lastUpdated: '2026-07-30T12:00:00.000Z',
    });
  });

  it('names the security as the page heading', async () => {
    await renderPage();
    expect(
      screen.getByRole('heading', { level: 1, name: 'Apple Inc.' }),
    ).toBeInTheDocument();
  });

  it('discards a load that resolves after the reader moved to another security', async () => {
    // The switcher moves between securities on the same route, so this component
    // stays mounted and a load started for the previous one keeps running. With
    // nothing discarding the late response, it wrote its own figures over the new
    // page: another instrument's position under this instrument's URL, with
    // nothing on screen to say so.
    let resolveSlowRead: ((detail: SecurityDetail) => void) | undefined;
    const slowRead = new Promise<SecurityDetail>((resolve) => {
      resolveSlowRead = resolve;
    });
    const microsoft = detailFixture({
      security: { ...security, id: 'sec-2', symbol: 'MSFT', name: 'Microsoft' },
    });
    mockGetSecurityDetail.mockImplementation((id: string) =>
      id === 'sec-1' ? slowRead : Promise.resolve(microsoft),
    );

    // Apple's read is still in flight when the reader picks Microsoft.
    const { rerender } = await renderPage();
    routeParams.current = { id: 'sec-2' };
    await act(async () => {
      rerender(<SecurityDetailPage />);
    });
    await waitFor(() => {
      expect(
        screen.getByRole('heading', { level: 1, name: 'Microsoft' }),
      ).toBeInTheDocument();
    });

    // Only now does Apple's response arrive.
    await act(async () => {
      resolveSlowRead?.(detailFixture());
    });

    expect(
      screen.getByRole('heading', { level: 1, name: 'Microsoft' }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('heading', { level: 1, name: 'Apple Inc.' }),
    ).not.toBeInTheDocument();
  });

  it('names the currency on the header quote when it is not the reader\'s', async () => {
    // Deliberately a currency the reader is NOT on. The fixture used to be a USD
    // security relying on the reader's fallback being CAD, so when that fallback
    // moved to USD the case started asserting the opposite of its own name --
    // the component was right to omit the code, and the test failed for it.
    mockGetSecurityDetail.mockResolvedValue(
      detailFixture({ security: { ...security, currencyCode: 'EUR' } }),
    );
    await renderPage();
    // The quote is the largest figure on the page and the one a reader anchors
    // on, so a figure in another currency has to say which.
    expect(screen.getByText(/150\.00 EUR/)).toBeInTheDocument();
  });

  describe('header daily change renders the server answer', () => {
    const serverMove = {
      currentPrice: 150,
      previousPrice: 145,
      dailyChange: 5,
      dailyChangePercent: 3.448,
      priceDate: '2026-07-28',
    };

    it('shows the move the server resolved', async () => {
      mockGetSecurityDetail.mockResolvedValue(
        detailFixture({ dailyChange: serverMove }),
      );
      await renderPage();
      expect(screen.getByText(/\+\$?5\.00.*today/)).toBeInTheDocument();
    });

    it('labels a move from an earlier session as the last move, not today', async () => {
      financialToday.current = '2026-07-29';
      try {
        mockGetSecurityDetail.mockResolvedValue(
          detailFixture({ dailyChange: serverMove }),
        );
        await renderPage();
        expect(screen.getByText(/\+\$?5\.00.*last move/)).toBeInTheDocument();
        expect(screen.queryByText(/today/)).not.toBeInTheDocument();
      } finally {
        financialToday.current = '2026-07-28';
      }
    });

    it('shows the newest close and no move when the server refuses', async () => {
      // The two default closes are a day apart, so a client rule would show a
      // move here; the server said null.
      mockGetSecurityDetail.mockResolvedValue(detailFixture({ dailyChange: null }));
      await renderPage();
      expect(screen.getAllByText(/150\.00/).length).toBeGreaterThan(0);
      expect(screen.queryByText(/today|last move/)).not.toBeInTheDocument();
    });

    it('does not show a move struck for another session than the newest close', async () => {
      mockGetSecurityDetail.mockResolvedValue(
        detailFixture({ dailyChange: { ...serverMove, priceDate: '2026-07-20' } }),
      );
      await renderPage();
      expect(screen.queryByText(/today|last move/)).not.toBeInTheDocument();
    });
  });

  it('refreshes only this security from the header, then re-reads the quote', async () => {
    await renderPage();
    mockGetSecurityDetail.mockClear();
    mockGetSecurityPrices.mockClear();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    });

    // Scoped to the security on screen: refreshing the whole catalog from a
    // single security's page would be a much larger job than the button offers.
    expect(mockRefreshSelectedPrices).toHaveBeenCalledWith(['sec-1']);
    await waitFor(() => {
      expect(mockGetSecurityDetail).toHaveBeenCalled();
      expect(mockGetSecurityPrices).toHaveBeenCalled();
    });
  });

  it('leaves the page up when the post-refresh re-read fails', async () => {
    await renderPage();
    mockGetSecurityDetail.mockRejectedValueOnce(new Error('network'));

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    });
    await act(async () => {});

    // The previous figures stay on screen rather than collapsing to the error
    // state -- the refresh itself already reported its own outcome.
    expect(
      screen.getByRole('heading', { level: 1, name: 'Apple Inc.' }),
    ).toBeInTheDocument();
  });

  it('opens the Investments page filtered to an account', async () => {
    await renderPage();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Brokerage/ }));
    });
    // The Investments page already accepts this parameter; the Accounts list
    // links the same way.
    expect(mockPush).toHaveBeenCalledWith('/investments?accountId=acct-1');
  });

  it('leaves the classification to Key information rather than repeating it', async () => {
    await renderPage();
    // Symbol, type, exchange and currency used to sit under the name as well;
    // saying them twice cost a third of the header's height.
    expect(screen.queryByText(/AAPL.*Stock.*NASDAQ.*USD/)).toBeNull();
    expect(
      screen.getByRole('heading', { name: 'Key information' }),
    ).toBeInTheDocument();
  });

  it('offers no overflow menu in the header', async () => {
    await renderPage();
    // Its items either jumped the page to a tab further down or duplicated the
    // Price history tab's own refresh button.
    expect(screen.queryByRole('button', { name: 'More' })).toBeNull();
  });

  it('reports the load failure with a way to retry', async () => {
    mockGetSecurityDetail.mockRejectedValue(new Error('boom'));
    await renderPage();
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Retry' }),
    ).toBeInTheDocument();
  });

  it('keeps the page usable when only the price history fails', async () => {
    mockGetSecurityPrices.mockRejectedValue(new Error('no prices'));
    await renderPage();
    expect(
      screen.getByRole('heading', { level: 1, name: 'Apple Inc.' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('goes back to the securities list', async () => {
    await renderPage();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Securities/ }));
    });
    expect(mockPush).toHaveBeenCalledWith('/securities');
  });

  describe('bond valuation card', () => {
    const bondSecurity = {
      ...security,
      securityType: 'BOND' as const,
      currencyCode: 'PLN',
      bondProgramId: 'prog-1',
    };

    beforeEach(() => {
      mockGetSecurityBondValuation.mockResolvedValue({
        securityId: 'sec-1',
        program: {
          id: 'prog-1',
          programCode: 'RETAIL',
          issuerCountryCode: 'PL',
          issuerCode: 'PL_MF',
          currency: 'PLN',
        },
        autoFetch: false,
        series: [],
        asOf: '2027-04-15',
        lots: [],
        totals: { quantity: 0, grossValue: '0.0000', earlyRedemptionValue: '0.0000', accruedInterest: '0.0000' },
        refusal: null,
      });
    });

    it('shows the card and asks for the valuation when the security is linked to a bond program', async () => {
      mockGetSecurityDetail.mockResolvedValue(detailFixture({ security: bondSecurity }));
      await renderPage();
      expect(await screen.findByRole('heading', { name: 'Your series' })).toBeInTheDocument();
      await waitFor(() =>
        expect(mockGetSecurityBondValuation).toHaveBeenCalledWith('sec-1', expect.any(String), undefined),
      );
    });

    it('shows no card and sends no request when the security is not linked', async () => {
      mockGetSecurityDetail.mockResolvedValue(
        detailFixture({ security: { ...bondSecurity, bondProgramId: null } }),
      );
      await renderPage();
      expect(screen.queryByRole('heading', { name: 'Your series' })).not.toBeInTheDocument();
      expect(mockGetSecurityBondValuation).not.toHaveBeenCalled();
    });

    describe('terms history tab', () => {
      const bondHistory = {
        countryCode: 'PL',
        programs: [
          {
            programCode: 'RETAIL',
            coverage: { from: '2026-10', to: '2026-10', missingMonths: [] },
            series: [
              {
                seriesCode: 'TOS1029',
                saleWindow: { from: '2026-10-01', to: '2026-10-31' },
                firstPeriodRate: '0.0440',
                annualRate: null,
                addend: null,
                fee: '3.00',
                proceedsFloor: null,
                termsVersion: 1,
                termsSource: { document: 'Terms', url: null },
              },
            ],
          },
        ],
      };

      beforeEach(() => {
        mockGetSecurityDetail.mockResolvedValue(detailFixture({ security: bondSecurity }));
        mockGetBondHistory.mockResolvedValue(bondHistory);
      });

      it('replaces Price history with Terms history for a bond', async () => {
        await renderPage();
        expect(screen.getByRole('tab', { name: 'Terms history' })).toBeInTheDocument();
        expect(screen.queryByRole('tab', { name: 'Price history' })).not.toBeInTheDocument();
      });

      it('keeps the manual price controls reachable under Terms history for a linked bond', async () => {
        await renderPage();
        await act(async () => {
          fireEvent.click(screen.getByRole('tab', { name: 'Terms history' }));
        });
        expect(await screen.findByRole('heading', { name: 'Price history' })).toBeInTheDocument();
        expect(await screen.findByText('+ Add Price', undefined, { timeout: 5000 })).toBeInTheDocument();
      });

      it('keeps Price history and offers no Terms history for another security', async () => {
        mockGetSecurityDetail.mockResolvedValue(detailFixture({ security }));
        await renderPage();
        expect(screen.getByRole('tab', { name: 'Price history' })).toBeInTheDocument();
        expect(screen.queryByRole('tab', { name: 'Terms history' })).not.toBeInTheDocument();
      });

      it('no longer renders the terms history on the Overview', async () => {
        await renderPage();
        await screen.findByRole('heading', { name: 'Your series' });
        expect(screen.queryByText('Every stored series')).not.toBeInTheDocument();
        expect(screen.queryByRole('region', { name: 'History of RETAIL terms' })).not.toBeInTheDocument();
        expect(mockGetBondHistory).not.toHaveBeenCalled();
      });

      it('shows the terms history under its tab', async () => {
        await renderPage();
        await act(async () => {
          fireEvent.click(screen.getByRole('tab', { name: 'Terms history' }));
        });
        expect(await screen.findByText('Every stored series')).toBeInTheDocument();
        // Scoped: the manual price history below has its own year groups.
        const terms = screen.getByRole('region', { name: 'History of RETAIL terms' });
        expect(within(terms).getByRole('button', { name: /2026/, expanded: true })).toBeInTheDocument();
        expect(screen.getByText('TOS1029')).toBeInTheDocument();
      });

      it('falls back to Overview for a stale ?tab=prices link on a bond', async () => {
        searchParams.current = new URLSearchParams('tab=prices');
        await renderPage();
        expect(screen.getByRole('tab', { name: 'Overview' })).toHaveAttribute('aria-selected', 'true');
      });

      it('falls back to Overview for ?tab=terms on a security without a program', async () => {
        mockGetSecurityDetail.mockResolvedValue(detailFixture({ security }));
        searchParams.current = new URLSearchParams('tab=terms');
        await renderPage();
        expect(screen.getByRole('tab', { name: 'Overview' })).toHaveAttribute('aria-selected', 'true');
      });

      it('re-reads the tab after a refresh completes', async () => {
        let resolve!: (v: unknown) => void;
        mockRefreshSelectedPrices.mockReturnValue(new Promise((r) => (resolve = r)));
        await renderPage();
        await act(async () => {
          fireEvent.click(screen.getByRole('tab', { name: 'Terms history' }));
        });
        await screen.findByText('Every stored series');
        const before = mockGetBondHistory.mock.calls.length;
        await act(async () => {
          fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
        });
        expect(mockGetBondHistory).toHaveBeenCalledTimes(before);
        await act(async () => {
          resolve({ totalSecurities: 1, updated: 1, failed: 0, skipped: 0, results: [], lastUpdated: null });
        });
        await waitFor(() => expect(mockGetBondHistory.mock.calls.length).toBeGreaterThan(before));
      });
    });

    describe('refresh', () => {
      const deferRefresh = () => {
        let resolve!: (v: unknown) => void;
        mockRefreshSelectedPrices.mockReturnValue(
          new Promise((r) => {
            resolve = r;
          }),
        );
        return () =>
          resolve({ totalSecurities: 1, updated: 1, failed: 0, skipped: 0, results: [], lastUpdated: null });
      };

      it('shows the progress bar only while the bond refresh runs', async () => {
        mockGetSecurityDetail.mockResolvedValue(detailFixture({ security: bondSecurity }));
        const finish = deferRefresh();
        await renderPage();
        expect(screen.queryByText('Starting…')).not.toBeInTheDocument();

        await act(async () => {
          fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
        });
        expect(screen.getByText('Starting…')).toBeInTheDocument();

        await act(async () => {
          finish();
        });
        await waitFor(() => expect(screen.queryByText('Starting…')).not.toBeInTheDocument());
      });

      it('shows no progress bar when a security without a program refreshes', async () => {
        const finish = deferRefresh();
        await renderPage();
        await act(async () => {
          fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
        });
        expect(screen.queryByText('Starting…')).not.toBeInTheDocument();
        await act(async () => {
          finish();
        });
      });

      it('re-reads every bond section once when the refresh completes', async () => {
        mockGetSecurityDetail.mockResolvedValue(detailFixture({ security: bondSecurity }));
        const finish = deferRefresh();
        await renderPage();
        await screen.findByRole('heading', { name: 'Your series' });
        await waitFor(() => {
          expect(mockListBondPrograms).toHaveBeenCalled();
          expect(mockGetBondOffer).toHaveBeenCalled();
        });
        const before = {
          valuation: mockGetSecurityBondValuation.mock.calls.length,
          offer: mockGetBondOffer.mock.calls.length,
          programs: mockListBondPrograms.mock.calls.length,
          documents: mockGetSecurityDocuments.mock.calls.length,
        };

        await act(async () => {
          fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
        });
        // Nothing is re-read while the refresh is still running.
        expect(mockGetSecurityBondValuation).toHaveBeenCalledTimes(before.valuation);
        await act(async () => {
          finish();
        });

        await waitFor(() => {
          expect(mockGetSecurityBondValuation).toHaveBeenCalledTimes(before.valuation * 2);
          expect(mockGetBondOffer.mock.calls.length).toBeGreaterThanOrEqual(before.offer * 2);
          expect(mockListBondPrograms).toHaveBeenCalledTimes(before.programs * 2);
        });
        // Once per completed refresh: nothing keeps re-reading afterwards.
        const settled = mockGetBondOffer.mock.calls.length;
        await act(async () => {});
        expect(mockGetBondOffer).toHaveBeenCalledTimes(settled);
        expect(mockGetSecurityBondValuation).toHaveBeenCalledTimes(before.valuation * 2);
        // The reader's own documents are not bond data and are not re-read.
        expect(mockGetSecurityDocuments).toHaveBeenCalledTimes(before.documents);
      });

      it('re-reads the bond sections after a refresh that failed too', async () => {
        mockGetSecurityDetail.mockResolvedValue(detailFixture({ security: bondSecurity }));
        let reject!: (e: unknown) => void;
        mockRefreshSelectedPrices.mockReturnValue(
          new Promise((_r, rej) => {
            reject = rej;
          }),
        );
        await renderPage();
        await screen.findByRole('heading', { name: 'Your series' });
        const before = mockGetSecurityBondValuation.mock.calls.length;
        await act(async () => {
          fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
        });
        await act(async () => {
          reject(new Error('boom'));
        });
        await waitFor(() =>
          expect(mockGetSecurityBondValuation).toHaveBeenCalledTimes(before * 2),
        );
      });
    });
  });

  describe('summary', () => {
    it('shows the position value in the reporting currency', async () => {
      await renderPage();
      expect(
        screen.getByRole('article', { name: 'Market value' }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole('article', { name: 'Cost basis' }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole('article', { name: 'Unrealized P/L' }),
      ).toBeInTheDocument();
    });

    it('lists each holding account with its share of the position', async () => {
      await renderPage();
      const card = screen.getByRole('article', { name: 'Held in accounts' });
      expect(card).toHaveTextContent('Brokerage');
      expect(card).toHaveTextContent('IKE');
      expect(card).toHaveTextContent('60.00%');
      expect(card).toHaveTextContent('40.00%');
    });

    it('replaces the cards with a closed-position panel once nothing is held', async () => {
      mockGetSecurityDetail.mockResolvedValue(
        detailFixture({
          accounts: [],
          isPositionClosed: true,
          activity: {
            ...detailFixture().activity,
            realizedGain: 2340,
            realizedGainCurrency: 'PLN',
          },
        }),
      );
      await renderPage();
      expect(screen.getByText('Position closed')).toBeInTheDocument();
      // No zero-filled figures standing in for a position that is not there.
      expect(
        screen.queryByRole('article', { name: 'Market value' }),
      ).not.toBeInTheDocument();
    });

    it('distinguishes a never-held security from a closed one', async () => {
      mockGetSecurityDetail.mockResolvedValue(
        detailFixture({
          accounts: [],
          hasTransactions: false,
          isPositionClosed: false,
        }),
      );
      await renderPage();
      expect(screen.getByText('No position data')).toBeInTheDocument();
      expect(screen.queryByText('Position closed')).not.toBeInTheDocument();
    });
  });

  describe('tabs', () => {
    it('opens on Overview and offers the other sections', async () => {
      await renderPage();
      expect(screen.getByRole('tab', { name: 'Overview' })).toHaveAttribute(
        'aria-selected',
        'true',
      );
      expect(screen.getByRole('tab', { name: 'Transactions' })).toBeInTheDocument();
      expect(screen.getByRole('tab', { name: 'Price history' })).toBeInTheDocument();
    });

    it('opens the tab a link names', async () => {
      // The dashboard's price widgets point straight here.
      searchParams.current = new URLSearchParams('tab=prices');
      await renderPage();
      expect(screen.getByRole('tab', { name: 'Price history' })).toHaveAttribute(
        'aria-selected',
        'true',
      );
    });

    it('falls back to Overview for a tab that does not exist', async () => {
      searchParams.current = new URLSearchParams('tab=nonsense');
      await renderPage();
      expect(screen.getByRole('tab', { name: 'Overview' })).toHaveAttribute(
        'aria-selected',
        'true',
      );
    });

    it('offers Documents and News, and loads neither until opened', async () => {
      await renderPage();
      expect(
        screen.getByRole('tab', { name: 'Documents' }),
      ).toBeInTheDocument();
      expect(screen.getByRole('tab', { name: 'News' })).toBeInTheDocument();
      // Lazy panels: nothing asks the API for either on arrival.
      expect(mockGetSecurityDocuments).not.toHaveBeenCalled();
      expect(mockGetSecurityNews).not.toHaveBeenCalled();
    });

    it('loads the news when that tab is opened', async () => {
      await renderPage();
      await act(async () => {
        fireEvent.click(screen.getByRole('tab', { name: 'News' }));
      });
      await waitFor(() =>
        expect(mockGetSecurityNews).toHaveBeenCalledWith('sec-1'),
      );
    });

    it('loads the documents when that tab is opened', async () => {
      await renderPage();
      await act(async () => {
        fireEvent.click(screen.getByRole('tab', { name: 'Documents' }));
      });
      // The panel is a dynamic import, so its first render lands a tick later.
      await waitFor(() =>
        expect(mockGetSecurityDocuments).toHaveBeenCalledWith('sec-1'),
      );
    });

    it('gives Overview the description, the figures and the tables', async () => {
      await renderPage();
      for (const name of [
        'About',
        // Named for its subject: these are the instrument's returns, not the
        // holder's, and "Performance" alone was read as the latter.
        'Security performance',
        'Position info',
        'Accounts',
      ]) {
        expect(screen.getByRole('heading', { name })).toBeInTheDocument();
      }
    });

    it('surfaces the sector breakdown the provider supplies', async () => {
      mockGetSecurityDetail.mockResolvedValue(
        detailFixture({
          security: {
            ...security,
            sectorWeightings: [
              { sector: 'Technology', weight: 0.324 },
              { sector: 'Financials', weight: 0.181 },
            ],
          },
        }),
      );
      await renderPage();

      // Beside the chart, not in Overview: it shares a card with the country
      // breakdown and opens on Sector. Asserted via the bar's own label, since
      // "Technology" is also this security's single sector elsewhere.
      expect(
        screen.getByRole('heading', { name: 'Breakdown' }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole('img', { name: 'Technology: 32.40%' }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole('img', { name: 'Financials: 18.10%' }),
      ).toBeInTheDocument();
    });

    it('switches to the price history table on demand', async () => {
      await renderPage();
      await act(async () => {
        fireEvent.click(screen.getByRole('tab', { name: 'Price history' }));
      });
      expect(screen.getByRole('tab', { name: 'Price history' })).toHaveAttribute(
        'aria-selected',
        'true',
      );
      expect(
        screen.queryByRole('heading', { name: 'About' }),
      ).not.toBeInTheDocument();
    });

    it('keeps Key information visible whichever tab is open', async () => {
      await renderPage();
      await act(async () => {
        fireEvent.click(screen.getByRole('tab', { name: 'Transactions' }));
      });
      // It sits beside the chart, above the tabs, so switching tab does not take
      // the instrument's identity off the screen. Performance and Position info
      // are inside Overview and do go with it.
      expect(
        screen.getByRole('heading', { name: 'Key information' }),
      ).toBeInTheDocument();
      expect(screen.queryByRole('heading', { name: 'Performance' })).toBeNull();
    });
  });

  describe('distributions', () => {
    it('reports an accumulating fund when the two price series agree', async () => {
      // A year of history, so the periods have a baseline and the card is not
      // empty -- the caption only appears when there are returns to caption.
      mockGetSecurityPrices.mockResolvedValue([
        {
          id: 2, securityId: 'sec-1', priceDate: '2026-07-28',
          openPrice: null, highPrice: null, lowPrice: null,
          closePrice: 150, adjustedClose: 150, volume: null,
          source: 'yahoo_finance', createdAt: '2026-07-28T00:00:00.000Z',
        },
        {
          id: 1, securityId: 'sec-1', priceDate: '2025-07-27',
          openPrice: null, highPrice: null, lowPrice: null,
          closePrice: 100, adjustedClose: 100, volume: null,
          source: 'yahoo_finance', createdAt: '2025-07-27T00:00:00.000Z',
        },
      ]);
      await renderPage();

      // Nothing was ever paid out, so the adjusted close never parts from the
      // quoted one.
      expect(screen.getByText('None (accumulating)')).toBeInTheDocument();
      expect(screen.getByText('Includes dividends')).toBeInTheDocument();
    });

    it('reports a distributing fund once the series part', async () => {
      mockGetSecurityPrices.mockResolvedValue([
        {
          id: 2, securityId: 'sec-1', priceDate: '2026-07-28',
          openPrice: null, highPrice: null, lowPrice: null,
          closePrice: 150, adjustedClose: 150, volume: null,
          source: 'yahoo_finance', createdAt: '2026-07-28T00:00:00.000Z',
        },
        {
          id: 1, securityId: 'sec-1', priceDate: '2025-07-27',
          openPrice: null, highPrice: null, lowPrice: null,
          closePrice: 100, adjustedClose: 96, volume: null,
          source: 'yahoo_finance', createdAt: '2025-07-27T00:00:00.000Z',
        },
      ]);
      await renderPage();
      expect(screen.getByText('Paid (observed)')).toBeInTheDocument();
    });

    it('says nothing, and warns, when the provider gives no adjusted series', async () => {
      mockGetSecurityPrices.mockResolvedValue([
        {
          id: 2, securityId: 'sec-1', priceDate: '2026-07-28',
          openPrice: null, highPrice: null, lowPrice: null,
          closePrice: 150, adjustedClose: null, volume: null,
          source: 'msn_finance', createdAt: '2026-07-28T00:00:00.000Z',
        },
        {
          id: 1, securityId: 'sec-1', priceDate: '2025-07-27',
          openPrice: null, highPrice: null, lowPrice: null,
          closePrice: 100, adjustedClose: null, volume: null,
          source: 'msn_finance', createdAt: '2025-07-27T00:00:00.000Z',
        },
      ]);
      await renderPage();

      // No basis to claim either way, so the row is absent...
      expect(screen.queryByText('Distributions')).toBeNull();
      // ...but the returns on screen are measured on price alone, and that is
      // not left to be discovered.
      expect(screen.getByText('Excludes dividends')).toBeInTheDocument();
      expect(screen.queryByText('Includes dividends')).toBeNull();
    });
  });

  describe('chart', () => {
    it('offers the three series and starts on price', async () => {
      await renderPage();
      expect(screen.getByRole('button', { name: 'Price' })).toHaveAttribute(
        'aria-pressed',
        'true',
      );
      expect(
        screen.getByRole('button', { name: 'Investment value' }),
      ).toHaveAttribute('aria-pressed', 'false');
      expect(screen.getByRole('button', { name: 'Return' })).toBeInTheDocument();
    });

    it('switches series without reloading the page data', async () => {
      await renderPage();
      mockGetSecurityDetail.mockClear();
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Return' }));
      });
      expect(screen.getByRole('button', { name: 'Return' })).toHaveAttribute(
        'aria-pressed',
        'true',
      );
      expect(mockGetSecurityDetail).not.toHaveBeenCalled();
    });
  });

  describe('favourites', () => {
    it('uses the same wording as the securities list', async () => {
      await renderPage();
      // "Watch" was ours alone; the rest of the app calls these favourites.
      expect(screen.getByText('Favourites')).toBeInTheDocument();
      expect(
        screen.getByRole('button', { name: 'Add to favourites' }),
      ).toBeInTheDocument();
    });

    it('adds the security and reflects it on the button', async () => {
      mockSetSecurityFavourite.mockResolvedValue({
        ...security,
        isFavourite: true,
      });
      await renderPage();
      await act(async () => {
        fireEvent.click(
          screen.getByRole('button', { name: 'Add to favourites' }),
        );
      });
      expect(mockSetSecurityFavourite).toHaveBeenCalledWith('sec-1', true);
      await waitFor(() =>
        expect(
          screen.getByRole('button', { name: 'Remove from favourites' }),
        ).toBeInTheDocument(),
      );
    });

    it('leaves the button alone when the update fails', async () => {
      mockSetSecurityFavourite.mockRejectedValue(new Error('nope'));
      await renderPage();
      await act(async () => {
        fireEvent.click(
          screen.getByRole('button', { name: 'Add to favourites' }),
        );
      });
      await act(async () => {});
      expect(
        screen.getByRole('button', { name: 'Add to favourites' }),
      ).toBeInTheDocument();
      expect(
        screen.queryByRole('button', { name: 'Remove from favourites' }),
      ).toBeNull();
    });
  });

  describe('switching security', () => {
    it('offers no caret when there is nothing else to switch to', async () => {
      mockGetSecurities.mockResolvedValue([security]);
    mockGetSecurityDocuments.mockResolvedValue([]);
    mockGetSecurityNews.mockResolvedValue({ provider: 'yahoo', items: [] });
      await renderPage();
      expect(
        screen.queryByRole('button', { name: 'Switch to another security' }),
      ).toBeNull();
    });

    it('navigates straight to another security', async () => {
      mockGetSecurities.mockResolvedValue([
        security,
        { ...security, id: 'sec-2', symbol: 'MSFT', name: 'Microsoft' },
      ]);
      await renderPage();

      await act(async () => {
        fireEvent.click(
          screen.getByRole('button', { name: 'Switch to another security' }),
        );
      });
      await act(async () => {
        fireEvent.click(screen.getByRole('menuitem', { name: /MSFT/ }));
      });

      expect(mockPush).toHaveBeenCalledWith('/securities/sec-2');
    });

    it('does not offer the security already on screen', async () => {
      mockGetSecurities.mockResolvedValue([
        security,
        { ...security, id: 'sec-2', symbol: 'MSFT', name: 'Microsoft' },
      ]);
      await renderPage();
      await act(async () => {
        fireEvent.click(
          screen.getByRole('button', { name: 'Switch to another security' }),
        );
      });
      expect(screen.queryByRole('menuitem', { name: /AAPL/ })).toBeNull();
    });
  });
});
