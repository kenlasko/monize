import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, act } from '@testing-library/react';
import { render } from '@/test/render';
import { CategoryTransactionsTab } from './CategoryTransactionsTab';
import type { Transaction } from '@/types/transaction';

const mockGetAll = vi.fn();
vi.mock('@/lib/transactions', () => ({
  transactionsApi: {
    getAll: (...args: unknown[]) => mockGetAll(...args),
  },
}));

// The shared register list has its own tests; stub it so this one asserts the
// wiring (what is fetched, what is passed down) rather than re-testing rows.
vi.mock('@/components/transactions/TransactionList', () => ({
  TransactionList: ({
    transactions,
    onEdit,
    onPageChange,
    totalItems,
    categoryLabelMap,
  }: {
    transactions: Transaction[];
    onEdit?: (t: Transaction) => void;
    onPageChange?: (page: number) => void;
    totalItems?: number;
    categoryLabelMap?: Map<string, string>;
  }) => (
    <div data-testid="transaction-list">
      <span data-testid="row-count">{transactions.length}</span>
      <span data-testid="total-items">{totalItems}</span>
      <span data-testid="label-map">{categoryLabelMap?.get('cat-1') ?? ''}</span>
      <button type="button" onClick={() => onEdit?.(transactions[0])}>
        edit-first
      </button>
      <button type="button" onClick={() => onPageChange?.(2)}>
        next-page
      </button>
    </div>
  ),
}));

function transaction(overrides: Partial<Transaction> = {}): Transaction {
  return {
    id: 'tx-1',
    accountId: 'acct-1',
    account: { id: 'acct-1', name: 'Chequing' },
    transactionDate: '2026-07-15',
    payeeId: 'payee-1',
    payeeName: 'Loblaws',
    categoryId: 'cat-1',
    category: { id: 'cat-1', name: 'Groceries' },
    amount: -86.45,
    currencyCode: 'CAD',
    ...overrides,
  } as Transaction;
}

const categoryLabelMap = new Map([['cat-1', 'Food: Groceries']]);
const categoryColorMap = new Map([['cat-1', '#abc123']]);

function page(total: number, totalPages = 1, pageNumber = 1) {
  return { page: pageNumber, limit: 50, total, totalPages, hasMore: totalPages > pageNumber };
}

async function renderTab(basis: 'cash'|'accrual' = 'cash') {
  const onChanged = vi.fn();
  const onViewInRegister = vi.fn();
  const onSelectDate = vi.fn();
  await act(async () => {
    render(
      <CategoryTransactionsTab
        basis={basis}
        categoryId="cat-1"
        refreshKey={0}
        categoryLabelMap={categoryLabelMap}
        categoryColorMap={categoryColorMap}
        categoryIconMap={new Map()}
        onChanged={onChanged}
        onViewInRegister={onViewInRegister}
        onSelectDate={onSelectDate}
      />,
    );
  });
  return { onChanged, onViewInRegister, onSelectDate };
}

describe('CategoryTransactionsTab', () => {
  beforeEach(() => {
    mockGetAll.mockReset();
    mockGetAll.mockResolvedValue({ data: [transaction()], pagination: page(1) });
  });

  it('fetches every transaction in the category subtree, paginated', async () => {
    await renderTab();

    expect(mockGetAll).toHaveBeenCalledWith({
      basis: 'cash',
      categoryIds: ['cat-1'],
      page: 1,
      limit: expect.any(Number),
    });
    expect(screen.getByTestId('row-count')).toHaveTextContent('1');
  });

  it('titles the card with the full count, not "recent"', async () => {
    mockGetAll.mockResolvedValue({
      data: [transaction()],
      pagination: page(137, 3),
    });

    await renderTab();

    expect(screen.getByText('Transactions (137)')).toBeInTheDocument();
    expect(screen.queryByText(/Recent/)).toBeNull();
  });

  it('passes the hierarchical category labels through to the rows', async () => {
    await renderTab();
    expect(screen.getByTestId('label-map')).toHaveTextContent('Food: Groceries');
  });

  it('opens the edit form in place', async () => {
    await renderTab();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'edit-first' }));
    });

    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('refetches when the page changes', async () => {
    mockGetAll.mockResolvedValue({
      data: [transaction()],
      pagination: page(137, 3),
    });

    await renderTab();
    mockGetAll.mockClear();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'next-page' }));
    });

    expect(mockGetAll).toHaveBeenCalledWith(
      expect.objectContaining({ page: 2 }),
    );
  });

  it('links out to the register', async () => {
    const { onViewInRegister } = await renderTab();

    fireEvent.click(screen.getByRole('button', { name: 'Open in the register' }));

    expect(onViewInRegister).toHaveBeenCalled();
  });

  it('shows the empty state for a category with no transactions', async () => {
    mockGetAll.mockResolvedValue({ data: [], pagination: page(0, 0) });

    await renderTab();

    expect(
      screen.getByText('No transactions in this category yet'),
    ).toBeInTheDocument();
    expect(screen.queryByTestId('transaction-list')).toBeNull();
  });

  it('reports a load failure without crashing the tab', async () => {
    mockGetAll.mockRejectedValue(new Error('boom'));

    await renderTab();
    await act(async () => {});

    expect(screen.getByText('Failed to load transactions')).toBeInTheDocument();
  });
});

 it('requests recognition rows when the surrounding view selects accrual', async () => {
   await renderTab('accrual');
   expect(mockGetAll).toHaveBeenCalledWith(expect.objectContaining({basis:'accrual',page:1}));
 });
