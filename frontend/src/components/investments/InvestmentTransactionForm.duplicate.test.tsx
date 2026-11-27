import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@/test/render';
import { chooseComboboxOption } from '@/test/combobox';
import { getSelectByLabel } from '@/test/icon-select';
import { InvestmentTransactionForm } from './InvestmentTransactionForm';
import { investmentsApi } from '@/lib/investments';
import { getLocalDateString } from '@/lib/utils';
import { usePreferencesStore } from '@/store/preferencesStore';
import type { InvestmentTransaction } from '@/types/investment';

/**
 * Duplicate (the register's row action) and the history button's quick-fill:
 * two ways of starting a NEW entry from an existing row (issue #2482).
 */

vi.mock('@/hooks/useNumberFormat', async () => {
  const { numberFormatMockDefaults } = await import('@/test/number-format-mock');
  return {
    useNumberFormat: () => ({ ...numberFormatMockDefaults(), defaultCurrency: 'CAD' }),
  };
});
const getRateForDateMock = vi.fn<(from: string, to: string, date: string) => Promise<number | null>>();
vi.mock('@/lib/exchange-rates', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/exchange-rates')>();
  return {
    ...actual,
    exchangeRatesApi: {
      ...actual.exchangeRatesApi,
      getRateForDate: (from: string, to: string, date: string) =>
        getRateForDateMock(from, to, date),
    },
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
    defaultCurrency: 'CAD',
  }),
}));
vi.mock('@/lib/investments', () => ({
  investmentsApi: {
    getSecurities: vi.fn(),
    getHoldings: vi.fn().mockResolvedValue([]),
    getHoldingAt: vi.fn().mockResolvedValue({ quantity: 0, averageCost: 0 }),
    createTransaction: vi.fn().mockResolvedValue({}),
    updateTransaction: vi.fn().mockResolvedValue({}),
    transferSecurity: vi.fn().mockResolvedValue({ transferOut: {}, transferIn: {} }),
    getTransaction: vi.fn(),
    getTransactions: vi.fn(),
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

const brokerage = {
  id: 'a1',
  name: 'RRSP Brokerage',
  accountType: 'INVESTMENT',
  accountSubType: 'INVESTMENT_BROKERAGE',
  currencyCode: 'CAD',
} as any;
const otherBrokerage = {
  id: 'a4',
  name: 'TFSA Brokerage',
  accountType: 'INVESTMENT',
  accountSubType: 'INVESTMENT_BROKERAGE',
  currencyCode: 'CAD',
} as any;
const chequing = {
  id: 'a2',
  name: 'Main Chequing',
  accountType: 'CHEQUING',
  accountSubType: null,
  currencyCode: 'CAD',
} as any;
const accounts = [brokerage, otherBrokerage, chequing];

const securities = [
  { id: 'sec-cad', symbol: 'XEQT', name: 'iShares Equity', securityType: 'ETF', currencyCode: 'CAD' },
  { id: 'sec-usd', symbol: 'AAPL', name: 'Apple Inc.', securityType: 'STOCK', currencyCode: 'USD' },
];

function row(overrides: Partial<InvestmentTransaction>): InvestmentTransaction {
  return {
    id: 'tx-src',
    accountId: 'a1',
    securityId: 'sec-cad',
    fundingAccountId: null,
    action: 'DIVIDEND',
    transactionDate: '2024-03-15',
    quantity: null,
    price: null,
    commission: null,
    totalAmount: 42.5,
    exchangeRate: 1,
    description: 'Q1 distribution',
    status: 'RECONCILED',
    linkedTransactionId: null,
    security: securities[0] as any,
    fundingAccount: null,
    createdAt: '2024-03-15T00:00:00Z',
    updatedAt: '2024-03-15T00:00:00Z',
    ...overrides,
  } as InvestmentTransaction;
}

function dateValue(): string | undefined {
  return document.querySelector<HTMLInputElement>('input[type="hidden"][name="transactionDate"]')?.value;
}

async function submit() {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Create Transaction' }));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  api.getSecurities.mockResolvedValue(securities as any);
  api.getTransactions.mockResolvedValue({
    data: [],
    pagination: { page: 1, limit: 5, total: 0, totalPages: 1, hasMore: false },
  } as any);
  getRateForDateMock.mockReset();
  getRateForDateMock.mockResolvedValue(null);
});

describe('duplicating an investment transaction', () => {
  it('creates a new row from the copy, dated today and unreconciled, and leaves the source alone', async () => {
    const source = row({ fundingAccountId: 'a2' });
    await act(async () => {
      render(<InvestmentTransactionForm accounts={accounts} duplicateFrom={source} />);
    });
    await waitFor(() => expect(screen.getByLabelText('Security')).toHaveValue('XEQT - iShares Equity (CAD)'));

    expect(dateValue()).toBe(getLocalDateString());
    expect(getSelectByLabel('Brokerage Account').value).toBe('a1');
    expect(screen.getByLabelText('Transaction Type')).toHaveValue('DIVIDEND');
    // An edit's button says Update; a duplicate is a create.
    expect(screen.getByRole('button', { name: 'Create Transaction' })).toBeInTheDocument();

    await submit();

    await waitFor(() => expect(api.createTransaction).toHaveBeenCalledTimes(1));
    expect(api.updateTransaction).not.toHaveBeenCalled();
    const payload = api.createTransaction.mock.calls[0][0] as any;
    expect(payload).toMatchObject({
      accountId: 'a1',
      action: 'DIVIDEND',
      securityId: 'sec-cad',
      fundingAccountId: 'a2',
      price: 42.5,
      transactionDate: getLocalDateString(),
      description: 'Q1 distribution',
      status: 'UNRECONCILED',
    });
  });

  it('copies a trade but looks up the rate for the new date rather than the source row', async () => {
    // The source settled at 1.30 on its own day; the copy is dated today, and
    // today's rate is what its cash leg moves at (INV-FX-001).
    getRateForDateMock.mockResolvedValue(1.4);
    const source = row({
      action: 'BUY',
      securityId: 'sec-usd',
      security: securities[1] as any,
      quantity: 10,
      price: 100,
      commission: 5,
      totalAmount: 1005,
      exchangeRate: 1.3,
    });
    await act(async () => {
      render(<InvestmentTransactionForm accounts={accounts} duplicateFrom={source} />);
    });
    await waitFor(() =>
      expect(getRateForDateMock).toHaveBeenCalledWith('USD', 'CAD', getLocalDateString()),
    );

    await submit();

    await waitFor(() => expect(api.createTransaction).toHaveBeenCalledTimes(1));
    const payload = api.createTransaction.mock.calls[0][0] as any;
    expect(payload).toMatchObject({
      action: 'BUY',
      securityId: 'sec-usd',
      quantity: 10,
      price: 100,
      commission: 5,
      totalAmount: 1005,
      exchangeRate: 1.4,
    });
  });

  it('turns a transfer leg into a new Transfer between the same two accounts', async () => {
    api.getTransaction.mockResolvedValue(row({ id: 'tx-in', accountId: 'a4', action: 'TRANSFER_IN' }));
    const source = row({
      action: 'TRANSFER_OUT',
      quantity: 3,
      price: 30,
      totalAmount: 90,
      linkedTransactionId: 'tx-in',
    });
    await act(async () => {
      render(<InvestmentTransactionForm accounts={accounts} duplicateFrom={source} />);
    });

    await waitFor(() => expect(getSelectByLabel('To Account').value).toBe('a4'));
    expect(api.getTransaction).toHaveBeenCalledWith('tx-in');
    expect(screen.getByLabelText('Transaction Type')).toHaveValue('TRANSFER');
    expect(getSelectByLabel('From Account').value).toBe('a1');
  });

  it('offers no history button: the copy already carries a row', async () => {
    await act(async () => {
      render(<InvestmentTransactionForm accounts={accounts} duplicateFrom={row({})} />);
    });
    expect(
      screen.queryByRole('button', { name: 'Show recent transactions for this account' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Show recent transactions for this security' }),
    ).not.toBeInTheDocument();
  });

  it('ignores the copy when editing', async () => {
    await act(async () => {
      render(
        <InvestmentTransactionForm
          accounts={accounts}
          transaction={row({ id: 'tx-edit', description: 'edited row' })}
          duplicateFrom={row({ id: 'tx-other', description: 'copied row' })}
        />,
      );
    });
    expect(screen.getByLabelText(/Memo|Description/)).toHaveValue('edited row');
    expect(screen.getByRole('button', { name: 'Update Transaction' })).toBeInTheDocument();
  });
});

describe('the history button on a new investment transaction', () => {
  async function openHistory(name: string) {
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name }));
    });
  }

  it('lists the account\'s recent rows, at the recent-transactions count, before a security is chosen', async () => {
    act(() => {
      usePreferencesStore.setState({
        preferences: { ...(usePreferencesStore.getState().preferences ?? {}), recentTransactionsLimit: 7 } as any,
      });
    });
    await act(async () => {
      render(<InvestmentTransactionForm accounts={accounts} defaultAccountId="a1" />);
    });

    await openHistory('Show recent transactions for this account');

    await waitFor(() => expect(api.getTransactions).toHaveBeenCalledTimes(1));
    expect(api.getTransactions).toHaveBeenCalledWith({
      accountIds: 'a1',
      securityId: undefined,
      limit: 7,
    });
    expect(await screen.findByText('No recent transactions.')).toBeInTheDocument();
  });

  it('narrows to the chosen security in the account', async () => {
    await act(async () => {
      render(<InvestmentTransactionForm accounts={accounts} defaultAccountId="a1" />);
    });
    await chooseComboboxOption('Security', 'XEQT - ');

    await openHistory('Show recent transactions for this security');

    await waitFor(() =>
      expect(api.getTransactions).toHaveBeenCalledWith(
        expect.objectContaining({ accountIds: 'a1', securityId: 'sec-cad' }),
      ),
    );
    expect(await screen.findByText('No recent transactions for this security.')).toBeInTheDocument();
  });

  it('fills the entry from a picked row but keeps the account and date on screen', async () => {
    api.getTransactions.mockResolvedValue({
      data: [
        row({
          id: 'tx-old',
          accountId: 'a4',
          fundingAccountId: 'a2',
          totalAmount: 61.25,
          description: 'Monthly distribution',
        }),
      ],
      pagination: { page: 1, limit: 5, total: 1, totalPages: 1, hasMore: false },
    } as any);
    await act(async () => {
      render(
        <InvestmentTransactionForm accounts={accounts} defaultAccountId="a1" defaultDate="2026-11-02" />,
      );
    });

    await openHistory('Show recent transactions for this account');
    const option = await screen.findByText('Monthly distribution');
    await act(async () => {
      fireEvent.click(option);
    });

    await waitFor(() => expect(screen.getByLabelText('Security')).toHaveValue('XEQT - iShares Equity (CAD)'));
    expect(screen.queryByRole('dialog', { name: 'Recent transactions' })).not.toBeInTheDocument();
    expect(screen.getByLabelText('Transaction Type')).toHaveValue('DIVIDEND');
    expect(getSelectByLabel('Brokerage Account').value).toBe('a1');
    expect(dateValue()).toBe('2026-11-02');

    await submit();

    await waitFor(() => expect(api.createTransaction).toHaveBeenCalledTimes(1));
    expect(api.createTransaction.mock.calls[0][0]).toMatchObject({
      accountId: 'a1',
      action: 'DIVIDEND',
      securityId: 'sec-cad',
      fundingAccountId: 'a2',
      price: 61.25,
      transactionDate: '2026-11-02',
      description: 'Monthly distribution',
      status: 'UNRECONCILED',
    });
  });

  it('says so when the history cannot be loaded, rather than showing an empty list', async () => {
    api.getTransactions.mockRejectedValue(new Error('offline'));
    await act(async () => {
      render(<InvestmentTransactionForm accounts={accounts} defaultAccountId="a1" />);
    });

    await openHistory('Show recent transactions for this account');

    expect(
      await screen.findByText('Could not load recent transactions. Try again.'),
    ).toBeInTheDocument();
    expect(screen.queryByText('No recent transactions.')).not.toBeInTheDocument();
  });

  it('is not offered when editing', async () => {
    await act(async () => {
      render(<InvestmentTransactionForm accounts={accounts} transaction={row({})} />);
    });
    expect(
      screen.queryByRole('button', { name: 'Show recent transactions for this security' }),
    ).not.toBeInTheDocument();
  });
});
