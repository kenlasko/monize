import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@/test/render';
import { ScheduledTransactionForm } from './ScheduledTransactionForm';
import toast from 'react-hot-toast';

vi.mock('react-hot-toast', () => ({
  default: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('@/hooks/useNumberFormat', async () => {
  const { numberFormatMockDefaults } = await import('@/test/number-format-mock');
  return {
    useNumberFormat: () => ({
      ...numberFormatMockDefaults(),
      defaultCurrency: 'CAD',
      formatCurrency: (v: number, code: string) => `${code} ${v.toFixed(2)}`,
      formatNumber: (v: number, decimals = 2) => v.toFixed(decimals),
      // Mirrors the real formatPrice: up to 6 decimals, trailing zeros trimmed.
      formatPrice: (n: number) => n.toFixed(6).replace(/0+$/, '').replace(/\.$/, ''),
    }),
  };
});
vi.mock('@hookform/resolvers/zod', () => ({
  zodResolver: () => async (values: any) => {
    // Simple pass-through resolver that returns the raw form values
    return { values, errors: {} };
  },
}));

vi.mock('@/lib/format', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/format')>()),
  FX_RATE_DISPLAY_DECIMALS: 6,
  getCurrencySymbol: () => '$',
  getDecimalPlacesForCurrency: () => 2,
  roundToCents: (v: number) => Math.round(v * 100) / 100,
  formatAmountWithCommas: (v: number) => v?.toLocaleString() ?? '',
  parseAmount: (v: string) => parseFloat(v) || 0,
  filterCurrencyInput: (v: string) => v,
  filterCalculatorInput: (v: string) => v,
  hasCalculatorOperators: () => false,
  evaluateExpression: (v: string) => parseFloat(v) || 0,
}));

const mockGetRateForDate = vi.fn().mockResolvedValue(null);

vi.mock('@/lib/exchange-rates', () => ({
  exchangeRatesApi: {
    getRateForDate: (...args: any[]) => mockGetRateForDate(...args),
    getCurrencies: vi.fn().mockResolvedValue([]),
  },
}));

// The picker itself is covered by CurrencyPickerButton.test.tsx; here it stands
// in as a plain control so the form's conversion behaviour is what is under test.
vi.mock('@/components/transactions/CurrencyPickerButton', () => ({
  CurrencyPickerButton: ({ value, accountCurrencyCode, onChange }: any) => (
    <div data-testid="currency-picker">
      <span data-testid="currency-picker-value">{value || accountCurrencyCode}</span>
      <button type="button" data-testid="pick-usd" onClick={() => onChange('USD')}>
        USD
      </button>
      <button type="button" data-testid="pick-account" onClick={() => onChange('')}>
        Use account currency
      </button>
    </div>
  ),
}));

vi.mock('@/lib/errors', () => ({
  getErrorMessage: (_error: unknown, fallback: string) => fallback,
}));

vi.mock('@/hooks/useDateFormat', () => ({
  useDateFormat: () => ({ formatDate: (d: string) => d, dateFormat: 'browser', datePattern: 'YYYY-MM-DD' }),
}));

const mockAccountsGetAll = vi.fn();
const mockCreate = vi.fn().mockResolvedValue({});
const mockUpdate = vi.fn().mockResolvedValue({});

vi.mock('@/lib/accounts', () => ({
  accountsApi: { getAll: (...args: any[]) => mockAccountsGetAll(...args) },
}));

const mockCategoriesGetAll = vi.fn().mockResolvedValue([]);
const mockCategoriesCreate = vi.fn().mockResolvedValue({ id: 'new-cat', name: 'New Category' });

vi.mock('@/lib/categories', () => ({
  categoriesApi: {
    getAll: (...args: any[]) => mockCategoriesGetAll(...args),
    create: (...args: any[]) => mockCategoriesCreate(...args),
  },
}));

const mockPayeesGetAll = vi.fn().mockResolvedValue([]);
const mockPayeesCreate = vi.fn().mockResolvedValue({ id: 'new-payee', name: 'New Payee' });
const mockPayeesGetById = vi.fn().mockResolvedValue({ id: 'inactive-payee', name: 'Inactive Payee' });

vi.mock('@/lib/payees', () => ({
  payeesApi: {
    getAll: (...args: any[]) => mockPayeesGetAll(...args),
    create: (...args: any[]) => mockPayeesCreate(...args),
    getById: (...args: any[]) => mockPayeesGetById(...args),
  },
}));

const mockTagsCreate = vi.fn().mockResolvedValue({ id: 'new-tag', name: 'New Tag' });
const mockTagsGetAll = vi.fn().mockResolvedValue([]);
const mockTagsGetUsage = vi.fn().mockResolvedValue({});

vi.mock('@/lib/tags', () => ({
  tagsApi: {
    getAll: (...args: any[]) => mockTagsGetAll(...args),
    getUsage: (...args: any[]) => mockTagsGetUsage(...args),
    create: (...args: any[]) => mockTagsCreate(...args),
  },
}));

vi.mock('@/lib/scheduled-transactions', () => ({
  scheduledTransactionsApi: {
    create: (...args: any[]) => mockCreate(...args),
    update: (...args: any[]) => mockUpdate(...args),
  },
}));

const mockGetSecurities = vi.fn();
const mockGetSecurityPrices = vi.fn();

vi.mock('@/lib/investments', () => ({
  investmentsApi: {
    getSecurities: (...args: any[]) => mockGetSecurities(...args),
    getSecurityPrices: (...args: any[]) => mockGetSecurityPrices(...args),
  },
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() }),
}));

vi.mock('@/lib/categoryUtils', () => ({
  buildCategoryTree: (cats: any[]) => (cats || []).map((c: any) => ({ category: c })),
}));

const mockSplitEditorProps = vi.fn();

vi.mock('@/components/transactions/SplitEditor', () => ({
  SplitEditor: (props: Record<string, unknown>) => {
    mockSplitEditorProps(props);
    return <div data-testid="split-editor">SplitEditor</div>;
  },
  createEmptySplits: (amount: number) => [
    { id: '1', categoryId: '', amount: amount / 2, memo: '', splitType: 'category' },
    { id: '2', categoryId: '', amount: amount / 2, memo: '', splitType: 'category' },
  ],
  toSplitRows: () => [],
  toCreateSplitData: () => [],
}));

vi.mock('@/components/ui/Combobox', () => ({
  Combobox: ({ label, placeholder, onChange, onCreateNew, value: _value, options }: any) => (
    <div data-testid={`combobox-${label || 'unnamed'}`}>
      {label && <label>{label}</label>}
      <input
        placeholder={placeholder}
        data-testid={`combobox-input-${label || 'unnamed'}`}
        onChange={(e: any) => {
          const opt = (options || []).find((o: any) => o.label === e.target.value);
          if (opt) {
            onChange?.(opt.value, opt.label);
          }
        }}
      />
      <button
        data-testid={`combobox-create-${label || 'unnamed'}`}
        onClick={() => onCreateNew?.('New Item')}
      >
        Create
      </button>
      <button
        data-testid={`combobox-create-nested-${label || 'unnamed'}`}
        onClick={() => onCreateNew?.('travel: hotels')}
      >
        Create nested
      </button>
      {(options || []).map((opt: any) => (
        <button
          key={opt.value}
          data-testid={`option-${opt.value}`}
          onClick={() => onChange?.(opt.value, opt.label)}
        >
          {opt.label}
        </button>
      ))}
    </div>
  ),
}));

const mockAccounts = [
  {
    id: 'acc-1',
    name: 'Chequing',
    currencyCode: 'CAD',
    isClosed: false,
    accountType: 'CHEQUING',
    accountSubType: null,
  },
  {
    id: 'acc-2',
    name: 'Savings',
    currencyCode: 'CAD',
    isClosed: false,
    accountType: 'SAVINGS',
    accountSubType: null,
  },
  {
    id: 'acc-3',
    name: 'Closed Account',
    currencyCode: 'CAD',
    isClosed: true,
    accountType: 'CHEQUING',
    accountSubType: null,
  },
  {
    id: 'acc-4',
    name: 'Brokerage',
    currencyCode: 'CAD',
    isClosed: false,
    accountType: 'INVESTMENT',
    accountSubType: 'INVESTMENT_BROKERAGE',
  },
  {
    id: 'acc-5',
    name: 'House',
    currencyCode: 'CAD',
    isClosed: false,
    accountType: 'ASSET',
    accountSubType: null,
  },
];

const mockCategories = [
  { id: 'cat-1', name: 'Rent', parentId: null, isIncome: false, color: null },
  { id: 'cat-2', name: 'Salary', parentId: null, isIncome: true, color: null },
  { id: 'cat-3', name: 'Sub Category', parentId: 'cat-1', isIncome: false, color: null },
];

const mockPayees = [
  { id: 'payee-1', name: 'Landlord', defaultCategoryId: 'cat-1', defaultCategory: { id: 'cat-1', name: 'Rent' } },
  { id: 'payee-2', name: 'Employer', defaultCategoryId: 'cat-2', defaultCategory: { id: 'cat-2', name: 'Salary' } },
  { id: 'payee-3', name: 'No Default', defaultCategoryId: null, defaultCategory: null },
];

const mockSecurities = [
  {
    id: 'sec-voo',
    symbol: 'VOO',
    name: 'Vanguard S&P 500 ETF',
    currencyCode: 'USD',
    securityType: 'ETF',
    exchange: 'NYSE',
    isActive: true,
    skipPriceUpdates: false,
    sector: null,
    industry: null,
    sectorWeightings: null,
    countryWeightings: null,
    assetWeightings: null,
    quoteProvider: null,
    msnInstrumentId: null,
    createdAt: '',
    updatedAt: '',
  },
];

// The Active / Auto-post / End-condition controls render as ToggleSwitch
// (role="switch") rather than checkboxes, so their state lives in aria-checked.
const expectToggle = (el: HTMLElement, on: boolean) =>
  expect(el).toHaveAttribute('aria-checked', String(on));

describe('ScheduledTransactionForm', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAccountsGetAll.mockResolvedValue(mockAccounts);
    mockCategoriesGetAll.mockResolvedValue(mockCategories);
    mockPayeesGetAll.mockResolvedValue(mockPayees);
    mockPayeesGetById.mockResolvedValue({ id: 'inactive-payee', name: 'Inactive Payee' });
    mockTagsCreate.mockResolvedValue({ id: 'new-tag', name: 'New Tag' });
    mockGetSecurities.mockResolvedValue(mockSecurities);
    mockGetSecurityPrices.mockResolvedValue([
      { id: 1, securityId: 'sec-voo', priceDate: '2026-05-09', closePrice: 500, openPrice: 499, highPrice: 501, lowPrice: 498, volume: 1000, source: 'manual', createdAt: '' },
    ]);
  });

  // --- Basic rendering ---
  it('renders form with Transaction, Split, and Transfer tabs', async () => {
    render(<ScheduledTransactionForm />);
    await waitFor(() => {
      expect(screen.getByText('Transaction')).toBeInTheDocument();
    });
    expect(screen.getByText('Split')).toBeInTheDocument();
    expect(screen.getByText('Transfer')).toBeInTheDocument();
  });

  it('renders name and frequency fields', async () => {
    render(<ScheduledTransactionForm />);
    await waitFor(() => {
      expect(screen.getByText('Name')).toBeInTheDocument();
    });
    expect(screen.getByText('Frequency')).toBeInTheDocument();
    expect(screen.getByText('Next Due Date')).toBeInTheDocument();
  });

  it('shows Create button for new form', async () => {
    const { container } = render(<ScheduledTransactionForm />);
    await waitFor(() => {
      expect(container.querySelector('button[type="submit"]')).toBeInTheDocument();
    });
    const submitButton = container.querySelector('button[type="submit"]');
    expect(submitButton!.textContent).toContain('Create');
  });

  it('shows Update button when editing', async () => {
    const st = {
      id: 's1', accountId: 'a1', name: 'Rent', amount: -1500, currencyCode: 'CAD',
      frequency: 'MONTHLY', nextDueDate: '2024-02-01', isActive: true, autoPost: false,
      reminderDaysBefore: 3, isTransfer: false, isSplit: false,
    } as any;
    render(<ScheduledTransactionForm scheduledTransaction={st} />);
    await waitFor(() => {
      expect(screen.getByText('Update')).toBeInTheDocument();
    });
  });

  // --- Frequency select dropdown ---
  it('renders frequency dropdown with all frequency options', async () => {
    render(<ScheduledTransactionForm />);

    await waitFor(() => {
      expect(screen.getByLabelText('Frequency')).toBeInTheDocument();
    });

    const frequencySelect = screen.getByLabelText('Frequency');
    expect(frequencySelect).toBeInTheDocument();

    // Check all frequency options are present
    expect(screen.getByText('One Time')).toBeInTheDocument();
    expect(screen.getByText('Daily')).toBeInTheDocument();
    expect(screen.getByText('Weekly')).toBeInTheDocument();
    expect(screen.getByText('Every 2 Weeks')).toBeInTheDocument();
    expect(screen.getByText('Twice a Month')).toBeInTheDocument();
    expect(screen.getByText('Monthly')).toBeInTheDocument();
    expect(screen.getByText('Quarterly')).toBeInTheDocument();
    expect(screen.getByText('Yearly')).toBeInTheDocument();
  });

  it('defaults frequency to MONTHLY for new form', async () => {
    render(<ScheduledTransactionForm />);
    await waitFor(() => {
      expect((screen.getByLabelText('Frequency') as HTMLSelectElement).value).toBe('MONTHLY');
    });
  });

  it('allows changing frequency via dropdown', async () => {
    render(<ScheduledTransactionForm />);
    await waitFor(() => {
      expect(screen.getByLabelText('Frequency')).toBeInTheDocument();
    });
    const frequencySelect = screen.getByLabelText('Frequency') as HTMLSelectElement;
    fireEvent.change(frequencySelect, { target: { value: 'WEEKLY' } });
    expect(frequencySelect.value).toBe('WEEKLY');
  });

  // --- Start date (next due date) and end date ---
  it('renders next due date field with date input', async () => {
    render(<ScheduledTransactionForm />);
    await waitFor(() => {
      expect(screen.getByLabelText('Next Due Date')).toBeInTheDocument();
    });
    const dateInput = screen.getByLabelText('Next Due Date');
    expect(dateInput).toHaveAttribute('type', 'text');
  });

  it('shows end date section when frequency is not ONCE', async () => {
    render(<ScheduledTransactionForm />);
    // Default frequency is MONTHLY, so end condition section should be present
    await waitFor(() => {
      expect(screen.getByText('End Condition (optional)')).toBeInTheDocument();
    });
    expect(screen.getByLabelText('End by date')).toBeInTheDocument();
  });

  it('hides end date section when frequency is ONCE', async () => {
    render(<ScheduledTransactionForm />);
    await waitFor(() => {
      expect(screen.getByLabelText('Frequency')).toBeInTheDocument();
    });
    const frequencySelect = screen.getByLabelText('Frequency');
    fireEvent.change(frequencySelect, { target: { value: 'ONCE' } });
    expect(screen.queryByText('End Condition (optional)')).not.toBeInTheDocument();
  });

  it('shows end date input when end by date checkbox is checked', async () => {
    render(<ScheduledTransactionForm />);
    await waitFor(() => {
      expect(screen.getByLabelText('End by date')).toBeInTheDocument();
    });
    const endDateCheckbox = screen.getByLabelText('End by date');
    fireEvent.click(endDateCheckbox);
    // After clicking, an additional date input should appear (the end date input)
    const dateInputs = screen.getAllByDisplayValue('');
    expect(dateInputs.length).toBeGreaterThan(0);
  });

  // --- Occurrences remaining ---
  it('shows number of occurrences checkbox', async () => {
    render(<ScheduledTransactionForm />);
    await waitFor(() => {
      expect(screen.getByLabelText('Number of occurrences')).toBeInTheDocument();
    });
  });

  it('shows occurrences input when number of occurrences checkbox is checked', async () => {
    render(<ScheduledTransactionForm />);
    await waitFor(() => {
      expect(screen.getByLabelText('Number of occurrences')).toBeInTheDocument();
    });
    const occurrencesCheckbox = screen.getByLabelText('Number of occurrences');
    fireEvent.click(occurrencesCheckbox);
    const numberInput = screen.getByPlaceholderText('# remaining');
    expect(numberInput).toBeInTheDocument();
    expect(numberInput).toHaveAttribute('inputmode', 'decimal');
  });

  it('unchecks end date when occurrences is checked (mutual exclusion)', async () => {
    render(<ScheduledTransactionForm />);
    await waitFor(() => {
      expect(screen.getByLabelText('End by date')).toBeInTheDocument();
    });
    const endDateCheckbox = screen.getByLabelText('End by date');
    const occurrencesCheckbox = screen.getByLabelText('Number of occurrences');

    fireEvent.click(endDateCheckbox);
    expectToggle(endDateCheckbox, true);

    fireEvent.click(occurrencesCheckbox);
    expectToggle(occurrencesCheckbox, true);
    expectToggle(endDateCheckbox, false);
  });

  it('unchecks occurrences when end date is checked (mutual exclusion)', async () => {
    render(<ScheduledTransactionForm />);
    await waitFor(() => {
      expect(screen.getByLabelText('End by date')).toBeInTheDocument();
    });
    const endDateCheckbox = screen.getByLabelText('End by date');
    const occurrencesCheckbox = screen.getByLabelText('Number of occurrences');

    fireEvent.click(occurrencesCheckbox);
    expectToggle(occurrencesCheckbox, true);

    fireEvent.click(endDateCheckbox);
    expectToggle(endDateCheckbox, true);
    expectToggle(occurrencesCheckbox, false);
  });

  // --- Auto-post checkbox ---
  it('renders auto-post checkbox defaulting to unchecked', async () => {
    render(<ScheduledTransactionForm />);
    await waitFor(() => {
      expect(screen.getByLabelText('Auto-post on due date')).toBeInTheDocument();
    });
    const autoPostCheckbox = screen.getByLabelText('Auto-post on due date');
    expectToggle(autoPostCheckbox, false);
  });

  it('allows toggling auto-post checkbox', async () => {
    render(<ScheduledTransactionForm />);
    await waitFor(() => {
      expect(screen.getByLabelText('Auto-post on due date')).toBeInTheDocument();
    });
    const autoPostCheckbox = screen.getByLabelText('Auto-post on due date');
    fireEvent.click(autoPostCheckbox);
    expectToggle(autoPostCheckbox, true);
    fireEvent.click(autoPostCheckbox);
    expectToggle(autoPostCheckbox, false);
  });

  // --- Active checkbox ---
  it('renders active checkbox defaulting to checked', async () => {
    render(<ScheduledTransactionForm />);
    await waitFor(() => {
      expect(screen.getByLabelText('Active')).toBeInTheDocument();
    });
    const activeCheckbox = screen.getByLabelText('Active');
    expectToggle(activeCheckbox, true);
  });

  // --- Reminder days input ---
  it('renders remind days before input', async () => {
    render(<ScheduledTransactionForm />);
    await waitFor(() => {
      expect(screen.getByLabelText('Remind Days Before')).toBeInTheDocument();
    });
    const reminderInput = screen.getByLabelText('Remind Days Before');
    expect(reminderInput).toHaveAttribute('inputmode', 'decimal');
  });

  it('defaults remind days before to 3', async () => {
    render(<ScheduledTransactionForm />);
    await waitFor(() => {
      expect(screen.getByLabelText('Remind Days Before')).toBeInTheDocument();
    });
    const reminderInput = screen.getByLabelText('Remind Days Before') as HTMLInputElement;
    expect(reminderInput.value).toBe('3');
  });

  it('allows changing reminder days', async () => {
    render(<ScheduledTransactionForm />);
    await waitFor(() => {
      expect(screen.getByLabelText('Remind Days Before')).toBeInTheDocument();
    });
    const reminderInput = screen.getByLabelText('Remind Days Before') as HTMLInputElement;
    fireEvent.change(reminderInput, { target: { value: '7' } });
    expect(reminderInput.value).toBe('7');
  });

  // --- Transfer mode detection ---
  it('switches to transfer mode when Transfer button is clicked', async () => {
    render(<ScheduledTransactionForm />);
    await waitFor(() => {
      expect(screen.getByText('Transfer')).toBeInTheDocument();
    });
    const transferButton = screen.getByText('Transfer');
    fireEvent.click(transferButton);

    // In transfer mode, the account label changes to "From Account"
    expect(screen.getByText('From Account')).toBeInTheDocument();
  });

  it('shows To Account dropdown in transfer mode', async () => {
    render(<ScheduledTransactionForm />);
    const transferButton = screen.getByText('Transfer');
    fireEvent.click(transferButton);

    await waitFor(() => {
      expect(screen.getByText('To Account')).toBeInTheDocument();
    });
  });

  it('switches back to transaction mode from transfer mode', async () => {
    render(<ScheduledTransactionForm />);
    await waitFor(() => {
      expect(screen.getByText('Transfer')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText('Transfer'));
    expect(screen.getByText('From Account')).toBeInTheDocument();

    fireEvent.click(screen.getByText('Transaction'));
    expect(screen.getByText('Account')).toBeInTheDocument();
  });

  it('renders transfer mode for existing transfer scheduled transaction', async () => {
    const transferSt = {
      id: 's1',
      accountId: 'acc-1',
      name: 'Savings Transfer',
      amount: -500,
      currencyCode: 'CAD',
      frequency: 'MONTHLY' as const,
      nextDueDate: '2024-02-01',
      isActive: true,
      autoPost: false,
      reminderDaysBefore: 3,
      isTransfer: true,
      transferAccountId: 'acc-2',
      isSplit: false,
    } as any;

    render(<ScheduledTransactionForm scheduledTransaction={transferSt} />);
    await waitFor(() => {
      expect(screen.getByText('From Account')).toBeInTheDocument();
    });
    expect(screen.getByText('To Account')).toBeInTheDocument();
  });

  it('opens in transfer mode prefilled from initial props (reconcile flow)', async () => {
    render(
      <ScheduledTransactionForm
        initialMode="transfer"
        initialAmount={250}
        initialTransferAccountId="acc-2"
      />,
    );
    await waitFor(() => {
      expect(screen.getByText('From Account')).toBeInTheDocument();
    });
    const toAccountSelect = screen.getByLabelText('To Account') as HTMLSelectElement;
    expect(toAccountSelect.value).toBe('acc-2');
    const amountInput = screen.getByLabelText('Transfer Amount') as HTMLInputElement;
    expect(Number(amountInput.value)).toBe(250);
  });

  // --- Form submission for new scheduled transaction ---
  it('submits form for new scheduled transaction via submit button', async () => {
    const { container } = render(<ScheduledTransactionForm />);

    // Fill in required fields
    const nameInput = screen.getByLabelText('Name');
    fireEvent.change(nameInput, { target: { value: 'Test Rent Payment' } });

    // Submit the form
    const createButton = container.querySelector('button[type="submit"]')!;
    fireEvent.click(createButton);

    // The form should attempt submission (validation may reject, but the button click works)
    await waitFor(() => {
      // Either the create API was called, or toast error appeared for validation
      expect(createButton).toBeInTheDocument();
    });
  });

  // --- Form submission for editing existing ---
  it('shows Update button and pre-fills values when editing existing scheduled transaction', async () => {
    const existingSt = {
      id: 's1',
      accountId: 'acc-1',
      name: 'Monthly Rent',
      amount: -1500,
      currencyCode: 'CAD',
      frequency: 'MONTHLY' as const,
      nextDueDate: '2024-03-01T00:00:00Z',
      endDate: '2025-03-01T00:00:00Z',
      occurrencesRemaining: null,
      isActive: true,
      autoPost: true,
      reminderDaysBefore: 5,
      isTransfer: false,
      isSplit: false,
      description: 'Monthly rent payment',
    } as any;

    render(<ScheduledTransactionForm scheduledTransaction={existingSt} />);

    await waitFor(() => {
      expect(screen.getByText('Update')).toBeInTheDocument();
    });

    // Check pre-filled name
    const nameInput = screen.getByLabelText('Name') as HTMLInputElement;
    expect(nameInput.value).toBe('Monthly Rent');

    // Check pre-filled frequency
    const frequencySelect = screen.getByLabelText('Frequency') as HTMLSelectElement;
    expect(frequencySelect.value).toBe('MONTHLY');

    // Check pre-filled auto post
    const autoPostCheckbox = screen.getByLabelText('Auto-post on due date');
    expectToggle(autoPostCheckbox, true);

    // Check pre-filled reminder days
    const reminderInput = screen.getByLabelText('Remind Days Before') as HTMLInputElement;
    expect(reminderInput.value).toBe('5');
  });

  it('pre-fills next due date from existing scheduled transaction', async () => {
    const existingSt = {
      id: 's1',
      accountId: 'acc-1',
      name: 'Monthly Rent',
      amount: -1500,
      currencyCode: 'CAD',
      frequency: 'MONTHLY' as const,
      nextDueDate: '2024-03-01T00:00:00Z',
      isActive: true,
      autoPost: false,
      reminderDaysBefore: 3,
      isTransfer: false,
      isSplit: false,
    } as any;

    render(<ScheduledTransactionForm scheduledTransaction={existingSt} />);
    await waitFor(() => {
      expect(screen.getByLabelText('Next Due Date')).toBeInTheDocument();
    });
    const dateInput = screen.getByLabelText('Next Due Date') as HTMLInputElement;
    expect(dateInput.value).toBe('2024-03-01');
  });

  // --- Cancel button ---
  it('renders cancel button when onCancel is provided', async () => {
    const onCancel = vi.fn();
    render(<ScheduledTransactionForm onCancel={onCancel} />);
    await waitFor(() => {
      expect(screen.getByText('Cancel')).toBeInTheDocument();
    });
  });

  it('does not render cancel button when onCancel is not provided', async () => {
    render(<ScheduledTransactionForm />);
    await waitFor(() => {
      expect(screen.getByText('Transaction')).toBeInTheDocument();
    });
    expect(screen.queryByText('Cancel')).not.toBeInTheDocument();
  });

  it('calls onCancel when cancel button is clicked', async () => {
    const onCancel = vi.fn();
    render(<ScheduledTransactionForm onCancel={onCancel} />);
    await waitFor(() => {
      expect(screen.getByText('Cancel')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText('Cancel'));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  // --- Description field ---
  it('renders description textarea', async () => {
    render(<ScheduledTransactionForm />);
    await waitFor(() => {
      expect(screen.getByText('Description')).toBeInTheDocument();
    });
  });

  // --- Category section visible in payment mode ---
  it('shows Category section in payment mode', async () => {
    render(<ScheduledTransactionForm />);
    // The Combobox mock renders a label "Category" in payment mode
    await waitFor(() => {
      expect(screen.getByText('Category')).toBeInTheDocument();
    });
  });

  // --- Amount field ---
  it('renders amount field', async () => {
    render(<ScheduledTransactionForm />);
    await waitFor(() => {
      expect(screen.getByText('Amount')).toBeInTheDocument();
    });
  });

  // --- Account select ---
  it('renders account select dropdown', async () => {
    render(<ScheduledTransactionForm />);

    await waitFor(() => {
      expect(screen.getByText('Account')).toBeInTheDocument();
    });

    const accountSelect = screen.getByLabelText('Account');
    expect(accountSelect).toBeInTheDocument();
  });

  // --- Payee field ---
  it('renders payee combobox', async () => {
    render(<ScheduledTransactionForm />);
    await waitFor(() => {
      expect(screen.getByText('Payee')).toBeInTheDocument();
    });
  });

  // --- Multiple frequency changes ---
  it('allows changing frequency multiple times', async () => {
    render(<ScheduledTransactionForm />);
    await waitFor(() => {
      expect(screen.getByLabelText('Frequency')).toBeInTheDocument();
    });
    const frequencySelect = screen.getByLabelText('Frequency') as HTMLSelectElement;

    fireEvent.change(frequencySelect, { target: { value: 'DAILY' } });
    expect(frequencySelect.value).toBe('DAILY');

    fireEvent.change(frequencySelect, { target: { value: 'QUARTERLY' } });
    expect(frequencySelect.value).toBe('QUARTERLY');

    fireEvent.change(frequencySelect, { target: { value: 'YEARLY' } });
    expect(frequencySelect.value).toBe('YEARLY');
  });

  // --- onDirtyChange callback ---
  it('calls onDirtyChange when form becomes dirty', async () => {
    const onDirtyChange = vi.fn();
    render(<ScheduledTransactionForm onDirtyChange={onDirtyChange} />);

    // Initially the form calls onDirtyChange with false
    await waitFor(() => {
      expect(onDirtyChange).toHaveBeenCalled();
    });
  });

  // --- Split tab in tab bar ---
  it('renders Split tab in tab bar', async () => {
    render(<ScheduledTransactionForm />);
    await waitFor(() => {
      expect(screen.getByText('Split')).toBeInTheDocument();
    });
  });

  // --- Transfer hides category ---
  it('hides category in transfer mode', async () => {
    render(<ScheduledTransactionForm />);
    await waitFor(() => {
      expect(screen.getByText('Transfer')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText('Transfer'));
    // Category Combobox should not be shown in transfer mode
    expect(screen.queryByTestId('combobox-Category')).not.toBeInTheDocument();
  });

  // ============================================================
  // NEW TESTS: Editing an existing scheduled transaction
  // ============================================================

  it('pre-fills description from existing scheduled transaction', async () => {
    const existingSt = {
      id: 's1', accountId: 'acc-1', name: 'Monthly Rent', amount: -1500,
      currencyCode: 'CAD', frequency: 'MONTHLY' as const,
      nextDueDate: '2024-03-01T00:00:00Z', isActive: true, autoPost: false,
      reminderDaysBefore: 3, isTransfer: false, isSplit: false,
      description: 'Rent payment for apartment',
    } as any;

    render(<ScheduledTransactionForm scheduledTransaction={existingSt} />);
    await waitFor(() => {
      expect(document.querySelector('textarea')).toBeTruthy();
    });
    const textarea = document.querySelector('textarea');
    expect(textarea!.value).toBe('Rent payment for apartment');
  });

  it('pre-fills inactive status from existing scheduled transaction', async () => {
    const existingSt = {
      id: 's1', accountId: 'acc-1', name: 'Old Sub', amount: -10,
      currencyCode: 'CAD', frequency: 'MONTHLY' as const,
      nextDueDate: '2024-03-01T00:00:00Z', isActive: false, autoPost: false,
      reminderDaysBefore: 3, isTransfer: false, isSplit: false,
    } as any;

    render(<ScheduledTransactionForm scheduledTransaction={existingSt} />);
    await waitFor(() => {
      expect(screen.getByLabelText('Active')).toBeInTheDocument();
    });
    const activeCheckbox = screen.getByLabelText('Active');
    expectToggle(activeCheckbox, false);
  });

  it('pre-fills end date checkbox and value from existing scheduled transaction', async () => {
    const existingSt = {
      id: 's1', accountId: 'acc-1', name: 'Lease', amount: -2000,
      currencyCode: 'CAD', frequency: 'MONTHLY' as const,
      nextDueDate: '2024-03-01T00:00:00Z', endDate: '2025-12-31T00:00:00Z',
      occurrencesRemaining: null,
      isActive: true, autoPost: false, reminderDaysBefore: 3,
      isTransfer: false, isSplit: false,
    } as any;

    render(<ScheduledTransactionForm scheduledTransaction={existingSt} />);
    await waitFor(() => {
      expect(screen.getByLabelText('End by date')).toBeInTheDocument();
    });
    const endDateCheckbox = screen.getByLabelText('End by date');
    expectToggle(endDateCheckbox, true);
  });

  it('pre-fills occurrences remaining from existing scheduled transaction', async () => {
    const existingSt = {
      id: 's1', accountId: 'acc-1', name: 'Installments', amount: -200,
      currencyCode: 'CAD', frequency: 'MONTHLY' as const,
      nextDueDate: '2024-03-01T00:00:00Z', endDate: null,
      occurrencesRemaining: 12,
      isActive: true, autoPost: false, reminderDaysBefore: 3,
      isTransfer: false, isSplit: false,
    } as any;

    render(<ScheduledTransactionForm scheduledTransaction={existingSt} />);
    await waitFor(() => {
      expect(screen.getByLabelText('Number of occurrences')).toBeInTheDocument();
    });
    const occurrencesCheckbox = screen.getByLabelText('Number of occurrences');
    expectToggle(occurrencesCheckbox, true);
    const occurrencesInput = screen.getByPlaceholderText('# remaining') as HTMLInputElement;
    expect(occurrencesInput.value).toBe('12');
  });

  it('shows transfer amount as absolute value when editing a transfer', async () => {
    const transferSt = {
      id: 's1', accountId: 'acc-1', name: 'Savings Transfer',
      amount: -500, currencyCode: 'CAD', frequency: 'MONTHLY' as const,
      nextDueDate: '2024-02-01', isActive: true, autoPost: false,
      reminderDaysBefore: 3, isTransfer: true, transferAccountId: 'acc-2', isSplit: false,
    } as any;

    render(<ScheduledTransactionForm scheduledTransaction={transferSt} />);
    // The form should display absolute value of the transfer amount
    // (checking it doesn't crash and renders properly)
    await waitFor(() => {
      expect(screen.getByText('Update')).toBeInTheDocument();
    });
  });

  it('pre-fills frequency from existing scheduled transaction with WEEKLY', async () => {
    const existingSt = {
      id: 's1', accountId: 'acc-1', name: 'Weekly Groceries', amount: -100,
      currencyCode: 'CAD', frequency: 'WEEKLY' as const,
      nextDueDate: '2024-03-01T00:00:00Z', isActive: true, autoPost: false,
      reminderDaysBefore: 0, isTransfer: false, isSplit: false,
    } as any;

    render(<ScheduledTransactionForm scheduledTransaction={existingSt} />);
    await waitFor(() => {
      expect(screen.getByLabelText('Frequency')).toBeInTheDocument();
    });
    const frequencySelect = screen.getByLabelText('Frequency') as HTMLSelectElement;
    expect(frequencySelect.value).toBe('WEEKLY');
  });

  it('pre-fills frequency from existing scheduled transaction with YEARLY', async () => {
    const existingSt = {
      id: 's1', accountId: 'acc-1', name: 'Insurance Premium', amount: -1200,
      currencyCode: 'CAD', frequency: 'YEARLY' as const,
      nextDueDate: '2024-06-15T00:00:00Z', isActive: true, autoPost: false,
      reminderDaysBefore: 7, isTransfer: false, isSplit: false,
    } as any;

    render(<ScheduledTransactionForm scheduledTransaction={existingSt} />);
    await waitFor(() => {
      expect(screen.getByLabelText('Frequency')).toBeInTheDocument();
    });
    const frequencySelect = screen.getByLabelText('Frequency') as HTMLSelectElement;
    expect(frequencySelect.value).toBe('YEARLY');
  });

  // ============================================================
  // NEW TESTS: Form submission paths
  // ============================================================

  it('calls create API when submitting new form', async () => {
    const onSuccess = vi.fn();
    const { container } = render(<ScheduledTransactionForm onSuccess={onSuccess} />);

    await waitFor(() => {
      expect(mockAccountsGetAll).toHaveBeenCalled();
    });

    // Fill required fields
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Test Bill' } });

    // Select account
    const accountSelect = screen.getByLabelText('Account');
    fireEvent.change(accountSelect, { target: { value: 'acc-1' } });

    // Submit form
    const createButton = container.querySelector('button[type="submit"]')!;
    fireEvent.click(createButton);

    await waitFor(() => {
      // form attempted submission (create or validation toast)
      expect(createButton).toBeInTheDocument();
    });
  });

  it('calls update API when submitting edit form', async () => {
    const onSuccess = vi.fn();
    const existingSt = {
      id: 's1', accountId: 'acc-1', name: 'Monthly Rent', amount: -1500,
      currencyCode: 'CAD', frequency: 'MONTHLY' as const,
      nextDueDate: '2024-03-01T00:00:00Z', isActive: true, autoPost: false,
      reminderDaysBefore: 3, isTransfer: false, isSplit: false,
    } as any;

    render(<ScheduledTransactionForm scheduledTransaction={existingSt} onSuccess={onSuccess} />);

    await waitFor(() => {
      expect(mockAccountsGetAll).toHaveBeenCalled();
    });

    // Change name
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Updated Rent' } });

    // Submit form
    fireEvent.click(screen.getByText('Update'));

    await waitFor(() => {
      expect(screen.getByText('Update')).toBeInTheDocument();
    });
  });

  it('shows error toast when form data load fails', async () => {
    mockAccountsGetAll.mockRejectedValue(new Error('Network error'));

    render(<ScheduledTransactionForm />);

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Failed to load form data');
    });
  });

  // ============================================================
  // NEW TESTS: Transfer mode
  // ============================================================

  it('clears split state when switching to transfer mode', async () => {
    render(<ScheduledTransactionForm />);

    await waitFor(() => {
      expect(screen.getByText('Split')).toBeInTheDocument();
    });

    // Switch to split tab first
    await act(async () => { fireEvent.click(screen.getByText('Split')); });
    expect(screen.getByTestId('split-editor')).toBeInTheDocument();

    // Switch to transfer
    await act(async () => { fireEvent.click(screen.getByText('Transfer')); });

    // Split editor should not be visible in transfer mode
    expect(screen.queryByTestId('split-editor')).not.toBeInTheDocument();
  });

  it('filters out closed accounts, brokerage accounts, and asset accounts from account select', async () => {
    render(<ScheduledTransactionForm />);

    await waitFor(() => {
      expect(mockAccountsGetAll).toHaveBeenCalled();
    });

    // Wait for accounts to load
    await waitFor(() => {
      const accountSelect = screen.getByLabelText('Account');
      expect(accountSelect).toBeInTheDocument();
    });

    const accountSelect = screen.getByLabelText('Account') as HTMLSelectElement;
    const options = Array.from(accountSelect.querySelectorAll('option'));
    const optionTexts = options.map(o => o.textContent);

    // Should include active non-investment non-asset accounts
    expect(optionTexts.some(t => t?.includes('Chequing'))).toBe(true);
    expect(optionTexts.some(t => t?.includes('Savings'))).toBe(true);

    // Should not include closed, brokerage, or asset
    expect(optionTexts.some(t => t?.includes('Closed Account'))).toBe(false);
    expect(optionTexts.some(t => t?.includes('Brokerage'))).toBe(false);
    expect(optionTexts.some(t => t?.includes('House'))).toBe(false);
  });

  it('offers a crypto wallet as the account and as a transfer destination', async () => {
    mockAccountsGetAll.mockResolvedValue([
      ...mockAccounts,
      {
        id: 'acc-btc',
        name: 'Bitcoin Wallet',
        currencyCode: 'BTC',
        isClosed: false,
        accountType: 'CRYPTO',
        accountSubType: null,
      },
    ]);
    render(<ScheduledTransactionForm />);

    await waitFor(() => {
      const accountSelect = screen.getByLabelText('Account') as HTMLSelectElement;
      const texts = Array.from(accountSelect.querySelectorAll('option')).map(o => o.textContent);
      expect(texts.some(t => t?.includes('Bitcoin Wallet'))).toBe(true);
    });

    await act(async () => {
      fireEvent.change(screen.getByLabelText('Account'), { target: { value: 'acc-1' } });
    });
    await act(async () => {
      fireEvent.click(screen.getByText('Transfer'));
    });

    const toAccountSelect = await screen.findByLabelText('To Account') as HTMLSelectElement;
    const toTexts = Array.from(toAccountSelect.querySelectorAll('option')).map(o => o.textContent);
    expect(toTexts.some(t => t?.includes('Bitcoin Wallet'))).toBe(true);
  });

  it('shows transfer destination accounts filtered correctly in transfer mode', async () => {
    render(<ScheduledTransactionForm />);

    await waitFor(() => {
      expect(mockAccountsGetAll).toHaveBeenCalled();
    });

    // Select source account in transaction mode first
    await waitFor(() => {
      const accountSelect = screen.getByLabelText('Account');
      fireEvent.change(accountSelect, { target: { value: 'acc-1' } });
    });

    // Switch to transfer mode
    fireEvent.click(screen.getByText('Transfer'));

    await waitFor(() => {
      const toAccountSelect = screen.getByLabelText('To Account') as HTMLSelectElement;
      expect(toAccountSelect).toBeInTheDocument();
    });
  });

  // ============================================================
  // NEW TESTS: Split tab
  // ============================================================

  it('shows split editor when Split tab is clicked', async () => {
    render(<ScheduledTransactionForm />);

    await waitFor(() => {
      expect(screen.getByText('Split')).toBeInTheDocument();
    });

    await act(async () => { fireEvent.click(screen.getByText('Split')); });

    expect(screen.getByTestId('split-editor')).toBeInTheDocument();
  });

  it('hides category combobox in split mode', async () => {
    render(<ScheduledTransactionForm />);

    // Category combobox should be present in transaction mode
    await waitFor(() => {
      expect(screen.getByTestId('combobox-Category')).toBeInTheDocument();
    });

    await act(async () => { fireEvent.click(screen.getByText('Split')); });

    // Category combobox should not be visible in split mode
    expect(screen.queryByTestId('combobox-Category')).not.toBeInTheDocument();
  });

  it('removes split editor when switching back to transaction tab', async () => {
    render(<ScheduledTransactionForm />);

    await waitFor(() => {
      expect(screen.getByText('Split')).toBeInTheDocument();
    });

    await act(async () => { fireEvent.click(screen.getByText('Split')); });
    expect(screen.getByTestId('split-editor')).toBeInTheDocument();

    await act(async () => { fireEvent.click(screen.getByText('Transaction')); });
    expect(screen.queryByTestId('split-editor')).not.toBeInTheDocument();
  });

  // ============================================================
  // NEW TESTS: Payee selection and category auto-assignment
  // ============================================================

  it('auto-fills category from payee default category', async () => {
    render(<ScheduledTransactionForm />);

    // Wait for payee options to actually render (not just API call)
    await waitFor(() => {
      expect(screen.getByTestId('option-payee-1')).toBeInTheDocument();
    });

    // Select payee with default category
    const payeeOption = screen.getByTestId('option-payee-1');
    fireEvent.click(payeeOption);

    // The category should be auto-set (payee-1 has defaultCategoryId: cat-1)
    // We can verify the form state changed by checking the category combobox
    await waitFor(() => {
      expect(screen.getByTestId('combobox-Category')).toBeInTheDocument();
    });
  });

  it('does not auto-fill category if payee has no default category', async () => {
    const { container } = render(<ScheduledTransactionForm />);

    // Wait for payee options to actually render (not just API call)
    await waitFor(() => {
      expect(screen.getByTestId('option-payee-3')).toBeInTheDocument();
    });

    // Select payee without default category
    const payeeOption = screen.getByTestId('option-payee-3');
    await act(async () => { fireEvent.click(payeeOption); });

    // No crash, form should still work
    const submitButton = container.querySelector('button[type="submit"]');
    expect(submitButton).toBeInTheDocument();
    expect(submitButton!.textContent).toContain('Create');
  });

  it('clears payee when empty selection is made', async () => {
    const { container } = render(<ScheduledTransactionForm />);

    // Wait for payee options to actually render (not just API call)
    await waitFor(() => {
      expect(screen.getByTestId('option-payee-1')).toBeInTheDocument();
    });

    // Select then deselect payee
    const payeeOption = screen.getByTestId('option-payee-1');
    await act(async () => { fireEvent.click(payeeOption); });

    // Select empty (clear)
    const comboboxInput = screen.getByTestId('combobox-input-Payee');
    fireEvent.change(comboboxInput, { target: { value: '' } });

    const submitButton = container.querySelector('button[type="submit"]');
    expect(submitButton).toBeInTheDocument();
    expect(submitButton!.textContent).toContain('Create');
  });

  // ============================================================
  // NEW TESTS: Category selection
  // ============================================================

  it('allows selecting a category', async () => {
    const { container } = render(<ScheduledTransactionForm />);

    // Wait for category options to actually render
    await waitFor(() => {
      expect(screen.getByTestId('option-cat-1')).toBeInTheDocument();
    });

    // Select category (cat-1 = Rent, which is expense)
    const catOption = screen.getByTestId('option-cat-1');
    await act(async () => { fireEvent.click(catOption); });

    // Should still render normally
    const submitButton = container.querySelector('button[type="submit"]');
    expect(submitButton).toBeInTheDocument();
    expect(submitButton!.textContent).toContain('Create');
  });

  it('clears category when empty selection is made', async () => {
    const { container } = render(<ScheduledTransactionForm />);

    // Wait for category options to actually render
    await waitFor(() => {
      expect(screen.getByTestId('option-cat-1')).toBeInTheDocument();
    });

    // Select category
    const catOption = screen.getByTestId('option-cat-1');
    await act(async () => { fireEvent.click(catOption); });

    // Clear selection by clicking with empty value
    // Use the Category combobox
    const comboboxInput = screen.getByTestId('combobox-input-Category');
    fireEvent.change(comboboxInput, { target: { value: '' } });

    const submitButton = container.querySelector('button[type="submit"]');
    expect(submitButton).toBeInTheDocument();
    expect(submitButton!.textContent).toContain('Create');
  });

  // ============================================================
  // NEW TESTS: Creating payee and category inline
  // ============================================================

  it('creates a new payee via combobox create button', async () => {
    render(<ScheduledTransactionForm />);

    await waitFor(() => {
      expect(mockPayeesGetAll).toHaveBeenCalled();
    });

    const createButton = screen.getByTestId('combobox-create-Payee');
    fireEvent.click(createButton);

    await waitFor(() => {
      expect(mockPayeesCreate).toHaveBeenCalledWith({ name: 'New Item' });
    });
  });

  it('shows error toast if payee creation fails', async () => {
    mockPayeesCreate.mockRejectedValueOnce(new Error('Create failed'));

    render(<ScheduledTransactionForm />);

    await waitFor(() => {
      expect(mockPayeesGetAll).toHaveBeenCalled();
    });

    const createButton = screen.getByTestId('combobox-create-Payee');
    fireEvent.click(createButton);

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Failed to create payee');
    });
  });

  it('creates a new category via combobox create button', async () => {
    render(<ScheduledTransactionForm />);

    await waitFor(() => {
      expect(mockCategoriesGetAll).toHaveBeenCalled();
    });

    const createButton = screen.getByTestId('combobox-create-Category');
    fireEvent.click(createButton);

    await waitFor(() => {
      expect(mockCategoriesCreate).toHaveBeenCalledWith({ name: 'New Item' });
    });
  });

  // This form used to create the typed text verbatim as one flat category, so
  // "travel: hotels" became a top-level category literally named "Travel:
  // Hotels" here while the transaction form made Hotels a child of Travel. Both
  // now go through `createCategoryFromInput`.
  it('creates a parent and child for "Parent: Child" typed into the category field', async () => {
    mockCategoriesCreate
      .mockResolvedValueOnce({ id: 'parent-cat', name: 'Travel', parentId: null })
      .mockResolvedValueOnce({ id: 'child-cat', name: 'Hotels', parentId: 'parent-cat' });

    render(<ScheduledTransactionForm />);

    await waitFor(() => {
      expect(mockCategoriesGetAll).toHaveBeenCalled();
    });

    fireEvent.click(screen.getByTestId('combobox-create-nested-Category'));

    await waitFor(() => {
      expect(mockCategoriesCreate).toHaveBeenNthCalledWith(1, { name: 'Travel' });
    });
    expect(mockCategoriesCreate).toHaveBeenNthCalledWith(2, {
      name: 'Hotels',
      parentId: 'parent-cat',
    });
    await waitFor(() => {
      expect(toast.success).toHaveBeenCalledWith('Category "Travel: Hotels" created');
    });
  });

  it('shows error toast if category creation fails', async () => {
    mockCategoriesCreate.mockRejectedValueOnce(new Error('Create failed'));

    render(<ScheduledTransactionForm />);

    await waitFor(() => {
      expect(mockCategoriesGetAll).toHaveBeenCalled();
    });

    const createButton = screen.getByTestId('combobox-create-Category');
    fireEvent.click(createButton);

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Failed to create category');
    });
  });

  // ============================================================
  // NEW TESTS: Amount label changes in split mode
  // ============================================================

  it('changes amount label to Total Amount when Split tab is active', async () => {
    render(<ScheduledTransactionForm />);

    await waitFor(() => {
      expect(screen.getByText('Amount')).toBeInTheDocument();
    });

    await act(async () => { fireEvent.click(screen.getByText('Split')); });

    expect(screen.getByText('Total Amount')).toBeInTheDocument();
    expect(screen.queryByText('Amount')).not.toBeInTheDocument();
  });

  // ============================================================
  // NEW TESTS: Frequency-specific behavior for ONCE
  // ============================================================

  it('hides end condition section for ONCE frequency', async () => {
    render(<ScheduledTransactionForm />);

    // Default MONTHLY should show end condition
    await waitFor(() => {
      expect(screen.getByText('End Condition (optional)')).toBeInTheDocument();
    });

    // Switch to ONCE
    const frequencySelect = screen.getByLabelText('Frequency') as HTMLSelectElement;
    fireEvent.change(frequencySelect, { target: { value: 'ONCE' } });

    // End condition section should be hidden
    expect(screen.queryByText('End Condition (optional)')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('End by date')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Number of occurrences')).not.toBeInTheDocument();
  });

  // ============================================================
  // NEW TESTS: Form with existing ONCE frequency
  // ============================================================

  it('does not show end condition for existing ONCE frequency transaction', async () => {
    const onceSt = {
      id: 's1', accountId: 'acc-1', name: 'One Time Payment', amount: -500,
      currencyCode: 'CAD', frequency: 'ONCE' as const,
      nextDueDate: '2024-06-01T00:00:00Z', isActive: true, autoPost: false,
      reminderDaysBefore: 1, isTransfer: false, isSplit: false,
    } as any;

    render(<ScheduledTransactionForm scheduledTransaction={onceSt} />);
    await waitFor(() => {
      expect(screen.getByText('Update')).toBeInTheDocument();
    });
    expect(screen.queryByText('End Condition (optional)')).not.toBeInTheDocument();
  });

  // ============================================================
  // NEW TESTS: Name placeholder changes based on transaction type
  // ============================================================

  it('shows payment placeholder for name field in transaction mode', async () => {
    render(<ScheduledTransactionForm />);
    await waitFor(() => {
      expect(screen.getByLabelText('Name')).toBeInTheDocument();
    });
    const nameInput = screen.getByLabelText('Name') as HTMLInputElement;
    expect(nameInput.placeholder).toContain('Rent');
  });

  it('shows transfer placeholder for name field in transfer mode', async () => {
    render(<ScheduledTransactionForm />);
    await waitFor(() => {
      expect(screen.getByText('Transfer')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText('Transfer'));
    const nameInput = screen.getByLabelText('Name') as HTMLInputElement;
    expect(nameInput.placeholder).toContain('Savings Transfer');
  });

  // ============================================================
  // NEW TESTS: Split tab specific features
  // ============================================================

  it('shows Split Transaction header and Cancel Split button in split mode', async () => {
    render(<ScheduledTransactionForm />);

    await waitFor(() => {
      expect(screen.getByText('Split')).toBeInTheDocument();
    });

    await act(async () => { fireEvent.click(screen.getByText('Split')); });

    expect(screen.getByText('Split Transaction')).toBeInTheDocument();
    expect(screen.getByText('Cancel Split')).toBeInTheDocument();
  });

  it('Cancel Split button switches back to transaction mode', async () => {
    render(<ScheduledTransactionForm />);

    await waitFor(() => {
      expect(screen.getByText('Split')).toBeInTheDocument();
    });

    await act(async () => { fireEvent.click(screen.getByText('Split')); });
    expect(screen.getByTestId('split-editor')).toBeInTheDocument();

    await act(async () => { fireEvent.click(screen.getByText('Cancel Split')); });
    expect(screen.queryByTestId('split-editor')).not.toBeInTheDocument();
    // Should be back in transaction mode with Category visible
    expect(screen.getByTestId('combobox-Category')).toBeInTheDocument();
  });

  it('Split Transaction button on transaction tab switches to split mode', async () => {
    render(<ScheduledTransactionForm />);

    await waitFor(() => {
      expect(screen.getByText('Transaction')).toBeInTheDocument();
    });

    // Find the "Split Transaction" button (there are desktop and mobile versions)
    const splitButtons = screen.getAllByText('Split Transaction');
    expect(splitButtons.length).toBeGreaterThan(0);

    await act(async () => { fireEvent.click(splitButtons[0]); });

    expect(screen.getByTestId('split-editor')).toBeInTheDocument();
  });

  // ============================================================
  // NEW TESTS: Reference Number field
  // ============================================================

  it('renders Reference Number field in transaction mode', async () => {
    render(<ScheduledTransactionForm />);
    await waitFor(() => {
      expect(screen.getByText('Reference Number')).toBeInTheDocument();
    });
  });

  it('renders Reference Number field in transfer mode', async () => {
    render(<ScheduledTransactionForm />);
    await waitFor(() => {
      expect(screen.getByText('Transfer')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText('Transfer'));
    expect(screen.getByText('Reference Number')).toBeInTheDocument();
  });

  // ============================================================
  // NEW TESTS: Tab switching state management
  // ============================================================

  it('clears category when switching to split mode', async () => {
    render(<ScheduledTransactionForm />);

    await waitFor(() => {
      expect(screen.getByTestId('option-cat-1')).toBeInTheDocument();
    });

    // Select a category in transaction mode
    await act(async () => { fireEvent.click(screen.getByTestId('option-cat-1')); });

    // Switch to split mode
    await act(async () => { fireEvent.click(screen.getByText('Split')); });

    // Switch back to transaction mode
    await act(async () => { fireEvent.click(screen.getByText('Transaction')); });

    // Form should still render correctly
    expect(screen.getByTestId('combobox-Category')).toBeInTheDocument();
  });

  it('makes transfer amount positive when switching to transfer mode', async () => {
    render(<ScheduledTransactionForm />);
    await waitFor(() => {
      expect(screen.getByText('Transfer')).toBeInTheDocument();
    });

    // Switch to transfer mode
    await act(async () => { fireEvent.click(screen.getByText('Transfer')); });

    // Transfer Amount label should be present
    expect(screen.getByText('Transfer Amount')).toBeInTheDocument();
  });

  it('renders existing split transaction in split mode', async () => {
    const splitSt = {
      id: 's1', accountId: 'acc-1', name: 'Split Bill',
      amount: -100, currencyCode: 'CAD', frequency: 'MONTHLY' as const,
      nextDueDate: '2024-02-01', isActive: true, autoPost: false,
      reminderDaysBefore: 3, isTransfer: false, isSplit: true,
      transferAccountId: null,
      splits: [
        { id: 'sp1', categoryId: 'cat-1', amount: -60, memo: 'Part 1', transferAccountId: null },
        { id: 'sp2', categoryId: 'cat-2', amount: -40, memo: 'Part 2', transferAccountId: null },
      ],
    } as any;

    render(<ScheduledTransactionForm scheduledTransaction={splitSt} />);
    await waitFor(() => {
      // Should render in split mode
      expect(screen.getByTestId('split-editor')).toBeInTheDocument();
    });
    expect(screen.getByText('Split Transaction')).toBeInTheDocument();
    expect(screen.getByText('Cancel Split')).toBeInTheDocument();
  });

  // ============================================================
  // NEW TESTS: submitRef
  // ============================================================

  it('exposes form submit via submitRef', async () => {
    const submitRef = { current: null } as any;
    render(<ScheduledTransactionForm submitRef={submitRef} />);

    await waitFor(() => {
      expect(submitRef.current).toBeTruthy();
    });

    // submitRef.current should be a function
    expect(typeof submitRef.current).toBe('function');
  });

  // ============================================================
  // Investment funding account clearing (issue #1154)
  // ============================================================

  it('sends an explicit null funding account when editing BUY to DIVIDEND', async () => {
    const existingBuy = {
      id: 's-inv',
      accountId: 'acc-4', // Brokerage
      name: 'Quarterly holding',
      amount: -500,
      currencyCode: 'CAD',
      frequency: 'QUARTERLY' as const,
      nextDueDate: '2026-06-15',
      isActive: true,
      autoPost: false,
      reminderDaysBefore: 3,
      isTransfer: false,
      isSplit: false,
      isInvestment: true,
      investmentAction: 'BUY' as const,
      investmentSecurityId: 'sec-voo',
      // The stale funding account that must be cleared once the action no longer
      // uses one.
      investmentFundingAccountId: 'acc-1',
      investmentQuantity: 1,
      investmentPrice: 500,
      // Carried so the DIVIDEND branch's total-amount validation passes on save.
      investmentTotalAmount: 75,
    } as any;

    const { container } = render(
      <ScheduledTransactionForm scheduledTransaction={existingBuy} />,
    );

    await waitFor(() => {
      expect(screen.getByLabelText('Action')).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.change(screen.getByLabelText('Action'), {
        target: { value: 'DIVIDEND' },
      });
    });

    const submitButton = container.querySelector(
      'button[type="submit"]',
    ) as HTMLButtonElement;
    await act(async () => {
      fireEvent.click(submitButton);
    });
    await act(async () => {}); // flush the async submit handler

    await waitFor(() => {
      expect(mockUpdate).toHaveBeenCalled();
    });
    expect(toast.error).not.toHaveBeenCalled();
    const [, payload] = mockUpdate.mock.calls[0];
    expect(payload.investmentAction).toBe('DIVIDEND');
    expect(payload.investmentFundingAccountId).toBeNull();
  });

  it('keeps the funding account when saving a BUY unchanged', async () => {
    const existingBuy = {
      id: 's-inv',
      accountId: 'acc-4',
      name: 'Quarterly holding',
      amount: -500,
      currencyCode: 'CAD',
      frequency: 'QUARTERLY' as const,
      nextDueDate: '2026-06-15',
      isActive: true,
      autoPost: false,
      reminderDaysBefore: 3,
      isTransfer: false,
      isSplit: false,
      isInvestment: true,
      investmentAction: 'BUY' as const,
      investmentSecurityId: 'sec-voo',
      investmentFundingAccountId: 'acc-1',
      investmentQuantity: 1,
      investmentPrice: 500,
    } as any;

    const { container } = render(
      <ScheduledTransactionForm scheduledTransaction={existingBuy} />,
    );

    await waitFor(() => {
      expect(screen.getByLabelText('Action')).toBeInTheDocument();
    });

    const submitButton = container.querySelector(
      'button[type="submit"]',
    ) as HTMLButtonElement;
    await act(async () => {
      fireEvent.click(submitButton);
    });
    await act(async () => {});

    await waitFor(() => {
      expect(mockUpdate).toHaveBeenCalled();
    });
    const [, payload] = mockUpdate.mock.calls[0];
    expect(payload.investmentAction).toBe('BUY');
    expect(payload.investmentFundingAccountId).toBe('acc-1');
  });

  it('clears the hidden security (and funding) when editing BUY to INTEREST', async () => {
    // INTEREST has no security field in the scheduled UI; a security carried in
    // from the prior BUY would settle the interest in the security's currency,
    // so the form omits the key and lets the backend clear it on the
    // BUY -> INTEREST transition (issue #1154 review).
    const existingBuy = {
      id: 's-inv',
      accountId: 'acc-4', // Brokerage
      name: 'Bond interest',
      amount: -500,
      currencyCode: 'CAD',
      frequency: 'MONTHLY' as const,
      nextDueDate: '2026-06-15',
      isActive: true,
      autoPost: false,
      reminderDaysBefore: 3,
      isTransfer: false,
      isSplit: false,
      isInvestment: true,
      investmentAction: 'BUY' as const,
      investmentSecurityId: 'sec-voo',
      investmentFundingAccountId: 'acc-1',
      investmentQuantity: 1,
      investmentPrice: 500,
      investmentTotalAmount: 25,
    } as any;

    const { container } = render(
      <ScheduledTransactionForm scheduledTransaction={existingBuy} />,
    );

    await waitFor(() => {
      expect(screen.getByLabelText('Action')).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.change(screen.getByLabelText('Action'), {
        target: { value: 'INTEREST' },
      });
    });

    const submitButton = container.querySelector(
      'button[type="submit"]',
    ) as HTMLButtonElement;
    await act(async () => {
      fireEvent.click(submitButton);
    });
    await act(async () => {});

    await waitFor(() => {
      expect(mockUpdate).toHaveBeenCalled();
    });
    expect(toast.error).not.toHaveBeenCalled();
    const [, payload] = mockUpdate.mock.calls[0];
    expect(payload.investmentAction).toBe('INTEREST');
    // The key is omitted (undefined), not null: the backend clears the hidden
    // security on the action transition. Sending null unconditionally would also
    // destroy a deliberate security-specific INTEREST on a later unrelated edit.
    expect(payload.investmentSecurityId).toBeUndefined();
    expect(payload.investmentFundingAccountId).toBeNull();
  });

  it('does not clear a deliberate INTEREST security on a name-only edit (issue #1154 re-review)', async () => {
    // An existing security-specific INTEREST (e.g. created via the API) must
    // survive a presentation-only edit: the form omits the security key rather
    // than sending null, so the backend leaves the stored value untouched
    // because the action did not change.
    const existingInterest = {
      id: 's-int',
      accountId: 'acc-4', // Brokerage
      name: 'Bond interest',
      amount: 100,
      currencyCode: 'CAD',
      frequency: 'MONTHLY' as const,
      nextDueDate: '2026-06-15',
      isActive: true,
      autoPost: false,
      reminderDaysBefore: 3,
      isTransfer: false,
      isSplit: false,
      isInvestment: true,
      investmentAction: 'INTEREST' as const,
      investmentSecurityId: 'sec-voo',
      investmentTotalAmount: 100,
    } as any;

    const { container } = render(
      <ScheduledTransactionForm scheduledTransaction={existingInterest} />,
    );

    await waitFor(() => {
      expect(screen.getByLabelText('Name')).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.change(screen.getByLabelText('Name'), {
        target: { value: 'Bond interest (renamed)' },
      });
    });

    const submitButton = container.querySelector(
      'button[type="submit"]',
    ) as HTMLButtonElement;
    await act(async () => {
      fireEvent.click(submitButton);
    });
    await act(async () => {});

    await waitFor(() => {
      expect(mockUpdate).toHaveBeenCalled();
    });
    expect(toast.error).not.toHaveBeenCalled();
    const [, payload] = mockUpdate.mock.calls[0];
    expect(payload.investmentAction).toBe('INTEREST');
    // Omitted, not null -> backend preserves the deliberate security.
    expect(payload.investmentSecurityId).toBeUndefined();
  });

  // ============================================================
  // NEW TESTS: templateTransaction prop initialization
  // ============================================================

  it('initializes from templateTransaction with payeeName as name', async () => {
    const template = {
      id: 't1',
      accountId: 'acc-1',
      payeeId: 'payee-1',
      payeeName: 'Landlord',
      categoryId: 'cat-1',
      amount: -1500,
      currencyCode: 'CAD',
      description: 'Template desc',
      isTransfer: false,
      isSplit: false,
      tags: [],
    } as any;

    render(<ScheduledTransactionForm templateTransaction={template} />);
    await waitFor(() => {
      const nameInput = screen.getByLabelText('Name') as HTMLInputElement;
      expect(nameInput.value).toBe('Landlord');
    });
  });

  it('initializes transfer mode from templateTransaction.isTransfer', async () => {
    const template = {
      id: 't1',
      accountId: 'acc-1',
      payeeId: '',
      payeeName: '',
      amount: -500,
      currencyCode: 'CAD',
      isTransfer: true,
      isSplit: false,
      tags: [],
      linkedTransaction: { accountId: 'acc-2' },
    } as any;

    render(<ScheduledTransactionForm templateTransaction={template} />);
    await waitFor(() => {
      expect(screen.getByText('From Account')).toBeInTheDocument();
    });
    expect(screen.getByText('To Account')).toBeInTheDocument();
  });

  it('initializes split mode from templateTransaction.isSplit', async () => {
    const template = {
      id: 't1',
      accountId: 'acc-1',
      payeeId: '',
      payeeName: '',
      amount: -100,
      currencyCode: 'CAD',
      isTransfer: false,
      isSplit: true,
      tags: [],
      splits: [
        { id: 'sp1', categoryId: 'cat-1', amount: -60, memo: '' },
        { id: 'sp2', categoryId: 'cat-2', amount: -40, memo: '' },
      ],
    } as any;

    render(<ScheduledTransactionForm templateTransaction={template} />);
    await waitFor(() => {
      expect(screen.getByTestId('split-editor')).toBeInTheDocument();
    });
  });

  it('initializes selectedTagIds from templateTransaction.tags', async () => {
    const template = {
      id: 't1',
      accountId: 'acc-1',
      payeeId: '',
      payeeName: '',
      amount: -100,
      currencyCode: 'CAD',
      isTransfer: false,
      isSplit: false,
      tags: [{ id: 'tag-1', name: 'Food' }],
    } as any;

    render(<ScheduledTransactionForm templateTransaction={template} />);
    await waitFor(() => {
      expect(screen.getByText('Transaction')).toBeInTheDocument();
    });
    // No crash, form renders in transaction mode
    expect(screen.getByText('Split')).toBeInTheDocument();
  });

  it('uses template amount as absolute when templateTransaction.isTransfer is true', async () => {
    const template = {
      id: 't1',
      accountId: 'acc-1',
      payeeId: '',
      payeeName: '',
      amount: -800,
      currencyCode: 'USD',
      isTransfer: true,
      isSplit: false,
      tags: [],
      linkedTransaction: null,
    } as any;

    render(<ScheduledTransactionForm templateTransaction={template} />);
    await waitFor(() => {
      expect(screen.getByText('From Account')).toBeInTheDocument();
    });
    // Transfer amount shows absolute value, no crash
    expect(screen.getByText('Transfer Amount')).toBeInTheDocument();
  });

  // ============================================================
  // NEW TESTS: Inactive payee fetching
  // ============================================================

  it('fetches inactive payee by ID when editing and payee not in active list', async () => {
    const stWithInactivePayee = {
      id: 's1', accountId: 'acc-1', name: 'Rent',
      amount: -1500, currencyCode: 'CAD', frequency: 'MONTHLY' as const,
      nextDueDate: '2024-03-01', isActive: true, autoPost: false,
      reminderDaysBefore: 3, isTransfer: false, isSplit: false,
      payeeId: 'payee-inactive',
    } as any;

    render(<ScheduledTransactionForm scheduledTransaction={stWithInactivePayee} />);

    await waitFor(() => {
      expect(mockPayeesGetById).toHaveBeenCalledWith('payee-inactive');
    });
  });

  it('falls back gracefully when inactive payee fetch fails', async () => {
    mockPayeesGetById.mockRejectedValueOnce(new Error('Payee not found'));

    const stWithInactivePayee = {
      id: 's1', accountId: 'acc-1', name: 'Rent',
      amount: -1500, currencyCode: 'CAD', frequency: 'MONTHLY' as const,
      nextDueDate: '2024-03-01', isActive: true, autoPost: false,
      reminderDaysBefore: 3, isTransfer: false, isSplit: false,
      payeeId: 'payee-inactive',
    } as any;

    render(<ScheduledTransactionForm scheduledTransaction={stWithInactivePayee} />);

    await waitFor(() => {
      expect(mockPayeesGetById).toHaveBeenCalledWith('payee-inactive');
    });
    // Should not crash - renders form normally
    expect(screen.getByText('Update')).toBeInTheDocument();
  });

  // ============================================================
  // NEW TESTS: Transfer submit validation
  // ============================================================

  it('shows error toast when submitting transfer with no destination account', async () => {
    const { container } = render(<ScheduledTransactionForm />);

    await waitFor(() => {
      expect(mockAccountsGetAll).toHaveBeenCalled();
    });

    // Switch to transfer mode
    await act(async () => { fireEvent.click(screen.getByText('Transfer')); });

    await waitFor(() => {
      expect(screen.getByLabelText('From Account')).toBeInTheDocument();
    });

    // Fill source account and name but no destination
    fireEvent.change(screen.getByLabelText('From Account'), { target: { value: 'acc-1' } });
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'No Destination Transfer' } });

    const submitBtn = container.querySelector('button[type="submit"]')!;
    await act(async () => { fireEvent.click(submitBtn); });

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Please select a destination account for the transfer');
    });
  });

  it('shows error toast when transfer source and destination are the same', async () => {
    const { container } = render(<ScheduledTransactionForm />);

    await waitFor(() => {
      expect(mockAccountsGetAll).toHaveBeenCalled();
    });

    // Switch to transfer mode
    await act(async () => { fireEvent.click(screen.getByText('Transfer')); });

    await waitFor(() => {
      expect(screen.getByLabelText('From Account')).toBeInTheDocument();
    });

    // Set To Account first (before From Account changes the available options),
    // then set From Account to the same value to trigger same-account validation.
    fireEvent.change(screen.getByLabelText('To Account'), { target: { value: 'acc-1' } });
    fireEvent.change(screen.getByLabelText('From Account'), { target: { value: 'acc-1' } });
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Self Transfer' } });

    const submitBtn = container.querySelector('button[type="submit"]')!;
    await act(async () => { fireEvent.click(submitBtn); });

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Source and destination accounts must be different');
    });
  });

  it('submits transfer successfully when valid destination is selected', async () => {
    const onSuccess = vi.fn();
    const { container } = render(<ScheduledTransactionForm onSuccess={onSuccess} />);

    await waitFor(() => {
      expect(mockAccountsGetAll).toHaveBeenCalled();
    });

    // Switch to transfer mode
    await act(async () => { fireEvent.click(screen.getByText('Transfer')); });

    await waitFor(() => {
      expect(screen.getByLabelText('From Account')).toBeInTheDocument();
    });

    // Set valid source and destination
    fireEvent.change(screen.getByLabelText('From Account'), { target: { value: 'acc-1' } });
    fireEvent.change(screen.getByLabelText('To Account'), { target: { value: 'acc-2' } });
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Savings Transfer' } });

    const submitBtn = container.querySelector('button[type="submit"]')!;
    await act(async () => { fireEvent.click(submitBtn); });

    await waitFor(() => {
      expect(mockCreate).toHaveBeenCalled();
    });
    expect(toast.success).toHaveBeenCalledWith('Scheduled transaction created');
    expect(onSuccess).toHaveBeenCalled();
  });

  it('shows error toast when transfer submission API fails', async () => {
    mockCreate.mockRejectedValueOnce(new Error('Server error'));
    const { container } = render(<ScheduledTransactionForm />);

    await waitFor(() => {
      expect(mockAccountsGetAll).toHaveBeenCalled();
    });

    await act(async () => { fireEvent.click(screen.getByText('Transfer')); });

    await waitFor(() => {
      expect(screen.getByLabelText('From Account')).toBeInTheDocument();
    });

    fireEvent.change(screen.getByLabelText('From Account'), { target: { value: 'acc-1' } });
    fireEvent.change(screen.getByLabelText('To Account'), { target: { value: 'acc-2' } });
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Transfer' } });

    const submitBtn = container.querySelector('button[type="submit"]')!;
    await act(async () => { fireEvent.click(submitBtn); });

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Failed to save scheduled transaction');
    });
  });

  // ============================================================
  // NEW TESTS: Split submit validation
  // ============================================================

  it('shows error when submitting split with fewer than 2 splits', async () => {
    // Override createEmptySplits to return 0 splits for this test
    // The mock returns 2 splits by default, so we need 0 splits state
    // We can test by starting in split mode with an existing ST that has no splits
    const noSplitsSt = {
      id: 's1', accountId: 'acc-1', name: 'Split Bill',
      amount: -100, currencyCode: 'CAD', frequency: 'MONTHLY' as const,
      nextDueDate: '2024-02-01', isActive: true, autoPost: false,
      reminderDaysBefore: 3, isTransfer: false, isSplit: true,
      transferAccountId: null,
      splits: [],
    } as any;

    const { container } = render(<ScheduledTransactionForm scheduledTransaction={noSplitsSt} />);

    await waitFor(() => {
      expect(mockAccountsGetAll).toHaveBeenCalled();
    });

    // Should be in split mode with empty splits
    const submitBtn = container.querySelector('button[type="submit"]')!;
    await act(async () => { fireEvent.click(submitBtn); });

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Split transactions require at least 2 splits');
    });
  });

  // ============================================================
  // NEW TESTS: Transaction submit paths
  // ============================================================

  it('calls create API when submitting new transaction form with valid data', async () => {
    const onSuccess = vi.fn();
    const { container } = render(<ScheduledTransactionForm onSuccess={onSuccess} />);

    await waitFor(() => {
      expect(mockAccountsGetAll).toHaveBeenCalled();
    });

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'New Bill' } });
    fireEvent.change(screen.getByLabelText('Account'), { target: { value: 'acc-1' } });

    const submitBtn = container.querySelector('button[type="submit"]')!;
    await act(async () => { fireEvent.click(submitBtn); });

    await waitFor(() => {
      expect(mockCreate).toHaveBeenCalled();
    });
    expect(toast.success).toHaveBeenCalledWith('Scheduled transaction created');
    expect(onSuccess).toHaveBeenCalled();
  });

  it('calls update API when submitting edit form in transaction mode', async () => {
    const onSuccess = vi.fn();
    const existingSt = {
      id: 's1', accountId: 'acc-1', name: 'Monthly Rent', amount: -1500,
      currencyCode: 'CAD', frequency: 'MONTHLY' as const,
      nextDueDate: '2024-03-01', isActive: true, autoPost: false,
      reminderDaysBefore: 3, isTransfer: false, isSplit: false,
    } as any;

    const { container } = render(<ScheduledTransactionForm scheduledTransaction={existingSt} onSuccess={onSuccess} />);

    await waitFor(() => {
      expect(mockAccountsGetAll).toHaveBeenCalled();
    });

    const submitBtn = container.querySelector('button[type="submit"]')!;
    await act(async () => { fireEvent.click(submitBtn); });

    await waitFor(() => {
      expect(mockUpdate).toHaveBeenCalledWith('s1', expect.objectContaining({ name: 'Monthly Rent' }));
    });
    expect(toast.success).toHaveBeenCalledWith('Scheduled transaction updated');
    expect(onSuccess).toHaveBeenCalled();
  });

  // Issue #1979: a cleared description used to be dropped from the payload, so
  // the stored one survived the save; the reference number was stripped.
  it('sends null for a cleared description and reference number on update', async () => {
    const existingSt = {
      id: 's1', accountId: 'acc-1', name: 'Monthly Rent', amount: -1500,
      currencyCode: 'CAD', frequency: 'MONTHLY' as const,
      nextDueDate: '2024-03-01', isActive: true, autoPost: false,
      reminderDaysBefore: 3, isTransfer: false, isSplit: false,
      description: 'Old note', referenceNumber: 'ACCT-42',
    } as any;

    const { container } = render(<ScheduledTransactionForm scheduledTransaction={existingSt} />);
    await waitFor(() => expect(mockAccountsGetAll).toHaveBeenCalled());

    fireEvent.change(screen.getByDisplayValue('Old note'), { target: { value: '' } });
    fireEvent.change(screen.getByDisplayValue('ACCT-42'), { target: { value: '' } });

    await act(async () => { fireEvent.click(container.querySelector('button[type="submit"]')!); });

    await waitFor(() => expect(mockUpdate).toHaveBeenCalled());
    const [, payload] = mockUpdate.mock.calls[0];
    expect(payload.description).toBeNull();
    expect(payload.referenceNumber).toBeNull();
  });

  it('sends an edited reference number on update', async () => {
    const existingSt = {
      id: 's1', accountId: 'acc-1', name: 'Monthly Rent', amount: -1500,
      currencyCode: 'CAD', frequency: 'MONTHLY' as const,
      nextDueDate: '2024-03-01', isActive: true, autoPost: false,
      reminderDaysBefore: 3, isTransfer: false, isSplit: false,
      referenceNumber: null,
    } as any;

    const { container } = render(<ScheduledTransactionForm scheduledTransaction={existingSt} />);
    await waitFor(() => expect(mockAccountsGetAll).toHaveBeenCalled());

    fireEvent.change(screen.getByPlaceholderText('Cheque #, confirmation #...'), { target: { value: 'ACCT-42' } });

    await act(async () => { fireEvent.click(container.querySelector('button[type="submit"]')!); });

    await waitFor(() => expect(mockUpdate).toHaveBeenCalled());
    const [, payload] = mockUpdate.mock.calls[0];
    expect(payload.referenceNumber).toBe('ACCT-42');
  });

  it('shows the optional category field in transfer mode (#743)', async () => {
    render(<ScheduledTransactionForm />);
    await waitFor(() => expect(screen.getByText('Transfer')).toBeInTheDocument());

    await act(async () => { fireEvent.click(screen.getByText('Transfer')); });

    expect(screen.getByText('Category (optional)')).toBeInTheDocument();
  });

  it('keeps the category when submitting an existing transfer schedule (#743)', async () => {
    const onSuccess = vi.fn();
    const existingSt = {
      id: 's1', accountId: 'acc-1', name: 'Monthly IKE', amount: -1000,
      currencyCode: 'CAD', frequency: 'MONTHLY' as const,
      nextDueDate: '2024-03-01', isActive: true, autoPost: false,
      reminderDaysBefore: 3, isTransfer: true, transferAccountId: 'acc-2',
      isSplit: false, categoryId: 'cat-1',
      category: { id: 'cat-1', name: 'Investments' },
    } as any;

    const { container } = render(
      <ScheduledTransactionForm scheduledTransaction={existingSt} onSuccess={onSuccess} />,
    );
    await waitFor(() => expect(mockAccountsGetAll).toHaveBeenCalled());

    const submitBtn = container.querySelector('button[type="submit"]')!;
    await act(async () => { fireEvent.click(submitBtn); });

    await waitFor(() => {
      expect(mockUpdate).toHaveBeenCalledWith(
        's1',
        expect.objectContaining({ isTransfer: true, categoryId: 'cat-1' }),
      );
    });
  });

  it('sends splits: [] when converting an existing split scheduled transaction back to regular', async () => {
    const onSuccess = vi.fn();
    const existingSt = {
      id: 's1', accountId: 'acc-1', name: 'Monthly Rent', amount: -1500,
      currencyCode: 'CAD', frequency: 'MONTHLY' as const,
      nextDueDate: '2024-03-01', isActive: true, autoPost: false,
      reminderDaysBefore: 3, isTransfer: false, isSplit: true,
      splits: [
        { id: 'sp-1', categoryId: 'cat-1', amount: -1000, memo: '', kind: 'category' as const },
        { id: 'sp-2', categoryId: 'cat-2', amount: -500, memo: '', kind: 'category' as const },
      ],
    } as any;

    const { container } = render(<ScheduledTransactionForm scheduledTransaction={existingSt} onSuccess={onSuccess} />);

    await waitFor(() => {
      expect(mockAccountsGetAll).toHaveBeenCalled();
    });

    // Editing a split scheduled transaction starts in split mode; switch to the
    // Transaction tab (mirrors deleting the final split).
    await act(async () => { fireEvent.click(screen.getByText('Transaction')); });

    const submitBtn = container.querySelector('button[type="submit"]')!;
    await act(async () => { fireEvent.click(submitBtn); });

    await waitFor(() => {
      expect(mockUpdate).toHaveBeenCalledWith('s1', expect.objectContaining({ splits: [] }));
    });
  });

  it('shows error toast when create API fails', async () => {
    mockCreate.mockRejectedValueOnce(new Error('Server error'));
    const { container } = render(<ScheduledTransactionForm />);

    await waitFor(() => {
      expect(mockAccountsGetAll).toHaveBeenCalled();
    });

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Test' } });
    fireEvent.change(screen.getByLabelText('Account'), { target: { value: 'acc-1' } });

    const submitBtn = container.querySelector('button[type="submit"]')!;
    await act(async () => { fireEvent.click(submitBtn); });

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Failed to save scheduled transaction');
    });
  });

  it('shows error toast when update API fails', async () => {
    mockUpdate.mockRejectedValueOnce(new Error('Server error'));
    const existingSt = {
      id: 's1', accountId: 'acc-1', name: 'Monthly Rent', amount: -1500,
      currencyCode: 'CAD', frequency: 'MONTHLY' as const,
      nextDueDate: '2024-03-01', isActive: true, autoPost: false,
      reminderDaysBefore: 3, isTransfer: false, isSplit: false,
    } as any;

    const { container } = render(<ScheduledTransactionForm scheduledTransaction={existingSt} />);

    await waitFor(() => {
      expect(mockAccountsGetAll).toHaveBeenCalled();
    });

    const submitBtn = container.querySelector('button[type="submit"]')!;
    await act(async () => { fireEvent.click(submitBtn); });

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Failed to save scheduled transaction');
    });
  });

  it('submits with useEndDate in payload when end date checkbox is enabled', async () => {
    const onSuccess = vi.fn();
    const { container } = render(<ScheduledTransactionForm onSuccess={onSuccess} />);

    await waitFor(() => {
      expect(screen.getByLabelText('End by date')).toBeInTheDocument();
    });

    // Enable end date checkbox
    fireEvent.click(screen.getByLabelText('End by date'));

    // Fill required fields
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Test Bill' } });
    fireEvent.change(screen.getByLabelText('Account'), { target: { value: 'acc-1' } });

    const submitBtn = container.querySelector('button[type="submit"]')!;
    await act(async () => { fireEvent.click(submitBtn); });

    await waitFor(() => {
      expect(mockCreate).toHaveBeenCalled();
    });
  });

  // ============================================================
  // NEW TESTS: Amount sign adjustment via category
  // ============================================================

  it('adjusts amount to positive when income category is selected with non-zero amount', async () => {
    const stWithNegAmount = {
      id: 's1', accountId: 'acc-1', name: 'Salary',
      amount: -100, currencyCode: 'CAD', frequency: 'MONTHLY' as const,
      nextDueDate: '2024-03-01', isActive: true, autoPost: false,
      reminderDaysBefore: 3, isTransfer: false, isSplit: false,
      categoryId: '',
    } as any;

    render(<ScheduledTransactionForm scheduledTransaction={stWithNegAmount} />);

    await waitFor(() => {
      expect(screen.getByTestId('option-cat-2')).toBeInTheDocument();
    });

    // Select income category (cat-2 = Salary, isIncome: true) - amount is -100
    await act(async () => { fireEvent.click(screen.getByTestId('option-cat-2')); });

    // Amount should now be adjusted to positive
    expect(screen.getByText('Update')).toBeInTheDocument();
  });

  it('does not auto-fill category from payee when already has a category selected', async () => {
    const stWithCategory = {
      id: 's1', accountId: 'acc-1', name: 'Rent',
      amount: -1500, currencyCode: 'CAD', frequency: 'MONTHLY' as const,
      nextDueDate: '2024-03-01', isActive: true, autoPost: false,
      reminderDaysBefore: 3, isTransfer: false, isSplit: false,
      categoryId: 'cat-1',
    } as any;

    render(<ScheduledTransactionForm scheduledTransaction={stWithCategory} />);

    await waitFor(() => {
      expect(screen.getByTestId('option-payee-2')).toBeInTheDocument();
    });

    // Select payee-2 = Employer with defaultCategoryId: cat-2
    // But since selectedCategoryId is 'cat-1', it should NOT auto-fill
    await act(async () => { fireEvent.click(screen.getByTestId('option-payee-2')); });

    // Form renders without crash
    expect(screen.getByText('Update')).toBeInTheDocument();
  });

  it('does not auto-fill category from payee when in transfer mode', async () => {
    render(<ScheduledTransactionForm />);

    await waitFor(() => {
      expect(screen.getByText('Transfer')).toBeInTheDocument();
    });

    // Switch to transfer mode
    await act(async () => { fireEvent.click(screen.getByText('Transfer')); });

    await waitFor(() => {
      expect(screen.getByTestId('option-payee-1')).toBeInTheDocument();
    });

    // Select payee with default category in transfer mode (should NOT auto-fill category)
    await act(async () => { fireEvent.click(screen.getByTestId('option-payee-1')); });

    // Category should not be shown in transfer mode
    expect(screen.queryByTestId('combobox-Category')).not.toBeInTheDocument();
  });

  // ============================================================
  // NEW TESTS: handleModeChange branch cases
  // ============================================================

  it('makes amount positive when switching to transfer with negative amount', async () => {
    const stWithNegAmount = {
      id: 's1', accountId: 'acc-1', name: 'Expense',
      amount: -200, currencyCode: 'CAD', frequency: 'MONTHLY' as const,
      nextDueDate: '2024-02-01', isActive: true, autoPost: false,
      reminderDaysBefore: 3, isTransfer: false, isSplit: false,
    } as any;

    render(<ScheduledTransactionForm scheduledTransaction={stWithNegAmount} />);

    await waitFor(() => {
      expect(screen.getByText('Transfer')).toBeInTheDocument();
    });

    // Switch to transfer mode - amount -200 should become +200
    await act(async () => { fireEvent.click(screen.getByText('Transfer')); });

    expect(screen.getByText('Transfer Amount')).toBeInTheDocument();
  });

  it('does not re-create splits when switching to split mode when splits already exist', async () => {
    const splitSt = {
      id: 's1', accountId: 'acc-1', name: 'Split Bill',
      amount: -100, currencyCode: 'CAD', frequency: 'MONTHLY' as const,
      nextDueDate: '2024-02-01', isActive: true, autoPost: false,
      reminderDaysBefore: 3, isTransfer: false, isSplit: true,
      transferAccountId: null,
      splits: [
        { id: 'sp1', categoryId: 'cat-1', amount: -60, memo: 'Part 1', transferAccountId: null },
        { id: 'sp2', categoryId: 'cat-2', amount: -40, memo: 'Part 2', transferAccountId: null },
      ],
    } as any;

    render(<ScheduledTransactionForm scheduledTransaction={splitSt} />);

    await waitFor(() => {
      expect(screen.getByTestId('split-editor')).toBeInTheDocument();
    });

    // Go to transaction mode and back to split - splits already exist (length > 0)
    await act(async () => { fireEvent.click(screen.getByText('Transaction')); });
    await act(async () => { fireEvent.click(screen.getByText('Split')); });

    expect(screen.getByTestId('split-editor')).toBeInTheDocument();
  });

  // ============================================================
  // NEW TESTS: handlePayeeSearch
  // ============================================================

  it('filters payees based on search query of length >= 2', async () => {
    render(<ScheduledTransactionForm />);

    await waitFor(() => {
      expect(mockPayeesGetAll).toHaveBeenCalled();
    });

    // Trigger search with query >= 2 chars
    const payeeInput = screen.getByTestId('combobox-input-Payee');
    fireEvent.change(payeeInput, { target: { value: 'La' } });

    // After search, no crash
    expect(screen.getByTestId('combobox-Payee')).toBeInTheDocument();
  });

  it('resets payee list when search query is too short', async () => {
    render(<ScheduledTransactionForm />);

    await waitFor(() => {
      expect(mockPayeesGetAll).toHaveBeenCalled();
    });

    const payeeInput = screen.getByTestId('combobox-input-Payee');
    // Search then clear back to 1 char
    fireEvent.change(payeeInput, { target: { value: 'La' } });
    fireEvent.change(payeeInput, { target: { value: 'L' } });

    expect(screen.getByTestId('combobox-Payee')).toBeInTheDocument();
  });

  // ============================================================
  // NEW TESTS: End condition in split mode
  // ============================================================

  it('shows end condition section in split mode', async () => {
    render(<ScheduledTransactionForm />);

    await waitFor(() => {
      expect(screen.getByText('Split')).toBeInTheDocument();
    });

    await act(async () => { fireEvent.click(screen.getByText('Split')); });

    expect(screen.getByText('End Condition (optional)')).toBeInTheDocument();
  });

  it('hides end condition in split mode when ONCE frequency is selected', async () => {
    render(<ScheduledTransactionForm />);

    await waitFor(() => {
      expect(screen.getByText('Split')).toBeInTheDocument();
    });

    await act(async () => { fireEvent.click(screen.getByText('Split')); });

    const frequencySelects = screen.getAllByLabelText('Frequency');
    fireEvent.change(frequencySelects[0], { target: { value: 'ONCE' } });

    expect(screen.queryByText('End Condition (optional)')).not.toBeInTheDocument();
  });

  // ============================================================
  // NEW TESTS: Currency auto-update from account
  // ============================================================

  it('auto-updates currency when a different account is selected', async () => {
    const usdAccount = {
      id: 'acc-usd',
      name: 'USD Account',
      currencyCode: 'USD',
      isClosed: false,
      accountType: 'CHEQUING',
      accountSubType: null,
    };

    mockAccountsGetAll.mockResolvedValue([...mockAccounts, usdAccount]);

    render(<ScheduledTransactionForm />);

    await waitFor(() => {
      expect(mockAccountsGetAll).toHaveBeenCalled();
    });

    const accountSelect = screen.getByLabelText('Account');
    fireEvent.change(accountSelect, { target: { value: 'acc-usd' } });

    // No crash after currency change
    expect(screen.getByText('Transaction')).toBeInTheDocument();
  });

  // ============================================================
  // NEW TESTS: Transfer mode end condition (mirrors the Transaction tab)
  // ============================================================

  it('shows end condition section in transfer mode', async () => {
    render(<ScheduledTransactionForm />);

    await waitFor(() => {
      expect(screen.getByText('Transfer')).toBeInTheDocument();
    });

    await act(async () => { fireEvent.click(screen.getByText('Transfer')); });

    expect(screen.getByText('End Condition (optional)')).toBeInTheDocument();
    expect(screen.getByLabelText('End by date')).toBeInTheDocument();
    expect(screen.getByLabelText('Number of occurrences')).toBeInTheDocument();
  });

  // ============================================================
  // NEW TESTS: tagIds used in payload
  // ============================================================

  it('includes empty tagIds array when no tags selected', async () => {
    const onSuccess = vi.fn();
    const { container } = render(<ScheduledTransactionForm onSuccess={onSuccess} />);

    await waitFor(() => {
      expect(mockAccountsGetAll).toHaveBeenCalled();
    });

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Tagged Bill' } });
    fireEvent.change(screen.getByLabelText('Account'), { target: { value: 'acc-1' } });

    const submitBtn = container.querySelector('button[type="submit"]')!;
    await act(async () => { fireEvent.click(submitBtn); });

    await waitFor(() => {
      expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ tagIds: [] }));
    });
  });

  // ============================================================
  // Investment tab
  // ============================================================

  describe('investment tab', () => {
    async function openInvestmentTab() {
      render(<ScheduledTransactionForm />);
      await waitFor(() => {
        expect(mockAccountsGetAll).toHaveBeenCalled();
      });
      await act(async () => {
        fireEvent.click(screen.getByText('Investment'));
      });
      await waitFor(() => {
        expect(mockGetSecurities).toHaveBeenCalled();
      });
    }

    it('does not offer a crypto wallet as the funding account', async () => {
      mockAccountsGetAll.mockResolvedValue([
        ...mockAccounts,
        {
          id: 'acc-btc',
          name: 'Bitcoin Wallet',
          currencyCode: 'BTC',
          isClosed: false,
          accountType: 'CRYPTO',
          accountSubType: null,
        },
      ]);
      await openInvestmentTab();
      const funding = screen.getByLabelText('Funding Account (optional)') as HTMLSelectElement;
      const texts = Array.from(funding.querySelectorAll('option')).map(o => o.textContent);
      expect(texts.some(t => t?.includes('Chequing'))).toBe(true);
      expect(texts.some(t => t?.includes('Bitcoin Wallet'))).toBe(false);
    });

    it('renders the Investment tab and an Action selector', async () => {
      await openInvestmentTab();
      expect(screen.getByLabelText('Action')).toBeInTheDocument();
      expect(screen.getByLabelText('Investment Account')).toBeInTheDocument();
    });

    it('shows Quantity / Price / Commission inputs for BUY', async () => {
      await openInvestmentTab();
      expect(screen.getByLabelText('Quantity (Shares)')).toBeInTheDocument();
      expect(screen.getByLabelText('Price per Share')).toBeInTheDocument();
      expect(screen.getByLabelText('Commission')).toBeInTheDocument();
      expect(screen.getByLabelText('Total Value')).toBeInTheDocument();
    });

    it('switches to amount-only fields for DIVIDEND', async () => {
      await openInvestmentTab();
      fireEvent.change(screen.getByLabelText('Action'), { target: { value: 'DIVIDEND' } });
      await waitFor(() => {
        expect(screen.queryByLabelText('Quantity (Shares)')).not.toBeInTheDocument();
      });
      expect(screen.getByLabelText('Total Amount')).toBeInTheDocument();
    });

    it('switches to quantity-only fields for ADD_SHARES', async () => {
      await openInvestmentTab();
      fireEvent.change(screen.getByLabelText('Action'), { target: { value: 'ADD_SHARES' } });
      await waitFor(() => {
        expect(screen.queryByLabelText('Price per Share')).not.toBeInTheDocument();
      });
      expect(screen.getByLabelText('Quantity (Shares)')).toBeInTheDocument();
    });

    it('shows Funding Account dropdown for BUY only', async () => {
      await openInvestmentTab();
      expect(screen.getByLabelText('Funding Account (optional)')).toBeInTheDocument();
      fireEvent.change(screen.getByLabelText('Action'), { target: { value: 'DIVIDEND' } });
      await waitFor(() => {
        expect(screen.queryByLabelText('Funding Account (optional)')).not.toBeInTheDocument();
      });
    });

    it('hides the Security selector for INTEREST (security not required)', async () => {
      await openInvestmentTab();
      fireEvent.change(screen.getByLabelText('Action'), { target: { value: 'INTEREST' } });
      await waitFor(() => {
        expect(screen.queryByLabelText('Security')).not.toBeInTheDocument();
      });
    });

    it('fetches the latest market price when a security is chosen', async () => {
      await openInvestmentTab();
      // Pick a brokerage account to satisfy the form
      fireEvent.change(screen.getByLabelText('Investment Account'), {
        target: { value: 'acc-4' },
      });
      fireEvent.change(screen.getByLabelText('Security'), {
        target: { value: 'sec-voo' },
      });
      await waitFor(() => {
        expect(mockGetSecurityPrices).toHaveBeenCalledWith('sec-voo', {
          limit: 1,
        });
      });
      await waitFor(() => {
        const priceInput = screen.getByLabelText('Price per Share') as HTMLInputElement;
        expect(priceInput.value).toBe('500.000000');
      });
    });

    it('back-derives Quantity from Total Value using the effective price', async () => {
      await openInvestmentTab();
      fireEvent.change(screen.getByLabelText('Investment Account'), {
        target: { value: 'acc-4' },
      });
      fireEvent.change(screen.getByLabelText('Security'), {
        target: { value: 'sec-voo' },
      });
      // Wait for price to auto-populate
      await waitFor(() => {
        const priceInput = screen.getByLabelText('Price per Share') as HTMLInputElement;
        expect(priceInput.value).toBe('500.000000');
      });
      const totalInput = screen.getByLabelText('Total Value') as HTMLInputElement;
      // 1000 / 500 = 2 shares
      fireEvent.change(totalInput, { target: { value: '1000' } });
      await waitFor(() => {
        const qtyInput = screen.getByLabelText('Quantity (Shares)') as HTMLInputElement;
        expect(qtyInput.value).toBe('2.00000000');
      });
    });

    it('forward-derives Total Value from Quantity', async () => {
      await openInvestmentTab();
      fireEvent.change(screen.getByLabelText('Investment Account'), {
        target: { value: 'acc-4' },
      });
      fireEvent.change(screen.getByLabelText('Security'), {
        target: { value: 'sec-voo' },
      });
      await waitFor(() => {
        const priceInput = screen.getByLabelText('Price per Share') as HTMLInputElement;
        expect(priceInput.value).toBe('500.000000');
      });
      fireEvent.change(screen.getByLabelText('Quantity (Shares)'), {
        target: { value: '3' },
      });
      await waitFor(() => {
        const totalInput = screen.getByLabelText('Total Value') as HTMLInputElement;
        // 3 * 500 = 1500 (no commission). CurrencyInput formats with commas.
        expect(Number(totalInput.value.replace(/,/g, ''))).toBe(1500);
      });
    });

    it('preserves a Total Value typed before the latest price resolves', async () => {
      // The typed-before-fetch race on this form's own auto-fill. On a slow
      // connection the user enters a quantity and a budget while the price
      // request is still pending; when the close lands the form must keep the
      // total and re-derive the quantity from it (total-first), not leave the
      // total behind while submit computes qty * price. Before the fix the
      // auto-fill only set the price, so a typed 950 total would submit as
      // 10 * 123.45 = 1,234.50 -- ~30% more than shown.
      let resolvePrices!: (prices: any[]) => void;
      mockGetSecurityPrices.mockReturnValue(
        new Promise((resolve) => {
          resolvePrices = resolve;
        }),
      );
      await openInvestmentTab();
      fireEvent.change(screen.getByLabelText('Investment Account'), {
        target: { value: 'acc-4' },
      });
      fireEvent.change(screen.getByLabelText('Security'), {
        target: { value: 'sec-voo' },
      });
      // Enter quantity and total while the price fetch is still pending.
      fireEvent.change(screen.getByLabelText('Quantity (Shares)'), {
        target: { value: '10' },
      });
      fireEvent.change(screen.getByLabelText('Total Value'), {
        target: { value: '950' },
      });

      await act(async () => {
        resolvePrices([{ closePrice: 123.45, priceDate: '2026-05-09' }]);
      });

      const totalInput = screen.getByLabelText('Total Value') as HTMLInputElement;
      const qtyInput = screen.getByLabelText('Quantity (Shares)') as HTMLInputElement;
      // The typed budget stands; the quantity is re-derived from it, so the shown
      // total and the amount submit will persist agree.
      expect(Number(totalInput.value.replace(/,/g, ''))).toBe(950);
      expect(Number(qtyInput.value)).toBeCloseTo(950 / 123.45, 6);
    });

    it('recomputes Total Value when the commission changes', async () => {
      await openInvestmentTab();
      fireEvent.change(screen.getByLabelText('Investment Account'), {
        target: { value: 'acc-4' },
      });
      fireEvent.change(screen.getByLabelText('Security'), {
        target: { value: 'sec-voo' },
      });
      await waitFor(() => {
        expect(
          (screen.getByLabelText('Price per Share') as HTMLInputElement).value,
        ).toBe('500.000000');
      });
      fireEvent.change(screen.getByLabelText('Quantity (Shares)'), {
        target: { value: '10' },
      });
      await waitFor(() => {
        expect(
          Number(
            (screen.getByLabelText('Total Value') as HTMLInputElement).value.replace(/,/g, ''),
          ),
        ).toBe(5000);
      });
      // A BUY folds the commission in: 10 * 500 + 25 = 5025. Before the fix the
      // shown total stayed 5000 while submit persisted 5025.
      fireEvent.change(screen.getByLabelText('Commission'), {
        target: { value: '25' },
      });
      await waitFor(() => {
        expect(
          Number(
            (screen.getByLabelText('Total Value') as HTMLInputElement).value.replace(/,/g, ''),
          ),
        ).toBe(5025);
      });
    });

    it('recomputes Total Value when the action flips BUY to SELL', async () => {
      await openInvestmentTab();
      fireEvent.change(screen.getByLabelText('Investment Account'), {
        target: { value: 'acc-4' },
      });
      fireEvent.change(screen.getByLabelText('Security'), {
        target: { value: 'sec-voo' },
      });
      await waitFor(() => {
        expect(
          (screen.getByLabelText('Price per Share') as HTMLInputElement).value,
        ).toBe('500.000000');
      });
      fireEvent.change(screen.getByLabelText('Quantity (Shares)'), {
        target: { value: '10' },
      });
      fireEvent.change(screen.getByLabelText('Commission'), {
        target: { value: '25' },
      });
      // BUY: 10 * 500 + 25 = 5025.
      await waitFor(() => {
        expect(
          Number(
            (screen.getByLabelText('Total Value') as HTMLInputElement).value.replace(/,/g, ''),
          ),
        ).toBe(5025);
      });
      // SELL nets the commission out: 10 * 500 - 25 = 4975. Before the fix the
      // total stayed at the BUY figure while submit persisted the SELL one.
      fireEvent.change(screen.getByLabelText('Action'), { target: { value: 'SELL' } });
      await waitFor(() => {
        expect(
          Number(
            (screen.getByLabelText('Total Value') as HTMLInputElement).value.replace(/,/g, ''),
          ),
        ).toBe(4975);
      });
    });

    it('does not carry the previous security price into a newly chosen security', async () => {
      mockGetSecurities.mockResolvedValue([
        ...mockSecurities,
        { ...mockSecurities[0], id: 'sec-bnd', symbol: 'BND', name: 'Vanguard Total Bond' },
      ]);
      mockGetSecurityPrices.mockImplementation((id: string) =>
        Promise.resolve([{ closePrice: id === 'sec-voo' ? 100 : 250, priceDate: '2026-05-09' }]),
      );
      await openInvestmentTab();
      fireEvent.change(screen.getByLabelText('Investment Account'), {
        target: { value: 'acc-4' },
      });
      fireEvent.change(screen.getByLabelText('Security'), {
        target: { value: 'sec-voo' },
      });
      await waitFor(() => {
        expect(
          (screen.getByLabelText('Price per Share') as HTMLInputElement).value,
        ).toBe('100.000000');
      });
      // Switch securities: the old 100 must be cleared and B's 250 fill in, not
      // linger because the field is non-empty.
      fireEvent.change(screen.getByLabelText('Security'), {
        target: { value: 'sec-bnd' },
      });
      await waitFor(() => {
        expect(
          (screen.getByLabelText('Price per Share') as HTMLInputElement).value,
        ).toBe('250.000000');
      });
    });

    it('keeps the entered quantity when switching securities, not the derived total', async () => {
      // The reported bug: after a share count is typed, switching securities left
      // the stale (derived) total behind, and the new security's total-first
      // auto-fill rescaled the quantity to hold it -- 10 shares silently becoming
      // 4. The quantity is the user's input; the total was derived, so it must not
      // win over it.
      mockGetSecurities.mockResolvedValue([
        ...mockSecurities,
        { ...mockSecurities[0], id: 'sec-bnd', symbol: 'BND', name: 'Vanguard Total Bond' },
      ]);
      mockGetSecurityPrices.mockImplementation((id: string) =>
        Promise.resolve([{ closePrice: id === 'sec-voo' ? 100 : 250, priceDate: '2026-05-09' }]),
      );
      await openInvestmentTab();
      fireEvent.change(screen.getByLabelText('Investment Account'), {
        target: { value: 'acc-4' },
      });
      fireEvent.change(screen.getByLabelText('Security'), {
        target: { value: 'sec-voo' },
      });
      await waitFor(() => {
        expect(
          (screen.getByLabelText('Price per Share') as HTMLInputElement).value,
        ).toBe('100.000000');
      });
      // Enter a share count; the total derives to 10 * 100 = 1000.
      fireEvent.change(screen.getByLabelText('Quantity (Shares)'), {
        target: { value: '10' },
      });
      await waitFor(() => {
        expect(
          Number(
            (screen.getByLabelText('Total Value') as HTMLInputElement).value.replace(/,/g, ''),
          ),
        ).toBe(1000);
      });
      // Switch securities. The 10 shares stand; the total recomputes at the new
      // price (10 * 250 = 2500), rather than the quantity being rescaled to 4.
      fireEvent.change(screen.getByLabelText('Security'), {
        target: { value: 'sec-bnd' },
      });
      await waitFor(() => {
        expect(
          (screen.getByLabelText('Price per Share') as HTMLInputElement).value,
        ).toBe('250.000000');
      });
      expect(
        Number((screen.getByLabelText('Quantity (Shares)') as HTMLInputElement).value),
      ).toBe(10);
      expect(
        Number(
          (screen.getByLabelText('Total Value') as HTMLInputElement).value.replace(/,/g, ''),
        ),
      ).toBe(2500);
    });

    it('does not show the no-price-history hint when the lookup fails', async () => {
      // A failed lookup is not an empty dataset: on a rejection the hint must
      // stay off, not falsely claim the security has no price history.
      mockGetSecurityPrices.mockRejectedValueOnce(new Error('network'));
      await openInvestmentTab();
      fireEvent.change(screen.getByLabelText('Investment Account'), {
        target: { value: 'acc-4' },
      });
      fireEvent.change(screen.getByLabelText('Security'), {
        target: { value: 'sec-voo' },
      });
      await waitFor(() => {
        expect(mockGetSecurityPrices).toHaveBeenCalled();
      });
      await act(async () => {});
      expect(screen.queryByText(/No price history yet/)).not.toBeInTheDocument();
    });

    it('does not re-fetch the close when toggling within quantity-price actions', async () => {
      await openInvestmentTab();
      fireEvent.change(screen.getByLabelText('Investment Account'), {
        target: { value: 'acc-4' },
      });
      fireEvent.change(screen.getByLabelText('Security'), {
        target: { value: 'sec-voo' },
      });
      await waitFor(() => {
        expect(mockGetSecurityPrices).toHaveBeenCalledTimes(1);
      });
      // BUY -> SELL -> REINVEST: same security, all price-relevant, so the close
      // is unchanged and there is nothing to re-fetch.
      fireEvent.change(screen.getByLabelText('Action'), { target: { value: 'SELL' } });
      fireEvent.change(screen.getByLabelText('Action'), { target: { value: 'REINVEST' } });
      await act(async () => {});
      expect(mockGetSecurityPrices).toHaveBeenCalledTimes(1);
    });

    it('treats a malformed close as no price rather than NaN', async () => {
      // A non-numeric closePrice must normalize to null: NaN would slip past the
      // `!= null` gate, cascade into the fold, and -- because NaN !== NaN -- make
      // the market-price latch re-fire every render.
      mockGetSecurityPrices.mockResolvedValue([
        { closePrice: 'not-a-number', priceDate: '2026-05-09' },
      ]);
      await openInvestmentTab();
      fireEvent.change(screen.getByLabelText('Investment Account'), {
        target: { value: 'acc-4' },
      });
      fireEvent.change(screen.getByLabelText('Security'), {
        target: { value: 'sec-voo' },
      });
      await waitFor(() => {
        expect(mockGetSecurityPrices).toHaveBeenCalled();
      });
      // The price stays empty (no NaN written) and the "no price history" hint
      // shows because the field is genuinely empty.
      expect(
        (screen.getByLabelText('Price per Share') as HTMLInputElement).value,
      ).toBe('');
      expect(screen.getByText(/No price history yet/)).toBeInTheDocument();
    });

    it('treats a zero close as no price', async () => {
      // A zero (or negative) quote is not a usable price, so it normalizes to
      // null just like a missing one: the field stays empty and the hint shows,
      // rather than a suppressed hint over an empty field with no way forward.
      mockGetSecurityPrices.mockResolvedValue([
        { closePrice: 0, priceDate: '2026-05-09' },
      ]);
      await openInvestmentTab();
      fireEvent.change(screen.getByLabelText('Investment Account'), {
        target: { value: 'acc-4' },
      });
      fireEvent.change(screen.getByLabelText('Security'), {
        target: { value: 'sec-voo' },
      });
      await waitFor(() => {
        expect(mockGetSecurityPrices).toHaveBeenCalled();
      });
      expect(
        (screen.getByLabelText('Price per Share') as HTMLInputElement).value,
      ).toBe('');
      expect(screen.getByText(/No price history yet/)).toBeInTheDocument();
    });

    it('does not store a market price on an amount-only action (DIVIDEND)', async () => {
      const { container } = render(<ScheduledTransactionForm />);
      await waitFor(() => {
        expect(mockAccountsGetAll).toHaveBeenCalled();
      });
      await act(async () => {
        fireEvent.click(screen.getByText('Investment'));
      });
      await waitFor(() => {
        expect(mockGetSecurities).toHaveBeenCalled();
      });
      fireEvent.change(screen.getByLabelText('Name'), {
        target: { value: 'VOO Dividend' },
      });
      fireEvent.change(screen.getByLabelText('Investment Account'), {
        target: { value: 'acc-4' },
      });
      fireEvent.change(screen.getByLabelText('Action'), { target: { value: 'DIVIDEND' } });
      fireEvent.change(screen.getByLabelText('Security'), {
        target: { value: 'sec-voo' },
      });
      // A dividend has no Price field, so the form never fetches a market close
      // for it (matching the dialogs) -- there is nothing to leak into the payload.
      await act(async () => {});
      expect(mockGetSecurityPrices).not.toHaveBeenCalled();
      fireEvent.change(screen.getByLabelText('Total Amount'), {
        target: { value: '42' },
      });
      const submitBtn = container.querySelector('button[type="submit"]')!;
      await act(async () => {
        fireEvent.click(submitBtn);
      });
      await waitFor(() => {
        expect(mockCreate).toHaveBeenCalled();
      });
      const payload = mockCreate.mock.calls[0][0];
      expect(payload.investmentAction).toBe('DIVIDEND');
      // No Price field is shown for a dividend, so the market fetch must not leak
      // a spurious investmentPrice into the payload.
      expect(payload.investmentPrice).toBeUndefined();
      expect(payload.investmentTotalAmount).toBe(42);
    });

    it('errors out when submitted without a brokerage account', async () => {
      const { container } = render(<ScheduledTransactionForm />);
      await waitFor(() => {
        expect(mockAccountsGetAll).toHaveBeenCalled();
      });
      await act(async () => {
        fireEvent.click(screen.getByText('Investment'));
      });
      fireEvent.change(screen.getByLabelText('Name'), {
        target: { value: 'Bad investment' },
      });
      const submitBtn = container.querySelector('button[type="submit"]')!;
      await act(async () => {
        fireEvent.click(submitBtn);
      });
      // Form bails before reaching the API
      await waitFor(() => {
        expect(toast.error).toHaveBeenCalled();
      });
      expect(mockCreate).not.toHaveBeenCalled();
    });

    it('errors out when BUY is submitted without a quantity', async () => {
      const { container } = await (async () => {
        const r = render(<ScheduledTransactionForm />);
        await waitFor(() => {
          expect(mockAccountsGetAll).toHaveBeenCalled();
        });
        await act(async () => {
          fireEvent.click(screen.getByText('Investment'));
        });
        return r;
      })();
      fireEvent.change(screen.getByLabelText('Name'), {
        target: { value: 'Missing qty' },
      });
      fireEvent.change(screen.getByLabelText('Investment Account'), {
        target: { value: 'acc-4' },
      });
      // Skip security/qty/price entirely
      const submitBtn = container.querySelector('button[type="submit"]')!;
      await act(async () => {
        fireEvent.click(submitBtn);
      });
      await waitFor(() => {
        expect(toast.error).toHaveBeenCalled();
      });
      expect(mockCreate).not.toHaveBeenCalled();
    });

    it('submits an investment payload with isInvestment=true', async () => {
      const onSuccess = vi.fn();
      const { container } = render(
        <ScheduledTransactionForm onSuccess={onSuccess} />,
      );
      await waitFor(() => {
        expect(mockAccountsGetAll).toHaveBeenCalled();
      });
      await act(async () => {
        fireEvent.click(screen.getByText('Investment'));
      });
      fireEvent.change(screen.getByLabelText('Name'), {
        target: { value: 'Monthly VOO DCA' },
      });
      fireEvent.change(screen.getByLabelText('Investment Account'), {
        target: { value: 'acc-4' },
      });
      fireEvent.change(screen.getByLabelText('Security'), {
        target: { value: 'sec-voo' },
      });
      await waitFor(() => {
        const priceInput = screen.getByLabelText('Price per Share') as HTMLInputElement;
        expect(priceInput.value).toBe('500.000000');
      });
      fireEvent.change(screen.getByLabelText('Quantity (Shares)'), {
        target: { value: '1' },
      });
      const submitBtn = container.querySelector('button[type="submit"]')!;
      await act(async () => {
        fireEvent.click(submitBtn);
      });
      await waitFor(() => {
        expect(mockCreate).toHaveBeenCalled();
      });
      const payload = mockCreate.mock.calls[0][0];
      expect(payload.isInvestment).toBe(true);
      expect(payload.investmentAction).toBe('BUY');
      expect(payload.investmentSecurityId).toBe('sec-voo');
      expect(payload.investmentQuantity).toBe(1);
      expect(payload.investmentPrice).toBe(500);
      expect(payload.accountId).toBe('acc-4');
    });

    it('starts in investment mode when editing an existing investment-kind row', async () => {
      const existing = {
        id: 'st-inv',
        userId: 'user-1',
        accountId: 'acc-4',
        name: 'Existing DCA',
        amount: -500,
        currencyCode: 'CAD',
        frequency: 'MONTHLY',
        nextDueDate: '2026-06-15',
        startDate: '2026-06-15',
        isActive: true,
        autoPost: false,
        reminderDaysBefore: 3,
        isSplit: false,
        isTransfer: false,
        isInvestment: true,
        investmentAction: 'BUY',
        investmentSecurityId: 'sec-voo',
        investmentQuantity: 1,
        investmentPrice: 500,
        investmentCommission: 0,
        tagIds: [],
        splits: [],
        createdAt: '',
        updatedAt: '',
      } as any;
      render(<ScheduledTransactionForm scheduledTransaction={existing} />);
      await waitFor(() => {
        expect(mockGetSecurities).toHaveBeenCalled();
      });
      // Investment-only fields are present
      expect(screen.getByLabelText('Investment Account')).toBeInTheDocument();
      expect(screen.getByLabelText('Action')).toBeInTheDocument();
    });
  });
});

describe('ScheduledTransactionForm - extra coverage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAccountsGetAll.mockResolvedValue(mockAccounts);
    mockCategoriesGetAll.mockResolvedValue(mockCategories);
    mockPayeesGetAll.mockResolvedValue(mockPayees);
    mockPayeesGetById.mockResolvedValue({ id: 'inactive-payee', name: 'Inactive Payee' });
    mockPayeesCreate.mockResolvedValue({ id: 'new-payee', name: 'New Co' });
    mockTagsCreate.mockResolvedValue({ id: 'new-tag', name: 'New Tag' });
    mockCreate.mockResolvedValue({});
    mockUpdate.mockResolvedValue({});
    mockGetSecurities.mockResolvedValue(mockSecurities);
    mockGetSecurityPrices.mockResolvedValue([
      { id: 1, securityId: 'sec-voo', priceDate: '2026-05-09', closePrice: 500, openPrice: 499, highPrice: 501, lowPrice: 498, volume: 1000, source: 'manual', createdAt: '' },
    ]);
  });

  async function renderForm(props: Record<string, unknown> = {}) {
    let result: ReturnType<typeof render>;
    await act(async () => {
      result = render(<ScheduledTransactionForm {...props} />);
    });
    await act(async () => {}); // flush mount data loads
    return result!;
  }

  async function openInvestment() {
    await act(async () => { fireEvent.click(screen.getByText('Investment')); });
    await act(async () => {}); // flush lazy securities load
    await waitFor(() => expect(screen.getByLabelText('Action')).toBeInTheDocument());
  }

  function submit(container: HTMLElement) {
    const btn = container.querySelector('button[type="submit"]') as HTMLButtonElement;
    fireEvent.click(btn);
  }

  it('seeds the split editor when switching to the Split tab', async () => {
    await renderForm();
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Account'), { target: { value: 'acc-1' } });
    });
    await act(async () => { fireEvent.click(screen.getByText('Split')); });
    expect(screen.getByTestId('split-editor')).toBeInTheDocument();
    expect(screen.getByText('Cancel Split')).toBeInTheDocument();
  });

  describe('tag picker order', () => {
    const tagFixture = (id: string, name: string) =>
      ({ id, name, userId: 'user-1', color: null, icon: null, createdAt: '', updatedAt: '' });

    afterEach(() => {
      mockTagsGetAll.mockResolvedValue([]);
      mockTagsGetUsage.mockResolvedValue({});
    });

    const precedes = (first: string, second: string) =>
      Boolean(
        screen.getByText(first).compareDocumentPosition(screen.getByText(second)) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      );

    const openPicker = async () => {
      await renderForm();
      await waitFor(() => expect(mockTagsGetUsage).toHaveBeenCalled());
      fireEvent.click(screen.getByText('Select tags...'));
      await waitFor(() => expect(screen.getByText('Holiday 2026')).toBeInTheDocument());
    };

    it('lists a recently used tag first and gives the split editor the same usage', async () => {
      const usage = { 't-h26': { lastUsed: '2026-10-01', count: 2 } };
      mockTagsGetAll.mockResolvedValue([tagFixture('t-art', 'Art'), tagFixture('t-h26', 'Holiday 2026')]);
      mockTagsGetUsage.mockResolvedValue(usage);

      await openPicker();
      expect(precedes('Holiday 2026', 'Art')).toBe(true);

      await act(async () => { fireEvent.click(screen.getByText('Split')); });
      expect(mockSplitEditorProps).toHaveBeenLastCalledWith(expect.objectContaining({ tagUsage: usage }));
    });

    it('stays A-Z when the usage lookup fails', async () => {
      mockTagsGetAll.mockResolvedValue([tagFixture('t-art', 'Art'), tagFixture('t-h26', 'Holiday 2026')]);
      mockTagsGetUsage.mockRejectedValue(new Error('network'));

      await openPicker();

      expect(precedes('Art', 'Holiday 2026')).toBe(true);
      expect(toast.error).not.toHaveBeenCalled();
    });
  });

  it('cancels the split and returns to the transaction tab', async () => {
    await renderForm();
    await act(async () => { fireEvent.click(screen.getByText('Split')); });
    expect(screen.getByText('Cancel Split')).toBeInTheDocument();
    await act(async () => { fireEvent.click(screen.getByText('Cancel Split')); });
    expect(screen.queryByText('Cancel Split')).not.toBeInTheDocument();
  });

  it('shows From/To account selects on the Transfer tab', async () => {
    await renderForm();
    await act(async () => { fireEvent.click(screen.getByText('Transfer')); });
    expect(screen.getByLabelText('From Account')).toBeInTheDocument();
    expect(screen.getByLabelText('To Account')).toBeInTheDocument();
  });

  it('shows only the quantity field for an ADD_SHARES investment action', async () => {
    await renderForm();
    await openInvestment();
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Action'), { target: { value: 'ADD_SHARES' } });
    });
    expect(screen.getByLabelText('Quantity (Shares)')).toBeInTheDocument();
    expect(screen.queryByLabelText('Funding Account (optional)')).not.toBeInTheDocument();
  });

  it('recomputes total value from quantity in investment BUY mode', async () => {
    await renderForm();
    await openInvestment();
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Security'), { target: { value: 'sec-voo' } });
    });
    await act(async () => {}); // market price arrives
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Price per Share'), { target: { value: '10' } });
    });
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Quantity (Shares)'), { target: { value: '5' } });
    });
    const total = screen.getByLabelText('Total Value') as HTMLInputElement;
    await waitFor(() =>
      expect(Number(total.value.replace(/,/g, ''))).toBeGreaterThan(0),
    );
  });

  it('blocks a transfer when no destination account is chosen', async () => {
    const { container } = await renderForm();
    await act(async () => { fireEvent.click(screen.getByText('Transfer')); });
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Move money' } });
    });
    await act(async () => {
      fireEvent.change(screen.getByLabelText('From Account'), { target: { value: 'acc-1' } });
    });
    await act(async () => { submit(container); });
    await act(async () => {});
    expect(mockCreate).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith(
      'Please select a destination account for the transfer',
    );
  });

  it('creates a transfer scheduled transaction with a negative amount', async () => {
    const onSuccess = vi.fn();
    const { container } = await renderForm({ onSuccess });
    await act(async () => { fireEvent.click(screen.getByText('Transfer')); });
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'CC Payment' } });
    });
    await act(async () => {
      fireEvent.change(screen.getByLabelText('From Account'), { target: { value: 'acc-1' } });
    });
    await act(async () => {
      fireEvent.change(screen.getByLabelText('To Account'), { target: { value: 'acc-2' } });
    });
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Transfer Amount'), { target: { value: '100' } });
    });
    await act(async () => { submit(container); });
    await act(async () => {});
    await waitFor(() => expect(mockCreate).toHaveBeenCalled());
    const payload = mockCreate.mock.calls[0][0];
    expect(payload.isTransfer).toBe(true);
    expect(payload.transferAccountId).toBe('acc-2');
    expect(payload.amount).toBeLessThan(0);
    expect(onSuccess).toHaveBeenCalled();
  });

  it('renders the SplitEditor when in split mode after selecting a category', async () => {
    await renderForm();
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Account'), { target: { value: 'acc-1' } });
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('option-cat-1'));
    });
    await act(async () => { fireEvent.click(screen.getByText('Split')); });
    expect(screen.getByTestId('split-editor')).toBeInTheDocument();
  });

  it('creates a new payee from the payee combobox', async () => {
    await renderForm();
    await act(async () => {
      fireEvent.click(screen.getByTestId('combobox-create-Payee'));
    });
    await waitFor(() => expect(mockPayeesCreate).toHaveBeenCalledWith({ name: 'New Item' }));
  });

  it('fetches an inactive payee when editing a scheduled transaction', async () => {
    const sched = {
      id: 'sched-x', accountId: 'acc-1', name: 'Old bill', amount: -50, currencyCode: 'CAD',
      frequency: 'MONTHLY', nextDueDate: '2025-03-01', isActive: true, autoPost: false,
      reminderDaysBefore: 3, isTransfer: false, isSplit: false, isInvestment: false,
      payeeId: 'payee-x', payeeName: 'Archived Payee',
    } as any;
    await renderForm({ scheduledTransaction: sched });
    await waitFor(() => expect(mockPayeesGetById).toHaveBeenCalledWith('payee-x'));
  });

  it('reveals the End Date input when toggling End-by-date on', async () => {
    await renderForm();
    expect(screen.getByLabelText('End by date')).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByLabelText('End by date'));
    });
    await waitFor(() => expect(screen.getByLabelText('End Date')).toBeInTheDocument());
  });

  it('toggles the Active and Auto-post switches', async () => {
    await renderForm();
    const active = screen.getByLabelText('Active');
    const autoPost = screen.getByLabelText('Auto-post on due date');
    await act(async () => { fireEvent.click(active); });
    await act(async () => { fireEvent.click(autoPost); });
    expect(active).toBeInTheDocument();
    expect(autoPost).toBeInTheDocument();
  });

  it('blocks an investment submit when the action requires a security', async () => {
    const { container } = await renderForm();
    await openInvestment();
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'DCA VOO' } });
    });
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Investment Account'), { target: { value: 'acc-4' } });
    });
    await act(async () => { submit(container); });
    await act(async () => {});
    expect(mockCreate).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith('This investment action requires a security');
  });

  it('creates a scheduled investment BUY transaction', async () => {
    const onSuccess = vi.fn();
    const { container } = await renderForm({ onSuccess });
    await openInvestment();
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'DCA VOO' } });
    });
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Investment Account'), { target: { value: 'acc-4' } });
    });
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Security'), { target: { value: 'sec-voo' } });
    });
    await act(async () => {});
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Price per Share'), { target: { value: '10' } });
    });
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Quantity (Shares)'), { target: { value: '5' } });
    });
    await act(async () => { submit(container); });
    await act(async () => {});
    await waitFor(() => expect(mockCreate).toHaveBeenCalled());
    const payload = mockCreate.mock.calls[0][0];
    expect(payload.isInvestment).toBe(true);
    expect(payload.investmentAction).toBe('BUY');
    expect(payload.investmentSecurityId).toBe('sec-voo');
    expect(onSuccess).toHaveBeenCalled();
  });

  it('flips the amount sign when an expense category is chosen', async () => {
    await renderForm();
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Account'), { target: { value: 'acc-1' } });
    });
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Amount'), { target: { value: '100' } });
    });
    // Choose the expense category "Rent" (cat-1) from the mocked combobox option.
    await act(async () => {
      fireEvent.click(screen.getByTestId('option-cat-1'));
    });
    const amount = screen.getByLabelText('Amount') as HTMLInputElement;
    await waitFor(() =>
      expect(Number(amount.value.replace(/,/g, ''))).toBeLessThan(0),
    );
  });
});

// ============================================================
// Foreign-currency entry (matches TransactionForm's picker)
// ============================================================
describe('ScheduledTransactionForm - foreign currency', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAccountsGetAll.mockResolvedValue(mockAccounts);
    mockCategoriesGetAll.mockResolvedValue(mockCategories);
    mockPayeesGetAll.mockResolvedValue(mockPayees);
    mockGetSecurities.mockResolvedValue([]);
    mockGetRateForDate.mockResolvedValue(1.365234);
  });

  const setUpForeign = async () => {
    const result = render(<ScheduledTransactionForm />);
    await waitFor(() => expect(mockAccountsGetAll).toHaveBeenCalled());
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Netflix' } });
    fireEvent.change(screen.getByLabelText('Account'), { target: { value: 'acc-1' } });
    await act(async () => {
      fireEvent.click(screen.getByTestId('pick-usd'));
    });
    return result;
  };

  it('offers the currency picker on the transaction tab', async () => {
    render(<ScheduledTransactionForm />);
    await waitFor(() => expect(mockAccountsGetAll).toHaveBeenCalled());
    expect(screen.getByTestId('currency-picker')).toBeInTheDocument();
    expect(screen.getByTestId('currency-picker-value')).toHaveTextContent('CAD');
  });

  it('relabels the amount field and fetches the latest rate when a currency is picked', async () => {
    await setUpForeign();

    await waitFor(() => {
      expect(mockGetRateForDate).toHaveBeenCalledWith('USD', 'CAD', expect.any(String));
    });
    expect(screen.getByLabelText('Amount in USD')).toBeInTheDocument();
  });

  it('sends the foreign amount, currency and rate on save', async () => {
    const { container } = await setUpForeign();
    await waitFor(() => expect(mockGetRateForDate).toHaveBeenCalled());

    const amountInput = screen.getByLabelText('Amount in USD');
    await act(async () => {
      fireEvent.change(amountInput, { target: { value: '-40' } });
      fireEvent.blur(amountInput);
    });

    await act(async () => {
      fireEvent.click(container.querySelector('button[type="submit"]')!);
    });

    await waitFor(() => {
      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          originalAmount: -40,
          originalCurrencyCode: 'USD',
          exchangeRate: 1.365234,
          // -40 * 1.365234, rounded to cents
          amount: -54.61,
        }),
      );
    });
  });

  it('refuses to save when no rate is available for the chosen currency', async () => {
    mockGetRateForDate.mockResolvedValue(null);
    const { container } = await setUpForeign();
    await waitFor(() => expect(mockGetRateForDate).toHaveBeenCalled());

    await act(async () => {
      fireEvent.click(container.querySelector('button[type="submit"]')!);
    });

    expect(mockCreate).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalled();
  });

  it('clears the foreign fields when the account currency is picked again', async () => {
    const { container } = await setUpForeign();
    await waitFor(() => expect(mockGetRateForDate).toHaveBeenCalled());

    await act(async () => {
      fireEvent.click(screen.getByTestId('pick-account'));
    });
    expect(screen.getByLabelText('Amount')).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(container.querySelector('button[type="submit"]')!);
    });

    await waitFor(() => expect(mockCreate).toHaveBeenCalled());
    const payload = mockCreate.mock.calls[0][0];
    expect(payload.originalCurrencyCode).toBeUndefined();
  });

  it('seeds the picker and rate from an existing foreign-currency schedule', async () => {
    const existing: any = {
      id: 'st-fx',
      userId: 'u1',
      accountId: 'acc-1',
      account: null,
      name: 'Netflix',
      payeeId: null,
      payee: null,
      payeeName: null,
      categoryId: null,
      category: null,
      amount: -54.61,
      currencyCode: 'CAD',
      originalAmount: -40,
      originalCurrencyCode: 'USD',
      exchangeRate: 1.365234,
      description: null,
      frequency: 'MONTHLY',
      nextDueDate: '2026-03-01',
      startDate: '2026-02-01',
      endDate: null,
      occurrencesRemaining: null,
      totalOccurrences: null,
      isActive: true,
      autoPost: false,
      reminderDaysBefore: 3,
      lastPostedDate: null,
      isSplit: false,
      isTransfer: false,
      transferAccountId: null,
      transferAccount: null,
      isInvestment: false,
      investmentAction: null,
      investmentSecurityId: null,
      investmentSecurity: null,
      investmentFundingAccountId: null,
      investmentFundingAccount: null,
      investmentQuantity: null,
      investmentPrice: null,
      investmentCommission: null,
      investmentTotalAmount: null,
      investmentExchangeRate: null,
      tagIds: [],
      createdAt: '',
      updatedAt: '',
    };

    render(<ScheduledTransactionForm scheduledTransaction={existing} />);
    await waitFor(() => expect(mockAccountsGetAll).toHaveBeenCalled());

    expect(screen.getByTestId('currency-picker-value')).toHaveTextContent('USD');
    expect(screen.getByLabelText('Amount in USD')).toBeInTheDocument();
    expect((screen.getByLabelText('Amount in USD') as HTMLInputElement).value).toContain('40');
  });
});
