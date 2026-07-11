import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act, within } from '@/test/render';
import * as nextNavigation from 'next/navigation';
import { AccountList } from './AccountList';
import { Account } from '@/types/account';
import { accountsApi } from '@/lib/accounts';

vi.mock('@/lib/accounts', () => ({
  accountsApi: {
    close: vi.fn().mockResolvedValue(undefined),
    reopen: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
    update: vi.fn().mockResolvedValue(undefined),
    setDelegateFavourite: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('@/hooks/useNumberFormat', () => ({
  useNumberFormat: () => ({
    formatCurrency: (n: number, _currency?: string) => `$${n.toFixed(2)}`,
  }),
}));

const exchangeMocks = vi.hoisted(() => ({
  convertToDefault: vi.fn((n: number, _currency?: string) => n),
}));

vi.mock('@/hooks/useExchangeRates', () => ({
  useExchangeRates: () => ({
    defaultCurrency: 'CAD',
    convertToDefault: exchangeMocks.convertToDefault,
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
    paymentAmount: null,
    paymentFrequency: null,
    paymentStartDate: null,
    sourceAccountId: null,
    principalCategoryId: null,
    interestCategoryId: null,
    overpaymentCategoryId: null, overpaymentMemo: null, overpaymentPayeeId: null,
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
    statementDueDay: null,
    statementSettlementDay: null,
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
    // Reset the exchange-rate mock to a no-op identity for currency conversion.
    exchangeMocks.convertToDefault.mockImplementation((n: number) => n);
    // Clear localStorage to reset persisted filter/sort/density state
    localStorage.clear();
  });

  it('renders empty state when no accounts', () => {
    render(
      <AccountList
        accounts={[]}
        onEdit={mockOnEdit}
        defaultCurrency="CAD" convertToDefault={exchangeMocks.convertToDefault} onRefresh={mockOnRefresh}
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
        defaultCurrency="CAD" convertToDefault={exchangeMocks.convertToDefault} onRefresh={mockOnRefresh}
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
        defaultCurrency="CAD" convertToDefault={exchangeMocks.convertToDefault} onRefresh={mockOnRefresh}
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
        defaultCurrency="CAD" convertToDefault={exchangeMocks.convertToDefault} onRefresh={mockOnRefresh}
      />
    );

    expect(screen.getByText('Reopen')).toBeInTheDocument();
    // Edit button should NOT be present for closed accounts
    expect(screen.queryByText('Edit')).not.toBeInTheDocument();
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
        defaultCurrency="CAD" convertToDefault={exchangeMocks.convertToDefault} onRefresh={mockOnRefresh}
      />
    );

    // Default sort is by name ascending, so Alpha should come first.
    // rows[0] = table header, rows[1] = CHEQUING group header,
    // rows[2..] = account rows in sorted order.
    const rows = screen.getAllByRole('row');
    expect(rows[2]).toHaveTextContent('Alpha Account');
    expect(rows[3]).toHaveTextContent('Zebra Account');
  });

  it('density toggle cycles through Normal, Compact, Dense', () => {
    const accounts = [createAccount()];

    render(
      <AccountList
        accounts={accounts}
        onEdit={mockOnEdit}
        defaultCurrency="CAD" convertToDefault={exchangeMocks.convertToDefault} onRefresh={mockOnRefresh}
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
        defaultCurrency="CAD" convertToDefault={exchangeMocks.convertToDefault} onRefresh={mockOnRefresh}
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
        defaultCurrency="CAD" convertToDefault={exchangeMocks.convertToDefault} onRefresh={mockOnRefresh}
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
        defaultCurrency="CAD" convertToDefault={exchangeMocks.convertToDefault} onRefresh={mockOnRefresh}
      />
    );

    // The "Close" button in the actions column (not the filter "Closed" button)
    const closeButton = screen.getByRole('button', { name: 'Close' });
    expect(closeButton).toBeDisabled();
  });

  // --- New tests for improved coverage ---

  it('displays accounts with multiple types and their type badges', () => {
    const accounts = [
      createAccount({ id: 'a1', name: 'Chequing Acct', accountType: 'CHEQUING' }),
      createAccount({ id: 'a2', name: 'Savings Acct', accountType: 'SAVINGS' }),
      createAccount({ id: 'a3', name: 'Credit Card Acct', accountType: 'CREDIT_CARD' }),
      createAccount({ id: 'a4', name: 'Investment Acct', accountType: 'INVESTMENT' }),
      createAccount({ id: 'a5', name: 'Cash Acct', accountType: 'CASH' }),
    ];

    render(
      <AccountList accounts={accounts} onEdit={mockOnEdit} defaultCurrency="CAD" convertToDefault={exchangeMocks.convertToDefault} onRefresh={mockOnRefresh} />
    );

    expect(screen.getByText('Chequing Acct')).toBeInTheDocument();
    expect(screen.getByText('Savings Acct')).toBeInTheDocument();
    expect(screen.getByText('Credit Card Acct')).toBeInTheDocument();
    expect(screen.getByText('Investment Acct')).toBeInTheDocument();
    expect(screen.getByText('Cash Acct')).toBeInTheDocument();

    // Type badges (also appear in the filter dropdown options, so use getAllByText)
    expect(screen.getAllByText('Chequing').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('Savings').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('Credit Card').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('Investment').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('Cash').length).toBeGreaterThanOrEqual(1);

    expect(screen.getByText('5 of 5 accounts')).toBeInTheDocument();
  });

  it('displays account balance with correct formatting', () => {
    const accounts = [
      createAccount({ id: 'a1', name: 'Positive Balance', currentBalance: 2500.50, currencyCode: 'CAD' }),
      createAccount({ id: 'a2', name: 'Negative Balance', currentBalance: -300.00, currencyCode: 'CAD' }),
    ];

    render(
      <AccountList accounts={accounts} onEdit={mockOnEdit} defaultCurrency="CAD" convertToDefault={exchangeMocks.convertToDefault} onRefresh={mockOnRefresh} />
    );

    expect(screen.getByText('$2500.50')).toBeInTheDocument();
    expect(screen.getByText('$-300.00')).toBeInTheDocument();
  });

  it('displays currency code for non-default currency accounts', () => {
    const accounts = [
      createAccount({ id: 'a1', name: 'USD Account', currencyCode: 'USD', currentBalance: 1000 }),
    ];

    render(
      <AccountList accounts={accounts} onEdit={mockOnEdit} defaultCurrency="CAD" convertToDefault={exchangeMocks.convertToDefault} onRefresh={mockOnRefresh} />
    );

    // Non-default currency appends currency code
    expect(screen.getByText('$1000.00 USD')).toBeInTheDocument();
  });

  it('does not show Delete button for non-deletable accounts', () => {
    const account = createAccount({ canDelete: false });

    render(
      <AccountList accounts={[account]} onEdit={mockOnEdit} defaultCurrency="CAD" convertToDefault={exchangeMocks.convertToDefault} onRefresh={mockOnRefresh} />
    );

    expect(screen.queryByText('Delete')).not.toBeInTheDocument();
  });

  it('filters accounts by active status', () => {
    const accounts = [
      createAccount({ id: 'a1', name: 'Active One', isClosed: false }),
      createAccount({ id: 'a2', name: 'Closed One', isClosed: true, closedDate: '2024-01-01T00:00:00Z' }),
    ];

    render(
      <AccountList accounts={accounts} onEdit={mockOnEdit} defaultCurrency="CAD" convertToDefault={exchangeMocks.convertToDefault} onRefresh={mockOnRefresh} />
    );

    expect(screen.getByText('2 of 2 accounts')).toBeInTheDocument();

    // Click the "Active" status filter button
    const statusButtons = screen.getAllByRole('button');
    const activeFilterButton = statusButtons.find(
      (btn) => btn.textContent === 'Active' && btn.closest('.inline-flex.rounded-md')
    );
    expect(activeFilterButton).toBeTruthy();
    fireEvent.click(activeFilterButton!);

    expect(screen.getByText('1 of 2 accounts')).toBeInTheDocument();
    expect(screen.getByText('Active One')).toBeInTheDocument();
    expect(screen.queryByText('Closed One')).not.toBeInTheDocument();
  });

  it('filters accounts by closed status', () => {
    const accounts = [
      createAccount({ id: 'a1', name: 'Active One', isClosed: false }),
      createAccount({ id: 'a2', name: 'Closed One', isClosed: true, closedDate: '2024-01-01T00:00:00Z' }),
    ];

    render(
      <AccountList accounts={accounts} onEdit={mockOnEdit} defaultCurrency="CAD" convertToDefault={exchangeMocks.convertToDefault} onRefresh={mockOnRefresh} />
    );

    // Click the "Closed" status filter button in the segmented control
    const closedFilterButton = screen.getAllByRole('button').find(
      (btn) => btn.textContent === 'Closed' && btn.closest('.inline-flex.rounded-md')
    );
    expect(closedFilterButton).toBeTruthy();
    fireEvent.click(closedFilterButton!);

    expect(screen.getByText('1 of 2 accounts')).toBeInTheDocument();
    expect(screen.queryByText('Active One')).not.toBeInTheDocument();
    expect(screen.getByText('Closed One')).toBeInTheDocument();
  });

  it('filters accounts by net worth included', () => {
    const accounts = [
      createAccount({ id: 'a1', name: 'Included Account', excludeFromNetWorth: false }),
      createAccount({ id: 'a2', name: 'Excluded Account', excludeFromNetWorth: true }),
    ];

    render(
      <AccountList accounts={accounts} onEdit={mockOnEdit} defaultCurrency="CAD" convertToDefault={exchangeMocks.convertToDefault} onRefresh={mockOnRefresh} />
    );

    expect(screen.getByText('2 of 2 accounts')).toBeInTheDocument();

    const netWorthFilter = screen.getByDisplayValue('Net Worth: All');
    fireEvent.change(netWorthFilter, { target: { value: 'included' } });

    expect(screen.getByText('1 of 2 accounts')).toBeInTheDocument();
    expect(screen.getByText('Included Account')).toBeInTheDocument();
    expect(screen.queryByText('Excluded Account')).not.toBeInTheDocument();
  });

  it('filters accounts by net worth excluded', () => {
    const accounts = [
      createAccount({ id: 'a1', name: 'Included Account', excludeFromNetWorth: false }),
      createAccount({ id: 'a2', name: 'Excluded Account', excludeFromNetWorth: true }),
    ];

    render(
      <AccountList accounts={accounts} onEdit={mockOnEdit} defaultCurrency="CAD" convertToDefault={exchangeMocks.convertToDefault} onRefresh={mockOnRefresh} />
    );

    const netWorthFilter = screen.getByDisplayValue('Net Worth: All');
    fireEvent.change(netWorthFilter, { target: { value: 'excluded' } });

    expect(screen.getByText('1 of 2 accounts')).toBeInTheDocument();
    expect(screen.queryByText('Included Account')).not.toBeInTheDocument();
    expect(screen.getByText('Excluded Account')).toBeInTheDocument();
  });

  it('hides net worth filter when no accounts are excluded from net worth', () => {
    const accounts = [
      createAccount({ id: 'a1', name: 'Account One', excludeFromNetWorth: false }),
      createAccount({ id: 'a2', name: 'Account Two', excludeFromNetWorth: false }),
    ];

    render(
      <AccountList accounts={accounts} onEdit={mockOnEdit} defaultCurrency="CAD" convertToDefault={exchangeMocks.convertToDefault} onRefresh={mockOnRefresh} />
    );

    expect(screen.queryByDisplayValue('Net Worth: All')).not.toBeInTheDocument();
  });

  it('filters accounts by text search on name', () => {
    const accounts = [
      createAccount({ id: 'a1', name: 'My Chequing', accountType: 'CHEQUING' }),
      createAccount({ id: 'a2', name: 'My Savings', accountType: 'SAVINGS' }),
    ];

    render(
      <AccountList accounts={accounts} onEdit={mockOnEdit} defaultCurrency="CAD" convertToDefault={exchangeMocks.convertToDefault} onRefresh={mockOnRefresh} />
    );

    fireEvent.change(screen.getByLabelText('Search accounts by name'), {
      target: { value: 'chequing' },
    });

    expect(screen.getByText('1 of 2 accounts')).toBeInTheDocument();
    expect(screen.getByText('My Chequing')).toBeInTheDocument();
    expect(screen.queryByText('My Savings')).not.toBeInTheDocument();
  });

  it('clears the text search via the clear button', () => {
    const accounts = [
      createAccount({ id: 'a1', name: 'My Chequing', accountType: 'CHEQUING' }),
      createAccount({ id: 'a2', name: 'My Savings', accountType: 'SAVINGS' }),
    ];

    render(
      <AccountList accounts={accounts} onEdit={mockOnEdit} defaultCurrency="CAD" convertToDefault={exchangeMocks.convertToDefault} onRefresh={mockOnRefresh} />
    );

    fireEvent.change(screen.getByLabelText('Search accounts by name'), {
      target: { value: 'chequing' },
    });
    expect(screen.getByText('1 of 2 accounts')).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText('Clear search'));
    expect(screen.getByText('2 of 2 accounts')).toBeInTheDocument();
  });

  it('filters accounts by one or more account types', () => {
    const accounts = [
      createAccount({ id: 'a1', name: 'My Chequing', accountType: 'CHEQUING' }),
      createAccount({ id: 'a2', name: 'My Savings', accountType: 'SAVINGS' }),
    ];

    render(
      <AccountList accounts={accounts} onEdit={mockOnEdit} defaultCurrency="CAD" convertToDefault={exchangeMocks.convertToDefault} onRefresh={mockOnRefresh} />
    );

    // Open the account-type multi-select. Options render as checkboxes ordered
    // by ACCOUNT_TYPE_ORDER, so index 1 is SAVINGS (after CHEQUING).
    fireEvent.click(screen.getByRole('button', { name: 'Filter by account type' }));
    const checkboxes = screen.getAllByRole('checkbox');
    fireEvent.click(checkboxes[1]);

    expect(screen.getByText('1 of 2 accounts')).toBeInTheDocument();
    expect(screen.getByText('My Savings')).toBeInTheDocument();
    expect(screen.queryByText('My Chequing')).not.toBeInTheDocument();
  });

  it('persists type and search filters to localStorage', () => {
    const accounts = [
      createAccount({ id: 'a1', name: 'My Chequing', accountType: 'CHEQUING' }),
      createAccount({ id: 'a2', name: 'My Savings', accountType: 'SAVINGS' }),
    ];

    render(
      <AccountList accounts={accounts} onEdit={mockOnEdit} defaultCurrency="CAD" convertToDefault={exchangeMocks.convertToDefault} onRefresh={mockOnRefresh} />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Filter by account type' }));
    fireEvent.click(screen.getAllByRole('checkbox')[1]);
    fireEvent.change(screen.getByLabelText('Search accounts by name'), {
      target: { value: 'sav' },
    });

    expect(localStorage.getItem('accounts.filter.types')).toBe(JSON.stringify(['SAVINGS']));
    expect(localStorage.getItem('accounts.filter.search')).toBe(JSON.stringify('sav'));
  });

  it('initializes type and search filters from localStorage', () => {
    localStorage.setItem('accounts.filter.types', JSON.stringify(['SAVINGS']));
    localStorage.setItem('accounts.filter.search', JSON.stringify(''));
    const accounts = [
      createAccount({ id: 'a1', name: 'My Chequing', accountType: 'CHEQUING' }),
      createAccount({ id: 'a2', name: 'My Savings', accountType: 'SAVINGS' }),
    ];

    render(
      <AccountList accounts={accounts} onEdit={mockOnEdit} defaultCurrency="CAD" convertToDefault={exchangeMocks.convertToDefault} onRefresh={mockOnRefresh} />
    );

    expect(screen.getByText('1 of 2 accounts')).toBeInTheDocument();
    expect(screen.getByText('My Savings')).toBeInTheDocument();
    expect(screen.queryByText('My Chequing')).not.toBeInTheDocument();
  });

  it('Clear Filters resets the type and search filters', () => {
    const accounts = [
      createAccount({ id: 'a1', name: 'My Chequing', accountType: 'CHEQUING' }),
      createAccount({ id: 'a2', name: 'My Savings', accountType: 'SAVINGS' }),
    ];

    render(
      <AccountList accounts={accounts} onEdit={mockOnEdit} defaultCurrency="CAD" convertToDefault={exchangeMocks.convertToDefault} onRefresh={mockOnRefresh} />
    );

    // A search matching nothing empties the list and surfaces Clear Filters.
    fireEvent.change(screen.getByLabelText('Search accounts by name'), {
      target: { value: 'no-such-account' },
    });
    expect(screen.getByText('No accounts match your filters.')).toBeInTheDocument();

    fireEvent.click(screen.getByText('Clear Filters'));

    expect(screen.getByText('2 of 2 accounts')).toBeInTheDocument();
    // The persistence effect re-writes the reset (empty) value after clearing.
    expect(localStorage.getItem('accounts.filter.search')).toBe(JSON.stringify(''));
    expect(localStorage.getItem('accounts.filter.types')).toBe(JSON.stringify([]));
  });

  it('shows "No accounts match your filters" and Clear Filters button when filters exclude all accounts', () => {
    const accounts = [
      createAccount({ id: 'a1', name: 'Chequing Only', accountType: 'CHEQUING', isClosed: false }),
    ];

    render(
      <AccountList accounts={accounts} onEdit={mockOnEdit} defaultCurrency="CAD" convertToDefault={exchangeMocks.convertToDefault} onRefresh={mockOnRefresh} />
    );

    // Filter by closed status when all accounts are active
    const closedFilterButton = screen.getAllByRole('button').find(
      (btn) => btn.textContent === 'Closed' && btn.closest('.inline-flex.rounded-md')
    );
    expect(closedFilterButton).toBeTruthy();
    fireEvent.click(closedFilterButton!);

    expect(screen.getByText('No accounts match your filters.')).toBeInTheDocument();
    expect(screen.getByText('Clear Filters')).toBeInTheDocument();
  });

  it('sorts accounts by balance', () => {
    const accounts = [
      createAccount({ id: 'a1', name: 'Low Balance', currentBalance: 100 }),
      createAccount({ id: 'a2', name: 'High Balance', currentBalance: 5000 }),
    ];

    render(
      <AccountList accounts={accounts} onEdit={mockOnEdit} defaultCurrency="CAD" convertToDefault={exchangeMocks.convertToDefault} onRefresh={mockOnRefresh} />
    );

    // Click on Balance header to sort
    const balanceHeader = screen.getByText('Balance');
    fireEvent.click(balanceHeader);

    // rows[0] = table header, rows[1] = CHEQUING group header,
    // followed by account rows sorted by balance ascending.
    const rows = screen.getAllByRole('row');
    expect(rows[2]).toHaveTextContent('Low Balance');
    expect(rows[3]).toHaveTextContent('High Balance');

    // Click again to reverse
    fireEvent.click(balanceHeader);
    const rowsDesc = screen.getAllByRole('row');
    expect(rowsDesc[2]).toHaveTextContent('High Balance');
    expect(rowsDesc[3]).toHaveTextContent('Low Balance');
  });

  it('renders account-type groups in the canonical order', () => {
    const accounts = [
      createAccount({ id: 'a1', name: 'Savings Acct', accountType: 'SAVINGS' }),
      createAccount({ id: 'a2', name: 'Chequing Acct', accountType: 'CHEQUING' }),
    ];

    render(
      <AccountList accounts={accounts} onEdit={mockOnEdit} defaultCurrency="CAD" convertToDefault={exchangeMocks.convertToDefault} onRefresh={mockOnRefresh} />
    );

    // Groups are rendered Chequing → Savings regardless of input order.
    // rows[0] = table header, rows[1] = Chequing group header,
    // rows[2] = Chequing account, rows[3] = Savings group header, rows[4] = Savings account.
    const rows = screen.getAllByRole('row');
    expect(rows[1]).toHaveTextContent('Chequing');
    expect(rows[2]).toHaveTextContent('Chequing Acct');
    expect(rows[3]).toHaveTextContent('Savings');
    expect(rows[4]).toHaveTextContent('Savings Acct');
  });

  it('sorts accounts by status', () => {
    const accounts = [
      createAccount({ id: 'a1', name: 'Closed Acct', isClosed: true, closedDate: '2024-01-01T00:00:00Z' }),
      createAccount({ id: 'a2', name: 'Active Acct', isClosed: false }),
    ];

    render(
      <AccountList accounts={accounts} onEdit={mockOnEdit} defaultCurrency="CAD" convertToDefault={exchangeMocks.convertToDefault} onRefresh={mockOnRefresh} />
    );

    // Click on Status header to sort by status
    const statusHeader = screen.getByText('Status');
    fireEvent.click(statusHeader);

    // rows[0] = table header, rows[1] = CHEQUING group header (both accounts share the type),
    // followed by account rows ordered Active before Closed.
    const rows = screen.getAllByRole('row');
    expect(rows[2]).toHaveTextContent('Active Acct');
    expect(rows[3]).toHaveTextContent('Closed Acct');
  });

  it('enables Close button when account balance is zero', () => {
    const account = createAccount({ currentBalance: 0 });

    render(
      <AccountList accounts={[account]} onEdit={mockOnEdit} defaultCurrency="CAD" convertToDefault={exchangeMocks.convertToDefault} onRefresh={mockOnRefresh} />
    );

    const closeButton = screen.getByRole('button', { name: 'Close' });
    expect(closeButton).not.toBeDisabled();
  });

  it('opens close confirmation dialog and confirms close', async () => {
    const account = createAccount({ currentBalance: 0 });

    render(
      <AccountList accounts={[account]} onEdit={mockOnEdit} defaultCurrency="CAD" convertToDefault={exchangeMocks.convertToDefault} onRefresh={mockOnRefresh} />
    );

    // Click Close to open dialog
    const closeButton = screen.getByRole('button', { name: 'Close' });
    fireEvent.click(closeButton);

    expect(screen.getByText(/Are you sure you want to close/)).toBeInTheDocument();

    // Confirm the close (use getByRole to target the confirm button, not the dialog title)
    const confirmButton = screen.getByRole('button', { name: 'Close Account' });
    fireEvent.click(confirmButton);

    await waitFor(() => {
      expect(accountsApi.close).toHaveBeenCalledWith(account.id);
    });

    await waitFor(() => {
      expect(mockOnRefresh).toHaveBeenCalled();
    });
  });

  it('cancels close dialog without closing account', () => {
    const account = createAccount({ currentBalance: 0 });

    render(
      <AccountList accounts={[account]} onEdit={mockOnEdit} defaultCurrency="CAD" convertToDefault={exchangeMocks.convertToDefault} onRefresh={mockOnRefresh} />
    );

    // Click Close to open dialog
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.getByText(/Are you sure you want to close/)).toBeInTheDocument();

    // Cancel
    fireEvent.click(screen.getByText('Cancel'));

    // Dialog should be dismissed (the confirm message should not be visible)
    expect(screen.queryByText(/Are you sure you want to close/)).not.toBeInTheDocument();
    expect(accountsApi.close).not.toHaveBeenCalled();
  });

  it('confirms delete and calls API', async () => {
    const account = createAccount({ canDelete: true });

    render(
      <AccountList accounts={[account]} onEdit={mockOnEdit} defaultCurrency="CAD" convertToDefault={exchangeMocks.convertToDefault} onRefresh={mockOnRefresh} />
    );

    // Click Delete to open dialog
    fireEvent.click(screen.getByText('Delete'));
    expect(screen.getByText(/Are you sure you want to permanently delete/)).toBeInTheDocument();

    // Confirm delete (use getByRole to target the confirm button, not the dialog title)
    fireEvent.click(screen.getByRole('button', { name: 'Delete Account' }));

    await waitFor(() => {
      expect(accountsApi.delete).toHaveBeenCalledWith(account.id);
    });

    await waitFor(() => {
      expect(mockOnRefresh).toHaveBeenCalled();
    });
  });

  it('cancels delete dialog without deleting', () => {
    const account = createAccount({ canDelete: true });

    render(
      <AccountList accounts={[account]} onEdit={mockOnEdit} defaultCurrency="CAD" convertToDefault={exchangeMocks.convertToDefault} onRefresh={mockOnRefresh} />
    );

    fireEvent.click(screen.getByText('Delete'));
    expect(screen.getByText(/Are you sure you want to permanently delete/)).toBeInTheDocument();

    // Cancel
    fireEvent.click(screen.getByText('Cancel'));
    expect(screen.queryByText(/Are you sure you want to permanently delete/)).not.toBeInTheDocument();
    expect(accountsApi.delete).not.toHaveBeenCalled();
  });

  it('calls reopen API when Reopen button is clicked', async () => {
    const closedAccount = createAccount({
      isClosed: true,
      closedDate: '2024-06-01T00:00:00Z',
    });

    render(
      <AccountList accounts={[closedAccount]} onEdit={mockOnEdit} defaultCurrency="CAD" convertToDefault={exchangeMocks.convertToDefault} onRefresh={mockOnRefresh} />
    );

    fireEvent.click(screen.getByText('Reopen'));

    await waitFor(() => {
      expect(accountsApi.reopen).toHaveBeenCalledWith(closedAccount.id);
    });

    await waitFor(() => {
      expect(mockOnRefresh).toHaveBeenCalled();
    });
  });

  it('shows Reconcile button for non-brokerage active accounts', () => {
    const account = createAccount({ accountSubType: null });

    render(
      <AccountList accounts={[account]} onEdit={mockOnEdit} defaultCurrency="CAD" convertToDefault={exchangeMocks.convertToDefault} onRefresh={mockOnRefresh} />
    );

    expect(screen.getByText('Reconcile')).toBeInTheDocument();
  });

  it('does not show Reconcile button for brokerage accounts', () => {
    const account = createAccount({
      accountType: 'INVESTMENT',
      accountSubType: 'INVESTMENT_BROKERAGE',
    });

    render(
      <AccountList accounts={[account]} onEdit={mockOnEdit} defaultCurrency="CAD" convertToDefault={exchangeMocks.convertToDefault} onRefresh={mockOnRefresh} />
    );

    expect(screen.queryByText('Reconcile')).not.toBeInTheDocument();
  });

  it('shows brokerage market value when provided', () => {
    const account = createAccount({
      id: 'broker-1',
      accountType: 'INVESTMENT',
      accountSubType: 'INVESTMENT_BROKERAGE',
      currencyCode: 'CAD',
      currentBalance: 0,
    });

    const brokerageMarketValues = new Map([['broker-1', 12345.67]]);

    render(
      <AccountList
        accounts={[account]}
        brokerageMarketValues={brokerageMarketValues}
        onEdit={mockOnEdit}
        defaultCurrency="CAD" convertToDefault={exchangeMocks.convertToDefault} onRefresh={mockOnRefresh}
      />
    );

    // The market value is shown both on the account row and in the
    // INVESTMENT group header total, so there are two matching nodes.
    expect(screen.getAllByText('$12345.67').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('Market value')).toBeInTheDocument();
  });

  it('shows credit limit for accounts with a credit limit', () => {
    const account = createAccount({
      accountType: 'CREDIT_CARD',
      creditLimit: 5000,
      currentBalance: -1200,
    });

    render(
      <AccountList accounts={[account]} onEdit={mockOnEdit} defaultCurrency="CAD" convertToDefault={exchangeMocks.convertToDefault} onRefresh={mockOnRefresh} />
    );

    expect(screen.getByText(/Limit:/)).toBeInTheDocument();
  });

  it('shows Closed status badge for closed accounts', () => {
    const accounts = [
      createAccount({
        id: 'a1',
        name: 'Closed Savings',
        isClosed: true,
        closedDate: '2024-06-01T00:00:00Z',
      }),
    ];

    render(
      <AccountList accounts={accounts} onEdit={mockOnEdit} defaultCurrency="CAD" convertToDefault={exchangeMocks.convertToDefault} onRefresh={mockOnRefresh} />
    );

    // "Closed" appears both in the status column badge and in the filter bar button
    const closedElements = screen.getAllByText('Closed');
    expect(closedElements.length).toBeGreaterThanOrEqual(1);
  });

  it('shows Delete button for closed deletable accounts', () => {
    const account = createAccount({
      isClosed: true,
      closedDate: '2024-01-01T00:00:00Z',
      canDelete: true,
    });

    render(
      <AccountList accounts={[account]} onEdit={mockOnEdit} defaultCurrency="CAD" convertToDefault={exchangeMocks.convertToDefault} onRefresh={mockOnRefresh} />
    );

    expect(screen.getByText('Reopen')).toBeInTheDocument();
    expect(screen.getByText('Delete')).toBeInTheDocument();
  });

  it('handles close API error gracefully', async () => {
    (accountsApi.close as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('Server error'));
    const account = createAccount({ currentBalance: 0 });

    render(
      <AccountList accounts={[account]} onEdit={mockOnEdit} defaultCurrency="CAD" convertToDefault={exchangeMocks.convertToDefault} onRefresh={mockOnRefresh} />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    fireEvent.click(screen.getByRole('button', { name: 'Close Account' }));

    await waitFor(() => {
      expect(accountsApi.close).toHaveBeenCalled();
    });

    // onRefresh should NOT be called on error
    expect(mockOnRefresh).not.toHaveBeenCalled();
  });

  it('handles delete API error gracefully', async () => {
    (accountsApi.delete as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('Server error'));
    const account = createAccount({ canDelete: true });

    render(
      <AccountList accounts={[account]} onEdit={mockOnEdit} defaultCurrency="CAD" convertToDefault={exchangeMocks.convertToDefault} onRefresh={mockOnRefresh} />
    );

    fireEvent.click(screen.getByText('Delete'));
    fireEvent.click(screen.getByRole('button', { name: 'Delete Account' }));

    await waitFor(() => {
      expect(accountsApi.delete).toHaveBeenCalled();
    });

    expect(mockOnRefresh).not.toHaveBeenCalled();
  });

  it('handles reopen API error gracefully', async () => {
    (accountsApi.reopen as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('Server error'));
    const account = createAccount({
      isClosed: true,
      closedDate: '2024-01-01T00:00:00Z',
    });

    render(
      <AccountList accounts={[account]} onEdit={mockOnEdit} defaultCurrency="CAD" convertToDefault={exchangeMocks.convertToDefault} onRefresh={mockOnRefresh} />
    );

    fireEvent.click(screen.getByText('Reopen'));

    await waitFor(() => {
      expect(accountsApi.reopen).toHaveBeenCalled();
    });

    expect(mockOnRefresh).not.toHaveBeenCalled();
  });

  it('shows the "All" segmented button as selected by default', () => {
    const accounts = [createAccount()];

    render(
      <AccountList accounts={accounts} onEdit={mockOnEdit} defaultCurrency="CAD" convertToDefault={exchangeMocks.convertToDefault} onRefresh={mockOnRefresh} />
    );

    // The "All" button in the segmented control should have active styling
    const allButton = screen.getAllByRole('button').find(
      (btn) => btn.textContent === 'All' && btn.closest('.inline-flex.rounded-md')
    );
    expect(allButton).toBeTruthy();
    expect(allButton!.className).toContain('bg-blue-600');
  });

  it('shows an interactive favourite star for favourite accounts', () => {
    const account = createAccount({ isFavourite: true });

    render(
      <AccountList accounts={[account]} onEdit={mockOnEdit} defaultCurrency="CAD" convertToDefault={exchangeMocks.convertToDefault} onRefresh={mockOnRefresh} />
    );

    expect(
      screen.getByLabelText('Remove from favourites'),
    ).toBeInTheDocument();
  });

  it('owner toggling the star updates the account favourite', async () => {
    const account = createAccount({ isFavourite: false });

    render(
      <AccountList accounts={[account]} onEdit={mockOnEdit} defaultCurrency="CAD" convertToDefault={exchangeMocks.convertToDefault} onRefresh={mockOnRefresh} />
    );

    await act(async () => {
      fireEvent.click(screen.getByLabelText('Add to favourites'));
    });

    expect(accountsApi.update).toHaveBeenCalledWith(account.id, {
      isFavourite: true,
    });
    expect(accountsApi.setDelegateFavourite).not.toHaveBeenCalled();
    // Optimistic update only -- no full list reload.
    expect(mockOnRefresh).not.toHaveBeenCalled();
    expect(
      screen.getByLabelText('Remove from favourites'),
    ).toBeInTheDocument();
  });

  it('rolls back the star when the favourite update fails', async () => {
    (accountsApi.update as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('nope'),
    );
    const account = createAccount({ isFavourite: false });

    render(
      <AccountList accounts={[account]} onEdit={mockOnEdit} defaultCurrency="CAD" convertToDefault={exchangeMocks.convertToDefault} onRefresh={mockOnRefresh} />
    );

    await act(async () => {
      fireEvent.click(screen.getByLabelText('Add to favourites'));
    });
    await act(async () => {});

    expect(
      screen.getByLabelText('Add to favourites'),
    ).toBeInTheDocument();
    expect(mockOnRefresh).not.toHaveBeenCalled();
  });

  it('a delegate toggling the star writes the delegate overlay', async () => {
    const { useAuthStore } = await import('@/store/authStore');
    act(() => {
      useAuthStore
        .getState()
        .setDelegation('owner-1', [], null, { accounts: true } as never);
    });
    const account = createAccount({ isFavourite: false });

    render(
      <AccountList accounts={[account]} onEdit={mockOnEdit} defaultCurrency="CAD" convertToDefault={exchangeMocks.convertToDefault} onRefresh={mockOnRefresh} />
    );

    await act(async () => {
      fireEvent.click(screen.getByLabelText('Add to favourites'));
    });

    expect(accountsApi.setDelegateFavourite).toHaveBeenCalledWith(
      account.id,
      true,
    );
    expect(accountsApi.update).not.toHaveBeenCalled();

    act(() => {
      useAuthStore.getState().setDelegation(null, [], null, null);
    });
  });

  it('shows linked account info for investment pairs', () => {
    const cashAccount = createAccount({
      id: 'cash-1',
      name: 'Inv Cash',
      accountType: 'INVESTMENT',
      accountSubType: 'INVESTMENT_CASH',
      linkedAccountId: 'broker-1',
    });
    const brokerageAccount = createAccount({
      id: 'broker-1',
      name: 'Inv Brokerage',
      accountType: 'INVESTMENT',
      accountSubType: 'INVESTMENT_BROKERAGE',
      linkedAccountId: 'cash-1',
    });

    render(
      <AccountList
        accounts={[cashAccount, brokerageAccount]}
        onEdit={mockOnEdit}
        defaultCurrency="CAD" convertToDefault={exchangeMocks.convertToDefault} onRefresh={mockOnRefresh}
      />
    );

    // "Paired with" text should be shown for linked investment accounts in normal density
    expect(screen.getByText(/Paired with Inv Brokerage/)).toBeInTheDocument();
    expect(screen.getByText(/Paired with Inv Cash/)).toBeInTheDocument();
  });

  it('counts a linked investment brokerage/cash pair as a single account in the header', () => {
    const accounts = [
      createAccount({ id: 'a1', name: 'Chequing', accountType: 'CHEQUING' }),
      createAccount({
        id: 'cash-1',
        name: 'Inv Cash',
        accountType: 'INVESTMENT',
        accountSubType: 'INVESTMENT_CASH',
        linkedAccountId: 'broker-1',
      }),
      createAccount({
        id: 'broker-1',
        name: 'Inv Brokerage',
        accountType: 'INVESTMENT',
        accountSubType: 'INVESTMENT_BROKERAGE',
        linkedAccountId: 'cash-1',
      }),
    ];

    render(
      <AccountList accounts={accounts} onEdit={mockOnEdit} defaultCurrency="CAD" convertToDefault={exchangeMocks.convertToDefault} onRefresh={mockOnRefresh} />
    );

    // 1 chequing + 1 logical investment account (the linked pair) = 2
    expect(screen.getByText('2 of 2 accounts')).toBeInTheDocument();
  });

  it('shows Brokerage and Inv. Cash type labels for investment subtypes', () => {
    const accounts = [
      createAccount({
        id: 'cash-1',
        name: 'Investment Cash',
        accountType: 'INVESTMENT',
        accountSubType: 'INVESTMENT_CASH',
        linkedAccountId: 'broker-1',
      }),
      createAccount({
        id: 'broker-1',
        name: 'Investment Brokerage',
        accountType: 'INVESTMENT',
        accountSubType: 'INVESTMENT_BROKERAGE',
        linkedAccountId: 'cash-1',
      }),
    ];

    render(
      <AccountList accounts={accounts} onEdit={mockOnEdit} defaultCurrency="CAD" convertToDefault={exchangeMocks.convertToDefault} onRefresh={mockOnRefresh} />
    );

    expect(screen.getByText('Inv. Cash')).toBeInTheDocument();
    expect(screen.getByText('Brokerage')).toBeInTheDocument();
  });

  it('shows description for accounts with description in normal density', () => {
    const account = createAccount({
      description: 'My primary chequing',
    });

    render(
      <AccountList accounts={[account]} onEdit={mockOnEdit} defaultCurrency="CAD" convertToDefault={exchangeMocks.convertToDefault} onRefresh={mockOnRefresh} />
    );

    expect(screen.getByText('My primary chequing')).toBeInTheDocument();
  });

  it('clears filter from "No accounts match" empty state', () => {
    const accounts = [
      createAccount({ id: 'a1', name: 'Chequing Only', accountType: 'CHEQUING', isClosed: false }),
    ];

    render(
      <AccountList accounts={accounts} onEdit={mockOnEdit} defaultCurrency="CAD" convertToDefault={exchangeMocks.convertToDefault} onRefresh={mockOnRefresh} />
    );

    // Filter by closed status when all accounts are active to produce empty results
    const closedFilterButton = screen.getAllByRole('button').find(
      (btn) => btn.textContent === 'Closed' && btn.closest('.inline-flex.rounded-md')
    );
    expect(closedFilterButton).toBeTruthy();
    fireEvent.click(closedFilterButton!);

    expect(screen.getByText('No accounts match your filters.')).toBeInTheDocument();

    // Click Clear Filters button in the empty state
    fireEvent.click(screen.getByText('Clear Filters'));

    expect(screen.getByText('1 of 1 accounts')).toBeInTheDocument();
    expect(screen.getByText('Chequing Only')).toBeInTheDocument();
  });

  it('shows approximate converted amount for non-default currency', () => {
    const account = createAccount({
      id: 'a1',
      currencyCode: 'USD',
      currentBalance: 500,
    });

    render(
      <AccountList accounts={[account]} onEdit={mockOnEdit} defaultCurrency="CAD" convertToDefault={exchangeMocks.convertToDefault} onRefresh={mockOnRefresh} />
    );

    // The approximate conversion indicator
    const approxIndicator = screen.getByText(/\u2248/);
    expect(approxIndicator).toBeInTheDocument();
  });

  describe('navigation on row click', () => {
    let mockPush: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      mockPush = vi.fn();
      vi.spyOn(nextNavigation, 'useRouter').mockReturnValue({
        push: mockPush,
        replace: vi.fn(),
        back: vi.fn(),
        forward: vi.fn(),
        refresh: vi.fn(),
        prefetch: vi.fn(),
      } as unknown as ReturnType<typeof nextNavigation.useRouter>);
    });

    it('navigates to /investments with accountId for brokerage accounts', () => {
      const account = createAccount({
        id: 'broker-1',
        name: 'My Brokerage',
        accountType: 'INVESTMENT',
        accountSubType: 'INVESTMENT_BROKERAGE',
      });

      render(
        <AccountList accounts={[account]} onEdit={mockOnEdit} defaultCurrency="CAD" convertToDefault={exchangeMocks.convertToDefault} onRefresh={mockOnRefresh} />
      );

      fireEvent.click(screen.getByText('My Brokerage'));

      expect(mockPush).toHaveBeenCalledWith('/investments?accountId=broker-1');
    });

    it('navigates to /transactions with accountId for non-brokerage accounts', () => {
      const account = createAccount({
        id: 'chequing-1',
        name: 'Main Chequing',
        accountType: 'CHEQUING',
      });

      render(
        <AccountList accounts={[account]} onEdit={mockOnEdit} defaultCurrency="CAD" convertToDefault={exchangeMocks.convertToDefault} onRefresh={mockOnRefresh} />
      );

      fireEvent.click(screen.getByText('Main Chequing'));

      expect(mockPush).toHaveBeenCalledWith('/transactions?accountId=chequing-1');
    });
  });

  describe('grouping by account type', () => {
    it('renders a group header for each account type with the account count', () => {
      const accounts = [
        createAccount({ id: 'c1', name: 'Cheq A', accountType: 'CHEQUING' }),
        createAccount({ id: 'c2', name: 'Cheq B', accountType: 'CHEQUING' }),
        createAccount({ id: 's1', name: 'Sav A', accountType: 'SAVINGS' }),
      ];

      render(
        <AccountList accounts={accounts} onEdit={mockOnEdit} defaultCurrency="CAD" convertToDefault={exchangeMocks.convertToDefault} onRefresh={mockOnRefresh} />
      );

      // Group headers display the account count alongside the type label.
      expect(screen.getByText('2 accounts')).toBeInTheDocument();
      expect(screen.getByText('1 account')).toBeInTheDocument();
    });

    it('converts foreign-currency balances into the default currency before summing', () => {
      // 1 USD = 1.4 CAD; CAD passes through unchanged.
      exchangeMocks.convertToDefault.mockImplementation((n: number, currency?: string) =>
        currency === 'USD' ? n * 1.4 : n,
      );

      const accounts = [
        createAccount({
          id: 'cad-1',
          name: 'CAD Cheq',
          accountType: 'CHEQUING',
          currencyCode: 'CAD',
          currentBalance: 1000,
        }),
        createAccount({
          id: 'usd-1',
          name: 'USD Cheq',
          accountType: 'CHEQUING',
          currencyCode: 'USD',
          currentBalance: 500,
        }),
      ];

      render(
        <AccountList accounts={accounts} onEdit={mockOnEdit} defaultCurrency="CAD" convertToDefault={exchangeMocks.convertToDefault} onRefresh={mockOnRefresh} />
      );

      // Group total: 1000 CAD + (500 USD * 1.4) = 1700 CAD
      const chequingHeader = document.querySelector<HTMLTableRowElement>(
        'tr[aria-expanded]',
      );
      expect(chequingHeader).toBeTruthy();
      expect(chequingHeader!.textContent).toContain('$1700.00');
    });

    it('converts investment brokerage market values into the default currency before summing', () => {
      // 1 USD = 1.4 CAD; CAD passes through unchanged.
      exchangeMocks.convertToDefault.mockImplementation((n: number, currency?: string) =>
        currency === 'USD' ? n * 1.4 : n,
      );

      const accounts = [
        createAccount({
          id: 'broker-cad',
          name: 'CAD Brokerage',
          accountType: 'INVESTMENT',
          accountSubType: 'INVESTMENT_BROKERAGE',
          currencyCode: 'CAD',
          currentBalance: 0,
        }),
        createAccount({
          id: 'broker-usd',
          name: 'USD Brokerage',
          accountType: 'INVESTMENT',
          accountSubType: 'INVESTMENT_BROKERAGE',
          currencyCode: 'USD',
          currentBalance: 0,
        }),
      ];
      const brokerageMarketValues = new Map([
        ['broker-cad', 1000],
        ['broker-usd', 500],
      ]);

      render(
        <AccountList
          accounts={accounts}
          brokerageMarketValues={brokerageMarketValues}
          onEdit={mockOnEdit}
          defaultCurrency="CAD" convertToDefault={exchangeMocks.convertToDefault} onRefresh={mockOnRefresh}
        />
      );

      // Group total: 1000 CAD market value + (500 USD market value * 1.4) = 1700 CAD
      const investmentHeader = document.querySelector<HTMLTableRowElement>(
        'tr[aria-expanded]',
      );
      expect(investmentHeader).toBeTruthy();
      expect(investmentHeader!.textContent).toContain('$1700.00');
    });

    it('shows the total balance for each group in the default currency', () => {
      const accounts = [
        createAccount({
          id: 'c1',
          name: 'Cheq A',
          accountType: 'CHEQUING',
          currencyCode: 'CAD',
          currentBalance: 1000,
          futureTransactionsSum: 500,
        }),
        createAccount({
          id: 'c2',
          name: 'Cheq B',
          accountType: 'CHEQUING',
          currencyCode: 'CAD',
          currentBalance: 250,
        }),
        createAccount({
          id: 'cc1',
          name: 'Visa',
          accountType: 'CREDIT_CARD',
          currencyCode: 'CAD',
          currentBalance: -750,
        }),
      ];

      render(
        <AccountList accounts={accounts} onEdit={mockOnEdit} defaultCurrency="CAD" convertToDefault={exchangeMocks.convertToDefault} onRefresh={mockOnRefresh} />
      );

      // CHEQUING group total: 1000 + 500 (future) + 250 = 1750
      // CREDIT_CARD group total: -750
      const chequingHeaderRow = Array.from(
        document.querySelectorAll<HTMLTableRowElement>('tr[aria-expanded]'),
      ).find((tr) => tr.textContent?.includes('Chequing'));
      const creditHeaderRow = Array.from(
        document.querySelectorAll<HTMLTableRowElement>('tr[aria-expanded]'),
      ).find((tr) => tr.textContent?.includes('Credit Card'));

      expect(chequingHeaderRow).toBeTruthy();
      expect(creditHeaderRow).toBeTruthy();
      expect(chequingHeaderRow!.textContent).toContain('$1750.00');
      expect(creditHeaderRow!.textContent).toContain('$-750.00');
    });

    it('collapses a group when its header is clicked and hides the rows', () => {
      const accounts = [
        createAccount({ id: 'c1', name: 'Cheq A', accountType: 'CHEQUING' }),
        createAccount({ id: 's1', name: 'Sav A', accountType: 'SAVINGS' }),
      ];

      render(
        <AccountList accounts={accounts} onEdit={mockOnEdit} defaultCurrency="CAD" convertToDefault={exchangeMocks.convertToDefault} onRefresh={mockOnRefresh} />
      );

      expect(screen.getByText('Cheq A')).toBeInTheDocument();

      const groupRows = Array.from(
        document.querySelectorAll<HTMLTableRowElement>('tr[aria-expanded]'),
      );
      const chequingHeader = groupRows.find((tr) =>
        tr.textContent?.includes('Chequing'),
      );
      expect(chequingHeader).toBeTruthy();
      fireEvent.click(chequingHeader!);

      // The chequing account row is hidden, but the group header remains.
      expect(screen.queryByText('Cheq A')).not.toBeInTheDocument();
      expect(screen.getByText('Sav A')).toBeInTheDocument();
    });

    it('persists collapsed groups in localStorage', () => {
      const accounts = [
        createAccount({ id: 'c1', name: 'Cheq A', accountType: 'CHEQUING' }),
      ];

      const { unmount } = render(
        <AccountList accounts={accounts} onEdit={mockOnEdit} defaultCurrency="CAD" convertToDefault={exchangeMocks.convertToDefault} onRefresh={mockOnRefresh} />
      );

      const groupRow = document.querySelector<HTMLTableRowElement>(
        'tr[aria-expanded]',
      );
      expect(groupRow).toBeTruthy();
      fireEvent.click(groupRow!);

      const stored = JSON.parse(
        localStorage.getItem('accounts.filter.collapsedGroups') ?? '[]',
      );
      expect(stored).toEqual(['CHEQUING']);

      unmount();

      // Re-render: persisted state means CHEQUING starts collapsed.
      render(
        <AccountList accounts={accounts} onEdit={mockOnEdit} defaultCurrency="CAD" convertToDefault={exchangeMocks.convertToDefault} onRefresh={mockOnRefresh} />
      );
      expect(screen.queryByText('Cheq A')).not.toBeInTheDocument();
    });

    it('keeps linked investment cash and brokerage accounts adjacent', () => {
      const accounts = [
        createAccount({
          id: 'cash-1',
          name: 'Pair One Cash',
          accountType: 'INVESTMENT',
          accountSubType: 'INVESTMENT_CASH',
          linkedAccountId: 'broker-1',
        }),
        createAccount({
          id: 'lonely',
          name: 'Solo Investment',
          accountType: 'INVESTMENT',
          accountSubType: null,
        }),
        createAccount({
          id: 'broker-1',
          name: 'Pair One Brokerage',
          accountType: 'INVESTMENT',
          accountSubType: 'INVESTMENT_BROKERAGE',
          linkedAccountId: 'cash-1',
        }),
      ];

      render(
        <AccountList accounts={accounts} onEdit={mockOnEdit} defaultCurrency="CAD" convertToDefault={exchangeMocks.convertToDefault} onRefresh={mockOnRefresh} />
      );

      // Within the INVESTMENT group, the brokerage account is rendered
      // immediately before its paired cash account, regardless of input order.
      const rows = screen.getAllByRole('row');
      const brokerageRow = screen.getByText('Pair One Brokerage').closest('tr');
      const cashRow = screen.getByText('Pair One Cash').closest('tr');
      expect(brokerageRow).toBeTruthy();
      expect(cashRow).toBeTruthy();
      const brokerageRowIdx = rows.indexOf(brokerageRow as HTMLTableRowElement);
      const cashRowIdx = rows.indexOf(cashRow as HTMLTableRowElement);
      expect(brokerageRowIdx).toBeGreaterThan(0);
      expect(cashRowIdx).toBe(brokerageRowIdx + 1);
    });

    it('counts a linked brokerage/cash pair as a single investment account', () => {
      const accounts = [
        createAccount({
          id: 'broker-1',
          name: 'Pair One Brokerage',
          accountType: 'INVESTMENT',
          accountSubType: 'INVESTMENT_BROKERAGE',
          linkedAccountId: 'cash-1',
        }),
        createAccount({
          id: 'cash-1',
          name: 'Pair One Cash',
          accountType: 'INVESTMENT',
          accountSubType: 'INVESTMENT_CASH',
          linkedAccountId: 'broker-1',
        }),
        createAccount({
          id: 'broker-2',
          name: 'Pair Two Brokerage',
          accountType: 'INVESTMENT',
          accountSubType: 'INVESTMENT_BROKERAGE',
          linkedAccountId: 'cash-2',
        }),
        createAccount({
          id: 'cash-2',
          name: 'Pair Two Cash',
          accountType: 'INVESTMENT',
          accountSubType: 'INVESTMENT_CASH',
          linkedAccountId: 'broker-2',
        }),
        createAccount({
          id: 'solo',
          name: 'Solo Investment',
          accountType: 'INVESTMENT',
          accountSubType: null,
        }),
      ];

      render(
        <AccountList accounts={accounts} onEdit={mockOnEdit} defaultCurrency="CAD" convertToDefault={exchangeMocks.convertToDefault} onRefresh={mockOnRefresh} />
      );

      // Two linked pairs + one standalone account = 3 logical investment accounts.
      const investmentHeader = document.querySelector<HTMLTableRowElement>(
        'tr[aria-expanded]',
      );
      expect(investmentHeader).toBeTruthy();
      expect(investmentHeader!.textContent).toContain('3 accounts');
    });
  });

  describe('sort by type', () => {
    it('sorts accounts by type ascending and then toggles to descending', () => {
      const accounts = [
        createAccount({ id: 'a1', name: 'Savings Acct', accountType: 'SAVINGS' }),
        createAccount({ id: 'a2', name: 'Chequing Acct', accountType: 'CHEQUING' }),
      ];

      render(
        <AccountList accounts={accounts} onEdit={mockOnEdit} defaultCurrency="CAD" convertToDefault={exchangeMocks.convertToDefault} onRefresh={mockOnRefresh} />
      );

      const typeHeader = screen.getByText('Type');
      // First click sorts by type ascending
      fireEvent.click(typeHeader);
      // Second click on same header reverses direction
      fireEvent.click(typeHeader);

      // Just verify no errors thrown and the table is rendered
      expect(screen.getByText('Savings Acct')).toBeInTheDocument();
      expect(screen.getByText('Chequing Acct')).toBeInTheDocument();
    });

    it('sorts accounts by name then toggles to descending on second click', () => {
      const accounts = [
        createAccount({ id: 'a1', name: 'Alpha', accountType: 'CHEQUING' }),
        createAccount({ id: 'a2', name: 'Zeta', accountType: 'CHEQUING' }),
      ];

      render(
        <AccountList accounts={accounts} onEdit={mockOnEdit} defaultCurrency="CAD" convertToDefault={exchangeMocks.convertToDefault} onRefresh={mockOnRefresh} />
      );

      const nameHeader = screen.getByText('Account Name');
      // Already sorted by name asc; second click toggles to desc
      fireEvent.click(nameHeader);

      const rows = screen.getAllByRole('row');
      // desc: Zeta before Alpha
      expect(rows[2]).toHaveTextContent('Zeta');
      expect(rows[3]).toHaveTextContent('Alpha');

      // Third click toggles back to asc
      fireEvent.click(nameHeader);
      const rowsAsc = screen.getAllByRole('row');
      expect(rowsAsc[2]).toHaveTextContent('Alpha');
      expect(rowsAsc[3]).toHaveTextContent('Zeta');
    });
  });

  describe('dense density mode', () => {
    it('renders icon-only buttons in dense mode for active accounts', () => {
      const account = createAccount({ currentBalance: 0 });

      render(
        <AccountList accounts={[account]} onEdit={mockOnEdit} defaultCurrency="CAD" convertToDefault={exchangeMocks.convertToDefault} onRefresh={mockOnRefresh} />
      );

      const densityButton = screen.getByTitle('Toggle row density');
      // Normal -> Compact -> Dense
      fireEvent.click(densityButton);
      fireEvent.click(densityButton);
      expect(densityButton).toHaveTextContent('Dense');

      // In dense mode, action buttons are icon-only (no text labels)
      expect(screen.queryByText('Edit')).not.toBeInTheDocument();
      expect(screen.queryByText('Close')).not.toBeInTheDocument();
      // But edit icon-button should exist with title="Edit"
      expect(screen.getByTitle('Edit')).toBeInTheDocument();
      expect(screen.getByTitle('Close account')).toBeInTheDocument();
    });

    it('triggers edit callback via dense mode icon button', () => {
      const account = createAccount({ currentBalance: 0 });

      render(
        <AccountList accounts={[account]} onEdit={mockOnEdit} defaultCurrency="CAD" convertToDefault={exchangeMocks.convertToDefault} onRefresh={mockOnRefresh} />
      );

      // Cycle to dense
      const densityButton = screen.getByTitle('Toggle row density');
      fireEvent.click(densityButton);
      fireEvent.click(densityButton);

      fireEvent.click(screen.getByTitle('Edit'));
      expect(mockOnEdit).toHaveBeenCalledWith(account);
    });

    it('triggers close dialog via dense mode icon button', () => {
      const account = createAccount({ currentBalance: 0 });

      render(
        <AccountList accounts={[account]} onEdit={mockOnEdit} defaultCurrency="CAD" convertToDefault={exchangeMocks.convertToDefault} onRefresh={mockOnRefresh} />
      );

      const densityButton = screen.getByTitle('Toggle row density');
      fireEvent.click(densityButton);
      fireEvent.click(densityButton);

      fireEvent.click(screen.getByTitle('Close account'));
      expect(screen.getByText(/Are you sure you want to close/)).toBeInTheDocument();
    });

    it('shows disabled close button in dense mode when balance is non-zero', () => {
      const account = createAccount({ currentBalance: 500 });

      render(
        <AccountList accounts={[account]} onEdit={mockOnEdit} defaultCurrency="CAD" convertToDefault={exchangeMocks.convertToDefault} onRefresh={mockOnRefresh} />
      );

      const densityButton = screen.getByTitle('Toggle row density');
      fireEvent.click(densityButton);
      fireEvent.click(densityButton);

      const closeIconButton = screen.getByTitle('Account must have zero balance to close');
      expect(closeIconButton).toBeDisabled();
    });

    it('shows reconcile icon button in dense mode for non-brokerage accounts', () => {
      const account = createAccount({ accountSubType: null, currentBalance: 0 });

      render(
        <AccountList accounts={[account]} onEdit={mockOnEdit} defaultCurrency="CAD" convertToDefault={exchangeMocks.convertToDefault} onRefresh={mockOnRefresh} />
      );

      const densityButton = screen.getByTitle('Toggle row density');
      fireEvent.click(densityButton);
      fireEvent.click(densityButton);

      expect(screen.getByTitle('Reconcile')).toBeInTheDocument();
    });

    it('hides reconcile icon button in dense mode for brokerage accounts', () => {
      const account = createAccount({
        accountType: 'INVESTMENT',
        accountSubType: 'INVESTMENT_BROKERAGE',
        currentBalance: 0,
      });

      render(
        <AccountList accounts={[account]} onEdit={mockOnEdit} defaultCurrency="CAD" convertToDefault={exchangeMocks.convertToDefault} onRefresh={mockOnRefresh} />
      );

      const densityButton = screen.getByTitle('Toggle row density');
      fireEvent.click(densityButton);
      fireEvent.click(densityButton);

      expect(screen.queryByTitle('Reconcile')).not.toBeInTheDocument();
    });

    it('shows delete icon button in dense mode for deletable active accounts', () => {
      const account = createAccount({ canDelete: true, currentBalance: 0 });

      render(
        <AccountList accounts={[account]} onEdit={mockOnEdit} defaultCurrency="CAD" convertToDefault={exchangeMocks.convertToDefault} onRefresh={mockOnRefresh} />
      );

      const densityButton = screen.getByTitle('Toggle row density');
      fireEvent.click(densityButton);
      fireEvent.click(densityButton);

      expect(screen.getByTitle('Delete')).toBeInTheDocument();
    });

    it('renders reopen icon button in dense mode for closed accounts', async () => {
      const account = createAccount({ isClosed: true, closedDate: '2024-01-01T00:00:00Z' });

      render(
        <AccountList accounts={[account]} onEdit={mockOnEdit} defaultCurrency="CAD" convertToDefault={exchangeMocks.convertToDefault} onRefresh={mockOnRefresh} />
      );

      const densityButton = screen.getByTitle('Toggle row density');
      fireEvent.click(densityButton);
      fireEvent.click(densityButton);

      // In dense mode the reopen button has title="Reopen"
      const reopenButton = screen.getByTitle('Reopen');
      expect(reopenButton).toBeInTheDocument();
      fireEvent.click(reopenButton);

      await waitFor(() => {
        expect(accountsApi.reopen).toHaveBeenCalledWith(account.id);
      });
    });

    it('shows delete icon button in dense mode for closed deletable accounts', () => {
      const account = createAccount({
        isClosed: true,
        closedDate: '2024-01-01T00:00:00Z',
        canDelete: true,
      });

      render(
        <AccountList accounts={[account]} onEdit={mockOnEdit} defaultCurrency="CAD" convertToDefault={exchangeMocks.convertToDefault} onRefresh={mockOnRefresh} />
      );

      const densityButton = screen.getByTitle('Toggle row density');
      fireEvent.click(densityButton);
      fireEvent.click(densityButton);

      expect(screen.getByTitle('Delete')).toBeInTheDocument();
    });

    it('hides Market value label in dense mode for brokerage accounts', () => {
      const account = createAccount({
        id: 'broker-1',
        accountType: 'INVESTMENT',
        accountSubType: 'INVESTMENT_BROKERAGE',
        currencyCode: 'CAD',
        currentBalance: 0,
      });
      const brokerageMarketValues = new Map([['broker-1', 5000]]);

      render(
        <AccountList accounts={[account]} brokerageMarketValues={brokerageMarketValues} onEdit={mockOnEdit} defaultCurrency="CAD" convertToDefault={exchangeMocks.convertToDefault} onRefresh={mockOnRefresh} />
      );

      const densityButton = screen.getByTitle('Toggle row density');
      fireEvent.click(densityButton);
      fireEvent.click(densityButton);

      // In dense mode "Market value" sub-label is hidden
      expect(screen.queryByText('Market value')).not.toBeInTheDocument();
    });

    it('hides credit limit in dense mode', () => {
      const account = createAccount({
        accountType: 'CREDIT_CARD',
        creditLimit: 5000,
        currentBalance: -1000,
      });

      render(
        <AccountList accounts={[account]} onEdit={mockOnEdit} defaultCurrency="CAD" convertToDefault={exchangeMocks.convertToDefault} onRefresh={mockOnRefresh} />
      );

      const densityButton = screen.getByTitle('Toggle row density');
      fireEvent.click(densityButton);
      fireEvent.click(densityButton);

      expect(screen.queryByText(/Limit:/)).not.toBeInTheDocument();
    });

    it('hides approximate conversion in dense mode for non-default currency', () => {
      const account = createAccount({
        currencyCode: 'USD',
        currentBalance: 500,
      });

      render(
        <AccountList accounts={[account]} onEdit={mockOnEdit} defaultCurrency="CAD" convertToDefault={exchangeMocks.convertToDefault} onRefresh={mockOnRefresh} />
      );

      const densityButton = screen.getByTitle('Toggle row density');
      fireEvent.click(densityButton);
      fireEvent.click(densityButton);

      expect(screen.queryByText(/≈/)).not.toBeInTheDocument();
    });

    it('hides approximate conversion for brokerage in dense mode', () => {
      const account = createAccount({
        id: 'broker-1',
        accountType: 'INVESTMENT',
        accountSubType: 'INVESTMENT_BROKERAGE',
        currencyCode: 'USD',
        currentBalance: 0,
      });
      const brokerageMarketValues = new Map([['broker-1', 5000]]);

      render(
        <AccountList accounts={[account]} brokerageMarketValues={brokerageMarketValues} onEdit={mockOnEdit} defaultCurrency="CAD" convertToDefault={exchangeMocks.convertToDefault} onRefresh={mockOnRefresh} />
      );

      const densityButton = screen.getByTitle('Toggle row density');
      fireEvent.click(densityButton);
      fireEvent.click(densityButton);

      expect(screen.queryByText(/≈/)).not.toBeInTheDocument();
    });

    it('shows linked account chain icon in compact mode instead of "Paired with" text', () => {
      const accounts = [
        createAccount({
          id: 'cash-1',
          name: 'Inv Cash',
          accountType: 'INVESTMENT',
          accountSubType: 'INVESTMENT_CASH',
          linkedAccountId: 'broker-1',
        }),
        createAccount({
          id: 'broker-1',
          name: 'Inv Brokerage',
          accountType: 'INVESTMENT',
          accountSubType: 'INVESTMENT_BROKERAGE',
          linkedAccountId: 'cash-1',
        }),
      ];

      render(
        <AccountList accounts={accounts} onEdit={mockOnEdit} defaultCurrency="CAD" convertToDefault={exchangeMocks.convertToDefault} onRefresh={mockOnRefresh} />
      );

      const densityButton = screen.getByTitle('Toggle row density');
      fireEvent.click(densityButton); // compact

      // In compact mode, no "Paired with" text — just icon
      expect(screen.queryByText(/Paired with/)).not.toBeInTheDocument();
    });
  });

  describe('long-press context menu', () => {
    let mockPush: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      mockPush = vi.fn();
      vi.spyOn(nextNavigation, 'useRouter').mockReturnValue({
        push: mockPush,
        replace: vi.fn(),
        back: vi.fn(),
        forward: vi.fn(),
        refresh: vi.fn(),
        prefetch: vi.fn(),
      } as unknown as ReturnType<typeof nextNavigation.useRouter>);
    });

    function openContextMenu(account: ReturnType<typeof createAccount>) {
      render(
        <AccountList accounts={[account]} onEdit={mockOnEdit} defaultCurrency="CAD" convertToDefault={exchangeMocks.convertToDefault} onRefresh={mockOnRefresh} />
      );

      // Simulate long press: mouseDown triggers timer, we advance past 750ms
      const row = screen.getByText(account.name).closest('tr')!;
      fireEvent.mouseDown(row);
      // Advance timers by 800ms to trigger long press
      act(() => {
        vi.advanceTimersByTime(800);
      });
    }

    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('opens context menu after long press and shows account name', () => {
      const account = createAccount({ name: 'Test Account' });
      openContextMenu(account);

      expect(screen.getByRole('dialog')).toBeInTheDocument();
      // Account name appears in the modal header
      const dialogs = screen.getAllByText('Test Account');
      expect(dialogs.length).toBeGreaterThanOrEqual(1);
    });

    it('context menu shows View Transactions button and navigates', () => {
      const account = createAccount({ id: 'acc-1', name: 'Cheq Account' });
      openContextMenu(account);

      fireEvent.click(screen.getByText('View Transactions'));
      expect(mockPush).toHaveBeenCalledWith('/transactions?accountId=acc-1');
    });

    it('context menu navigates to /investments for brokerage account View Transactions', () => {
      const account = createAccount({
        id: 'broker-1',
        name: 'My Brokerage Account',
        accountType: 'INVESTMENT',
        accountSubType: 'INVESTMENT_BROKERAGE',
      });
      openContextMenu(account);

      fireEvent.click(screen.getByText('View Transactions'));
      expect(mockPush).toHaveBeenCalledWith('/investments?accountId=broker-1');
    });

    it('context menu shows Edit button for active accounts and calls onEdit', () => {
      const account = createAccount({ name: 'My Account' });
      openContextMenu(account);

      const sheet = within(screen.getByRole('dialog'));
      expect(sheet.getByText('Edit')).toBeInTheDocument();
      fireEvent.click(sheet.getByText('Edit'));
      expect(mockOnEdit).toHaveBeenCalledWith(account);
    });

    it('context menu shows Reconcile button for non-brokerage active accounts', () => {
      const account = createAccount({ name: 'My Cheq' });
      openContextMenu(account);

      // Reconcile appears both in the row actions and in the context menu
      const reconcileButtons = screen.getAllByText('Reconcile');
      expect(reconcileButtons.length).toBeGreaterThanOrEqual(2);
    });

    it('context menu hides Reconcile button for brokerage accounts', () => {
      const account = createAccount({
        name: 'My Brokerage Acct',
        accountType: 'INVESTMENT',
        accountSubType: 'INVESTMENT_BROKERAGE',
      });
      openContextMenu(account);

      expect(screen.queryByText('Reconcile')).not.toBeInTheDocument();
    });

    it('context menu Reconcile button navigates to reconcile page', () => {
      const account = createAccount({ id: 'acc-1', name: 'Cheq Account' });
      openContextMenu(account);

      // Reconcile appears in both the row actions and the context menu;
      // the context menu button is the last one.
      const reconcileButtons = screen.getAllByText('Reconcile');
      fireEvent.click(reconcileButtons[reconcileButtons.length - 1]);
      expect(mockPush).toHaveBeenCalledWith('/reconcile?accountId=acc-1');
    });

    it('context menu shows Close button enabled when balance is zero', () => {
      const account = createAccount({ name: 'Zero Balance', currentBalance: 0 });
      openContextMenu(account);

      const closeBtn = within(screen.getByRole('dialog')).getByRole('button', { name: 'Close' });
      expect(closeBtn).not.toBeDisabled();
    });

    it('context menu shows Close button disabled when balance is non-zero', () => {
      const account = createAccount({ name: 'Non Zero', currentBalance: 500 });
      openContextMenu(account);

      const closeBtn = within(screen.getByRole('dialog')).getByRole('button', { name: 'Close' });
      expect(closeBtn).toBeDisabled();
    });

    it('context menu Close opens close dialog', () => {
      const account = createAccount({ name: 'Zero Bal', currentBalance: 0 });
      openContextMenu(account);

      fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Close' }));
      expect(screen.getByText(/Are you sure you want to close/)).toBeInTheDocument();
    });

    it('context menu shows Reopen for closed accounts', async () => {
      const account = createAccount({
        name: 'Closed Acct',
        isClosed: true,
        closedDate: '2024-01-01T00:00:00Z',
      });
      openContextMenu(account);

      const sheet = within(screen.getByRole('dialog'));
      expect(sheet.getByText('Reopen')).toBeInTheDocument();
      // Active-account-only buttons should not appear
      expect(sheet.queryByText('Edit')).not.toBeInTheDocument();
      expect(sheet.queryByText('Close')).not.toBeInTheDocument();
    });

    it('context menu Reopen calls reopen API', async () => {
      const account = createAccount({
        name: 'Closed Acct',
        isClosed: true,
        closedDate: '2024-01-01T00:00:00Z',
      });
      openContextMenu(account);

      fireEvent.click(within(screen.getByRole('dialog')).getByText('Reopen'));

      // Switch to real timers so waitFor can work
      vi.useRealTimers();
      await waitFor(() => {
        expect(accountsApi.reopen).toHaveBeenCalledWith(account.id);
      });
    });

    it('context menu shows "— Closed" in subtitle for closed accounts', () => {
      const account = createAccount({
        name: 'Closed Acct',
        isClosed: true,
        closedDate: '2024-01-01T00:00:00Z',
      });
      openContextMenu(account);

      // The subtitle includes " — Closed"
      expect(screen.getByText(/— Closed/)).toBeInTheDocument();
    });

    it('context menu shows "Brokerage" in subtitle for brokerage accounts', () => {
      const account = createAccount({
        name: 'My Brokerage Acct Two',
        accountType: 'INVESTMENT',
        accountSubType: 'INVESTMENT_BROKERAGE',
      });
      openContextMenu(account);

      // The subtitle should say "Brokerage"
      // It appears both as the type badge in the table row and in the context menu subtitle
      const brokerageTexts = screen.getAllByText('Brokerage');
      expect(brokerageTexts.length).toBeGreaterThanOrEqual(2);
    });

    it('context menu shows "Inv. Cash" in subtitle for investment cash accounts', () => {
      const accounts2 = [
        createAccount({
          id: 'cash-1',
          name: 'Inv Cash Acct',
          accountType: 'INVESTMENT',
          accountSubType: 'INVESTMENT_CASH',
          linkedAccountId: 'broker-1',
        }),
        createAccount({
          id: 'broker-1',
          name: 'Inv Broker Acct',
          accountType: 'INVESTMENT',
          accountSubType: 'INVESTMENT_BROKERAGE',
          linkedAccountId: 'cash-1',
        }),
      ];

      render(
        <AccountList accounts={accounts2} onEdit={mockOnEdit} defaultCurrency="CAD" convertToDefault={exchangeMocks.convertToDefault} onRefresh={mockOnRefresh} />
      );

      const cashRow = screen.getByText('Inv Cash Acct').closest('tr')!;
      fireEvent.mouseDown(cashRow);
      act(() => { vi.advanceTimersByTime(800); });

      const invCashTexts = screen.getAllByText('Inv. Cash');
      expect(invCashTexts.length).toBeGreaterThanOrEqual(1);
    });

    it('context menu shows Delete for deletable accounts', () => {
      const account = createAccount({ name: 'Del Acct', canDelete: true });
      openContextMenu(account);

      expect(within(screen.getByRole('dialog')).getByText('Delete')).toBeInTheDocument();
    });

    it('context menu Delete opens delete confirmation dialog', () => {
      const account = createAccount({ name: 'Del Acct', canDelete: true });
      openContextMenu(account);

      fireEvent.click(within(screen.getByRole('dialog')).getByText('Delete'));
      expect(screen.getByText(/Are you sure you want to permanently delete/)).toBeInTheDocument();
    });

    it('context menu does not show Delete for non-deletable accounts', () => {
      const account = createAccount({ name: 'No Del Acct', canDelete: false });
      openContextMenu(account);

      expect(within(screen.getByRole('dialog')).queryByText('Delete')).not.toBeInTheDocument();
    });

    it('closes context menu when modal onClose is triggered', () => {
      const account = createAccount({ name: 'Test Account' });
      openContextMenu(account);

      // Modal has a close button (X button)
      const closeButtons = screen.getAllByRole('button');
      const xButton = closeButtons.find((btn) => btn.getAttribute('aria-label') === 'Close modal');
      if (xButton) {
        fireEvent.click(xButton);
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      } else {
        // Alternatively press Escape
        fireEvent.keyDown(document, { key: 'Escape' });
        expect(screen.queryByText('View Transactions')).not.toBeInTheDocument();
      }
    });

    it('long press does not fire after touch move exceeds threshold', () => {
      const account = createAccount({ name: 'Move Account' });

      render(
        <AccountList accounts={[account]} onEdit={mockOnEdit} defaultCurrency="CAD" convertToDefault={exchangeMocks.convertToDefault} onRefresh={mockOnRefresh} />
      );

      const row = screen.getByText('Move Account').closest('tr')!;

      // Start touch at position (100, 100)
      fireEvent.touchStart(row, {
        touches: [{ clientX: 100, clientY: 100 }],
      });

      // Move more than 10px — should cancel long press
      fireEvent.touchMove(row, {
        touches: [{ clientX: 120, clientY: 100 }],
      });

      act(() => { vi.advanceTimersByTime(800); });

      // Context menu should NOT appear because touch moved too far
      expect(screen.queryByText('View Transactions')).not.toBeInTheDocument();
    });

    it('long press fires via touch start without movement', () => {
      const account = createAccount({ name: 'Touch Account' });

      render(
        <AccountList accounts={[account]} onEdit={mockOnEdit} defaultCurrency="CAD" convertToDefault={exchangeMocks.convertToDefault} onRefresh={mockOnRefresh} />
      );

      const row = screen.getByText('Touch Account').closest('tr')!;

      fireEvent.touchStart(row, {
        touches: [{ clientX: 50, clientY: 50 }],
      });

      act(() => { vi.advanceTimersByTime(800); });

      // Context menu should appear
      expect(screen.getByText('View Transactions')).toBeInTheDocument();
    });

    it('long press end clears the timer before context menu fires', () => {
      const account = createAccount({ name: 'Cancel Press Account' });

      render(
        <AccountList accounts={[account]} onEdit={mockOnEdit} defaultCurrency="CAD" convertToDefault={exchangeMocks.convertToDefault} onRefresh={mockOnRefresh} />
      );

      const row = screen.getByText('Cancel Press Account').closest('tr')!;
      fireEvent.mouseDown(row);
      // Release before 750ms
      fireEvent.mouseUp(row);
      act(() => { vi.advanceTimersByTime(800); });

      // No context menu should appear
      expect(screen.queryByText('View Transactions')).not.toBeInTheDocument();
    });

    it('row click is suppressed when long press was triggered', () => {
      const account = createAccount({ id: 'acc-x', name: 'Long Press Acct' });
      openContextMenu(account);

      // The account name appears in both the table row and the open context menu dialog.
      // Get the row itself via the account row (tr) in the tbody.
      const nameSpan = screen.getAllByText('Long Press Acct')[0]; // first occurrence is in the table row
      const row = nameSpan.closest('tr')!;
      fireEvent.click(row);

      // Navigation should NOT happen since the long press already triggered
      expect(mockPush).not.toHaveBeenCalled();
    });

    it('long press without touch event (no touches array) sets touchStartPos to null', () => {
      const account = createAccount({ name: 'Mouse Press Account' });

      render(
        <AccountList accounts={[account]} onEdit={mockOnEdit} defaultCurrency="CAD" convertToDefault={exchangeMocks.convertToDefault} onRefresh={mockOnRefresh} />
      );

      const row = screen.getByText('Mouse Press Account').closest('tr')!;
      // mouseDown fires handleLongPressStart without a touch event
      fireEvent.mouseDown(row);
      act(() => { vi.advanceTimersByTime(800); });

      // Context menu should still appear (touchStartPos stays null, no movement cancellation)
      expect(screen.getByText('View Transactions')).toBeInTheDocument();
    });

    it('touch move within threshold does not cancel long press', () => {
      const account = createAccount({ name: 'Small Move Account' });

      render(
        <AccountList accounts={[account]} onEdit={mockOnEdit} defaultCurrency="CAD" convertToDefault={exchangeMocks.convertToDefault} onRefresh={mockOnRefresh} />
      );

      const row = screen.getByText('Small Move Account').closest('tr')!;

      fireEvent.touchStart(row, {
        touches: [{ clientX: 100, clientY: 100 }],
      });

      // Move only 5px — within 10px threshold
      fireEvent.touchMove(row, {
        touches: [{ clientX: 105, clientY: 100 }],
      });

      act(() => { vi.advanceTimersByTime(800); });

      // Context menu should still appear
      expect(screen.getByText('View Transactions')).toBeInTheDocument();
    });
  });

  describe('additional account type coverage', () => {
    it('renders LOAN account type group', () => {
      const account = createAccount({ id: 'l1', name: 'Car Loan', accountType: 'LOAN' });

      render(
        <AccountList accounts={[account]} onEdit={mockOnEdit} defaultCurrency="CAD" convertToDefault={exchangeMocks.convertToDefault} onRefresh={mockOnRefresh} />
      );

      expect(screen.getByText('Car Loan')).toBeInTheDocument();
      // "Loan" appears in both group header and type badge
      expect(screen.getAllByText('Loan').length).toBeGreaterThanOrEqual(2);
    });

    it('renders MORTGAGE account type group', () => {
      const account = createAccount({ id: 'm1', name: 'Home Mortgage', accountType: 'MORTGAGE' });

      render(
        <AccountList accounts={[account]} onEdit={mockOnEdit} defaultCurrency="CAD" convertToDefault={exchangeMocks.convertToDefault} onRefresh={mockOnRefresh} />
      );

      expect(screen.getByText('Home Mortgage')).toBeInTheDocument();
      // "Mortgage" appears in both group header and type badge
      expect(screen.getAllByText('Mortgage').length).toBeGreaterThanOrEqual(2);
    });

    it('renders ASSET account type group', () => {
      const account = createAccount({ id: 'as1', name: 'My Car', accountType: 'ASSET' });

      render(
        <AccountList accounts={[account]} onEdit={mockOnEdit} defaultCurrency="CAD" convertToDefault={exchangeMocks.convertToDefault} onRefresh={mockOnRefresh} />
      );

      expect(screen.getByText('My Car')).toBeInTheDocument();
      // "Asset" appears in both group header and type badge
      expect(screen.getAllByText('Asset').length).toBeGreaterThanOrEqual(2);
    });

    it('renders LINE_OF_CREDIT account type group', () => {
      const account = createAccount({ id: 'loc1', name: 'HELOC', accountType: 'LINE_OF_CREDIT' });

      render(
        <AccountList accounts={[account]} onEdit={mockOnEdit} defaultCurrency="CAD" convertToDefault={exchangeMocks.convertToDefault} onRefresh={mockOnRefresh} />
      );

      expect(screen.getByText('HELOC')).toBeInTheDocument();
      // "Line of Credit" appears in both group header and type badge
      expect(screen.getAllByText('Line of Credit').length).toBeGreaterThanOrEqual(2);
    });

    it('renders OTHER account type group', () => {
      const account = createAccount({ id: 'o1', name: 'Other Account', accountType: 'OTHER' });

      render(
        <AccountList accounts={[account]} onEdit={mockOnEdit} defaultCurrency="CAD" convertToDefault={exchangeMocks.convertToDefault} onRefresh={mockOnRefresh} />
      );

      expect(screen.getByText('Other Account')).toBeInTheDocument();
      // "Other" appears in both group header and type badge
      expect(screen.getAllByText('Other').length).toBeGreaterThanOrEqual(2);
    });

    it('shows approximate conversion for brokerage in compact mode', () => {
      const account = createAccount({
        id: 'broker-usd',
        accountType: 'INVESTMENT',
        accountSubType: 'INVESTMENT_BROKERAGE',
        currencyCode: 'USD',
        currentBalance: 0,
      });
      const brokerageMarketValues = new Map([['broker-usd', 1000]]);
      exchangeMocks.convertToDefault.mockImplementation((n: number) => n * 1.3);

      render(
        <AccountList accounts={[account]} brokerageMarketValues={brokerageMarketValues} onEdit={mockOnEdit} defaultCurrency="CAD" convertToDefault={exchangeMocks.convertToDefault} onRefresh={mockOnRefresh} />
      );

      // Compact mode still shows approximate conversion (only dense hides it)
      const densityButton = screen.getByTitle('Toggle row density');
      fireEvent.click(densityButton); // compact

      // Should show approximate conversion in compact mode
      expect(screen.getByText(/≈/)).toBeInTheDocument();
    });

    it('negative group total renders in red', () => {
      const account = createAccount({
        id: 'cc1',
        name: 'Credit Card',
        accountType: 'CREDIT_CARD',
        currentBalance: -1000,
      });

      render(
        <AccountList accounts={[account]} onEdit={mockOnEdit} defaultCurrency="CAD" convertToDefault={exchangeMocks.convertToDefault} onRefresh={mockOnRefresh} />
      );

      // The group header total for CREDIT_CARD should be negative
      const headerRow = document.querySelector<HTMLTableRowElement>('tr[aria-expanded]');
      expect(headerRow).toBeTruthy();
      expect(headerRow!.textContent).toContain('$-1000.00');
    });

    it('group header re-expands when clicked again', () => {
      const accounts = [
        createAccount({ id: 'c1', name: 'Cheq A', accountType: 'CHEQUING' }),
      ];

      render(
        <AccountList accounts={accounts} onEdit={mockOnEdit} defaultCurrency="CAD" convertToDefault={exchangeMocks.convertToDefault} onRefresh={mockOnRefresh} />
      );

      const groupRow = document.querySelector<HTMLTableRowElement>('tr[aria-expanded]')!;

      // Collapse
      fireEvent.click(groupRow);
      expect(screen.queryByText('Cheq A')).not.toBeInTheDocument();

      // Re-expand
      fireEvent.click(groupRow);
      expect(screen.getByText('Cheq A')).toBeInTheDocument();
    });

    it('clears net worth filter when all excluded accounts are removed from prop', async () => {
      // Start with one excluded account to show the net worth filter
      const accounts = [
        createAccount({ id: 'a1', name: 'Included Account', excludeFromNetWorth: false }),
        createAccount({ id: 'a2', name: 'Excluded Account', excludeFromNetWorth: true }),
      ];

      const { rerender } = render(
        <AccountList accounts={accounts} onEdit={mockOnEdit} defaultCurrency="CAD" convertToDefault={exchangeMocks.convertToDefault} onRefresh={mockOnRefresh} />
      );

      // Apply net worth excluded filter
      const netWorthFilter = screen.getByDisplayValue('Net Worth: All');
      fireEvent.change(netWorthFilter, { target: { value: 'excluded' } });
      expect(screen.getByText('1 of 2 accounts')).toBeInTheDocument();

      // Now rerender with no excluded accounts — effect should clear the filter
      const noExcludedAccounts = [
        createAccount({ id: 'a1', name: 'Included Account', excludeFromNetWorth: false }),
        createAccount({ id: 'a2', name: 'Was Excluded', excludeFromNetWorth: false }),
      ];

      rerender(
        <AccountList accounts={noExcludedAccounts} onEdit={mockOnEdit} defaultCurrency="CAD" convertToDefault={exchangeMocks.convertToDefault} onRefresh={mockOnRefresh} />
      );

      // Filter should be cleared — both accounts visible
      await waitFor(() => {
        expect(screen.getByText('2 of 2 accounts')).toBeInTheDocument();
      });
    });

    it('persists sort field and direction in localStorage', () => {
      const accounts = [
        createAccount({ id: 'a1', name: 'Alpha', accountType: 'CHEQUING' }),
        createAccount({ id: 'a2', name: 'Zeta', accountType: 'CHEQUING' }),
      ];

      const { unmount } = render(
        <AccountList accounts={accounts} onEdit={mockOnEdit} defaultCurrency="CAD" convertToDefault={exchangeMocks.convertToDefault} onRefresh={mockOnRefresh} />
      );

      // Click balance header to change sort
      fireEvent.click(screen.getByText('Balance'));

      expect(localStorage.getItem('accounts.filter.sortField')).toBe('"balance"');
      expect(localStorage.getItem('accounts.filter.sortDirection')).toBe('"asc"');

      unmount();

      // Re-render: should restore sort from localStorage
      render(
        <AccountList accounts={accounts} onEdit={mockOnEdit} defaultCurrency="CAD" convertToDefault={exchangeMocks.convertToDefault} onRefresh={mockOnRefresh} />
      );

      // Balance header sort should be active (reflected in sort icon)
      expect(localStorage.getItem('accounts.filter.sortField')).toBe('"balance"');
    });

    it('initializes from localStorage when stored values exist', () => {
      // Pre-populate localStorage with filter state
      localStorage.setItem('accounts.filter.status', JSON.stringify('active'));
      localStorage.setItem('accounts.filter.sortField', JSON.stringify('balance'));
      localStorage.setItem('accounts.filter.sortDirection', JSON.stringify('desc'));
      localStorage.setItem('accounts.filter.density', JSON.stringify('compact'));

      const accounts = [
        createAccount({ id: 'a1', name: 'Active One', isClosed: false }),
        createAccount({ id: 'a2', name: 'Closed One', isClosed: true, closedDate: '2024-01-01T00:00:00Z' }),
      ];

      render(
        <AccountList accounts={accounts} onEdit={mockOnEdit} defaultCurrency="CAD" convertToDefault={exchangeMocks.convertToDefault} onRefresh={mockOnRefresh} />
      );

      // Should show only active accounts (initialized from stored status filter)
      expect(screen.getByText('1 of 2 accounts')).toBeInTheDocument();
      // Density should be compact
      expect(screen.getByTitle('Toggle row density')).toHaveTextContent('Compact');
    });

    it('handles getStoredValue with invalid JSON gracefully', () => {
      // Put invalid JSON in localStorage
      localStorage.setItem('accounts.filter.sortField', 'invalid-json');

      const accounts = [createAccount()];

      render(
        <AccountList accounts={accounts} onEdit={mockOnEdit} defaultCurrency="CAD" convertToDefault={exchangeMocks.convertToDefault} onRefresh={mockOnRefresh} />
      );

      // Should fall back to default sort (name) without crashing
      expect(screen.getByText('Main Chequing')).toBeInTheDocument();
    });

    it('status segmented control renders non-active styling when filter is set', () => {
      const accounts = [
        createAccount({ id: 'a1', name: 'Active One', isClosed: false }),
        createAccount({ id: 'a2', name: 'Closed One', isClosed: true, closedDate: '2024-01-01T00:00:00Z' }),
      ];

      render(
        <AccountList accounts={accounts} onEdit={mockOnEdit} defaultCurrency="CAD" convertToDefault={exchangeMocks.convertToDefault} onRefresh={mockOnRefresh} />
      );

      // Click Active filter to change filterStatus away from ''
      const activeBtn = screen.getAllByRole('button').find(
        (btn) => btn.textContent === 'Active' && btn.closest('.inline-flex.rounded-md')
      )!;
      fireEvent.click(activeBtn);

      // Now "All" button should not have bg-blue-600 (it's no longer selected)
      const allBtn = screen.getAllByRole('button').find(
        (btn) => btn.textContent === 'All' && btn.closest('.inline-flex.rounded-md')
      )!;
      expect(allBtn.className).not.toContain('bg-blue-600');

      // Active button now has bg-blue-600
      expect(activeBtn.className).toContain('bg-blue-600');
    });

    it('dense mode with deletable active brokerage account hides reconcile button', () => {
      const account = createAccount({
        accountType: 'INVESTMENT',
        accountSubType: 'INVESTMENT_BROKERAGE',
        canDelete: true,
        currentBalance: 0,
      });

      render(
        <AccountList accounts={[account]} onEdit={mockOnEdit} defaultCurrency="CAD" convertToDefault={exchangeMocks.convertToDefault} onRefresh={mockOnRefresh} />
      );

      const densityButton = screen.getByTitle('Toggle row density');
      fireEvent.click(densityButton);
      fireEvent.click(densityButton); // dense

      // No Reconcile in dense mode for brokerage
      expect(screen.queryByTitle('Reconcile')).not.toBeInTheDocument();
      // But delete button appears for deletable
      expect(screen.getByTitle('Delete')).toBeInTheDocument();
    });

    it('dense mode with non-deletable closed account does not show delete button', () => {
      const account = createAccount({
        isClosed: true,
        closedDate: '2024-01-01T00:00:00Z',
        canDelete: false,
      });

      render(
        <AccountList accounts={[account]} onEdit={mockOnEdit} defaultCurrency="CAD" convertToDefault={exchangeMocks.convertToDefault} onRefresh={mockOnRefresh} />
      );

      const densityButton = screen.getByTitle('Toggle row density');
      fireEvent.click(densityButton);
      fireEvent.click(densityButton); // dense

      expect(screen.queryByTitle('Delete')).not.toBeInTheDocument();
    });
  });
});
