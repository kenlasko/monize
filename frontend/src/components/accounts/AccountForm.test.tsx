import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@/test/render';
import { AccountForm } from './AccountForm';
import { Account } from '@/types/account';
import { exchangeRatesApi } from '@/lib/exchange-rates';
import { accountsApi } from '@/lib/accounts';
import { categoriesApi } from '@/lib/categories';

vi.mock('@/lib/accounts', () => ({
  accountsApi: {
    getAll: vi.fn().mockResolvedValue([]),
    previewLoanAmortization: vi.fn(),
    previewMortgageAmortization: vi.fn(),
  },
}));

vi.mock('@/lib/categories', () => ({
  categoriesApi: {
    getAll: vi.fn().mockResolvedValue([]),
    create: vi.fn(),
  },
}));

vi.mock('@/lib/exchange-rates', () => ({
  exchangeRatesApi: {
    getCurrencies: vi.fn().mockResolvedValue([
      { code: 'CAD', name: 'Canadian Dollar', symbol: 'CA$', decimalPlaces: 2, isActive: true },
      { code: 'USD', name: 'US Dollar', symbol: '$', decimalPlaces: 2, isActive: true },
      { code: 'EUR', name: 'Euro', symbol: 'E', decimalPlaces: 2, isActive: true },
    ]),
  },
  CurrencyInfo: {},
}));

vi.mock('@/hooks/useNumberFormat', () => ({
  useNumberFormat: () => ({
    formatCurrency: (n: number) => `$${n.toFixed(2)}`,
  }),
}));

vi.mock('@/hooks/useExchangeRates', () => ({
  useExchangeRates: () => ({
    defaultCurrency: 'CAD',
    convertToDefault: (n: number) => n,
  }),
}));

vi.mock('@/lib/format', () => ({
  getCurrencySymbol: () => '$',
  roundToCents: (v: number) => Math.round(v * 100) / 100,
  formatAmount: (v: number | undefined | null) => (v === undefined || v === null || isNaN(v)) ? '' : (Math.round(v * 100) / 100).toFixed(2),
  formatAmountWithCommas: (v: number | undefined | null) => (v === undefined || v === null || isNaN(v)) ? '' : (Math.round(v * 100) / 100).toFixed(2),
  parseAmount: (input: string) => { const n = parseFloat(input.replace(/[^0-9.-]/g, '')); return isNaN(n) ? undefined : Math.round(n * 100) / 100; },
  filterCurrencyInput: (input: string) => input.replace(/[^0-9.-]/g, ''),
  filterCalculatorInput: (input: string) => input.replace(/[^0-9.+\-*/() ]/g, ''),
  hasCalculatorOperators: (input: string) => /[+*/()]/.test(input.replace(/^-/, '')) || /(?!^)-/.test(input),
  evaluateExpression: (input: string) => { try { const r = new Function(`"use strict"; return (${input})`)(); return typeof r === 'number' && isFinite(r) ? Math.round(r * 100) / 100 : undefined; } catch { return undefined; } },
  formatCurrency: (amount: number) => `$${amount.toFixed(2)}`,
}));

vi.mock('@/lib/categoryUtils', () => ({
  buildCategoryTree: (cats: any[]) => cats.map((c: any) => ({ category: c, children: [] })),
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  }),
}));

function createExistingAccount(overrides: Partial<Account> = {}): Account {
  return {
    id: '123e4567-e89b-12d3-a456-426614174000',
    userId: 'user-1',
    accountType: 'CHEQUING',
    accountSubType: null,
    linkedAccountId: null,
    name: 'My Chequing',
    description: null,
    currencyCode: 'CAD',
    accountNumber: null,
    institution: null,
    openingBalance: 1000,
    currentBalance: 1500,
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

describe('AccountForm', () => {
  const mockOnSubmit = vi.fn().mockResolvedValue(undefined);
  const mockOnCancel = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders account name input', () => {
    render(
      <AccountForm onSubmit={mockOnSubmit} onCancel={mockOnCancel} />
    );

    expect(screen.getByText('Account Name')).toBeInTheDocument();
  });

  it('renders account type select with options', () => {
    render(
      <AccountForm onSubmit={mockOnSubmit} onCancel={mockOnCancel} />
    );

    expect(screen.getByText('Account Type')).toBeInTheDocument();
  });

  it('shows "Create Account" button for new account', () => {
    render(
      <AccountForm onSubmit={mockOnSubmit} onCancel={mockOnCancel} />
    );

    expect(screen.getByRole('button', { name: /Create Account/i })).toBeInTheDocument();
  });

  it('shows "Update Account" button when editing', () => {
    const existingAccount = createExistingAccount();

    render(
      <AccountForm
        account={existingAccount}
        onSubmit={mockOnSubmit}
        onCancel={mockOnCancel}
      />
    );

    expect(screen.getByRole('button', { name: /Update Account/i })).toBeInTheDocument();
  });

  it('calls onCancel when Cancel button is clicked', () => {
    render(
      <AccountForm onSubmit={mockOnSubmit} onCancel={mockOnCancel} />
    );

    fireEvent.click(screen.getByRole('button', { name: /Cancel/i }));
    expect(mockOnCancel).toHaveBeenCalledTimes(1);
  });

  it('shows Investment pair checkbox when INVESTMENT type is selected (new account)', async () => {
    render(
      <AccountForm onSubmit={mockOnSubmit} onCancel={mockOnCancel} />
    );

    // Select INVESTMENT type
    const typeSelect = screen.getByLabelText('Account Type') as HTMLSelectElement;
    fireEvent.change(typeSelect, { target: { value: 'INVESTMENT' } });

    await waitFor(() => {
      expect(screen.getByText(/Create as Cash \+ Brokerage pair/i)).toBeInTheDocument();
    });
  });

  it('shows loan fields when LOAN type is selected for a new account', async () => {
    render(
      <AccountForm onSubmit={mockOnSubmit} onCancel={mockOnCancel} />
    );

    const typeSelect = screen.getByLabelText('Account Type') as HTMLSelectElement;
    fireEvent.change(typeSelect, { target: { value: 'LOAN' } });

    await waitFor(() => {
      expect(screen.getByText('Loan Payment Details')).toBeInTheDocument();
    });
  });

  it('shows favourite toggle', () => {
    render(
      <AccountForm onSubmit={mockOnSubmit} onCancel={mockOnCancel} />
    );

    expect(screen.getByText('Add to favourites')).toBeInTheDocument();
  });

  it('toggles favourite when star button is clicked', () => {
    render(
      <AccountForm onSubmit={mockOnSubmit} onCancel={mockOnCancel} />
    );

    const favButton = screen.getByTitle('Add to favourites');
    fireEvent.click(favButton);

    expect(screen.getByText('Favourite')).toBeInTheDocument();
  });

  it('shows Import QIF button only when editing an existing account', () => {
    const existingAccount = createExistingAccount();

    render(
      <AccountForm
        account={existingAccount}
        onSubmit={mockOnSubmit}
        onCancel={mockOnCancel}
      />
    );

    expect(screen.getByText('Import QIF')).toBeInTheDocument();
  });

  it('does not show Import QIF button for new accounts', () => {
    render(
      <AccountForm onSubmit={mockOnSubmit} onCancel={mockOnCancel} />
    );

    expect(screen.queryByText('Import QIF')).not.toBeInTheDocument();
  });

  // --- New tests for improved coverage ---

  it('renders all standard form fields for a new account', () => {
    render(
      <AccountForm onSubmit={mockOnSubmit} onCancel={mockOnCancel} />
    );

    expect(screen.getByText('Account Name')).toBeInTheDocument();
    expect(screen.getByText('Account Type')).toBeInTheDocument();
    expect(screen.getByText('Currency')).toBeInTheDocument();
    expect(screen.getByText('Opening Balance')).toBeInTheDocument();
    expect(screen.getByText('Account Number (optional)')).toBeInTheDocument();
    expect(screen.getByText('Institution (optional)')).toBeInTheDocument();
    expect(screen.getByText('Credit Limit (optional)')).toBeInTheDocument();
    expect(screen.getByText('Interest Rate % (optional)')).toBeInTheDocument();
    expect(screen.getByText('Description (optional)')).toBeInTheDocument();
  });

  it('renders all account type options in the select', () => {
    render(
      <AccountForm onSubmit={mockOnSubmit} onCancel={mockOnCancel} />
    );

    const typeSelect = screen.getByLabelText('Account Type') as HTMLSelectElement;
    const options = Array.from(typeSelect.querySelectorAll('option'));
    const optionValues = options.map(o => o.value);

    expect(optionValues).toContain('CHEQUING');
    expect(optionValues).toContain('SAVINGS');
    expect(optionValues).toContain('CREDIT_CARD');
    expect(optionValues).toContain('INVESTMENT');
    expect(optionValues).toContain('LOAN');
    expect(optionValues).toContain('LINE_OF_CREDIT');
    expect(optionValues).toContain('MORTGAGE');
    expect(optionValues).toContain('ASSET');
    expect(optionValues).toContain('CASH');
    expect(optionValues).toContain('OTHER');
  });

  it('populates form values when editing an existing account', () => {
    const existingAccount = createExistingAccount({
      name: 'My Savings',
      accountType: 'SAVINGS',
      currencyCode: 'CAD',
      description: 'Test description',
      institution: 'RBC',
      accountNumber: '1234567',
    });

    render(
      <AccountForm
        account={existingAccount}
        onSubmit={mockOnSubmit}
        onCancel={mockOnCancel}
      />
    );

    expect(screen.getByDisplayValue('My Savings')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Test description')).toBeInTheDocument();
    expect(screen.getByDisplayValue('RBC')).toBeInTheDocument();
    expect(screen.getByDisplayValue('1234567')).toBeInTheDocument();
  });

  it('does not show Investment pair checkbox when editing an existing INVESTMENT account', () => {
    const investmentAccount = createExistingAccount({
      accountType: 'INVESTMENT',
    });

    render(
      <AccountForm
        account={investmentAccount}
        onSubmit={mockOnSubmit}
        onCancel={mockOnCancel}
      />
    );

    expect(screen.queryByText(/Create as Cash \+ Brokerage pair/i)).not.toBeInTheDocument();
  });

  it('shows loan-specific label for opening balance when LOAN selected', async () => {
    render(
      <AccountForm onSubmit={mockOnSubmit} onCancel={mockOnCancel} />
    );

    const typeSelect = screen.getByLabelText('Account Type') as HTMLSelectElement;
    fireEvent.change(typeSelect, { target: { value: 'LOAN' } });

    await waitFor(() => {
      expect(screen.getByText('Loan Amount')).toBeInTheDocument();
    });
  });

  it('shows mortgage-specific label for opening balance when MORTGAGE selected', async () => {
    render(
      <AccountForm onSubmit={mockOnSubmit} onCancel={mockOnCancel} />
    );

    const typeSelect = screen.getByLabelText('Account Type') as HTMLSelectElement;
    fireEvent.change(typeSelect, { target: { value: 'MORTGAGE' } });

    await waitFor(() => {
      expect(screen.getByText('Mortgage Amount')).toBeInTheDocument();
    });
  });

  it('shows "Interest Rate % (required)" label for LOAN type', async () => {
    render(
      <AccountForm onSubmit={mockOnSubmit} onCancel={mockOnCancel} />
    );

    const typeSelect = screen.getByLabelText('Account Type') as HTMLSelectElement;
    fireEvent.change(typeSelect, { target: { value: 'LOAN' } });

    await waitFor(() => {
      expect(screen.getByText('Interest Rate % (required)')).toBeInTheDocument();
    });
  });

  it('shows "Interest Rate % (required)" label for MORTGAGE type', async () => {
    render(
      <AccountForm onSubmit={mockOnSubmit} onCancel={mockOnCancel} />
    );

    const typeSelect = screen.getByLabelText('Account Type') as HTMLSelectElement;
    fireEvent.change(typeSelect, { target: { value: 'MORTGAGE' } });

    await waitFor(() => {
      expect(screen.getByText('Interest Rate % (required)')).toBeInTheDocument();
    });
  });

  it('hides credit limit field for LOAN type', async () => {
    render(
      <AccountForm onSubmit={mockOnSubmit} onCancel={mockOnCancel} />
    );

    expect(screen.getByText('Credit Limit (optional)')).toBeInTheDocument();

    const typeSelect = screen.getByLabelText('Account Type') as HTMLSelectElement;
    fireEvent.change(typeSelect, { target: { value: 'LOAN' } });

    await waitFor(() => {
      expect(screen.queryByText('Credit Limit (optional)')).not.toBeInTheDocument();
    });
  });

  it('hides credit limit and interest rate fields for ASSET type', async () => {
    render(
      <AccountForm onSubmit={mockOnSubmit} onCancel={mockOnCancel} />
    );

    const typeSelect = screen.getByLabelText('Account Type') as HTMLSelectElement;
    fireEvent.change(typeSelect, { target: { value: 'ASSET' } });

    await waitFor(() => {
      expect(screen.queryByText('Credit Limit (optional)')).not.toBeInTheDocument();
      expect(screen.queryByText('Interest Rate % (optional)')).not.toBeInTheDocument();
    });
  });

  it('shows "Lender/Institution (required)" label for LOAN type', async () => {
    render(
      <AccountForm onSubmit={mockOnSubmit} onCancel={mockOnCancel} />
    );

    const typeSelect = screen.getByLabelText('Account Type') as HTMLSelectElement;
    fireEvent.change(typeSelect, { target: { value: 'LOAN' } });

    await waitFor(() => {
      expect(screen.getByText('Lender/Institution (required)')).toBeInTheDocument();
    });
  });

  it('shows "Lender/Institution (required)" label for MORTGAGE type', async () => {
    render(
      <AccountForm onSubmit={mockOnSubmit} onCancel={mockOnCancel} />
    );

    const typeSelect = screen.getByLabelText('Account Type') as HTMLSelectElement;
    fireEvent.change(typeSelect, { target: { value: 'MORTGAGE' } });

    await waitFor(() => {
      expect(screen.getByText('Lender/Institution (required)')).toBeInTheDocument();
    });
  });

  it('does not show loan fields when LOAN type is selected for editing existing account', () => {
    const loanAccount = createExistingAccount({
      accountType: 'LOAN',
      interestRate: 5.5,
      paymentAmount: 500,
    });

    render(
      <AccountForm
        account={loanAccount}
        onSubmit={mockOnSubmit}
        onCancel={mockOnCancel}
      />
    );

    // Loan payment details are only shown for new accounts
    expect(screen.queryByText('Loan Payment Details')).not.toBeInTheDocument();
  });

  it('shows mortgage fields when MORTGAGE type is selected for a new account', async () => {
    render(
      <AccountForm onSubmit={mockOnSubmit} onCancel={mockOnCancel} />
    );

    const typeSelect = screen.getByLabelText('Account Type') as HTMLSelectElement;
    fireEvent.change(typeSelect, { target: { value: 'MORTGAGE' } });

    await waitFor(() => {
      expect(screen.getByText('Mortgage Details')).toBeInTheDocument();
    });
  });

  it('does not show mortgage fields when editing existing MORTGAGE account', () => {
    const mortgageAccount = createExistingAccount({
      accountType: 'MORTGAGE',
      interestRate: 3.5,
    });

    render(
      <AccountForm
        account={mortgageAccount}
        onSubmit={mockOnSubmit}
        onCancel={mockOnCancel}
      />
    );

    expect(screen.queryByText('Mortgage Details')).not.toBeInTheDocument();
  });

  it('shows asset fields when ASSET type is selected', async () => {
    render(
      <AccountForm onSubmit={mockOnSubmit} onCancel={mockOnCancel} />
    );

    const typeSelect = screen.getByLabelText('Account Type') as HTMLSelectElement;
    fireEvent.change(typeSelect, { target: { value: 'ASSET' } });

    await waitFor(() => {
      expect(screen.getByText('Date Acquired')).toBeInTheDocument();
    });
  });

  it('toggles favourite star from on to off', () => {
    const favAccount = createExistingAccount({ isFavourite: true });

    render(
      <AccountForm
        account={favAccount}
        onSubmit={mockOnSubmit}
        onCancel={mockOnCancel}
      />
    );

    expect(screen.getByText('Favourite')).toBeInTheDocument();

    const favButton = screen.getByTitle('Remove from favourites');
    fireEvent.click(favButton);

    expect(screen.getByText('Add to favourites')).toBeInTheDocument();
  });

  it('loads currencies and renders currency dropdown options', async () => {
    render(
      <AccountForm onSubmit={mockOnSubmit} onCancel={mockOnCancel} />
    );

    await waitFor(() => {
      expect(exchangeRatesApi.getCurrencies).toHaveBeenCalled();
    });

    // Currency select should be present
    expect(screen.getByText('Currency')).toBeInTheDocument();
  });

  it('submits the form with valid data', async () => {
    render(
      <AccountForm onSubmit={mockOnSubmit} onCancel={mockOnCancel} />
    );

    // Fill in account name
    const nameInput = screen.getByLabelText('Account Name');
    fireEvent.change(nameInput, { target: { value: 'New Account' } });

    // Submit form
    const submitButton = screen.getByRole('button', { name: /Create Account/i });
    fireEvent.click(submitButton);

    await waitFor(() => {
      expect(mockOnSubmit).toHaveBeenCalled();
    });
  });

  it('shows validation error when name is empty on submit', async () => {
    render(
      <AccountForm onSubmit={mockOnSubmit} onCancel={mockOnCancel} />
    );

    // Clear any default values in the name field
    const nameInput = screen.getByLabelText('Account Name');
    fireEvent.change(nameInput, { target: { value: '' } });

    // Submit form without name
    const submitButton = screen.getByRole('button', { name: /Create Account/i });
    fireEvent.click(submitButton);

    await waitFor(() => {
      expect(screen.getByText('Account name is required')).toBeInTheDocument();
    });

    // onSubmit should NOT have been called
    expect(mockOnSubmit).not.toHaveBeenCalled();
  });

  it('loads accounts and categories when LOAN type is selected for new account', async () => {
    render(
      <AccountForm onSubmit={mockOnSubmit} onCancel={mockOnCancel} />
    );

    const typeSelect = screen.getByLabelText('Account Type') as HTMLSelectElement;
    fireEvent.change(typeSelect, { target: { value: 'LOAN' } });

    await waitFor(() => {
      expect(accountsApi.getAll).toHaveBeenCalled();
      expect(categoriesApi.getAll).toHaveBeenCalled();
    });
  });

  it('loads accounts and categories when MORTGAGE type is selected for new account', async () => {
    render(
      <AccountForm onSubmit={mockOnSubmit} onCancel={mockOnCancel} />
    );

    const typeSelect = screen.getByLabelText('Account Type') as HTMLSelectElement;
    fireEvent.change(typeSelect, { target: { value: 'MORTGAGE' } });

    await waitFor(() => {
      expect(accountsApi.getAll).toHaveBeenCalled();
      expect(categoriesApi.getAll).toHaveBeenCalled();
    });
  });

  it('loads accounts and categories when ASSET type is selected', async () => {
    render(
      <AccountForm onSubmit={mockOnSubmit} onCancel={mockOnCancel} />
    );

    const typeSelect = screen.getByLabelText('Account Type') as HTMLSelectElement;
    fireEvent.change(typeSelect, { target: { value: 'ASSET' } });

    await waitFor(() => {
      expect(accountsApi.getAll).toHaveBeenCalled();
      expect(categoriesApi.getAll).toHaveBeenCalled();
    });
  });

  it('shows standard fields when SAVINGS type is selected', () => {
    render(
      <AccountForm onSubmit={mockOnSubmit} onCancel={mockOnCancel} />
    );

    const typeSelect = screen.getByLabelText('Account Type') as HTMLSelectElement;
    fireEvent.change(typeSelect, { target: { value: 'SAVINGS' } });

    // Standard fields should still be present
    expect(screen.getByText('Opening Balance')).toBeInTheDocument();
    expect(screen.getByText('Credit Limit (optional)')).toBeInTheDocument();
    expect(screen.getByText('Interest Rate % (optional)')).toBeInTheDocument();
  });

  it('shows standard fields when CREDIT_CARD type is selected', () => {
    render(
      <AccountForm onSubmit={mockOnSubmit} onCancel={mockOnCancel} />
    );

    const typeSelect = screen.getByLabelText('Account Type') as HTMLSelectElement;
    fireEvent.change(typeSelect, { target: { value: 'CREDIT_CARD' } });

    expect(screen.getByText('Opening Balance')).toBeInTheDocument();
    expect(screen.getByText('Credit Limit (optional)')).toBeInTheDocument();
    expect(screen.getByText('Interest Rate % (optional)')).toBeInTheDocument();
  });

  it('calls onDirtyChange when form becomes dirty', async () => {
    const mockOnDirtyChange = vi.fn();

    render(
      <AccountForm
        onSubmit={mockOnSubmit}
        onCancel={mockOnCancel}
        onDirtyChange={mockOnDirtyChange}
      />
    );

    // Change a field to make the form dirty
    const nameInput = screen.getByLabelText('Account Name');
    fireEvent.change(nameInput, { target: { value: 'Changed' } });

    await waitFor(() => {
      expect(mockOnDirtyChange).toHaveBeenCalledWith(true);
    });
  });

  it('populates existing account values including credit card fields', () => {
    const ccAccount = createExistingAccount({
      accountType: 'CREDIT_CARD',
      creditLimit: 10000,
      interestRate: 19.99,
    });

    render(
      <AccountForm
        account={ccAccount}
        onSubmit={mockOnSubmit}
        onCancel={mockOnCancel}
      />
    );

    expect(screen.getByDisplayValue('19.99')).toBeInTheDocument();
  });

  it('switches from one type to another correctly', async () => {
    render(
      <AccountForm onSubmit={mockOnSubmit} onCancel={mockOnCancel} />
    );

    const typeSelect = screen.getByLabelText('Account Type') as HTMLSelectElement;

    // First switch to LOAN
    fireEvent.change(typeSelect, { target: { value: 'LOAN' } });
    await waitFor(() => {
      expect(screen.getByText('Loan Payment Details')).toBeInTheDocument();
    });

    // Then switch to SAVINGS - loan fields should disappear
    fireEvent.change(typeSelect, { target: { value: 'SAVINGS' } });
    await waitFor(() => {
      expect(screen.queryByText('Loan Payment Details')).not.toBeInTheDocument();
    });
  });
});
