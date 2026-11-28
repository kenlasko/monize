import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@/test/render';
import { CategoryList } from './CategoryList';
import { Category } from '@/types/category';
import { useDensityStore } from '@/store/densityStore';

const mockPush = vi.fn();

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: mockPush,
    replace: vi.fn(),
    back: vi.fn(),
    prefetch: vi.fn(),
    refresh: vi.fn(),
  }),
  usePathname: () => '/categories',
  useSearchParams: () => new URLSearchParams(),
}));

const mockCategoriesApi = {
  getUsage: vi.fn().mockResolvedValue({ count: 0, movableCount: 0 }),
  reassignTransactions: vi.fn().mockResolvedValue(undefined),
  delete: vi.fn().mockResolvedValue(undefined),
};

vi.mock('@/lib/categories', () => ({
  categoriesApi: {
    getUsage: (...args: any[]) => mockCategoriesApi.getUsage(...args),
    reassignTransactions: (...args: any[]) => mockCategoriesApi.reassignTransactions(...args),
    delete: (...args: any[]) => mockCategoriesApi.delete(...args),
  },
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() }),
}));

vi.mock('@/lib/categoryUtils', () => ({
  buildCategoryTree: (cats: any[]) => cats.map((c: any) => ({ category: c, level: 0 })),
}));

function makeCategory(overrides: Partial<Category> & { id: string; name: string }): Category {
  return {
    userId: 'user-1',
    parentId: null,
    parent: null,
    children: [],
    description: null,
    icon: null,
    color: null,
    effectiveColor: null,
    effectiveIcon: null,
    autoSign: null,
    effectiveAutoSign: true,
    categoryType: 'expense',
    isSystem: false,
    createdAt: '2026-01-01T00:00:00Z',
    transactionCount: 0,
    ...overrides,
  };
}

describe('CategoryList', () => {
  const onEdit = vi.fn();
  const onRefresh = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  // Empty state
  it('renders the first-run empty state with its actions when there are no categories', () => {
    const onCreate = vi.fn();
    const onImportDefaults = vi.fn();
    render(
      <CategoryList
        categories={[]}
        onEdit={onEdit}
        onRefresh={onRefresh}
        onCreate={onCreate}
        onImportDefaults={onImportDefaults}
      />,
    );
    expect(screen.getByRole('heading', { name: 'No categories yet' })).toBeInTheDocument();
    expect(screen.getByText(/The default set includes common income and expense categories/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Import Default Categories' }));
    expect(onImportDefaults).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Create Your Own' }));
    expect(onCreate).toHaveBeenCalledTimes(1);
  });

  it('renders the no-match empty state, without the first-run actions, when a filter hides every category', () => {
    render(
      <CategoryList
        categories={[]}
        onEdit={onEdit}
        onRefresh={onRefresh}
        isFiltered
        onCreate={vi.fn()}
        onImportDefaults={vi.fn()}
      />,
    );
    expect(screen.getByRole('heading', { name: 'No categories found' })).toBeInTheDocument();
    expect(screen.getByText('No categories match your current search or filter.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Import Default Categories' })).not.toBeInTheDocument();
  });

  it('does not render table in empty state', () => {
    render(<CategoryList categories={[]} onEdit={onEdit} onRefresh={onRefresh} />);
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  // Rendering categories
  it('renders categories table with data', () => {
    const categories = [
      makeCategory({ id: 'c1', name: 'Food', categoryType: 'expense', transactionCount: 5 }),
      makeCategory({ id: 'c2', name: 'Salary', categoryType: 'income', transactionCount: 12 }),
    ];

    render(<CategoryList categories={categories} onEdit={onEdit} onRefresh={onRefresh} />);
    expect(screen.getByText('Food')).toBeInTheDocument();
    expect(screen.getByText('Salary')).toBeInTheDocument();
  });

  it('marks the table and each row for the UI styles, rows carrying their tree depth', () => {
    const categories = [
      makeCategory({ id: 'p', name: 'Food' }),
      makeCategory({ id: 'c', name: 'Groceries', parentId: 'p' }),
    ];

    render(<CategoryList categories={categories} onEdit={onEdit} onRefresh={onRefresh} />);
    expect(screen.getByRole('table')).toHaveClass('ui-list-ledger', 'ui-list-categories');
    const levels = screen
      .getAllByRole('row')
      .filter((row) => row.classList.contains('ui-list-row'))
      .map((row) => row.getAttribute('data-level'));
    expect(levels).toEqual(['0', '1']);
  });

  it('shows income/expense badge for each category', () => {
    const categories = [
      makeCategory({ id: 'c1', name: 'Food', categoryType: 'expense' }),
      makeCategory({ id: 'c2', name: 'Salary', categoryType: 'income' }),
    ];

    render(<CategoryList categories={categories} onEdit={onEdit} onRefresh={onRefresh} />);
    expect(screen.getByText('Expense')).toBeInTheDocument();
    expect(screen.getByText('Income')).toBeInTheDocument();
  });

  it('marks a Transfer category as one, never as an expense', () => {
    const categories = [
      makeCategory({ id: 'c1', name: 'Savings', categoryType: 'transfer' }),
    ];

    render(<CategoryList categories={categories} onEdit={onEdit} onRefresh={onRefresh} />);
    expect(screen.getByText('Transfer')).toBeInTheDocument();
    expect(screen.queryByText('Expense')).not.toBeInTheDocument();
  });

  it('displays transaction count for each category', () => {
    const categories = [
      makeCategory({ id: 'c1', name: 'Food', transactionCount: 5 }),
      makeCategory({ id: 'c2', name: 'Salary', transactionCount: 12 }),
    ];

    render(<CategoryList categories={categories} onEdit={onEdit} onRefresh={onRefresh} />);
    expect(screen.getByText('5')).toBeInTheDocument();
    expect(screen.getByText('12')).toBeInTheDocument();
  });

  it('shows usageCount, not transactionCount, when the list carries it', () => {
    // Used only by a schedule: no transactions, but a delete would be refused.
    const categories = [
      makeCategory({ id: 'c1', name: 'Rent', transactionCount: 0, usageCount: 7 }),
    ];

    render(<CategoryList categories={categories} onEdit={onEdit} onRefresh={onRefresh} />);
    expect(screen.getByText('7')).toBeInTheDocument();
    expect(screen.queryByText('0')).not.toBeInTheDocument();
  });

  it('sorts by usageCount, not transactionCount', () => {
    const categories = [
      makeCategory({ id: 'c1', name: 'Alpha', transactionCount: 9, usageCount: 1 }),
      makeCategory({ id: 'c2', name: 'Beta', transactionCount: 0, usageCount: 5 }),
    ];
    render(
      <CategoryList
        categories={categories}
        onEdit={onEdit}
        onRefresh={onRefresh}
        sortField="count"
        sortDirection="desc"
      />,
    );
    const names = screen
      .getAllByRole('row')
      .slice(1)
      .map((row) => within(row).getAllByRole('button')[0].textContent);
    expect(names).toEqual(['Beta', 'Alpha']);
  });

  it('displays 0 when transactionCount is undefined', () => {
    const categories = [
      makeCategory({ id: 'c1', name: 'Food', transactionCount: undefined }),
    ];

    render(<CategoryList categories={categories} onEdit={onEdit} onRefresh={onRefresh} />);
    expect(screen.getByText('0')).toBeInTheDocument();
  });

  it('displays description when available', () => {
    const categories = [
      makeCategory({ id: 'c1', name: 'Food', description: 'Groceries and dining' }),
    ];

    render(<CategoryList categories={categories} onEdit={onEdit} onRefresh={onRefresh} />);
    expect(screen.getByText('Groceries and dining')).toBeInTheDocument();
  });

  it('displays dash for empty description', () => {
    const categories = [
      makeCategory({ id: 'c1', name: 'Food', description: null }),
    ];

    render(<CategoryList categories={categories} onEdit={onEdit} onRefresh={onRefresh} />);
    expect(screen.getByText('-')).toBeInTheDocument();
  });

  it('shows color indicator when category has color', () => {
    const categories = [
      makeCategory({ id: 'c1', name: 'Food', color: '#ef4444', effectiveColor: '#ef4444' }),
    ];

    render(<CategoryList categories={categories} onEdit={onEdit} onRefresh={onRefresh} />);
    const colorDot = screen.getByText('Food').closest('div')?.querySelector('span[style]');
    expect(colorDot).toBeTruthy();
    // jsdom converts hex to rgb, so check for the rgb equivalent
    expect(colorDot?.getAttribute('style')).toContain('background-color');
  });

  it('shows inherited color indicator with half opacity when color is inherited', () => {
    const categories = [
      makeCategory({ id: 'c1', name: 'Food', color: null, effectiveColor: '#3b82f6' }),
    ];

    render(<CategoryList categories={categories} onEdit={onEdit} onRefresh={onRefresh} />);
    const colorDot = screen.getByText('Food').closest('div')?.querySelector('span[style]');
    expect(colorDot).toBeTruthy();
    expect(colorDot?.getAttribute('style')).toContain('background-color');
    expect(colorDot?.classList.contains('opacity-50')).toBe(true);
    expect(colorDot?.getAttribute('title')).toBe('Inherited from parent');
  });

  it('shows full opacity color dot when color is explicitly set', () => {
    const categories = [
      makeCategory({ id: 'c1', name: 'Food', color: '#ef4444', effectiveColor: '#ef4444' }),
    ];

    render(<CategoryList categories={categories} onEdit={onEdit} onRefresh={onRefresh} />);
    const colorDot = screen.getByText('Food').closest('div')?.querySelector('span[style]');
    expect(colorDot).toBeTruthy();
    expect(colorDot?.classList.contains('opacity-50')).toBe(false);
    expect(colorDot?.getAttribute('title')).toBeNull();
  });

  it('does not show color indicator when effectiveColor is null', () => {
    const categories = [
      makeCategory({ id: 'c1', name: 'Food', color: null, effectiveColor: null }),
    ];

    render(<CategoryList categories={categories} onEdit={onEdit} onRefresh={onRefresh} />);
    const colorDot = screen.getByText('Food').closest('div')?.querySelector('span[style]');
    expect(colorDot).toBeNull();
  });

  // System category
  it('shows system category label', () => {
    const categories = [
      makeCategory({ id: 'c1', name: 'Transfer', isSystem: true }),
    ];

    render(<CategoryList categories={categories} onEdit={onEdit} onRefresh={onRefresh} />);
    expect(screen.getByText('(System)')).toBeInTheDocument();
  });

  it('does not show delete button for system categories', () => {
    const categories = [
      makeCategory({ id: 'c1', name: 'Transfer', isSystem: true }),
    ];

    render(<CategoryList categories={categories} onEdit={onEdit} onRefresh={onRefresh} />);
    expect(screen.queryByText('Delete')).not.toBeInTheDocument();
  });

  it('shows delete button for non-system categories', () => {
    const categories = [
      makeCategory({ id: 'c1', name: 'Food', isSystem: false }),
    ];

    render(<CategoryList categories={categories} onEdit={onEdit} onRefresh={onRefresh} />);
    expect(screen.getByText('Delete')).toBeInTheDocument();
  });

  // Edit button
  it('calls onEdit when edit button is clicked', () => {
    const categories = [
      makeCategory({ id: 'c1', name: 'Food' }),
    ];

    render(<CategoryList categories={categories} onEdit={onEdit} onRefresh={onRefresh} />);
    fireEvent.click(screen.getByText('Edit'));
    expect(onEdit).toHaveBeenCalledWith(expect.objectContaining({ name: 'Food' }));
  });

  // View transactions
  it('navigates to transactions page when category name is clicked', () => {
    const categories = [
      makeCategory({ id: 'c1', name: 'Food' }),
    ];

    render(<CategoryList categories={categories} onEdit={onEdit} onRefresh={onRefresh} />);
    fireEvent.click(screen.getByText('Food'));
    expect(mockPush).toHaveBeenCalledWith('/transactions?categoryId=c1');
  });

  // Row click -> detail page
  it('navigates to the category detail page when the row is clicked', () => {
    const categories = [
      makeCategory({ id: 'c1', name: 'Food' }),
    ];

    render(<CategoryList categories={categories} onEdit={onEdit} onRefresh={onRefresh} />);
    // Click the row itself (via a cell without its own handler), matching the
    // payees/accounts/securities lists. Edit stays on the row actions.
    fireEvent.click(screen.getByText('Food').closest('tr')!);
    expect(mockPush).toHaveBeenCalledWith('/categories/c1');
    expect(onEdit).not.toHaveBeenCalled();
  });

  // Delete flow
  it('opens delete dialog when delete button is clicked', async () => {
    mockCategoriesApi.getUsage.mockResolvedValueOnce({ count: 0, movableCount: 0 });
    const categories = [
      makeCategory({ id: 'c1', name: 'Food', isSystem: false }),
    ];

    render(<CategoryList categories={categories} onEdit={onEdit} onRefresh={onRefresh} />);
    fireEvent.click(screen.getByText('Delete'));

    // DeleteCategoryDialog should open - it shows the category name in title
    await waitFor(() => {
      expect(screen.getByText('Delete "Food"')).toBeInTheDocument();
    });
  });

  it('closes delete dialog on cancel', async () => {
    const categories = [
      makeCategory({ id: 'c1', name: 'Food', isSystem: false }),
    ];

    render(<CategoryList categories={categories} onEdit={onEdit} onRefresh={onRefresh} />);
    fireEvent.click(screen.getByText('Delete'));

    expect(screen.getByText('Delete "Food"')).toBeInTheDocument();

    // Click Cancel
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    await waitFor(() => {
      expect(screen.queryByText('Delete "Food"')).not.toBeInTheDocument();
    });
  });

  it('deletes category and calls onRefresh on confirm when onDelete not provided', async () => {
    mockCategoriesApi.getUsage.mockResolvedValueOnce({ count: 0, movableCount: 0 });
    const categories = [
      makeCategory({ id: 'c1', name: 'Food', isSystem: false }),
    ];

    render(<CategoryList categories={categories} onEdit={onEdit} onRefresh={onRefresh} />);
    fireEvent.click(screen.getByText('Delete'));

    await waitFor(() => {
      expect(screen.getByText('Delete "Food"')).toBeInTheDocument();
    });

    // Click the Delete confirm button in the dialog
    const deleteButtons = screen.getAllByText('Delete');
    // Last one should be the confirm button in the dialog
    const confirmButton = deleteButtons[deleteButtons.length - 1];
    fireEvent.click(confirmButton);

    await waitFor(() => {
      expect(mockCategoriesApi.delete).toHaveBeenCalledWith('c1', undefined);
    });

    await waitFor(() => {
      expect(onRefresh).toHaveBeenCalled();
    });
  });

  it('reassigns and deletes in one DELETE request when the category has transactions', async () => {
    mockCategoriesApi.getUsage.mockResolvedValueOnce({ count: 4, movableCount: 4 });
    const categories = [
      makeCategory({ id: 'c1', name: 'Food', isSystem: false }),
    ];

    render(<CategoryList categories={categories} onEdit={onEdit} onRefresh={onRefresh} />);
    fireEvent.click(screen.getByText('Delete'));
    await waitFor(() => {
      expect(screen.getByText('Delete "Food"')).toBeInTheDocument();
    });
    const deleteButtons = screen.getAllByText('Delete');
    fireEvent.click(deleteButtons[deleteButtons.length - 1]);

    await waitFor(() => {
      expect(mockCategoriesApi.delete).toHaveBeenCalledWith('c1', null);
    });
    expect(mockCategoriesApi.reassignTransactions).not.toHaveBeenCalled();
  });

  it('refreshes the list after a delete that reassigned rows, so the target count updates', async () => {
    mockCategoriesApi.getUsage.mockResolvedValueOnce({ count: 4, movableCount: 4 });
    const onDeleteFn = vi.fn();
    render(
      <CategoryList
        categories={[makeCategory({ id: 'c1', name: 'Food', isSystem: false })]}
        onEdit={onEdit}
        onRefresh={onRefresh}
        onDelete={onDeleteFn}
      />,
    );
    fireEvent.click(screen.getByText('Delete'));
    await waitFor(() => expect(screen.getByText('Delete "Food"')).toBeInTheDocument());
    const deleteButtons = screen.getAllByText('Delete');
    fireEvent.click(deleteButtons[deleteButtons.length - 1]);

    await waitFor(() => expect(onDeleteFn).toHaveBeenCalledWith('c1'));
    expect(onRefresh).toHaveBeenCalled();
  });

  it('shows what still uses the category, linked, when the delete is refused with 409', async () => {
    mockCategoriesApi.getUsage.mockResolvedValueOnce({ count: 0, movableCount: 0 });
    mockCategoriesApi.delete.mockRejectedValueOnce({
      response: {
        status: 409,
        data: {
          errorCode: 'RECORD_IN_USE',
          errors: [{ kind: 'subcategories', count: 2 }, { kind: 'budgetLines', count: 1 }, { kind: 'payrollDeductionRules', count: 1 }],
        },
      },
    });
    render(<CategoryList categories={[makeCategory({ id: 'c1', name: 'Food', isSystem: false })]} onEdit={onEdit} onRefresh={onRefresh} />);
    fireEvent.click(screen.getByText('Delete'));
    await waitFor(() => expect(screen.getByText('Delete "Food"')).toBeInTheDocument());
    const deleteButtons = screen.getAllByText('Delete');
    fireEvent.click(deleteButtons[deleteButtons.length - 1]);

    expect(await screen.findByText('Cannot delete "Food"')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '2 subcategories' })).toHaveAttribute('href', '/categories/c1');
    expect(screen.getByRole('link', { name: '1 budget line' })).toHaveAttribute('href', '/budgets');
    expect(onRefresh).not.toHaveBeenCalled();
  });

  it('calls onDelete instead of onRefresh when onDelete is provided', async () => {
    mockCategoriesApi.getUsage.mockResolvedValueOnce({ count: 0, movableCount: 0 });
    const onDeleteFn = vi.fn();
    const categories = [
      makeCategory({ id: 'c1', name: 'Food', isSystem: false }),
    ];

    render(<CategoryList categories={categories} onEdit={onEdit} onRefresh={onRefresh} onDelete={onDeleteFn} />);
    fireEvent.click(screen.getByText('Delete'));

    await waitFor(() => {
      expect(screen.getByText('Delete "Food"')).toBeInTheDocument();
    });

    const deleteButtons = screen.getAllByText('Delete');
    const confirmButton = deleteButtons[deleteButtons.length - 1];
    fireEvent.click(confirmButton);

    await waitFor(() => {
      expect(mockCategoriesApi.delete).toHaveBeenCalledWith('c1', undefined);
    });

    await waitFor(() => {
      expect(onDeleteFn).toHaveBeenCalledWith('c1');
    });

    expect(onRefresh).not.toHaveBeenCalled();
  });

  // Subcategories (tree structure)
  it('renders subcategories indented under parent', () => {
    const categories = [
      makeCategory({ id: 'c1', name: 'Food', parentId: null }),
      makeCategory({ id: 'c2', name: 'Groceries', parentId: 'c1' }),
      makeCategory({ id: 'c3', name: 'Dining', parentId: 'c1' }),
    ];

    render(<CategoryList categories={categories} onEdit={onEdit} onRefresh={onRefresh} />);
    expect(screen.getByText('Food')).toBeInTheDocument();
    expect(screen.getByText('Groceries')).toBeInTheDocument();
    expect(screen.getByText('Dining')).toBeInTheDocument();
  });

  // Sorting
  it('renders column headers with sort indicators', () => {
    const categories = [
      makeCategory({ id: 'c1', name: 'Food' }),
    ];

    render(<CategoryList categories={categories} onEdit={onEdit} onRefresh={onRefresh} />);
    expect(screen.getByText('Name')).toBeInTheDocument();
    expect(screen.getByText('Type')).toBeInTheDocument();
    expect(screen.getByText('Count')).toBeInTheDocument();
    expect(screen.getByText('Actions')).toBeInTheDocument();
  });

  it('toggles sort direction when clicking same column header', () => {
    const categories = [
      makeCategory({ id: 'c1', name: 'Food', transactionCount: 5 }),
      makeCategory({ id: 'c2', name: 'Salary', transactionCount: 12, categoryType: 'income' }),
    ];

    render(<CategoryList categories={categories} onEdit={onEdit} onRefresh={onRefresh} />);

    // Click Name header to toggle sort (default is asc by name)
    fireEvent.click(screen.getByText('Name'));

    // Categories should still render
    expect(screen.getByText('Food')).toBeInTheDocument();
    expect(screen.getByText('Salary')).toBeInTheDocument();
  });

  it('sorts by type when Type header is clicked', () => {
    const categories = [
      makeCategory({ id: 'c1', name: 'Food', categoryType: 'expense' }),
      makeCategory({ id: 'c2', name: 'Salary', categoryType: 'income' }),
    ];

    render(<CategoryList categories={categories} onEdit={onEdit} onRefresh={onRefresh} />);
    fireEvent.click(screen.getByText('Type'));

    expect(screen.getByText('Food')).toBeInTheDocument();
    expect(screen.getByText('Salary')).toBeInTheDocument();
  });

  it('sorts by count when Count header is clicked', () => {
    const categories = [
      makeCategory({ id: 'c1', name: 'Food', transactionCount: 5 }),
      makeCategory({ id: 'c2', name: 'Salary', transactionCount: 12, categoryType: 'income' }),
    ];

    render(<CategoryList categories={categories} onEdit={onEdit} onRefresh={onRefresh} />);
    fireEvent.click(screen.getByText('Count'));

    expect(screen.getByText('Food')).toBeInTheDocument();
    expect(screen.getByText('Salary')).toBeInTheDocument();
  });

  it('announces the sort on a th aria-sort holding a keyboard button', () => {
    useDensityStore.setState({ densities: { categories: 'normal' } });
    const onSort = vi.fn();
    render(
      <CategoryList
        categories={[makeCategory({ id: 'c1', name: 'Food' })]}
        onEdit={onEdit}
        onRefresh={onRefresh}
        sortField="count"
        sortDirection="desc"
        onSort={onSort}
      />,
    );
    const countHeader = screen.getByRole('columnheader', { name: /Count/ });
    expect(countHeader).toHaveAttribute('aria-sort', 'descending');
    expect(screen.getByRole('columnheader', { name: /Name/ })).toHaveAttribute('aria-sort', 'none');
    expect(screen.getByRole('columnheader', { name: /Description/ })).not.toHaveAttribute('aria-sort');
    fireEvent.click(within(countHeader).getByRole('button'));
    expect(onSort).toHaveBeenCalledWith('count');
  });

  it('sorts siblings within their parent, never moving a subcategory out of its branch', () => {
    const categories = [
      makeCategory({ id: 'p1', name: 'Food', transactionCount: 1 }),
      makeCategory({ id: 'c1', name: 'Groceries', parentId: 'p1', transactionCount: 2 }),
      makeCategory({ id: 'c2', name: 'Dining', parentId: 'p1', transactionCount: 50 }),
      makeCategory({ id: 'p2', name: 'Bills', transactionCount: 10 }),
    ];
    render(
      <CategoryList
        categories={categories}
        onEdit={onEdit}
        onRefresh={onRefresh}
        sortField="count"
        sortDirection="desc"
      />,
    );
    const names = screen
      .getAllByRole('row')
      .slice(1)
      .map((row) => within(row).getAllByRole('button')[0].textContent);
    expect(names).toEqual(['Bills', 'Food', 'Dining', 'Groceries']);
  });

  // Density toggle
  it('renders density toggle button', () => {
    const categories = [
      makeCategory({ id: 'c1', name: 'Food' }),
    ];

    render(<CategoryList categories={categories} onEdit={onEdit} onRefresh={onRefresh} />);
    expect(screen.getByTitle('Toggle row density')).toBeInTheDocument();
    expect(screen.getByText('Normal')).toBeInTheDocument();
  });

  it('cycles density from normal to compact on click', () => {
    const categories = [
      makeCategory({ id: 'c1', name: 'Food' }),
    ];

    render(<CategoryList categories={categories} onEdit={onEdit} onRefresh={onRefresh} />);
    fireEvent.click(screen.getByTitle('Toggle row density'));

    expect(screen.getByText('Compact')).toBeInTheDocument();
  });

  it('cycles density from compact to dense on second click', () => {
    const categories = [
      makeCategory({ id: 'c1', name: 'Food' }),
    ];

    render(<CategoryList categories={categories} onEdit={onEdit} onRefresh={onRefresh} />);
    const densityButton = screen.getByTitle('Toggle row density');
    fireEvent.click(densityButton); // normal -> compact
    fireEvent.click(densityButton); // compact -> dense

    expect(screen.getByText('Dense')).toBeInTheDocument();
  });

  it('cycles density from dense back to normal on third click', () => {
    const categories = [
      makeCategory({ id: 'c1', name: 'Food' }),
    ];

    render(<CategoryList categories={categories} onEdit={onEdit} onRefresh={onRefresh} />);
    const densityButton = screen.getByTitle('Toggle row density');
    fireEvent.click(densityButton); // normal -> compact
    fireEvent.click(densityButton); // compact -> dense
    fireEvent.click(densityButton); // dense -> normal

    expect(screen.getByText('Normal')).toBeInTheDocument();
  });

  it('uses prop density when provided', () => {
    const categories = [
      makeCategory({ id: 'c1', name: 'Food' }),
    ];

    useDensityStore.setState({ densities: { categories: 'compact' } });
    render(<CategoryList categories={categories} onEdit={onEdit} onRefresh={onRefresh} />);
    expect(screen.getByText('Compact')).toBeInTheDocument();
  });

  it('cycles the shared density preference', () => {
    const categories = [
      makeCategory({ id: 'c1', name: 'Food' }),
    ];

    useDensityStore.setState({ densities: { categories: 'normal' } });
    render(
      <CategoryList
        categories={categories}
        onEdit={onEdit}
        onRefresh={onRefresh}
      />,
    );
    fireEvent.click(screen.getByTitle('Toggle row density'));
    expect(useDensityStore.getState().densities.categories).toBe('compact');
  });

  it('hides description column in dense mode', () => {
    const categories = [
      makeCategory({ id: 'c1', name: 'Food', description: 'Groceries' }),
    ];

    useDensityStore.setState({ densities: { categories: 'dense' } });
    render(<CategoryList categories={categories} onEdit={onEdit} onRefresh={onRefresh} />);
    expect(screen.queryByText('Description')).not.toBeInTheDocument();
    expect(screen.queryByText('Groceries')).not.toBeInTheDocument();
  });

  it('hides description column in compact mode', () => {
    const categories = [
      makeCategory({ id: 'c1', name: 'Food', description: 'Groceries' }),
    ];

    useDensityStore.setState({ densities: { categories: 'compact' } });
    render(<CategoryList categories={categories} onEdit={onEdit} onRefresh={onRefresh} />);
    expect(screen.queryByText('Description')).not.toBeInTheDocument();
  });

  it('does not show system label in dense mode', () => {
    const categories = [
      makeCategory({ id: 'c1', name: 'Transfer', isSystem: true }),
    ];

    useDensityStore.setState({ densities: { categories: 'dense' } });
    render(<CategoryList categories={categories} onEdit={onEdit} onRefresh={onRefresh} />);
    expect(screen.queryByText('(System)')).not.toBeInTheDocument();
  });

  // Multiple categories
  it('renders multiple categories with edit buttons', () => {
    const categories = [
      makeCategory({ id: 'c1', name: 'Food' }),
      makeCategory({ id: 'c2', name: 'Transport' }),
      makeCategory({ id: 'c3', name: 'Utilities' }),
    ];

    render(<CategoryList categories={categories} onEdit={onEdit} onRefresh={onRefresh} />);
    const editButtons = screen.getAllByText('Edit');
    expect(editButtons).toHaveLength(3);
  });

  it('renders multiple non-system categories with delete buttons', () => {
    const categories = [
      makeCategory({ id: 'c1', name: 'Food' }),
      makeCategory({ id: 'c2', name: 'Transport' }),
    ];

    render(<CategoryList categories={categories} onEdit={onEdit} onRefresh={onRefresh} />);
    const deleteButtons = screen.getAllByText('Delete');
    expect(deleteButtons).toHaveLength(2);
  });
});
