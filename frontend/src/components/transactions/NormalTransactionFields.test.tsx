import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@/test/render';
import { NormalTransactionFields } from './NormalTransactionFields';
import { Account } from '@/types/account';
import { Payee } from '@/types/payee';

vi.mock('@/lib/format', () => ({
  getCurrencySymbol: (code: string) => (code === 'USD' ? 'US$' : '$'),
}));

vi.mock('@/components/ui/Combobox', () => ({
  Combobox: ({ label, options, value, onChange, onCreateNew, error, placeholder, allowCustomValue, initialDisplayValue }: any) => (
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

describe('NormalTransactionFields', () => {
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
    selectedCategoryId: '',
    payees: [] as Payee[],
    categoryOptions: [] as Array<{ value: string; label: string }>,
    handlePayeeChange: vi.fn(),
    handlePayeeCreate: vi.fn(),
    handleCategoryChange: vi.fn(),
    handleCategoryCreate: vi.fn(),
    handleAmountChange: vi.fn(),
    handleModeChange: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders Account select', () => {
    render(<NormalTransactionFields {...defaultProps} />);

    expect(screen.getByText('Account')).toBeInTheDocument();
  });

  it('renders Date input', () => {
    render(<NormalTransactionFields {...defaultProps} />);

    expect(screen.getByText('Date')).toBeInTheDocument();
  });

  it('renders Payee combobox', () => {
    render(<NormalTransactionFields {...defaultProps} />);

    expect(screen.getByText('Payee')).toBeInTheDocument();
  });

  it('renders Category combobox', () => {
    render(<NormalTransactionFields {...defaultProps} />);

    expect(screen.getByText('Category')).toBeInTheDocument();
  });

  it('renders Amount input', () => {
    render(<NormalTransactionFields {...defaultProps} />);

    expect(screen.getByText('Amount')).toBeInTheDocument();
  });

  it('renders Reference Number input', () => {
    render(<NormalTransactionFields {...defaultProps} />);

    expect(screen.getByText('Reference Number')).toBeInTheDocument();
  });

  // --- New tests below ---

  it('filters out investment brokerage accounts from the Account dropdown', () => {
    const chequingAccount = createAccount({ id: 'acc-1', name: 'Chequing', accountSubType: null });
    const investmentAccount = createAccount({
      id: 'acc-inv',
      name: 'Brokerage',
      accountSubType: 'INVESTMENT_BROKERAGE',
    });

    render(
      <NormalTransactionFields
        {...defaultProps}
        accounts={[chequingAccount, investmentAccount]}
      />
    );

    const accountSelect = screen.getByLabelText('Account');
    const options = Array.from(accountSelect.querySelectorAll('option'));
    const optionLabels = options.map(o => o.textContent);

    expect(optionLabels).toContain('Chequing (CAD)');
    expect(optionLabels).not.toContain('Brokerage (CAD)');
  });

  it('filters out closed accounts from the Account dropdown', () => {
    const openAccount = createAccount({ id: 'acc-1', name: 'Open Account', isClosed: false });
    const closedAccount = createAccount({ id: 'acc-2', name: 'Closed Account', isClosed: true });

    render(
      <NormalTransactionFields
        {...defaultProps}
        accounts={[openAccount, closedAccount]}
      />
    );

    const accountSelect = screen.getByLabelText('Account');
    const options = Array.from(accountSelect.querySelectorAll('option'));
    const optionLabels = options.map(o => o.textContent);

    expect(optionLabels).toContain('Open Account (CAD)');
    expect(optionLabels).not.toContain('Closed Account (CAD)');
  });

  it('sorts account options alphabetically', () => {
    const accountB = createAccount({ id: 'acc-b', name: 'Beta Account' });
    const accountA = createAccount({ id: 'acc-a', name: 'Alpha Account' });
    const accountC = createAccount({ id: 'acc-c', name: 'Charlie Account' });

    render(
      <NormalTransactionFields
        {...defaultProps}
        accounts={[accountB, accountA, accountC]}
      />
    );

    const accountSelect = screen.getByLabelText('Account');
    const options = Array.from(accountSelect.querySelectorAll('option'));
    // First option is the placeholder
    const accountLabels = options.slice(1).map(o => o.textContent);

    expect(accountLabels).toEqual([
      'Alpha Account (CAD)',
      'Beta Account (CAD)',
      'Charlie Account (CAD)',
    ]);
  });

  it('displays payee options in the Payee combobox', () => {
    const payees = [
      createPayee({ id: 'p1', name: 'Grocery Store' }),
      createPayee({ id: 'p2', name: 'Gas Station' }),
    ];

    render(
      <NormalTransactionFields
        {...defaultProps}
        payees={payees}
      />
    );

    const payeeSelect = screen.getByTestId('combobox-select-Payee');
    const options = Array.from(payeeSelect.querySelectorAll('option'));
    const labels = options.map(o => o.textContent);

    expect(labels).toContain('Grocery Store');
    expect(labels).toContain('Gas Station');
  });

  it('calls handlePayeeChange when a payee is selected', () => {
    const payees = [
      createPayee({ id: 'p1', name: 'Grocery Store' }),
    ];

    render(
      <NormalTransactionFields
        {...defaultProps}
        payees={payees}
      />
    );

    const payeeSelect = screen.getByTestId('combobox-select-Payee');
    fireEvent.change(payeeSelect, { target: { value: 'p1' } });

    expect(defaultProps.handlePayeeChange).toHaveBeenCalledWith('p1', 'Grocery Store');
  });

  it('calls handlePayeeCreate when create button is clicked', () => {
    render(<NormalTransactionFields {...defaultProps} />);

    const createButton = screen.getByTestId('combobox-create-Payee');
    fireEvent.click(createButton);

    expect(defaultProps.handlePayeeCreate).toHaveBeenCalledWith('New Item');
  });

  it('displays category options in the Category combobox', () => {
    const categoryOptions = [
      { value: 'cat-1', label: 'Groceries' },
      { value: 'cat-2', label: 'Entertainment' },
    ];

    render(
      <NormalTransactionFields
        {...defaultProps}
        categoryOptions={categoryOptions}
      />
    );

    const categorySelect = screen.getByTestId('combobox-select-Category');
    const options = Array.from(categorySelect.querySelectorAll('option'));
    const labels = options.map(o => o.textContent);

    expect(labels).toContain('Groceries');
    expect(labels).toContain('Entertainment');
  });

  it('calls handleCategoryChange when a category is selected', () => {
    const categoryOptions = [
      { value: 'cat-1', label: 'Groceries' },
    ];

    render(
      <NormalTransactionFields
        {...defaultProps}
        categoryOptions={categoryOptions}
      />
    );

    const categorySelect = screen.getByTestId('combobox-select-Category');
    fireEvent.change(categorySelect, { target: { value: 'cat-1' } });

    expect(defaultProps.handleCategoryChange).toHaveBeenCalledWith('cat-1', 'Groceries');
  });

  it('calls handleCategoryCreate when category create button is clicked', () => {
    render(<NormalTransactionFields {...defaultProps} />);

    const createButton = screen.getByTestId('combobox-create-Category');
    fireEvent.click(createButton);

    expect(defaultProps.handleCategoryCreate).toHaveBeenCalledWith('New Item');
  });

  it('calls handleAmountChange when amount input changes', () => {
    render(<NormalTransactionFields {...defaultProps} />);

    const amountInput = screen.getByTestId('currency-input-field-Amount');
    fireEvent.change(amountInput, { target: { value: '42.50' } });

    expect(defaultProps.handleAmountChange).toHaveBeenCalledWith(42.50);
  });

  it('calls handleModeChange with "split" when Split Transaction button is clicked', () => {
    render(<NormalTransactionFields {...defaultProps} />);

    // There are two split buttons (desktop and mobile), click the first
    const splitButtons = screen.getAllByText('Split Transaction');
    fireEvent.click(splitButtons[0]);

    expect(defaultProps.handleModeChange).toHaveBeenCalledWith('split');
  });

  it('includes currency code in account labels', () => {
    const usdAccount = createAccount({ id: 'acc-usd', name: 'US Savings', currencyCode: 'USD' });

    render(
      <NormalTransactionFields
        {...defaultProps}
        accounts={[usdAccount]}
      />
    );

    const accountSelect = screen.getByLabelText('Account');
    const options = Array.from(accountSelect.querySelectorAll('option'));
    const labels = options.map(o => o.textContent);

    expect(labels).toContain('US Savings (USD)');
  });

  it('shows the first option as "Select account..." placeholder', () => {
    render(
      <NormalTransactionFields
        {...defaultProps}
        accounts={[createAccount()]}
      />
    );

    const accountSelect = screen.getByLabelText('Account');
    const firstOption = accountSelect.querySelector('option');

    expect(firstOption?.textContent).toBe('Select account...');
    expect(firstOption?.value).toBe('');
  });

  it('passes watchedAmount as value to CurrencyInput', () => {
    render(
      <NormalTransactionFields
        {...defaultProps}
        watchedAmount={99.99}
      />
    );

    const amountInput = screen.getByTestId('currency-input-field-Amount');
    expect(amountInput).toHaveValue(99.99);
  });

  it('passes selectedPayeeId as value to the Payee combobox', () => {
    const payees = [
      createPayee({ id: 'p1', name: 'Selected Payee' }),
    ];

    render(
      <NormalTransactionFields
        {...defaultProps}
        payees={payees}
        selectedPayeeId="p1"
      />
    );

    const payeeSelect = screen.getByTestId('combobox-select-Payee');
    expect(payeeSelect).toHaveValue('p1');
  });

  it('passes selectedCategoryId as value to the Category combobox', () => {
    const categoryOptions = [
      { value: 'cat-1', label: 'Groceries' },
    ];

    render(
      <NormalTransactionFields
        {...defaultProps}
        categoryOptions={categoryOptions}
        selectedCategoryId="cat-1"
      />
    );

    const categorySelect = screen.getByTestId('combobox-select-Category');
    expect(categorySelect).toHaveValue('cat-1');
  });
});
