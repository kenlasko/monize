import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@/test/render';
import { InvestmentTransactionForm } from './InvestmentTransactionForm';
import { investmentsApi } from '@/lib/investments';
import toast from 'react-hot-toast';

vi.mock('@/hooks/useNumberFormat', () => ({
  useNumberFormat: () => ({
    defaultCurrency: 'CAD',
    formatCurrency: (n: number, c?: string) =>
      c ? `${c} $${n.toFixed(2)}` : `$${n.toFixed(2)}`,
  }),
}));

const getMarketRateMock = vi.fn<(from: string, to: string) => number | null>(
  () => null,
);

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

vi.mock('@/lib/format', () => ({
  getCurrencySymbol: () => '$',
  getDecimalPlacesForCurrency: () => 2,
  roundToCents: (v: number) => Math.round(v * 100) / 100,
  roundToDecimals: (v: number, dp: number) => {
    const factor = Math.pow(10, dp);
    return Math.round(v * factor) / factor;
  },
  formatAmountWithCommas: (v: number) => v?.toLocaleString() ?? '',
  parseAmount: (v: string) => parseFloat(v) || 0,
  filterCurrencyInput: (v: string) => v,
  filterCalculatorInput: (v: string) => v,
  hasCalculatorOperators: () => false,
  evaluateExpression: (v: string) => parseFloat(v) || 0,
}));

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
}));

vi.mock('@/components/securities/SecurityForm', () => ({
  SecurityForm: ({ onSubmit, onCancel }: { onSubmit: (data: any) => Promise<void>; onCancel: () => void }) => (
    <div data-testid="security-form-modal">
      <button onClick={() => { onSubmit({ symbol: 'TEST', name: 'Test Corp', securityType: 'STOCK', currencyCode: 'CAD' }).catch(() => {}); }}>
        Create Security
      </button>
      <button onClick={onCancel}>Cancel</button>
    </div>
  ),
}));

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
    getMarketRateMock.mockReset();
    getMarketRateMock.mockReturnValue(null);
  });

  it('renders form fields', async () => {
    render(<InvestmentTransactionForm accounts={accounts} />);
    await waitFor(() => {
      expect(screen.getByText('Brokerage Account')).toBeInTheDocument();
    });
    expect(screen.getByText('Transaction Type')).toBeInTheDocument();
    expect(screen.getByText('Date')).toBeInTheDocument();
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

  it('renders all action types in dropdown', async () => {
    render(<InvestmentTransactionForm accounts={accounts} />);
    await waitFor(() => {
      const select = screen.getByLabelText('Transaction Type');
      const options = select.querySelectorAll('option');
      expect(options.length).toBe(11); // 11 action types
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

  it('shows "+ Add new security" link', async () => {
    render(<InvestmentTransactionForm accounts={accounts} />);
    await waitFor(() => {
      expect(screen.getByText('+ Add new security')).toBeInTheDocument();
    });
  });

  it('opens security modal when clicking add new security link', async () => {
    render(<InvestmentTransactionForm accounts={accounts} />);

    const addLink = await screen.findByText('+ Add new security');
    fireEvent.click(addLink);

    expect(screen.getByTestId('security-form-modal')).toBeInTheDocument();
    expect(screen.getByText('New Security')).toBeInTheDocument();

    // Close modal via cancel
    fireEvent.click(screen.getByText('Cancel'));
    await waitFor(() => {
      expect(screen.queryByTestId('security-form-modal')).not.toBeInTheDocument();
    });
  });

  it('shows modal title when security form is open', async () => {
    render(<InvestmentTransactionForm accounts={accounts} />);

    const addLink = await screen.findByText('+ Add new security');
    fireEvent.click(addLink);

    expect(screen.getByText('New Security')).toBeInTheDocument();
  });

  it('handles create security success', async () => {
    render(<InvestmentTransactionForm accounts={accounts} />);

    const addLink = await screen.findByText('+ Add new security');
    fireEvent.click(addLink);

    // Submit the mocked SecurityForm
    fireEvent.click(screen.getByText('Create Security'));

    await waitFor(() => {
      expect(investmentsApi.createSecurity).toHaveBeenCalledWith({
        symbol: 'TEST', name: 'Test Corp', securityType: 'STOCK', currencyCode: 'CAD',
      });
      expect(toast.success).toHaveBeenCalledWith('Security created');
    });

    // Modal should close after success
    expect(screen.queryByTestId('security-form-modal')).not.toBeInTheDocument();
  });

  it('handles create security failure', async () => {
    vi.mocked(investmentsApi.createSecurity).mockRejectedValueOnce(new Error('API error'));

    render(<InvestmentTransactionForm accounts={accounts} />);

    const addLink = await screen.findByText('+ Add new security');
    fireEvent.click(addLink);

    // Submit the mocked SecurityForm (will trigger API error)
    fireEvent.click(screen.getByText('Create Security'));

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Failed to create security');
    });

    // Modal should stay open on failure
    expect(screen.getByTestId('security-form-modal')).toBeInTheDocument();
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
      expect(screen.getByText('Funds From (optional)')).toBeInTheDocument();
    });
  });

  it('filters out CASH, ASSET, and brokerage accounts from funding accounts', async () => {
    const investmentCash = {
      id: 'a4', name: 'RRSP Cash', accountType: 'INVESTMENT',
      accountSubType: 'INVESTMENT_CASH', currencyCode: 'CAD',
    } as any;

    render(<InvestmentTransactionForm accounts={[...accounts, investmentCash]} />);
    await waitFor(() => {
      const fundingSelect = screen.getByLabelText('Funds From (optional)');
      const options = fundingSelect.querySelectorAll('option');
      const optionTexts = Array.from(options).map(o => o.textContent);
      expect(optionTexts).not.toContain('Cash Account');
      expect(optionTexts).not.toContain('RRSP Brokerage');
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
      expect(screen.getByLabelText('Deposit To (optional)')).toBeInTheDocument();
    });
    expect(screen.queryByText('Funds From (optional)')).not.toBeInTheDocument();
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
      expect(screen.getByLabelText('Deposit To (optional)')).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.change(screen.getByLabelText('Transaction Type'), {
        target: { value: 'CAPITAL_GAIN' },
      });
    });
    await waitFor(() => {
      expect(screen.getByLabelText('Deposit To (optional)')).toBeInTheDocument();
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
      expect(screen.getByLabelText('Deposit To (optional)')).toBeInTheDocument();
    });

    const select = screen.getByLabelText('Deposit To (optional)');
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
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Security'), {
        target: { value: 'sec-1' },
      });
    });
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Deposit To (optional)'), {
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
      fireEvent.change(screen.getByLabelText('Funds From (optional)'), {
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
      expect(screen.queryByLabelText('Funds From (optional)')).not.toBeInTheDocument();
      expect(screen.queryByLabelText('Deposit To (optional)')).not.toBeInTheDocument();
    });

    // Now switch back to BUY: funding should be empty (default), not stale 'a2'
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Transaction Type'), {
        target: { value: 'BUY' },
      });
    });
    await waitFor(() => {
      const sel = screen.getByLabelText('Funds From (optional)') as HTMLSelectElement;
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
      const fundingSelect = screen.getByLabelText('Funds From (optional)');
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
    // 3 * 53.245 = 159.73499... in IEEE 754, which should round to 159.73 without fix
    // but should display as 159.74 after roundToDecimals is applied
    const transaction = {
      id: 't1', accountId: 'a1', action: 'BUY' as const, transactionDate: '2024-01-01',
      quantity: 3, price: 53.245, commission: 0, totalAmount: 159.74, description: '',
    } as any;

    render(<InvestmentTransactionForm accounts={accounts} transaction={transaction} />);
    await waitFor(() => {
      // The total display uses formatCurrency which receives the rounded value
      // formatCurrency mock: $${n.toFixed(2)} => $159.74 not $159.73
      expect(screen.getByText(/\$159\.74/)).toBeInTheDocument();
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

      await waitFor(() => {
        expect(screen.getByLabelText('Security')).toBeInTheDocument();
      });

      const securitySelect = screen.getByLabelText('Security');
      fireEvent.change(securitySelect, { target: { value: 'sec-usd' } });

      await waitFor(() => {
        expect(
          screen.getByText(/Currency conversion \(USD/),
        ).toBeInTheDocument();
      });
    });

    it('auto-fills the exchange rate with the latest market rate', async () => {
      getMarketRateMock.mockReturnValue(1.365);

      render(
        <InvestmentTransactionForm
          accounts={crossCurrencyAccounts}
          allAccounts={crossCurrencyAccounts}
          defaultAccountId="cad-brokerage"
        />,
      );

      await waitFor(() => {
        expect(screen.getByLabelText('Security')).toBeInTheDocument();
      });

      const securitySelect = screen.getByLabelText('Security');
      fireEvent.change(securitySelect, { target: { value: 'sec-usd' } });

      await waitFor(() => {
        expect(getMarketRateMock).toHaveBeenCalledWith('USD', 'CAD');
      });

      await waitFor(() => {
        const rateInput = screen.getByLabelText(
          /Exchange rate \(1 USD =\)/,
        ) as HTMLInputElement;
        expect(Number(rateInput.value)).toBeCloseTo(1.365, 3);
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

      await waitFor(() => {
        expect(screen.getByLabelText('Security')).toBeInTheDocument();
      });

      fireEvent.change(screen.getByLabelText('Security'), {
        target: { value: 'sec-usd' },
      });

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
      await act(async () => {
        fireEvent.change(screen.getByLabelText('Security'), {
          target: { value: 'sec-1' },
        });
      });

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
          screen.getByText(/New price per share, after split/i),
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
      await act(async () => {
        fireEvent.change(screen.getByLabelText('Security'), {
          target: { value: 'sec-1' },
        });
      });

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
      await act(async () => {
        fireEvent.change(screen.getByLabelText('Security'), {
          target: { value: 'sec-1' },
        });
      });

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
        expect(screen.getByText(/100\.0000/)).toBeInTheDocument();
        expect(screen.getByText(/200\.0000/)).toBeInTheDocument();
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

    await waitFor(() => {
      const securitySelect = screen.getByLabelText('Security');
      const options = securitySelect.querySelectorAll('option');
      const optionTexts = Array.from(options).map(o => o.textContent);
      // Should include both the active security (AAPL) and the inactive one (OLD)
      expect(optionTexts).toContain('AAPL - Apple Inc. (USD)');
      expect(optionTexts).toContain('OLD - Old Corp (CAD)');
    });
  });
});
