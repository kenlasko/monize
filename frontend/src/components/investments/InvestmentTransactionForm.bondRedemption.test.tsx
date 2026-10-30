import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act, within } from '@/test/render';
import { InvestmentTransactionForm } from './InvestmentTransactionForm';
import { investmentsApi } from '@/lib/investments';

vi.mock('@/hooks/useNumberFormat', async () => {
  const { numberFormatMockDefaults } = await import('@/test/number-format-mock');
  return {
    useNumberFormat: () => ({
      ...numberFormatMockDefaults(),
      defaultCurrency: 'PLN',
      formatCurrency: (n: number, c?: string) => `${c ?? ''} ${n.toFixed(2)}`,
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
    listBondPrograms: vi.fn(),
    listBondInstruments: vi.fn(),
    fetchBondSeries: vi.fn(),
    getBondSeriesOnSale: vi.fn(),
    getExpectedBondSeries: vi.fn(),
    getBondSeriesHoldings: vi.fn(),
    getBondRedemptionSplit: vi.fn(),
  },
}));
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() }),
}));
vi.mock('@hookform/resolvers/zod', () => ({
  zodResolver: () => async (data: any) => ({ values: data, errors: {} }),
}));
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

async function pickSecurity(id: string, action?: string) {
  if (action) {
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Transaction Type'), { target: { value: action } });
    });
  }
  await waitFor(() => expect(within(screen.getByLabelText('Security')).getAllByRole('option').length).toBeGreaterThan(1));
  await act(async () => {
    fireEvent.change(screen.getByLabelText('Security'), { target: { value: id } });
  });
}

const seriesSelect = () => screen.findByLabelText('Bond series') as Promise<HTMLSelectElement>;

const num = (label: string | RegExp) =>
  parseFloat((screen.getByLabelText(label) as HTMLInputElement).value);

const split = (over: Record<string, unknown> = {}) => ({
  date: '2026-12-01',
  quantity: 4,
  principal: '400.00',
  grossInterest: '12.80',
  deduction: '3.00',
  interest: '9.80',
  principalReturned: '400.00',
  payout: '409.80',
  refusal: null,
  ...over,
});

const type = async (label: string | RegExp, value: string) => {
  await act(async () => {
    fireEvent.change(screen.getByLabelText(label), { target: { value } });
  });
};

/** A REDEEM of EDO on 2026-12-01, series EDO1036 picked, `quantity` typed. */
async function redeem(quantity: string) {
  await openForm({ defaultDate: '2026-12-01' });
  await pickSecurity('sec-edo', 'REDEEM');
  const select = await seriesSelect();
  await waitFor(() => expect(optionLabels(select)).toContain('EDO1036 (25 held)'));
  await act(async () => {
    fireEvent.change(select, { target: { value: 'i-1036' } });
  });
  await type('Quantity (Shares)', quantity);
}

beforeEach(() => {
  vi.clearAllMocks();
  api.getSecurities.mockResolvedValue(securities.map((s) => ({ ...s })) as any);
  api.listBondPrograms.mockResolvedValue(programs);
  api.listBondInstruments.mockResolvedValue(instruments);
  api.getBondSeriesOnSale.mockResolvedValue({ instrumentId: 'i-1036', seriesCode: 'EDO1036' });
  api.getExpectedBondSeries.mockResolvedValue({ seriesCode: 'EDO1036', countryCode: 'PL', fetchable: true });
  api.getBondSeriesHoldings.mockResolvedValue({
    holdings: [held('i-0936', 'EDO0936', 5), held('i-1036', 'EDO1036', 25)],
  });
  api.getBondRedemptionSplit.mockResolvedValue(split() as any);
  api.createTransaction.mockResolvedValue({} as any);
  api.updateTransaction.mockResolvedValue({} as any);
});

const waitSplitCalls = (n: number) =>
  waitFor(() => expect(api.getBondRedemptionSplit).toHaveBeenCalledTimes(n), { timeout: 2000 });

describe('InvestmentTransactionForm: redemption of a bond splits into principal and interest', () => {
  it('asks the server once series, date and quantity are set, and fills the price and the accrued interest', async () => {
    await redeem('4');
    await waitSplitCalls(1);
    expect(api.getBondRedemptionSplit).toHaveBeenCalledWith('sec-edo', {
      accountId: 'a1',
      bondInstrumentId: 'i-1036',
      date: '2026-12-01',
      quantity: 4,
      excludeTransactionId: undefined,
    });
    await waitFor(() => expect(num(/Accrued Interest/)).toBeCloseTo(9.8, 4));
    // principalReturned 400.00 over 4 bonds.
    expect(num(/Price per Share/)).toBeCloseTo(100, 6);
    expect(screen.getByText('Interest PLN 9.80, early-redemption deduction PLN 3.00, payout PLN 409.80')).toBeInTheDocument();
  });

  it('asks nothing before a series and a whole quantity are set', async () => {
    await openForm({ defaultDate: '2026-12-01' });
    await pickSecurity('sec-edo', 'REDEEM');
    await seriesSelect();
    await type('Quantity (Shares)', '4');
    await new Promise((r) => setTimeout(r, 500));
    // Oldest first names no series: there is no series to split.
    expect(api.getBondRedemptionSplit).not.toHaveBeenCalled();
  });

  it('keeps what the person typed: a later change of quantity does not overwrite an edited price or interest', async () => {
    await redeem('4');
    await waitFor(() => expect(num(/Accrued Interest/)).toBeCloseTo(9.8, 4));
    await type(/Accrued Interest/, '8.50');
    await type(/Price per Share/, '99.5');
    api.getBondRedemptionSplit.mockResolvedValue(
      split({ quantity: 2, principal: '200.00', interest: '4.90', principalReturned: '200.00', payout: '204.90' }) as any,
    );
    await type('Quantity (Shares)', '2');
    await waitSplitCalls(2);
    // The new split is shown, the person's figures stand.
    expect(await screen.findByText(/payout PLN 204.90/)).toBeInTheDocument();
    expect(num(/Accrued Interest/)).toBeCloseTo(8.5, 4);
    expect(num(/Price per Share/)).toBeCloseTo(99.5, 6);
  });

  it('keeps the price the person typed as the cash per bond: the interest comes out of qty x price, and repeated quantity changes do not drift', async () => {
    await redeem('4');
    await waitFor(() => expect(num(/Accrued Interest/)).toBeCloseTo(9.8, 4));
    await type(/Price per Share/, '100');
    api.getBondRedemptionSplit.mockResolvedValue(
      split({ quantity: 2, interest: '4.00', principalReturned: '200.00', payout: '204.00' }) as any,
    );
    await type('Quantity (Shares)', '2');
    // (2 x 100 - 4) / 2
    await waitFor(() => expect(num(/Accrued Interest/)).toBeCloseTo(4, 4));
    expect(num(/Price per Share/)).toBeCloseTo(98, 6);
    api.getBondRedemptionSplit.mockResolvedValue(
      split({ quantity: 4, interest: '8.00', principalReturned: '400.00', payout: '408.00' }) as any,
    );
    await type('Quantity (Shares)', '4');
    // Still from the typed 100, not from the 98 the first refill wrote: (4 x 100 - 8) / 4.
    await waitFor(() => expect(num(/Accrued Interest/)).toBeCloseTo(8, 4));
    expect(num(/Price per Share/)).toBeCloseTo(98, 6);
  });

  it('keeps the total the person fixed: the interest comes out of the typed total, each time from the typed figure', async () => {
    await redeem('4');
    await waitFor(() => expect(num(/Accrued Interest/)).toBeCloseTo(9.8, 4));
    await type(/Total Amount/, '420');
    api.getBondRedemptionSplit.mockResolvedValue(
      split({ quantity: 2, interest: '4.90', principalReturned: '200.00', payout: '204.90' }) as any,
    );
    await type('Quantity (Shares)', '2');
    await waitFor(() => expect(num(/Accrued Interest/)).toBeCloseTo(4.9, 4));
    // (420 - 4.90) / 2
    expect(num(/Price per Share/)).toBeCloseTo(207.55, 6);
  });

  it('refills a field the person has not edited when the quantity changes', async () => {
    await redeem('4');
    await waitFor(() => expect(num(/Accrued Interest/)).toBeCloseTo(9.8, 4));
    api.getBondRedemptionSplit.mockResolvedValue(
      split({ quantity: 2, interest: '4.90', principalReturned: '200.00', payout: '204.90' }) as any,
    );
    await type('Quantity (Shares)', '2');
    await waitFor(() => expect(num(/Accrued Interest/)).toBeCloseTo(4.9, 4));
  });

  it('ignores a slow answer to an earlier request', async () => {
    let resolveFirst: (v: unknown) => void = () => {};
    api.getBondRedemptionSplit
      .mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve; }) as any)
      .mockResolvedValue(
        split({ quantity: 2, interest: '4.90', principalReturned: '200.00', payout: '204.90' }) as any,
      );
    await redeem('4');
    await waitSplitCalls(1);
    await type('Quantity (Shares)', '2');
    await waitSplitCalls(2);
    await waitFor(() => expect(num(/Accrued Interest/)).toBeCloseTo(4.9, 4));
    await act(async () => {
      resolveFirst(split());
    });
    expect(num(/Accrued Interest/)).toBeCloseTo(4.9, 4);
    expect(screen.queryByText(/payout PLN 409.80/)).not.toBeInTheDocument();
  });

  it('says why when the redemption is refused, and fills nothing', async () => {
    api.getBondRedemptionSplit.mockResolvedValue(
      split({ refusal: 'TOO_EARLY', interest: null, deduction: null, principalReturned: null, payout: null }) as any,
    );
    await redeem('4');
    expect(await screen.findByText('Too early to redeem')).toBeInTheDocument();
    expect(screen.getByLabelText(/Accrued Interest/)).toHaveValue('');
  });

  it('says a refused quantity with the removal refusal, and a failed read as a failure', async () => {
    api.getBondRedemptionSplit.mockRejectedValue({
      response: { status: 400, data: { message: 'x', errorCode: 'REMOVAL_EXCEEDS_SERIES' } },
    });
    await redeem('30');
    expect(
      await screen.findByText('The lots cannot be derived: more bonds of one series were removed than were held.'),
    ).toBeInTheDocument();

    api.getBondRedemptionSplit.mockRejectedValue(new Error('down'));
    await type('Quantity (Shares)', '5');
    expect(await screen.findByText('The redemption split could not be calculated.')).toBeInTheDocument();
  });

  it('leaves a redemption of a security that is not a program-linked bond alone', async () => {
    await openForm({ defaultDate: '2026-12-01' });
    await pickSecurity('sec-stock', 'REDEEM');
    await type('Quantity (Shares)', '4');
    await new Promise((r) => setTimeout(r, 500));
    expect(api.getBondRedemptionSplit).not.toHaveBeenCalled();
    expect(screen.queryByText(/early-redemption deduction/)).not.toBeInTheDocument();
  });

  it('leaves another action alone', async () => {
    await openForm({ defaultDate: '2026-12-01' });
    await pickSecurity('sec-edo', 'SELL');
    const select = await seriesSelect();
    await waitFor(() => expect(optionLabels(select)).toContain('EDO1036 (25 held)'));
    await act(async () => {
      fireEvent.change(select, { target: { value: 'i-1036' } });
    });
    await type('Quantity (Shares)', '4');
    await new Promise((r) => setTimeout(r, 500));
    expect(api.getBondRedemptionSplit).not.toHaveBeenCalled();
  });

  describe('editing an existing redemption', () => {
    const stored = {
      id: 't1',
      accountId: 'a1',
      securityId: 'sec-edo',
      action: 'REDEEM' as const,
      transactionDate: '2026-12-01',
      quantity: 4,
      price: 99,
      commission: 0,
      accruedInterest: 7.25,
      totalAmount: 403.25,
      bondInstrumentId: 'i-1036',
      description: '',
    } as any;

    it('opens with the stored price and interest, shows the split, and only a change of quantity suggests new figures', async () => {
      await act(async () => {
        render(<InvestmentTransactionForm accounts={[account]} transaction={stored} />);
      });
      await waitSplitCalls(1);
      expect(api.getBondRedemptionSplit).toHaveBeenCalledWith(
        'sec-edo',
        expect.objectContaining({ excludeTransactionId: 't1', quantity: 4, bondInstrumentId: 'i-1036' }),
      );
      expect(await screen.findByText(/payout PLN 409.80/)).toBeInTheDocument();
      expect(num(/Accrued Interest/)).toBeCloseTo(7.25, 4);
      expect(num(/Price per Share/)).toBeCloseTo(99, 6);

      api.getBondRedemptionSplit.mockResolvedValue(
        split({ quantity: 2, interest: '4.90', principalReturned: '200.00', payout: '204.90' }) as any,
      );
      await type('Quantity (Shares)', '2');
      await waitFor(() => expect(num(/Accrued Interest/)).toBeCloseTo(4.9, 4));
      expect(num(/Price per Share/)).toBeCloseTo(100, 6);
    });

    it('suppresses only the first answer: returning to the opened quantity refills the split for it', async () => {
      await act(async () => {
        render(<InvestmentTransactionForm accounts={[account]} transaction={stored} />);
      });
      await waitSplitCalls(1);
      expect(await screen.findByText(/payout PLN 409.80/)).toBeInTheDocument();
      expect(num(/Accrued Interest/)).toBeCloseTo(7.25, 4);

      api.getBondRedemptionSplit.mockResolvedValue(
        split({ quantity: 2, interest: '4.90', principalReturned: '200.00', payout: '204.90' }) as any,
      );
      await type('Quantity (Shares)', '2');
      await waitFor(() => expect(num(/Accrued Interest/)).toBeCloseTo(4.9, 4));

      api.getBondRedemptionSplit.mockResolvedValue(split() as any);
      await type('Quantity (Shares)', '4');
      await waitFor(() => expect(num(/Accrued Interest/)).toBeCloseTo(9.8, 4));
      expect(num(/Price per Share/)).toBeCloseTo(100, 6);
    });
  });
});
