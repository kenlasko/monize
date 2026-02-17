import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@/test/render';
import { InvestmentTransactionForm } from './InvestmentTransactionForm';
import { investmentsApi } from '@/lib/investments';
import toast from 'react-hot-toast';

vi.mock('@/hooks/useNumberFormat', () => ({
  useNumberFormat: () => ({
    defaultCurrency: 'CAD',
  }),
}));

vi.mock('@/lib/format', () => ({
  getCurrencySymbol: () => '$',
  roundToCents: (v: number) => Math.round(v * 100) / 100,
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

  it('toggles new security form when clicking add new security link', async () => {
    render(<InvestmentTransactionForm accounts={accounts} />);

    const addLink = await screen.findByText('+ Add new security');
    fireEvent.click(addLink);

    expect(screen.getByText('Symbol')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('e.g., AAPL')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('e.g., Apple Inc.')).toBeInTheDocument();
    expect(screen.getByText('Create Security')).toBeInTheDocument();

    // Click again to cancel
    fireEvent.click(screen.getByText('Cancel'));
    expect(screen.queryByPlaceholderText('e.g., AAPL')).not.toBeInTheDocument();
  });

  it('handles create security with empty fields', async () => {
    render(<InvestmentTransactionForm accounts={accounts} />);

    const addLink = await screen.findByText('+ Add new security');
    fireEvent.click(addLink);

    // Click Create Security without filling fields
    fireEvent.click(screen.getByText('Create Security'));
    expect(toast.error).toHaveBeenCalledWith('Symbol and name are required');
  });

  it('handles create security success', async () => {
    render(<InvestmentTransactionForm accounts={accounts} />);

    const addLink = await screen.findByText('+ Add new security');
    fireEvent.click(addLink);

    const symbolInput = screen.getByPlaceholderText('e.g., AAPL');
    const nameInput = screen.getByPlaceholderText('e.g., Apple Inc.');
    fireEvent.change(symbolInput, { target: { value: 'TEST' } });
    fireEvent.change(nameInput, { target: { value: 'Test Corp' } });

    fireEvent.click(screen.getByText('Create Security'));

    await waitFor(() => {
      expect(investmentsApi.createSecurity).toHaveBeenCalled();
      expect(toast.success).toHaveBeenCalledWith('Security created');
    });
  });

  it('handles create security failure', async () => {
    vi.mocked(investmentsApi.createSecurity).mockRejectedValueOnce(new Error('API error'));

    render(<InvestmentTransactionForm accounts={accounts} />);

    const addLink = await screen.findByText('+ Add new security');
    fireEvent.click(addLink);

    fireEvent.change(screen.getByPlaceholderText('e.g., AAPL'), { target: { value: 'FAIL' } });
    fireEvent.change(screen.getByPlaceholderText('e.g., Apple Inc.'), { target: { value: 'Fail Corp' } });

    fireEvent.click(screen.getByText('Create Security'));

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Failed to create security');
    });
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

  it('filters out CASH and ASSET accounts from funding accounts', async () => {
    render(<InvestmentTransactionForm accounts={accounts} />);
    await waitFor(() => {
      const fundingSelect = screen.getByLabelText('Funds From (optional)');
      const options = fundingSelect.querySelectorAll('option');
      // "Default cash account" + chequing + brokerage (not cash account or asset)
      const optionTexts = Array.from(options).map(o => o.textContent);
      expect(optionTexts).not.toContain('Cash Account');
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
});
