import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act, fireEvent, waitFor } from '@/test/render';
import { ScheduledTransactionForm } from './ScheduledTransactionForm';
import { clearCurrencyDecimals, registerCurrencyDecimals } from '@/lib/currency-decimals';
import { exchangeRatesApi } from '@/lib/exchange-rates';
import { scheduledTransactionsApi } from '@/lib/scheduled-transactions';
import toast from 'react-hot-toast';

// Issue #1581, the template form: editing a LINEAR mortgage installment
// (864.5833 + 306.0625 = 1,170.6458) loaded the amount in cents and the lines
// at 4dp, so saving the template, even for a description change, sent a
// cents parent over 4dp lines and was refused. The real `toSplitRows` and
// format helpers run here; the shared suite mocks both.

vi.mock('react-hot-toast', () => ({
  default: { success: vi.fn(), error: vi.fn() },
}));

vi.mock('@/hooks/useNumberFormat', async () => {
  const { numberFormatMockDefaults } = await import('@/test/number-format-mock');
  return { useNumberFormat: () => ({ ...numberFormatMockDefaults(), defaultCurrency: 'EUR' }) };
});

vi.mock('@/hooks/useDateFormat', () => ({
  useDateFormat: () => ({ formatDate: (d: string) => d, dateFormat: 'browser', datePattern: 'YYYY-MM-DD' }),
}));

vi.mock('@/lib/exchange-rates', () => ({
  exchangeRatesApi: {
    getRateForDate: vi.fn().mockResolvedValue(null),
    getCurrencies: vi.fn().mockResolvedValue([]),
  },
}));

vi.mock('@/components/transactions/CurrencyPickerButton', () => ({
  CurrencyPickerButton: () => <div data-testid="currency-picker" />,
}));

const mortgage = {
  id: 'mortgage-1',
  name: 'Mortgage',
  currencyCode: 'EUR',
  isClosed: false,
  accountType: 'MORTGAGE',
  accountSubType: null,
};
const main = {
  id: 'a1',
  name: 'Main',
  currencyCode: 'EUR',
  isClosed: false,
  accountType: 'CHEQUING',
  accountSubType: null,
};

const wallet = {
  // A uuid: the form's schema refuses any other account id.
  id: '33333333-3333-4333-8333-333333333333',
  name: 'Bitcoin Wallet',
  currencyCode: 'BTC',
  isClosed: false,
  accountType: 'CRYPTO',
  accountSubType: null,
};

vi.mock('@/lib/accounts', () => ({
  accountsApi: { getAll: vi.fn(async () => [main, mortgage, wallet]) },
}));
vi.mock('@/lib/categories', () => ({
  categoriesApi: { getAll: vi.fn().mockResolvedValue([]), create: vi.fn() },
}));
vi.mock('@/lib/payees', () => ({
  payeesApi: { getAll: vi.fn().mockResolvedValue([]), create: vi.fn(), getById: vi.fn() },
}));
vi.mock('@/lib/tags', () => ({
  tagsApi: { getAll: vi.fn().mockResolvedValue([]), getUsage: vi.fn().mockResolvedValue({}), create: vi.fn() },
}));
vi.mock('@/lib/scheduled-transactions', () => ({
  scheduledTransactionsApi: { create: vi.fn(), update: vi.fn() },
}));
vi.mock('@/lib/investments', () => ({
  investmentsApi: { getSecurities: vi.fn().mockResolvedValue([]), getSecurityPrices: vi.fn().mockResolvedValue([]) },
}));
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() }),
}));

vi.mock('@/components/transactions/SplitEditor', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/components/transactions/SplitEditor')>()),
  SplitEditor: ({ splits, transactionAmount }: any) => (
    <div data-testid="split-editor">
      <span data-testid="parent">{transactionAmount}</span>
      {splits.map((s: any) => (
        <span key={s.id} data-testid="line">{s.amount}</span>
      ))}
    </div>
  ),
}));

const linearInstallment = {
  id: 's1',
  name: 'Mortgage payment',
  accountId: 'a1',
  account: main,
  payeeId: null,
  payeeName: null,
  categoryId: null,
  amount: -1170.6458,
  currencyCode: 'EUR',
  description: '',
  frequency: 'MONTHLY',
  nextDueDate: '2026-11-01',
  startDate: '2026-01-01',
  endDate: null,
  occurrencesRemaining: null,
  isActive: true,
  autoPost: false,
  reminderDaysBefore: 3,
  isTransfer: false,
  isSplit: true,
  tagIds: [],
  splits: [
    {
      id: '11111111-1111-4111-8111-111111111111',
      transferAccountId: null,
      transferAccount: null,
      categoryId: 'cat-interest',
      amount: -306.0625,
      memo: 'Interest',
    },
    {
      id: '22222222-2222-4222-8222-222222222222',
      transferAccountId: 'mortgage-1',
      transferAccount: mortgage,
      categoryId: null,
      amount: -864.5833,
      memo: 'Principal',
    },
  ],
} as any;

describe('ScheduledTransactionForm: a template priced below the cent (issue #1581)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('loads the lines and the amount in the same unit, the cent on the principal line', async () => {
    await act(async () => {
      render(<ScheduledTransactionForm scheduledTransaction={linearInstallment} />);
    });
    expect(screen.getByTestId('parent')).toHaveTextContent('-1170.65');
    expect(screen.getAllByTestId('line').map((el) => el.textContent)).toEqual(['-306.06', '-864.59']);
  });
});

describe('ScheduledTransactionForm: a coin schedule', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('loads and enters an eight-place coin amount at its eight places, not cents', async () => {
    registerCurrencyDecimals([{ code: 'BTC', decimalPlaces: 8 }]);
    try {
      await act(async () => {
        render(
          <ScheduledTransactionForm
            scheduledTransaction={{
              ...linearInstallment,
              accountId: 'wallet-1',
              account: null,
              amount: -0.000025,
              currencyCode: 'BTC',
              isSplit: false,
              splits: [],
            }}
          />,
        );
      });
      // Loaded at cents this read -0.00, and an unedited save sent 0 back.
      expect(screen.getByLabelText('Amount')).toHaveValue('-0.00002500');
    } finally {
      await act(async () => clearCurrencyDecimals());
    }
  });

  it('keeps a foreign amount in a coin at the coin\'s places, not cents', async () => {
    registerCurrencyDecimals([{ code: 'BTC', decimalPlaces: 8 }]);
    vi.mocked(exchangeRatesApi.getRateForDate).mockResolvedValue(50000);
    try {
      await act(async () => {
        render(
          <ScheduledTransactionForm
            scheduledTransaction={{
              ...linearInstallment,
              amount: -255,
              originalAmount: -0.0051,
              originalCurrencyCode: 'BTC',
              exchangeRate: 50000,
              isSplit: false,
              splits: [],
            }}
          />,
        );
      });
      const foreign = screen.getByLabelText('Amount in BTC');
      expect(foreign).toHaveValue('-0.00510000');
      await act(async () => {
        fireEvent.change(foreign, { target: { value: '-0.0073' } });
        fireEvent.blur(foreign);
      });
      // `handleForeignAmountChange` rounded the typed amount to cents, -0.01,
      // and converted that: -500 EUR rather than -0.0073 x 50000 = -365.
      await waitFor(() => expect(screen.getByText(/-365(\.00)?\b/)).toBeInTheDocument());
      expect(screen.queryByText(/-500(\.00)?\b/)).not.toBeInTheDocument();
    } finally {
      await act(async () => clearCurrencyDecimals());
    }
  });

  describe('a split whose lines miss the amount by less than a cent', () => {
    const coinSplit = (second: number) => ({
      ...linearInstallment,
      accountId: wallet.id,
      account: wallet,
      amount: -0.005025,
      currencyCode: 'BTC',
      splits: [
        { ...linearInstallment.splits[0], amount: -0.005 },
        { ...linearInstallment.splits[1], transferAccountId: null, transferAccount: null, categoryId: 'cat-fee', amount: second },
      ],
    });

    async function save(scheduled: unknown) {
      const { container } = render(<ScheduledTransactionForm scheduledTransaction={scheduled as any} />);
      await act(async () => {});
      await act(async () => {
        fireEvent.click(container.querySelector('button[type="submit"]') as HTMLButtonElement);
      });
      await act(async () => {});
    }

    it('refuses a one-satoshi remainder, as the server would', async () => {
      registerCurrencyDecimals([{ code: 'BTC', decimalPlaces: 8 }]);
      try {
        await save(coinSplit(-0.00002499));
        // At four places (and under a one-cent tolerance) this saved, and the
        // server refused it.
        expect(toast.error).toHaveBeenCalledWith('Split amounts must equal the transaction amount');
        expect(scheduledTransactionsApi.update).not.toHaveBeenCalled();
      } finally {
        await act(async () => clearCurrencyDecimals());
      }
    });

    it('saves -0.00502500 as a -0.00500000 line and a -0.00002500 fee', async () => {
      registerCurrencyDecimals([{ code: 'BTC', decimalPlaces: 8 }]);
      vi.mocked(scheduledTransactionsApi.update).mockResolvedValue({} as never);
      try {
        await save(coinSplit(-0.000025));
        expect(toast.error).not.toHaveBeenCalledWith('Split amounts must equal the transaction amount');
        await waitFor(() => expect(scheduledTransactionsApi.update).toHaveBeenCalled());
      } finally {
        await act(async () => clearCurrencyDecimals());
      }
    });
  });
});
