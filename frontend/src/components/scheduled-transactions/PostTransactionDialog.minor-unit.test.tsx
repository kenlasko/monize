import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@/test/render';
import { PostTransactionDialog } from './PostTransactionDialog';
import { clearCurrencyDecimals, registerCurrencyDecimals } from '@/lib/currency-decimals';
import toast from 'react-hot-toast';
import { exchangeRatesApi } from '@/lib/exchange-rates';

// Issue #1581: a LINEAR mortgage installment is priced at storage precision
// (864.5833 principal + 306.0625 interest = 1,170.6458). The dialog rounded the
// parent to 1,170.65 but sent the 4dp lines, and the server refused the post:
// "Split amounts (-1170.6458) must equal transaction amount (-1170.65)". The
// real `toSplitRows` and format helpers run here; the shared dialog suite mocks
// both.

vi.mock('react-hot-toast', () => ({
  default: { success: vi.fn(), error: vi.fn() },
}));

const mockPostApi = vi.fn().mockResolvedValue({});
vi.mock('@/lib/scheduled-transactions', () => ({
  scheduledTransactionsApi: {
    post: (...args: any[]) => mockPostApi(...args),
    // The loan projection that previews the post is still pending: these cases
    // are about the template's own pre-fill. PostTransactionDialog.loan.test.tsx
    // covers the priced preview.
    getLoanOccurrences: () => new Promise(() => {}),
  },
}));

vi.mock('@/lib/investments', () => ({
  investmentsApi: { getSecurityPrices: vi.fn().mockResolvedValue([]) },
}));

vi.mock('@/lib/exchange-rates', () => ({
  exchangeRatesApi: { getRateForDate: vi.fn().mockResolvedValue(null) },
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }),
}));

vi.mock('@/hooks/useDateFormat', () => ({
  useDateFormat: () => ({ formatDate: (d: string) => d, dateFormat: 'browser', datePattern: 'YYYY-MM-DD' }),
}));

vi.mock('@/hooks/useNumberFormat', async () => {
  const { numberFormatMockDefaults } = await import('@/test/number-format-mock');
  return { useNumberFormat: () => numberFormatMockDefaults() };
});

vi.mock('@/lib/forecast', () => ({
  getProjectedBalanceAtDate: (account: any) => Number(account.currentBalance) || 0,
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

const mortgage = { id: 'mortgage-1', name: 'Mortgage', accountType: 'MORTGAGE', currentBalance: -61212.5 };
const checking = { id: 'a1', name: 'Main', accountType: 'CHEQUING', currentBalance: 5000 };

const linearInstallment = (currencyCode: string) =>
  ({
    id: 's1',
    name: 'Mortgage payment',
    amount: -1170.6458,
    currencyCode,
    accountId: 'a1',
    categoryId: null,
    description: '',
    nextDueDate: '2026-11-01T00:00:00Z',
    isTransfer: false,
    isSplit: true,
    account: { name: 'Main' },
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
  }) as any;

const renderDialog = (currencyCode: string, overrides: Record<string, unknown> = {}) =>
  render(
    <PostTransactionDialog
      isOpen
      scheduledTransaction={{ ...linearInstallment(currencyCode), ...overrides }}
      categories={[{ id: 'cat-interest', name: 'Mortgage Interest', parentId: null }] as any[]}
      accounts={[checking, mortgage] as any[]}
      scheduledTransactions={[]}
      futureTransactions={[]}
      onClose={vi.fn()}
      onPosted={vi.fn()}
    />,
  );

const post = async () => {
  const buttons = screen.getAllByText('Post Transaction');
  fireEvent.click(buttons[buttons.length - 1]);
  await waitFor(() => expect(mockPostApi).toHaveBeenCalled());
  return mockPostApi.mock.calls[0][1];
};

describe('PostTransactionDialog: a bill priced below the cent (issue #1581)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('pre-fills lines that sum to the amount shown, the cent on the principal line', () => {
    renderDialog('EUR');
    expect(screen.getByTestId('parent')).toHaveTextContent('-1170.65');
    expect(screen.getAllByTestId('line').map((el) => el.textContent)).toEqual(['-306.06', '-864.59']);
  });

  it('posts the parent and the lines in the same unit', async () => {
    renderDialog('EUR');
    const payload = await post();
    expect(payload.amount).toBe(-1170.65);
    expect(payload.splits.map((s: any) => [s.sourceSplitId, s.amount])).toEqual([
      ['11111111-1111-4111-8111-111111111111', -306.06],
      ['22222222-2222-4222-8222-222222222222', -864.59],
    ]);
  });

  it('leaves an override that changed only the amount unbalanced for the user to settle', () => {
    // An occurrence override of 1,500 that never touched the lines: the
    // 329.35 gap is not a rounding difference, so it is not pushed onto the
    // principal line behind the user's back.
    renderDialog('EUR', {
      nextOverride: { amount: -1500, isSplit: null, splits: null, overrideDate: null },
    });
    expect(screen.getByTestId('parent')).toHaveTextContent('-1500');
    expect(screen.getAllByTestId('line').map((el) => el.textContent)).toEqual(['-306.06', '-864.58']);
  });

  it('books whole units for a currency without a minor unit', async () => {
    renderDialog('JPY');
    const payload = await post();
    expect(payload.amount).toBe(-1171);
    expect(payload.splits.map((s: any) => s.amount)).toEqual([-306, -865]);
  });
});

describe('PostTransactionDialog: a coin account', () => {
  const coinBill = (overrides: Record<string, unknown> = {}) =>
    ({
      id: 's-btc',
      name: 'Node hosting',
      amount: -0.000025,
      currencyCode: 'BTC',
      accountId: 'a1',
      categoryId: null,
      description: '',
      nextDueDate: '2026-11-01T00:00:00Z',
      isTransfer: false,
      isSplit: false,
      account: { name: 'Wallet' },
      ...overrides,
    }) as any;

  const renderCoin = (overrides: Record<string, unknown> = {}) =>
    render(
      <PostTransactionDialog
        isOpen
        scheduledTransaction={coinBill(overrides)}
        categories={[]}
        accounts={[{ ...checking, name: 'Wallet', currencyCode: 'BTC', currentBalance: 0.5 }] as any[]}
        scheduledTransactions={[]}
        futureTransactions={[]}
        onClose={vi.fn()}
        onPosted={vi.fn()}
      />,
    );

  beforeEach(() => {
    vi.clearAllMocks();
    registerCurrencyDecimals([{ code: 'BTC', decimalPlaces: 8, symbol: '₿' }]);
  });

  afterEach(async () => {
    await act(async () => clearCurrencyDecimals());
  });

  const saleSplits = (feeAmount: number) => [
    { id: '11111111-1111-4111-8111-111111111111', transferAccountId: null, transferAccount: null, categoryId: 'cat-a', amount: -0.005, memo: '' },
    { id: '22222222-2222-4222-8222-222222222222', transferAccountId: null, transferAccount: null, categoryId: 'cat-b', amount: feeAmount, memo: '' },
  ];

  it('refuses to post split lines that miss the amount by one satoshi, as the server would', async () => {
    renderCoin({ amount: -0.005025, isSplit: true, splits: saleSplits(-0.00002499) });
    const buttons = screen.getAllByText('Post Transaction');
    await act(async () => {
      fireEvent.click(buttons[buttons.length - 1]);
    });
    // At four places both sides read -0.0050 and this posted; the server refused it.
    expect(toast.error).toHaveBeenCalledWith('Split amounts must equal the transaction amount');
    expect(mockPostApi).not.toHaveBeenCalled();
  });

  it('posts -0.00502500 split into -0.00500000 and a -0.00002500 fee', async () => {
    renderCoin({ amount: -0.005025, isSplit: true, splits: saleSplits(-0.000025) });
    await post();
    expect(toast.error).not.toHaveBeenCalledWith('Split amounts must equal the transaction amount');
  });

  it('posts a typed 0.00002500 BTC as 0.00002500, not cents', async () => {
    renderCoin({ amount: -0.02 });
    const amount = screen.getByLabelText('Amount');
    await act(async () => {
      fireEvent.change(amount, { target: { value: '-0.00002500' } });
      fireEvent.blur(amount);
    });
    expect(amount).toHaveValue('-0.00002500');
    const payload = await post();
    expect(payload.amount).toBe(-0.000025);
  });

  it('posts an unedited 0.00002500 BTC as 0.00002500 when the currency list arrives after the dialog opened', async () => {
    // Seeded before the registry knew BTC: kept at the column scale, not
    // rounded at an assumed two, so the late fill has nothing to recover.
    await act(async () => clearCurrencyDecimals());
    renderCoin();
    await act(async () => {
      registerCurrencyDecimals([{ code: 'BTC', decimalPlaces: 8, symbol: '₿' }]);
    });
    expect(screen.getByLabelText('Amount')).toHaveValue('-0.00002500');
    const payload = await post();
    expect(payload.amount).toBe(-0.000025);
  });

  it('re-converts at the coin\'s places when the currency list arrives after the dialog opened', async () => {
    // `GET /currencies` answering late: the registry is empty when the dialog
    // converts, so the total starts at the column scale (never cents, which
    // read -0.00), and the fill must redraw it at the coin's own.
    await act(async () => clearCurrencyDecimals());
    vi.mocked(exchangeRatesApi.getRateForDate).mockResolvedValue(0.0000098);
    renderCoin({ originalAmount: -510, originalCurrencyCode: 'USD', exchangeRate: 0.0000098 });
    const total = screen.getByLabelText('Total in BTC');
    await waitFor(() => expect(total).toHaveValue('-0.00499800'));
    await act(async () => {
      registerCurrencyDecimals([{ code: 'BTC', decimalPlaces: 3, symbol: '₿' }]);
    });
    await waitFor(() => expect(total).toHaveValue('-0.005'));
  });

  it('converts a foreign bill into the coin at the coin\'s places', async () => {
    // 510 USD at 0.0000098 BTC/USD is 0.00499800 BTC; at four places it read 0.0050.
    vi.mocked(exchangeRatesApi.getRateForDate).mockResolvedValue(0.0000098);
    renderCoin({ originalAmount: -510, originalCurrencyCode: 'USD', exchangeRate: 0.0000098 });
    const total = screen.getByLabelText('Total in BTC');
    await waitFor(() => expect(total).toHaveValue('-0.00499800'));
    const payload = await post();
    expect(payload.originalAmount).toBe(-510);
    expect(payload.amount).toBeUndefined();
  });
});
