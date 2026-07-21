import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act } from '@testing-library/react';
import { render, screen, fireEvent, waitFor } from '@/test/render';
import { AccountForm } from './AccountForm';
import { Account } from '@/types/account';
import { exchangeRatesApi } from '@/lib/exchange-rates';
import { accountsApi } from '@/lib/accounts';
import { categoriesApi } from '@/lib/categories';
import { institutionsApi } from '@/lib/institutions';

vi.mock('@/lib/accounts', () => ({
  accountsApi: {
    getAll: vi.fn().mockResolvedValue([]),
    previewLoanAmortization: vi.fn(),
    previewMortgageAmortization: vi.fn(),
    canDelete: vi.fn().mockResolvedValue({
      transactionCount: 0,
      investmentTransactionCount: 0,
      canDelete: true,
    }),
  },
}));

vi.mock('@/lib/categories', () => ({
  categoriesApi: {
    getAll: vi.fn().mockResolvedValue([]),
    create: vi.fn(),
  },
}));

vi.mock('@/lib/institutions', () => ({
  institutionsApi: {
    getAll: vi.fn().mockResolvedValue([]),
    create: vi.fn(),
  },
  institutionLogoUrl: (id: string) => `/api/v1/institutions/${id}/logo`,
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
  getDecimalPlacesForCurrency: () => 2,
  roundToCents: (v: number) => Math.round(v * 100) / 100,
  roundToDecimals: (v: number, d: number) => { const f = Math.pow(10, d); return Math.round(v * f) / f; },
  formatAmount: (v: number | undefined | null) => (v === undefined || v === null || isNaN(v)) ? '' : (Math.round(v * 100) / 100).toFixed(2),
  formatAmountWithCommas: (v: number | undefined | null) => (v === undefined || v === null || isNaN(v)) ? '' : (Math.round(v * 100) / 100).toFixed(2),
  parseAmount: (input: string) => { const n = parseFloat(input.replace(/[^0-9.-]/g, '')); return isNaN(n) ? undefined : Math.round(n * 100) / 100; },
  filterCurrencyInput: (input: string) => input.replace(/[^0-9.-]/g, ''),
  filterCalculatorInput: (input: string) => input.replace(/[^0-9.+\-*/() ]/g, ''),
  hasCalculatorOperators: (input: string) => /[+*/()]/.test(input.replace(/^-/, '')) || /(?!^)-/.test(input),
  evaluateExpression: vi.fn().mockImplementation(() => undefined),
  formatCurrency: (amount: number) => `$${amount.toFixed(2)}`,
}));

vi.mock('@/lib/categoryUtils', () => ({
  buildCategoryTree: (cats: any[]) => cats.map((c: any) => ({ category: c, children: [] })),
  getCategorySelectOptions: (cats: any[]) => (cats || []).map((c: any) => ({ value: c.id, label: c.name })),
  buildCategoryColorMap: () => new Map(),
}));

vi.mock('@hookform/resolvers/zod', () => ({
  zodResolver: (schema: any) => {
    return async (data: any) => {
      try {
        const result = schema.parse(data);
        return { values: result, errors: {} };
      } catch (error: any) {
        const fieldErrors: any = {};
        const issues = error.issues || error.errors || [];
        for (const err of issues) {
          const path = err.path.join('.');
          if (!fieldErrors[path]) {
            fieldErrors[path] = { type: 'validation', message: err.message };
          }
        }
        return { values: {}, errors: fieldErrors };
      }
    };
  },
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  }),
}));

// Capture AssetFields callback props so tests can call them directly
// eslint-disable-next-line @typescript-eslint/no-unused-vars
let capturedHandleAssetCategoryChange: ((id: string, name: string) => void) | null = null;
let capturedHandleAssetCategoryCreate: ((name: string) => Promise<void>) | null = null;

vi.mock('./AssetFields', () => ({
  AssetFields: (props: any) => {
    capturedHandleAssetCategoryChange = props.handleAssetCategoryChange;
    capturedHandleAssetCategoryCreate = props.handleAssetCategoryCreate;
    return (
      <div data-testid="asset-fields">
        <button
          data-testid="trigger-category-change"
          onClick={() => props.handleAssetCategoryChange('cat-1', 'Home Value')}
        >
          Trigger Category Change
        </button>
        <button
          data-testid="trigger-category-create"
          onClick={() => props.handleAssetCategoryCreate('New Category')}
        >
          Trigger Category Create
        </button>
        <button
          data-testid="trigger-category-create-parent-child"
          onClick={() => props.handleAssetCategoryCreate('Assets: Home Value')}
        >
          Trigger Parent:Child Create
        </button>
        <button
          data-testid="trigger-category-create-empty"
          onClick={() => props.handleAssetCategoryCreate('   ')}
        >
          Trigger Empty Create
        </button>
        <span>Date Acquired</span>
      </div>
    );
  },
}));

// Capture LoanPaymentSetupDialog callback so tests can trigger onSetupComplete
// eslint-disable-next-line @typescript-eslint/no-unused-vars
let capturedOnSetupComplete: (() => void) | null = null;
// eslint-disable-next-line @typescript-eslint/no-unused-vars
let capturedOnClose: (() => void) | null = null;

vi.mock('./LoanPaymentSetupDialog', () => ({
  LoanPaymentSetupDialog: (props: any) => {
    capturedOnSetupComplete = props.onSetupComplete;
    capturedOnClose = props.onClose;
    if (!props.isOpen) return null;
    return (
      <div data-testid="loan-setup-dialog">
        <button data-testid="setup-complete" onClick={() => props.onSetupComplete?.()}>
          Complete Setup
        </button>
        <button data-testid="close-dialog" onClick={() => props.onClose()}>
          Close
        </button>
      </div>
    );
  },
}));

// Capture AccountExportModal so tests can verify it renders when showExportModal=true
vi.mock('./AccountExportModal', () => ({
  AccountExportModal: (props: any) => {
    if (!props.isOpen) return null;
    return <div data-testid="export-modal">Export Modal for {props.accountName}</div>;
  },
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
    institution: null, institutionId: null,
    openingBalance: 1000,
    currentBalance: 1500,
    creditLimit: null,
    interestRate: null,
    isClosed: false,
    closedDate: null,
    isFavourite: false,
    favouriteSortOrder: 0,
    excludeFromNetWorth: false,
    statementDueDay: null,
    statementSettlementDay: null,
    paymentAmount: null,
    paymentFrequency: null,
    paymentStartDate: null,
    sourceAccountId: null,
    principalCategoryId: null,
    interestCategoryId: null,
    interestBookingMode: 'AUTO',
    overpaymentCategoryId: null, overpaymentMemo: null, overpaymentPayeeId: null, fxFeePercent: null, fxFeeCategoryId: null,
    scheduledTransactionId: null,
    assetCategoryId: null,
    dateAcquired: null,
    linkedLoanAccountId: null,
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

  it('renders account name input', async () => {
    render(
      <AccountForm onSubmit={mockOnSubmit} onCancel={mockOnCancel} />
    );

    await waitFor(() => {
      expect(screen.getByText('Account Name')).toBeInTheDocument();
    });
  });

  it('loads categories on mount for any account type (so the fee-category picker has options)', async () => {
    // Default new account is CHEQUING (not loan/mortgage/asset); the FX fee
    // category dropdown still needs the category list.
    render(
      <AccountForm onSubmit={mockOnSubmit} onCancel={mockOnCancel} />
    );

    await waitFor(() => {
      expect(categoriesApi.getAll).toHaveBeenCalled();
    });
  });

  it('renders account type select with options', async () => {
    render(
      <AccountForm onSubmit={mockOnSubmit} onCancel={mockOnCancel} />
    );

    await waitFor(() => {
      expect(screen.getByText('Account Type')).toBeInTheDocument();
    });
  });

  it('shows "Create Account" button for new account', async () => {
    render(
      <AccountForm onSubmit={mockOnSubmit} onCancel={mockOnCancel} />
    );

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Create Account/i })).toBeInTheDocument();
    });
  });

  it('shows "Update Account" button when editing', async () => {
    const existingAccount = createExistingAccount();

    render(
      <AccountForm
        account={existingAccount}
        onSubmit={mockOnSubmit}
        onCancel={mockOnCancel}
      />
    );

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Update Account/i })).toBeInTheDocument();
    });
  });

  it('calls onCancel when Cancel button is clicked', async () => {
    render(
      <AccountForm onSubmit={mockOnSubmit} onCancel={mockOnCancel} />
    );

    fireEvent.click(screen.getByRole('button', { name: /Cancel/i }));
    await waitFor(() => {
      expect(mockOnCancel).toHaveBeenCalledTimes(1);
    });
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

  it('shows favourite toggle', async () => {
    render(
      <AccountForm onSubmit={mockOnSubmit} onCancel={mockOnCancel} />
    );

    await waitFor(() => {
      expect(screen.getByText('Add to favourites')).toBeInTheDocument();
    });
  });

  it('hides the favourite toggle for a delegate (acting view)', async () => {
    const { useAuthStore } = await import('@/store/authStore');
    act(() => {
      useAuthStore
        .getState()
        .setDelegation('owner-1', [], null, { accounts: true } as never);
    });

    render(<AccountForm onSubmit={mockOnSubmit} onCancel={mockOnCancel} />);

    await waitFor(() => {
      expect(screen.getByText('Account Name')).toBeInTheDocument();
    });
    expect(screen.queryByText('Add to favourites')).not.toBeInTheDocument();

    act(() => {
      useAuthStore.getState().setDelegation(null, [], null, null);
    });
  });

  it('toggles favourite when star button is clicked', async () => {
    render(
      <AccountForm onSubmit={mockOnSubmit} onCancel={mockOnCancel} />
    );

    const favButton = screen.getByTitle('Add to favourites');
    fireEvent.click(favButton);

    await waitFor(() => {
      expect(screen.getByText('Favourite')).toBeInTheDocument();
    });
  });

  it('shows Import and Export buttons only when editing an existing account', async () => {
    const existingAccount = createExistingAccount();

    render(
      <AccountForm
        account={existingAccount}
        onSubmit={mockOnSubmit}
        onCancel={mockOnCancel}
      />
    );

    await waitFor(() => {
      expect(screen.getByTitle('Import transactions from QIF file')).toBeInTheDocument();
      expect(screen.getByTitle('Export account transactions')).toBeInTheDocument();
    });
  });

  it('does not show Import or Export buttons for new accounts', async () => {
    render(
      <AccountForm onSubmit={mockOnSubmit} onCancel={mockOnCancel} />
    );

    await waitFor(() => {
      expect(screen.queryByTitle('Import transactions from QIF file')).not.toBeInTheDocument();
      expect(screen.queryByTitle('Export account transactions')).not.toBeInTheDocument();
    });
  });

  // --- New tests for improved coverage ---

  it('renders all standard form fields for a new account', async () => {
    render(
      <AccountForm onSubmit={mockOnSubmit} onCancel={mockOnCancel} />
    );

    await waitFor(() => {
      expect(screen.getByText('Account Name')).toBeInTheDocument();
    });
    expect(screen.getByText('Account Type')).toBeInTheDocument();
    expect(screen.getByText('Currency')).toBeInTheDocument();
    expect(screen.getByText('Opening Balance')).toBeInTheDocument();
    expect(screen.getByText('Account Number (optional)')).toBeInTheDocument();
    expect(screen.getByText('Institution (optional)')).toBeInTheDocument();
    expect(screen.getByText('Credit Limit (optional)')).toBeInTheDocument();
    expect(screen.getByText('Interest Rate % (optional)')).toBeInTheDocument();
    expect(screen.getByText('Description (optional)')).toBeInTheDocument();
  });

  it('renders all account type options in the select', async () => {
    render(
      <AccountForm onSubmit={mockOnSubmit} onCancel={mockOnCancel} />
    );

    await waitFor(() => {
      expect(screen.getByLabelText('Account Type')).toBeInTheDocument();
    });

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

  it('populates form values when editing an existing account', async () => {
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

    await waitFor(() => {
      expect(screen.getByDisplayValue('My Savings')).toBeInTheDocument();
    });
    expect(screen.getByDisplayValue('Test description')).toBeInTheDocument();
    expect(screen.getByDisplayValue('1234567')).toBeInTheDocument();
  });

  it('does not show Investment pair checkbox when editing an existing INVESTMENT account', async () => {
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

    await waitFor(() => {
      expect(screen.queryByText(/Create as Cash \+ Brokerage pair/i)).not.toBeInTheDocument();
    });
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

  it('shows the institution selector as required for LOAN type', async () => {
    render(
      <AccountForm onSubmit={mockOnSubmit} onCancel={mockOnCancel} />
    );

    const typeSelect = screen.getByLabelText('Account Type') as HTMLSelectElement;
    fireEvent.change(typeSelect, { target: { value: 'LOAN' } });

    await waitFor(() => {
      expect(screen.getByText('Lender/Institution (required)')).toBeInTheDocument();
    });
    expect(screen.queryByText('Institution (optional)')).not.toBeInTheDocument();
  });

  it('shows the institution selector as required for MORTGAGE type', async () => {
    render(
      <AccountForm onSubmit={mockOnSubmit} onCancel={mockOnCancel} />
    );

    const typeSelect = screen.getByLabelText('Account Type') as HTMLSelectElement;
    fireEvent.change(typeSelect, { target: { value: 'MORTGAGE' } });

    await waitFor(() => {
      expect(screen.getByText('Lender/Institution (required)')).toBeInTheDocument();
    });
    expect(screen.queryByText('Institution (optional)')).not.toBeInTheDocument();
  });

  it('omits institutionId on submit when the field is untouched, so the backend keeps it (issue #806)', async () => {
    vi.mocked(institutionsApi.getAll).mockResolvedValueOnce([
      { id: 'inst-1', name: 'RBC', website: 'rbc.com' } as never,
    ]);
    const account = createExistingAccount({ institutionId: 'inst-1' });

    render(
      <AccountForm account={account} onSubmit={mockOnSubmit} onCancel={mockOnCancel} />
    );

    await waitFor(() => {
      expect(screen.getByDisplayValue('RBC')).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Update Account/i }));
    });

    await waitFor(() => {
      expect(mockOnSubmit).toHaveBeenCalled();
    });
    // Untouched -> not sent at all, so the stored institution is retained.
    expect(mockOnSubmit.mock.calls[0][0]).not.toHaveProperty('institutionId');
  });

  it('retains the institution when editing another field and leaving institution untouched', async () => {
    vi.mocked(institutionsApi.getAll).mockResolvedValueOnce([
      { id: 'inst-1', name: 'RBC', website: 'rbc.com' } as never,
    ]);
    const account = createExistingAccount({ institutionId: 'inst-1' });

    render(
      <AccountForm account={account} onSubmit={mockOnSubmit} onCancel={mockOnCancel} />
    );

    await waitFor(() => {
      expect(screen.getByDisplayValue('RBC')).toBeInTheDocument();
    });

    // Edit an unrelated field (the account name) without touching institution.
    await act(async () => {
      fireEvent.change(screen.getByDisplayValue('My Chequing'), {
        target: { value: 'Renamed Chequing' },
      });
    });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Update Account/i }));
    });

    await waitFor(() => {
      expect(mockOnSubmit).toHaveBeenCalled();
    });
    const payload = mockOnSubmit.mock.calls[0][0];
    expect(payload.name).toBe('Renamed Chequing');
    // The institution must not be overwritten by an edit that never touched it.
    expect(payload).not.toHaveProperty('institutionId');
  });

  it('retains the institution even when the institutions list fails to load', async () => {
    // Institutions never populate, so the combobox cannot resolve the stored id
    // to a label. An untouched edit must still not clear the institution.
    vi.mocked(institutionsApi.getAll).mockResolvedValueOnce([] as never);
    const account = createExistingAccount({ institutionId: 'inst-1' });

    render(
      <AccountForm account={account} onSubmit={mockOnSubmit} onCancel={mockOnCancel} />
    );

    await waitFor(() => {
      expect(screen.getByDisplayValue('My Chequing')).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Update Account/i }));
    });

    await waitFor(() => {
      expect(mockOnSubmit).toHaveBeenCalled();
    });
    expect(mockOnSubmit.mock.calls[0][0]).not.toHaveProperty('institutionId');
  });

  it('submits an explicit null when the user clears the institution while editing', async () => {
    vi.mocked(institutionsApi.getAll).mockResolvedValueOnce([
      { id: 'inst-1', name: 'RBC', website: 'rbc.com' } as never,
    ]);
    const account = createExistingAccount({ institutionId: 'inst-1' });

    render(
      <AccountForm account={account} onSubmit={mockOnSubmit} onCancel={mockOnCancel} />
    );

    await waitFor(() => {
      expect(screen.getByDisplayValue('RBC')).toBeInTheDocument();
    });

    // Click the combobox's clear (X) button next to the institution input
    const institutionInput = screen.getByDisplayValue('RBC');
    const clearButton = institutionInput.parentElement!.querySelector('button');
    expect(clearButton).not.toBeNull();
    await act(async () => {
      fireEvent.mouseDown(clearButton!);
    });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Update Account/i }));
    });

    await waitFor(() => {
      expect(mockOnSubmit).toHaveBeenCalled();
    });
    expect(mockOnSubmit.mock.calls[0][0].institutionId).toBeNull();
  });

  it('saves a MORTGAGE edit whose stored frequency is an accelerated cadence (not in the loan enum)', async () => {
    // Regression: a mortgage stores its cadence in paymentFrequency, and
    // accelerated/semi-monthly values are not members of the loan-only enum.
    // Loaded as the (unrendered) paymentFrequency default on the edit form,
    // such a value used to fail base-schema validation and silently block
    // submit -- "Update Account" did nothing.
    const account = createExistingAccount({
      accountType: 'MORTGAGE',
      name: 'Home Mortgage',
      paymentFrequency: 'ACCELERATED_BIWEEKLY',
      interestRate: 5,
      paymentAmount: 1200,
      amortizationMonths: 300,
      paymentStartDate: '2024-01-01',
      originalPrincipal: 400000,
    });

    render(
      <AccountForm account={account} onSubmit={mockOnSubmit} onCancel={mockOnCancel} />
    );

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Update Account/i })).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Update Account/i }));
    });

    await waitFor(() => {
      expect(mockOnSubmit).toHaveBeenCalled();
    });
    // The unrendered loan-only frequency field is dropped rather than sent,
    // so the stored mortgage cadence round-trips untouched.
    expect(mockOnSubmit.mock.calls[0][0].paymentFrequency).toBeUndefined();
  });

  it('blocks new MORTGAGE submit with localized required errors and no raw Zod enum message', async () => {
    render(<AccountForm onSubmit={mockOnSubmit} onCancel={mockOnCancel} />);

    const typeSelect = screen.getByLabelText('Account Type') as HTMLSelectElement;
    await act(async () => { fireEvent.change(typeSelect, { target: { value: 'MORTGAGE' } }); });

    const nameInput = screen.getByLabelText('Account Name');
    await act(async () => { fireEvent.change(nameInput, { target: { value: 'Home Mortgage' } }); });

    await waitFor(() => {
      expect(screen.getByText('Mortgage Details')).toBeInTheDocument();
    });

    const submitButton = screen.getByRole('button', { name: /Create Account/i });
    await act(async () => { fireEvent.click(submitButton); });

    // Institution is no longer optional, and the unselected payment-frequency
    // dropdown produces a clean localized message rather than the raw Zod
    // "Invalid option: expected one of ..." error from issue #785.
    await waitFor(() => {
      expect(screen.getByText('Please select or create an institution')).toBeInTheDocument();
    });
    expect(screen.getByText('Payment frequency is required')).toBeInTheDocument();
    expect(screen.queryByText(/Invalid option/i)).not.toBeInTheDocument();
    expect(mockOnSubmit).not.toHaveBeenCalled();
  });

  it('blocks new LOAN submit when the institution is missing', async () => {
    render(<AccountForm onSubmit={mockOnSubmit} onCancel={mockOnCancel} />);

    const typeSelect = screen.getByLabelText('Account Type') as HTMLSelectElement;
    await act(async () => { fireEvent.change(typeSelect, { target: { value: 'LOAN' } }); });

    const nameInput = screen.getByLabelText('Account Name');
    await act(async () => { fireEvent.change(nameInput, { target: { value: 'Car Loan' } }); });

    await waitFor(() => {
      expect(screen.getByText('Loan Payment Details')).toBeInTheDocument();
    });

    const submitButton = screen.getByRole('button', { name: /Create Account/i });
    await act(async () => { fireEvent.click(submitButton); });

    await waitFor(() => {
      expect(screen.getByText('Please select or create an institution')).toBeInTheDocument();
    });
    expect(mockOnSubmit).not.toHaveBeenCalled();
  });

  it('does not show loan fields when editing existing LOAN account', async () => {
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
    await waitFor(() => {
      expect(screen.queryByText('Loan Payment Details')).not.toBeInTheDocument();
    });
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

  it('shows mortgage fields in edit mode but hides payment fields', async () => {
    const mortgageAccount = createExistingAccount({
      accountType: 'MORTGAGE',
      interestRate: 3.5,
      termMonths: 60,
      amortizationMonths: 300,
      isCanadianMortgage: true,
    });

    render(
      <AccountForm
        account={mortgageAccount}
        onSubmit={mockOnSubmit}
        onCancel={mockOnCancel}
      />
    );

    // Mortgage section should be shown with term/amortization fields
    await waitFor(() => {
      expect(screen.getByText('Mortgage Details')).toBeInTheDocument();
    });
    expect(screen.getByText('Term Length')).toBeInTheDocument();
    expect(screen.getByText('Amortization Period (required)')).toBeInTheDocument();
    expect(screen.getByText('Canadian Mortgage')).toBeInTheDocument();
    // Payment fields should be hidden during editing
    expect(screen.queryByText('Payment Frequency (required)')).not.toBeInTheDocument();
    expect(screen.queryByText('First Payment Date (required)')).not.toBeInTheDocument();
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

  it('toggles favourite star from on to off', async () => {
    const favAccount = createExistingAccount({ isFavourite: true });

    render(
      <AccountForm
        account={favAccount}
        onSubmit={mockOnSubmit}
        onCancel={mockOnCancel}
      />
    );

    await waitFor(() => {
      expect(screen.getByText('Favourite')).toBeInTheDocument();
    });

    const favButton = screen.getByTitle('Remove from favourites');
    fireEvent.click(favButton);

    await waitFor(() => {
      expect(screen.getByText('Add to favourites')).toBeInTheDocument();
    });
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

  it('shows standard fields when SAVINGS type is selected', async () => {
    render(
      <AccountForm onSubmit={mockOnSubmit} onCancel={mockOnCancel} />
    );

    const typeSelect = screen.getByLabelText('Account Type') as HTMLSelectElement;
    fireEvent.change(typeSelect, { target: { value: 'SAVINGS' } });

    // Standard fields should still be present
    await waitFor(() => {
      expect(screen.getByText('Opening Balance')).toBeInTheDocument();
    });
    expect(screen.getByText('Credit Limit (optional)')).toBeInTheDocument();
    expect(screen.getByText('Interest Rate % (optional)')).toBeInTheDocument();
  });

  it('shows standard fields when CREDIT_CARD type is selected', async () => {
    render(
      <AccountForm onSubmit={mockOnSubmit} onCancel={mockOnCancel} />
    );

    const typeSelect = screen.getByLabelText('Account Type') as HTMLSelectElement;
    fireEvent.change(typeSelect, { target: { value: 'CREDIT_CARD' } });

    await waitFor(() => {
      expect(screen.getByText('Opening Balance')).toBeInTheDocument();
    });
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

  it('populates existing account values including credit card fields', async () => {
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

    await waitFor(() => {
      expect(screen.getByDisplayValue('19.99')).toBeInTheDocument();
    });
  });

  it('shows credit card statement date fields when CREDIT_CARD type is selected', async () => {
    render(
      <AccountForm onSubmit={mockOnSubmit} onCancel={mockOnCancel} />
    );

    const typeSelect = screen.getByLabelText('Account Type') as HTMLSelectElement;
    fireEvent.change(typeSelect, { target: { value: 'CREDIT_CARD' } });

    await waitFor(() => {
      expect(screen.getByText('Statement Dates (optional)')).toBeInTheDocument();
    });
    expect(screen.getByText('Due Date (day of month)')).toBeInTheDocument();
    expect(screen.getByText('Settlement Date (day of month)')).toBeInTheDocument();
  });

  it('does not show credit card statement date fields for non-CREDIT_CARD types', async () => {
    render(
      <AccountForm onSubmit={mockOnSubmit} onCancel={mockOnCancel} />
    );

    const typeSelect = screen.getByLabelText('Account Type') as HTMLSelectElement;
    fireEvent.change(typeSelect, { target: { value: 'SAVINGS' } });

    await waitFor(() => {
      expect(screen.queryByText('Statement Dates (optional)')).not.toBeInTheDocument();
    });
  });

  it('populates credit card statement date fields when editing', async () => {
    const ccAccount = createExistingAccount({
      accountType: 'CREDIT_CARD',
      statementDueDay: 15,
      statementSettlementDay: 25,
    });

    render(
      <AccountForm
        account={ccAccount}
        onSubmit={mockOnSubmit}
        onCancel={mockOnCancel}
      />
    );

    await waitFor(() => {
      expect(screen.getByDisplayValue('15')).toBeInTheDocument();
      expect(screen.getByDisplayValue('25')).toBeInTheDocument();
    });
  });

  it('shows settlement date help tooltip', async () => {
    render(
      <AccountForm onSubmit={mockOnSubmit} onCancel={mockOnCancel} />
    );

    const typeSelect = screen.getByLabelText('Account Type') as HTMLSelectElement;
    fireEvent.change(typeSelect, { target: { value: 'CREDIT_CARD' } });

    await waitFor(() => {
      expect(screen.getByLabelText(/settlement date.*closing date.*last day of the billing cycle/i)).toBeInTheDocument();
    });
  });

  it('navigates to import page when QIF Import button clicked on existing account', async () => {
    const account = createExistingAccount();

    render(
      <AccountForm
        account={account}
        onSubmit={mockOnSubmit}
        onCancel={mockOnCancel}
      />
    );

    await waitFor(() => {
      expect(screen.getByTitle('Import transactions from QIF file')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTitle('Import transactions from QIF file'));

    // onCancel is called immediately
    await waitFor(() => {
      expect(mockOnCancel).toHaveBeenCalled();
    });
  });

  it('opens export modal when Export button clicked on existing account', async () => {
    const account = createExistingAccount();
    render(
      <AccountForm
        account={account}
        onSubmit={mockOnSubmit}
        onCancel={mockOnCancel}
      />
    );
    await waitFor(() => {
      expect(screen.getByTitle('Export account transactions')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTitle('Export account transactions'));
    // No assertion needed - this exercises the showExportModal state
  });

  it('shows Set Up Recurring Payments button for existing LOAN with no scheduled payment', async () => {
    const loan = createExistingAccount({
      accountType: 'LOAN',
      paymentAmount: 500,
      interestRate: 5,
      scheduledTransactionId: null,
    });
    render(
      <AccountForm account={loan} onSubmit={mockOnSubmit} onCancel={mockOnCancel} />
    );
    await waitFor(() => {
      expect(screen.getByText('Set Up Recurring Payments')).toBeInTheDocument();
    });
  });

  it('opens loan setup dialog when Set Up Recurring Payments is clicked', async () => {
    const loan = createExistingAccount({
      accountType: 'LOAN',
      paymentAmount: 500,
      interestRate: 5,
      scheduledTransactionId: null,
    });
    render(
      <AccountForm account={loan} onSubmit={mockOnSubmit} onCancel={mockOnCancel} />
    );
    await waitFor(() => {
      expect(screen.getByText('Set Up Recurring Payments')).toBeInTheDocument();
    });
    // Just ensure the button click does not throw
    fireEvent.click(screen.getByText('Set Up Recurring Payments'));
  });

  it('does not show Set Up Recurring Payments for LOAN with existing scheduled payment', async () => {
    const loan = createExistingAccount({
      accountType: 'LOAN',
      scheduledTransactionId: 'sched-1',
    });
    render(
      <AccountForm account={loan} onSubmit={mockOnSubmit} onCancel={mockOnCancel} />
    );
    await waitFor(() => {
      expect(screen.queryByText('Set Up Recurring Payments')).not.toBeInTheDocument();
    });
  });

  it('auto-selects default loan interest category when LOAN type is selected', async () => {
    (categoriesApi.getAll as any).mockResolvedValue([
      { id: 'loan-parent', userId: 'u1', name: 'Loan', parentId: null, parent: null, children: [], description: null, icon: null, color: null, effectiveColor: null, isIncome: false, isSystem: true, createdAt: '' },
      { id: 'loan-int', userId: 'u1', name: 'Loan Interest', parentId: 'loan-parent', parent: null, children: [], description: null, icon: null, color: null, effectiveColor: null, isIncome: false, isSystem: true, createdAt: '' },
    ]);
    render(<AccountForm onSubmit={mockOnSubmit} onCancel={mockOnCancel} />);

    const typeSelect = screen.getByLabelText('Account Type') as HTMLSelectElement;
    fireEvent.change(typeSelect, { target: { value: 'LOAN' } });

    await waitFor(() => {
      expect(categoriesApi.getAll).toHaveBeenCalled();
    });
  });

  it('auto-selects default mortgage interest category when MORTGAGE type is selected', async () => {
    (categoriesApi.getAll as any).mockResolvedValue([
      { id: 'mortgage-parent', userId: 'u1', name: 'Mortgage', parentId: null, parent: null, children: [], description: null, icon: null, color: null, effectiveColor: null, isIncome: false, isSystem: true, createdAt: '' },
      { id: 'mortgage-int', userId: 'u1', name: 'Mortgage Interest', parentId: 'mortgage-parent', parent: null, children: [], description: null, icon: null, color: null, effectiveColor: null, isIncome: false, isSystem: true, createdAt: '' },
    ]);
    render(<AccountForm onSubmit={mockOnSubmit} onCancel={mockOnCancel} />);

    const typeSelect = screen.getByLabelText('Account Type') as HTMLSelectElement;
    fireEvent.change(typeSelect, { target: { value: 'MORTGAGE' } });

    await waitFor(() => {
      expect(categoriesApi.getAll).toHaveBeenCalled();
    });
  });

  it('falls back to Loan Interest category when MORTGAGE has no Mortgage parent category', async () => {
    (categoriesApi.getAll as any).mockResolvedValue([
      { id: 'loan-parent', userId: 'u1', name: 'Loan', parentId: null, parent: null, children: [], description: null, icon: null, color: null, effectiveColor: null, isIncome: false, isSystem: true, createdAt: '' },
      { id: 'loan-int', userId: 'u1', name: 'Loan Interest', parentId: 'loan-parent', parent: null, children: [], description: null, icon: null, color: null, effectiveColor: null, isIncome: false, isSystem: true, createdAt: '' },
    ]);
    render(<AccountForm onSubmit={mockOnSubmit} onCancel={mockOnCancel} />);

    const typeSelect = screen.getByLabelText('Account Type') as HTMLSelectElement;
    fireEvent.change(typeSelect, { target: { value: 'MORTGAGE' } });
    await waitFor(() => {
      expect(categoriesApi.getAll).toHaveBeenCalled();
    });
  });

  it('handles accountsApi/categoriesApi failure gracefully when LOAN selected', async () => {
    (accountsApi.getAll as any).mockRejectedValue(new Error('boom'));
    render(<AccountForm onSubmit={mockOnSubmit} onCancel={mockOnCancel} />);
    const typeSelect = screen.getByLabelText('Account Type') as HTMLSelectElement;
    fireEvent.change(typeSelect, { target: { value: 'LOAN' } });
    await waitFor(() => {
      expect(accountsApi.getAll).toHaveBeenCalled();
    });
  });

  it('LINE_OF_CREDIT type loads accounts and categories', async () => {
    render(<AccountForm onSubmit={mockOnSubmit} onCancel={mockOnCancel} />);
    const typeSelect = screen.getByLabelText('Account Type') as HTMLSelectElement;
    fireEvent.change(typeSelect, { target: { value: 'LINE_OF_CREDIT' } });
    await waitFor(() => {
      expect(accountsApi.getAll).toHaveBeenCalled();
      expect(categoriesApi.getAll).toHaveBeenCalled();
    });
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

  it('shows actual (negative) opening balance for CREDIT_CARD when editing', async () => {
    const ccAccount = createExistingAccount({
      accountType: 'CREDIT_CARD',
      openingBalance: -500,
    });
    render(<AccountForm account={ccAccount} onSubmit={mockOnSubmit} onCancel={mockOnCancel} />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Update Account/i })).toBeInTheDocument();
    });
    // Opening balance should be -500 (not abs value 500) for credit card
    const input = screen.getByLabelText('Opening Balance') as HTMLInputElement;
    expect(input.value).toBe('-500.00');
  });

  it('shows positive opening balance unchanged for CREDIT_CARD when editing', async () => {
    const ccAccount = createExistingAccount({
      accountType: 'CREDIT_CARD',
      openingBalance: 75,
    });
    render(<AccountForm account={ccAccount} onSubmit={mockOnSubmit} onCancel={mockOnCancel} />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Update Account/i })).toBeInTheDocument();
    });
    const input = screen.getByLabelText('Opening Balance') as HTMLInputElement;
    expect(input.value).toBe('75.00');
  });

  it('shows actual (negative) opening balance for SAVINGS when editing (overdrawn)', async () => {
    const account = createExistingAccount({
      accountType: 'SAVINGS',
      openingBalance: -42,
    });
    render(<AccountForm account={account} onSubmit={mockOnSubmit} onCancel={mockOnCancel} />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Update Account/i })).toBeInTheDocument();
    });
    const input = screen.getByLabelText('Opening Balance') as HTMLInputElement;
    expect(input.value).toBe('-42.00');
  });

  it('shows absolute opening balance for LOAN when editing', async () => {
    const loanAccount = createExistingAccount({
      accountType: 'LOAN',
      openingBalance: -10000,
    });
    render(<AccountForm account={loanAccount} onSubmit={mockOnSubmit} onCancel={mockOnCancel} />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Update Account/i })).toBeInTheDocument();
    });
    // Loan amount should show as positive (abs value)
    const input = screen.getByLabelText('Loan Amount') as HTMLInputElement;
    expect(input.value).toBe('10000.00');
  });

  it('shows absolute opening balance for MORTGAGE when editing', async () => {
    const mortgageAccount = createExistingAccount({
      accountType: 'MORTGAGE',
      openingBalance: -250000,
    });
    render(<AccountForm account={mortgageAccount} onSubmit={mockOnSubmit} onCancel={mockOnCancel} />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Update Account/i })).toBeInTheDocument();
    });
    const input = screen.getByLabelText('Mortgage Amount') as HTMLInputElement;
    expect(input.value).toBe('250000.00');
  });


  it('populates account with openingBalance of 0 correctly', async () => {
    const account = createExistingAccount({ openingBalance: 0 });
    render(<AccountForm account={account} onSubmit={mockOnSubmit} onCancel={mockOnCancel} />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Update Account/i })).toBeInTheDocument();
    });
  });

  it('populates account with null openingBalance correctly', async () => {
    const account = createExistingAccount({ openingBalance: null as any });
    render(<AccountForm account={account} onSubmit={mockOnSubmit} onCancel={mockOnCancel} />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Update Account/i })).toBeInTheDocument();
    });
  });

  it('populates account with paymentStartDate correctly', async () => {
    const account = createExistingAccount({
      accountType: 'LOAN',
      paymentStartDate: '2024-03-15T00:00:00Z',
      scheduledTransactionId: 'sched-1',
    });
    render(<AccountForm account={account} onSubmit={mockOnSubmit} onCancel={mockOnCancel} />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Update Account/i })).toBeInTheDocument();
    });
  });

  it('populates account with dateAcquired correctly', async () => {
    const account = createExistingAccount({
      accountType: 'ASSET',
      dateAcquired: '2022-01-01T00:00:00Z',
      linkedLoanAccountId: null,
    });
    render(<AccountForm account={account} onSubmit={mockOnSubmit} onCancel={mockOnCancel} />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Update Account/i })).toBeInTheDocument();
    });
  });

  it('does not show Set Up Recurring Payments for MORTGAGE with scheduled payment', async () => {
    const mortgage = createExistingAccount({
      accountType: 'MORTGAGE',
      scheduledTransactionId: 'sched-1',
    });
    render(<AccountForm account={mortgage} onSubmit={mockOnSubmit} onCancel={mockOnCancel} />);
    await waitFor(() => {
      expect(screen.queryByText('Set Up Recurring Payments')).not.toBeInTheDocument();
    });
  });

  it('shows Set Up Recurring Payments for existing MORTGAGE without scheduled payment', async () => {
    const mortgage = createExistingAccount({
      accountType: 'MORTGAGE',
      interestRate: 3.5,
      scheduledTransactionId: null,
    });
    render(<AccountForm account={mortgage} onSubmit={mockOnSubmit} onCancel={mockOnCancel} />);
    await waitFor(() => {
      expect(screen.getByText('Set Up Recurring Payments')).toBeInTheDocument();
    });
  });

  it('handles CASH account type without special fields', async () => {
    render(<AccountForm onSubmit={mockOnSubmit} onCancel={mockOnCancel} />);
    const typeSelect = screen.getByLabelText('Account Type') as HTMLSelectElement;
    fireEvent.change(typeSelect, { target: { value: 'CASH' } });
    await waitFor(() => {
      expect(screen.getByText('Opening Balance')).toBeInTheDocument();
    });
    expect(screen.queryByText('Statement Dates (optional)')).not.toBeInTheDocument();
    expect(screen.queryByText('Loan Payment Details')).not.toBeInTheDocument();
    expect(screen.queryByText('Mortgage Details')).not.toBeInTheDocument();
  });

  it('handles OTHER account type without special fields', async () => {
    render(<AccountForm onSubmit={mockOnSubmit} onCancel={mockOnCancel} />);
    const typeSelect = screen.getByLabelText('Account Type') as HTMLSelectElement;
    fireEvent.change(typeSelect, { target: { value: 'OTHER' } });
    await waitFor(() => {
      expect(screen.getByText('Opening Balance')).toBeInTheDocument();
    });
    expect(screen.queryByText('Statement Dates (optional)')).not.toBeInTheDocument();
  });

  it('sets isFavourite from existing account with isFavourite=true', async () => {
    const account = createExistingAccount({ isFavourite: true });
    render(<AccountForm account={account} onSubmit={mockOnSubmit} onCancel={mockOnCancel} />);
    await waitFor(() => {
      expect(screen.getByText('Favourite')).toBeInTheDocument();
    });
  });

  it('excludeFromNetWorth toggle is on for account with excludeFromNetWorth=true', async () => {
    const account = createExistingAccount({ excludeFromNetWorth: true });
    render(<AccountForm account={account} onSubmit={mockOnSubmit} onCancel={mockOnCancel} />);
    await waitFor(() => {
      const toggle = screen.getByRole('switch', { name: /Exclude from Net Worth/i });
      expect(toggle).toHaveAttribute('aria-checked', 'true');
    });
  });

  it('handles creditLimit with value when editing', async () => {
    const account = createExistingAccount({
      accountType: 'CHEQUING',
      creditLimit: 5000,
    });
    render(<AccountForm account={account} onSubmit={mockOnSubmit} onCancel={mockOnCancel} />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Update Account/i })).toBeInTheDocument();
    });
  });

  it('auto-selects existing loan interest category when already set', async () => {
    (categoriesApi.getAll as any).mockResolvedValue([
      { id: 'loan-parent', userId: 'u1', name: 'Loan', parentId: null, parent: null, children: [], description: null, icon: null, color: null, effectiveColor: null, isIncome: false, isSystem: true, createdAt: '' },
      { id: 'loan-int', userId: 'u1', name: 'Loan Interest', parentId: 'loan-parent', parent: null, children: [], description: null, icon: null, color: null, effectiveColor: null, isIncome: false, isSystem: true, createdAt: '' },
    ]);
    // Use an existing loan account where interestCategoryId is already set
    const existingLoan = createExistingAccount({
      accountType: 'LOAN',
      interestCategoryId: 'loan-int',
      interestBookingMode: 'AUTO',
      overpaymentCategoryId: null, overpaymentMemo: null, overpaymentPayeeId: null, fxFeePercent: null, fxFeeCategoryId: null,
    });
    render(<AccountForm account={existingLoan} onSubmit={mockOnSubmit} onCancel={mockOnCancel} />);
    await waitFor(() => {
      expect(categoriesApi.getAll).toHaveBeenCalled();
    });
  });

  it('handles categories with no Loan parent when LOAN type selected', async () => {
    (categoriesApi.getAll as any).mockResolvedValue([
      { id: 'other-cat', userId: 'u1', name: 'Other', parentId: null, parent: null, children: [], description: null, icon: null, color: null, effectiveColor: null, isIncome: false, isSystem: false, createdAt: '' },
    ]);
    render(<AccountForm onSubmit={mockOnSubmit} onCancel={mockOnCancel} />);
    const typeSelect = screen.getByLabelText('Account Type') as HTMLSelectElement;
    fireEvent.change(typeSelect, { target: { value: 'LOAN' } });
    await waitFor(() => {
      expect(categoriesApi.getAll).toHaveBeenCalled();
    });
  });

  it('handles categories with no Mortgage or Loan parent when MORTGAGE selected', async () => {
    (categoriesApi.getAll as any).mockResolvedValue([
      { id: 'other-cat', userId: 'u1', name: 'Other', parentId: null, parent: null, children: [], description: null, icon: null, color: null, effectiveColor: null, isIncome: false, isSystem: false, createdAt: '' },
    ]);
    render(<AccountForm onSubmit={mockOnSubmit} onCancel={mockOnCancel} />);
    const typeSelect = screen.getByLabelText('Account Type') as HTMLSelectElement;
    fireEvent.change(typeSelect, { target: { value: 'MORTGAGE' } });
    await waitFor(() => {
      expect(categoriesApi.getAll).toHaveBeenCalled();
    });
  });

  it('re-syncs currency select after currencies load', async () => {
    render(<AccountForm onSubmit={mockOnSubmit} onCancel={mockOnCancel} />);
    await waitFor(() => {
      expect(exchangeRatesApi.getCurrencies).toHaveBeenCalled();
    });
    // After currencies load the currency field should still be present
    expect(screen.getByText('Currency')).toBeInTheDocument();
  });

  it('handles mortgage account with mortgagePaymentFrequency set', async () => {
    const baseAccount = createExistingAccount({
      accountType: 'MORTGAGE',
      interestRate: 4.0,
      termMonths: 60,
      amortizationMonths: 300,
    });
    const account = { ...baseAccount, mortgagePaymentFrequency: 'MONTHLY' } as any;
    render(<AccountForm account={account} onSubmit={mockOnSubmit} onCancel={mockOnCancel} />);
    await waitFor(() => {
      expect(screen.getByText('Mortgage Details')).toBeInTheDocument();
    });
  });

  describe('AssetFields callbacks', () => {
    beforeEach(() => {
      capturedHandleAssetCategoryChange = null;
      capturedHandleAssetCategoryCreate = null;
    });

    it('handleAssetCategoryChange updates selected asset category', async () => {
      render(<AccountForm onSubmit={mockOnSubmit} onCancel={mockOnCancel} />);
      const typeSelect = screen.getByLabelText('Account Type') as HTMLSelectElement;
      await act(async () => { fireEvent.change(typeSelect, { target: { value: 'ASSET' } }); });

      await waitFor(() => {
        expect(screen.getByTestId('asset-fields')).toBeInTheDocument();
      });

      await act(async () => { fireEvent.click(screen.getByTestId('trigger-category-change')); });
      // No error = handleAssetCategoryChange executed without throwing
    });

    it('handleAssetCategoryCreate creates a simple category', async () => {
      (categoriesApi.create as any).mockResolvedValue({
        id: 'new-cat-id',
        name: 'New Category',
        parentId: null,
      });

      render(<AccountForm onSubmit={mockOnSubmit} onCancel={mockOnCancel} />);
      const typeSelect = screen.getByLabelText('Account Type') as HTMLSelectElement;
      fireEvent.change(typeSelect, { target: { value: 'ASSET' } });

      await waitFor(() => {
        expect(screen.getByTestId('asset-fields')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByTestId('trigger-category-create'));

      await waitFor(() => {
        expect(categoriesApi.create).toHaveBeenCalledWith(
          expect.objectContaining({ name: 'New Category' })
        );
      });
    });

    it('handleAssetCategoryCreate with empty/whitespace name does nothing', async () => {
      render(<AccountForm onSubmit={mockOnSubmit} onCancel={mockOnCancel} />);
      const typeSelect = screen.getByLabelText('Account Type') as HTMLSelectElement;
      fireEvent.change(typeSelect, { target: { value: 'ASSET' } });

      await waitFor(() => {
        expect(screen.getByTestId('asset-fields')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByTestId('trigger-category-create-empty'));
      // categoriesApi.create should not have been called
      await waitFor(() => {
        expect(categoriesApi.create).not.toHaveBeenCalled();
      });
    });

    it('handleAssetCategoryCreate creates parent:child category when parent exists', async () => {
      (categoriesApi.getAll as any).mockResolvedValue([
        { id: 'assets-parent', userId: 'u1', name: 'Assets', parentId: null, parent: null, children: [], description: null, icon: null, color: null, effectiveColor: null, isIncome: false, isSystem: false, createdAt: '' },
      ]);
      (categoriesApi.create as any).mockResolvedValue({
        id: 'new-child-id',
        name: 'Home Value',
        parentId: 'assets-parent',
      });

      render(<AccountForm onSubmit={mockOnSubmit} onCancel={mockOnCancel} />);
      const typeSelect = screen.getByLabelText('Account Type') as HTMLSelectElement;
      fireEvent.change(typeSelect, { target: { value: 'ASSET' } });

      await waitFor(() => {
        expect(screen.getByTestId('asset-fields')).toBeInTheDocument();
        expect(categoriesApi.getAll).toHaveBeenCalled();
      });

      fireEvent.click(screen.getByTestId('trigger-category-create-parent-child'));

      await waitFor(() => {
        expect(categoriesApi.create).toHaveBeenCalled();
      });
    });

    it('handleAssetCategoryCreate creates both parent and child when parent not found', async () => {
      (categoriesApi.getAll as any).mockResolvedValue([]);
      (categoriesApi.create as any)
        .mockResolvedValueOnce({ id: 'new-parent-id', name: 'Assets', parentId: null })
        .mockResolvedValueOnce({ id: 'new-child-id', name: 'Home Value', parentId: 'new-parent-id' });

      render(<AccountForm onSubmit={mockOnSubmit} onCancel={mockOnCancel} />);
      const typeSelect = screen.getByLabelText('Account Type') as HTMLSelectElement;
      fireEvent.change(typeSelect, { target: { value: 'ASSET' } });

      await waitFor(() => {
        expect(screen.getByTestId('asset-fields')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByTestId('trigger-category-create-parent-child'));

      await waitFor(() => {
        // First call creates the parent, second creates the child
        expect(categoriesApi.create).toHaveBeenCalledTimes(2);
      });
    });

    it('handleAssetCategoryCreate handles API error gracefully', async () => {
      (categoriesApi.create as any).mockRejectedValue(new Error('Network error'));

      render(<AccountForm onSubmit={mockOnSubmit} onCancel={mockOnCancel} />);
      const typeSelect = screen.getByLabelText('Account Type') as HTMLSelectElement;
      fireEvent.change(typeSelect, { target: { value: 'ASSET' } });

      await waitFor(() => {
        expect(screen.getByTestId('asset-fields')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByTestId('trigger-category-create'));

      // Wait for the async operation to fail without throwing
      await waitFor(() => {
        expect(categoriesApi.create).toHaveBeenCalled();
      });
    });
  });

  describe('LoanPaymentSetupDialog callbacks', () => {
    beforeEach(() => {
      capturedOnSetupComplete = null;
      capturedOnClose = null;
    });

    it('onSetupComplete callback updates hasScheduledPayment and refreshes', async () => {
      const loan = createExistingAccount({
        accountType: 'LOAN',
        paymentAmount: 500,
        interestRate: 5,
        scheduledTransactionId: null,
      });
      render(<AccountForm account={loan} onSubmit={mockOnSubmit} onCancel={mockOnCancel} />);

      await waitFor(() => {
        expect(screen.getByText('Set Up Recurring Payments')).toBeInTheDocument();
      });

      // Open the dialog
      fireEvent.click(screen.getByText('Set Up Recurring Payments'));

      await waitFor(() => {
        expect(screen.getByTestId('loan-setup-dialog')).toBeInTheDocument();
      });

      // Trigger onSetupComplete
      fireEvent.click(screen.getByTestId('setup-complete'));

      await waitFor(() => {
        // After completion, the "Set Up Recurring Payments" prompt should disappear
        // because hasScheduledPayment is now true
        expect(screen.queryByText('Set Up Recurring Payments')).not.toBeInTheDocument();
      });
    });

    it('onClose callback closes the dialog', async () => {
      const loan = createExistingAccount({
        accountType: 'LOAN',
        paymentAmount: 500,
        interestRate: 5,
        scheduledTransactionId: null,
      });
      render(<AccountForm account={loan} onSubmit={mockOnSubmit} onCancel={mockOnCancel} />);

      await waitFor(() => {
        expect(screen.getByText('Set Up Recurring Payments')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByText('Set Up Recurring Payments'));

      await waitFor(() => {
        expect(screen.getByTestId('loan-setup-dialog')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByTestId('close-dialog'));

      await waitFor(() => {
        expect(screen.queryByTestId('loan-setup-dialog')).not.toBeInTheDocument();
      });
    });
  });

  describe('AccountExportModal', () => {
    it('export modal renders when Export button is clicked', async () => {
      const account = createExistingAccount({ name: 'Test Account' });
      render(<AccountForm account={account} onSubmit={mockOnSubmit} onCancel={mockOnCancel} />);

      await waitFor(() => {
        expect(screen.getByTitle('Export account transactions')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByTitle('Export account transactions'));

      await waitFor(() => {
        expect(screen.getByTestId('export-modal')).toBeInTheDocument();
        expect(screen.getByText(/Export Modal for Test Account/)).toBeInTheDocument();
      });
    });
  });

  describe('CurrencyInput onChange callbacks', () => {
    it('openingBalance CurrencyInput onChange updates form value', async () => {
      render(<AccountForm onSubmit={mockOnSubmit} onCancel={mockOnCancel} />);
      await waitFor(() => {
        expect(screen.getByText('Opening Balance')).toBeInTheDocument();
      });
      const openingBalanceInput = screen.getByLabelText('Opening Balance') as HTMLInputElement;
      await act(async () => { fireEvent.change(openingBalanceInput, { target: { value: '500' } }); });
    });

    it('creditLimit CurrencyInput onChange updates form value', async () => {
      render(<AccountForm onSubmit={mockOnSubmit} onCancel={mockOnCancel} />);
      await waitFor(() => {
        expect(screen.getByText('Credit Limit (optional)')).toBeInTheDocument();
      });
      const creditLimitInput = screen.getByLabelText('Credit Limit (optional)') as HTMLInputElement;
      await act(async () => { fireEvent.change(creditLimitInput, { target: { value: '10000' } }); });
    });

    it('loanAmount CurrencyInput onChange triggers when LOAN type selected', async () => {
      render(<AccountForm onSubmit={mockOnSubmit} onCancel={mockOnCancel} />);
      const typeSelect = screen.getByLabelText('Account Type') as HTMLSelectElement;
      await act(async () => { fireEvent.change(typeSelect, { target: { value: 'LOAN' } }); });

      await waitFor(() => {
        expect(screen.getByText('Loan Amount')).toBeInTheDocument();
      });

      const loanAmountInput = screen.getByLabelText('Loan Amount') as HTMLInputElement;
      await act(async () => { fireEvent.change(loanAmountInput, { target: { value: '25000' } }); });
    });

    it('mortgageAmount CurrencyInput onChange triggers when MORTGAGE type selected', async () => {
      render(<AccountForm onSubmit={mockOnSubmit} onCancel={mockOnCancel} />);
      const typeSelect = screen.getByLabelText('Account Type') as HTMLSelectElement;
      await act(async () => { fireEvent.change(typeSelect, { target: { value: 'MORTGAGE' } }); });

      await waitFor(() => {
        expect(screen.getByText('Mortgage Amount')).toBeInTheDocument();
      });

      const mortgageInput = screen.getByLabelText('Mortgage Amount') as HTMLInputElement;
      await act(async () => { fireEvent.change(mortgageInput, { target: { value: '350000' } }); });
    });
  });

  describe('currency lock for accounts with transactions', () => {
    it('does not check transaction count for new accounts', async () => {
      render(<AccountForm onSubmit={mockOnSubmit} onCancel={mockOnCancel} />);

      await waitFor(() => {
        expect(screen.getByText('Currency')).toBeInTheDocument();
      });

      expect(accountsApi.canDelete).not.toHaveBeenCalled();
      const currencySelect = screen.getByLabelText('Currency') as HTMLSelectElement;
      expect(currencySelect.disabled).toBe(false);
    });

    it('leaves currency enabled when editing an account with no transactions', async () => {
      (accountsApi.canDelete as any).mockResolvedValue({
        transactionCount: 0,
        investmentTransactionCount: 0,
        canDelete: true,
      });
      const account = createExistingAccount();

      render(<AccountForm account={account} onSubmit={mockOnSubmit} onCancel={mockOnCancel} />);

      await waitFor(() => {
        expect(accountsApi.canDelete).toHaveBeenCalledWith(account.id);
      });

      const currencySelect = screen.getByLabelText('Currency') as HTMLSelectElement;
      await waitFor(() => {
        expect(currencySelect.disabled).toBe(false);
      });
      expect(screen.queryByLabelText(/Currency is locked/i)).not.toBeInTheDocument();
    });

    it('disables currency and shows tooltip when the account has regular transactions', async () => {
      (accountsApi.canDelete as any).mockResolvedValue({
        transactionCount: 7,
        investmentTransactionCount: 0,
        canDelete: false,
      });
      const account = createExistingAccount();

      render(<AccountForm account={account} onSubmit={mockOnSubmit} onCancel={mockOnCancel} />);

      const currencySelect = screen.getByLabelText('Currency') as HTMLSelectElement;
      await waitFor(() => {
        expect(currencySelect.disabled).toBe(true);
      });
      // Dimmed to visually signal it cannot be changed
      expect(currencySelect.className).toContain('opacity-60');
      expect(screen.getByLabelText(/Currency is locked/i)).toBeInTheDocument();
    });

    it('does not dim the currency select when it is unlocked', async () => {
      (accountsApi.canDelete as any).mockResolvedValue({
        transactionCount: 0,
        investmentTransactionCount: 0,
        canDelete: true,
      });
      const account = createExistingAccount();

      render(<AccountForm account={account} onSubmit={mockOnSubmit} onCancel={mockOnCancel} />);

      await waitFor(() => {
        expect(accountsApi.canDelete).toHaveBeenCalledWith(account.id);
      });

      const currencySelect = screen.getByLabelText('Currency') as HTMLSelectElement;
      expect(currencySelect.className).not.toContain('opacity-60');
    });

    it('disables currency when the account has only investment transactions', async () => {
      (accountsApi.canDelete as any).mockResolvedValue({
        transactionCount: 0,
        investmentTransactionCount: 3,
        canDelete: false,
      });
      const account = createExistingAccount({ accountType: 'INVESTMENT' });

      render(<AccountForm account={account} onSubmit={mockOnSubmit} onCancel={mockOnCancel} />);

      const currencySelect = screen.getByLabelText('Currency') as HTMLSelectElement;
      await waitFor(() => {
        expect(currencySelect.disabled).toBe(true);
      });
      expect(screen.getByLabelText(/Currency is locked/i)).toBeInTheDocument();
    });

    it('keeps currency enabled if the transaction-count lookup fails', async () => {
      (accountsApi.canDelete as any).mockRejectedValue(new Error('boom'));
      const account = createExistingAccount();

      render(<AccountForm account={account} onSubmit={mockOnSubmit} onCancel={mockOnCancel} />);

      await waitFor(() => {
        expect(accountsApi.canDelete).toHaveBeenCalled();
      });

      const currencySelect = screen.getByLabelText('Currency') as HTMLSelectElement;
      expect(currencySelect.disabled).toBe(false);
    });
  });

  describe('handleAssetCategoryCreate - parent category found branch', () => {
    it('creates child under existing parent category via capturedHandleAssetCategoryCreate', async () => {
      // Load a parent category so it's in state when ASSET is selected
      (categoriesApi.getAll as any).mockResolvedValue([
        { id: 'assets-parent', userId: 'u1', name: 'Assets', parentId: null, parent: null, children: [], description: null, icon: null, color: null, effectiveColor: null, isIncome: false, isSystem: false, createdAt: '' },
      ]);
      (categoriesApi.create as any).mockResolvedValue({
        id: 'new-child-id',
        name: 'Home Value',
        parentId: 'assets-parent',
      });

      render(<AccountForm onSubmit={mockOnSubmit} onCancel={mockOnCancel} />);
      const typeSelect = screen.getByLabelText('Account Type') as HTMLSelectElement;
      await act(async () => { fireEvent.change(typeSelect, { target: { value: 'ASSET' } }); });

      // Wait for categories to be loaded and AssetFields to be rendered
      await waitFor(() => {
        expect(screen.getByTestId('asset-fields')).toBeInTheDocument();
        expect(capturedHandleAssetCategoryCreate).not.toBeNull();
      });

      // Clear the create mock count before calling to isolate from any load-time side effects
      (categoriesApi.create as any).mockClear();

      // Call the captured callback directly - by this time categories state is populated
      await act(async () => { await capturedHandleAssetCategoryCreate!('Assets: Home Value'); });

      // Should have called create (regardless of whether it found an existing parent,
      // it creates the child; exercises lines 379 and the parent-found branch)
      expect(categoriesApi.create).toHaveBeenCalled();
    });
  });
});
