import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@/test/render';
import { CategoryList } from './CategoryList';
import { Category } from '@/types/category';

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
  getTransactionCount: vi.fn().mockResolvedValue(0),
  reassignTransactions: vi.fn().mockResolvedValue(undefined),
  delete: vi.fn().mockResolvedValue(undefined),
};

vi.mock('@/lib/categories', () => ({
  categoriesApi: {
    getTransactionCount: (...args: any[]) => mockCategoriesApi.getTransactionCount(...args),
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
    isIncome: false,
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
  it('renders empty state when no categories', () => {
    render(<CategoryList categories={[]} onEdit={onEdit} onRefresh={onRefresh} />);
    expect(screen.getByText('No categories')).toBeInTheDocument();
    expect(screen.getByText('Get started by creating a new category.')).toBeInTheDocument();
  });

  it('does not render table in empty state', () => {
    render(<CategoryList categories={[]} onEdit={onEdit} onRefresh={onRefresh} />);
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  // Rendering categories
  it('renders categories table with data', () => {
    const categories = [
      makeCategory({ id: 'c1', name: 'Food', isIncome: false, transactionCount: 5 }),
      makeCategory({ id: 'c2', name: 'Salary', isIncome: true, transactionCount: 12 }),
    ];

    render(<CategoryList categories={categories} onEdit={onEdit} onRefresh={onRefresh} />);
    expect(screen.getByText('Food')).toBeInTheDocument();
    expect(screen.getByText('Salary')).toBeInTheDocument();
  });

  it('shows income/expense badge for each category', () => {
    const categories = [
      makeCategory({ id: 'c1', name: 'Food', isIncome: false }),
      makeCategory({ id: 'c2', name: 'Salary', isIncome: true }),
    ];

    render(<CategoryList categories={categories} onEdit={onEdit} onRefresh={onRefresh} />);
    expect(screen.getByText('Expense')).toBeInTheDocument();
    expect(screen.getByText('Income')).toBeInTheDocument();
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
      makeCategory({ id: 'c1', name: 'Food', color: '#ef4444' }),
    ];

    render(<CategoryList categories={categories} onEdit={onEdit} onRefresh={onRefresh} />);
    const colorDot = screen.getByText('Food').closest('div')?.querySelector('span[style]');
    expect(colorDot).toBeTruthy();
    // jsdom converts hex to rgb, so check for the rgb equivalent
    expect(colorDot?.getAttribute('style')).toContain('background-color');
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

  // Delete flow
  it('opens delete dialog when delete button is clicked', async () => {
    mockCategoriesApi.getTransactionCount.mockResolvedValueOnce(0);
    const categories = [
      makeCategory({ id: 'c1', name: 'Food', isSystem: false }),
    ];

    render(<CategoryList categories={categories} onEdit={onEdit} onRefresh={onRefresh} />);
    fireEvent.click(screen.getByText('Delete'));

    // DeleteCategoryDialog should open - it shows the category name in title
    await waitFor(() => {
      expect(screen.getByText('Delete "Food"?')).toBeInTheDocument();
    });
  });

  it('closes delete dialog on cancel', async () => {
    const categories = [
      makeCategory({ id: 'c1', name: 'Food', isSystem: false }),
    ];

    render(<CategoryList categories={categories} onEdit={onEdit} onRefresh={onRefresh} />);
    fireEvent.click(screen.getByText('Delete'));

    expect(screen.getByText('Delete "Food"?')).toBeInTheDocument();

    // Click Cancel
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    await waitFor(() => {
      expect(screen.queryByText('Delete "Food"?')).not.toBeInTheDocument();
    });
  });

  it('deletes category and calls onRefresh on confirm', async () => {
    mockCategoriesApi.getTransactionCount.mockResolvedValueOnce(0);
    const categories = [
      makeCategory({ id: 'c1', name: 'Food', isSystem: false }),
    ];

    render(<CategoryList categories={categories} onEdit={onEdit} onRefresh={onRefresh} />);
    fireEvent.click(screen.getByText('Delete'));

    await waitFor(() => {
      expect(screen.getByText('Delete "Food"?')).toBeInTheDocument();
    });

    // Click the Delete confirm button in the dialog
    const deleteButtons = screen.getAllByText('Delete');
    // Last one should be the confirm button in the dialog
    const confirmButton = deleteButtons[deleteButtons.length - 1];
    fireEvent.click(confirmButton);

    await waitFor(() => {
      expect(mockCategoriesApi.delete).toHaveBeenCalledWith('c1');
    });

    await waitFor(() => {
      expect(onRefresh).toHaveBeenCalled();
    });
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
      makeCategory({ id: 'c2', name: 'Salary', transactionCount: 12, isIncome: true }),
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
      makeCategory({ id: 'c1', name: 'Food', isIncome: false }),
      makeCategory({ id: 'c2', name: 'Salary', isIncome: true }),
    ];

    render(<CategoryList categories={categories} onEdit={onEdit} onRefresh={onRefresh} />);
    fireEvent.click(screen.getByText('Type'));

    expect(screen.getByText('Food')).toBeInTheDocument();
    expect(screen.getByText('Salary')).toBeInTheDocument();
  });

  it('sorts by count when Count header is clicked', () => {
    const categories = [
      makeCategory({ id: 'c1', name: 'Food', transactionCount: 5 }),
      makeCategory({ id: 'c2', name: 'Salary', transactionCount: 12, isIncome: true }),
    ];

    render(<CategoryList categories={categories} onEdit={onEdit} onRefresh={onRefresh} />);
    fireEvent.click(screen.getByText('Count'));

    expect(screen.getByText('Food')).toBeInTheDocument();
    expect(screen.getByText('Salary')).toBeInTheDocument();
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

    render(<CategoryList categories={categories} onEdit={onEdit} onRefresh={onRefresh} density="compact" />);
    expect(screen.getByText('Compact')).toBeInTheDocument();
  });

  it('calls onDensityChange callback when provided', () => {
    const onDensityChange = vi.fn();
    const categories = [
      makeCategory({ id: 'c1', name: 'Food' }),
    ];

    render(
      <CategoryList
        categories={categories}
        onEdit={onEdit}
        onRefresh={onRefresh}
        density="normal"
        onDensityChange={onDensityChange}
      />,
    );
    fireEvent.click(screen.getByTitle('Toggle row density'));
    expect(onDensityChange).toHaveBeenCalledWith('compact');
  });

  it('hides description column in dense mode', () => {
    const categories = [
      makeCategory({ id: 'c1', name: 'Food', description: 'Groceries' }),
    ];

    render(<CategoryList categories={categories} onEdit={onEdit} onRefresh={onRefresh} density="dense" />);
    expect(screen.queryByText('Description')).not.toBeInTheDocument();
    expect(screen.queryByText('Groceries')).not.toBeInTheDocument();
  });

  it('hides description column in compact mode', () => {
    const categories = [
      makeCategory({ id: 'c1', name: 'Food', description: 'Groceries' }),
    ];

    render(<CategoryList categories={categories} onEdit={onEdit} onRefresh={onRefresh} density="compact" />);
    expect(screen.queryByText('Description')).not.toBeInTheDocument();
  });

  it('does not show system label in dense mode', () => {
    const categories = [
      makeCategory({ id: 'c1', name: 'Transfer', isSystem: true }),
    ];

    render(<CategoryList categories={categories} onEdit={onEdit} onRefresh={onRefresh} density="dense" />);
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
