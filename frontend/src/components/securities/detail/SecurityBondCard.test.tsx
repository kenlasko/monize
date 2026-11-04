import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { render } from '@/test/render';
import { SecurityBondCard } from './SecurityBondCard';
import { investmentsApi } from '@/lib/investments';
import type { Security } from '@/types/investment';
import toast from 'react-hot-toast';
import type {
  BondOffer,
  OfferSeries,
  BondRateRule,
  BondRateScheduleEntry,
  BondValuation,
  SecurityBondValuation,
} from '@/types/bond';

vi.mock('@/hooks/useNumberFormat', async () => {
  const { numberFormatMockDefaults } = await import('@/test/number-format-mock');
  return {
    useNumberFormat: () => ({
      ...numberFormatMockDefaults(),
      defaultCurrency: 'PLN',
      // Like the real hook: the code when given, the default currency otherwise.
      formatCurrencyAxis: (value: number, code?: unknown) =>
        `${typeof code === 'string' ? code : 'DEFAULT'} ${value}`,
    }),
  };
});
vi.mock('@/hooks/useFinancialToday', () => ({
  useFinancialToday: () => '2027-04-15',
}));
vi.mock('@/lib/investments', () => ({
  investmentsApi: {
    getSecurityBondValuation: vi.fn(),
    getSecurityBondScenarios: vi.fn(),
    recomputeSecurityBondPrices: vi.fn(),
    getBondOffer: vi.fn(),
    getBondHistory: vi.fn(),
    updateSecurity: vi.fn(),
  },
}));
vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }: any) => <div>{children}</div>,
  BarChart: ({ children, data }: any) => (
    <div data-testid="bar-chart" data-points={data.length}>
      {children}
    </div>
  ),
  Bar: ({ name, fill, children }: any) => (
    <div data-testid="bar" data-name={name} data-fill={fill}>
      {children}
    </div>
  ),
  Cell: ({ fillOpacity }: any) => <i data-testid="cell" data-opacity={fillOpacity} />,
  XAxis: () => null,
  YAxis: ({ tickFormatter }: any) =>
    tickFormatter ? <span data-testid="y-tick">{tickFormatter(100, 0)}</span> : null,
  CartesianGrid: () => null,
  // Only a render-function tooltip is drawn (the history charts); recharts hands
  // it the hovered point, which this stands in for.
  Tooltip: ({ content }: any) =>
    typeof content === 'function' ? (
      <div data-testid="chart-tooltip">
        {content({
          active: true,
          label: '2026-10',
          payload: [{ name: 'Series', value: 4.4, color: '#123456' }],
        })}
      </div>
    ) : null,
  Legend: () => null,
  LineChart: ({ children }: any) => <div data-testid="line-chart">{children}</div>,
  Line: ({ name }: any) => <i data-testid="line" data-name={name} />,
  ReferenceDot: ({ x, y }: any) => <i data-testid="held-dot" data-x={x} data-y={y} />,
}));
vi.mock('react-hot-toast', () => ({
  default: { success: vi.fn(), error: vi.fn() },
}));

const security = {
  id: 'sec-1',
  symbol: 'TOS1029',
  name: 'TOS1029',
  currencyCode: 'PLN',
  bondProgramId: 'prog-1',
  bondAutoFetch: false,
} as Security;

function lotValuation(overrides: Partial<BondValuation> = {}): BondValuation {
  return {
    asOf: '2027-04-15',
    status: 'OPEN',
    refusal: null,
    seriesCode: 'TOS1029',
    termsVersion: 1,
    quantity: 10,
    maturityDate: '2029-10-01',
    currentPeriod: {
      index: 2,
      start: '2027-01-01',
      end: '2027-12-31',
      annualRate: '0.0440',
      rateSource: 'ANNOUNCED',
    },
    rateRule: {
      type: 'FIXED',
      benchmarkId: null,
      annualRate: '0.0440',
      firstPeriodRate: null,
      addend: null,
      benchmarkFloor: null,
    },
    rateSchedule: [],
    principal: '103.5000',
    accruedInterest: '55.2000',
    grossValue: '1090.2000',
    earlyRedemptionValue: '1085.2000',
    earlyRedemptionRefusal: null,
    knownCashflows: [
      { date: '2027-12-31', type: 'INTEREST', amount: '45.00', status: 'KNOWN', period: 2 },
    ],
    projectedCashflows: [],
    nextPayment: [
      { date: '2027-12-31', type: 'INTEREST', amount: '45.00', status: 'KNOWN', period: 2 },
    ],
    nextRateReset: null,
    nextCapitalization: null,
    maturityValueKnown: '1200.0000',
    maturityValueProjected: null,
    projectionAssumptions: [],
    dataCompleteness: {
      termsComplete: true,
      referenceDataComplete: true,
      earlyRedemptionTermsComplete: true,
    },
    missing: [],
    projectionMissing: [],
    valuationComplete: true,
    ...overrides,
  };
}

function response(
  overrides: Partial<SecurityBondValuation> = {},
): SecurityBondValuation {
  return {
    securityId: 'sec-1',
    program: {
      id: 'prog-1',
      programCode: 'RETAIL',
      issuerCountryCode: 'PL',
      issuerCode: 'PL_MF',
      currency: 'PLN',
    },
    autoFetch: false,
    series: [
      { instrumentId: 'bond-1', seriesCode: 'TOS1029', programCode: 'RETAIL', redemptionTerms: null },
    ],
    asOf: '2027-04-15',
    lots: [
      { instrumentId: 'bond-1', purchaseDate: '2026-10-05', quantity: 10, purchaseDateAssumed: false, valuation: lotValuation() },
    ],
    totals: {
      quantity: 10,
      grossValue: '1090.2000',
      earlyRedemptionValue: '1085.2000',
      accruedInterest: '55.2000',
    },
    refusal: null,
    ...overrides,
  };
}

/** The one series of the default response, with fields overridden. */
function oneSeries(
  over: Partial<SecurityBondValuation['series'][number]> = {},
): SecurityBondValuation['series'] {
  return [
    { instrumentId: 'bond-1', seriesCode: 'TOS1029', programCode: 'RETAIL', redemptionTerms: null, ...over },
  ];
}

const get = vi.mocked(investmentsApi.getSecurityBondValuation);
const recompute = vi.mocked(investmentsApi.recomputeSecurityBondPrices);
const scenarios = vi.mocked(investmentsApi.getSecurityBondScenarios);
const getOffer = vi.mocked(investmentsApi.getBondOffer);
const getHistory = vi.mocked(investmentsApi.getBondHistory);

/** The program total under the series rows: the cell of a column. */
const TOTAL_COLUMN = { quantity: 1, gross: 3, accrued: 4, early: 5 } as const;
function totalCell(column: keyof typeof TOTAL_COLUMN): HTMLElement {
  const row = screen.getByText('Bond kind total').closest('tr') as HTMLElement;
  return within(row).getAllByRole('cell')[TOTAL_COLUMN[column]];
}

/** The per-lot table of an opened series (the one with the principal column). */
function lotRows(): HTMLElement[] {
  // The series table holds the lots table in its opened row: take the inner one.
  const table = screen
    .getAllByRole('table')
    .find(
      (t) => t.querySelector('table') === null && within(t).queryByText('Principal per bond') !== null,
    ) as HTMLElement;
  return within(table).getAllByRole('row');
}

/** Opens every series row, so the per-lot detail the older cases read is on screen. */
async function expandAll() {
  for (const button of screen.queryAllByRole('button', { name: /^Show details of / })) {
    await act(async () => {
      fireEvent.click(button);
    });
  }
}

async function mountCollapsed(onPricesChanged?: () => void) {
  await act(async () => {
    render(<SecurityBondCard security={security} onPricesChanged={onPricesChanged} />);
  });
}

async function mount(onPricesChanged?: () => void) {
  await mountCollapsed(onPricesChanged);
  await expandAll();
}

describe('SecurityBondCard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    get.mockResolvedValue(response());
    recompute.mockResolvedValue({ written: 3, deleted: 0 });
    getOffer.mockResolvedValue({ countryCode: 'PL', today: '2027-04-15', series: [] });
    getHistory.mockResolvedValue({ countryCode: 'PL', programs: [] });
    scenarios.mockResolvedValue({
      securityId: 'sec-1',
      benchmarkId: 'PL_CPI_GUS_YOY',
      asOf: '2027-04-15',
      refusal: null,
      scenarios: [],
    });
  });

  it('asks for the valuation on the financial today and renders totals and lots', async () => {
    await mount();
    expect(get).toHaveBeenCalledWith('sec-1', '2027-04-15', undefined);
    const gross = totalCell('gross');
    expect(gross).toHaveTextContent('$1,090.20');
    const row = lotRows()[1];
    expect(within(row).getByText('4.4%')).toBeInTheDocument();
    expect(within(row).getByText('Announced')).toBeInTheDocument();
    expect(within(row).getByText('$1,085.20')).toBeInTheDocument();
    expect(within(row).getByText('Interest $45.00 on 12/31/2027')).toBeInTheDocument();
    expect(within(row).getByText(/Known\s+\$1,200\.00/)).toBeInTheDocument();
  });

  it('links the terms document when the terms were read from the official source', async () => {
    get.mockResolvedValue(
      response({
        series: oneSeries({
          termsSource: {
            provider: 'obligacjeskarbowe.pl',
            url: 'https://www.obligacjeskarbowe.pl/oferta/edo1136',
            document: 'List emisyjny nr 5/2026',
          },
        }),
      }),
    );
    await mount();
    const link = screen.getByRole('link', { name: 'Terms: List emisyjny nr 5/2026' });
    expect(link).toHaveAttribute('href', 'https://www.obligacjeskarbowe.pl/oferta/edo1136');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('does not make a non-http terms address a link', async () => {
    get.mockResolvedValue(
      response({
        series: oneSeries({
          termsSource: { provider: 'obligacjeskarbowe.pl', url: 'javascript:alert(1)', document: 'Doc' },
        }),
      }),
    );
    await mount();
    expect(screen.getByText('Terms: Doc')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Terms/ })).not.toBeInTheDocument();
  });

  it('notes hand-entered terms without a link', async () => {
    get.mockResolvedValue(
      response({ series: oneSeries({ termsSource: { provider: 'manual', url: '', document: 'x' } }) }),
    );
    await mount();
    expect(screen.getByText('Terms entered by hand by an administrator')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Terms/ })).not.toBeInTheDocument();
  });

  it('shows no terms source for an older payload without one', async () => {
    await mount();
    expect(screen.queryByText(/^Terms: /)).not.toBeInTheDocument();
  });

  it('renders a null total as unknown with its reason, never as zero', async () => {
    get.mockResolvedValue(
      response({
        totals: { quantity: 10, grossValue: null, earlyRedemptionValue: null, accruedInterest: '55.2000' },
        lots: [
          {
            instrumentId: 'bond-1', purchaseDate: '2026-10-05',
            quantity: 10,
            purchaseDateAssumed: true,
            // The period is known, so only the two money cells can read Unknown.
            valuation: lotValuation({
              grossValue: null,
              principal: null,
              earlyRedemptionValue: null,
              earlyRedemptionRefusal: 'RATE_UNKNOWN',
            }),
          },
        ],
      }),
    );
    await mount();
    const gross = totalCell('gross');
    expect(gross).toHaveTextContent('Unknown');
    expect(gross).toHaveTextContent('At least one lot has no figure');
    expect(gross).not.toHaveTextContent('$0.00');
    expect(screen.getByText('Assumed')).toBeInTheDocument();
    const row = lotRows()[1];
    const cells = within(row).getAllByRole('cell');
    // Columns: purchase, quantity, maturity, period, rate, principal, accrued, gross, early, next, maturity value.
    expect(cells[5]).toHaveTextContent('Unknown');
    expect(cells[7]).toHaveTextContent('Unknown');
    expect(cells[3]).not.toHaveTextContent('Unknown');
    expect(row).not.toHaveTextContent('$0.00');
  });

  it('shows the early redemption refusal reason in place of a value', async () => {
    get.mockResolvedValue(
      response({
        lots: [
          {
            instrumentId: 'bond-1', purchaseDate: '2027-04-10',
            quantity: 10,
            purchaseDateAssumed: false,
            valuation: lotValuation({
              earlyRedemptionValue: null,
              earlyRedemptionRefusal: 'TOO_EARLY',
            }),
          },
        ],
      }),
    );
    await mount();
    expect(screen.getByText('Too early to redeem')).toBeInTheDocument();
  });

  it('lists assumptions once and the missing data with its publisher', async () => {
    const v = lotValuation({
      projectionAssumptions: [
        { benchmarkId: 'WIBOR_6M', value: '0.0510', basis: 'SUPPLIED', observation: null },
        { benchmarkId: 'CPI_YOY', value: '0.0290', basis: 'LATEST_OBSERVATION', observation: '2026-08' },
      ],
      missing: [
        { benchmarkId: 'CPI_YOY', observation: '2027-02', publisher: 'GUS' },
        { benchmarkId: 'NBP_REF', observation: '2027-03-01', publisher: null },
      ],
      currentPeriod: { index: 3, start: '2027-01-01', end: '2027-12-31', annualRate: '0.0510', rateSource: 'PROJECTED' },
    });
    get.mockResolvedValue(
      response({
        lots: [
          { instrumentId: 'bond-1', purchaseDate: '2026-10-05', quantity: 5, purchaseDateAssumed: false, valuation: v },
          { instrumentId: 'bond-1', purchaseDate: '2026-11-05', quantity: 5, purchaseDateAssumed: false, valuation: v },
        ],
      }),
    );
    await mount();
    // An id without a translated name is shown as is; a monthly key stays YYYY-MM.
    expect(screen.getAllByText('WIBOR_6M assumed at 5.1% for every later period')).toHaveLength(1);
    expect(
      screen.getAllByText(
        'CPI_YOY assumed at 2.9% for every later period, the latest published value (2026-08)',
      ),
    ).toHaveLength(1);
    expect(screen.getAllByText('CPI_YOY 2027-02 — published by GUS')).toHaveLength(1);
    // A step-series day is formatted by the reader's date preference.
    expect(screen.getByText('NBP_REF 03/01/2027 — publisher not known')).toBeInTheDocument();
    expect(screen.getAllByText('Projected').length).toBeGreaterThan(0);
  });

  it('shows translated benchmark names and localized dates in the assumptions and missing lists', async () => {
    get.mockResolvedValue(
      response({
        lots: [
          {
            instrumentId: 'bond-1', purchaseDate: '2026-10-05',
            quantity: 5,
            purchaseDateAssumed: false,
            valuation: lotValuation({
              projectionAssumptions: [
                { benchmarkId: 'PL_NBP_REFERENCE', value: '0.0425', basis: 'LATEST_OBSERVATION', observation: '2026-10-19' },
              ],
              missing: [
                { benchmarkId: 'PL_NBP_REFERENCE', observation: '2026-10-19', publisher: 'NBP' },
                { benchmarkId: 'PL_CPI_GUS_YOY', observation: '2027-02', publisher: 'GUS' },
              ],
            }),
          },
        ],
      }),
    );
    await mount();
    expect(
      screen.getByText(
        'NBP reference rate assumed at 4.25% for every later period, the latest published value (10/19/2026)',
      ),
    ).toBeInTheDocument();
    expect(screen.getByText('NBP reference rate 10/19/2026 — published by NBP')).toBeInTheDocument();
    expect(screen.getByText('CPI, 12 months (GUS) 2027-02 — published by GUS')).toBeInTheDocument();
    expect(screen.queryByText(/PL_NBP_REFERENCE|PL_CPI_GUS_YOY/)).not.toBeInTheDocument();
  });

  it('renders a lots refusal with its detail and unknown totals', async () => {
    get.mockResolvedValue(
      response({
        lots: [],
        totals: { quantity: null, grossValue: null, earlyRedemptionValue: null, accruedInterest: null },
        refusal: {
          code: 'OVER_REMOVAL',
          detail: 'English server text that must not be shown',
          params: { action: 'SELL', date: '2027-01-05', quantity: '12' },
        },
      }),
    );
    await mount();
    expect(screen.getByText(/more bonds were removed than were held/)).toBeInTheDocument();
    // Composed on the client from code and params: translated action, the reader's date.
    expect(screen.getByText('Sell on 01/05/2027 removes 12 bonds, more than were held.')).toBeInTheDocument();
    expect(screen.queryByText(/English server text/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Show details of / })).not.toBeInTheDocument();
    expect(screen.getAllByText('Unknown').length).toBe(4);
  });

  it.each([
    [
      'SPLIT',
      { action: 'SPLIT', date: '2027-03-04', quantity: '2' },
      'A split (Split on 03/04/2027) is recorded on this security; a bond does not split.',
    ],
    [
      'FRACTIONAL_QUANTITY',
      { action: 'SELL', date: '2027-03-04', quantity: '1.5' },
      'Sell on 03/04/2027 moves 1.5 bonds, which is not a whole number.',
    ],
    [
      'INVALID_QUANTITY',
      { action: 'BUY', date: '2027-03-04', quantity: null },
      'The quantity of Buy on 03/04/2027 is missing, negative or too large.',
    ],
  ] as const)('renders the %s refusal only from its code and params', async (code, params, text) => {
    get.mockResolvedValue(
      response({
        lots: [],
        totals: { quantity: null, grossValue: null, earlyRedemptionValue: null, accruedInterest: null },
        refusal: { code, detail: 'raw server English', params },
      }),
    );
    await mount();
    expect(screen.getByText(text)).toBeInTheDocument();
    expect(screen.queryByText('raw server English')).not.toBeInTheDocument();
  });

  it('shows an error state, not an empty valuation, when the request fails', async () => {
    get.mockRejectedValue(new Error('boom'));
    await mount();
    expect(screen.getByRole('alert')).toHaveTextContent('boom');
    expect(screen.queryByText('Bond kind total')).not.toBeInTheDocument();
    expect(screen.queryByText('$0.00')).not.toBeInTheDocument();
  });

  it('recomputes, refetches and tells the page to re-read prices', async () => {
    const onPricesChanged = vi.fn();
    await mount(onPricesChanged);
    expect(get).toHaveBeenCalledTimes(1);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Recalculate prices' }));
    });
    expect(recompute).toHaveBeenCalledWith('sec-1');
    await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
    expect(onPricesChanged).toHaveBeenCalledTimes(1);
  });

  it('does not refetch or notify when the recompute fails', async () => {
    recompute.mockRejectedValue(new Error('nope'));
    const onPricesChanged = vi.fn();
    await mount(onPricesChanged);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Recalculate prices' }));
    });
    expect(get).toHaveBeenCalledTimes(1);
    expect(onPricesChanged).not.toHaveBeenCalled();
  });

  describe('as-of date', () => {
    const changeDate = (value: string) => {
      const input = screen.getByLabelText('Valued on');
      fireEvent.change(input, { target: { value } });
      fireEvent.blur(input);
    };

    it('refetches for the picked day and hides the previous day while it loads', async () => {
      await mount();
      expect(totalCell('gross')).toHaveTextContent('$1,090.20');
      let resolveSecond!: (value: SecurityBondValuation) => void;
      get.mockReturnValueOnce(new Promise((resolve) => (resolveSecond = resolve)));
      await act(async () => {
        changeDate('03/30/2027');
      });
      expect(get).toHaveBeenLastCalledWith('sec-1', '2027-03-30', undefined);
      // Day A's figures are not shown under day B's label while B is pending.
      expect(screen.getByText('Loading the bond valuation...')).toBeInTheDocument();
      expect(screen.queryByText('$1,090.20')).not.toBeInTheDocument();
      expect(screen.queryByText('Bond kind total')).not.toBeInTheDocument();

      await act(async () => {
        resolveSecond(
          response({
            asOf: '2027-03-30',
            totals: { quantity: 10, grossValue: '1111.1100', earlyRedemptionValue: null, accruedInterest: '1.00' },
          }),
        );
      });
      expect(totalCell('gross')).toHaveTextContent('$1,111.11');
    });

    it('falls back to the financial today when the date is cleared', async () => {
      await mount();
      await act(async () => {
        changeDate('03/30/2027');
      });
      expect(get).toHaveBeenLastCalledWith('sec-1', '2027-03-30', undefined);
      await act(async () => {
        changeDate('');
      });
      expect(get).toHaveBeenLastCalledWith('sec-1', '2027-04-15', undefined);
    });
  });

  describe('lots table branches', () => {
    const flow = (
      over: Partial<BondValuation['knownCashflows'][number]> &
        Pick<BondValuation['knownCashflows'][number], 'date' | 'type' | 'amount'>,
    ) => ({ status: 'KNOWN' as const, period: 1, ...over });
    const mountLot = async (valuation: Partial<BondValuation>) => {
      get.mockResolvedValue(
        response({
          lots: [
            { instrumentId: 'bond-1', purchaseDate: '2026-10-05', quantity: 10, purchaseDateAssumed: false, valuation: lotValuation(valuation) },
          ],
        }),
      );
      await mount();
      return within(lotRows()[1]).getAllByRole('cell');
    };

    it('shows the engine\'s next payment, not a date derived from the cash flow lists', async () => {
      const cells = await mountLot({
        knownCashflows: [flow({ date: '2027-12-31', type: 'INTEREST', amount: '45.00' })],
        projectedCashflows: [flow({ date: '2027-09-30', type: 'INTEREST', amount: '12.00', status: 'PROJECTED' })],
        nextPayment: [flow({ date: '2027-03-30', type: 'INTEREST', amount: '7.00' })],
      });
      expect(cells[9]).toHaveTextContent('Interest $7.00 on 03/30/2027');
      expect(cells[9]).not.toHaveTextContent('09/30/2027');
      expect(cells[9]).not.toHaveTextContent('12/31/2027');
    });

    it('shows a projected next payment with the Projected badge', async () => {
      const cells = await mountLot({
        nextPayment: [flow({ date: '2027-09-30', type: 'INTEREST', amount: '12.00', status: 'PROJECTED' })],
      });
      expect(cells[9]).toHaveTextContent('Interest $12.00 on 09/30/2027');
      expect(within(cells[9]).getByText('Projected')).toBeInTheDocument();
    });

    it('shows the coupon and the principal paid on the same day, each labelled', async () => {
      const cells = await mountLot({
        nextPayment: [
          flow({ date: '2027-07-05', type: 'INTEREST', amount: '5.00' }),
          flow({ date: '2027-07-05', type: 'PRINCIPAL', amount: '1000.00' }),
        ],
      });
      const lines = Array.from(cells[9].children).map((c) => c.textContent);
      expect(lines).toEqual(['Interest $5.00 on 07/05/2027', 'Principal $1,000.00 on 07/05/2027']);
    });

    it('keeps a projected coupon visible beside a known principal on the same day', async () => {
      const cells = await mountLot({
        nextPayment: [
          flow({ date: '2027-07-05', type: 'INTEREST', amount: '5.00', status: 'PROJECTED' }),
          flow({ date: '2027-07-05', type: 'PRINCIPAL', amount: '1000.00' }),
        ],
      });
      expect(cells[9]).toHaveTextContent('Interest $5.00 on 07/05/2027');
      expect(cells[9]).toHaveTextContent('Principal $1,000.00 on 07/05/2027');
      expect(within(cells[9]).getAllByText('Projected')).toHaveLength(1);
    });

    it('shows the projected maturity value on its own line', async () => {
      const cells = await mountLot({ maturityValueKnown: null, maturityValueProjected: '1350.0000' });
      expect(cells[10]).toHaveTextContent(/Known\s+Unknown/);
      expect(cells[10]).toHaveTextContent(/Projected\s+\$1,350\.00/);
    });

    it('reads Unknown when an early redemption has neither a value nor a refusal', async () => {
      const cells = await mountLot({ earlyRedemptionValue: null, earlyRedemptionRefusal: null });
      expect(cells[8]).toHaveTextContent('Unknown');
      expect(cells[8]).not.toHaveTextContent('$0.00');
    });

    it('shows None and Matured for a matured lot with no flows left', async () => {
      const cells = await mountLot({
        knownCashflows: [],
        projectedCashflows: [],
        nextPayment: [],
        earlyRedemptionValue: null,
        earlyRedemptionRefusal: 'MATURED',
      });
      expect(cells[9]).toHaveTextContent('None');
      expect(cells[8]).toHaveTextContent('Matured');
    });

    it('says no lots are open, with known zero totals, when there are none and no refusal', async () => {
      get.mockResolvedValue(
        response({
          lots: [],
          totals: { quantity: 0, grossValue: '0.0000', earlyRedemptionValue: '0.0000', accruedInterest: '0.0000' },
        }),
      );
      await mount();
      expect(screen.getByText('No lots are open on this date.')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /^Show details of / })).not.toBeInTheDocument();
      expect(totalCell('gross')).toHaveTextContent('$0.00');
      expect(totalCell('gross')).not.toHaveTextContent('Unknown');
    });
  });

  describe('early redemption terms and the next rate reset and capitalization', () => {
    const terms = (
      over: Partial<NonNullable<SecurityBondValuation['series'][number]['redemptionTerms']>> = {},
    ): NonNullable<SecurityBondValuation['series'][number]['redemptionTerms']> => ({
      type: 'ON_DEMAND',
      earliestDaysAfterPurchase: 7,
      latestDaysBeforeMaturity: 20,
      blackouts: [],
      penalties: [{ type: 'FIXED_FEE_PER_UNIT', amount: '3.00' }],
      proceedsFloor: { type: 'FACE_VALUE', appliesTo: 'ALL_PERIODS' },
      ...over,
    });
    const mountTerms = async (
      redemptionTerms: SecurityBondValuation['series'][number]['redemptionTerms'],
      valuation: Partial<BondValuation> = {},
    ) => {
      get.mockResolvedValue(
        response({
          series: oneSeries({ redemptionTerms }),
          lots: [
            { instrumentId: 'bond-1', purchaseDate: '2026-10-05', quantity: 10, purchaseDateAssumed: false, valuation: lotValuation(valuation) },
          ],
        }),
      );
      await mount();
    };

    // The terms are also summarized under "The program"; these cases read the
    // series' own block, inside its opened row.
    const seriesTerms = () =>
      within(screen.getByText('Early redemption terms').parentElement as HTMLElement);

    it('shows the fixed fee per bond in the bond currency and the face value floor in every period', async () => {
      await mountTerms(terms());
      expect(screen.getByText('Early redemption terms')).toBeInTheDocument();
      expect(seriesTerms().getByText('Early redemption fee: $3.00 per bond.')).toBeInTheDocument();
      expect(
        seriesTerms().getByText('In every period, the fee never reduces the proceeds below the face value.'),
      ).toBeInTheDocument();
    });

    it('says the floor holds in the first period only', async () => {
      await mountTerms(terms({ proceedsFloor: { type: 'FACE_VALUE', appliesTo: 'FIRST_PERIOD' } }));
      expect(seriesTerms().getByText(/In the first period only/)).toBeInTheDocument();
      expect(seriesTerms().queryByText(/In every period/)).not.toBeInTheDocument();
    });

    it('says the accrued interest is forfeited, and shows no floor line without a floor', async () => {
      await mountTerms(
        terms({ penalties: [{ type: 'FORFEIT_ACCRUED_SINCE_LAST_PAYMENT' }], proceedsFloor: null }),
      );
      expect(
        seriesTerms().getByText(
          'On early redemption, the interest accrued in the current period is forfeited.',
        ),
      ).toBeInTheDocument();
      expect(seriesTerms().queryByText(/face value/)).not.toBeInTheDocument();
      expect(seriesTerms().queryByText(/Early redemption fee/)).not.toBeInTheDocument();
    });

    it('shows no redemption terms for a bond redeemable at maturity only', async () => {
      await mountTerms(null);
      expect(screen.queryByText('Early redemption terms')).not.toBeInTheDocument();
    });

    it('shows the next rate reset and capitalization dates of a lot, and hides a null one', async () => {
      await mountTerms(null, { nextRateReset: '2028-10-01', nextCapitalization: '2027-12-31' });
      expect(screen.getByText('Next rate reset: 10/01/2028')).toBeInTheDocument();
      expect(screen.getByText('Next capitalization: 12/31/2027')).toBeInTheDocument();
    });

    it('hides the rows when the dates are null', async () => {
      await mountTerms(null, { nextRateReset: null, nextCapitalization: '2027-12-31' });
      expect(screen.queryByText(/Next rate reset/)).not.toBeInTheDocument();
      expect(screen.getByText(/Next capitalization/)).toBeInTheDocument();
    });
  });

  describe('interest rate section', () => {
    const CPI = 'PL_CPI_GUS_YOY';
    const edoRule: BondRateRule = {
      type: 'INFLATION_PLUS_MARGIN_AS_RATE',
      benchmarkId: CPI,
      annualRate: null,
      firstPeriodRate: '0.0535',
      addend: '0.0200',
      benchmarkFloor: '0',
    };
    const entry = (
      over: Partial<BondRateScheduleEntry> & Pick<BondRateScheduleEntry, 'index'>,
    ): BondRateScheduleEntry => ({
      start: '2027-10-01',
      end: '2028-10-01',
      annualRate: null,
      rateSource: null,
      benchmark: null,
      addend: null,
      interest: null,
      fixedPart: null,
      benchmarkPart: null,
      addendPart: null,
      announcedPart: null,
      ...over,
    });
    const edoSchedule: BondRateScheduleEntry[] = [
      entry({ index: 1, start: '2026-10-01', end: '2027-10-01', annualRate: '0.0535', rateSource: 'TERMS' }),
      entry({
        index: 2,
        annualRate: '0.0540',
        rateSource: 'DERIVED',
        benchmark: { benchmarkId: CPI, observation: '2027-08', value: '0.0340', flooredValue: '0.0340' },
        addend: '0.0200',
      }),
      entry({
        index: 3,
        annualRate: '0.0200',
        rateSource: 'DERIVED',
        benchmark: { benchmarkId: CPI, observation: '2028-08', value: '-0.0050', flooredValue: '0.0000' },
        addend: '0.0200',
      }),
      entry({
        index: 4,
        annualRate: '0.0500',
        rateSource: 'PROJECTED',
        benchmark: { benchmarkId: CPI, observation: '2029-08', value: '0.0300', flooredValue: '0.0300' },
        addend: '0.0200',
      }),
      entry({
        index: 5,
        annualRate: null,
        benchmark: { benchmarkId: CPI, observation: '2030-08', value: null, flooredValue: null },
        addend: '0.0200',
      }),
    ];

    async function mountWith(valuation: Partial<BondValuation>) {
      get.mockResolvedValue(
        response({
          lots: [
            { instrumentId: 'bond-1', purchaseDate: '2026-10-01', quantity: 10, purchaseDateAssumed: false, valuation: lotValuation(valuation) },
          ],
        }),
      );
      await mount();
      const heading = screen.getByRole('heading', { name: 'Interest rate' });
      return heading.parentElement as HTMLElement;
    }

    it('says an inflation bond is CPI plus a margin, with the floor', async () => {
      const section = await mountWith({ rateRule: edoRule, rateSchedule: edoSchedule });
      expect(
        within(section).getByText('Period 1: 5.35%. Then CPI, 12 months (GUS) + 2%'),
      ).toBeInTheDocument();
      expect(
        within(section).getByText('A negative CPI, 12 months (GUS) counts as 0'),
      ).toBeInTheDocument();
    });

    it('omits the period 1 sentence when there is no first-period rate and no floor', async () => {
      const section = await mountWith({
        rateRule: { ...edoRule, firstPeriodRate: null, benchmarkFloor: null },
      });
      expect(
        within(section).getByText('Every period: CPI, 12 months (GUS) + 2%'),
      ).toBeInTheDocument();
      expect(within(section).queryByText(/Period 1/)).not.toBeInTheDocument();
      expect(within(section).queryByText(/counts as 0/)).not.toBeInTheDocument();
    });

    it('shows a fixed rate for the whole term', async () => {
      const section = await mountWith({});
      expect(within(section).getByText('Fixed 4.4% for the whole term')).toBeInTheDocument();
    });

    it('falls back to the raw benchmark id when it has no translated name', async () => {
      const section = await mountWith({
        rateRule: { ...edoRule, benchmarkId: 'XX_UNKNOWN_INDEX' },
      });
      expect(
        within(section).getByText('Period 1: 5.35%. Then XX_UNKNOWN_INDEX + 2%'),
      ).toBeInTheDocument();
    });

    it('lists every period with its rate, source and how it was set', async () => {
      const section = await mountWith({
        rateRule: edoRule,
        rateSchedule: edoSchedule,
        currentPeriod: { index: 2, start: '2027-10-01', end: '2028-10-01', annualRate: '0.0540', rateSource: 'DERIVED' },
      });
      const rows = within(section).getAllByRole('row');
      expect(rows).toHaveLength(1 + edoSchedule.length);

      // TERMS: the stated rate, no benchmark.
      expect(within(rows[1]).getByText('5.35%')).toBeInTheDocument();
      expect(within(rows[1]).getByText('Terms')).toBeInTheDocument();
      expect(within(rows[1]).getByText('Stated rate')).toBeInTheDocument();

      // DERIVED: the observation, its value and the margin; the current period.
      expect(within(rows[2]).getByText('5.4%')).toBeInTheDocument();
      expect(
        within(rows[2]).getByText('CPI, 12 months (GUS) 2027-08: 3.4% + 2%'),
      ).toBeInTheDocument();
      expect(rows[2]).toHaveAttribute('aria-current', 'true');
      expect(within(rows[2]).getByText('Current')).toBeInTheDocument();
      expect(rows[1]).not.toHaveAttribute('aria-current');

      // Floored: both the observed and the floored values are said.
      expect(
        within(rows[3]).getByText('CPI, 12 months (GUS) 2028-08: -0.5% + 2%'),
      ).toBeInTheDocument();
      expect(within(rows[3]).getByText('(floored to 0%)')).toBeInTheDocument();
      expect(within(rows[3]).getByText('2%')).toBeInTheDocument();

      // PROJECTED: the assumed value and the projected badge.
      expect(
        within(rows[4]).getByText('CPI, 12 months (GUS) 2029-08: 3% + 2%'),
      ).toBeInTheDocument();
      expect(within(rows[4]).getAllByText('Projected')).toHaveLength(2);

      // Missing: no rate, no source, the observation that is awaited.
      expect(
        within(rows[5]).getByText('CPI, 12 months (GUS) 2030-08: not published yet'),
      ).toBeInTheDocument();
      expect(within(rows[5]).getAllByText('Unknown')).toHaveLength(2);
    });

    it('formats a step-series observation day as a date', async () => {
      const section = await mountWith({
        rateRule: { ...edoRule, type: 'BENCHMARK_PLUS_SPREAD', benchmarkId: 'PL_NBP_REFERENCE', firstPeriodRate: null, benchmarkFloor: null },
        rateSchedule: [
          entry({
            index: 1,
            annualRate: '0.0475',
            rateSource: 'DERIVED',
            benchmark: { benchmarkId: 'PL_NBP_REFERENCE', observation: '2026-10-19', value: '0.0425', flooredValue: '0.0425' },
            addend: '0.0050',
          }),
        ],
      });
      expect(
        within(section).getByText('NBP reference rate 10/19/2026: 4.25% + 0.5%'),
      ).toBeInTheDocument();
    });

    it('labels each lot when there are several', async () => {
      get.mockResolvedValue(
        response({
          lots: [
            { instrumentId: 'bond-1', purchaseDate: '2026-10-01', quantity: 5, purchaseDateAssumed: false, valuation: lotValuation() },
            { instrumentId: 'bond-1', purchaseDate: '2026-11-05', quantity: 5, purchaseDateAssumed: false, valuation: lotValuation() },
          ],
        }),
      );
      await mount();
      expect(screen.getByText('Lot purchased 10/01/2026')).toBeInTheDocument();
      expect(screen.getByText('Lot purchased 11/05/2026')).toBeInTheDocument();
    });
  });
});

describe('SecurityBondCard: indexation, scenarios and the interest chart (spec 13.1 to 13.4)', () => {
  const CPI = 'PL_CPI_GUS_YOY';
  const rule = (over: Partial<BondRateRule> = {}): BondRateRule => ({
    type: 'INFLATION_PLUS_MARGIN_AS_RATE',
    benchmarkId: CPI,
    annualRate: null,
    firstPeriodRate: '0.0535',
    addend: '0.0200',
    benchmarkFloor: '0',
    ...over,
  });
  const period = (
    index: number,
    over: Partial<BondRateScheduleEntry> = {},
  ): BondRateScheduleEntry => ({
    index,
    start: `${2025 + index}-10-01`,
    end: `${2026 + index}-10-01`,
    annualRate: '0.0540',
    rateSource: 'DERIVED',
    benchmark: null,
    addend: '0.0200',
    interest: '0',
    fixedPart: '0',
    benchmarkPart: '0',
    addendPart: '0',
    announcedPart: '0',
    ...over,
  });
  // Per bond, computed independently with python fractions (EDO1036).
  const schedule: BondRateScheduleEntry[] = [
    period(1, {
      rateSource: 'TERMS',
      addend: null,
      interest: '5.35',
      fixedPart: '5.35',
    }),
    period(2, { interest: '5.6889', benchmarkPart: '3.5819', addendPart: '2.107' }),
    period(3, {
      rateSource: 'PROJECTED',
      interest: '7.772723',
      benchmarkPart: '5.551945',
      addendPart: '2.220778',
    }),
    period(4, {
      annualRate: null,
      rateSource: null,
      interest: null,
      fixedPart: null,
      benchmarkPart: null,
      addendPart: null,
      announcedPart: null,
    }),
  ];
  const assumption = {
    benchmarkId: CPI,
    value: '0.0500',
    basis: 'SUPPLIED' as const,
    observation: null,
  };
  const scenarioRows = [
    { value: '0', maturityValue: '1301.00', totalInterest: '301.00', fixedInterest: '53.50', benchmarkInterest: '35.82', addendInterest: '211.68', announcedInterest: '0.00' },
    { value: '0.025', maturityValue: '1500.00', totalInterest: null, fixedInterest: '53.50', benchmarkInterest: null, addendInterest: null, announcedInterest: null },
    { value: '0.05', maturityValue: '1907.90', totalInterest: '907.86', fixedInterest: '53.50', benchmarkInterest: '605.44', addendInterest: '248.92', announcedInterest: '0.00' },
    { value: '0.08', maturityValue: '2400.00', totalInterest: '1400.00', fixedInterest: '53.50', benchmarkInterest: '900.00', addendInterest: '300.00', announcedInterest: '0.00' },
  ];

  function withLots(valuation: Partial<BondValuation>, purchaseDates = ['2026-10-01']) {
    get.mockResolvedValue(
      response({
        lots: purchaseDates.map((purchaseDate) => ({
          instrumentId: 'bond-1',
          purchaseDate,
          quantity: 10,
          purchaseDateAssumed: false,
          valuation: lotValuation({
            rateRule: rule(),
            rateSchedule: schedule,
            projectionAssumptions: [assumption],
            ...valuation,
          }),
        })),
      }),
    );
  }

  beforeEach(() => {
    vi.clearAllMocks();
    get.mockResolvedValue(response());
    recompute.mockResolvedValue({ written: 0, deleted: 0 });
    scenarios.mockResolvedValue({
      securityId: 'sec-1',
      benchmarkId: CPI,
      asOf: '2027-04-15',
      refusal: null,
      scenarios: scenarioRows,
    });
  });

  describe('indexation notice (13.1)', () => {
    it("says an inflation bond is indexed, from the lot's own period 2 start", async () => {
      withLots({}, ['2026-10-01', '2026-11-05']);
      await mount();
      const notes = screen.getAllByRole('note');
      expect(notes).toHaveLength(2);
      expect(notes[0]).toHaveTextContent(
        'Inflation-indexed: from 10/01/2027 (period 2) the rate is CPI, 12 months (GUS) + 2%, recalculated every period',
      );
    });

    it('uses the floating-rate wording for a reference-rate rule', async () => {
      withLots({
        rateRule: rule({ type: 'BENCHMARK_PLUS_SPREAD', benchmarkId: 'PL_NBP_REFERENCE', addend: '0.0050' }),
      });
      await mount();
      expect(screen.getByRole('note')).toHaveTextContent(
        'Floating rate: from 10/01/2027 (period 2) the rate is NBP reference rate + 0.5%, recalculated every period',
      );
    });

    it('says nothing for a fixed rate', async () => {
      await mount();
      expect(screen.queryByRole('note')).not.toBeInTheDocument();
      expect(screen.queryByText('Inflation scenarios')).not.toBeInTheDocument();
      expect(scenarios).not.toHaveBeenCalled();
    });
  });

  describe('scenario panel (13.3)', () => {
    it('asks once for the four presets, and shows every figure, unknown ones as Unknown', async () => {
      withLots({});
      await mount();
      expect(scenarios).toHaveBeenCalledTimes(1);
      expect(scenarios).toHaveBeenCalledWith('sec-1', CPI, ['0', '0.025', '0.05', '0.08'], '2027-04-15');
      const panel = screen.getByRole('region', { name: 'Inflation scenarios' });
      expect(within(panel).getByText('Projection')).toBeInTheDocument();
      const rows = within(panel).getAllByRole('row');
      expect(rows).toHaveLength(5);
      expect(within(rows[1]).getByText('0%')).toBeInTheDocument();
      expect(within(rows[1]).getByText('$1,301.00')).toBeInTheDocument();
      expect(within(rows[3]).getByText('$907.86')).toBeInTheDocument();
      // A null is Unknown, never $0.00.
      expect(within(rows[2]).getAllByText('Unknown')).toHaveLength(3);
      expect(within(panel).getByText('Maturity value (projection)')).toBeInTheDocument();
      expect(within(panel).getByText('Interest from margin')).toBeInTheDocument();
      expect(within(panel).getByText('Interest from inflation')).toBeInTheDocument();
      expect(within(panel).getByText('Fixed interest (1st period)')).toBeInTheDocument();
    });

    it('adds the typed value to the one request, as a fraction', async () => {
      withLots({});
      await mount();
      const panel = screen.getByRole('region', { name: 'Inflation scenarios' });
      fireEvent.change(within(panel).getByLabelText('Your own CPI, 12 months (GUS) (%)'), {
        target: { value: '3.25' },
      });
      await act(async () => {
        fireEvent.click(within(panel).getByRole('button', { name: 'Add scenario' }));
      });
      expect(scenarios).toHaveBeenLastCalledWith('sec-1', CPI, ['0', '0.025', '0.05', '0.08', '0.0325'], '2027-04-15');
    });

    it('does not repeat a typed value that is a preset', async () => {
      withLots({});
      await mount();
      const panel = screen.getByRole('region', { name: 'Inflation scenarios' });
      fireEvent.change(within(panel).getByLabelText('Your own CPI, 12 months (GUS) (%)'), {
        target: { value: '2.5' },
      });
      await act(async () => {
        fireEvent.click(within(panel).getByRole('button', { name: 'Add scenario' }));
      });
      expect(scenarios).toHaveBeenCalledTimes(1);
    });

    it('clicking a row makes the valuation follow it, and the default can be restored', async () => {
      withLots({});
      await mount();
      expect(get).toHaveBeenLastCalledWith('sec-1', '2027-04-15', undefined);
      const panel = screen.getByRole('region', { name: 'Inflation scenarios' });
      await act(async () => {
        fireEvent.click(within(panel).getAllByRole('row')[3]);
      });
      expect(get).toHaveBeenLastCalledWith('sec-1', '2027-04-15', {
        benchmarkId: CPI,
        value: '0.05',
      });
      // The panel stayed mounted through the reload, and marks the choice.
      const after = screen.getByRole('region', { name: 'Inflation scenarios' });
      expect(within(after).getAllByRole('row')[3]).toHaveAttribute('aria-current', 'true');
      expect(scenarios).toHaveBeenCalledTimes(1);

      await act(async () => {
        fireEvent.click(within(after).getByRole('button', { name: 'Use the default assumption' }));
      });
      expect(get).toHaveBeenLastCalledWith('sec-1', '2027-04-15', undefined);
      expect(within(after).queryByRole('button', { name: 'Use the default assumption' })).not.toBeInTheDocument();
    });

    it('is an error state with a retry when the scenarios cannot be loaded', async () => {
      withLots({});
      scenarios.mockRejectedValue(new Error('boom'));
      await mount();
      const panel = screen.getByRole('region', { name: 'Inflation scenarios' });
      expect(within(panel).getByRole('alert')).toHaveTextContent(/scenarios could not be loaded|boom/);
      expect(within(panel).queryAllByRole('row')).toHaveLength(0);
    });

    it('names the refusal and shows no invented figures when the lots cannot be derived', async () => {
      withLots({});
      scenarios.mockResolvedValue({
        securityId: 'sec-1',
        benchmarkId: CPI,
        asOf: '2027-04-15',
        refusal: { code: 'SPLIT', detail: 'split', params: { action: 'SPLIT', date: '2027-01-05', quantity: '2' } },
        scenarios: scenarioRows.slice(0, 1).map((r) => ({
          ...r,
          maturityValue: null,
          totalInterest: null,
          fixedInterest: null,
          benchmarkInterest: null,
          addendInterest: null,
          announcedInterest: null,
        })),
      });
      await mount();
      const panel = screen.getByRole('region', { name: 'Inflation scenarios' });
      expect(within(panel).getByText(/a bond does not split/)).toBeInTheDocument();
      expect(within(panel).getAllByText('Unknown')).toHaveLength(5);
    });
  });

  describe('interest chart (13.4)', () => {
    it('stacks the cumulative parts per period end, lighter when projected, and stops at an unknown period', async () => {
      withLots({});
      await mount();
      expect(screen.getByTestId('bar-chart')).toHaveAttribute('data-points', '3');
      const bars = screen.getAllByTestId('bar');
      expect(bars.map((b) => b.getAttribute('data-name'))).toEqual([
        'Fixed interest (1st period)',
        'Interest from margin',
        'Interest from inflation',
      ]);
      for (const bar of bars) {
        expect(bar.getAttribute('data-fill')).toMatch(/^var\(--chart-/);
        const opacities = within(bar).getAllByTestId('cell').map((c) => c.getAttribute('data-opacity'));
        expect(opacities).toEqual(['1', '1', '0.45']);
      }
      expect(screen.getByText('Projection assuming CPI, 12 months (GUS) = 5%', { exact: false })).toBeInTheDocument();
      expect(screen.getByText('Interest is not known from period 4, so the chart stops before it.')).toBeInTheDocument();
    });

    it('draws nothing for a fixed-rate bond without a schedule', async () => {
      await mount();
      expect(screen.queryByTestId('bar-chart')).not.toBeInTheDocument();
    });
  });
  describe('audit fixes', () => {
    const cashFlow = (over: Partial<BondValuation['knownCashflows'][number]>) => ({
      date: '2027-07-05',
      type: 'INTEREST' as const,
      amount: '5.00',
      status: 'KNOWN' as const,
      period: 1,
      ...over,
    });

    it('shows an UNKNOWN cash flow as the next one, with an unknown amount and no number', async () => {
      withLots({
        rateSchedule: [],
        rateRule: rule({ type: 'FIXED', benchmarkId: null }),
        knownCashflows: [cashFlow({ date: '2027-10-15', type: 'PRINCIPAL', amount: '1000.00' })],
        projectedCashflows: [
          cashFlow({ date: '2027-01-15', amount: null, status: 'UNKNOWN', period: 3 }),
          cashFlow({ date: '2027-02-15', amount: '3.80', status: 'PROJECTED', period: 4 }),
        ],
        nextPayment: [cashFlow({ date: '2027-01-15', amount: null, status: 'UNKNOWN', period: 3 })],
      });
      await mount();
      const next = within(lotRows()[1]).getAllByRole('cell')[9];
      expect(next).toHaveTextContent('Interest Unknown on 01/15/2027');
      expect(within(next).getByText('Amount unknown')).toBeInTheDocument();
      expect(next).not.toHaveTextContent('$0.00');
      expect(next).not.toHaveTextContent('3.80');
    });

    it('lists a benchmark nothing can be projected from, with its publisher', async () => {
      withLots({
        projectionAssumptions: [],
        projectionMissing: [
          { benchmarkId: CPI, publisher: 'GUS' },
          { benchmarkId: 'PL_NBP_REFERENCE', publisher: null },
        ],
      });
      await mount();
      expect(screen.getByText('Later periods cannot be projected')).toBeInTheDocument();
      expect(
        screen.getByText(/CPI, 12 months \(GUS\): no value is published.*\(published by GUS\)/),
      ).toBeInTheDocument();
      expect(screen.getByText(/NBP reference rate: no value is published.*publisher not known/)).toBeInTheDocument();
    });

    it('draws the chart axis in the bond currency, not the default one', async () => {
      withLots({});
      await mount();
      const ticks = screen.getAllByTestId('y-tick');
      expect(ticks[0]).toHaveTextContent('PLN 100');
      expect(ticks[0]).not.toHaveTextContent('DEFAULT');
    });

    it('labels a fixed-rate bond fixed-rate interest for the whole term, without margin or benchmark bars', async () => {
      withLots({
        rateRule: rule({ type: 'FIXED', benchmarkId: null, annualRate: '0.0440', firstPeriodRate: null, addend: null }),
        rateSchedule: [
          period(1, { rateSource: 'TERMS', addend: null, interest: '4.4', fixedPart: '4.4' }),
          period(2, { rateSource: 'TERMS', addend: null, interest: '4.4', fixedPart: '4.4' }),
          period(3, { rateSource: 'TERMS', addend: null, interest: '4.4', fixedPart: '4.4' }),
        ],
        projectionAssumptions: [],
      });
      await mount();
      expect(screen.getAllByTestId('bar').map((b) => b.getAttribute('data-name'))).toEqual(['Fixed-rate interest']);
      expect(screen.queryByText(/1st period/)).not.toBeInTheDocument();
    });

    it('shows Matured, not Unknown, for a matured lot and keeps the period of an open lot with an unknown rate', async () => {
      get.mockResolvedValue(
        response({
          lots: [
            {
              instrumentId: 'bond-1', purchaseDate: '2020-10-05',
              quantity: 10,
              purchaseDateAssumed: false,
              valuation: lotValuation({
                status: 'MATURED',
                currentPeriod: null,
                earlyRedemptionValue: null,
                earlyRedemptionRefusal: 'MATURED',
              }),
            },
            {
              instrumentId: 'bond-1', purchaseDate: '2026-10-05',
              quantity: 5,
              purchaseDateAssumed: false,
              valuation: lotValuation({
                currentPeriod: {
                  index: 3,
                  start: '2027-01-01',
                  end: '2027-12-31',
                  annualRate: null,
                  rateSource: null,
                },
              }),
            },
          ],
        }),
      );
      await mount();
      const matured = within(lotRows()[1]).getAllByRole('cell');
      expect(matured[3]).toHaveTextContent('Matured');
      expect(matured[4]).toHaveTextContent('Matured');
      expect(matured[3]).not.toHaveTextContent('Unknown');
      const open = within(lotRows()[2]).getAllByRole('cell');
      expect(open[3]).toHaveTextContent('3: 12/31/2027'.slice(0, 2));
      expect(open[3]).toHaveTextContent('01/01/2027');
      expect(open[4]).toHaveTextContent('Unknown');
    });

    it('shows the refusal reason of a lot bought outside the sale window instead of Unknown', async () => {
      get.mockResolvedValue(
        response({
          lots: [
            {
              instrumentId: 'bond-1', purchaseDate: '2026-12-05',
              quantity: 10,
              purchaseDateAssumed: false,
              valuation: lotValuation({
                status: 'REFUSED',
                currentPeriod: null,
                refusal: {
                  code: 'PURCHASE_OUTSIDE_SALE_WINDOW',
                  params: { from: '2026-10-01', to: '2026-10-31', purchaseDate: '2026-12-05' },
                },
                grossValue: null,
                valuationComplete: false,
              }),
            },
          ],
        }),
      );
      await mount();
      const cell = within(lotRows()[1]).getAllByRole('cell')[3];
      expect(cell).toHaveTextContent('Not valued');
      expect(cell).toHaveTextContent('can only be bought from 10/01/2026 to 10/31/2026');
      expect(cell).toHaveTextContent('bought on 12/05/2026');
    });

    it('shows the refusal reason of a marketable lot bought on or after its maturity', async () => {
      get.mockResolvedValue(
        response({
          lots: [
            {
              instrumentId: 'bond-1', purchaseDate: '2027-04-02',
              quantity: 10,
              purchaseDateAssumed: false,
              valuation: lotValuation({
                status: 'REFUSED',
                currentPeriod: null,
                refusal: {
                  code: 'PURCHASE_AFTER_MATURITY',
                  params: { maturityDate: '2027-04-01', purchaseDate: '2027-04-02' },
                },
                grossValue: null,
                valuationComplete: false,
              }),
            },
          ],
        }),
      );
      await mount();
      const cell = within(lotRows()[1]).getAllByRole('cell')[3];
      expect(cell).toHaveTextContent('Not valued');
      expect(cell).toHaveTextContent('matured on 04/01/2027');
      expect(cell).toHaveTextContent('bought on 04/02/2027');
    });

    it('says the price is the person\'s own when a held series trades, and says nothing otherwise', async () => {
      get.mockResolvedValue(response({ marketPriceRequired: true }));
      await mount();
      expect(screen.getByText('Monize writes no price for it', { exact: false })).toBeInTheDocument();
    });

    it('does not ask for a price when the flag is false or absent', async () => {
      get.mockResolvedValue(response({ marketPriceRequired: false }));
      await mount();
      expect(screen.queryByText('Monize writes no price for it', { exact: false })).not.toBeInTheDocument();
    });

    it('shows a partial-data notice naming the cause when valuationComplete is false', async () => {
      withLots({
        valuationComplete: false,
        dataCompleteness: {
          termsComplete: false,
          referenceDataComplete: true,
          earlyRedemptionTermsComplete: true,
        },
        missing: [],
      });
      await mount();
      const note = screen.getByText('This valuation is incomplete', { exact: false }).closest('[role="note"]') as HTMLElement;
      expect(note).toHaveTextContent('This valuation is incomplete');
      expect(note).toHaveTextContent('The terms of the bond are incomplete');
      expect(note).not.toHaveTextContent('Reference data is missing');
    });

    it('shows no partial notice for a complete valuation or an absent flag', async () => {
      withLots({ valuationComplete: true });
      await mount();
      expect(screen.queryByText('This valuation is incomplete', { exact: false })).not.toBeInTheDocument();
    });

    it('says how fresh each benchmark is', async () => {
      get.mockResolvedValue(
        response({
          benchmarkCoverage: [
            { benchmarkId: CPI, coveredThrough: '2027-03-31', lastFetchedAt: '2027-04-10T06:00:00Z' },
            { benchmarkId: 'PL_NBP_REFERENCE', coveredThrough: null, lastFetchedAt: null },
          ],
        }),
      );
      await mount();
      expect(screen.getByText('CPI, 12 months (GUS) data as of 03/31/2027')).toBeInTheDocument();
      expect(screen.getByText('No NBP reference rate data is stored yet')).toBeInTheDocument();
    });

    it('does not let the picker choose a day after today and never requests one', async () => {
      await mount();
      const input = screen.getByLabelText('Valued on');
      expect(input).toHaveAttribute('max', '2027-04-15');
      await act(async () => {
        fireEvent.change(input, { target: { value: '12/31/2030' } });
        fireEvent.blur(input);
      });
      expect(get).not.toHaveBeenCalledWith('sec-1', '2030-12-31', undefined);
    });

    it('values the scenarios on the card date and says so', async () => {
      withLots({});
      await mount();
      const input = screen.getByLabelText('Valued on');
      scenarios.mockResolvedValue({
        securityId: 'sec-1',
        benchmarkId: CPI,
        asOf: '2027-02-01',
        refusal: null,
        scenarios: scenarioRows,
      });
      await act(async () => {
        fireEvent.change(input, { target: { value: '02/01/2027' } });
        fireEvent.blur(input);
      });
      expect(scenarios).toHaveBeenLastCalledWith('sec-1', CPI, ['0', '0.025', '0.05', '0.08'], '2027-02-01');
      const panel = screen.getByRole('region', { name: 'Inflation scenarios' });
      expect(within(panel).getByText(/Valued on 02\/01\/2027/)).toBeInTheDocument();
    });
  });
});

describe('SecurityBondCard: a program-linked security (spec bond-program-securities 3.4)', () => {
  const termsSource = { provider: 'curated', url: '', document: 'Terms 5/2026' };
  const lot = (instrumentId: string, seriesCode: string, purchaseDate: string, quantity: number, over: Partial<BondValuation> = {}) => ({
    instrumentId,
    purchaseDate,
    quantity,
    purchaseDateAssumed: false,
    valuation: lotValuation({
      seriesCode,
      quantity,
      grossValue: String(quantity * 100),
      accruedInterest: String(quantity),
      earlyRedemptionValue: String(quantity * 99),
      maturityDate: seriesCode === 'TOS1029' ? '2029-10-01' : '2030-11-01',
      nextRateReset: seriesCode === 'TOS1029' ? '2027-10-05' : null,
      ...over,
    }),
  });
  const twoSeries = () =>
    response({
      lots: [
        lot('bond-1', 'TOS1029', '2026-10-05', 10),
        lot('bond-2', 'TOS1130', '2026-11-02', 5),
        lot('bond-2', 'TOS1130', '2026-11-20', 3),
      ],
      series: [
        { instrumentId: 'bond-1', seriesCode: 'TOS1029', programCode: 'RETAIL', termsSource, redemptionTerms: null },
        { instrumentId: 'bond-2', seriesCode: 'TOS1130', programCode: 'RETAIL', termsSource, redemptionTerms: null },
      ],
      totals: { quantity: 18, grossValue: '1800.0000', earlyRedemptionValue: '1782.0000', accruedInterest: '18.0000' },
    });

  const offerSeries = (over: Partial<OfferSeries> = {}): OfferSeries => ({
    instrumentId: 'offer-1',
    issuerCountryCode: 'PL',
    issuerCode: 'PL_MF',
    programCode: 'RETAIL',
    seriesCode: 'TOS0430',
    currency: 'PLN',
    saleWindow: { from: '2027-04-01', to: '2027-04-30' },
    periodMonths: 12,
    periodCount: 3,
    lengthDays: null,
    rateRule: { type: 'FIXED', benchmarkId: null, annualRate: '0.0500', firstPeriodRate: null, addend: null, benchmarkFloor: null },
    capitalization: 'NONE',
    redemption: {
      type: 'ON_DEMAND',
      earliestDaysAfterPurchase: 7,
      latestDaysBeforeMaturity: 20,
      blackouts: [],
      penalties: [{ type: 'FIXED_FEE_PER_UNIT', amount: '2.00' }],
      proceedsFloor: { type: 'FACE_VALUE', appliesTo: 'FIRST_PERIOD' },
    },
    termsSource,
    projection: {
      maturityValue: '115.0000',
      totalReturn: '0.1500',
      annualizedReturn: '0.0480',
      projected: false,
      assumptions: [],
      projectionMissing: [],
    },
    ...over,
  });
  const offerOf = (series: OfferSeries[]): BondOffer => ({ countryCode: 'PL', today: '2027-04-15', series });

  beforeEach(() => {
    vi.clearAllMocks();
    get.mockResolvedValue(twoSeries());
    getOffer.mockResolvedValue(offerOf([]));
    scenarios.mockResolvedValue({
      securityId: 'sec-1',
      benchmarkId: 'PL_CPI_GUS_YOY',
      asOf: '2027-04-15',
      refusal: null,
      scenarios: [],
    });
  });

  it('lays the sections out in the order: your series, the program, on sale now (the terms history has its own tab)', async () => {
    await mountCollapsed();
    const sections = ['Your series', 'The bond kind', 'On sale now', 'History of RETAIL terms'];
    const headings = screen
      .getAllByRole('heading', { level: 3 })
      .map((h) => h.textContent ?? '')
      .filter((text) => sections.includes(text));
    expect(headings).toEqual([
      'Your series',
      'The bond kind',
      'On sale now',
    ]);
    expect(getHistory).not.toHaveBeenCalled();
  });

  it('groups the lots into one row per series, with the series figures and the program total', async () => {
    await mountCollapsed();
    const rows = within(screen.getAllByRole('table')[0]).getAllByRole('row');
    // header, two series, program total
    expect(rows).toHaveLength(4);
    const first = within(rows[1]).getAllByRole('cell');
    expect(first[0]).toHaveTextContent('TOS1029');
    expect(first[1]).toHaveTextContent('10');
    expect(first[2]).toHaveTextContent('10/05/2026');
    expect(first[3]).toHaveTextContent('$1,000.00');
    expect(first[8]).toHaveTextContent('10/01/2029');
    expect(first[7]).toHaveTextContent('10/05/2027');
    const second = within(rows[2]).getAllByRole('cell');
    expect(second[0]).toHaveTextContent('TOS1130');
    // Two lots of one series: their quantities add, their dates are a range.
    expect(second[1]).toHaveTextContent('8');
    expect(second[2]).toHaveTextContent('11/02/2026 to 11/20/2026');
    expect(second[3]).toHaveTextContent('$800.00');
    expect(second[4]).toHaveTextContent('$8.00');
    expect(second[5]).toHaveTextContent('$792.00');
    // The totals are the server's, not re-added here.
    expect(totalCell('quantity')).toHaveTextContent('18');
    expect(totalCell('gross')).toHaveTextContent('$1,800.00');
  });

  it('opens a series onto the detail of its own lots only', async () => {
    await mountCollapsed();
    expect(screen.queryByText('Principal per bond')).not.toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Show details of TOS1130' }));
    });
    expect(screen.getByRole('button', { name: 'Hide details of TOS1130' })).toHaveAttribute('aria-expanded', 'true');
    // Two lots of TOS1130 are in the lots table, none of TOS1029.
    expect(lotRows()).toHaveLength(3);
    expect(
      within(screen.getByRole('region', { name: 'Your series' })).getByText('Terms: Terms 5/2026'),
    ).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Hide details of TOS1130' }));
    });
    expect(screen.queryByText('Principal per bond')).not.toBeInTheDocument();
  });

  it('keeps a figure unknown for a series when one of its lots has none', async () => {
    get.mockResolvedValue(
      response({
        lots: [lot('bond-1', 'TOS1029', '2026-10-05', 10), lot('bond-1', 'TOS1029', '2026-10-20', 2, { grossValue: null })],
        totals: { quantity: 12, grossValue: null, earlyRedemptionValue: '1188.0000', accruedInterest: '12.0000' },
      }),
    );
    await mountCollapsed();
    const row = within(within(screen.getAllByRole('table')[0]).getAllByRole('row')[1]).getAllByRole('cell');
    expect(row[3]).toHaveTextContent('Unknown');
    expect(row[3]).not.toHaveTextContent('$');
    expect(totalCell('gross')).toHaveTextContent('Unknown');
  });

  it('describes the program from the newest series on sale: rule, length, fee and floor', async () => {
    getOffer.mockResolvedValue(
      offerOf([
        offerSeries({ seriesCode: 'TOS0330', saleWindow: { from: '2027-03-01', to: '2027-03-31' } }),
        offerSeries(),
        offerSeries({ instrumentId: 'other', programCode: 'OTHER', seriesCode: 'OTH0430' }),
      ]),
    );
    await mountCollapsed();
    const program = screen.getByRole('region', { name: 'The bond kind' });
    expect(within(program).getByText('Terms of the newest series, TOS0430.')).toBeInTheDocument();
    expect(within(program).getByText('Fixed 5% for the whole term')).toBeInTheDocument();
    expect(within(program).getByText('36 months')).toBeInTheDocument();
    expect(within(program).getByText('Paid out each period')).toBeInTheDocument();
    expect(within(program).getByText('Early redemption fee: $2.00 per bond.')).toBeInTheDocument();
    expect(within(program).getByText(/In the first period only/)).toBeInTheDocument();
  });

  it('falls back to the series held when nothing is on sale', async () => {
    await mountCollapsed();
    const program = screen.getByRole('region', { name: 'The bond kind' });
    // The newest held series is the one bought last.
    expect(within(program).getByText('Terms of the newest series, TOS1130.')).toBeInTheDocument();
    expect(within(program).getByText('Fixed 4.4% for the whole term')).toBeInTheDocument();
  });

  it('reads the offer for the program\'s own country, and shows a day-counted term in days', async () => {
    get.mockResolvedValue(
      response({
        program: {
          id: 'prog-1',
          programCode: 'RETAIL',
          issuerCountryCode: 'US',
          issuerCode: 'US_TREASURY',
          currency: 'USD',
        },
      }),
    );
    getOffer.mockResolvedValue({
      countryCode: 'US',
      today: '2027-04-15',
      series: [offerSeries({ periodMonths: 0, periodCount: 0, lengthDays: 28 })],
    });
    await mountCollapsed();
    expect(getOffer).toHaveBeenCalledWith('US', []);
    expect(getOffer).not.toHaveBeenCalledWith('PL', expect.anything());
    const onSale = screen.getByRole('region', { name: 'On sale now' });
    expect(within(onSale).getByText('28 days')).toBeInTheDocument();
  });

  it('shows a month-counted term in months', async () => {
    getOffer.mockResolvedValue(offerOf([offerSeries()]));
    await mountCollapsed();
    const onSale = screen.getByRole('region', { name: 'On sale now' });
    expect(within(onSale).getByText('36 months')).toBeInTheDocument();
  });

  it('says a discount bond\'s rule as a discount to face value', async () => {
    getOffer.mockResolvedValue(
      offerOf([
        offerSeries({
          lengthDays: 28,
          rateRule: { type: 'ZERO_COUPON_DISCOUNT', benchmarkId: null, annualRate: null, firstPeriodRate: null, addend: null, benchmarkFloor: null },
        }),
      ]),
    );
    await mountCollapsed();
    const onSale = screen.getByRole('region', { name: 'On sale now' });
    expect(within(onSale).getByText('Discount to face value')).toBeInTheDocument();
  });

  it('lists only the series on sale of this program, with nothing to add', async () => {
    getOffer.mockResolvedValue(
      offerOf([
        offerSeries(),
        offerSeries({ instrumentId: 'other', programCode: 'OTHER', seriesCode: 'OTH0430' }),
      ]),
    );
    await mountCollapsed();
    const onSale = screen.getByRole('region', { name: 'On sale now' });
    expect(within(onSale).getByText('TOS0430')).toBeInTheDocument();
    expect(within(onSale).queryByText('OTH0430')).not.toBeInTheDocument();
    expect(within(onSale).queryByRole('button', { name: /Add / })).not.toBeInTheDocument();
    expect(within(onSale).queryByRole('button', { name: 'Fetch the current offer now' })).not.toBeInTheDocument();
  });

  it('lets the text columns of the bond tables wrap and keeps the scrollbar themed', async () => {
    getOffer.mockResolvedValue(offerOf([offerSeries()]));
    await mountCollapsed();
    const onSale = screen.getByRole('region', { name: 'On sale now' });
    const table = within(onSale).getByRole('table');
    expect(table.parentElement).toHaveClass('overflow-x-auto', 'scrollbar-slim');
    const cells = within(table).getAllByRole('cell');
    // The rule, capitalization and redemption text, and the sale window,
    // are free to wrap; only a figure holds to one line.
    const wrapping = cells.filter((c) => !c.className.includes('whitespace-nowrap'));
    expect(wrapping.length).toBeGreaterThan(0);
    const sale = within(onSale).getAllByRole('cell')[1];
    expect(sale).not.toHaveClass('whitespace-nowrap');
    const yourSeries = screen.getAllByRole('table')[0];
    expect(yourSeries.parentElement).toHaveClass('overflow-x-auto', 'scrollbar-slim');
  });

  describe('the auto-fetch switch', () => {
    const update = vi.mocked(investmentsApi.updateSecurity);
    const switchEl = () => screen.getByRole('switch', { name: 'Fetch new series of this bond kind automatically' });

    it('starts as the server reports it', async () => {
      get.mockResolvedValue({ ...twoSeries(), autoFetch: true });
      await mountCollapsed();
      expect(switchEl()).toHaveAttribute('aria-checked', 'true');
    });

    it('saves through the security update, moving at once', async () => {
      let resolveSave!: (v: Security) => void;
      update.mockReturnValue(new Promise((r) => (resolveSave = r)));
      await mountCollapsed();
      expect(switchEl()).toHaveAttribute('aria-checked', 'false');
      await act(async () => {
        fireEvent.click(switchEl());
      });
      expect(update).toHaveBeenCalledWith('sec-1', { bondAutoFetch: true });
      // Optimistic: on before the server answered.
      expect(switchEl()).toHaveAttribute('aria-checked', 'true');
      await act(async () => {
        resolveSave({ ...security, bondAutoFetch: true });
      });
      expect(switchEl()).toHaveAttribute('aria-checked', 'true');
    });

    it('goes back and says why when the save fails', async () => {
      update.mockRejectedValue({ response: { data: { message: 'Not allowed for this security' } } });
      await mountCollapsed();
      await act(async () => {
        fireEvent.click(switchEl());
      });
      expect(switchEl()).toHaveAttribute('aria-checked', 'false');
      expect(toast.error).toHaveBeenCalledWith('Not allowed for this security');
    });
  });
});
