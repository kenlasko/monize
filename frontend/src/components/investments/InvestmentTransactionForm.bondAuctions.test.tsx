import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act, within } from '@/test/render';
import { chooseComboboxOption } from '@/test/combobox';
import { InvestmentTransactionForm } from './InvestmentTransactionForm';
import { investmentsApi } from '@/lib/investments';

vi.mock('@/hooks/useNumberFormat', async () => {
  const { numberFormatMockDefaults } = await import('@/test/number-format-mock');
  return {
    useNumberFormat: () => ({ ...numberFormatMockDefaults(), defaultCurrency: 'USD' }),
  };
});
vi.mock('@/hooks/useDateFormat', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/hooks/useDateFormat')>();
  return {
    useDateFormat: () => ({
      ...actual.useDateFormat(),
      formatDate: (d: string) => `D:${d}`,
      formatMonth: (m: string) => `M:${m}`,
    }),
  };
});
vi.mock('@/hooks/useExchangeRates', () => ({
  useExchangeRates: () => ({
    getRate: () => null,
    rates: [],
    rateMap: new Map(),
    isLoading: false,
    convert: (amount: number) => amount,
    convertToDefault: (amount: number) => amount,
    refresh: vi.fn(),
    defaultCurrency: 'USD',
  }),
}));
vi.mock('@/lib/format', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/format')>();
  return { ...actual, getCurrencySymbol: () => '$' };
});
vi.mock('@/lib/investments', () => ({
  investmentsApi: {
    getSecurities: vi.fn(),
    getHoldings: vi.fn().mockResolvedValue([]),
    getHoldingAt: vi.fn().mockResolvedValue({ quantity: 0, averageCost: 0 }),
    createTransaction: vi.fn().mockResolvedValue({}),
    updateTransaction: vi.fn().mockResolvedValue({}),
    getTransaction: vi.fn(),
    listBondPrograms: vi.fn(),
    listBondInstruments: vi.fn(),
    fetchBondSeries: vi.fn(),
    getBondSeriesOnSale: vi.fn(),
    getExpectedBondSeries: vi.fn(),
    getBondSeriesHoldings: vi.fn(),
    getBondAuctions: vi.fn(),
  },
}));
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() }),
}));
vi.mock('@hookform/resolvers/zod', () => ({
  zodResolver: () => async (data: any) => ({ values: data, errors: {} }),
}));
vi.mock('react-hot-toast', () => ({ default: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/components/securities/SecurityForm', () => ({ SecurityForm: () => null }));

const api = vi.mocked(investmentsApi);

const account = {
  id: 'a1',
  name: 'TreasuryDirect',
  accountType: 'INVESTMENT',
  accountSubType: 'INVESTMENT_BROKERAGE',
  currencyCode: 'USD',
} as any;

const securities = [
  { id: 'sec-note', symbol: 'UST', name: 'US notes', securityType: 'BOND', currencyCode: 'USD', bondProgramId: 'p-note' },
  { id: 'sec-tips', symbol: 'TIPS', name: 'US TIPS', securityType: 'BOND', currencyCode: 'USD', bondProgramId: 'p-tips' },
];
const program = (id: string, programCode: string, over: Record<string, unknown> = {}) => ({
  id,
  issuerCountryCode: 'US',
  issuerCode: 'US_TREASURY',
  programCode,
  currency: 'USD',
  seriesCount: 1,
  newestSeriesCode: null,
  faceValue: '100',
  cashPriced: true,
  indexedPrincipal: false,
  listsAuctions: true,
  ...over,
});
const programs = [program('p-note', 'NOTE'), program('p-tips', 'TIPS', { indexedPrincipal: true })];
const stored = {
  id: 'i-crt0',
  issuerCountryCode: 'US',
  issuerCode: 'US_TREASURY',
  programCode: 'NOTE',
  seriesCode: '91282CRT0',
  currencyCode: 'USD',
  termsProvider: 'treasurydirect',
  saleWindow: null,
};
const auction = (over: Record<string, unknown>) => ({
  seriesCode: '91282CRT0',
  identifier: '91282CRT0',
  term: '5-Year',
  auctionDate: '2026-10-27',
  issueDate: '2026-11-02',
  maturityDate: '2031-10-31',
  reopening: false,
  announced: false,
  rateKind: 'COUPON',
  ratePercent: '4.75',
  pricePer100: '99.582397',
  instrumentId: 'i-crt0',
  ...over,
});
const listed = {
  countryCode: 'US',
  supported: true,
  auctions: [
    auction({}),
    auction({
      seriesCode: '91282CRU7',
      identifier: '91282CRU7',
      term: '2-Year',
      maturityDate: '2028-10-31',
      ratePercent: '4.625',
      pricePer100: '99.843155',
      instrumentId: null,
    }),
    auction({
      seriesCode: '91282CRX1',
      identifier: '91282CRX1',
      term: '10-Year',
      auctionDate: '2026-11-12',
      issueDate: '2026-11-16',
      maturityDate: '2036-11-15',
      announced: true,
      ratePercent: null,
      pricePer100: null,
      instrumentId: null,
    }),
  ],
};

async function openForm() {
  await act(async () => {
    render(<InvestmentTransactionForm accounts={[account]} defaultAccountId="a1" defaultDate="2026-11-06" />);
  });
}

async function pickSecurity(symbol: string) {
  await chooseComboboxOption('Security', `${symbol} - `);
}

const seriesSelect = () => screen.findByLabelText('Bond series') as Promise<HTMLSelectElement>;

async function findAuctions() {
  await act(async () => {
    fireEvent.click(await screen.findByRole('button', { name: 'Find the auction' }));
  });
  return screen.findByRole('list', { name: 'Auctions issued around D:2026-11-06' });
}

beforeEach(() => {
  vi.clearAllMocks();
  api.getSecurities.mockResolvedValue(securities.map((s) => ({ ...s })) as any);
  api.listBondPrograms.mockResolvedValue(programs as any);
  api.listBondInstruments.mockResolvedValue([stored] as any);
  api.getBondAuctions.mockResolvedValue(listed as any);
  api.createTransaction.mockResolvedValue({} as any);
});

describe('InvestmentTransactionForm: choosing the auction of a program sold by auction', () => {
  it('asks for the auction instead of saying no series is on sale, and reads nothing from the issuer until asked', async () => {
    await openForm();
    await pickSecurity('UST');
    const select = await seriesSelect();
    await waitFor(() =>
      expect(within(select).getAllByRole('option')[0].textContent).toBe('Choose the auction below'),
    );
    expect(screen.queryByText('No series on sale on this date')).not.toBeInTheDocument();
    // No sale window can hold the date, so neither date lookup is asked.
    expect(api.getBondSeriesOnSale).not.toHaveBeenCalled();
    expect(api.getExpectedBondSeries).not.toHaveBeenCalled();
    expect(api.getBondAuctions).not.toHaveBeenCalled();
  });

  it('lists the auctions around the date, with an announced one that cannot be chosen yet', async () => {
    await openForm();
    await pickSecurity('UST');
    const list = await findAuctions();
    expect(api.getBondAuctions).toHaveBeenCalledWith('sec-note', '2026-11-06');
    const rows = within(list).getAllByRole('button');
    expect(rows).toHaveLength(3);
    expect(rows[0]).toHaveTextContent('5-Year · 91282CRT0');
    expect(rows[0]).toHaveTextContent('Auctioned D:2026-10-27 · issued D:2026-11-02 · matures D:2031-10-31');
    expect(rows[2]).toHaveTextContent('Announced: results not published yet');
    expect(rows[2]).toBeDisabled();
  });

  it('filters the list by term', async () => {
    await openForm();
    await pickSecurity('UST');
    const list = await findAuctions();
    const terms = screen.getByRole('group', { name: 'Term' });
    // Shortest term first.
    expect(within(terms).getAllByRole('button').map((b) => b.textContent)).toEqual([
      'All',
      '2-Year',
      '5-Year',
      '10-Year',
    ]);
    fireEvent.click(within(terms).getByRole('button', { name: '2-Year' }));
    expect(within(list).getAllByRole('button')).toHaveLength(1);
    expect(within(list).getByRole('button')).toHaveTextContent('91282CRU7');
  });

  it('chooses a stored series, sets the date to its issue and the empty price to the auction price, and says so', async () => {
    await openForm();
    await pickSecurity('UST');
    const list = await findAuctions();
    await act(async () => {
      fireEvent.click(within(list).getAllByRole('button')[0]);
    });
    expect(api.fetchBondSeries).not.toHaveBeenCalled();
    const status = await screen.findByText('Chosen: 91282CRT0, issued D:2026-11-02.');
    expect(status.parentElement).toHaveTextContent('Date set to the issue date, D:2026-11-02.');
    expect(status.parentElement).toHaveTextContent('Price set to the auction price');
    expect((await seriesSelect()).value).toBe('i-crt0');
  });

  it('fetches a series the catalog does not hold before choosing it', async () => {
    const fetched = { ...stored, id: 'i-cru7', seriesCode: '91282CRU7' };
    // The fetch stores the series, so the catalog read after it holds it too.
    api.fetchBondSeries.mockImplementation(async () => {
      api.listBondInstruments.mockResolvedValue([stored, fetched] as any);
      return { ...fetched, created: true } as any;
    });
    await openForm();
    await pickSecurity('UST');
    const list = await findAuctions();
    await act(async () => {
      fireEvent.click(within(list).getAllByRole('button')[1]);
    });
    expect(api.fetchBondSeries).toHaveBeenCalledWith('US', '91282CRU7');
    await waitFor(async () => expect((await seriesSelect()).value).toBe('i-cru7'));
  });

  it('leaves the price of an indexed principal to the person', async () => {
    await openForm();
    await pickSecurity('TIPS');
    const list = await findAuctions();
    await act(async () => {
      fireEvent.click(within(list).getAllByRole('button')[0]);
    });
    await screen.findByText('Chosen: 91282CRT0, issued D:2026-11-02.');
    expect(screen.queryByText(/Price set to the auction price/)).not.toBeInTheDocument();
  });

  it('refuses to save a purchase with no auction chosen', async () => {
    await openForm();
    await pickSecurity('UST');
    await seriesSelect();
    await act(async () => {
      fireEvent.click(screen.getByText('Create Transaction'));
    });
    expect(await screen.findByText('Choose the auction this purchase was in: find it below.')).toBeInTheDocument();
    expect(api.createTransaction).not.toHaveBeenCalled();
  });

  it('says the auctions could not be read, and retries', async () => {
    api.getBondAuctions.mockRejectedValueOnce(new Error('503'));
    await openForm();
    await pickSecurity('UST');
    await act(async () => {
      fireEvent.click(await screen.findByRole('button', { name: 'Find the auction' }));
    });
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('The auctions could not be read from the issuer.');
    await act(async () => {
      fireEvent.click(within(alert).getByRole('button', { name: 'Retry' }));
    });
    expect(await screen.findByRole('list', { name: 'Auctions issued around D:2026-11-06' })).toBeInTheDocument();
  });
});
