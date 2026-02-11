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
});
