import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@/test/render';
import { SplitTransactionFields } from './SplitTransactionFields';
import { Account } from '@/types/account';
import { Payee } from '@/types/payee';

vi.mock('@/lib/format', () => ({
  getCurrencySymbol: (code: string) => (code === 'USD' ? 'US$' : '$'),
}));

vi.mock('@/components/ui/Combobox', () => ({
  Combobox: ({ label, options, value, onChange, onCreateNew, error, placeholder }: any) => (
    <div data-testid={`combobox-${label}`}>
      <label>{label}</label>
      {error && <span data-testid={`combobox-error-${label}`}>{error}</span>}
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
      {onCreateNew && (
        <button
          data-testid={`combobox-create-${label}`}
          onClick={() => onCreateNew('New Item')}
        >
          Create
        </button>
      )}
    </div>
  ),
}));

vi.mock('@/components/ui/CurrencyInput', () => ({
  CurrencyInput: ({ label, value, onChange, error, prefix }: any) => (
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

describe('SplitTransactionFields', () => {
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
    selectedPayeeId: '',
    payees: [] as Payee[],
    handlePayeeChange: vi.fn(),
    handlePayeeCreate: vi.fn(),
    handleAmountChange: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders Account select', () => {
    render(<SplitTransactionFields {...defaultProps} />);

    expect(screen.getByText('Account')).toBeInTheDocument();
  });

  it('renders Date input', () => {
    render(<SplitTransactionFields {...defaultProps} />);

    expect(screen.getByText('Date')).toBeInTheDocument();
  });

  it('renders Payee combobox', () => {
    render(<SplitTransactionFields {...defaultProps} />);

    expect(screen.getByText('Payee')).toBeInTheDocument();
  });

  it('renders Total Amount input', () => {
    render(<SplitTransactionFields {...defaultProps} />);

    expect(screen.getByText('Total Amount')).toBeInTheDocument();
  });

  it('renders Reference Number input', () => {
    render(<SplitTransactionFields {...defaultProps} />);

    expect(screen.getByText('Reference Number')).toBeInTheDocument();
  });

  // --- New tests below ---

  it('filters out investment brokerage accounts from the Account dropdown', () => {
    const chequingAccount = createAccount({ id: 'acc-1', name: 'Chequing' });
    const investmentAccount = createAccount({
      id: 'acc-inv',
      name: 'Brokerage',
      accountSubType: 'INVESTMENT_BROKERAGE',
    });

    render(
      <SplitTransactionFields
        {...defaultProps}
        accounts={[chequingAccount, investmentAccount]}
      />
    );

    const accountSelect = screen.getByLabelText('Account');
    const options = Array.from(accountSelect.querySelectorAll('option'));
    const labels = options.map(o => o.textContent);

    expect(labels).toContain('Chequing (CAD)');
    expect(labels).not.toContain('Brokerage (CAD)');
  });

  it('filters out closed accounts from the Account dropdown', () => {
    const openAccount = createAccount({ id: 'acc-1', name: 'Open Account', isClosed: false });
    const closedAccount = createAccount({ id: 'acc-2', name: 'Closed Account', isClosed: true });

    render(
      <SplitTransactionFields
        {...defaultProps}
        accounts={[openAccount, closedAccount]}
      />
    );

    const accountSelect = screen.getByLabelText('Account');
    const options = Array.from(accountSelect.querySelectorAll('option'));
    const labels = options.map(o => o.textContent);

    expect(labels).toContain('Open Account (CAD)');
    expect(labels).not.toContain('Closed Account (CAD)');
  });

  it('sorts accounts alphabetically in the dropdown', () => {
    const accountC = createAccount({ id: 'acc-c', name: 'Charlie' });
    const accountA = createAccount({ id: 'acc-a', name: 'Alpha' });
    const accountB = createAccount({ id: 'acc-b', name: 'Beta' });

    render(
      <SplitTransactionFields
        {...defaultProps}
        accounts={[accountC, accountA, accountB]}
      />
    );

    const accountSelect = screen.getByLabelText('Account');
    const options = Array.from(accountSelect.querySelectorAll('option'));
    const accountLabels = options.slice(1).map(o => o.textContent);

    expect(accountLabels).toEqual([
      'Alpha (CAD)',
      'Beta (CAD)',
      'Charlie (CAD)',
    ]);
  });

  it('displays payee options in the Payee combobox', () => {
    const payees = [
      createPayee({ id: 'p1', name: 'Grocery Store' }),
      createPayee({ id: 'p2', name: 'Hardware Store' }),
    ];

    render(
      <SplitTransactionFields
        {...defaultProps}
        payees={payees}
      />
    );

    const payeeSelect = screen.getByTestId('combobox-select-Payee');
    const options = Array.from(payeeSelect.querySelectorAll('option'));
    const labels = options.map(o => o.textContent);

    expect(labels).toContain('Grocery Store');
    expect(labels).toContain('Hardware Store');
  });

  it('calls handlePayeeChange when a payee is selected', () => {
    const payees = [
      createPayee({ id: 'p1', name: 'Grocery Store' }),
    ];

    render(
      <SplitTransactionFields
        {...defaultProps}
        payees={payees}
      />
    );

    const payeeSelect = screen.getByTestId('combobox-select-Payee');
    fireEvent.change(payeeSelect, { target: { value: 'p1' } });

    expect(defaultProps.handlePayeeChange).toHaveBeenCalledWith('p1', 'Grocery Store');
  });

  it('calls handlePayeeCreate when create button is clicked', () => {
    render(<SplitTransactionFields {...defaultProps} />);

    const createButton = screen.getByTestId('combobox-create-Payee');
    fireEvent.click(createButton);

    expect(defaultProps.handlePayeeCreate).toHaveBeenCalledWith('New Item');
  });

  it('calls handleAmountChange when Total Amount changes', () => {
    render(<SplitTransactionFields {...defaultProps} />);

    const amountInput = screen.getByTestId('currency-input-field-Total Amount');
    fireEvent.change(amountInput, { target: { value: '150.00' } });

    expect(defaultProps.handleAmountChange).toHaveBeenCalledWith(150);
  });

  it('calls handleAmountChange with undefined when Total Amount is cleared', () => {
    render(<SplitTransactionFields {...defaultProps} watchedAmount={100} />);

    const amountInput = screen.getByTestId('currency-input-field-Total Amount');
    fireEvent.change(amountInput, { target: { value: '' } });

    expect(defaultProps.handleAmountChange).toHaveBeenCalledWith(undefined);
  });

  it('passes watchedAmount as value to Total Amount CurrencyInput', () => {
    render(
      <SplitTransactionFields
        {...defaultProps}
        watchedAmount={-250.75}
      />
    );

    const amountInput = screen.getByTestId('currency-input-field-Total Amount');
    expect(amountInput).toHaveValue(-250.75);
  });

  it('passes selectedPayeeId as value to the Payee combobox', () => {
    const payees = [
      createPayee({ id: 'p1', name: 'Selected Payee' }),
    ];

    render(
      <SplitTransactionFields
        {...defaultProps}
        payees={payees}
        selectedPayeeId="p1"
      />
    );

    const payeeSelect = screen.getByTestId('combobox-select-Payee');
    expect(payeeSelect).toHaveValue('p1');
  });

  it('includes currency code in account labels', () => {
    const usdAccount = createAccount({ id: 'acc-usd', name: 'US Savings', currencyCode: 'USD' });

    render(
      <SplitTransactionFields
        {...defaultProps}
        accounts={[usdAccount]}
      />
    );

    const accountSelect = screen.getByLabelText('Account');
    const options = Array.from(accountSelect.querySelectorAll('option'));
    const labels = options.map(o => o.textContent);

    expect(labels).toContain('US Savings (USD)');
  });

  it('shows "Select account..." as the first option placeholder', () => {
    render(
      <SplitTransactionFields
        {...defaultProps}
        accounts={[createAccount()]}
      />
    );

    const accountSelect = screen.getByLabelText('Account');
    const firstOption = accountSelect.querySelector('option');

    expect(firstOption?.textContent).toBe('Select account...');
    expect(firstOption?.value).toBe('');
  });

  it('does not render a Category combobox (split mode has no single category)', () => {
    render(<SplitTransactionFields {...defaultProps} />);

    expect(screen.queryByTestId('combobox-Category')).not.toBeInTheDocument();
  });

  it('does not render a Split Transaction button (already in split mode)', () => {
    render(<SplitTransactionFields {...defaultProps} />);

    expect(screen.queryByText('Split Transaction')).not.toBeInTheDocument();
  });
});
