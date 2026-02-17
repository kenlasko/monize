import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@/test/render';
import { TransactionFilterPanel } from './TransactionFilterPanel';
import { Account } from '@/types/account';
import { Category } from '@/types/category';
import { Payee } from '@/types/payee';

function createAccount(overrides: Partial<Account> = {}): Account {
  return {
    id: 'acc-1', userId: 'user-1', accountType: 'CHEQUING', accountSubType: null,
    linkedAccountId: null, name: 'Chequing', description: null, currencyCode: 'CAD',
    accountNumber: null, institution: null, openingBalance: 0, currentBalance: 1000,
    creditLimit: null, interestRate: null, isClosed: false, closedDate: null,
    isFavourite: false, paymentAmount: null, paymentFrequency: null, paymentStartDate: null,
    sourceAccountId: null, principalCategoryId: null, interestCategoryId: null,
    scheduledTransactionId: null, assetCategoryId: null, dateAcquired: null,
    isCanadianMortgage: false, isVariableRate: false, termMonths: null, termEndDate: null,
    amortizationMonths: null, originalPrincipal: null,
    createdAt: '2024-01-01T00:00:00Z', updatedAt: '2024-01-01T00:00:00Z',
    ...overrides,
  };
}

function createCategory(overrides: Partial<Category> = {}): Category {
  return {
    id: 'cat-1',
    userId: 'user-1',
    parentId: null,
    parent: null,
    children: [],
    name: 'Groceries',
    description: null,
    icon: null,
    color: null,
    effectiveColor: null,
    isIncome: false,
    isSystem: false,
    createdAt: '2024-01-01T00:00:00Z',
    ...overrides,
  };
}

function createPayee(overrides: Partial<Payee> = {}): Payee {
  return {
    id: 'payee-1',
    userId: 'user-1',
    name: 'Supermarket',
    defaultCategoryId: null,
    defaultCategory: null,
    notes: null,
    createdAt: '2024-01-01T00:00:00Z',
    ...overrides,
  };
}

describe('TransactionFilterPanel', () => {
  const defaultProps = {
    filterAccountIds: [] as string[],
    filterCategoryIds: [] as string[],
    filterPayeeIds: [] as string[],
    filterStartDate: '',
    filterEndDate: '',
    filterSearch: '',
    searchInput: '',
    filterAccountStatus: '' as 'active' | 'closed' | '',
    handleArrayFilterChange: vi.fn(),
    handleFilterChange: vi.fn(),
    handleSearchChange: vi.fn(),
    setFilterAccountStatus: vi.fn(),
    setFilterAccountIds: vi.fn(),
    setFilterCategoryIds: vi.fn(),
    setFilterPayeeIds: vi.fn(),
    setFilterStartDate: vi.fn(),
    setFilterEndDate: vi.fn(),
    setFilterSearch: vi.fn(),
    filtersExpanded: false,
    setFiltersExpanded: vi.fn(),
    activeFilterCount: 0,
    filteredAccounts: [] as Account[],
    selectedAccounts: [] as Account[],
    selectedCategories: [] as Category[],
    selectedPayees: [] as Payee[],
    accountFilterOptions: [],
    categoryFilterOptions: [],
    payeeFilterOptions: [],
    formatDate: vi.fn((d: string) => d),
    onClearFilters: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ----------------------------------------------------------------
  // Existing tests
  // ----------------------------------------------------------------

  it('renders the filter header with Filters text and Show toggle', () => {
    render(<TransactionFilterPanel {...defaultProps} />);

    expect(screen.getByText('Filters')).toBeInTheDocument();
    expect(screen.getByText('Show')).toBeInTheDocument();
  });

  it('displays Hide when filters are expanded', () => {
    render(<TransactionFilterPanel {...defaultProps} filtersExpanded={true} />);

    expect(screen.getByText('Hide')).toBeInTheDocument();
  });

  it('toggles filtersExpanded when header is clicked', () => {
    render(<TransactionFilterPanel {...defaultProps} filtersExpanded={false} />);

    fireEvent.click(screen.getByText('Filters'));
    expect(defaultProps.setFiltersExpanded).toHaveBeenCalledWith(true);
  });

  it('shows active filter count badge when filters are active', () => {
    render(<TransactionFilterPanel {...defaultProps} activeFilterCount={3} />);

    expect(screen.getByText('3')).toBeInTheDocument();
  });

  it('does not show filter count badge when activeFilterCount is 0', () => {
    render(<TransactionFilterPanel {...defaultProps} activeFilterCount={0} />);

    expect(screen.queryByText('0')).not.toBeInTheDocument();
  });

  it('shows Clear button and calls onClearFilters on click', () => {
    render(<TransactionFilterPanel {...defaultProps} activeFilterCount={2} />);

    const clearButton = screen.getByText('Clear');
    fireEvent.click(clearButton);
    expect(defaultProps.onClearFilters).toHaveBeenCalledTimes(1);
  });

  it('renders favourite account quick select buttons', () => {
    const favouriteAccount = createAccount({ id: 'acc-fav', name: 'Savings', isFavourite: true });
    const regularAccount = createAccount({ id: 'acc-reg', name: 'Chequing', isFavourite: false });

    render(<TransactionFilterPanel {...defaultProps} filteredAccounts={[favouriteAccount, regularAccount]} />);

    expect(screen.getByText('Favourites:')).toBeInTheDocument();
    expect(screen.getByText('Savings')).toBeInTheDocument();
  });

  it('does not render favourites section when no favourite accounts exist', () => {
    const regularAccount = createAccount({ id: 'acc-reg', name: 'Chequing', isFavourite: false });

    render(<TransactionFilterPanel {...defaultProps} filteredAccounts={[regularAccount]} />);

    expect(screen.queryByText('Favourites:')).not.toBeInTheDocument();
  });

  it('shows account status segmented control when expanded', () => {
    render(<TransactionFilterPanel {...defaultProps} filtersExpanded={true} />);

    expect(screen.getByText('Show accounts:')).toBeInTheDocument();
    expect(screen.getByText('All')).toBeInTheDocument();
    expect(screen.getByText('Active')).toBeInTheDocument();
    expect(screen.getByText('Closed')).toBeInTheDocument();
  });

  it('renders filter inputs when expanded', () => {
    render(<TransactionFilterPanel {...defaultProps} filtersExpanded={true} />);

    expect(screen.getByText('Start Date')).toBeInTheDocument();
    expect(screen.getByText('End Date')).toBeInTheDocument();
    expect(screen.getByText('Search')).toBeInTheDocument();
  });

  // ----------------------------------------------------------------
  // Filter panel expand / collapse toggle
  // ----------------------------------------------------------------

  describe('expand/collapse toggle', () => {
    it('calls setFiltersExpanded(false) when header is clicked while expanded', () => {
      render(<TransactionFilterPanel {...defaultProps} filtersExpanded={true} />);

      fireEvent.click(screen.getByText('Filters'));
      expect(defaultProps.setFiltersExpanded).toHaveBeenCalledWith(false);
    });

    it('applies overflow-hidden class to filter body when collapsed', () => {
      const { container } = render(<TransactionFilterPanel {...defaultProps} filtersExpanded={false} />);

      // When collapsed, the inner wrapper div should have overflow-hidden to hide content
      const overflowDiv = container.querySelector('.overflow-hidden');
      expect(overflowDiv).toBeTruthy();
    });

    it('shows the filter body content when expanded', () => {
      render(<TransactionFilterPanel {...defaultProps} filtersExpanded={true} />);

      expect(screen.getByText('Accounts')).toBeInTheDocument();
      expect(screen.getByText('Categories')).toBeInTheDocument();
      expect(screen.getByText('Payees')).toBeInTheDocument();
    });

    it('shows Show label when collapsed and Hide label when expanded', () => {
      const { rerender } = render(<TransactionFilterPanel {...defaultProps} filtersExpanded={false} />);

      expect(screen.getByText('Show')).toBeInTheDocument();
      expect(screen.queryByText('Hide')).not.toBeInTheDocument();

      rerender(<TransactionFilterPanel {...defaultProps} filtersExpanded={true} />);

      expect(screen.getByText('Hide')).toBeInTheDocument();
      expect(screen.queryByText('Show')).not.toBeInTheDocument();
    });
  });

  // ----------------------------------------------------------------
  // Date range filter (start/end date inputs)
  // ----------------------------------------------------------------

  describe('date range filter', () => {
    it('renders start date and end date inputs when expanded', () => {
      render(<TransactionFilterPanel {...defaultProps} filtersExpanded={true} />);

      const startInput = screen.getByLabelText('Start Date');
      const endInput = screen.getByLabelText('End Date');

      expect(startInput).toBeInTheDocument();
      expect(endInput).toBeInTheDocument();
      expect(startInput).toHaveAttribute('type', 'date');
      expect(endInput).toHaveAttribute('type', 'date');
    });

    it('calls handleFilterChange with setFilterStartDate when start date changes', () => {
      render(<TransactionFilterPanel {...defaultProps} filtersExpanded={true} />);

      const startInput = screen.getByLabelText('Start Date');
      fireEvent.change(startInput, { target: { value: '2025-01-15' } });

      expect(defaultProps.handleFilterChange).toHaveBeenCalledWith(
        defaultProps.setFilterStartDate,
        '2025-01-15'
      );
    });

    it('calls handleFilterChange with setFilterEndDate when end date changes', () => {
      render(<TransactionFilterPanel {...defaultProps} filtersExpanded={true} />);

      const endInput = screen.getByLabelText('End Date');
      fireEvent.change(endInput, { target: { value: '2025-12-31' } });

      expect(defaultProps.handleFilterChange).toHaveBeenCalledWith(
        defaultProps.setFilterEndDate,
        '2025-12-31'
      );
    });

    it('displays current filter start date value', () => {
      render(
        <TransactionFilterPanel
          {...defaultProps}
          filtersExpanded={true}
          filterStartDate="2025-03-01"
        />
      );

      const startInput = screen.getByLabelText('Start Date');
      expect(startInput).toHaveValue('2025-03-01');
    });

    it('displays current filter end date value', () => {
      render(
        <TransactionFilterPanel
          {...defaultProps}
          filtersExpanded={true}
          filterEndDate="2025-06-30"
        />
      );

      const endInput = screen.getByLabelText('End Date');
      expect(endInput).toHaveValue('2025-06-30');
    });
  });

  // ----------------------------------------------------------------
  // Account filter multi-select
  // ----------------------------------------------------------------

  describe('account filter multi-select', () => {
    it('renders the Accounts multi-select with placeholder when expanded', () => {
      render(<TransactionFilterPanel {...defaultProps} filtersExpanded={true} />);

      expect(screen.getByText('Accounts')).toBeInTheDocument();
      expect(screen.getByText('All accounts')).toBeInTheDocument();
    });

    it('opens the account multi-select dropdown when trigger is clicked', () => {
      const options = [
        { value: 'acc-1', label: 'Chequing' },
        { value: 'acc-2', label: 'Savings' },
      ];

      render(
        <TransactionFilterPanel
          {...defaultProps}
          filtersExpanded={true}
          accountFilterOptions={options}
        />
      );

      fireEvent.click(screen.getByText('All accounts'));
      expect(screen.getByText('Chequing')).toBeInTheDocument();
      expect(screen.getByText('Savings')).toBeInTheDocument();
    });

    it('calls handleArrayFilterChange when an account option is toggled', () => {
      const options = [{ value: 'acc-1', label: 'Chequing' }];

      render(
        <TransactionFilterPanel
          {...defaultProps}
          filtersExpanded={true}
          accountFilterOptions={options}
        />
      );

      fireEvent.click(screen.getByText('All accounts'));
      // Click the checkbox label for the option
      const checkbox = screen.getByRole('checkbox', { name: /Chequing/i });
      fireEvent.click(checkbox);

      expect(defaultProps.handleArrayFilterChange).toHaveBeenCalledWith(
        defaultProps.setFilterAccountIds,
        ['acc-1']
      );
    });

    it('displays selected account name when one account is selected', () => {
      const options = [
        { value: 'acc-1', label: 'Chequing' },
        { value: 'acc-2', label: 'Savings' },
      ];

      render(
        <TransactionFilterPanel
          {...defaultProps}
          filtersExpanded={true}
          accountFilterOptions={options}
          filterAccountIds={['acc-1']}
        />
      );

      expect(screen.getByText('Chequing')).toBeInTheDocument();
    });

    it('displays count when multiple accounts are selected', () => {
      const options = [
        { value: 'acc-1', label: 'Chequing' },
        { value: 'acc-2', label: 'Savings' },
      ];

      render(
        <TransactionFilterPanel
          {...defaultProps}
          filtersExpanded={true}
          accountFilterOptions={options}
          filterAccountIds={['acc-1', 'acc-2']}
        />
      );

      expect(screen.getByText('2 selected')).toBeInTheDocument();
    });
  });

  // ----------------------------------------------------------------
  // Category filter multi-select
  // ----------------------------------------------------------------

  describe('category filter multi-select', () => {
    it('renders the Categories multi-select with placeholder when expanded', () => {
      render(<TransactionFilterPanel {...defaultProps} filtersExpanded={true} />);

      expect(screen.getByText('Categories')).toBeInTheDocument();
      expect(screen.getByText('All categories')).toBeInTheDocument();
    });

    it('opens the category multi-select dropdown when trigger is clicked', () => {
      const options = [
        { value: 'cat-1', label: 'Groceries' },
        { value: 'cat-2', label: 'Rent' },
      ];

      render(
        <TransactionFilterPanel
          {...defaultProps}
          filtersExpanded={true}
          categoryFilterOptions={options}
        />
      );

      fireEvent.click(screen.getByText('All categories'));
      expect(screen.getByText('Groceries')).toBeInTheDocument();
      expect(screen.getByText('Rent')).toBeInTheDocument();
    });

    it('calls handleArrayFilterChange when a category option is toggled', () => {
      const options = [{ value: 'cat-1', label: 'Groceries' }];

      render(
        <TransactionFilterPanel
          {...defaultProps}
          filtersExpanded={true}
          categoryFilterOptions={options}
        />
      );

      fireEvent.click(screen.getByText('All categories'));
      const checkbox = screen.getByRole('checkbox', { name: /Groceries/i });
      fireEvent.click(checkbox);

      expect(defaultProps.handleArrayFilterChange).toHaveBeenCalledWith(
        defaultProps.setFilterCategoryIds,
        ['cat-1']
      );
    });

    it('displays selected category name when one category is selected', () => {
      const options = [
        { value: 'cat-1', label: 'Groceries' },
        { value: 'cat-2', label: 'Rent' },
      ];

      render(
        <TransactionFilterPanel
          {...defaultProps}
          filtersExpanded={true}
          categoryFilterOptions={options}
          filterCategoryIds={['cat-2']}
        />
      );

      expect(screen.getByText('Rent')).toBeInTheDocument();
    });
  });

  // ----------------------------------------------------------------
  // Payee filter multi-select
  // ----------------------------------------------------------------

  describe('payee filter multi-select', () => {
    it('renders the Payees multi-select with placeholder when expanded', () => {
      render(<TransactionFilterPanel {...defaultProps} filtersExpanded={true} />);

      expect(screen.getByText('Payees')).toBeInTheDocument();
      expect(screen.getByText('All payees')).toBeInTheDocument();
    });

    it('opens the payee multi-select dropdown when trigger is clicked', () => {
      const options = [
        { value: 'payee-1', label: 'Supermarket' },
        { value: 'payee-2', label: 'Landlord' },
      ];

      render(
        <TransactionFilterPanel
          {...defaultProps}
          filtersExpanded={true}
          payeeFilterOptions={options}
        />
      );

      fireEvent.click(screen.getByText('All payees'));
      expect(screen.getByText('Supermarket')).toBeInTheDocument();
      expect(screen.getByText('Landlord')).toBeInTheDocument();
    });

    it('calls handleArrayFilterChange when a payee option is toggled', () => {
      const options = [{ value: 'payee-1', label: 'Supermarket' }];

      render(
        <TransactionFilterPanel
          {...defaultProps}
          filtersExpanded={true}
          payeeFilterOptions={options}
        />
      );

      fireEvent.click(screen.getByText('All payees'));
      const checkbox = screen.getByRole('checkbox', { name: /Supermarket/i });
      fireEvent.click(checkbox);

      expect(defaultProps.handleArrayFilterChange).toHaveBeenCalledWith(
        defaultProps.setFilterPayeeIds,
        ['payee-1']
      );
    });

    it('displays selected payee name when one payee is selected', () => {
      const options = [
        { value: 'payee-1', label: 'Supermarket' },
        { value: 'payee-2', label: 'Landlord' },
      ];

      render(
        <TransactionFilterPanel
          {...defaultProps}
          filtersExpanded={true}
          payeeFilterOptions={options}
          filterPayeeIds={['payee-2']}
        />
      );

      expect(screen.getByText('Landlord')).toBeInTheDocument();
    });
  });

  // ----------------------------------------------------------------
  // Clear all filters button
  // ----------------------------------------------------------------

  describe('clear all filters button', () => {
    it('does not show Clear button when no filters are active', () => {
      render(<TransactionFilterPanel {...defaultProps} activeFilterCount={0} />);

      expect(screen.queryByText('Clear')).not.toBeInTheDocument();
    });

    it('shows Clear button when filters are active', () => {
      render(<TransactionFilterPanel {...defaultProps} activeFilterCount={1} />);

      expect(screen.getByText('Clear')).toBeInTheDocument();
    });

    it('calls onClearFilters when Clear button is clicked', () => {
      render(<TransactionFilterPanel {...defaultProps} activeFilterCount={5} />);

      fireEvent.click(screen.getByText('Clear'));
      expect(defaultProps.onClearFilters).toHaveBeenCalledTimes(1);
    });

    it('does not toggle filter expansion when Clear button is clicked', () => {
      render(<TransactionFilterPanel {...defaultProps} activeFilterCount={2} />);

      fireEvent.click(screen.getByText('Clear'));

      // Clear button uses stopPropagation, so setFiltersExpanded should NOT be called
      expect(defaultProps.setFiltersExpanded).not.toHaveBeenCalled();
    });
  });

  // ----------------------------------------------------------------
  // Favourite account quick-select buttons
  // ----------------------------------------------------------------

  describe('favourite account quick-select buttons', () => {
    it('renders multiple favourite accounts sorted alphabetically', () => {
      const accounts = [
        createAccount({ id: 'acc-z', name: 'Zccount', isFavourite: true }),
        createAccount({ id: 'acc-a', name: 'Accoont', isFavourite: true }),
        createAccount({ id: 'acc-m', name: 'Midaccount', isFavourite: true }),
      ];

      render(<TransactionFilterPanel {...defaultProps} filteredAccounts={accounts} />);

      const buttons = screen.getAllByRole('button').filter(b =>
        ['Accoont', 'Midaccount', 'Zccount'].includes(b.textContent?.trim() ?? '')
      );
      expect(buttons).toHaveLength(3);

      // Verify alphabetical order
      const names = buttons.map(b => b.textContent?.trim());
      expect(names).toEqual(['Accoont', 'Midaccount', 'Zccount']);
    });

    it('calls handleArrayFilterChange with account id when favourite button is clicked', () => {
      const account = createAccount({ id: 'acc-fav', name: 'Savings', isFavourite: true });

      render(<TransactionFilterPanel {...defaultProps} filteredAccounts={[account]} />);

      fireEvent.click(screen.getByText('Savings'));

      expect(defaultProps.handleArrayFilterChange).toHaveBeenCalledWith(
        defaultProps.setFilterAccountIds,
        ['acc-fav']
      );
    });

    it('clears account filter when the only selected favourite is clicked again', () => {
      const account = createAccount({ id: 'acc-fav', name: 'Savings', isFavourite: true });

      render(
        <TransactionFilterPanel
          {...defaultProps}
          filteredAccounts={[account]}
          filterAccountIds={['acc-fav']}
        />
      );

      fireEvent.click(screen.getByText('Savings'));

      expect(defaultProps.handleArrayFilterChange).toHaveBeenCalledWith(
        defaultProps.setFilterAccountIds,
        []
      );
    });

    it('replaces selection when a different favourite button is clicked (multiple accounts selected)', () => {
      const accounts = [
        createAccount({ id: 'acc-1', name: 'Savings', isFavourite: true }),
        createAccount({ id: 'acc-2', name: 'Chequing', isFavourite: true }),
      ];

      render(
        <TransactionFilterPanel
          {...defaultProps}
          filteredAccounts={accounts}
          filterAccountIds={['acc-1', 'acc-2']}
        />
      );

      fireEvent.click(screen.getByText('Chequing'));

      // Even though multiple are selected, clicking should set to just this one
      expect(defaultProps.handleArrayFilterChange).toHaveBeenCalledWith(
        defaultProps.setFilterAccountIds,
        ['acc-2']
      );
    });

    it('does not render non-favourite accounts in the quick-select area', () => {
      const fav = createAccount({ id: 'acc-fav', name: 'Savings', isFavourite: true });
      const reg = createAccount({ id: 'acc-reg', name: 'Regular', isFavourite: false });

      render(<TransactionFilterPanel {...defaultProps} filteredAccounts={[fav, reg]} />);

      expect(screen.getByText('Savings')).toBeInTheDocument();
      // Regular should not appear in the favourites section (it might appear elsewhere if expanded)
      const favouritesSection = screen.getByText('Favourites:').closest('div');
      expect(favouritesSection).not.toHaveTextContent('Regular');
    });

    it('applies selected styling to currently selected favourite account', () => {
      const account = createAccount({ id: 'acc-fav', name: 'Savings', isFavourite: true });

      render(
        <TransactionFilterPanel
          {...defaultProps}
          filteredAccounts={[account]}
          filterAccountIds={['acc-fav']}
        />
      );

      const button = screen.getByText('Savings').closest('button');
      expect(button?.className).toContain('bg-emerald-700');
    });

    it('applies unselected styling to unselected favourite account', () => {
      const account = createAccount({ id: 'acc-fav', name: 'Savings', isFavourite: true });

      render(
        <TransactionFilterPanel
          {...defaultProps}
          filteredAccounts={[account]}
          filterAccountIds={[]}
        />
      );

      const button = screen.getByText('Savings').closest('button');
      expect(button?.className).toContain('bg-gray-100');
    });
  });

  // ----------------------------------------------------------------
  // Search text filter input
  // ----------------------------------------------------------------

  describe('search text filter input', () => {
    it('renders the search input when expanded', () => {
      render(<TransactionFilterPanel {...defaultProps} filtersExpanded={true} />);

      const searchInput = screen.getByLabelText('Search');
      expect(searchInput).toBeInTheDocument();
      expect(searchInput).toHaveAttribute('type', 'text');
    });

    it('displays searchInput value in the search field', () => {
      render(
        <TransactionFilterPanel
          {...defaultProps}
          filtersExpanded={true}
          searchInput="groceries"
        />
      );

      const searchInput = screen.getByLabelText('Search');
      expect(searchInput).toHaveValue('groceries');
    });

    it('calls handleSearchChange when search input changes', () => {
      render(<TransactionFilterPanel {...defaultProps} filtersExpanded={true} />);

      const searchInput = screen.getByLabelText('Search');
      fireEvent.change(searchInput, { target: { value: 'rent payment' } });

      expect(defaultProps.handleSearchChange).toHaveBeenCalledWith('rent payment');
    });

    it('shows the search placeholder text', () => {
      render(<TransactionFilterPanel {...defaultProps} filtersExpanded={true} />);

      const searchInput = screen.getByPlaceholderText('Search descriptions...');
      expect(searchInput).toBeInTheDocument();
    });
  });

  // ----------------------------------------------------------------
  // Filter change callbacks fire with correct values
  // ----------------------------------------------------------------

  describe('filter change callbacks', () => {
    it('calls setFilterAccountStatus with "active" when Active button is clicked', () => {
      render(<TransactionFilterPanel {...defaultProps} filtersExpanded={true} />);

      fireEvent.click(screen.getByText('Active'));
      expect(defaultProps.setFilterAccountStatus).toHaveBeenCalledWith('active');
    });

    it('calls setFilterAccountStatus with "closed" when Closed button is clicked', () => {
      render(<TransactionFilterPanel {...defaultProps} filtersExpanded={true} />);

      fireEvent.click(screen.getByText('Closed'));
      expect(defaultProps.setFilterAccountStatus).toHaveBeenCalledWith('closed');
    });

    it('calls setFilterAccountStatus with empty string when All button is clicked', () => {
      render(
        <TransactionFilterPanel
          {...defaultProps}
          filtersExpanded={true}
          filterAccountStatus="active"
        />
      );

      fireEvent.click(screen.getByText('All'));
      expect(defaultProps.setFilterAccountStatus).toHaveBeenCalledWith('');
    });

    it('does not call handleSearchChange or handleFilterChange when filters panel is not interacted with', () => {
      render(<TransactionFilterPanel {...defaultProps} filtersExpanded={true} />);

      expect(defaultProps.handleSearchChange).not.toHaveBeenCalled();
      expect(defaultProps.handleFilterChange).not.toHaveBeenCalled();
      expect(defaultProps.handleArrayFilterChange).not.toHaveBeenCalled();
    });
  });

  // ----------------------------------------------------------------
  // Active filter count badge
  // ----------------------------------------------------------------

  describe('active filter count badge', () => {
    it('does not render badge when activeFilterCount is 0', () => {
      render(<TransactionFilterPanel {...defaultProps} activeFilterCount={0} />);

      // Badge should not exist
      const badge = screen.queryByText('0');
      expect(badge).not.toBeInTheDocument();
    });

    it('renders badge with count 1', () => {
      render(<TransactionFilterPanel {...defaultProps} activeFilterCount={1} />);

      expect(screen.getByText('1')).toBeInTheDocument();
    });

    it('renders badge with a high count', () => {
      render(<TransactionFilterPanel {...defaultProps} activeFilterCount={12} />);

      expect(screen.getByText('12')).toBeInTheDocument();
    });

    it('renders badge with correct styling', () => {
      render(<TransactionFilterPanel {...defaultProps} activeFilterCount={5} />);

      const badge = screen.getByText('5');
      expect(badge.className).toContain('rounded-full');
      expect(badge.className).toContain('bg-blue-100');
    });
  });

  // ----------------------------------------------------------------
  // Active filter chips when collapsed
  // ----------------------------------------------------------------

  describe('active filter chips when collapsed', () => {
    it('shows account chips when collapsed with selected accounts', () => {
      const selectedAccounts = [
        createAccount({ id: 'acc-1', name: 'Savings' }),
        createAccount({ id: 'acc-2', name: 'Chequing' }),
      ];

      render(
        <TransactionFilterPanel
          {...defaultProps}
          filtersExpanded={false}
          activeFilterCount={2}
          selectedAccounts={selectedAccounts}
          filterAccountIds={['acc-1', 'acc-2']}
        />
      );

      expect(screen.getByText('Savings')).toBeInTheDocument();
      expect(screen.getByText('Chequing')).toBeInTheDocument();
    });

    it('shows category chips when collapsed with selected categories', () => {
      const selectedCategories = [
        createCategory({ id: 'cat-1', name: 'Groceries', color: '#4CAF50' }),
      ];

      render(
        <TransactionFilterPanel
          {...defaultProps}
          filtersExpanded={false}
          activeFilterCount={1}
          selectedCategories={selectedCategories}
          filterCategoryIds={['cat-1']}
        />
      );

      expect(screen.getByText('Groceries')).toBeInTheDocument();
    });

    it('shows payee chips when collapsed with selected payees', () => {
      const selectedPayees = [
        createPayee({ id: 'payee-1', name: 'Supermarket' }),
      ];

      render(
        <TransactionFilterPanel
          {...defaultProps}
          filtersExpanded={false}
          activeFilterCount={1}
          selectedPayees={selectedPayees}
          filterPayeeIds={['payee-1']}
        />
      );

      expect(screen.getByText('Supermarket')).toBeInTheDocument();
    });

    it('shows date range chip with both dates when collapsed', () => {
      const formatDate = vi.fn((d: string) => {
        if (d === '2025-01-01') return 'Jan 1, 2025';
        if (d === '2025-12-31') return 'Dec 31, 2025';
        return d;
      });

      render(
        <TransactionFilterPanel
          {...defaultProps}
          filtersExpanded={false}
          activeFilterCount={1}
          filterStartDate="2025-01-01"
          filterEndDate="2025-12-31"
          formatDate={formatDate}
        />
      );

      expect(screen.getByText('Jan 1, 2025 - Dec 31, 2025')).toBeInTheDocument();
    });

    it('shows "From" date chip when only start date is set', () => {
      const formatDate = vi.fn((_d: string) => 'Mar 15, 2025');

      render(
        <TransactionFilterPanel
          {...defaultProps}
          filtersExpanded={false}
          activeFilterCount={1}
          filterStartDate="2025-03-15"
          filterEndDate=""
          formatDate={formatDate}
        />
      );

      expect(screen.getByText(/^From Mar 15, 2025$/)).toBeInTheDocument();
    });

    it('shows "Until" date chip when only end date is set', () => {
      const formatDate = vi.fn((_d: string) => 'Jun 30, 2025');

      render(
        <TransactionFilterPanel
          {...defaultProps}
          filtersExpanded={false}
          activeFilterCount={1}
          filterStartDate=""
          filterEndDate="2025-06-30"
          formatDate={formatDate}
        />
      );

      expect(screen.getByText(/^Until Jun 30, 2025$/)).toBeInTheDocument();
    });

    it('shows search chip with quoted search text when collapsed', () => {
      render(
        <TransactionFilterPanel
          {...defaultProps}
          filtersExpanded={false}
          activeFilterCount={1}
          filterSearch="groceries"
        />
      );

      // The component renders &quot;groceries&quot; which is "groceries"
      const chip = screen.getByText(/groceries/);
      expect(chip).toBeInTheDocument();
    });

    it('does not show chips when filters are expanded', () => {
      const selectedAccounts = [createAccount({ id: 'acc-1', name: 'Savings' })];

      render(
        <TransactionFilterPanel
          {...defaultProps}
          filtersExpanded={true}
          activeFilterCount={1}
          selectedAccounts={selectedAccounts}
          filterAccountIds={['acc-1']}
        />
      );

      // The chip area (role="presentation") should not exist when expanded
      expect(screen.queryByRole('presentation')).not.toBeInTheDocument();
    });

    it('does not show chips when no filters are active (collapsed)', () => {
      render(
        <TransactionFilterPanel
          {...defaultProps}
          filtersExpanded={false}
          activeFilterCount={0}
        />
      );

      expect(screen.queryByRole('presentation')).not.toBeInTheDocument();
    });

    it('removes account chip by calling handleArrayFilterChange when dismiss is clicked', () => {
      const selectedAccounts = [
        createAccount({ id: 'acc-1', name: 'Savings' }),
        createAccount({ id: 'acc-2', name: 'Chequing' }),
      ];

      render(
        <TransactionFilterPanel
          {...defaultProps}
          filtersExpanded={false}
          activeFilterCount={2}
          selectedAccounts={selectedAccounts}
          filterAccountIds={['acc-1', 'acc-2']}
        />
      );

      // Find the dismiss button (the X) within the Savings chip
      const savingsChip = screen.getByText('Savings').closest('span');
      const dismissButton = savingsChip?.querySelector('button');
      expect(dismissButton).toBeTruthy();
      fireEvent.click(dismissButton!);

      expect(defaultProps.handleArrayFilterChange).toHaveBeenCalledWith(
        defaultProps.setFilterAccountIds,
        ['acc-2']
      );
    });

    it('removes category chip by calling handleArrayFilterChange when dismiss is clicked', () => {
      const selectedCategories = [
        createCategory({ id: 'cat-1', name: 'Groceries' }),
        createCategory({ id: 'cat-2', name: 'Rent' }),
      ];

      render(
        <TransactionFilterPanel
          {...defaultProps}
          filtersExpanded={false}
          activeFilterCount={2}
          selectedCategories={selectedCategories}
          filterCategoryIds={['cat-1', 'cat-2']}
        />
      );

      const groceriesChip = screen.getByText('Groceries').closest('span');
      const dismissButton = groceriesChip?.querySelector('button');
      expect(dismissButton).toBeTruthy();
      fireEvent.click(dismissButton!);

      expect(defaultProps.handleArrayFilterChange).toHaveBeenCalledWith(
        defaultProps.setFilterCategoryIds,
        ['cat-2']
      );
    });

    it('removes payee chip by calling handleArrayFilterChange when dismiss is clicked', () => {
      const selectedPayees = [
        createPayee({ id: 'payee-1', name: 'Supermarket' }),
      ];

      render(
        <TransactionFilterPanel
          {...defaultProps}
          filtersExpanded={false}
          activeFilterCount={1}
          selectedPayees={selectedPayees}
          filterPayeeIds={['payee-1']}
        />
      );

      const payeeChip = screen.getByText('Supermarket').closest('span');
      const dismissButton = payeeChip?.querySelector('button');
      expect(dismissButton).toBeTruthy();
      fireEvent.click(dismissButton!);

      expect(defaultProps.handleArrayFilterChange).toHaveBeenCalledWith(
        defaultProps.setFilterPayeeIds,
        []
      );
    });

    it('clears date range chip by calling handleFilterChange for both dates', () => {
      const formatDate = vi.fn((_d: string) => 'formatted');

      render(
        <TransactionFilterPanel
          {...defaultProps}
          filtersExpanded={false}
          activeFilterCount={1}
          filterStartDate="2025-01-01"
          filterEndDate="2025-12-31"
          formatDate={formatDate}
        />
      );

      const dateChip = screen.getByText('formatted - formatted').closest('span');
      const dismissButton = dateChip?.querySelector('button');
      expect(dismissButton).toBeTruthy();
      fireEvent.click(dismissButton!);

      expect(defaultProps.handleFilterChange).toHaveBeenCalledWith(
        defaultProps.setFilterStartDate,
        ''
      );
      expect(defaultProps.handleFilterChange).toHaveBeenCalledWith(
        defaultProps.setFilterEndDate,
        ''
      );
    });

    it('clears search chip by calling handleFilterChange for search', () => {
      render(
        <TransactionFilterPanel
          {...defaultProps}
          filtersExpanded={false}
          activeFilterCount={1}
          filterSearch="test query"
        />
      );

      const searchChip = screen.getByText(/test query/).closest('span');
      const dismissButton = searchChip?.querySelector('button');
      expect(dismissButton).toBeTruthy();
      fireEvent.click(dismissButton!);

      expect(defaultProps.handleFilterChange).toHaveBeenCalledWith(
        defaultProps.setFilterSearch,
        ''
      );
    });

    it('renders category chip with color dot when category has a color', () => {
      const selectedCategories = [
        createCategory({ id: 'cat-1', name: 'Groceries', color: '#4CAF50' }),
      ];

      render(
        <TransactionFilterPanel
          {...defaultProps}
          filtersExpanded={false}
          activeFilterCount={1}
          selectedCategories={selectedCategories}
          filterCategoryIds={['cat-1']}
        />
      );

      const colorDot = screen.getByText('Groceries').closest('span')?.querySelector('[style]');
      expect(colorDot).toBeTruthy();
      expect(colorDot?.getAttribute('style')).toContain('background-color');
    });

    it('does not render color dot for category without a color', () => {
      const selectedCategories = [
        createCategory({ id: 'cat-1', name: 'Groceries', color: null }),
      ];

      render(
        <TransactionFilterPanel
          {...defaultProps}
          filtersExpanded={false}
          activeFilterCount={1}
          selectedCategories={selectedCategories}
          filterCategoryIds={['cat-1']}
        />
      );

      const chip = screen.getByText('Groceries').closest('span');
      const colorDot = chip?.querySelector('[style]');
      expect(colorDot).toBeNull();
    });
  });

  // ----------------------------------------------------------------
  // Bulk Update toggle button
  // ----------------------------------------------------------------

  describe('bulk update toggle button', () => {
    it('does not render the bulk update button when onToggleBulkSelectMode is not provided', () => {
      render(<TransactionFilterPanel {...defaultProps} filtersExpanded={true} />);

      expect(screen.queryByText('Bulk Update')).not.toBeInTheDocument();
      expect(screen.queryByText('Cancel Bulk')).not.toBeInTheDocument();
    });

    it('renders "Bulk Update" buttons when bulkSelectMode is false and filters expanded', () => {
      render(
        <TransactionFilterPanel
          {...defaultProps}
          filtersExpanded={true}
          bulkSelectMode={false}
          onToggleBulkSelectMode={vi.fn()}
        />
      );

      // Two instances: one for desktop (inline), one for mobile (full width)
      const buttons = screen.getAllByText('Bulk Update');
      expect(buttons.length).toBe(2);
      expect(screen.queryByText('Cancel Bulk')).not.toBeInTheDocument();
    });

    it('renders "Cancel Bulk" buttons when bulkSelectMode is true', () => {
      render(
        <TransactionFilterPanel
          {...defaultProps}
          filtersExpanded={true}
          bulkSelectMode={true}
          onToggleBulkSelectMode={vi.fn()}
        />
      );

      const buttons = screen.getAllByText('Cancel Bulk');
      expect(buttons.length).toBe(2);
      expect(screen.queryByText('Bulk Update')).not.toBeInTheDocument();
    });

    it('calls onToggleBulkSelectMode when a Bulk Update button is clicked', () => {
      const onToggle = vi.fn();
      render(
        <TransactionFilterPanel
          {...defaultProps}
          filtersExpanded={true}
          bulkSelectMode={false}
          onToggleBulkSelectMode={onToggle}
        />
      );

      // Click either instance — both should call the same handler
      fireEvent.click(screen.getAllByText('Bulk Update')[0]);
      expect(onToggle).toHaveBeenCalledTimes(1);
    });

    it('calls onToggleBulkSelectMode when a Cancel Bulk button is clicked', () => {
      const onToggle = vi.fn();
      render(
        <TransactionFilterPanel
          {...defaultProps}
          filtersExpanded={true}
          bulkSelectMode={true}
          onToggleBulkSelectMode={onToggle}
        />
      );

      fireEvent.click(screen.getAllByText('Cancel Bulk')[0]);
      expect(onToggle).toHaveBeenCalledTimes(1);
    });

    it('is inside the filter body, not the header', () => {
      render(
        <TransactionFilterPanel
          {...defaultProps}
          filtersExpanded={false}
          bulkSelectMode={false}
          onToggleBulkSelectMode={vi.fn()}
        />
      );

      // Buttons are inside the collapsible body, so they should be inside overflow-hidden when collapsed
      const buttons = screen.queryAllByText('Bulk Update');
      expect(buttons.length).toBeGreaterThan(0);
      buttons.forEach(button => {
        const overflowParent = button.closest('.overflow-hidden');
        expect(overflowParent).toBeTruthy();
      });
    });

    it('renders desktop button hidden on mobile and mobile button hidden on desktop', () => {
      render(
        <TransactionFilterPanel
          {...defaultProps}
          filtersExpanded={true}
          bulkSelectMode={false}
          onToggleBulkSelectMode={vi.fn()}
        />
      );

      const buttons = screen.getAllByText('Bulk Update');
      // Desktop button: hidden on mobile (has sm:inline-flex)
      const desktopButton = buttons.find(b => b.className.includes('sm:inline-flex'));
      expect(desktopButton).toBeTruthy();
      // Mobile button: hidden on desktop (has sm:hidden)
      const mobileButton = buttons.find(b => b.className.includes('sm:hidden'));
      expect(mobileButton).toBeTruthy();
    });

    it('uses outline variant styling when bulkSelectMode is false', () => {
      render(
        <TransactionFilterPanel
          {...defaultProps}
          filtersExpanded={true}
          bulkSelectMode={false}
          onToggleBulkSelectMode={vi.fn()}
        />
      );

      const buttons = screen.getAllByText('Bulk Update');
      // All instances should use outline variant (border styling)
      buttons.forEach(button => {
        expect(button.className).toContain('border');
      });
    });

    it('uses secondary variant styling when bulkSelectMode is true', () => {
      render(
        <TransactionFilterPanel
          {...defaultProps}
          filtersExpanded={true}
          bulkSelectMode={true}
          onToggleBulkSelectMode={vi.fn()}
        />
      );

      const buttons = screen.getAllByText('Cancel Bulk');
      // All instances should use secondary variant (bg-gray-600)
      buttons.forEach(button => {
        expect(button.className).toContain('bg-gray-600');
      });
    });
  });

  // ----------------------------------------------------------------
  // Account status segmented control
  // ----------------------------------------------------------------

  describe('account status segmented control', () => {
    it('applies selected styling to All button when filterAccountStatus is empty', () => {
      render(
        <TransactionFilterPanel
          {...defaultProps}
          filtersExpanded={true}
          filterAccountStatus=""
        />
      );

      const allButton = screen.getByText('All');
      expect(allButton.className).toContain('bg-blue-600');
    });

    it('applies selected styling to Active button when filterAccountStatus is active', () => {
      render(
        <TransactionFilterPanel
          {...defaultProps}
          filtersExpanded={true}
          filterAccountStatus="active"
        />
      );

      const activeButton = screen.getByText('Active');
      expect(activeButton.className).toContain('bg-blue-600');
    });

    it('applies selected styling to Closed button when filterAccountStatus is closed', () => {
      render(
        <TransactionFilterPanel
          {...defaultProps}
          filtersExpanded={true}
          filterAccountStatus="closed"
        />
      );

      const closedButton = screen.getByText('Closed');
      expect(closedButton.className).toContain('bg-blue-600');
    });

    it('applies unselected styling to non-active status buttons', () => {
      render(
        <TransactionFilterPanel
          {...defaultProps}
          filtersExpanded={true}
          filterAccountStatus="active"
        />
      );

      const allButton = screen.getByText('All');
      const closedButton = screen.getByText('Closed');
      expect(allButton.className).not.toContain('bg-blue-600');
      expect(closedButton.className).not.toContain('bg-blue-600');
    });
  });
});
