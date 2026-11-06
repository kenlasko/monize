import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act, cleanup } from '@/test/render';
import { chooseComboboxOption } from '@/test/combobox';
import { InvestmentTransactionForm } from './InvestmentTransactionForm';
import { investmentsApi } from '@/lib/investments';
import { getLocalDateString } from '@/lib/utils';
import {
  INVESTMENT_TRANSACTION_SUBMIT_MODE_KEY,
  TRANSACTION_SUBMIT_MODE_KEY,
} from '@/hooks/useTransactionSubmitMode';
import toast from 'react-hot-toast';
import { usePreferencesStore } from '@/store/preferencesStore';

// A case about the reader's own number locale switches this on and sets the
// preferences store; every other case keeps the deterministic en-US stand-in.
const realNumberFormat = vi.hoisted(() => ({ on: false }));

vi.mock('@/hooks/useNumberFormat', async (importOriginal) => {
  const { numberFormatMockDefaults } = await import('@/test/number-format-mock');
  const actual = await importOriginal<typeof import('@/hooks/useNumberFormat')>();
  return {
    useNumberFormat: () => {
      // Called every render either way so the hook order never changes.
      const real = actual.useNumberFormat();
      if (realNumberFormat.on) return real;
      return {
        ...numberFormatMockDefaults(),
        defaultCurrency: 'CAD',
        formatCurrency: (n: number, c?: string) =>
          c ? `${c} $${n.toFixed(2)}` : `$${n.toFixed(2)}`,
      };
    },
  };
});
const getMarketRateMock = vi.fn<(from: string, to: string) => number | null>(
  () => null,
);

// The dated lookup the form prefills from. By default it answers what
// `getMarketRateMock` says, so a test about something else needs one mock; a
// test about the trade date overrides it and leaves `getMarketRateMock` (the
// latest rate, which the form must not read) pointing somewhere else.
const getRateForDateMock = vi.fn<(from: string, to: string, date: string) => Promise<number | null>>();
const delegateToMarketRate = (from: string, to: string) =>
  Promise.resolve(getMarketRateMock(from, to));

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
    getRate: getMarketRateMock,
    rates: [],
    rateMap: new Map(),
    isLoading: false,
    convert: (amount: number) => amount,
    convertToDefault: (amount: number) => amount,
    refresh: vi.fn(),
    defaultCurrency: 'CAD',
  }),
}));

// Real money and rate helpers: this form's subject is cross-currency
// arithmetic, and a mock that rounds rates like money is the very defect being
// fixed here.
vi.mock('@/lib/format', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/format')>();
  return { ...actual, getCurrencySymbol: () => '$' };
});

vi.mock('@/lib/investments', () => ({
  investmentsApi: {
    getSecurities: vi.fn().mockResolvedValue([
      { id: 'sec-1', symbol: 'AAPL', name: 'Apple Inc.', securityType: 'STOCK', currencyCode: 'USD' },
    ]),
    getHoldings: vi.fn().mockResolvedValue([]),
    getHoldingAt: vi.fn().mockResolvedValue({ quantity: 0, averageCost: 0 }),
    createSecurity: vi.fn().mockResolvedValue({ id: 'new-sec', symbol: 'TEST', name: 'Test Corp' }),
    createTransaction: vi.fn().mockResolvedValue({}),
    updateTransaction: vi.fn().mockResolvedValue({}),
    transferSecurity: vi.fn().mockResolvedValue({ transferOut: {}, transferIn: {} }),
    getTransaction: vi.fn().mockResolvedValue({}),
  },
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() }),
}));

vi.mock('@hookform/resolvers/zod', () => ({
  zodResolver: () => async (data: any) => ({ values: data, errors: {} }),
}));

vi.mock('react-hot-toast', () => ({
  default: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('@/lib/errors', () => ({
  getErrorMessage: (_e: any, fallback: string) => fallback,
  getErrorCode: () => undefined,
}));

vi.mock('@/components/securities/SecurityForm', () => ({
  SecurityForm: ({ defaults, onSubmit, onCancel }: { defaults?: unknown; onSubmit: (data: any) => Promise<void>; onCancel: () => void }) => (
    <div data-testid="security-form-modal" data-defaults={JSON.stringify(defaults)}>
      <button onClick={() => { onSubmit({ symbol: 'TEST', name: 'Test Corp', securityType: 'STOCK', currencyCode: 'CAD' }).catch(() => {}); }}>
        Create Security
      </button>
      <button onClick={onCancel}>Cancel</button>
    </div>
  ),
}));

/**
 * Pick a security by id. The Security field lists each one by its symbol, and
 * the fixtures differ by case, so the symbol is read from what the form was
 * given: the last list `getSecurities` answered with.
 */
async function chooseSecurity(id: string) {
  await waitFor(() => expect(investmentsApi.getSecurities).toHaveBeenCalled());
  const { results } = vi.mocked(investmentsApi.getSecurities).mock;
  const listed = (await results[results.length - 1].value) as { id: string; symbol: string }[];
  const security = listed.find((s) => s.id === id);
  if (!security) throw new Error(`No security ${id} in the getSecurities fixture`);
  await chooseComboboxOption('Security', `${security.symbol} - `);
}

/** The date the form will submit: DateInput keeps it in a hidden input, while
 *  the visible box renders it in whatever pattern the user prefers. */
function canonicalDateValue(): string | undefined {
  return document.querySelector<HTMLInputElement>('input[type="hidden"][name="transactionDate"]')?.value;
}

describe('InvestmentTransactionForm', () => {
  const brokerageAccount = {
    id: 'a1',
    name: 'RRSP Brokerage',
    accountType: 'INVESTMENT',
    accountSubType: 'INVESTMENT_BROKERAGE',
    currencyCode: 'CAD',
  } as any;

  const chequingAccount = {
    id: 'a2',
    name: 'Main Chequing',
    accountType: 'CHEQUING',
    accountSubType: null,
    currencyCode: 'CAD',
  } as any;

  const cashAccount = {
    id: 'a3',
    name: 'Cash Account',
    accountType: 'CASH',
    accountSubType: null,
    currencyCode: 'CAD',
  } as any;

  const accounts = [brokerageAccount, chequingAccount, cashAccount];

  beforeEach(() => {
    vi.clearAllMocks();
    // A case that lists other securities must not leak them into the next:
    // the Security field shows what it was given, by symbol.
    vi.mocked(investmentsApi.getSecurities).mockResolvedValue([
      { id: 'sec-1', symbol: 'AAPL', name: 'Apple Inc.', securityType: 'STOCK', currencyCode: 'USD' } as any,
    ]);
    realNumberFormat.on = false;
    getMarketRateMock.mockReset();
    getMarketRateMock.mockReturnValue(null);
    getRateForDateMock.mockReset();
    getRateForDateMock.mockImplementation(delegateToMarketRate);
  });

  it('renders form fields', async () => {
    render(<InvestmentTransactionForm accounts={accounts} />);
    await waitFor(() => {
      expect(screen.getByText('Brokerage Account')).toBeInTheDocument();
    });
    expect(screen.getByText('Transaction Type')).toBeInTheDocument();
    expect(screen.getByText('Date')).toBeInTheDocument();
  });

  describe('defaultDate', () => {
    it('opens a new trade on the day the caller named', async () => {
      // The calendar's "New investment transaction on this day" means the day
      // the reader clicked, not the date the last entry was filed under.
      render(<InvestmentTransactionForm accounts={accounts} defaultDate="2026-03-07" />);

      await waitFor(() => {
        // The field shows the reader's own date format; the value it carries
        // is the day the caller named.
        expect((screen.getByLabelText('Date') as HTMLInputElement).value).toBe('03/07/2026');
      });
    });

    it("leaves an edit on the row's own date", async () => {
      const transaction = {
        id: 't1', accountId: 'a1', action: 'BUY' as const, transactionDate: '2024-01-01',
        quantity: 10, price: 50, commission: 5, totalAmount: 505, description: '',
      } as any;

      render(
        <InvestmentTransactionForm
          accounts={accounts}
          transaction={transaction}
          defaultDate="2026-03-07"
        />,
      );

      await waitFor(() => {
        expect((screen.getByLabelText('Date') as HTMLInputElement).value).toBe('01/01/2024');
      });
    });
  });

  it('shows Create Transaction button for new form', async () => {
    render(<InvestmentTransactionForm accounts={accounts} />);
    await waitFor(() => {
      expect(screen.getByText('Create Transaction')).toBeInTheDocument();
    });
  });

  it('shows Update Transaction button for editing', async () => {
    const transaction = {
      id: 't1', accountId: 'a1', action: 'BUY' as const, transactionDate: '2024-01-01',
      quantity: 10, price: 50, commission: 5, totalAmount: 505, description: '',
    } as any;

    render(<InvestmentTransactionForm accounts={accounts} transaction={transaction} />);
    await waitFor(() => {
      expect(screen.getByText('Update Transaction')).toBeInTheDocument();
    });
  });

  it('renders cancel button when onCancel provided', async () => {
    const onCancel = vi.fn();
    render(<InvestmentTransactionForm accounts={accounts} onCancel={onCancel} />);
    await waitFor(() => {
      expect(screen.getByText('Cancel')).toBeInTheDocument();
    });
  });

  it('only shows brokerage accounts in account dropdown', async () => {
    render(<InvestmentTransactionForm accounts={accounts} />);
    await waitFor(() => {
      const select = screen.getByLabelText('Brokerage Account');
      const options = select.querySelectorAll('option');
      // "Select account..." + "RRSP Brokerage" only (no chequing, no cash)
      expect(options).toHaveLength(2);
      expect(options[1].textContent).toBe('RRSP Brokerage (CAD)');
    });
  });

  it('renders action types in dropdown, offering a single Transfer option', async () => {
    render(<InvestmentTransactionForm accounts={accounts} />);
    await waitFor(() => {
      const select = screen.getByLabelText('Transaction Type');
      const optionValues = Array.from(
        select.querySelectorAll('option'),
      ).map((o) => o.getAttribute('value'));
      // The raw TRANSFER_IN/TRANSFER_OUT legs are hidden when creating; a
      // single combined TRANSFER option is offered instead.
      expect(optionValues).not.toContain('TRANSFER_IN');
      expect(optionValues).not.toContain('TRANSFER_OUT');
      expect(optionValues).toContain('TRANSFER');
      // Money's full distribution vocabulary is offered too (issue #1149).
      expect(optionValues).toContain('REINVEST_INTEREST');
      expect(optionValues).toContain('REINVEST_CAPITAL_GAIN_SHORT');
      expect(optionValues).toContain('REINVEST_CAPITAL_GAIN_LONG');
      expect(optionValues).toContain('CAPITAL_GAIN_SHORT');
      expect(optionValues).toContain('CAPITAL_GAIN_LONG');
      expect(optionValues).toContain('REDEEM');
      // Money's Return of Capital activity (issue #1800).
      expect(optionValues).toContain('RETURN_OF_CAPITAL');
      expect(optionValues.length).toBe(17);
    });
  });

  it('shows security select for BUY action', async () => {
    vi.mocked(investmentsApi.getSecurities).mockResolvedValue([
      { id: 'sec-1', symbol: 'AAPL', name: 'Apple Inc.', securityType: 'STOCK', currencyCode: 'USD' } as any,
    ]);

    render(<InvestmentTransactionForm accounts={accounts} />);
    // Default action is BUY, which needs security
    await waitFor(() => {
      expect(screen.getByText('Security')).toBeInTheDocument();
    });
  });

  /** Type into the Security field and pick its "+ Create" row. */
  async function createSecurityFromField(text: string) {
    const input = await screen.findByLabelText('Security');
    await act(async () => {
      fireEvent.change(input, { target: { value: text } });
    });
    await act(async () => {
      fireEvent.click(screen.getByText(`Create "${text}"`));
    });
  }

  it('offers "+ Create" inside the Security field, not as a separate link', async () => {
    render(<InvestmentTransactionForm accounts={accounts} />);
    const input = await screen.findByLabelText('Security');
    expect(screen.queryByText('+ Add new security')).not.toBeInTheDocument();
    expect(input).toHaveAttribute('placeholder', 'Select or create security...');
    await act(async () => {
      fireEvent.change(input, { target: { value: 'NEWCO' } });
    });
    expect(screen.getByText('Create "NEWCO"')).toBeInTheDocument();
  });

  it('opens the new-security form with a typed ticker as its symbol', async () => {
    render(<InvestmentTransactionForm accounts={accounts} />);
    await createSecurityFromField('newco');

    expect(screen.getByTestId('security-form-modal')).toHaveAttribute(
      'data-defaults',
      JSON.stringify({ symbol: 'NEWCO' }),
    );
    expect(screen.getByText('New Security')).toBeInTheDocument();

    // Close modal via cancel
    fireEvent.click(screen.getByText('Cancel'));
    await waitFor(() => {
      expect(screen.queryByTestId('security-form-modal')).not.toBeInTheDocument();
    });
  });

  it('opens the new-security form with typed words as its name', async () => {
    render(<InvestmentTransactionForm accounts={accounts} />);
    await createSecurityFromField('New Fund Co');

    expect(screen.getByTestId('security-form-modal')).toHaveAttribute(
      'data-defaults',
      JSON.stringify({ name: 'New Fund Co' }),
    );
  });

  it('handles create security success', async () => {
    render(<InvestmentTransactionForm accounts={accounts} />);
    await createSecurityFromField('TEST');

    // Submit the mocked SecurityForm
    fireEvent.click(screen.getByText('Create Security'));

    await waitFor(() => {
      expect(investmentsApi.createSecurity).toHaveBeenCalledWith({
        symbol: 'TEST', name: 'Test Corp', securityType: 'STOCK', currencyCode: 'CAD',
      });
      expect(toast.success).toHaveBeenCalledWith('Security created');
    });

    // Modal should close after success, with the new security selected
    expect(screen.queryByTestId('security-form-modal')).not.toBeInTheDocument();
    await waitFor(() => {
      expect((screen.getByLabelText('Security') as HTMLInputElement).value).toMatch(/^TEST - Test Corp/);
    });
  });

  it('handles create security failure', async () => {
    vi.mocked(investmentsApi.createSecurity).mockRejectedValueOnce(new Error('API error'));

    render(<InvestmentTransactionForm accounts={accounts} />);
    await createSecurityFromField('TEST');

    // Submit the mocked SecurityForm (will trigger API error)
    fireEvent.click(screen.getByText('Create Security'));

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Failed to create security');
    });

    // Modal should stay open on failure
    expect(screen.getByTestId('security-form-modal')).toBeInTheDocument();
  });

  it('puts Quantity, Price per Share and Commission / Fees on one line', async () => {
    render(<InvestmentTransactionForm accounts={accounts} />);
    const quantity = await screen.findByLabelText('Quantity (Shares)');
    const row = quantity.closest('.grid') as HTMLElement;
    expect(row).toHaveClass('sm:grid-cols-3');
    expect(row).toContainElement(screen.getByLabelText('Price per Share'));
    expect(row).toContainElement(screen.getByLabelText('Commission / Fees'));
  });

  it('keeps the Total Amount summary short: less padding above and below than beside', async () => {
    render(<InvestmentTransactionForm accounts={accounts} />);
    const summary = await screen.findByTestId('total-amount-summary');
    expect(summary).toHaveClass('px-4', 'py-2.5');
    expect(summary).not.toHaveClass('p-4');
  });

  it('shows description field', async () => {
    render(<InvestmentTransactionForm accounts={accounts} />);
    await waitFor(() => {
      expect(screen.getByText('Description (optional)')).toBeInTheDocument();
    });
  });

  it('uses defaultAccountId when provided', async () => {
    render(<InvestmentTransactionForm accounts={accounts} defaultAccountId="a1" />);
    await waitFor(() => {
      const select = screen.getByLabelText('Brokerage Account');
      expect((select as HTMLSelectElement).value).toBe('a1');
    });
  });

  it('renders with editing transaction that has DIVIDEND action', async () => {
    const transaction = {
      id: 't1', accountId: 'a1', action: 'DIVIDEND' as const, transactionDate: '2024-06-15',
      quantity: null, price: null, commission: 0, totalAmount: 250, description: 'Q2 Dividend',
      securityId: 'sec-1',
    } as any;

    render(<InvestmentTransactionForm accounts={accounts} transaction={transaction} />);
    await waitFor(() => {
      expect(screen.getByText('Update Transaction')).toBeInTheDocument();
    });
  });

  it('shows funding account select for BUY action', async () => {
    render(<InvestmentTransactionForm accounts={accounts} />);
    await waitFor(() => {
      // Default action is BUY which supports funding account
      expect(screen.getByText('Funds From')).toBeInTheDocument();
    });
  });

  it('filters out CASH, ASSET, CRYPTO, and brokerage accounts from funding accounts', async () => {
    const investmentCash = {
      id: 'a4', name: 'RRSP Cash', accountType: 'INVESTMENT',
      accountSubType: 'INVESTMENT_CASH', currencyCode: 'CAD',
    } as any;
    const wallet = {
      id: 'a5', name: 'Bitcoin Wallet', accountType: 'CRYPTO',
      accountSubType: null, currencyCode: 'BTC',
    } as any;

    render(<InvestmentTransactionForm accounts={[...accounts, investmentCash, wallet]} />);
    await waitFor(() => {
      const fundingSelect = screen.getByLabelText('Funds From');
      const options = fundingSelect.querySelectorAll('option');
      const optionTexts = Array.from(options).map(o => o.textContent);
      expect(optionTexts).not.toContain('Cash Account');
      expect(optionTexts).not.toContain('RRSP Brokerage');
      expect(optionTexts.some((text) => text?.includes('Bitcoin Wallet'))).toBe(false);
      expect(optionTexts).toContain('Main Chequing');
      expect(optionTexts).toContain('RRSP Cash');
    });
  });

  it('loads securities on mount', async () => {
    render(<InvestmentTransactionForm accounts={accounts} />);
    await waitFor(() => {
      expect(investmentsApi.getSecurities).toHaveBeenCalled();
    });
  });

  it('handles security load failure gracefully', async () => {
    vi.mocked(investmentsApi.getSecurities).mockRejectedValueOnce(new Error('Network error'));
    render(<InvestmentTransactionForm accounts={accounts} />);
    // Should still render form without crashing
    await waitFor(() => {
      expect(screen.getByText('Brokerage Account')).toBeInTheDocument();
    });
  });

  it('shows Deposit To select for DIVIDEND action', async () => {
    render(<InvestmentTransactionForm accounts={accounts} />);
    await waitFor(() => {
      expect(screen.getByText('Brokerage Account')).toBeInTheDocument();
    });
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Transaction Type'), {
        target: { value: 'DIVIDEND' },
      });
    });
    await waitFor(() => {
      expect(screen.getByLabelText('Deposit to')).toBeInTheDocument();
    });
    expect(screen.queryByText('Funds From')).not.toBeInTheDocument();
  });

  it('offers accrued interest for REDEEM and for no other action', async () => {
    // The field is keyed on the raw action, not its base: REDEEM normalizes to
    // SELL, and the backend refuses accrued interest on a sale.
    render(<InvestmentTransactionForm accounts={accounts} />);
    await waitFor(() => {
      expect(screen.getByText('Brokerage Account')).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.change(screen.getByLabelText('Transaction Type'), {
        target: { value: 'SELL' },
      });
    });
    expect(
      screen.queryByLabelText(/Accrued Interest/),
    ).not.toBeInTheDocument();

    await act(async () => {
      fireEvent.change(screen.getByLabelText('Transaction Type'), {
        target: { value: 'REDEEM' },
      });
    });
    await waitFor(() => {
      expect(screen.getByLabelText(/Accrued Interest/)).toBeInTheDocument();
    });
  });

  it('shows Deposit To select for INTEREST and CAPITAL_GAIN actions', async () => {
    render(<InvestmentTransactionForm accounts={accounts} />);
    await waitFor(() => {
      expect(screen.getByText('Brokerage Account')).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.change(screen.getByLabelText('Transaction Type'), {
        target: { value: 'INTEREST' },
      });
    });
    await waitFor(() => {
      expect(screen.getByLabelText('Deposit to')).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.change(screen.getByLabelText('Transaction Type'), {
        target: { value: 'CAPITAL_GAIN' },
      });
    });
    await waitFor(() => {
      expect(screen.getByLabelText('Deposit to')).toBeInTheDocument();
    });
  });

  it('lists cash-holding accounts as dividend deposit destinations', async () => {
    const investmentCash = {
      id: 'a4', name: 'RRSP Cash', accountType: 'INVESTMENT',
      accountSubType: 'INVESTMENT_CASH', currencyCode: 'CAD',
    } as any;
    const savings = {
      id: 'a5', name: 'High-Yield Savings', accountType: 'SAVINGS',
      accountSubType: null, currencyCode: 'CAD',
    } as any;
    const creditCard = {
      id: 'a6', name: 'Visa', accountType: 'CREDIT_CARD',
      accountSubType: null, currencyCode: 'CAD',
    } as any;

    render(
      <InvestmentTransactionForm
        accounts={accounts}
        allAccounts={[...accounts, investmentCash, savings, creditCard]}
      />,
    );
    await waitFor(() => {
      expect(screen.getByText('Brokerage Account')).toBeInTheDocument();
    });
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Transaction Type'), {
        target: { value: 'DIVIDEND' },
      });
    });
    await waitFor(() => {
      expect(screen.getByLabelText('Deposit to')).toBeInTheDocument();
    });

    const select = screen.getByLabelText('Deposit to');
    const optionTexts = Array.from(select.querySelectorAll('option')).map(
      (o) => o.textContent,
    );
    expect(optionTexts).toContain('Main Chequing (CAD)');
    expect(optionTexts).toContain('Cash Account (CAD)');
    expect(optionTexts).toContain('RRSP Cash (CAD)');
    expect(optionTexts).toContain('High-Yield Savings (CAD)');
    expect(optionTexts).not.toContain('Visa (CAD)');
    expect(optionTexts).not.toContain('RRSP Brokerage (CAD)');
  });

  it('forwards the selected fundingAccountId when creating a DIVIDEND transaction', async () => {
    // sec-1 is USD and a1 is CAD, so this posts a cross-currency cash leg: give
    // it a rate, or the form (correctly) refuses to commit an unpriced trade.
    getMarketRateMock.mockReturnValue(1.35);
    render(<InvestmentTransactionForm accounts={accounts} />);
    await waitFor(() => {
      expect(screen.getByText('Brokerage Account')).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.change(screen.getByLabelText('Brokerage Account'), {
        target: { value: 'a1' },
      });
    });
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Transaction Type'), {
        target: { value: 'DIVIDEND' },
      });
    });
    await waitFor(() => {
      expect(screen.getByLabelText('Security')).toBeInTheDocument();
    });
    await chooseSecurity('sec-1');
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Deposit to'), {
        target: { value: 'a2' },
      });
    });
    await act(async () => {
      fireEvent.change(screen.getByLabelText(/Amount/), {
        target: { value: '125' },
      });
    });

    await act(async () => {
      fireEvent.click(screen.getByText('Create Transaction'));
    });

    await waitFor(() => {
      expect(investmentsApi.createTransaction).toHaveBeenCalled();
    });
    const payload = vi.mocked(investmentsApi.createTransaction).mock.calls[0][0] as any;
    expect(payload.action).toBe('DIVIDEND');
    expect(payload.fundingAccountId).toBe('a2');
  });

  describe('RETURN_OF_CAPITAL (issue #1800)', () => {
    it('asks for a security, an amount and where the cash goes, and says it lowers the cost basis', async () => {
      render(<InvestmentTransactionForm accounts={accounts} />);
      await waitFor(() => {
        expect(screen.getByText('Brokerage Account')).toBeInTheDocument();
      });
      await act(async () => {
        fireEvent.change(screen.getByLabelText('Transaction Type'), {
          target: { value: 'RETURN_OF_CAPITAL' },
        });
      });

      await waitFor(() => {
        expect(screen.getByLabelText('Security')).toBeInTheDocument();
      });
      expect(screen.getByLabelText('Deposit to')).toBeInTheDocument();
      expect(screen.getByLabelText(/Amount/)).toBeInTheDocument();
      expect(screen.getByText(/lowers the cost basis of your holding/)).toBeInTheDocument();
      // Not a trade: no shares, no per-share price, no commission.
      expect(screen.queryByLabelText(/Quantity/)).not.toBeInTheDocument();
      expect(screen.queryByLabelText(/Commission/)).not.toBeInTheDocument();
      expect(screen.queryByText('Funds From')).not.toBeInTheDocument();
    });

    it('does not show the cost-basis note for a dividend', async () => {
      render(<InvestmentTransactionForm accounts={accounts} />);
      await waitFor(() => {
        expect(screen.getByText('Brokerage Account')).toBeInTheDocument();
      });
      await act(async () => {
        fireEvent.change(screen.getByLabelText('Transaction Type'), {
          target: { value: 'DIVIDEND' },
        });
      });
      await waitFor(() => {
        expect(screen.getByLabelText('Security')).toBeInTheDocument();
      });
      expect(screen.queryByText(/lowers the cost basis of your holding/)).not.toBeInTheDocument();
    });

    it('sends the security, the amount as the cash total and the destination account', async () => {
      // sec-1 is USD and a1 is CAD: a cross-currency cash leg needs a rate.
      getMarketRateMock.mockReturnValue(1.35);
      render(<InvestmentTransactionForm accounts={accounts} />);
      await waitFor(() => {
        expect(screen.getByText('Brokerage Account')).toBeInTheDocument();
      });
      await act(async () => {
        fireEvent.change(screen.getByLabelText('Brokerage Account'), {
          target: { value: 'a1' },
        });
      });
      await act(async () => {
        fireEvent.change(screen.getByLabelText('Transaction Type'), {
          target: { value: 'RETURN_OF_CAPITAL' },
        });
      });
      await waitFor(() => {
        expect(screen.getByLabelText('Security')).toBeInTheDocument();
      });
      await chooseSecurity('sec-1');
      await act(async () => {
        fireEvent.change(screen.getByLabelText('Deposit to'), {
          target: { value: 'a2' },
        });
      });
      await act(async () => {
        fireEvent.change(screen.getByLabelText(/Amount/), {
          target: { value: '80' },
        });
      });

      await act(async () => {
        fireEvent.click(screen.getByText('Create Transaction'));
      });

      await waitFor(() => {
        expect(investmentsApi.createTransaction).toHaveBeenCalled();
      });
      const payload = vi.mocked(investmentsApi.createTransaction).mock.calls[0][0] as any;
      expect(payload.action).toBe('RETURN_OF_CAPITAL');
      expect(payload.securityId).toBe('sec-1');
      expect(payload.fundingAccountId).toBe('a2');
      expect(payload.price).toBe(80);
      expect(payload.quantity).toBeUndefined();
      expect(payload.exchangeRate).toBe(1.35);
    });
  });

  describe('Remembering the last entered date', () => {
    const INVESTMENT_DATE_KEY = 'monize-last-investment-transaction-date';
    const REGULAR_DATE_KEY = 'monize-last-transaction-date';

    beforeEach(() => {
      sessionStorage.clear();
    });

    async function createBuy() {
      await waitFor(() => {
        expect(screen.getByText('Brokerage Account')).toBeInTheDocument();
      });
      await act(async () => {
        fireEvent.change(screen.getByLabelText('Brokerage Account'), {
          target: { value: 'a1' },
        });
      });
      await waitFor(() => {
        expect(screen.getByLabelText('Security')).toBeInTheDocument();
      });
      await chooseSecurity('sec-1');
      await act(async () => {
        fireEvent.click(screen.getByText('Create Transaction'));
      });
      await waitFor(() => {
        expect(investmentsApi.createTransaction).toHaveBeenCalled();
      });
    }

    it('pre-fills the date from a recently saved value', async () => {
      sessionStorage.setItem(
        INVESTMENT_DATE_KEY,
        JSON.stringify({ date: '2026-02-20', savedAt: Date.now() - 10 * 60 * 1000 }),
      );
      render(<InvestmentTransactionForm accounts={accounts} />);
      await waitFor(() => {
        // The canonical value, read off the hidden input the form submits --
        // the visible box shows it in the user's own pattern.
        expect(canonicalDateValue()).toBe('2026-02-20');
      });
    });

    it('ignores and clears a saved date older than one hour', async () => {
      sessionStorage.setItem(
        INVESTMENT_DATE_KEY,
        JSON.stringify({ date: '2026-02-20', savedAt: Date.now() - 61 * 60 * 1000 }),
      );
      render(<InvestmentTransactionForm accounts={accounts} />);
      await waitFor(() => {
        expect(canonicalDateValue()).toBe(getLocalDateString());
      });
      expect(sessionStorage.getItem(INVESTMENT_DATE_KEY)).toBeNull();
    });

    it('saves the entered date after creating a transaction', async () => {
      // sec-1 is USD and a1 is CAD, so this posts a cross-currency cash leg: give
      // it a rate, or the form (correctly) refuses to commit an unpriced trade.
        getMarketRateMock.mockReturnValue(1.35);
      render(<InvestmentTransactionForm accounts={accounts} />);
      await waitFor(() => {
        expect(screen.getByText('Brokerage Account')).toBeInTheDocument();
      });
      await act(async () => {
        fireEvent.change(screen.getByLabelText('Date'), {
          target: { value: '2026-09-09' },
        });
      });
      await createBuy();

      const payload = vi.mocked(investmentsApi.createTransaction).mock
        .calls[0][0] as any;
      expect(payload.transactionDate).toBe('2026-09-09');
      const stored = JSON.parse(
        sessionStorage.getItem(INVESTMENT_DATE_KEY) as string,
      );
      expect(stored.date).toBe('2026-09-09');
    });

    it('keeps the auto-filled 10dp rate when the rate field is only focused and blurred', async () => {
      // The rate field shows 6dp but the market rate is stored at 10dp
      // (roundFxRate). Tabbing through it without editing must not truncate the
      // stored precision, nor dirty the form: NumericInput re-reports the 6dp
      // rounding on blur, and its own finalValue !== value guard cannot catch it
      // because the stored value carries more precision than the field displays.
      getMarketRateMock.mockReturnValue(1.2345678); // more than 6 decimals
      render(<InvestmentTransactionForm accounts={accounts} />);
      await waitFor(() => {
        expect(screen.getByText('Brokerage Account')).toBeInTheDocument();
      });
      await act(async () => {
        fireEvent.change(screen.getByLabelText('Brokerage Account'), {
          target: { value: 'a1' },
        });
      });
      await waitFor(() => {
        expect(screen.getByLabelText('Security')).toBeInTheDocument();
      });
      await chooseSecurity('sec-1');
      const rateField = await screen.findByLabelText(/Exchange rate/i);
      await act(async () => {
        fireEvent.focus(rateField);
        fireEvent.blur(rateField);
      });
      await act(async () => {
        fireEvent.click(screen.getByText('Create Transaction'));
      });
      await waitFor(() => {
        expect(investmentsApi.createTransaction).toHaveBeenCalled();
      });
      const payload = vi.mocked(investmentsApi.createTransaction).mock
        .calls[0][0] as any;
      expect(payload.exchangeRate).toBe(1.2345678);
    });

    it('does not write to the regular-transaction date key', async () => {
      // sec-1 is USD and a1 is CAD, so this posts a cross-currency cash leg: give
      // it a rate, or the form (correctly) refuses to commit an unpriced trade.
        getMarketRateMock.mockReturnValue(1.35);
      render(<InvestmentTransactionForm accounts={accounts} />);
      await createBuy();
      expect(sessionStorage.getItem(REGULAR_DATE_KEY)).toBeNull();
      expect(sessionStorage.getItem(INVESTMENT_DATE_KEY)).not.toBeNull();
    });

    it('does not remember the date when editing an existing transaction', async () => {
      const transaction = {
        id: 't1',
        accountId: 'a1',
        action: 'BUY' as const,
        transactionDate: '2024-01-01',
        securityId: 'sec-1',
        quantity: 10,
        price: 50,
        commission: 5,
        totalAmount: 505,
        description: '',
      } as any;
      render(
        <InvestmentTransactionForm accounts={accounts} transaction={transaction} />,
      );
      await waitFor(() => {
        expect(screen.getByText('Update Transaction')).toBeInTheDocument();
      });
      await act(async () => {
        fireEvent.click(screen.getByText('Update Transaction'));
      });
      await waitFor(() => {
        expect(investmentsApi.updateTransaction).toHaveBeenCalled();
      });
      expect(sessionStorage.getItem(INVESTMENT_DATE_KEY)).toBeNull();
    });
  });

  describe('Transfer between accounts', () => {
    const brokerageB = {
      id: 'b1',
      name: 'TFSA Brokerage',
      accountType: 'INVESTMENT',
      accountSubType: 'INVESTMENT_BROKERAGE',
      currencyCode: 'CAD',
    } as any;
    const transferAccounts = [brokerageAccount, brokerageB, chequingAccount];

    // The source account (a1) holds 100 shares of sec-1 at 1.67 avg cost.
    const sourceHoldings = [
      {
        id: 'h1',
        accountId: 'a1',
        securityId: 'sec-1',
        quantity: 100,
        averageCost: 1.67,
        security: {
          id: 'sec-1',
          symbol: 'AAPL',
          name: 'Apple Inc.',
          currencyCode: 'USD',
        },
      },
      // A fully-exited position lingers as a zero-quantity holding row; it must
      // not appear as transferable.
      {
        id: 'h2',
        accountId: 'a1',
        securityId: 'sec-2',
        quantity: 0,
        averageCost: 0,
        security: {
          id: 'sec-2',
          symbol: 'GONE',
          name: 'Sold Out Co.',
          currencyCode: 'USD',
        },
      },
      // A tiny residual position (below the 0.0001 presence threshold the rest
      // of the app uses) should also be hidden.
      {
        id: 'h3',
        accountId: 'a1',
        securityId: 'sec-3',
        quantity: 0.00005,
        averageCost: 5,
        security: {
          id: 'sec-3',
          symbol: 'DUST',
          name: 'Residual Inc.',
          currencyCode: 'USD',
        },
      },
    ] as any;

    beforeEach(() => {
      vi.mocked(investmentsApi.getHoldings).mockResolvedValue(sourceHoldings);
    });

    async function selectTransfer() {
      render(<InvestmentTransactionForm accounts={transferAccounts} />);
      await waitFor(() => {
        expect(screen.getByText('Brokerage Account')).toBeInTheDocument();
      });
      await act(async () => {
        fireEvent.change(screen.getByLabelText('Transaction Type'), {
          target: { value: 'TRANSFER' },
        });
      });
    }

    it('reveals destination account, security, quantity and cost-per-share fields', async () => {
      await selectTransfer();
      await waitFor(() => {
        expect(screen.getByLabelText('To Account')).toBeInTheDocument();
      });
      expect(screen.getByLabelText('From Account')).toBeInTheDocument();
      expect(screen.getByText('Security')).toBeInTheDocument();
      expect(screen.getByLabelText('Quantity (Shares)')).toBeInTheDocument();
      expect(screen.getByLabelText(/Cost per Share/)).toBeInTheDocument();
    });

    it('excludes the source account from the destination dropdown', async () => {
      await selectTransfer();
      await act(async () => {
        fireEvent.change(screen.getByLabelText('From Account'), {
          target: { value: 'a1' },
        });
      });
      await waitFor(() => {
        const dest = screen.getByLabelText('To Account');
        const values = Array.from(dest.querySelectorAll('option')).map((o) =>
          o.getAttribute('value'),
        );
        expect(values).not.toContain('a1');
        expect(values).toContain('b1');
      });
    });

    it('lists only securities held in the source account', async () => {
      await selectTransfer();
      await act(async () => {
        fireEvent.change(screen.getByLabelText('From Account'), {
          target: { value: 'a1' },
        });
      });
      await waitFor(() => {
        expect(investmentsApi.getHoldings).toHaveBeenCalledWith('a1');
      });
      // Only the held security (sec-1) is offered.
      await act(async () => {
        fireEvent.click(screen.getByLabelText('Security'));
      });
      await waitFor(() => {
        expect(screen.getByText('AAPL - Apple Inc. (USD)')).toBeInTheDocument();
      });
      expect(screen.queryByText(/^GONE - /)).not.toBeInTheDocument();
      expect(screen.queryByText(/^DUST - /)).not.toBeInTheDocument();
      // Transfers cannot create new securities: typed text offers no Create.
      await act(async () => {
        fireEvent.change(screen.getByLabelText('Security'), { target: { value: 'NEWCO' } });
      });
      expect(screen.queryByText('Create "NEWCO"')).not.toBeInTheDocument();
    });

    it('prefills cost per share from the source holding average cost', async () => {
      await selectTransfer();
      await act(async () => {
        fireEvent.change(screen.getByLabelText('From Account'), {
          target: { value: 'a1' },
        });
      });
      await waitFor(() => {
        expect(investmentsApi.getHoldings).toHaveBeenCalledWith('a1');
      });
      await chooseSecurity('sec-1');
      await waitFor(() => {
        expect(screen.getByLabelText(/Cost per Share/)).toHaveValue('1.670000');
      });
      // A26-S19-05: the server carries the source's basis, so the field is not
      // offered as something the person can change.
      expect(screen.getByLabelText(/Cost per Share/)).toBeDisabled();
    });

    it('submits a transfer with the correct payload', async () => {
      await selectTransfer();
      await act(async () => {
        fireEvent.change(screen.getByLabelText('From Account'), {
          target: { value: 'a1' },
        });
      });
      await act(async () => {
        fireEvent.change(screen.getByLabelText('To Account'), {
          target: { value: 'b1' },
        });
      });
      await waitFor(() => {
        expect(investmentsApi.getHoldings).toHaveBeenCalledWith('a1');
      });
      await chooseSecurity('sec-1');
      await act(async () => {
        fireEvent.change(screen.getByLabelText('Quantity (Shares)'), {
          target: { value: '100' },
        });
      });

      await act(async () => {
        fireEvent.click(screen.getByText('Transfer Securities'));
      });

      await waitFor(() => {
        expect(investmentsApi.transferSecurity).toHaveBeenCalled();
      });
      const payload = vi.mocked(investmentsApi.transferSecurity).mock.calls[0][0];
      expect(payload).toMatchObject({
        fromAccountId: 'a1',
        toAccountId: 'b1',
        securityId: 'sec-1',
        quantity: 100,
        costPerShare: 1.67,
      });
    });

    it('blocks a transfer to the same source and destination account', async () => {
      await selectTransfer();
      await act(async () => {
        fireEvent.change(screen.getByLabelText('From Account'), {
          target: { value: 'a1' },
        });
      });
      await waitFor(() => {
        expect(investmentsApi.getHoldings).toHaveBeenCalledWith('a1');
      });
      await chooseSecurity('sec-1');
      await act(async () => {
        fireEvent.change(screen.getByLabelText('Quantity (Shares)'), {
          target: { value: '50' },
        });
      });
      // Destination left blank -> validation should block and toast an error.
      await act(async () => {
        fireEvent.click(screen.getByText('Transfer Securities'));
      });
      await act(async () => {});
      expect(investmentsApi.transferSecurity).not.toHaveBeenCalled();
      expect(toast.error).toHaveBeenCalled();
    });

    it('excludes closed accounts from the destination dropdown', async () => {
      const closedBrokerage = {
        id: 'b2',
        name: 'Closed Brokerage',
        accountType: 'INVESTMENT',
        accountSubType: 'INVESTMENT_BROKERAGE',
        currencyCode: 'CAD',
        isClosed: true,
      } as any;
      render(
        <InvestmentTransactionForm
          accounts={[...transferAccounts, closedBrokerage]}
        />,
      );
      await waitFor(() => {
        expect(screen.getByText('Brokerage Account')).toBeInTheDocument();
      });
      await act(async () => {
        fireEvent.change(screen.getByLabelText('Transaction Type'), {
          target: { value: 'TRANSFER' },
        });
      });
      await act(async () => {
        fireEvent.change(screen.getByLabelText('From Account'), {
          target: { value: 'a1' },
        });
      });
      await waitFor(() => {
        const dest = screen.getByLabelText('To Account');
        const values = Array.from(dest.querySelectorAll('option')).map((o) =>
          o.getAttribute('value'),
        );
        expect(values).not.toContain('b2');
        expect(values).toContain('b1');
      });
    });
  });

  describe('Editing a posted transfer leg', () => {
    const brokerageB = {
      id: 'b1',
      name: 'TFSA Brokerage',
      accountType: 'INVESTMENT',
      accountSubType: 'INVESTMENT_BROKERAGE',
      currencyCode: 'CAD',
    } as any;
    const editAccounts = [brokerageAccount, brokerageB, chequingAccount];

    // The opened OUT leg (source a1) is linked to the IN leg (dest b1).
    const transferLeg = {
      id: 'leg-out',
      accountId: 'a1',
      action: 'TRANSFER_OUT' as const,
      transactionDate: '2026-02-01',
      securityId: 'sec-1',
      quantity: 100,
      price: 1.67,
      commission: 0,
      totalAmount: 0,
      description: '',
      linkedTransactionId: 'leg-in',
    } as any;

    beforeEach(() => {
      vi.mocked(investmentsApi.getTransaction).mockResolvedValue({
        id: 'leg-in',
        accountId: 'b1',
        action: 'TRANSFER_IN',
        securityId: 'sec-1',
        quantity: 100,
        price: 1.67,
        linkedTransactionId: 'leg-out',
      } as any);
    });

    it('locks the transaction type so the direction cannot change', async () => {
      render(
        <InvestmentTransactionForm
          accounts={editAccounts}
          transaction={transferLeg}
        />,
      );
      await waitFor(() => {
        expect(screen.getByText('Update Transaction')).toBeInTheDocument();
      });
      expect(screen.getByLabelText('Transaction Type')).toBeDisabled();
    });

    it('does not show the Total Amount for a transfer', async () => {
      render(
        <InvestmentTransactionForm
          accounts={editAccounts}
          transaction={transferLeg}
        />,
      );
      await waitFor(() => {
        expect(screen.getByText('Update Transaction')).toBeInTheDocument();
      });
      expect(screen.queryByText(/Total Amount/)).not.toBeInTheDocument();
    });

    it('shows both the source and destination accounts', async () => {
      render(
        <InvestmentTransactionForm
          accounts={editAccounts}
          transaction={transferLeg}
        />,
      );
      await waitFor(() => {
        expect(investmentsApi.getTransaction).toHaveBeenCalledWith('leg-in');
      });
      await waitFor(() => {
        expect(screen.getByLabelText('From Account')).toHaveValue('a1');
        expect(screen.getByLabelText('To Account')).toHaveValue('b1');
      });
    });

    it('shows the destination account when the opened leg is the TRANSFER_IN side', async () => {
      // Opening the IN leg (dest b1) must still resolve and display the source
      // (a1) and destination (b1). The destination option only enters the list
      // once the source is resolved, so an uncontrolled select would leave
      // "To Account" blank -- the bug this guards against.
      const transferInLeg = {
        id: 'leg-in',
        accountId: 'b1',
        action: 'TRANSFER_IN' as const,
        transactionDate: '2026-02-01',
        securityId: 'sec-1',
        quantity: 100,
        price: 1.67,
        commission: 0,
        totalAmount: 0,
        description: '',
        linkedTransactionId: 'leg-out',
      } as any;
      vi.mocked(investmentsApi.getTransaction).mockResolvedValue({
        id: 'leg-out',
        accountId: 'a1',
        action: 'TRANSFER_OUT',
        securityId: 'sec-1',
        quantity: 100,
        price: 1.67,
        linkedTransactionId: 'leg-in',
      } as any);

      render(
        <InvestmentTransactionForm
          accounts={editAccounts}
          transaction={transferInLeg}
        />,
      );
      await waitFor(() => {
        expect(investmentsApi.getTransaction).toHaveBeenCalledWith('leg-out');
      });
      await waitFor(() => {
        expect(screen.getByLabelText('From Account')).toHaveValue('a1');
        expect(screen.getByLabelText('To Account')).toHaveValue('b1');
      });
    });

    it('submits both accounts to the source leg when edited', async () => {
      render(
        <InvestmentTransactionForm
          accounts={editAccounts}
          transaction={transferLeg}
        />,
      );
      await waitFor(() => {
        expect(screen.getByLabelText('To Account')).toHaveValue('b1');
      });
      await act(async () => {
        fireEvent.change(screen.getByLabelText('Quantity (Shares)'), {
          target: { value: '60' },
        });
      });
      await act(async () => {
        fireEvent.click(screen.getByText('Update Transaction'));
      });
      await waitFor(() => {
        expect(investmentsApi.updateTransaction).toHaveBeenCalled();
      });
      const [id, payload] = vi.mocked(investmentsApi.updateTransaction).mock
        .calls[0];
      // Edits route through the source (OUT) leg and carry both accounts.
      expect(id).toBe('leg-out');
      expect(payload).toMatchObject({
        accountId: 'a1',
        destinationAccountId: 'b1',
        securityId: 'sec-1',
        quantity: 60,
      });
    });

    it('blocks an edit that exceeds the available shares', async () => {
      // The source (a1) currently holds 0 (all 100 already transferred out).
      // Editing reverses this leg first, so up to 100 is available again --
      // 150 must be rejected client-side before hitting the API.
      vi.mocked(investmentsApi.getHoldings).mockResolvedValue([
        {
          id: 'h1',
          accountId: 'a1',
          securityId: 'sec-1',
          quantity: 0,
          averageCost: 1.67,
          security: {
            id: 'sec-1',
            symbol: 'AAPL',
            name: 'Apple Inc.',
            currencyCode: 'USD',
          },
        },
      ] as any);
      render(
        <InvestmentTransactionForm
          accounts={editAccounts}
          transaction={transferLeg}
        />,
      );
      await waitFor(() => {
        expect(screen.getByLabelText('To Account')).toHaveValue('b1');
      });
      await waitFor(() => {
        expect(investmentsApi.getHoldings).toHaveBeenCalledWith('a1');
      });
      await act(async () => {
        fireEvent.change(screen.getByLabelText('Quantity (Shares)'), {
          target: { value: '150' },
        });
      });
      await act(async () => {
        fireEvent.click(screen.getByText('Update Transaction'));
      });
      await act(async () => {});
      expect(investmentsApi.updateTransaction).not.toHaveBeenCalled();
      expect(toast.error).toHaveBeenCalled();
    });
  });

  it('clears a stale fundingAccountId when switching to an action that does not accept one', async () => {
    render(<InvestmentTransactionForm accounts={accounts} />);
    await waitFor(() => {
      expect(screen.getByText('Brokerage Account')).toBeInTheDocument();
    });
    // Pick a funding account on BUY first
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Brokerage Account'), {
        target: { value: 'a1' },
      });
    });
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Funds From'), {
        target: { value: 'a2' },
      });
    });

    // Switch to ADD_SHARES which doesn't accept a funding/destination account
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Transaction Type'), {
        target: { value: 'ADD_SHARES' },
      });
    });

    await waitFor(() => {
      expect(screen.queryByLabelText('Funds From')).not.toBeInTheDocument();
      expect(screen.queryByLabelText('Deposit to')).not.toBeInTheDocument();
    });

    // Now switch back to BUY: funding should be empty (default), not stale 'a2'
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Transaction Type'), {
        target: { value: 'BUY' },
      });
    });
    await waitFor(() => {
      const sel = screen.getByLabelText('Funds From') as HTMLSelectElement;
      expect(sel.value).toBe('');
    });
  });

  it('uses allAccounts for funding dropdown when provided', async () => {
    const extraAccount = {
      id: 'a4', name: 'Savings', accountType: 'SAVINGS',
      accountSubType: null, currencyCode: 'CAD',
    } as any;

    render(<InvestmentTransactionForm accounts={accounts} allAccounts={[...accounts, extraAccount]} />);
    await waitFor(() => {
      const fundingSelect = screen.getByLabelText('Funds From');
      const options = fundingSelect.querySelectorAll('option');
      const optionTexts = Array.from(options).map(o => o.textContent);
      expect(optionTexts).toContain('Savings');
    });
  });

  it('shows Total Amount display for BUY action', async () => {
    render(<InvestmentTransactionForm accounts={accounts} />);
    await waitFor(() => {
      expect(screen.getByText(/Total Amount/)).toBeInTheDocument();
    });
  });

  it('displays total amount rounded to avoid IEEE 754 drift', async () => {
    // 3 * 53.245 = 159.73499999999999 in IEEE 754. The field carries the total
    // at the money column's four decimals, so it reads 159.735 -- the figure
    // that will be stored -- and never the drifting tail.
    const transaction = {
      id: 't1', accountId: 'a1', action: 'BUY' as const, transactionDate: '2024-01-01',
      quantity: 3, price: 53.245, commission: 0, totalAmount: 159.74, description: '',
    } as any;

    render(<InvestmentTransactionForm accounts={accounts} transaction={transaction} />);
    await waitFor(() => {
      // The total is an editable field now (it is the authoritative input when
      // the user types in it), so the figure is its value rather than text.
      const total = screen.getByLabelText(/Total Amount/) as HTMLInputElement;
      expect(Number(total.value)).toBe(159.735);
    });
  });

  describe('currency conversion', () => {
    const cadBrokerage = {
      id: 'cad-brokerage',
      name: 'CAD Brokerage',
      accountType: 'INVESTMENT',
      accountSubType: 'INVESTMENT_BROKERAGE',
      currencyCode: 'CAD',
      linkedAccountId: 'cad-cash',
    } as any;

    const cadCash = {
      id: 'cad-cash',
      name: 'CAD Investment Cash',
      accountType: 'INVESTMENT',
      accountSubType: 'INVESTMENT_CASH',
      currencyCode: 'CAD',
    } as any;

    const crossCurrencyAccounts = [cadBrokerage, cadCash];

    beforeEach(() => {
      vi.mocked(investmentsApi.getSecurities).mockResolvedValue([
        {
          id: 'sec-usd',
          symbol: 'AAPL',
          name: 'Apple Inc.',
          securityType: 'STOCK',
          currencyCode: 'USD',
        } as any,
      ]);
    });

    it('does NOT show the conversion panel when security and cash currencies match', async () => {
      vi.mocked(investmentsApi.getSecurities).mockResolvedValue([
        {
          id: 'sec-cad',
          symbol: 'TD.TO',
          name: 'TD Bank',
          securityType: 'STOCK',
          currencyCode: 'CAD',
        } as any,
      ]);

      render(
        <InvestmentTransactionForm
          accounts={crossCurrencyAccounts}
          allAccounts={crossCurrencyAccounts}
          defaultAccountId="cad-brokerage"
        />,
      );

      await waitFor(() => {
        expect(
          screen.queryByText(/Currency conversion/),
        ).not.toBeInTheDocument();
      });
    });

    it('shows the conversion panel when security currency differs from cash account currency', async () => {
      getMarketRateMock.mockReturnValue(1.365);

      render(
        <InvestmentTransactionForm
          accounts={crossCurrencyAccounts}
          allAccounts={crossCurrencyAccounts}
          defaultAccountId="cad-brokerage"
        />,
      );

      // The field draws before the securities load; the pick waits for the
      // option to be listed.
      await chooseSecurity('sec-usd');

      await waitFor(() => {
        expect(
          screen.getByText(/Currency conversion \(USD/),
        ).toBeInTheDocument();
      });
    });

    describe('the rate is the one for the trade date (INV-FX-001)', () => {
      const rateInput = () =>
        screen.getByLabelText(/Exchange rate \(1 USD =\)/) as HTMLInputElement;

      const renderUsdBuy = async () => {
        render(
          <InvestmentTransactionForm
            accounts={crossCurrencyAccounts}
            allAccounts={crossCurrencyAccounts}
            defaultAccountId="cad-brokerage"
          />,
        );
        // The select draws before the securities load; choosing 'sec-usd'
        // before its option exists silently keeps the empty value.
        await chooseSecurity('sec-usd');
        await waitFor(() => {
          expect(screen.getByLabelText(/Quantity \(Shares\)/)).toBeInTheDocument();
        });
      };

      const setDate = async (value: string) => {
        await act(async () => {
          fireEvent.change(screen.getByLabelText('Date'), { target: { value } });
        });
      };

      it('fills the exchange rate for the trade date, not the latest', async () => {
        getMarketRateMock.mockReturnValue(1.365);
        getRateForDateMock.mockImplementation(async () => 1.4389);

        await renderUsdBuy();
        await setDate('2025-01-02');

        await waitFor(() => {
          expect(getRateForDateMock).toHaveBeenCalledWith('USD', 'CAD', '2025-01-02');
        });
        await waitFor(() => {
          expect(Number(rateInput().value)).toBeCloseTo(1.4389, 4);
        });

        fireEvent.change(screen.getByLabelText(/Quantity \(Shares\)/), {
          target: { value: '10' },
        });
        fireEvent.change(screen.getByLabelText(/Price per Share/), {
          target: { value: '100' },
        });
        fireEvent.click(screen.getByText('Create Transaction'));

        await waitFor(() => {
          expect(investmentsApi.createTransaction).toHaveBeenCalled();
        });
        const payload = vi.mocked(investmentsApi.createTransaction).mock
          .calls[0][0] as { exchangeRate?: number; transactionDate?: string };
        expect(payload.transactionDate).toBe('2025-01-02');
        expect(payload.exchangeRate).toBeCloseTo(1.4389, 4);
      });

      it('asks again and refills when the date changes', async () => {
        getRateForDateMock.mockImplementation(async (_f, _t, date) =>
          date === '2025-01-02' ? 1.4389 : 1.3,
        );

        await renderUsdBuy();
        await setDate('2025-01-02');
        await waitFor(() => expect(Number(rateInput().value)).toBeCloseTo(1.4389, 4));

        await setDate('2025-03-03');
        await waitFor(() => {
          expect(getRateForDateMock).toHaveBeenCalledWith('USD', 'CAD', '2025-03-03');
        });
        await waitFor(() => expect(Number(rateInput().value)).toBeCloseTo(1.3, 4));
      });

      it('keeps a rate the user typed when the date changes', async () => {
        getRateForDateMock.mockImplementation(async () => 1.4389);

        await renderUsdBuy();
        await setDate('2025-01-02');
        await waitFor(() => expect(Number(rateInput().value)).toBeCloseTo(1.4389, 4));

        fireEvent.focus(rateInput());
        fireEvent.change(rateInput(), { target: { value: '1.5' } });
        fireEvent.blur(rateInput());
        await waitFor(() => expect(Number(rateInput().value)).toBeCloseTo(1.5, 4));

        getRateForDateMock.mockClear();
        await setDate('2025-03-03');

        await waitFor(() => expect(Number(rateInput().value)).toBeCloseTo(1.5, 4));
        expect(getRateForDateMock).not.toHaveBeenCalled();
      });

      it('leaves the rate unresolved when the dated lookup answers null, never the latest', async () => {
        getMarketRateMock.mockReturnValue(1.365);
        getRateForDateMock.mockImplementation(async () => null);

        await renderUsdBuy();
        await setDate('2025-01-02');
        await waitFor(() => {
          expect(getRateForDateMock).toHaveBeenCalledWith('USD', 'CAD', '2025-01-02');
        });

        await waitFor(() => {
          expect(screen.getByRole('alert')).toHaveTextContent('No USD to CAD rate is available');
        });
        expect(rateInput().value).toBe('');

        await act(async () => {
          fireEvent.change(screen.getByLabelText(/Quantity \(Shares\)/), {
            target: { value: '10' },
          });
          fireEvent.change(screen.getByLabelText(/Price per Share/), {
            target: { value: '100' },
          });
        });
        expect(screen.getByRole('button', { name: 'Create Transaction' })).toBeDisabled();
        expect(investmentsApi.createTransaction).not.toHaveBeenCalled();
      });

      it('leaves the rate unresolved when the dated lookup fails', async () => {
        getMarketRateMock.mockReturnValue(1.365);
        getRateForDateMock.mockRejectedValue(new Error('offline'));

        await renderUsdBuy();
        await setDate('2025-01-02');

        await waitFor(() => {
          expect(screen.getByRole('alert')).toHaveTextContent('No USD to CAD rate is available');
        });
        expect(rateInput().value).toBe('');
      });

      it('ignores a late answer for a date the user has moved off', async () => {
        const resolvers = new Map<string, (rate: number | null) => void>();
        getRateForDateMock.mockImplementation(
          (_f, _t, date) => new Promise((resolve) => resolvers.set(date, resolve)),
        );

        await renderUsdBuy();
        await setDate('2025-01-02');
        await waitFor(() => expect(resolvers.has('2025-01-02')).toBe(true));
        await setDate('2025-03-03');
        await waitFor(() => expect(resolvers.has('2025-03-03')).toBe(true));

        await act(async () => {
          resolvers.get('2025-03-03')!(1.3);
        });
        await waitFor(() => expect(Number(rateInput().value)).toBeCloseTo(1.3, 4));
        await act(async () => {
          resolvers.get('2025-01-02')!(1.4389);
        });
        expect(Number(rateInput().value)).toBeCloseTo(1.3, 4);
      });
    });

    // The audit's reproduction. With no client-side rate the preview used to show
    // 10 x 100.00 USD as 1,000.00 CAD (rate substituted as 1) while the request
    // omitted `exchangeRate` entirely, so the server resolved its own dated or
    // latest rate and persisted 1,350.00 CAD -- a 35% difference from the figure
    // the user confirmed.
    describe('when no rate can be resolved', () => {
      const renderCrossCurrencyBuy = async () => {
        getMarketRateMock.mockReturnValue(null);

        render(
          <InvestmentTransactionForm
            accounts={crossCurrencyAccounts}
            allAccounts={crossCurrencyAccounts}
            defaultAccountId="cad-brokerage"
          />,
        );

        // The select draws before the securities load; choosing 'sec-usd'
        // before its option exists silently keeps the empty value.
        await chooseSecurity('sec-usd');
        await waitFor(() => {
          expect(screen.getByLabelText(/Quantity \(Shares\)/)).toBeInTheDocument();
        });
        fireEvent.change(screen.getByLabelText(/Quantity \(Shares\)/), {
          target: { value: '10' },
        });
        fireEvent.change(screen.getByLabelText(/Price per Share/), {
          target: { value: '100' },
        });
        await waitFor(() => {
          expect(screen.getByText(/Currency conversion \(USD/)).toBeInTheDocument();
        });
      };

      it('does not preview the trade at one to one', async () => {
        await renderCrossCurrencyBuy();

        const convertedInput = screen.getByLabelText(
          /^Converted Total$/,
        ) as HTMLInputElement;
        expect(convertedInput.value).toBe('');
        // and the figure is not printed anywhere as a complete CAD total
        expect(screen.queryByText('$1,000.00')).not.toBeInTheDocument();
      });

      it('says the rate is missing and names the pair', async () => {
        await renderCrossCurrencyBuy();
        expect(screen.getByRole('alert')).toHaveTextContent(
          'No USD to CAD rate is available',
        );
      });

      it('blocks the commit', async () => {
        await renderCrossCurrencyBuy();

        const submit = screen.getByRole('button', { name: 'Create Transaction' });
        expect(submit).toBeDisabled();
        expect(investmentsApi.createTransaction).not.toHaveBeenCalled();
      });

      it('prices the trade once the user supplies a rate', async () => {
        await renderCrossCurrencyBuy();

        fireEvent.change(screen.getByLabelText(/Exchange rate \(1 USD =\)/), {
          target: { value: '1.35' },
        });

        await waitFor(() => {
          const convertedInput = screen.getByLabelText(
            /^Converted Total$/,
          ) as HTMLInputElement;
          expect(Number(convertedInput.value)).toBeCloseTo(1350, 4);
        });
        expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      });
    });

    it('sends exchangeRate in payload when creating a cross-currency BUY', async () => {
      getMarketRateMock.mockReturnValue(1.365);

      render(
        <InvestmentTransactionForm
          accounts={crossCurrencyAccounts}
          allAccounts={crossCurrencyAccounts}
          defaultAccountId="cad-brokerage"
        />,
      );

      // The select draws before the securities load; choosing 'sec-usd'
      // before its option exists silently keeps the empty value.
      await chooseSecurity('sec-usd');

      await waitFor(() => {
        expect(screen.getByLabelText(/Quantity \(Shares\)/)).toBeInTheDocument();
      });

      fireEvent.change(screen.getByLabelText(/Quantity \(Shares\)/), {
        target: { value: '10' },
      });
      fireEvent.change(screen.getByLabelText(/Price per Share/), {
        target: { value: '100' },
      });

      await waitFor(() => {
        const rateInput = screen.getByLabelText(
          /Exchange rate \(1 USD =\)/,
        ) as HTMLInputElement;
        expect(Number(rateInput.value)).toBeCloseTo(1.365, 3);
      });

      fireEvent.click(screen.getByText('Create Transaction'));

      await waitFor(() => {
        expect(investmentsApi.createTransaction).toHaveBeenCalled();
      });

      const payload = vi.mocked(investmentsApi.createTransaction).mock
        .calls[0][0] as { exchangeRate?: number; quantity?: number; price?: number };
      expect(payload.exchangeRate).toBeCloseTo(1.365, 3);
      expect(payload.quantity).toBe(10);
      expect(payload.price).toBe(100);
    });

    it('omits the conversion panel for non-cash-posting actions', async () => {
      getMarketRateMock.mockReturnValue(1.365);

      render(
        <InvestmentTransactionForm
          accounts={crossCurrencyAccounts}
          allAccounts={crossCurrencyAccounts}
          defaultAccountId="cad-brokerage"
        />,
      );

      await waitFor(() => {
        expect(screen.getByLabelText('Transaction Type')).toBeInTheDocument();
      });

      // Switch to ADD_SHARES which does not post cash
      fireEvent.change(screen.getByLabelText('Transaction Type'), {
        target: { value: 'ADD_SHARES' },
      });

      await waitFor(() => {
        expect(
          screen.queryByText(/Currency conversion/),
        ).not.toBeInTheDocument();
      });
    });

    it('preserves the stored exchange rate when editing a cross-currency transaction', async () => {
      // Regression test: previously, on initial render the security was not
      // yet in the securities array so transactionCurrency fell back to the
      // account currency, making needsConversion temporarily false. The
      // auto-fill effect then reset the stored rate to 1, and once securities
      // loaded, the effect overwrote it with the market default -- silently
      // losing the user's persisted custom rate on every form load.
      getMarketRateMock.mockReturnValue(1.4);

      const editTransaction = {
        id: 'tx-edit',
        accountId: 'cad-brokerage',
        action: 'BUY' as const,
        transactionDate: '2024-01-15',
        securityId: 'sec-usd',
        security: {
          id: 'sec-usd',
          symbol: 'AAPL',
          name: 'Apple Inc.',
          securityType: 'STOCK',
          currencyCode: 'USD',
        },
        quantity: 10,
        price: 100,
        commission: 0,
        totalAmount: 1000,
        exchangeRate: 1.2345,
        description: '',
      } as any;

      render(
        <InvestmentTransactionForm
          accounts={crossCurrencyAccounts}
          allAccounts={crossCurrencyAccounts}
          transaction={editTransaction}
        />,
      );

      // Once securities load and the form settles, the rate input should
      // show the stored rate (1.2345), not the market default (1.4).
      await waitFor(() => {
        const rateInput = screen.getByLabelText(
          /Exchange rate \(1 USD =\)/,
        ) as HTMLInputElement;
        expect(Number(rateInput.value)).toBeCloseTo(1.2345, 4);
      });

      // Saving without touching anything should persist the stored rate.
      fireEvent.click(screen.getByText('Update Transaction'));

      await waitFor(() => {
        expect(investmentsApi.updateTransaction).toHaveBeenCalled();
      });

      const [, payload] = vi.mocked(investmentsApi.updateTransaction).mock
        .calls[0] as [string, { exchangeRate?: number }];
      expect(payload.exchangeRate).toBeCloseTo(1.2345, 4);
    });

    it('persists a user-edited exchange rate when editing a cross-currency transaction', async () => {
      getMarketRateMock.mockReturnValue(1.4);

      const editTransaction = {
        id: 'tx-edit',
        accountId: 'cad-brokerage',
        action: 'BUY' as const,
        transactionDate: '2024-01-15',
        securityId: 'sec-usd',
        security: {
          id: 'sec-usd',
          symbol: 'AAPL',
          name: 'Apple Inc.',
          securityType: 'STOCK',
          currencyCode: 'USD',
        },
        quantity: 10,
        price: 100,
        commission: 0,
        totalAmount: 1000,
        exchangeRate: 1.35,
        description: '',
      } as any;

      render(
        <InvestmentTransactionForm
          accounts={crossCurrencyAccounts}
          allAccounts={crossCurrencyAccounts}
          transaction={editTransaction}
        />,
      );

      await waitFor(() => {
        expect(
          screen.getByLabelText(/Exchange rate \(1 USD =\)/),
        ).toBeInTheDocument();
      });

      const rateInput = screen.getByLabelText(
        /Exchange rate \(1 USD =\)/,
      ) as HTMLInputElement;

      fireEvent.focus(rateInput);
      fireEvent.change(rateInput, { target: { value: '1.5' } });
      fireEvent.blur(rateInput);

      fireEvent.click(screen.getByText('Update Transaction'));

      await waitFor(() => {
        expect(investmentsApi.updateTransaction).toHaveBeenCalled();
      });

      const [, payload] = vi.mocked(investmentsApi.updateTransaction).mock
        .calls[0] as [string, { exchangeRate?: number }];
      expect(payload.exchangeRate).toBeCloseTo(1.5, 4);
    });
  });

  describe('SPLIT action', () => {
    async function selectSplitAction() {
      await act(async () => {
        render(<InvestmentTransactionForm accounts={accounts} />);
      });
      await waitFor(() => {
        expect(screen.getByLabelText('Transaction Type')).toBeInTheDocument();
      });
      await act(async () => {
        fireEvent.change(screen.getByLabelText('Transaction Type'), {
          target: { value: 'SPLIT' },
        });
      });
    }

    it('renders New shares / Old shares inputs blank for a new split (no assumed default)', async () => {
      await selectSplitAction();

      await waitFor(() => {
        expect(screen.getByText('New shares')).toBeInTheDocument();
      });
      expect(screen.getByText('Old shares')).toBeInTheDocument();
      const newShares = screen.getByLabelText('New shares') as HTMLInputElement;
      const oldShares = screen.getByLabelText('Old shares') as HTMLInputElement;
      // The form must not pre-fill any ratio -- the user has to set it.
      expect(newShares.value).toBe('');
      expect(oldShares.value).toBe('');
    });

    it('blocks submit until the user fills in the split ratio', async () => {
      await selectSplitAction();
      await waitFor(() => {
        expect(screen.getByText('New shares')).toBeInTheDocument();
      });

      await act(async () => {
        fireEvent.change(screen.getByLabelText('Brokerage Account'), {
          target: { value: 'a1' },
        });
      });
      await waitFor(() => {
        expect(screen.getByLabelText('Security')).toBeInTheDocument();
      });
      await chooseSecurity('sec-1');

      await act(async () => {
        fireEvent.click(screen.getByText('Create Transaction'));
      });

      await waitFor(() => {
        expect(toast.error).toHaveBeenCalledWith('Split ratio must be greater than zero');
      });
      expect(investmentsApi.createTransaction).not.toHaveBeenCalled();
    });

    it('leaves split inputs blank when editing a transaction with no usable ratio (e.g. quantity = 5 from a buggy import)', async () => {
      const importedTx = {
        id: 'tx-imported',
        accountId: 'a1',
        action: 'SPLIT' as const,
        transactionDate: '2022-11-07',
        securityId: 'sec-1',
        security: {
          id: 'sec-1',
          symbol: 'AAPL',
          name: 'Apple Inc.',
          securityType: 'STOCK',
          currencyCode: 'USD',
        } as any,
        quantity: 5, // Suspicious residue from older buggy QIF imports.
        price: 0,
        commission: 0,
        totalAmount: 0,
        description: '',
      } as any;

      await act(async () => {
        render(<InvestmentTransactionForm accounts={accounts} transaction={importedTx} />);
      });

      await waitFor(() => {
        expect(screen.getByText('New shares')).toBeInTheDocument();
      });
      const newShares = screen.getByLabelText('New shares') as HTMLInputElement;
      const oldShares = screen.getByLabelText('Old shares') as HTMLInputElement;
      expect(newShares.value).toBe('');
      expect(oldShares.value).toBe('');
      expect(
        screen.getByText(/No split ratio is set on this transaction/i),
      ).toBeInTheDocument();
    });

    it('pre-fills the split inputs when editing a transaction with a sensible ratio (e.g. 0.5)', async () => {
      const editedTx = {
        id: 'tx-edited',
        accountId: 'a1',
        action: 'SPLIT' as const,
        transactionDate: '2022-11-07',
        securityId: 'sec-1',
        security: {
          id: 'sec-1',
          symbol: 'AAPL',
          name: 'Apple Inc.',
          securityType: 'STOCK',
          currencyCode: 'USD',
        } as any,
        quantity: 0.5,
        price: 0,
        commission: 0,
        totalAmount: 0,
        description: '',
      } as any;

      await act(async () => {
        render(<InvestmentTransactionForm accounts={accounts} transaction={editedTx} />);
      });

      await waitFor(() => {
        expect(screen.getByText('New shares')).toBeInTheDocument();
      });
      const newShares = screen.getByLabelText('New shares') as HTMLInputElement;
      const oldShares = screen.getByLabelText('Old shares') as HTMLInputElement;
      expect(parseFloat(newShares.value)).toBe(0.5);
      expect(parseFloat(oldShares.value)).toBe(1);
    });

    it('shows the optional new price per share field', async () => {
      await selectSplitAction();
      await waitFor(() => {
        expect(
          screen.getByText(/New Price per Share After Split/i),
        ).toBeInTheDocument();
      });
    });

    it('does not render Quantity (Shares), Commission, or Total Amount fields for SPLIT', async () => {
      await selectSplitAction();
      await waitFor(() => {
        expect(screen.getByText('New shares')).toBeInTheDocument();
      });
      expect(screen.queryByText('Quantity (Shares)')).not.toBeInTheDocument();
      expect(screen.queryByText(/Commission \/ Fees/)).not.toBeInTheDocument();
      expect(screen.queryByText(/Total Amount/)).not.toBeInTheDocument();
    });

    it('submits the computed ratio (newShares / oldShares) as quantity', async () => {
      await selectSplitAction();
      await waitFor(() => {
        expect(screen.getByText('New shares')).toBeInTheDocument();
      });

      await act(async () => {
        fireEvent.change(screen.getByLabelText('Brokerage Account'), {
          target: { value: 'a1' },
        });
      });
      await waitFor(() => {
        expect(screen.getByLabelText('Security')).toBeInTheDocument();
      });
      await chooseSecurity('sec-1');

      const newShares = screen.getByLabelText('New shares') as HTMLInputElement;
      const oldShares = screen.getByLabelText('Old shares') as HTMLInputElement;
      await act(async () => {
        fireEvent.change(newShares, { target: { value: '3' } });
        fireEvent.change(oldShares, { target: { value: '2' } });
      });

      await act(async () => {
        fireEvent.click(screen.getByText('Create Transaction'));
      });

      await waitFor(() => {
        expect(investmentsApi.createTransaction).toHaveBeenCalled();
      });
      const payload = vi.mocked(investmentsApi.createTransaction).mock.calls[0][0] as any;
      expect(payload.action).toBe('SPLIT');
      expect(payload.quantity).toBeCloseTo(1.5, 6);
      expect(payload.commission).toBeUndefined();
      expect(payload.fundingAccountId).toBeUndefined();
    });

    it('supports reverse splits (newShares < oldShares submits ratio < 1)', async () => {
      await selectSplitAction();
      await waitFor(() => {
        expect(screen.getByText('New shares')).toBeInTheDocument();
      });

      await act(async () => {
        fireEvent.change(screen.getByLabelText('Brokerage Account'), {
          target: { value: 'a1' },
        });
      });
      await waitFor(() => {
        expect(screen.getByLabelText('Security')).toBeInTheDocument();
      });
      await chooseSecurity('sec-1');

      const newShares = screen.getByLabelText('New shares') as HTMLInputElement;
      const oldShares = screen.getByLabelText('Old shares') as HTMLInputElement;
      await act(async () => {
        fireEvent.change(newShares, { target: { value: '1' } });
        fireEvent.change(oldShares, { target: { value: '2' } });
      });

      await act(async () => {
        fireEvent.click(screen.getByText('Create Transaction'));
      });

      await waitFor(() => {
        expect(investmentsApi.createTransaction).toHaveBeenCalled();
      });
      const payload = vi.mocked(investmentsApi.createTransaction).mock.calls[0][0] as any;
      expect(payload.quantity).toBe(0.5);
    });

    it('shows a holding preview using as-of-date holdings (not the live state)', async () => {
      const asOfMock = vi.mocked(investmentsApi.getHoldingAt);
      asOfMock.mockImplementation(() =>
        Promise.resolve({ quantity: 100, averageCost: 150 }),
      );

      // Render in edit mode so account, security, and SPLIT action are all
      // wired up from initial state without relying on async select changes.
      const splitTx = {
        id: 'tx-split',
        accountId: 'a1',
        action: 'SPLIT' as const,
        transactionDate: '2026-01-15',
        securityId: 'sec-1',
        security: {
          id: 'sec-1',
          symbol: 'AAPL',
          name: 'Apple Inc.',
          securityType: 'STOCK',
          currencyCode: 'USD',
        } as any,
        quantity: 2,
        price: 0,
        commission: 0,
        totalAmount: 0,
        description: '',
      } as any;

      realNumberFormat.on = true;
      try {
        await act(async () => {
          render(
            <InvestmentTransactionForm
              accounts={accounts}
              transaction={splitTx}
            />,
          );
        });

        await waitFor(
          () => {
            expect(screen.getByText(/Holding preview/i)).toBeInTheDocument();
          },
          { timeout: 3000 },
        );

        // The form must request the as-of state for the split's own date,
        // excluding the split transaction itself so the "Before" reflects
        // shares held going into the split, not after.
        expect(asOfMock).toHaveBeenCalledWith(
          expect.objectContaining({
            accountId: 'a1',
            securityId: 'sec-1',
            asOfDate: '2026-01-15',
            excludeTransactionId: 'tx-split',
          }),
        );

        // 100 shares @ $150 -> 200 shares @ $75 after a 2-for-1 split.
        expect(screen.getByText('100')).toBeInTheDocument();
        expect(screen.getByText('200')).toBeInTheDocument();
        expect(screen.getByText(/75\.0000/)).toBeInTheDocument();

        // The unhelpful replay-auto sentence must be gone.
        expect(
          screen.queryByText(/replayed automatically/i),
        ).not.toBeInTheDocument();

        // The "Before (as of ...)" line must render the transaction date using
        // the user's locale formatting, not the raw YYYY-MM-DD string.
        expect(screen.queryByText(/as of 2026-01-15/)).not.toBeInTheDocument();
        expect(screen.getByText(/Before \(as of/i)).toBeInTheDocument();
      } finally {
        asOfMock.mockResolvedValue({ quantity: 0, averageCost: 0 });
      }
    });

    it('writes the holding preview in the reader number locale', async () => {
      const asOfMock = vi.mocked(investmentsApi.getHoldingAt);
      asOfMock.mockImplementation(() =>
        Promise.resolve({ quantity: 100.25, averageCost: 150.5 }),
      );
      const splitTx = {
        id: 'tx-split',
        accountId: 'a1',
        action: 'SPLIT' as const,
        transactionDate: '2026-01-15',
        securityId: 'sec-1',
        security: {
          id: 'sec-1',
          symbol: 'AAPL',
          name: 'Apple Inc.',
          securityType: 'STOCK',
          currencyCode: 'USD',
        } as any,
        quantity: 2,
        price: 0,
        commission: 0,
        totalAmount: 0,
        description: '',
      } as any;

      realNumberFormat.on = true;
      usePreferencesStore.setState({
        preferences: { numberFormat: 'pl-PL', language: 'en' } as any,
      });
      try {
        await act(async () => {
          render(
            <InvestmentTransactionForm accounts={accounts} transaction={splitTx} />,
          );
        });
        await waitFor(() => {
          expect(screen.getByText(/Holding preview/i)).toBeInTheDocument();
        });

        // 100.25 shares @ 150.50 -> 200.5 shares @ 75.25 after a 2-for-1 split.
        expect(screen.getByText('100,25')).toBeInTheDocument();
        expect(screen.getByText('200,5')).toBeInTheDocument();
        expect(screen.getByText(/75,2500/)).toBeInTheDocument();
        expect(screen.queryByText(/75\.2500/)).not.toBeInTheDocument();
        // The currency is formatted once: no hand-written symbol beside it.
        expect(screen.queryByText(/\$.*75,2500/)).not.toBeInTheDocument();
      } finally {
        cleanup();
        usePreferencesStore.setState({ preferences: null });
        asOfMock.mockResolvedValue({ quantity: 0, averageCost: 0 });
      }
    });
  });

  it('includes inactive security in dropdown when editing a transaction', async () => {
    const inactiveSecurity = {
      id: 'sec-inactive',
      symbol: 'OLD',
      name: 'Old Corp',
      securityType: 'STOCK',
      currencyCode: 'CAD',
      isActive: false,
    };
    const editTransaction = {
      id: 'tx-1',
      accountId: 'a2',
      action: 'BUY',
      transactionDate: '2026-01-15',
      securityId: 'sec-inactive',
      security: inactiveSecurity,
      quantity: 10,
      price: 50,
      commission: 0,
      totalAmount: 500,
      description: '',
    } as any;

    render(
      <InvestmentTransactionForm accounts={accounts} transaction={editTransaction} />
    );

    // Should include both the active security (AAPL) and the inactive one (OLD)
    await waitFor(() => {
      expect(screen.getByLabelText('Security')).toHaveValue('OLD - Old Corp (CAD)');
    });
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Security'));
    });
    expect(screen.getByText('AAPL - Apple Inc. (USD)')).toBeInTheDocument();
    expect(screen.getAllByText('OLD - Old Corp (CAD)').length).toBeGreaterThan(0);
  });

  describe('status field', () => {
    it('renders the status select with four options, defaulting to UNRECONCILED on create', async () => {
      render(<InvestmentTransactionForm accounts={accounts} />);
      await waitFor(() => {
        expect(screen.getByLabelText('Status')).toBeInTheDocument();
      });
      const select = screen.getByLabelText('Status') as HTMLSelectElement;
      const options = Array.from(select.querySelectorAll('option'));
      expect(options.map((o) => o.getAttribute('value'))).toEqual([
        'UNRECONCILED',
        'CLEARED',
        'RECONCILED',
        'VOID',
      ]);
      expect(options.map((o) => o.textContent)).toEqual([
        'Unreconciled',
        'Cleared',
        'Reconciled',
        'Void',
      ]);
      expect(select.value).toBe('UNRECONCILED');
      expect(select).not.toBeDisabled();
    });

    it('shows the stored status selected when editing', async () => {
      const transaction = {
        id: 't1', accountId: 'a1', action: 'BUY' as const, transactionDate: '2024-01-01',
        quantity: 10, price: 50, commission: 5, totalAmount: 505, description: '',
        status: 'RECONCILED',
      } as any;
      render(<InvestmentTransactionForm accounts={accounts} transaction={transaction} />);
      await waitFor(() => {
        expect(screen.getByLabelText('Status')).toHaveValue('RECONCILED');
      });
    });

    it('disables the select and explains when the row is embedded in a split (transactionSplitId set)', async () => {
      const embedded = {
        id: 't1', accountId: 'a1', action: 'BUY' as const, transactionDate: '2024-01-01',
        quantity: 10, price: 50, commission: 5, totalAmount: 505, description: '',
        status: 'CLEARED',
        transactionSplitId: 'split-1',
      } as any;
      render(<InvestmentTransactionForm accounts={accounts} transaction={embedded} />);
      await waitFor(() => {
        expect(screen.getByLabelText('Status')).toBeDisabled();
      });
      expect(
        screen.getByText(/This transaction is part of a split/),
      ).toBeInTheDocument();
    });

    it('does not disable the select for an ordinary (non-embedded) edit', async () => {
      const transaction = {
        id: 't1', accountId: 'a1', action: 'BUY' as const, transactionDate: '2024-01-01',
        quantity: 10, price: 50, commission: 5, totalAmount: 505, description: '',
        status: 'CLEARED',
      } as any;
      render(<InvestmentTransactionForm accounts={accounts} transaction={transaction} />);
      await waitFor(() => {
        expect(screen.getByLabelText('Status')).not.toBeDisabled();
      });
      expect(
        screen.queryByText(/This transaction is part of a split/),
      ).not.toBeInTheDocument();
    });

    it('sends the selected status in the create payload', async () => {
      // sec-1 is USD and a1 is CAD, so this posts a cross-currency cash leg:
      // give it a rate, or the form (correctly) refuses to commit an unpriced
      // trade.
      getMarketRateMock.mockReturnValue(1.35);
      render(<InvestmentTransactionForm accounts={accounts} />);
      await waitFor(() => {
        expect(screen.getByText('Brokerage Account')).toBeInTheDocument();
      });
      await act(async () => {
        fireEvent.change(screen.getByLabelText('Brokerage Account'), {
          target: { value: 'a1' },
        });
      });
      await waitFor(() => {
        expect(screen.getByLabelText('Security')).toBeInTheDocument();
      });
      await chooseSecurity('sec-1');
      await act(async () => {
        fireEvent.change(screen.getByLabelText('Status'), {
          target: { value: 'CLEARED' },
        });
      });
      await act(async () => {
        fireEvent.click(screen.getByText('Create Transaction'));
      });
      await waitFor(() => {
        expect(investmentsApi.createTransaction).toHaveBeenCalled();
      });
      const payload = vi.mocked(investmentsApi.createTransaction).mock
        .calls[0][0] as any;
      expect(payload.status).toBe('CLEARED');
    });

    it('defaults the payload status to UNRECONCILED when the user leaves it alone', async () => {
      getMarketRateMock.mockReturnValue(1.35);
      render(<InvestmentTransactionForm accounts={accounts} />);
      await waitFor(() => {
        expect(screen.getByText('Brokerage Account')).toBeInTheDocument();
      });
      await act(async () => {
        fireEvent.change(screen.getByLabelText('Brokerage Account'), {
          target: { value: 'a1' },
        });
      });
      await waitFor(() => {
        expect(screen.getByLabelText('Security')).toBeInTheDocument();
      });
      await chooseSecurity('sec-1');
      await act(async () => {
        fireEvent.click(screen.getByText('Create Transaction'));
      });
      await waitFor(() => {
        expect(investmentsApi.createTransaction).toHaveBeenCalled();
      });
      const payload = vi.mocked(investmentsApi.createTransaction).mock
        .calls[0][0] as any;
      expect(payload.status).toBe('UNRECONCILED');
    });
  });
});

describe('InvestmentTransactionForm - extra coverage', () => {
  const brokerageAccount = {
    id: 'a1', name: 'RRSP Brokerage', accountType: 'INVESTMENT',
    accountSubType: 'INVESTMENT_BROKERAGE', currencyCode: 'CAD',
  } as any;
  const brokerageB = {
    id: 'b1', name: 'TFSA Brokerage', accountType: 'INVESTMENT',
    accountSubType: 'INVESTMENT_BROKERAGE', currencyCode: 'CAD',
  } as any;
  const chequingAccount = {
    id: 'a2', name: 'Main Chequing', accountType: 'CHEQUING',
    accountSubType: null, currencyCode: 'CAD',
  } as any;
  const accounts = [brokerageAccount, brokerageB, chequingAccount];

  const sourceHoldings = [
    {
      id: 'h1', accountId: 'a1', securityId: 'sec-1', quantity: 100, averageCost: 1.67,
      security: { id: 'sec-1', symbol: 'AAPL', name: 'Apple Inc.', currencyCode: 'USD' },
    },
  ] as any;

  beforeEach(() => {
    vi.clearAllMocks();
    getMarketRateMock.mockReset();
    getMarketRateMock.mockReturnValue(null);
    getRateForDateMock.mockReset();
    getRateForDateMock.mockImplementation(delegateToMarketRate);
    vi.mocked(investmentsApi.getHoldings).mockResolvedValue(sourceHoldings);
    vi.mocked(investmentsApi.getSecurities).mockResolvedValue([
      { id: 'sec-1', symbol: 'AAPL', name: 'Apple Inc.', securityType: 'STOCK', currencyCode: 'USD' } as any,
    ]);
  });

  it('blocks a transfer with zero quantity', async () => {
    render(<InvestmentTransactionForm accounts={accounts} />);
    await waitFor(() => expect(screen.getByText('Brokerage Account')).toBeInTheDocument());
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Transaction Type'), { target: { value: 'TRANSFER' } });
    });
    await act(async () => {
      fireEvent.change(screen.getByLabelText('From Account'), { target: { value: 'a1' } });
    });
    await waitFor(() => expect(investmentsApi.getHoldings).toHaveBeenCalledWith('a1'));
    await act(async () => {
      fireEvent.change(screen.getByLabelText('To Account'), { target: { value: 'b1' } });
    });
    await chooseSecurity('sec-1');
    await act(async () => {
      fireEvent.click(screen.getByText('Transfer Securities'));
    });
    await act(async () => {});
    expect(investmentsApi.transferSecurity).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith('Quantity must be greater than zero');
  });

  it('blocks a transfer that exceeds the available quantity', async () => {
    render(<InvestmentTransactionForm accounts={accounts} />);
    await waitFor(() => expect(screen.getByText('Brokerage Account')).toBeInTheDocument());
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Transaction Type'), { target: { value: 'TRANSFER' } });
    });
    await act(async () => {
      fireEvent.change(screen.getByLabelText('From Account'), { target: { value: 'a1' } });
    });
    await waitFor(() => expect(investmentsApi.getHoldings).toHaveBeenCalledWith('a1'));
    await act(async () => {
      fireEvent.change(screen.getByLabelText('To Account'), { target: { value: 'b1' } });
    });
    await chooseSecurity('sec-1');
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Quantity (Shares)'), { target: { value: '999' } });
    });
    await act(async () => {
      fireEvent.click(screen.getByText('Transfer Securities'));
    });
    await act(async () => {});
    expect(investmentsApi.transferSecurity).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith('Only 100 shares available to transfer');
  });

  it('rejects a SPLIT with a non-positive ratio', async () => {
    render(<InvestmentTransactionForm accounts={accounts} />);
    await waitFor(() => expect(screen.getByText('Brokerage Account')).toBeInTheDocument());
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Brokerage Account'), { target: { value: 'a1' } });
    });
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Transaction Type'), { target: { value: 'SPLIT' } });
    });
    await chooseSecurity('sec-1');
    await act(async () => {
      fireEvent.click(screen.getByText('Create Transaction'));
    });
    await act(async () => {});
    expect(investmentsApi.createTransaction).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith('Split ratio must be greater than zero');
  });

  it('shows the split holding preview when shares are held at the split date', async () => {
    vi.mocked(investmentsApi.getHoldingAt).mockResolvedValue({ quantity: 100, averageCost: 50 });
    const splitTx = {
      id: 'tx-split', accountId: 'a1', action: 'SPLIT' as const, transactionDate: '2026-01-15',
      securityId: 'sec-1',
      security: { id: 'sec-1', symbol: 'AAPL', name: 'Apple Inc.', securityType: 'STOCK', currencyCode: 'USD' } as any,
      quantity: 2, price: 0, commission: 0, totalAmount: 0, description: '',
    } as any;
    await act(async () => {
      render(<InvestmentTransactionForm accounts={accounts} transaction={splitTx} />);
    });
    await waitFor(() => expect(screen.getByText(/Holding preview/i)).toBeInTheDocument());
    // 100 @ $50 -> 200 @ $25 after a 2-for-1 split.
    expect(screen.getByText('200')).toBeInTheDocument();
  });

  it('submits an edited transfer leg via the source (OUT) leg', async () => {
    const linkedLeg = {
      id: 'leg-in', accountId: 'b1', action: 'TRANSFER_IN', transactionDate: '2026-01-10',
      securityId: 'sec-1', quantity: 10, price: 1.67, linkedTransactionId: 'leg-out',
    } as any;
    vi.mocked(investmentsApi.getTransaction).mockResolvedValue(linkedLeg);
    const outLeg = {
      id: 'leg-out', accountId: 'a1', action: 'TRANSFER_OUT' as const, transactionDate: '2026-01-10',
      securityId: 'sec-1',
      security: { id: 'sec-1', symbol: 'AAPL', name: 'Apple Inc.', securityType: 'STOCK', currencyCode: 'USD' } as any,
      quantity: 10, price: 1.67, commission: 0, totalAmount: 0, description: '',
      linkedTransactionId: 'leg-in',
    } as any;
    await act(async () => {
      render(<InvestmentTransactionForm accounts={accounts} transaction={outLeg} />);
    });
    await waitFor(() => expect(screen.getByText('Update Transaction')).toBeInTheDocument());
    await waitFor(() => expect(screen.getByLabelText('To Account')).toHaveValue('b1'));
    // Re-assert the source/security/quantity explicitly so the submit payload
    // is deterministic regardless of async resync timing.
    await chooseSecurity('sec-1');
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Quantity (Shares)'), { target: { value: '5' } });
    });
    await act(async () => {
      fireEvent.click(screen.getByText('Update Transaction'));
    });
    await act(async () => {});
    await waitFor(() => expect(investmentsApi.updateTransaction).toHaveBeenCalled());
    const [id, payload] = vi.mocked(investmentsApi.updateTransaction).mock.calls[0];
    expect(id).toBe('leg-out');
    expect(payload).toMatchObject({ accountId: 'a1', destinationAccountId: 'b1', quantity: 5 });
  });

  it('derives a converted total back into the exchange rate for a cross-currency BUY', async () => {
    const usdSecurity = {
      id: 'sec-usd', symbol: 'MSFT', name: 'Microsoft', securityType: 'STOCK', currencyCode: 'USD',
    };
    vi.mocked(investmentsApi.getSecurities).mockResolvedValue([usdSecurity as any]);
    const cadBrokerage = {
      id: 'a-cad', name: 'CAD Broker', accountType: 'INVESTMENT',
      accountSubType: 'INVESTMENT_BROKERAGE', currencyCode: 'CAD', linkedAccountId: null,
    } as any;
    getMarketRateMock.mockReturnValue(1.35);

    render(<InvestmentTransactionForm accounts={[cadBrokerage]} />);
    await waitFor(() => expect(screen.getByText('Brokerage Account')).toBeInTheDocument());
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Brokerage Account'), { target: { value: 'a-cad' } });
    });
    await chooseSecurity('sec-usd');
    // The conversion section appears once the USD security is selected.
    await waitFor(() => expect(screen.getByLabelText(/Exchange rate/i)).toBeInTheDocument());
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Quantity (Shares)'), { target: { value: '10' } });
    });
    await act(async () => {
      fireEvent.change(screen.getByLabelText(/Price per Share/i), { target: { value: '5' } });
    });
    // Editing the converted total back-derives the exchange rate.
    await act(async () => {
      fireEvent.change(screen.getByLabelText(/Converted total/i), { target: { value: '100' } });
    });
    const rate = screen.getByLabelText(/Exchange rate/i) as HTMLInputElement;
    await waitFor(() => expect(Number(rate.value)).toBeGreaterThan(0));
  });

  // =========================================================================
  // "Create & New": the submit button's two behaviours
  // =========================================================================

  describe('create and new', () => {
    const CHEVRON = 'Choose what happens after creating';

    beforeEach(() => {
      window.localStorage.clear();
      window.sessionStorage.clear();
    });

    async function chooseCreateAndNew() {
      fireEvent.click(screen.getByRole('button', { name: CHEVRON }));
      await act(async () => {
        fireEvent.click(
          screen.getByRole('menuitemradio', { name: /Create Transaction & New/ }),
        );
      });
    }

    async function submitBuy(buttonName: RegExp) {
      // sec-1 is USD and a1 is CAD, so this posts a cross-currency cash leg:
      // give it a resolved market rate, or the form (correctly) refuses to
      // commit an unpriced trade and the submit never fires.
      getMarketRateMock.mockReturnValue(1.35);
      await act(async () => {
        fireEvent.change(screen.getByLabelText('Brokerage Account'), {
          target: { value: 'a1' },
        });
      });
      await waitFor(() => {
        expect(screen.getByLabelText('Security')).toBeInTheDocument();
      });
      await chooseSecurity('sec-1');
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: buttonName }));
      });
    }

    it('offers no choice when the host cannot keep the window open', async () => {
      render(<InvestmentTransactionForm accounts={accounts} onSuccess={vi.fn()} />);
      await waitFor(() => {
        expect(screen.getByText('Create Transaction')).toBeInTheDocument();
      });
      expect(screen.queryByRole('button', { name: CHEVRON })).not.toBeInTheDocument();
    });

    it('offers no choice when editing an existing transaction', async () => {
      const transaction = {
        id: 't1', accountId: 'a1', action: 'BUY' as const, transactionDate: '2024-01-01',
        quantity: 10, price: 50, commission: 5, totalAmount: 505, description: '',
      } as any;
      render(
        <InvestmentTransactionForm
          accounts={accounts}
          transaction={transaction}
          onCreateAndNew={vi.fn()}
        />,
      );
      await waitFor(() => {
        expect(screen.getByText('Update Transaction')).toBeInTheDocument();
      });
      expect(screen.queryByRole('button', { name: CHEVRON })).not.toBeInTheDocument();
    });

    it('closes as before while the default behaviour is selected', async () => {
      const onSuccess = vi.fn();
      const onCreateAndNew = vi.fn();
      render(
        <InvestmentTransactionForm
          accounts={accounts}
          onSuccess={onSuccess}
          onCreateAndNew={onCreateAndNew}
        />,
      );
      await waitFor(() => {
        expect(screen.getByRole('button', { name: CHEVRON })).toBeInTheDocument();
      });
      await submitBuy(/^Create Transaction$/);

      await waitFor(() => {
        expect(investmentsApi.createTransaction).toHaveBeenCalledTimes(1);
      });
      expect(onSuccess).toHaveBeenCalledTimes(1);
      expect(onCreateAndNew).not.toHaveBeenCalled();
    });

    it('keeps the window open and restarts the form when Create & New is selected', async () => {
      const onSuccess = vi.fn();
      const onCreateAndNew = vi.fn();
      render(
        <InvestmentTransactionForm
          accounts={accounts}
          onSuccess={onSuccess}
          onCreateAndNew={onCreateAndNew}
        />,
      );
      await waitFor(() => {
        expect(screen.getByRole('button', { name: CHEVRON })).toBeInTheDocument();
      });
      await chooseCreateAndNew();
      expect(investmentsApi.createTransaction).not.toHaveBeenCalled();

      await act(async () => {
        fireEvent.change(screen.getByLabelText('Date'), { target: { value: '2026-09-09' } });
      });
      await submitBuy(/^Create Transaction & New$/);

      await waitFor(() => {
        expect(investmentsApi.createTransaction).toHaveBeenCalledTimes(1);
      });
      expect(onCreateAndNew).toHaveBeenCalledTimes(1);
      expect(onSuccess).not.toHaveBeenCalled();

      // Restarted, but still filed against the account and date just used --
      // what a freshly opened window would show.
      await waitFor(() => {
        expect(screen.getByLabelText('Brokerage Account')).toHaveValue('a1');
      });
      expect(canonicalDateValue()).toBe('2026-09-09');
      expect(screen.getByLabelText('Security')).toHaveValue('');
    });

    it('keeps the transaction type just saved when Create & New restarts the form', async () => {
      render(
        <InvestmentTransactionForm accounts={accounts} onCreateAndNew={vi.fn()} />,
      );
      await waitFor(() => {
        expect(screen.getByRole('button', { name: CHEVRON })).toBeInTheDocument();
      });
      await chooseCreateAndNew();
      await act(async () => {
        fireEvent.change(screen.getByLabelText('Transaction Type'), { target: { value: 'SELL' } });
      });
      await submitBuy(/^Create Transaction & New$/);

      await waitFor(() => {
        expect(investmentsApi.createTransaction).toHaveBeenCalledTimes(1);
      });
      expect(vi.mocked(investmentsApi.createTransaction).mock.calls[0][0]).toMatchObject({ action: 'SELL' });
      // The restarted form is a fresh SELL, not the BUY a new window opens as.
      await waitFor(() => {
        expect(screen.getByLabelText('Transaction Type')).toHaveValue('SELL');
      });
      expect(screen.getByLabelText('Funds To')).toBeInTheDocument();
      expect(screen.getByLabelText('Security')).toHaveValue('');
    });

    it('remembers the choice under the investment key', async () => {
      render(
        <InvestmentTransactionForm accounts={accounts} onCreateAndNew={vi.fn()} />,
      );
      await waitFor(() => {
        expect(screen.getByRole('button', { name: CHEVRON })).toBeInTheDocument();
      });
      await chooseCreateAndNew();

      expect(
        window.localStorage.getItem(INVESTMENT_TRANSACTION_SUBMIT_MODE_KEY),
      ).toBe('"new"');
      // The regular transaction form reads its own key and must be untouched.
      expect(window.localStorage.getItem(TRANSACTION_SUBMIT_MODE_KEY)).toBeNull();
    });

    it('starts with Create & New already selected when it was chosen before', async () => {
      window.localStorage.setItem(
        INVESTMENT_TRANSACTION_SUBMIT_MODE_KEY,
        JSON.stringify('new'),
      );
      render(
        <InvestmentTransactionForm accounts={accounts} onCreateAndNew={vi.fn()} />,
      );
      await waitFor(() => {
        expect(
          screen.getByRole('button', { name: 'Create Transaction & New' }),
        ).toBeInTheDocument();
      });
    });

    it('labels the option for a securities transfer in its own terms', async () => {
      window.localStorage.setItem(
        INVESTMENT_TRANSACTION_SUBMIT_MODE_KEY,
        JSON.stringify('new'),
      );
      render(
        <InvestmentTransactionForm accounts={accounts} onCreateAndNew={vi.fn()} />,
      );
      await waitFor(() => {
        expect(screen.getByLabelText('Transaction Type')).toBeInTheDocument();
      });
      await act(async () => {
        fireEvent.change(screen.getByLabelText('Transaction Type'), {
          target: { value: 'TRANSFER' },
        });
      });
      await waitFor(() => {
        expect(
          screen.getByRole('button', { name: 'Transfer Securities & New' }),
        ).toBeInTheDocument();
      });
    });
  });
  describe('total and price', () => {
    /**
     * Invariant: the executed total is the fact; the per-share price is derived
     * from it (INV-TRADE-001).
     * Canonical adversarial input: a sale of 141 shares for 820.91, which is
     * not any two-decimal price times 141.
     * Minimal mutation: make the Total a read-only display again.
     * Test that fails under it: this one -- the payload carries 820.62 (or no
     * total at all) and a price of 5.82.
     */
    it('derives the price from a typed total, and sends the total as entered', async () => {
      render(<InvestmentTransactionForm accounts={accounts} />);
      await waitFor(() => {
        expect(screen.getByLabelText('Transaction Type')).toBeInTheDocument();
      });
      await act(async () => {
        fireEvent.change(screen.getByLabelText('Transaction Type'), {
          target: { value: 'SELL' },
        });
      });
      await act(async () => {
        fireEvent.change(screen.getByLabelText('Quantity (Shares)'), {
          target: { value: '141' },
        });
      });
      await act(async () => {
        fireEvent.change(screen.getByLabelText(/Price per Share/), {
          target: { value: '5.82' },
        });
      });
      // What the statement says the sale came to.
      await act(async () => {
        fireEvent.change(screen.getByLabelText(/Total Amount/), {
          target: { value: '820.91' },
        });
      });

      const priceInput = screen.getByLabelText(/Price per Share/) as HTMLInputElement;
      expect(Number(priceInput.value)).toBeCloseTo(5.822057, 6);

      await act(async () => {
        fireEvent.click(screen.getByText('Create Transaction'));
      });
      await waitFor(() => {
        expect(investmentsApi.createTransaction).toHaveBeenCalled();
      });
      const payload = vi.mocked(investmentsApi.createTransaction).mock
        .calls[0][0] as { totalAmount?: number; price?: number };
      expect(payload.totalAmount).toBeCloseTo(820.91, 4);
      expect(payload.price).toBeCloseTo(5.8220567376, 10);
    });

    it('still derives the total from the price when the price is what changed', async () => {
      render(<InvestmentTransactionForm accounts={accounts} />);
      await waitFor(() => {
        expect(screen.getByLabelText('Transaction Type')).toBeInTheDocument();
      });
      await act(async () => {
        fireEvent.change(screen.getByLabelText('Quantity (Shares)'), {
          target: { value: '8' },
        });
      });
      await act(async () => {
        fireEvent.change(screen.getByLabelText(/Price per Share/), {
          target: { value: '5.831963' },
        });
      });

      const totalInput = screen.getByLabelText(/Total Amount/) as HTMLInputElement;
      expect(Number(totalInput.value)).toBeCloseTo(46.6557, 4);
    });
  });
});
