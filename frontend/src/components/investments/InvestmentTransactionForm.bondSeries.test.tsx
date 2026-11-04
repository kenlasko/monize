import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act, within } from '@/test/render';
import toast from 'react-hot-toast';
import { chooseComboboxOption } from '@/test/combobox';
import { InvestmentTransactionForm } from './InvestmentTransactionForm';
import { investmentsApi } from '@/lib/investments';

vi.mock('@/hooks/useNumberFormat', async () => {
  const { numberFormatMockDefaults } = await import('@/test/number-format-mock');
  return {
    useNumberFormat: () => ({ ...numberFormatMockDefaults(), defaultCurrency: 'PLN' }),
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
    defaultCurrency: 'PLN',
  }),
}));
vi.mock('@/lib/format', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/format')>();
  return { ...actual, getCurrencySymbol: () => 'zl' };
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
  name: 'IKE Brokerage',
  accountType: 'INVESTMENT',
  accountSubType: 'INVESTMENT_BROKERAGE',
  currencyCode: 'PLN',
} as any;

const securities = [
  { id: 'sec-edo', symbol: 'EDO', name: 'EDO', securityType: 'BOND', currencyCode: 'PLN', bondProgramId: 'p-edo' },
  { id: 'sec-tos', symbol: 'TOS', name: 'TOS', securityType: 'BOND', currencyCode: 'PLN', bondProgramId: 'p-tos' },
  { id: 'sec-stock', symbol: 'CDR', name: 'CD Projekt', securityType: 'STOCK', currencyCode: 'PLN', bondProgramId: null },
];
const programs = [
  { id: 'p-edo', issuerCountryCode: 'PL', issuerCode: 'PL_MF', programCode: 'EDO', currency: 'PLN', seriesCount: 2, newestSeriesCode: 'EDO1036' },
  { id: 'p-tos', issuerCountryCode: 'PL', issuerCode: 'PL_MF', programCode: 'TOS', currency: 'PLN', seriesCount: 1, newestSeriesCode: 'TOS1029' },
];
const inst = (id: string, seriesCode: string, programCode = 'EDO') => ({
  id,
  issuerCountryCode: 'PL',
  issuerCode: 'PL_MF',
  programCode,
  seriesCode,
  currencyCode: 'PLN',
  termsProvider: 'curated',
  saleWindow: null,
});
const instruments = [inst('i-0936', 'EDO0936'), inst('i-1036', 'EDO1036'), inst('i-tos', 'TOS1029', 'TOS')];

const held = (instrumentId: string, seriesCode: string, quantity: number) => ({
  instrumentId,
  seriesCode,
  quantity,
});

const optionLabels = (select: HTMLElement) =>
  within(select).getAllByRole('option').map((o) => o.textContent);

async function openForm(props: Record<string, unknown> = {}) {
  await act(async () => {
    render(
      <InvestmentTransactionForm accounts={[account]} defaultAccountId="a1" defaultDate="2026-10-12" {...props} />,
    );
  });
}

/** The Security field lists each fixture by its symbol. */
const SECURITY_SYMBOLS: Record<string, string> = { 'sec-edo': 'EDO', 'sec-tos': 'TOS', 'sec-stock': 'CDR' };

async function pickSecurity(id: string, action?: string) {
  if (action) {
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Transaction Type'), { target: { value: action } });
    });
  }
  await chooseComboboxOption('Security', `${SECURITY_SYMBOLS[id]} - `);
}

const seriesSelect = () => screen.findByLabelText('Bond series') as Promise<HTMLSelectElement>;

async function submit() {
  await act(async () => {
    fireEvent.click(screen.getByText('Create Transaction'));
  });
}
const sent = () => api.createTransaction.mock.calls[0][0] as any;

beforeEach(() => {
  vi.clearAllMocks();
  api.getSecurities.mockResolvedValue(securities.map((s) => ({ ...s })) as any);
  api.listBondPrograms.mockResolvedValue(programs);
  api.listBondInstruments.mockResolvedValue(instruments);
  // The series the server infers: EDO1036 for October 2026, none for November.
  api.getBondSeriesOnSale.mockImplementation(async (securityId: string, date: string) => {
    if (date === '2026-11-05') return null;
    return securityId === 'sec-tos'
      ? { instrumentId: 'i-tos', seriesCode: 'TOS1029' }
      : { instrumentId: 'i-1036', seriesCode: 'EDO1036' };
  });
  // The code the server's grammar names: the series maturing a decade on, fetchable.
  api.getExpectedBondSeries.mockImplementation(async (_securityId: string, date: string) => ({
    seriesCode: date === '2026-11-05' ? 'EDO1136' : 'EDO1036',
    countryCode: 'PL',
    fetchable: true,
  }));
  api.getBondSeriesHoldings.mockResolvedValue({
    holdings: [held('i-0936', 'EDO0936', 5), held('i-1036', 'EDO1036', 25)],
  });
  api.createTransaction.mockResolvedValue({} as any);
  api.updateTransaction.mockResolvedValue({} as any);
});

describe('InvestmentTransactionForm: the sale period in the series labels', () => {
  const windowed = [
    inst('i-0936', 'EDO0936'),
    { ...inst('i-1036', 'EDO1036'), saleWindow: { from: '2026-10-01', to: '2026-10-31' } },
    { ...inst('i-0836', 'EDO0836'), saleWindow: { from: '2026-08-03', to: '2026-08-21' } },
  ];

  it('shows the month for a one-month window, the dates for another, the code alone for none, newest first', async () => {
    api.listBondInstruments.mockResolvedValue(windowed);
    await openForm();
    await pickSecurity('sec-edo');
    const select = await seriesSelect();
    await waitFor(() =>
      expect(optionLabels(select)).toEqual([
        'From the date: EDO1036 — on sale M:2026-10',
        'EDO1036 — on sale M:2026-10',
        'EDO0836 — on sale D:2026-08-03 to D:2026-08-21',
        'EDO0936',
      ]),
    );
  });

  it('keeps the choose option ahead of the sorted series', async () => {
    api.listBondInstruments.mockResolvedValue(windowed);
    await openForm();
    await pickSecurity('sec-edo', 'ADD_SHARES');
    const select = await seriesSelect();
    await waitFor(() =>
      expect(optionLabels(select)).toEqual([
        'Choose a series',
        'EDO1036 — on sale M:2026-10',
        'EDO0836 — on sale D:2026-08-03 to D:2026-08-21',
        'EDO0936',
      ]),
    );
  });
});

describe('InvestmentTransactionForm: the series of a bond program', () => {
  describe('an acquisition', () => {
    it('defaults to the series the server infers for the date, labelled with it, and sends null', async () => {
      await openForm();
      await pickSecurity('sec-edo');
      const select = await seriesSelect();
      await waitFor(() => expect(optionLabels(select)).toEqual(['From the date: EDO1036', 'EDO0936', 'EDO1036']));
      expect(api.getBondSeriesOnSale).toHaveBeenCalledWith('sec-edo', '2026-10-12');
      // The client no longer prefills the series: the default is the server's inference.
      expect(select.value).toBe('');
      await submit();
      await waitFor(() => expect(api.createTransaction).toHaveBeenCalled());
      expect(sent()).toHaveProperty('bondInstrumentId', null);
      expect(sent().securityId).toBe('sec-edo');
    });

    it('asks again, and relabels the default, when the date changes', async () => {
      await openForm();
      await pickSecurity('sec-edo');
      const select = await seriesSelect();
      await waitFor(() => expect(optionLabels(select)[0]).toBe('From the date: EDO1036'));
      await act(async () => {
        fireEvent.change(screen.getByLabelText('Date'), { target: { value: '2026-11-05' } });
      });
      await waitFor(() => expect(api.getBondSeriesOnSale).toHaveBeenCalledWith('sec-edo', '2026-11-05'));
      await waitFor(() => expect(optionLabels(select)[0]).toBe('No series on sale on this date'));
    });

    it('sends the series the reader picked', async () => {
      await openForm();
      await pickSecurity('sec-edo');
      const select = await seriesSelect();
      await waitFor(() => expect(optionLabels(select)[0]).toBe('From the date: EDO1036'));
      fireEvent.change(select, { target: { value: 'i-0936' } });
      await submit();
      await waitFor(() => expect(api.createTransaction).toHaveBeenCalled());
      expect(sent().bondInstrumentId).toBe('i-0936');
    });

    it('sends null again when the reader returns to the default', async () => {
      await openForm();
      await pickSecurity('sec-edo');
      const select = await seriesSelect();
      await waitFor(() => expect(optionLabels(select)[0]).toBe('From the date: EDO1036'));
      fireEvent.change(select, { target: { value: 'i-0936' } });
      fireEvent.change(select, { target: { value: '' } });
      await submit();
      await waitFor(() => expect(api.createTransaction).toHaveBeenCalled());
      expect(sent()).toHaveProperty('bondInstrumentId', null);
    });

    it('says no series is on sale, and sends null, when the server infers none', async () => {
      await openForm({ defaultDate: '2026-11-05' });
      await pickSecurity('sec-edo');
      const select = await seriesSelect();
      await waitFor(() => expect(optionLabels(select)).toContain('No series on sale on this date'));
      expect(select.value).toBe('');
      await submit();
      await waitFor(() => expect(api.createTransaction).toHaveBeenCalled());
      expect(sent().bondInstrumentId).toBeNull();
    });

    it('offers to fetch the date\'s series when none is on sale, then selects and sends it', async () => {
      api.fetchBondSeries.mockResolvedValue({ ...inst('i-1136', 'EDO1136'), created: true } as any);
      await openForm({ defaultDate: '2026-11-05' });
      await pickSecurity('sec-edo');
      const select = await seriesSelect();
      const fetchLabel = 'Fetch EDO1136 from the official source';
      await waitFor(() => expect(optionLabels(select)).toContain(fetchLabel));
      api.listBondInstruments.mockResolvedValue([...instruments, inst('i-1136', 'EDO1136')]);
      api.getBondSeriesOnSale.mockResolvedValue({ instrumentId: 'i-1136', seriesCode: 'EDO1136' });
      await act(async () => {
        fireEvent.change(select, { target: { value: within(select).getByText(fetchLabel).getAttribute('value') } });
      });
      expect(api.fetchBondSeries).toHaveBeenCalledWith('PL', 'EDO1136');
      await waitFor(() => expect(select.value).toBe('i-1136'));
      // Stored now, so there is nothing left to offer.
      expect(optionLabels(select)).not.toContain(fetchLabel);
      await submit();
      await waitFor(() => expect(api.createTransaction).toHaveBeenCalled());
      expect(sent().bondInstrumentId).toBe('i-1136');
    });

    it('shows a spinner with the status while the series is fetched, and removes it after', async () => {
      let resolveFetch: (v: any) => void = () => {};
      api.fetchBondSeries.mockReturnValue(new Promise((resolve) => { resolveFetch = resolve; }));
      await openForm({ defaultDate: '2026-11-05' });
      await pickSecurity('sec-edo');
      const select = await seriesSelect();
      const fetchLabel = 'Fetch EDO1136 from the official source';
      await waitFor(() => expect(optionLabels(select)).toContain(fetchLabel));
      await act(async () => {
        fireEvent.change(select, { target: { value: within(select).getByText(fetchLabel).getAttribute('value') } });
      });
      const status = await screen.findByText(/Fetching EDO1136 from the issuer and its reference rates/);
      const wrapper = status.closest('[role="status"]') as HTMLElement;
      expect(wrapper).toHaveAttribute('aria-busy', 'true');
      expect(wrapper.querySelector('.animate-spin')).not.toBeNull();
      expect(select).toBeDisabled();
      api.listBondInstruments.mockResolvedValue([...instruments, inst('i-1136', 'EDO1136')]);
      api.getBondSeriesOnSale.mockResolvedValue({ instrumentId: 'i-1136', seriesCode: 'EDO1136' });
      await act(async () => {
        resolveFetch({ ...inst('i-1136', 'EDO1136'), created: true });
      });
      await waitFor(() =>
        expect(screen.queryByText(/Fetching EDO1136 from the issuer/)).not.toBeInTheDocument(),
      );
      expect(select).not.toBeDisabled();
    });

    it('says why a fetch failed, inline, and keeps the choice open', async () => {
      api.fetchBondSeries.mockRejectedValue({ response: { data: { message: 'Series EDO1136 is not published yet' } } });
      await openForm({ defaultDate: '2026-11-05' });
      await pickSecurity('sec-edo');
      const select = await seriesSelect();
      const fetchLabel = 'Fetch EDO1136 from the official source';
      await waitFor(() => expect(optionLabels(select)).toContain(fetchLabel));
      await act(async () => {
        fireEvent.change(select, { target: { value: within(select).getByText(fetchLabel).getAttribute('value') } });
      });
      expect(await screen.findByRole('alert')).toHaveTextContent('Series EDO1136 is not published yet');
      expect(select.value).toBe('');
      expect(optionLabels(select)).toContain(fetchLabel);
    });

    it('offers no fetch when the server names no series code', async () => {
      api.getExpectedBondSeries.mockResolvedValue({ seriesCode: null, countryCode: 'PL', fetchable: false });
      api.listBondPrograms.mockResolvedValue([{ ...programs[0], programCode: 'ZZZ' }]);
      api.listBondInstruments.mockResolvedValue([inst('i-z', 'ZZZ0136', 'ZZZ')]);
      await openForm({ defaultDate: '2026-11-05' });
      await pickSecurity('sec-edo');
      const select = await seriesSelect();
      await waitFor(() => expect(optionLabels(select)).toContain('ZZZ0136'));
      await waitFor(() => expect(optionLabels(select)).toContain('No series on sale on this date'));
      await waitFor(() => expect(api.getExpectedBondSeries).toHaveBeenCalledWith('sec-edo', '2026-11-05'));
      expect(optionLabels(select).some((l) => /Fetch/.test(l ?? ''))).toBe(false);
    });

    it('offers no fetch when the country cannot fetch the named series', async () => {
      api.getExpectedBondSeries.mockResolvedValue({ seriesCode: 'EDO1136', countryCode: 'PL', fetchable: false });
      await openForm({ defaultDate: '2026-11-05' });
      await pickSecurity('sec-edo');
      const select = await seriesSelect();
      await waitFor(() => expect(optionLabels(select)).toContain('No series on sale on this date'));
      await waitFor(() => expect(api.getExpectedBondSeries).toHaveBeenCalled());
      expect(optionLabels(select).some((l) => /Fetch/.test(l ?? ''))).toBe(false);
    });

    it('offers no fetch, rather than a guessed code, when the expected series could not be read', async () => {
      api.getExpectedBondSeries.mockRejectedValue(new Error('down'));
      await openForm({ defaultDate: '2026-11-05' });
      await pickSecurity('sec-edo');
      const select = await seriesSelect();
      await waitFor(() => expect(optionLabels(select)).toContain('No series on sale on this date'));
      await waitFor(() => expect(api.getExpectedBondSeries).toHaveBeenCalled());
      expect(optionLabels(select).some((l) => /Fetch/.test(l ?? ''))).toBe(false);
    });

    it('fetches with the country the server names, not a fixed one', async () => {
      api.getExpectedBondSeries.mockResolvedValue({ seriesCode: 'EDO1136', countryCode: 'US', fetchable: true });
      api.fetchBondSeries.mockResolvedValue({ ...inst('i-1136', 'EDO1136'), created: true } as any);
      await openForm({ defaultDate: '2026-11-05' });
      await pickSecurity('sec-edo');
      const select = await seriesSelect();
      const fetchLabel = 'Fetch EDO1136 from the official source';
      await waitFor(() => expect(optionLabels(select)).toContain(fetchLabel));
      await act(async () => {
        fireEvent.change(select, { target: { value: within(select).getByText(fetchLabel).getAttribute('value') } });
      });
      expect(api.fetchBondSeries).toHaveBeenCalledWith('US', 'EDO1136');
    });

    it('keeps the generic default when the date\'s series could not be read, and sends null', async () => {
      api.getBondSeriesOnSale.mockRejectedValue(new Error('down'));
      await openForm();
      await pickSecurity('sec-edo');
      const select = await seriesSelect();
      await waitFor(() => expect(optionLabels(select)).toContain('EDO0936'));
      expect(optionLabels(select)[0]).toBe('Determined from the date');
      await submit();
      await waitFor(() => expect(api.createTransaction).toHaveBeenCalled());
      expect(sent().bondInstrumentId).toBeNull();
    });

    it('says a failed lookup failed, and retries', async () => {
      api.listBondInstruments.mockRejectedValueOnce(new Error('down'));
      await openForm();
      await pickSecurity('sec-edo');
      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent('The series could not be loaded.');
      await act(async () => {
        fireEvent.click(within(alert).getByRole('button', { name: 'Retry' }));
      });
      const select = await seriesSelect();
      await waitFor(() => expect(optionLabels(select)).toContain('EDO1036'));
      expect(screen.queryByText('The series could not be loaded.')).not.toBeInTheDocument();
    });

    it('starts the choice again when another bond security is selected', async () => {
      await openForm();
      await pickSecurity('sec-edo');
      const select = await seriesSelect();
      await waitFor(() => expect(optionLabels(select)[0]).toBe('From the date: EDO1036'));
      fireEvent.change(select, { target: { value: 'i-0936' } });
      await pickSecurity('sec-tos');
      await waitFor(() => expect(optionLabels(screen.getByLabelText('Bond series'))).toEqual(['From the date: TOS1029', 'TOS1029']));
      await submit();
      await waitFor(() => expect(api.createTransaction).toHaveBeenCalled());
      expect(sent().securityId).toBe('sec-tos');
      expect(sent().bondInstrumentId).toBeNull();
    });
  });

  describe('adding shares', () => {
    it('lists every stored series with no default, and does not ask the server for the date\'s', async () => {
      await openForm();
      await pickSecurity('sec-edo', 'ADD_SHARES');
      const select = await seriesSelect();
      await waitFor(() => expect(optionLabels(select)).toEqual(['Choose a series', 'EDO0936', 'EDO1036']));
      expect(select.value).toBe('');
      expect(api.getBondSeriesOnSale).not.toHaveBeenCalled();
    });

    it('blocks the submit until a series is chosen, then sends it', async () => {
      await openForm();
      await pickSecurity('sec-edo', 'ADD_SHARES');
      const select = await seriesSelect();
      await waitFor(() => expect(optionLabels(select)).toContain('EDO1036'));
      await submit();
      expect(api.createTransaction).not.toHaveBeenCalled();
      expect(await screen.findByText('Choose the series of these shares.')).toBeInTheDocument();
      fireEvent.change(select, { target: { value: 'i-0936' } });
      expect(screen.queryByText('Choose the series of these shares.')).not.toBeInTheDocument();
      await submit();
      await waitFor(() => expect(api.createTransaction).toHaveBeenCalled());
      expect(sent().action).toBe('ADD_SHARES');
      expect(sent().bondInstrumentId).toBe('i-0936');
    });

    it('says the server\'s SERIES_REQUIRED refusal under the select', async () => {
      api.createTransaction.mockRejectedValue({
        response: { status: 400, data: { message: 'Name the series of the shares.', errorCode: 'SERIES_REQUIRED' } },
      });
      await openForm();
      await pickSecurity('sec-edo', 'ADD_SHARES');
      const select = await seriesSelect();
      await waitFor(() => expect(optionLabels(select)).toContain('EDO1036'));
      fireEvent.change(select, { target: { value: 'i-1036' } });
      await submit();
      expect(await screen.findByText('Name the series of the shares.')).toBeInTheDocument();
    });
  });

  describe('a removal', () => {
    it('lists the series the account holds on the date, with quantities, Oldest first as the default, and sends null', async () => {
      await openForm();
      await pickSecurity('sec-edo', 'SELL');
      const select = await seriesSelect();
      await waitFor(() =>
        expect(optionLabels(select)).toEqual(['Oldest first', 'EDO0936 (5 held)', 'EDO1036 (25 held)']),
      );
      expect(api.getBondSeriesHoldings).toHaveBeenCalledWith('sec-edo', 'a1', '2026-10-12', undefined);
      expect(select.value).toBe('');
      await submit();
      await waitFor(() => expect(api.createTransaction).toHaveBeenCalled());
      expect(sent().action).toBe('SELL');
      expect(sent()).toHaveProperty('bondInstrumentId', null);
    });

    it('sends the series the reader names, and offers no fetch', async () => {
      await openForm();
      await pickSecurity('sec-edo', 'SELL');
      const select = await seriesSelect();
      await waitFor(() => expect(optionLabels(select)).toContain('EDO0936 (5 held)'));
      expect(optionLabels(select).some((l) => /Fetch/.test(l ?? ''))).toBe(false);
      fireEvent.change(select, { target: { value: 'i-0936' } });
      await submit();
      await waitFor(() => expect(api.createTransaction).toHaveBeenCalled());
      expect(sent().bondInstrumentId).toBe('i-0936');
    });

    it('also lists holdings for removing shares', async () => {
      await openForm();
      await pickSecurity('sec-edo', 'REMOVE_SHARES');
      const select = await seriesSelect();
      await waitFor(() => expect(optionLabels(select)).toContain('EDO1036 (25 held)'));
    });

    it('asks again when the date or the account changes', async () => {
      await openForm();
      await pickSecurity('sec-edo', 'SELL');
      await seriesSelect();
      await waitFor(() => expect(api.getBondSeriesHoldings).toHaveBeenCalledTimes(1));
      await act(async () => {
        fireEvent.change(screen.getByLabelText('Date'), { target: { value: '2026-11-05' } });
      });
      await waitFor(() =>
        expect(api.getBondSeriesHoldings).toHaveBeenLastCalledWith('sec-edo', 'a1', '2026-11-05', undefined),
      );
    });

    it('names no series for a redemption of a bond with nothing held, and says the list is only oldest first', async () => {
      api.getBondSeriesHoldings.mockResolvedValue({ holdings: [] });
      await openForm();
      await pickSecurity('sec-edo', 'REDEEM');
      const select = await seriesSelect();
      await waitFor(() => expect(api.getBondSeriesHoldings).toHaveBeenCalled());
      expect(optionLabels(select)).toEqual(['Oldest first']);
    });

    it('says why the lots cannot be derived when the endpoint answers 422, and offers only Oldest first', async () => {
      api.getBondSeriesHoldings.mockRejectedValue({
        response: { status: 422, data: { message: 'x', errorCode: 'OVER_REMOVAL' } },
      });
      await openForm();
      await pickSecurity('sec-edo', 'SELL');
      const select = await seriesSelect();
      expect(await screen.findByText('The lots cannot be derived: more bonds were removed than were held.')).toBeInTheDocument();
      expect(optionLabels(select)).toEqual(['Oldest first']);
      // A refusal is not a failed read: there is nothing to retry.
      expect(screen.queryByText('The series could not be loaded.')).not.toBeInTheDocument();
    });

    it('says a failed read failed, not "no series held"', async () => {
      api.getBondSeriesHoldings.mockRejectedValue(new Error('down'));
      await openForm();
      await pickSecurity('sec-edo', 'SELL');
      expect(await screen.findByText('The series could not be loaded.')).toBeInTheDocument();
    });
  });

  describe('where there is no series', () => {
    it('shows nothing for a security that is not program-linked, and sends no series', async () => {
      await openForm();
      await pickSecurity('sec-stock');
      expect(screen.queryByLabelText('Bond series')).not.toBeInTheDocument();
      expect(api.listBondInstruments).not.toHaveBeenCalled();
      await submit();
      await waitFor(() => expect(api.createTransaction).toHaveBeenCalled());
      expect(sent().bondInstrumentId).toBeUndefined();
    });

    it('shows nothing for an action that moves no shares', async () => {
      await openForm();
      await pickSecurity('sec-edo', 'DIVIDEND');
      expect(screen.queryByLabelText('Bond series')).not.toBeInTheDocument();
    });
  });

  describe('the server\'s refusal', () => {
    const refuse = (errorCode: string, message: string) =>
      api.createTransaction.mockRejectedValue({ response: { status: 400, data: { message, errorCode } } });

    it('is said under the series select when it is about the series, and in a toast', async () => {
      refuse('SERIES_NOT_DETERMINED', 'No stored series of EDO covers 2026-11-05. Fetch the series first.');
      await openForm({ defaultDate: '2026-11-05' });
      await pickSecurity('sec-edo');
      await seriesSelect();
      await submit();
      expect(await screen.findByText('No stored series of EDO covers 2026-11-05. Fetch the series first.')).toBeInTheDocument();
      expect(toast.error).toHaveBeenCalledWith('No stored series of EDO covers 2026-11-05. Fetch the series first.');
    });

    it('says an OVER_REMOVAL under the select of a removal', async () => {
      refuse('OVER_REMOVAL', 'Selling 30 would remove more than are held.');
      await openForm();
      await pickSecurity('sec-edo', 'SELL');
      const select = await seriesSelect();
      await waitFor(() => expect(optionLabels(select)).toContain('EDO1036 (25 held)'));
      await submit();
      expect(await screen.findByText('Selling 30 would remove more than are held.')).toBeInTheDocument();
    });

    it('is cleared when the reader picks a series again', async () => {
      refuse('SERIES_NOT_IN_PROGRAM', 'That series is not a series of EDO.');
      await openForm();
      await pickSecurity('sec-edo');
      const select = await seriesSelect();
      await waitFor(() => expect(optionLabels(select)).toContain('EDO1036'));
      await submit();
      expect(await screen.findByText('That series is not a series of EDO.')).toBeInTheDocument();
      fireEvent.change(select, { target: { value: 'i-0936' } });
      expect(screen.queryByText('That series is not a series of EDO.')).not.toBeInTheDocument();
    });

    it('is only a toast when it is about something else', async () => {
      refuse('SOMETHING_ELSE', 'Not enough cash.');
      await openForm();
      await pickSecurity('sec-edo');
      await seriesSelect();
      await submit();
      await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Not enough cash.'));
      expect(screen.queryByText('Not enough cash.')).not.toBeInTheDocument();
    });
  });

  describe('editing a row', () => {
    const row = {
      id: 't1',
      accountId: 'a1',
      securityId: 'sec-edo',
      action: 'BUY' as const,
      transactionDate: '2026-11-05',
      quantity: 5,
      price: 100,
      commission: 0,
      totalAmount: 500,
      description: '',
      bondInstrumentId: 'i-0936',
    } as any;

    it('keeps the row\'s own series, whatever the date would suggest', async () => {
      await openForm({ transaction: row, defaultDate: undefined });
      const select = await seriesSelect();
      await waitFor(() => expect(optionLabels(select)).toContain('EDO1036'));
      expect(select.value).toBe('i-0936');
      await act(async () => {
        fireEvent.click(screen.getByText('Update Transaction'));
      });
      await waitFor(() => expect(api.updateTransaction).toHaveBeenCalled());
      expect(api.updateTransaction.mock.calls[0][1]).toMatchObject({ bondInstrumentId: 'i-0936' });
    });

    it('resets the series to the default when a buy becomes a sale, instead of sending the buy\'s series', async () => {
      await openForm({ transaction: row, defaultDate: undefined });
      const select = await seriesSelect();
      await waitFor(() => expect(select.value).toBe('i-0936'));
      await act(async () => {
        fireEvent.change(screen.getByLabelText('Transaction Type'), { target: { value: 'SELL' } });
      });
      await waitFor(() => expect(optionLabels(select)).toContain('EDO1036 (25 held)'));
      expect(select.value).toBe('');
      await act(async () => {
        fireEvent.click(screen.getByText('Update Transaction'));
      });
      await waitFor(() => expect(api.updateTransaction).toHaveBeenCalled());
      expect(api.updateTransaction.mock.calls[0][1]).toHaveProperty('bondInstrumentId', null);
    });

    it('restores the stored series when the action returns to the stored kind', async () => {
      await openForm({ transaction: row, defaultDate: undefined });
      const select = await seriesSelect();
      await waitFor(() => expect(select.value).toBe('i-0936'));
      await act(async () => {
        fireEvent.change(screen.getByLabelText('Transaction Type'), { target: { value: 'SELL' } });
      });
      await waitFor(() => expect(select.value).toBe(''));
      await act(async () => {
        fireEvent.change(screen.getByLabelText('Transaction Type'), { target: { value: 'BUY' } });
      });
      await waitFor(() => expect(select.value).toBe('i-0936'));
    });

    const sale = { ...row, action: 'SELL' as const, bondInstrumentId: 'i-0936' };

    it('excludes the row from the holdings, and keeps its stored series visible when it is no longer held', async () => {
      api.getBondSeriesHoldings.mockResolvedValue({ holdings: [held('i-1036', 'EDO1036', 25)] });
      await openForm({ transaction: sale, defaultDate: undefined });
      const select = await seriesSelect();
      await waitFor(() =>
        expect(optionLabels(select)).toEqual([
          'Oldest first',
          'EDO1036 (25 held)',
          'EDO0936 (no longer held on this date)',
        ]),
      );
      expect(api.getBondSeriesHoldings).toHaveBeenCalledWith('sec-edo', 'a1', '2026-11-05', 't1');
      expect(select.value).toBe('i-0936');
    });

    it('shows a stored series that is held under its plain held label', async () => {
      await openForm({ transaction: sale, defaultDate: undefined });
      const select = await seriesSelect();
      await waitFor(() => expect(optionLabels(select)).toEqual(['Oldest first', 'EDO0936 (5 held)', 'EDO1036 (25 held)']));
      expect(select.value).toBe('i-0936');
    });

    describe('an unpaired TRANSFER_IN', () => {
      const unpaired = {
        id: 't9',
        accountId: 'a1',
        securityId: 'sec-edo',
        action: 'TRANSFER_IN' as const,
        transactionDate: '2026-11-05',
        quantity: 5,
        price: 100,
        commission: 0,
        totalAmount: 0,
        description: '',
        linkedTransactionId: null,
        bondInstrumentId: null,
      } as any;

      it('shows the series select and saves as a single row sending the series', async () => {
        await openForm({ transaction: unpaired, defaultDate: undefined });
        const select = await seriesSelect();
        await waitFor(() => expect(optionLabels(select)).toEqual(['Choose a series', 'EDO0936', 'EDO1036']));
        fireEvent.change(select, { target: { value: 'i-0936' } });
        await act(async () => {
          fireEvent.click(screen.getByText('Update Transaction'));
        });
        await waitFor(() => expect(api.updateTransaction).toHaveBeenCalled());
        expect(api.getTransaction).not.toHaveBeenCalled();
        expect(api.updateTransaction.mock.calls[0][0]).toBe('t9');
        expect(api.updateTransaction.mock.calls[0][1]).toMatchObject({
          action: 'TRANSFER_IN',
          bondInstrumentId: 'i-0936',
          securityId: 'sec-edo',
        });
      });

      it('keeps a paired leg on the pair path, with no series select', async () => {
        api.getTransaction.mockResolvedValue({ ...unpaired, id: 't8', action: 'TRANSFER_OUT', linkedTransactionId: 't9' } as any);
        await openForm({ transaction: { ...unpaired, linkedTransactionId: 't8' }, defaultDate: undefined });
        await waitFor(() => expect(api.getTransaction).toHaveBeenCalledWith('t8'));
        expect(screen.queryByLabelText('Bond series')).not.toBeInTheDocument();
      });
    });
  });
});
