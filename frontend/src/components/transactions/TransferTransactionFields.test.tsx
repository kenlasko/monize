import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@/test/render';
import { TransferTransactionFields } from './TransferTransactionFields';
import { Account } from '@/types/account';
import { Payee } from '@/types/payee';

vi.mock('@/lib/format', () => ({
  getCurrencySymbol: (code: string) => {
    const map: Record<string, string> = { CAD: '$', USD: 'US$', EUR: 'E' };
    return map[code] || '$';
  },
}));

vi.mock('@/components/ui/Combobox', () => ({
  Combobox: ({ label, options, value, onChange, placeholder }: any) => (
    <div data-testid={`combobox-${label}`}>
      <label>{label}</label>
      <select
        data-testid={`combobox-select-${label}`}
        value={value}
        onChange={(e) => {
          const selected = options.find((o: any) => o.value === e.target.value);
          onChange(e.target.value, selected?.label || e.target.value);
        }}
      >
        <option value="">{placeholder || 'Select...'}</option>
        {options.map((opt: any) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
    </div>
  ),
}));

vi.mock('@/components/ui/CurrencyInput', () => ({
  CurrencyInput: ({ label, value, onChange, error, prefix, allowNegative: _allowNegative }: any) => (
    <div data-testid={`currency-input-${label}`}>
      <label>{label}</label>
      {prefix && <span data-testid={`currency-prefix-${label}`}>{prefix}</span>}
      <input
        data-testid={`currency-input-field-${label}`}
        type="number"
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value ? Number(e.target.value) : undefined)}
      />
      {error && <span data-testid={`currency-error-${label}`}>{error}</span>}
    </div>
  ),
}));

function createAccount(overrides: Partial<Account> = {}): Account {
  return {
    id: 'acc-1',
    userId: 'user-1',
    accountType: 'CHEQUING',
    accountSubType: null,
    linkedAccountId: null,
    name: 'Chequing',
    description: null,
    currencyCode: 'CAD',
    accountNumber: null,
    institution: null,
    openingBalance: 0,
    currentBalance: 1000,
    creditLimit: null,
    interestRate: null,
    isClosed: false,
    closedDate: null,
    isFavourite: false,
    paymentAmount: null,
    paymentFrequency: null,
    paymentStartDate: null,
    sourceAccountId: null,
    principalCategoryId: null,
    interestCategoryId: null,
    scheduledTransactionId: null,
    assetCategoryId: null,
    dateAcquired: null,
    isCanadianMortgage: false,
    isVariableRate: false,
    termMonths: null,
    termEndDate: null,
    amortizationMonths: null,
    originalPrincipal: null,
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
    ...overrides,
  };
}

function createPayee(overrides: Partial<Payee> = {}): Payee {
  return {
    id: 'payee-1',
    userId: 'user-1',
    name: 'Test Payee',
    defaultCategoryId: null,
    defaultCategory: null,
    notes: null,
    createdAt: '2024-01-01T00:00:00Z',
    ...overrides,
  };
}

describe('TransferTransactionFields', () => {
  const mockRegister = vi.fn().mockReturnValue({
    name: 'fieldName', onChange: vi.fn(), onBlur: vi.fn(), ref: vi.fn(),
  });

  const defaultProps = {
    register: mockRegister,
    errors: {},
    watchedAccountId: '',
    watchedAmount: 0,
    watchedCurrencyCode: 'CAD',
    accounts: [] as Account[],
    setValue: vi.fn(),
    transferToAccountId: '',
    setTransferToAccountId: vi.fn(),
    transferTargetAmount: undefined as number | undefined,
    setTransferTargetAmount: vi.fn(),
    transferPayeeId: '',
    transferPayeeName: '',
    setTransferPayeeId: vi.fn(),
    setTransferPayeeName: vi.fn(),
    crossCurrencyInfo: null as any,
    payees: [] as Payee[],
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders Date input', () => {
    render(<TransferTransactionFields {...defaultProps} />);

    expect(screen.getByText('Date')).toBeInTheDocument();
  });

  it('renders From Account select', () => {
    render(<TransferTransactionFields {...defaultProps} />);

    expect(screen.getByText('From Account')).toBeInTheDocument();
  });

  it('renders To Account select', () => {
    render(<TransferTransactionFields {...defaultProps} />);

    expect(screen.getByText('To Account')).toBeInTheDocument();
  });

  it('renders Transfer Amount input', () => {
    render(<TransferTransactionFields {...defaultProps} />);

    expect(screen.getByText('Transfer Amount')).toBeInTheDocument();
  });

  it('renders Reference Number input', () => {
    render(<TransferTransactionFields {...defaultProps} />);

    expect(screen.getByText('Reference Number')).toBeInTheDocument();
  });

  it('does not show cross-currency section when crossCurrencyInfo is null', () => {
    render(<TransferTransactionFields {...defaultProps} />);

    expect(screen.queryByText(/Amount Received/)).not.toBeInTheDocument();
  });

  it('shows cross-currency section when crossCurrencyInfo is provided', () => {
    render(
      <TransferTransactionFields
        {...defaultProps}
        crossCurrencyInfo={{
          fromCurrency: 'CAD',
          toCurrency: 'USD',
          fromAccountName: 'CAD Account',
          toAccountName: 'USD Account',
        }}
      />
    );

    expect(screen.getByText('Amount Received (USD)')).toBeInTheDocument();
  });

  // --- New tests below ---

  it('filters out investment brokerage accounts from From Account dropdown', () => {
    const chequingAccount = createAccount({ id: 'acc-1', name: 'Chequing' });
    const investmentAccount = createAccount({
      id: 'acc-inv',
      name: 'Brokerage',
      accountSubType: 'INVESTMENT_BROKERAGE',
    });

    render(
      <TransferTransactionFields
        {...defaultProps}
        accounts={[chequingAccount, investmentAccount]}
      />
    );

    const fromSelect = screen.getByLabelText('From Account');
    const options = Array.from(fromSelect.querySelectorAll('option'));
    const labels = options.map(o => o.textContent);

    expect(labels).toContain('Chequing (CAD)');
    expect(labels).not.toContain('Brokerage (CAD)');
  });

  it('filters out investment brokerage accounts from To Account dropdown', () => {
    const savingsAccount = createAccount({ id: 'acc-2', name: 'Savings' });
    const investmentAccount = createAccount({
      id: 'acc-inv',
      name: 'Brokerage',
      accountSubType: 'INVESTMENT_BROKERAGE',
    });

    render(
      <TransferTransactionFields
        {...defaultProps}
        accounts={[savingsAccount, investmentAccount]}
      />
    );

    const toSelect = screen.getByLabelText('To Account');
    const options = Array.from(toSelect.querySelectorAll('option'));
    const labels = options.map(o => o.textContent);

    expect(labels).toContain('Savings (CAD)');
    expect(labels).not.toContain('Brokerage (CAD)');
  });

  it('excludes the currently selected "From" account from To Account dropdown', () => {
    const account1 = createAccount({ id: 'acc-1', name: 'Chequing' });
    const account2 = createAccount({ id: 'acc-2', name: 'Savings' });

    render(
      <TransferTransactionFields
        {...defaultProps}
        accounts={[account1, account2]}
        watchedAccountId="acc-1"
      />
    );

    const toSelect = screen.getByLabelText('To Account');
    const options = Array.from(toSelect.querySelectorAll('option'));
    const labels = options.map(o => o.textContent);

    expect(labels).toContain('Savings (CAD)');
    expect(labels).not.toContain('Chequing (CAD)');
  });

  it('hides closed accounts from From Account dropdown unless they are the current selection', () => {
    const openAccount = createAccount({ id: 'acc-open', name: 'Open Account', isClosed: false });
    const closedAccount = createAccount({ id: 'acc-closed', name: 'Closed Account', isClosed: true });

    render(
      <TransferTransactionFields
        {...defaultProps}
        accounts={[openAccount, closedAccount]}
      />
    );

    const fromSelect = screen.getByLabelText('From Account');
    const options = Array.from(fromSelect.querySelectorAll('option'));
    const labels = options.map(o => o.textContent);

    expect(labels).toContain('Open Account (CAD)');
    // Closed accounts are shown but disabled (unless currently selected)
    // The component uses: (!account.isClosed || account.id === watchedAccountId)
    expect(labels).not.toContain('Closed Account (CAD)');
  });

  it('shows a closed account in From Account dropdown if it is the currently selected account', () => {
    const closedAccount = createAccount({ id: 'acc-closed', name: 'Closed Account', isClosed: true });

    render(
      <TransferTransactionFields
        {...defaultProps}
        accounts={[closedAccount]}
        watchedAccountId="acc-closed"
      />
    );

    const fromSelect = screen.getByLabelText('From Account');
    const options = Array.from(fromSelect.querySelectorAll('option'));
    const labels = options.map(o => o.textContent);

    expect(labels).toContain('Closed Account (CAD) (Closed)');
  });

  it('sorts account options alphabetically in both dropdowns', () => {
    const accountC = createAccount({ id: 'acc-c', name: 'Charlie' });
    const accountA = createAccount({ id: 'acc-a', name: 'Alpha' });
    const accountB = createAccount({ id: 'acc-b', name: 'Beta' });

    render(
      <TransferTransactionFields
        {...defaultProps}
        accounts={[accountC, accountA, accountB]}
      />
    );

    const fromSelect = screen.getByLabelText('From Account');
    const fromOptions = Array.from(fromSelect.querySelectorAll('option'));
    const fromLabels = fromOptions.slice(1).map(o => o.textContent);

    expect(fromLabels).toEqual([
      'Alpha (CAD)',
      'Beta (CAD)',
      'Charlie (CAD)',
    ]);
  });

  it('shows currency code label suffix for cross-currency Transfer Amount', () => {
    render(
      <TransferTransactionFields
        {...defaultProps}
        crossCurrencyInfo={{
          fromCurrency: 'CAD',
          toCurrency: 'USD',
          fromAccountName: 'CAD Account',
          toAccountName: 'USD Account',
        }}
      />
    );

    expect(screen.getByText('Transfer Amount (CAD)')).toBeInTheDocument();
    expect(screen.getByText('Amount Received (USD)')).toBeInTheDocument();
  });

  it('does not show "Amount must be positive" hint when in cross-currency mode', () => {
    render(
      <TransferTransactionFields
        {...defaultProps}
        crossCurrencyInfo={{
          fromCurrency: 'CAD',
          toCurrency: 'USD',
          fromAccountName: 'CAD Account',
          toAccountName: 'USD Account',
        }}
      />
    );

    expect(screen.queryByText('Amount must be positive for transfers')).not.toBeInTheDocument();
  });

  it('shows "Amount must be positive" hint when not in cross-currency mode', () => {
    render(
      <TransferTransactionFields
        {...defaultProps}
        crossCurrencyInfo={null}
      />
    );

    expect(screen.getByText('Amount must be positive for transfers')).toBeInTheDocument();
  });

  it('shows "Amount received after currency conversion" hint for cross-currency', () => {
    render(
      <TransferTransactionFields
        {...defaultProps}
        crossCurrencyInfo={{
          fromCurrency: 'CAD',
          toCurrency: 'EUR',
          fromAccountName: 'CAD Account',
          toAccountName: 'EUR Account',
        }}
      />
    );

    expect(screen.getByText('Amount received after currency conversion')).toBeInTheDocument();
  });

  it('calls setTransferToAccountId when To Account is changed', () => {
    const account1 = createAccount({ id: 'acc-1', name: 'Account A' });
    const account2 = createAccount({ id: 'acc-2', name: 'Account B' });

    render(
      <TransferTransactionFields
        {...defaultProps}
        accounts={[account1, account2]}
      />
    );

    const toSelect = screen.getByLabelText('To Account');
    fireEvent.change(toSelect, { target: { value: 'acc-2' } });

    expect(defaultProps.setTransferToAccountId).toHaveBeenCalledWith('acc-2');
  });

  it('resets transferTargetAmount when To Account is changed', () => {
    const account1 = createAccount({ id: 'acc-1', name: 'Account A' });
    const account2 = createAccount({ id: 'acc-2', name: 'Account B' });

    render(
      <TransferTransactionFields
        {...defaultProps}
        accounts={[account1, account2]}
      />
    );

    const toSelect = screen.getByLabelText('To Account');
    fireEvent.change(toSelect, { target: { value: 'acc-2' } });

    expect(defaultProps.setTransferTargetAmount).toHaveBeenCalledWith(undefined);
  });

  it('renders payee options in the Payee combobox', () => {
    const payees = [
      createPayee({ id: 'p1', name: 'Bank Transfer' }),
      createPayee({ id: 'p2', name: 'Wire Service' }),
    ];

    render(
      <TransferTransactionFields
        {...defaultProps}
        payees={payees}
      />
    );

    const payeeSelect = screen.getByTestId('combobox-select-Payee (Optional)');
    const options = Array.from(payeeSelect.querySelectorAll('option'));
    const labels = options.map(o => o.textContent);

    expect(labels).toContain('Bank Transfer');
    expect(labels).toContain('Wire Service');
  });

  it('calls setTransferPayeeId and setTransferPayeeName when payee is selected', () => {
    const payees = [
      createPayee({ id: 'p1', name: 'Bank Transfer' }),
    ];

    render(
      <TransferTransactionFields
        {...defaultProps}
        payees={payees}
      />
    );

    const payeeSelect = screen.getByTestId('combobox-select-Payee (Optional)');
    fireEvent.change(payeeSelect, { target: { value: 'p1' } });

    expect(defaultProps.setTransferPayeeId).toHaveBeenCalledWith('p1');
    expect(defaultProps.setTransferPayeeName).toHaveBeenCalledWith('Bank Transfer');
  });

  it('displays "Select destination account..." as To Account placeholder', () => {
    render(
      <TransferTransactionFields
        {...defaultProps}
        accounts={[createAccount()]}
      />
    );

    const toSelect = screen.getByLabelText('To Account');
    const firstOption = toSelect.querySelector('option');

    expect(firstOption?.textContent).toBe('Select destination account...');
  });

  it('calls setValue for amount when Transfer Amount changes', () => {
    render(<TransferTransactionFields {...defaultProps} />);

    const amountInput = screen.getByTestId('currency-input-field-Transfer Amount');
    fireEvent.change(amountInput, { target: { value: '500' } });

    expect(defaultProps.setValue).toHaveBeenCalledWith(
      'amount',
      500,
      { shouldValidate: true }
    );
  });

  it('includes currency code in account labels', () => {
    const usdAccount = createAccount({ id: 'acc-usd', name: 'US Account', currencyCode: 'USD' });
    const cadAccount = createAccount({ id: 'acc-cad', name: 'CAD Account', currencyCode: 'CAD' });

    render(
      <TransferTransactionFields
        {...defaultProps}
        accounts={[usdAccount, cadAccount]}
      />
    );

    const fromSelect = screen.getByLabelText('From Account');
    const options = Array.from(fromSelect.querySelectorAll('option'));
    const labels = options.map(o => o.textContent);

    expect(labels).toContain('CAD Account (CAD)');
    expect(labels).toContain('US Account (USD)');
  });
});
