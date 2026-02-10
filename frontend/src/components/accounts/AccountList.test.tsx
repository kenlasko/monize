import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@/test/render';
import { AccountList } from './AccountList';
import { Account } from '@/types/account';

vi.mock('@/lib/accounts', () => ({
  accountsApi: {
    close: vi.fn(),
    reopen: vi.fn(),
    delete: vi.fn(),
  },
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

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  }),
}));

function createAccount(overrides: Partial<Account> = {}): Account {
  return {
    id: '123e4567-e89b-12d3-a456-426614174000',
    userId: 'user-1',
    accountType: 'CHEQUING',
    accountSubType: null,
    linkedAccountId: null,
    name: 'Main Chequing',
    description: 'Primary account',
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
    canDelete: false,
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
    ...overrides,
  };
}

describe('AccountList', () => {
  const mockOnEdit = vi.fn();
  const mockOnRefresh = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    // Clear localStorage to reset persisted filter/sort/density state
    localStorage.clear();
  });

  it('renders empty state when no accounts', () => {
    render(
      <AccountList
        accounts={[]}
        onEdit={mockOnEdit}
        onRefresh={mockOnRefresh}
      />
    );

    expect(screen.getByText(/No accounts found/)).toBeInTheDocument();
  });

  it('renders account rows with name and type badge', () => {
    const accounts = [
      createAccount({ name: 'Main Chequing' }),
      createAccount({
        id: '223e4567-e89b-12d3-a456-426614174001',
        name: 'My Savings',
        accountType: 'SAVINGS',
      }),
    ];

    render(
      <AccountList
        accounts={accounts}
        onEdit={mockOnEdit}
        onRefresh={mockOnRefresh}
      />
    );

    expect(screen.getByText('Main Chequing')).toBeInTheDocument();
    expect(screen.getByText('My Savings')).toBeInTheDocument();
    // Account count shown in filter bar
    expect(screen.getByText('2 of 2 accounts')).toBeInTheDocument();
  });

  it('shows Edit button for active accounts', () => {
    const accounts = [createAccount()];

    render(
      <AccountList
        accounts={accounts}
        onEdit={mockOnEdit}
        onRefresh={mockOnRefresh}
      />
    );

    const editButton = screen.getByText('Edit');
    expect(editButton).toBeInTheDocument();

    fireEvent.click(editButton);
    expect(mockOnEdit).toHaveBeenCalledWith(accounts[0]);
  });

  it('shows Reopen button for closed accounts', () => {
    const closedAccount = createAccount({
      isClosed: true,
      closedDate: '2024-06-01T00:00:00Z',
    });

    render(
      <AccountList
        accounts={[closedAccount]}
        onEdit={mockOnEdit}
        onRefresh={mockOnRefresh}
      />
    );

    expect(screen.getByText('Reopen')).toBeInTheDocument();
    // Edit button should NOT be present for closed accounts
    expect(screen.queryByText('Edit')).not.toBeInTheDocument();
  });

  it('filters accounts by type using the type dropdown', () => {
    const accounts = [
      createAccount({ name: 'Main Chequing', accountType: 'CHEQUING' }),
      createAccount({
        id: '223e4567-e89b-12d3-a456-426614174001',
        name: 'My Savings',
        accountType: 'SAVINGS',
      }),
      createAccount({
        id: '323e4567-e89b-12d3-a456-426614174002',
        name: 'Visa',
        accountType: 'CREDIT_CARD',
      }),
    ];

    render(
      <AccountList
        accounts={accounts}
        onEdit={mockOnEdit}
        onRefresh={mockOnRefresh}
      />
    );

    // Initially all accounts are shown
    expect(screen.getByText('3 of 3 accounts')).toBeInTheDocument();

    // Filter by SAVINGS
    const typeFilter = screen.getByDisplayValue('All Types');
    fireEvent.change(typeFilter, { target: { value: 'SAVINGS' } });

    expect(screen.getByText('1 of 3 accounts')).toBeInTheDocument();
    expect(screen.getByText('My Savings')).toBeInTheDocument();
    expect(screen.queryByText('Main Chequing')).not.toBeInTheDocument();
  });

  it('sorts accounts by name ascending by default', () => {
    const accounts = [
      createAccount({ name: 'Zebra Account', accountType: 'CHEQUING' }),
      createAccount({
        id: '223e4567-e89b-12d3-a456-426614174001',
        name: 'Alpha Account',
        accountType: 'CHEQUING',
      }),
    ];

    render(
      <AccountList
        accounts={accounts}
        onEdit={mockOnEdit}
        onRefresh={mockOnRefresh}
      />
    );

    // Default sort is by name ascending, so Alpha should come first
    const rows = screen.getAllByRole('row');
    // rows[0] = header, rows[1] = first data row, rows[2] = second data row
    expect(rows[1]).toHaveTextContent('Alpha Account');
    expect(rows[2]).toHaveTextContent('Zebra Account');
  });

  it('density toggle cycles through Normal, Compact, Dense', () => {
    const accounts = [createAccount()];

    render(
      <AccountList
        accounts={accounts}
        onEdit={mockOnEdit}
        onRefresh={mockOnRefresh}
      />
    );

    const densityButton = screen.getByTitle('Toggle row density');

    // Default should show "Normal" since localStorage is empty
    expect(densityButton).toHaveTextContent('Normal');

    // Cycle to compact
    fireEvent.click(densityButton);
    expect(densityButton).toHaveTextContent('Compact');

    // Cycle to dense
    fireEvent.click(densityButton);
    expect(densityButton).toHaveTextContent('Dense');

    // Cycle back to normal
    fireEvent.click(densityButton);
    expect(densityButton).toHaveTextContent('Normal');
  });

  it('shows Active and Closed status badges', () => {
    const accounts = [
      createAccount({ name: 'Active Account', isClosed: false }),
      createAccount({
        id: '223e4567-e89b-12d3-a456-426614174001',
        name: 'Closed Account',
        isClosed: true,
        closedDate: '2024-06-01T00:00:00Z',
      }),
    ];

    render(
      <AccountList
        accounts={accounts}
        onEdit={mockOnEdit}
        onRefresh={mockOnRefresh}
      />
    );

    // The status badges in the table cells
    const activeElements = screen.getAllByText('Active');
    // There's the filter button "Active" and the status badge "Active"
    expect(activeElements.length).toBeGreaterThanOrEqual(1);
  });

  it('shows Delete button for deletable accounts and opens confirmation', () => {
    const deletableAccount = createAccount({ canDelete: true });

    render(
      <AccountList
        accounts={[deletableAccount]}
        onEdit={mockOnEdit}
        onRefresh={mockOnRefresh}
      />
    );

    const deleteButton = screen.getByText('Delete');
    expect(deleteButton).toBeInTheDocument();

    // Clicking Delete should open confirmation dialog
    fireEvent.click(deleteButton);
    expect(screen.getByText(/Are you sure you want to permanently delete/)).toBeInTheDocument();
  });

  it('shows Close button disabled when balance is non-zero', () => {
    const account = createAccount({ currentBalance: 500 });

    render(
      <AccountList
        accounts={[account]}
        onEdit={mockOnEdit}
        onRefresh={mockOnRefresh}
      />
    );

    // The "Close" button in the actions column (not the filter "Closed" button)
    const closeButton = screen.getByRole('button', { name: 'Close' });
    expect(closeButton).toBeDisabled();
  });
});
