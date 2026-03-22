import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@/test/render';
import { InvestmentTransactionForm } from './InvestmentTransactionForm';
import { investmentsApi } from '@/lib/investments';
import toast from 'react-hot-toast';

vi.mock('@/hooks/useNumberFormat', () => ({
  useNumberFormat: () => ({
    defaultCurrency: 'CAD',
    formatCurrency: (n: number, _c?: string) => `$${n.toFixed(2)}`,
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
