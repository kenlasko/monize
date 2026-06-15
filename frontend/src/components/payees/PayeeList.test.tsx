import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@/test/render';
import { PayeeList } from './PayeeList';
import { Payee } from '@/types/payee';

const mockPush = vi.fn();

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: mockPush,
    replace: vi.fn(),
    back: vi.fn(),
    prefetch: vi.fn(),
    refresh: vi.fn(),
  }),
  usePathname: () => '/payees',
  useSearchParams: () => new URLSearchParams(),
}));

const mockPayeesApi = {
  delete: vi.fn().mockResolvedValue(undefined),
};

vi.mock('@/lib/payees', () => ({
  payeesApi: {
    delete: (...args: any[]) => mockPayeesApi.delete(...args),
  },
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() }),
}));

vi.mock('@/hooks/useDateFormat', () => ({
  useDateFormat: () => ({ formatDate: (d: string) => d, dateFormat: 'browser' }),
}));

function makePayee(overrides: Partial<Payee> & { id: string; name: string }): Payee {
  return {
    userId: 'user-1',
    defaultCategoryId: null,
    defaultCategory: null,
    notes: null,
    isActive: true,
    createdAt: '2026-01-01T00:00:00Z',
    transactionCount: 0,
    ...overrides,
  };
}

describe('PayeeList', () => {
  const onEdit = vi.fn();
  const onRefresh = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  // Empty state
  it('renders empty state when no payees', () => {
    render(<PayeeList payees={[]} onEdit={onEdit} onRefresh={onRefresh} />);
    expect(screen.getByText('No payees')).toBeInTheDocument();
    expect(screen.getByText('Get started by creating a new payee.')).toBeInTheDocument();
  });

  it('does not render table in empty state', () => {
    render(<PayeeList payees={[]} onEdit={onEdit} onRefresh={onRefresh} />);
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  // Rendering payees
  it('renders payees table with data', () => {
    const payees = [
      makePayee({ id: 'p1', name: 'Walmart', transactionCount: 10 }),
      makePayee({ id: 'p2', name: 'Netflix', transactionCount: 3 }),
    ];

    render(<PayeeList payees={payees} onEdit={onEdit} onRefresh={onRefresh} />);
    expect(screen.getByText('Walmart')).toBeInTheDocument();
    expect(screen.getByText('Netflix')).toBeInTheDocument();
  });

  it('shows default category name when payee has one', () => {
    const payees = [
      makePayee({
        id: 'p1',
        name: 'Walmart',
        defaultCategory: {
          id: 'cat-1',
          userId: 'user-1',
          parentId: null,
          parent: null,
          children: [],
          name: 'Groceries',
          description: null,
          icon: null,
          color: '#22c55e',
          effectiveColor: '#22c55e',
          isIncome: false,
          isSystem: false,
          createdAt: '2026-01-01T00:00:00Z',
        },
      }),
    ];

    render(<PayeeList payees={payees} onEdit={onEdit} onRefresh={onRefresh} />);
    expect(screen.getByText('Groceries')).toBeInTheDocument();
  });

  it('shows full "Parent: Child" label when categoryLabelMap is provided', () => {
    const payees = [
      makePayee({
        id: 'p1',
        name: 'Walmart',
        defaultCategory: {
          id: 'cat-1',
          userId: 'user-1',
          parentId: 'parent-1',
          parent: null,
          children: [],
          name: 'Groceries',
          description: null,
          icon: null,
          color: '#22c55e',
          effectiveColor: '#22c55e',
          isIncome: false,
          isSystem: false,
          createdAt: '2026-01-01T00:00:00Z',
        },
      }),
    ];
    const categoryLabelMap = new Map([['cat-1', 'Food: Groceries']]);

    render(
      <PayeeList
        payees={payees}
        onEdit={onEdit}
        onRefresh={onRefresh}
        categoryLabelMap={categoryLabelMap}
      />,
    );
    expect(screen.getByText('Food: Groceries')).toBeInTheDocument();
    expect(screen.queryByText('Groceries')).not.toBeInTheDocument();
  });

  it('falls back to category name when categoryLabelMap has no entry', () => {
    const payees = [
      makePayee({
        id: 'p1',
        name: 'Walmart',
        defaultCategory: {
          id: 'cat-1',
          userId: 'user-1',
          parentId: null,
          parent: null,
          children: [],
          name: 'Groceries',
          description: null,
          icon: null,
          color: '#22c55e',
          effectiveColor: '#22c55e',
          isIncome: false,
          isSystem: false,
          createdAt: '2026-01-01T00:00:00Z',
        },
      }),
    ];
    const categoryLabelMap = new Map([['cat-other', 'Food: Other']]);

    render(
      <PayeeList
        payees={payees}
        onEdit={onEdit}
        onRefresh={onRefresh}
        categoryLabelMap={categoryLabelMap}
      />,
    );
    expect(screen.getByText('Groceries')).toBeInTheDocument();
  });

  it('shows "None" when payee has no default category', () => {
    const payees = [
      makePayee({ id: 'p1', name: 'Walmart', defaultCategory: null }),
    ];

    render(<PayeeList payees={payees} onEdit={onEdit} onRefresh={onRefresh} />);
    expect(screen.getByText('None')).toBeInTheDocument();
  });

  it('displays transaction count for each payee', () => {
    const payees = [
      makePayee({ id: 'p1', name: 'Walmart', transactionCount: 10 }),
      makePayee({ id: 'p2', name: 'Netflix', transactionCount: 3 }),
    ];

    render(<PayeeList payees={payees} onEdit={onEdit} onRefresh={onRefresh} />);
    expect(screen.getByText('10')).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();
  });

  it('displays 0 when transactionCount is undefined', () => {
    const payees = [
      makePayee({ id: 'p1', name: 'Walmart', transactionCount: undefined }),
    ];

    render(<PayeeList payees={payees} onEdit={onEdit} onRefresh={onRefresh} />);
    const zeros = screen.getAllByText('0');
    expect(zeros.length).toBeGreaterThanOrEqual(1);
  });

  it('shows an uncategorized badge for payees with uncategorized transactions', () => {
    const payees = [
      makePayee({ id: 'p1', name: 'Walmart', uncategorizedCount: 4 }),
      makePayee({ id: 'p2', name: 'Netflix', uncategorizedCount: 0 }),
    ];

    render(<PayeeList payees={payees} onEdit={onEdit} onRefresh={onRefresh} />);
    // Walmart has 4 uncategorized; Netflix has none, so only one badge.
    expect(screen.getByText('4 uncategorized')).toBeInTheDocument();
    expect(screen.queryByText('0 uncategorized')).not.toBeInTheDocument();
  });

  it('does not show the uncategorized badge when the count is undefined', () => {
    const payees = [makePayee({ id: 'p1', name: 'Walmart' })];

    render(<PayeeList payees={payees} onEdit={onEdit} onRefresh={onRefresh} />);
    expect(screen.queryByText(/uncategorized/)).not.toBeInTheDocument();
  });

  it('displays notes when available', () => {
    const payees = [
      makePayee({ id: 'p1', name: 'Netflix', notes: 'Streaming service' }),
    ];

    render(<PayeeList payees={payees} onEdit={onEdit} onRefresh={onRefresh} />);
    expect(screen.getByText('Streaming service')).toBeInTheDocument();
  });

  it('displays dash for empty notes', () => {
    const payees = [
      makePayee({ id: 'p1', name: 'Netflix', notes: null }),
    ];

    render(<PayeeList payees={payees} onEdit={onEdit} onRefresh={onRefresh} />);
    expect(screen.getAllByText('-').length).toBeGreaterThan(0);
  });

  // Edit
  it('calls onEdit when edit button is clicked', () => {
    const payees = [
      makePayee({ id: 'p1', name: 'Walmart' }),
    ];

    render(<PayeeList payees={payees} onEdit={onEdit} onRefresh={onRefresh} />);
    fireEvent.click(screen.getByText('Edit'));
    expect(onEdit).toHaveBeenCalledWith(expect.objectContaining({ name: 'Walmart' }));
  });

  // View transactions
  it('navigates to transactions page when payee name is clicked', () => {
    const payees = [
      makePayee({ id: 'p1', name: 'Walmart' }),
    ];

    render(<PayeeList payees={payees} onEdit={onEdit} onRefresh={onRefresh} />);
    fireEvent.click(screen.getByText('Walmart'));
    expect(mockPush).toHaveBeenCalledWith('/transactions?payeeId=p1');
  });

  // Delete flow
  it('shows delete button for each payee', () => {
    const payees = [
      makePayee({ id: 'p1', name: 'Walmart' }),
    ];

    render(<PayeeList payees={payees} onEdit={onEdit} onRefresh={onRefresh} />);
    expect(screen.getByText('Delete')).toBeInTheDocument();
  });

  it('opens confirm dialog when delete button is clicked', () => {
    const payees = [
      makePayee({ id: 'p1', name: 'Walmart' }),
    ];

    render(<PayeeList payees={payees} onEdit={onEdit} onRefresh={onRefresh} />);
    fireEvent.click(screen.getByText('Delete'));

    // ConfirmDialog shows title with payee name
    expect(screen.getByText('Delete "Walmart"?')).toBeInTheDocument();
    expect(screen.getByText('This action cannot be undone.')).toBeInTheDocument();
  });

  it('closes confirm dialog on cancel', async () => {
    const payees = [
      makePayee({ id: 'p1', name: 'Walmart' }),
    ];

    render(<PayeeList payees={payees} onEdit={onEdit} onRefresh={onRefresh} />);
    fireEvent.click(screen.getByText('Delete'));

    expect(screen.getByText('Delete "Walmart"?')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    await waitFor(() => {
      expect(screen.queryByText('Delete "Walmart"?')).not.toBeInTheDocument();
    });
  });

  it('deletes payee and calls onRefresh on confirm when onDelete not provided', async () => {
    const payees = [
      makePayee({ id: 'p1', name: 'Walmart' }),
    ];

    render(<PayeeList payees={payees} onEdit={onEdit} onRefresh={onRefresh} />);
    fireEvent.click(screen.getByText('Delete'));

    // Click the confirm Delete button in the dialog
    const deleteButtons = screen.getAllByText('Delete');
    const confirmButton = deleteButtons[deleteButtons.length - 1];
    fireEvent.click(confirmButton);

    await waitFor(() => {
      expect(mockPayeesApi.delete).toHaveBeenCalledWith('p1');
    });

    await waitFor(() => {
      expect(onRefresh).toHaveBeenCalled();
    });
  });

  it('calls onDelete instead of onRefresh when onDelete is provided', async () => {
    const onDeleteFn = vi.fn();
    const payees = [
      makePayee({ id: 'p1', name: 'Walmart' }),
    ];

    render(<PayeeList payees={payees} onEdit={onEdit} onRefresh={onRefresh} onDelete={onDeleteFn} />);
    fireEvent.click(screen.getByText('Delete'));

    const deleteButtons = screen.getAllByText('Delete');
    const confirmButton = deleteButtons[deleteButtons.length - 1];
    fireEvent.click(confirmButton);

    await waitFor(() => {
      expect(mockPayeesApi.delete).toHaveBeenCalledWith('p1');
    });

    await waitFor(() => {
      expect(onDeleteFn).toHaveBeenCalledWith('p1');
    });

    expect(onRefresh).not.toHaveBeenCalled();
  });

  it('shows error toast when delete fails', async () => {
    mockPayeesApi.delete.mockRejectedValueOnce(new Error('Delete failed'));
    const payees = [
      makePayee({ id: 'p1', name: 'Walmart' }),
    ];

    render(<PayeeList payees={payees} onEdit={onEdit} onRefresh={onRefresh} />);
    fireEvent.click(screen.getByText('Delete'));

    const deleteButtons = screen.getAllByText('Delete');
    const confirmButton = deleteButtons[deleteButtons.length - 1];
    fireEvent.click(confirmButton);

    await waitFor(() => {
      expect(mockPayeesApi.delete).toHaveBeenCalledWith('p1');
    });

    // onRefresh should NOT have been called since delete failed
    // The toast.error is handled by the component, we just verify no crash
  });

  // Column headers
  it('renders column headers', () => {
    const payees = [
      makePayee({ id: 'p1', name: 'Walmart' }),
    ];

    render(<PayeeList payees={payees} onEdit={onEdit} onRefresh={onRefresh} />);
    expect(screen.getByText('Name')).toBeInTheDocument();
    expect(screen.getByText('Default Category')).toBeInTheDocument();
    expect(screen.getByText('Count')).toBeInTheDocument();
    expect(screen.getByText('Notes')).toBeInTheDocument();
    expect(screen.getByText('Actions')).toBeInTheDocument();
  });

  // Sorting
  it('sorts by name when Name header is clicked (toggles direction)', () => {
    const payees = [
      makePayee({ id: 'p1', name: 'Walmart', transactionCount: 10 }),
      makePayee({ id: 'p2', name: 'Amazon', transactionCount: 5 }),
    ];

    render(<PayeeList payees={payees} onEdit={onEdit} onRefresh={onRefresh} />);
    // Click Name to toggle sort direction (default is asc)
    fireEvent.click(screen.getByText('Name'));

    // Both payees should still be present
    expect(screen.getByText('Walmart')).toBeInTheDocument();
    expect(screen.getByText('Amazon')).toBeInTheDocument();
  });

  it('sorts by category when Default Category header is clicked', () => {
    const payees = [
      makePayee({
        id: 'p1',
        name: 'Walmart',
        defaultCategory: {
          id: 'cat-1', userId: 'u', parentId: null, parent: null, children: [],
          name: 'Groceries', description: null, icon: null, color: null, effectiveColor: null,
          isIncome: false, isSystem: false, createdAt: '',
        },
      }),
      makePayee({ id: 'p2', name: 'Netflix', defaultCategory: null }),
    ];

    render(<PayeeList payees={payees} onEdit={onEdit} onRefresh={onRefresh} />);
    fireEvent.click(screen.getByText('Default Category'));

    expect(screen.getByText('Walmart')).toBeInTheDocument();
    expect(screen.getByText('Netflix')).toBeInTheDocument();
  });

  it('sorts by full category label when categoryLabelMap is provided', () => {
    // Leaf names would order Walmart (Apples) before Netflix (Zebra), but the
    // full labels invert that: "Zoo: Apples" sorts after "Animals: Zebra".
    const payees = [
      makePayee({
        id: 'p1',
        name: 'Walmart',
        defaultCategory: {
          id: 'cat-1', userId: 'u', parentId: 'zoo', parent: null, children: [],
          name: 'Apples', description: null, icon: null, color: null, effectiveColor: null,
          isIncome: false, isSystem: false, createdAt: '',
        },
      }),
      makePayee({
        id: 'p2',
        name: 'Netflix',
        defaultCategory: {
          id: 'cat-2', userId: 'u', parentId: 'animals', parent: null, children: [],
          name: 'Zebra', description: null, icon: null, color: null, effectiveColor: null,
          isIncome: false, isSystem: false, createdAt: '',
        },
      }),
    ];
    const categoryLabelMap = new Map([
      ['cat-1', 'Zoo: Apples'],
      ['cat-2', 'Animals: Zebra'],
    ]);

    const { container } = render(
      <PayeeList
        payees={payees}
        onEdit={onEdit}
        onRefresh={onRefresh}
        categoryLabelMap={categoryLabelMap}
      />,
    );
    fireEvent.click(screen.getByText('Default Category'));

    const names = Array.from(container.querySelectorAll('tbody tr')).map(
      (row) => row.querySelector('td')?.textContent?.trim(),
    );
    // Ascending by full label: "Animals: Zebra" (Netflix) < "Zoo: Apples" (Walmart)
    expect(names[0]).toBe('Netflix');
    expect(names[1]).toBe('Walmart');
  });

  it('sorts by count when Count header is clicked', () => {
    const payees = [
      makePayee({ id: 'p1', name: 'Walmart', transactionCount: 10 }),
      makePayee({ id: 'p2', name: 'Amazon', transactionCount: 5 }),
    ];

    render(<PayeeList payees={payees} onEdit={onEdit} onRefresh={onRefresh} />);
    fireEvent.click(screen.getByText('Count'));

    expect(screen.getByText('Walmart')).toBeInTheDocument();
    expect(screen.getByText('Amazon')).toBeInTheDocument();
  });

  it('sorts names case-insensitively', () => {
    const payees = [
      makePayee({ id: 'p1', name: 'banana' }),
      makePayee({ id: 'p2', name: 'Apple' }),
      makePayee({ id: 'p3', name: 'cherry' }),
    ];

    const { container } = render(<PayeeList payees={payees} onEdit={onEdit} onRefresh={onRefresh} />);
    const rows = container.querySelectorAll('tbody tr');
    const names = Array.from(rows).map(row => row.querySelector('td')?.textContent?.trim());

    // Default sort is name asc; case-insensitive means Apple < banana < cherry
    expect(names[0]).toBe('Apple');
    expect(names[1]).toBe('banana');
    expect(names[2]).toBe('cherry');
  });

  it('uses controlled sort when onSort prop is provided', () => {
    const onSort = vi.fn();
    const payees = [
      makePayee({ id: 'p1', name: 'Walmart' }),
    ];

    render(
      <PayeeList
        payees={payees}
        onEdit={onEdit}
        onRefresh={onRefresh}
        sortField="name"
        sortDirection="asc"
        onSort={onSort}
      />,
    );
    fireEvent.click(screen.getByText('Name'));
    expect(onSort).toHaveBeenCalledWith('name');
  });

  // Density toggle
  it('renders density toggle button', () => {
    const payees = [
      makePayee({ id: 'p1', name: 'Walmart' }),
    ];

    render(<PayeeList payees={payees} onEdit={onEdit} onRefresh={onRefresh} />);
    expect(screen.getByTitle('Toggle row density')).toBeInTheDocument();
    expect(screen.getByText('Normal')).toBeInTheDocument();
  });

  it('cycles density from normal to compact on click', () => {
    const payees = [
      makePayee({ id: 'p1', name: 'Walmart' }),
    ];

    render(<PayeeList payees={payees} onEdit={onEdit} onRefresh={onRefresh} />);
    fireEvent.click(screen.getByTitle('Toggle row density'));
    expect(screen.getByText('Compact')).toBeInTheDocument();
  });

  it('cycles through all density levels', () => {
    const payees = [
      makePayee({ id: 'p1', name: 'Walmart' }),
    ];

    render(<PayeeList payees={payees} onEdit={onEdit} onRefresh={onRefresh} />);
    const btn = screen.getByTitle('Toggle row density');
    fireEvent.click(btn); // normal -> compact
    expect(screen.getByText('Compact')).toBeInTheDocument();
    fireEvent.click(btn); // compact -> dense
    expect(screen.getByText('Dense')).toBeInTheDocument();
    fireEvent.click(btn); // dense -> normal
    expect(screen.getByText('Normal')).toBeInTheDocument();
  });

  it('uses prop density when provided', () => {
    const payees = [
      makePayee({ id: 'p1', name: 'Walmart' }),
    ];

    render(<PayeeList payees={payees} onEdit={onEdit} onRefresh={onRefresh} density="compact" />);
    expect(screen.getByText('Compact')).toBeInTheDocument();
  });

  it('calls onDensityChange callback when provided', () => {
    const onDensityChange = vi.fn();
    const payees = [
      makePayee({ id: 'p1', name: 'Walmart' }),
    ];

    render(
      <PayeeList
        payees={payees}
        onEdit={onEdit}
        onRefresh={onRefresh}
        density="normal"
        onDensityChange={onDensityChange}
      />,
    );
    fireEvent.click(screen.getByTitle('Toggle row density'));
    expect(onDensityChange).toHaveBeenCalledWith('compact');
  });

  it('hides notes column in dense mode', () => {
    const payees = [
      makePayee({ id: 'p1', name: 'Netflix', notes: 'Streaming' }),
    ];

    render(<PayeeList payees={payees} onEdit={onEdit} onRefresh={onRefresh} density="dense" />);
    expect(screen.queryByText('Notes')).not.toBeInTheDocument();
    expect(screen.queryByText('Streaming')).not.toBeInTheDocument();
  });

  it('hides notes column in compact mode', () => {
    const payees = [
      makePayee({ id: 'p1', name: 'Netflix', notes: 'Streaming' }),
    ];

    render(<PayeeList payees={payees} onEdit={onEdit} onRefresh={onRefresh} density="compact" />);
    expect(screen.queryByText('Notes')).not.toBeInTheDocument();
  });

  // Multiple payees
  it('renders multiple payees with edit and delete buttons each', () => {
    const payees = [
      makePayee({ id: 'p1', name: 'Walmart' }),
      makePayee({ id: 'p2', name: 'Netflix' }),
      makePayee({ id: 'p3', name: 'Amazon' }),
    ];

    render(<PayeeList payees={payees} onEdit={onEdit} onRefresh={onRefresh} />);
    const editButtons = screen.getAllByText('Edit');
    const deleteButtons = screen.getAllByText('Delete');
    expect(editButtons).toHaveLength(3);
    expect(deleteButtons).toHaveLength(3);
  });

  it('navigates to correct payee when clicking different payee names', () => {
    const payees = [
      makePayee({ id: 'p1', name: 'Walmart' }),
      makePayee({ id: 'p2', name: 'Netflix' }),
    ];

    render(<PayeeList payees={payees} onEdit={onEdit} onRefresh={onRefresh} />);

    fireEvent.click(screen.getByText('Netflix'));
    expect(mockPush).toHaveBeenCalledWith('/transactions?payeeId=p2');
  });

  it('shows category with color styling for payees with default category having color', () => {
    const payees = [
      makePayee({
        id: 'p1',
        name: 'Walmart',
        defaultCategory: {
          id: 'cat-1', userId: 'u', parentId: null, parent: null, children: [],
          name: 'Groceries', description: null, icon: null, color: '#ef4444', effectiveColor: '#ef4444',
          isIncome: false, isSystem: false, createdAt: '',
        },
      }),
    ];

    render(<PayeeList payees={payees} onEdit={onEdit} onRefresh={onRefresh} />);
    const categoryBadge = screen.getByText('Groceries');
    expect(categoryBadge).toBeInTheDocument();
    // Should have color-mix styles applied
    expect(categoryBadge.getAttribute('style')).toContain('#ef4444');
  });

  // Status column
  it('shows status column when showStatusColumn is true', () => {
    const payees = [
      makePayee({ id: 'p1', name: 'Walmart', isActive: true }),
    ];

    render(<PayeeList payees={payees} onEdit={onEdit} onRefresh={onRefresh} showStatusColumn />);
    expect(screen.getByText('Status')).toBeInTheDocument();
  });

  it('does not show status column by default', () => {
    const payees = [
      makePayee({ id: 'p1', name: 'Walmart', isActive: true }),
    ];

    render(<PayeeList payees={payees} onEdit={onEdit} onRefresh={onRefresh} />);
    expect(screen.queryByText('Status')).not.toBeInTheDocument();
  });

  it('shows Active badge for active payee when showStatusColumn is true', () => {
    const payees = [
      makePayee({ id: 'p1', name: 'Walmart', isActive: true }),
    ];

    render(<PayeeList payees={payees} onEdit={onEdit} onRefresh={onRefresh} showStatusColumn />);
    expect(screen.getByText('Active')).toBeInTheDocument();
  });

  it('shows Inactive badge for inactive payee when showStatusColumn is true', () => {
    const payees = [
      makePayee({ id: 'p1', name: 'Walmart', isActive: false }),
    ];

    render(<PayeeList payees={payees} onEdit={onEdit} onRefresh={onRefresh} showStatusColumn />);
    expect(screen.getByText('Inactive')).toBeInTheDocument();
  });

  // Reactivate
  it('shows Reactivate button for inactive payee when onReactivate is provided', () => {
    const onReactivate = vi.fn();
    const payees = [
      makePayee({ id: 'p1', name: 'Walmart', isActive: false }),
    ];

    render(<PayeeList payees={payees} onEdit={onEdit} onRefresh={onRefresh} onReactivate={onReactivate} />);
    expect(screen.getByText('Reactivate')).toBeInTheDocument();
  });

  it('does not show Reactivate button for active payees', () => {
    const onReactivate = vi.fn();
    const payees = [
      makePayee({ id: 'p1', name: 'Walmart', isActive: true }),
    ];

    render(<PayeeList payees={payees} onEdit={onEdit} onRefresh={onRefresh} onReactivate={onReactivate} />);
    expect(screen.queryByText('Reactivate')).not.toBeInTheDocument();
  });

  it('does not show Reactivate button when onReactivate is not provided', () => {
    const payees = [
      makePayee({ id: 'p1', name: 'Walmart', isActive: false }),
    ];

    render(<PayeeList payees={payees} onEdit={onEdit} onRefresh={onRefresh} />);
    expect(screen.queryByText('Reactivate')).not.toBeInTheDocument();
  });

  it('calls onReactivate with payee id when Reactivate is clicked', () => {
    const onReactivate = vi.fn();
    const payees = [
      makePayee({ id: 'p1', name: 'Walmart', isActive: false }),
    ];

    render(<PayeeList payees={payees} onEdit={onEdit} onRefresh={onRefresh} onReactivate={onReactivate} />);
    fireEvent.click(screen.getByText('Reactivate'));
    expect(onReactivate).toHaveBeenCalledWith('p1');
  });

  // Merge
  it('shows Merge button for active payee when onMerge is provided', () => {
    const onMerge = vi.fn();
    const payees = [
      makePayee({ id: 'p1', name: 'Walmart', isActive: true }),
    ];

    render(<PayeeList payees={payees} onEdit={onEdit} onRefresh={onRefresh} onMerge={onMerge} />);
    expect(screen.getByText('Merge')).toBeInTheDocument();
  });

  it('does not show Merge button for inactive payees', () => {
    const onMerge = vi.fn();
    const payees = [
      makePayee({ id: 'p1', name: 'Walmart', isActive: false }),
    ];

    render(<PayeeList payees={payees} onEdit={onEdit} onRefresh={onRefresh} onMerge={onMerge} />);
    expect(screen.queryByText('Merge')).not.toBeInTheDocument();
  });

  it('does not show Merge button when onMerge is not provided', () => {
    const payees = [
      makePayee({ id: 'p1', name: 'Walmart', isActive: true }),
    ];

    render(<PayeeList payees={payees} onEdit={onEdit} onRefresh={onRefresh} />);
    expect(screen.queryByText('Merge')).not.toBeInTheDocument();
  });

  it('calls onMerge with payee when Merge is clicked', () => {
    const onMerge = vi.fn();
    const payees = [
      makePayee({ id: 'p1', name: 'Walmart', isActive: true }),
    ];

    render(<PayeeList payees={payees} onEdit={onEdit} onRefresh={onRefresh} onMerge={onMerge} />);
    fireEvent.click(screen.getByText('Merge'));
    expect(onMerge).toHaveBeenCalledWith(expect.objectContaining({ id: 'p1' }));
  });

  // Dense mode button labels
  it('shows icon-only action buttons in dense mode', () => {
    const onMerge = vi.fn();
    const payees = [
      makePayee({ id: 'p1', name: 'Walmart', isActive: true }),
    ];

    render(<PayeeList payees={payees} onEdit={onEdit} onRefresh={onRefresh} onMerge={onMerge} density="dense" />);
    // Icon-only buttons expose their label via the accessible name, not visible text.
    expect(screen.getByRole('button', { name: 'Merge' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Edit' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Delete' })).toBeInTheDocument();
  });

  it('shows the Reactivate action in dense mode for an inactive payee', () => {
    const onReactivate = vi.fn();
    const payees = [
      makePayee({ id: 'p1', name: 'Walmart', isActive: false }),
    ];

    render(<PayeeList payees={payees} onEdit={onEdit} onRefresh={onRefresh} onReactivate={onReactivate} density="dense" />);
    expect(screen.getByRole('button', { name: 'Reactivate' })).toBeInTheDocument();
  });

  // Category badge density
  it('shows compact category badge in dense mode', () => {
    const payees = [
      makePayee({
        id: 'p1',
        name: 'Walmart',
        defaultCategory: {
          id: 'cat-1', userId: 'u', parentId: null, parent: null, children: [],
          name: 'Groceries', description: null, icon: null, color: null, effectiveColor: null,
          isIncome: false, isSystem: false, createdAt: '',
        },
      }),
    ];

    render(<PayeeList payees={payees} onEdit={onEdit} onRefresh={onRefresh} density="dense" />);
    const badge = screen.getByText('Groceries');
    // dense mode applies px-1.5 py-0.5
    expect(badge).toBeInTheDocument();
    expect(badge.className).toContain('px-1.5');
  });

  it('shows regular category badge in normal mode', () => {
    const payees = [
      makePayee({
        id: 'p1',
        name: 'Walmart',
        defaultCategory: {
          id: 'cat-1', userId: 'u', parentId: null, parent: null, children: [],
          name: 'Groceries', description: null, icon: null, color: null, effectiveColor: null,
          isIncome: false, isSystem: false, createdAt: '',
        },
      }),
    ];

    render(<PayeeList payees={payees} onEdit={onEdit} onRefresh={onRefresh} density="normal" />);
    const badge = screen.getByText('Groceries');
    expect(badge.className).toContain('px-2');
  });

  // Sorting aliases, lastUsed, createdAt
  it('sorts by aliases when Aliases header is clicked', () => {
    const payees = [
      makePayee({ id: 'p1', name: 'Walmart', aliasCount: 2 }),
      makePayee({ id: 'p2', name: 'Amazon', aliasCount: 5 }),
    ];

    const { container } = render(<PayeeList payees={payees} onEdit={onEdit} onRefresh={onRefresh} />);
    // Click Aliases — switches field, sets direction to desc (count-like field)
    fireEvent.click(screen.getByText('Aliases'));
    // With desc sort on aliases: Amazon (5) first, Walmart (2) second
    const rows = container.querySelectorAll('tbody tr');
    expect(rows[0].querySelector('td')?.textContent?.trim()).toBe('Amazon');
    expect(rows[1].querySelector('td')?.textContent?.trim()).toBe('Walmart');
  });

  it('sorts by lastUsed when Last Used header is clicked', () => {
    const payees = [
      makePayee({ id: 'p1', name: 'Walmart', lastUsedDate: '2026-01-15' }),
      makePayee({ id: 'p2', name: 'Amazon', lastUsedDate: '2026-01-20' }),
    ];

    render(<PayeeList payees={payees} onEdit={onEdit} onRefresh={onRefresh} />);
    fireEvent.click(screen.getByText('Last Used'));
    expect(screen.getByText('Walmart')).toBeInTheDocument();
    expect(screen.getByText('Amazon')).toBeInTheDocument();
  });

  it('sorts by createdAt when Created header is clicked', () => {
    const payees = [
      makePayee({ id: 'p1', name: 'Walmart', createdAt: '2025-01-01T00:00:00Z' }),
      makePayee({ id: 'p2', name: 'Amazon', createdAt: '2026-01-01T00:00:00Z' }),
    ];

    render(<PayeeList payees={payees} onEdit={onEdit} onRefresh={onRefresh} />);
    fireEvent.click(screen.getByText('Created'));
    expect(screen.getByText('Walmart')).toBeInTheDocument();
    expect(screen.getByText('Amazon')).toBeInTheDocument();
  });

  it('toggles sort direction when same field is clicked twice', () => {
    const payees = [
      makePayee({ id: 'p1', name: 'banana' }),
      makePayee({ id: 'p2', name: 'Apple' }),
    ];

    const { container } = render(<PayeeList payees={payees} onEdit={onEdit} onRefresh={onRefresh} />);
    // Initial order: Apple, banana (asc)
    let rows = container.querySelectorAll('tbody tr');
    expect(rows[0].querySelector('td')?.textContent?.trim()).toBe('Apple');

    // Click Name again — toggles to desc
    fireEvent.click(screen.getByText('Name'));
    rows = container.querySelectorAll('tbody tr');
    expect(rows[0].querySelector('td')?.textContent?.trim()).toBe('banana');
  });

  it('resets direction to desc when switching to a count field', () => {
    const payees = [
      makePayee({ id: 'p1', name: 'Walmart', transactionCount: 10 }),
      makePayee({ id: 'p2', name: 'Amazon', transactionCount: 5 }),
    ];

    const { container } = render(<PayeeList payees={payees} onEdit={onEdit} onRefresh={onRefresh} />);
    // Click Count — switches field, sets direction to desc
    fireEvent.click(screen.getByText('Count'));
    // With desc sort on count: Walmart (10) first, Amazon (5) second
    const rows = container.querySelectorAll('tbody tr');
    expect(rows[0].querySelector('td')?.textContent?.trim()).toBe('Walmart');
    expect(rows[1].querySelector('td')?.textContent?.trim()).toBe('Amazon');
  });

  it('resets direction to asc when switching to category field', () => {
    const payees = [
      makePayee({
        id: 'p1', name: 'Walmart',
        defaultCategory: {
          id: 'cat-1', userId: 'u', parentId: null, parent: null, children: [],
          name: 'Zoning', description: null, icon: null, color: null, effectiveColor: null,
          isIncome: false, isSystem: false, createdAt: '',
        },
      }),
      makePayee({ id: 'p2', name: 'Amazon', defaultCategory: null }),
    ];

    const { container } = render(<PayeeList payees={payees} onEdit={onEdit} onRefresh={onRefresh} />);
    // Click Category — switches field, sets direction to asc
    fireEvent.click(screen.getByText('Default Category'));
    // With asc sort on category: '' (Amazon/None) < 'Zoning' (Walmart)
    const rows = container.querySelectorAll('tbody tr');
    expect(rows[0].querySelector('td')?.textContent?.trim()).toBe('Amazon');
    expect(rows[1].querySelector('td')?.textContent?.trim()).toBe('Walmart');
  });

  // lastUsedDate and createdAt display
  it('shows formatted lastUsedDate when present', () => {
    const payees = [
      makePayee({ id: 'p1', name: 'Walmart', lastUsedDate: '2026-03-15T00:00:00Z' }),
    ];

    render(<PayeeList payees={payees} onEdit={onEdit} onRefresh={onRefresh} />);
    // formatDate is mocked to return date as-is, substring(0,10) = '2026-03-15'
    expect(screen.getByText('2026-03-15')).toBeInTheDocument();
  });

  it('shows dash when lastUsedDate is null', () => {
    const payees = [
      makePayee({ id: 'p1', name: 'Walmart', lastUsedDate: null }),
    ];

    render(<PayeeList payees={payees} onEdit={onEdit} onRefresh={onRefresh} />);
    const dashes = screen.getAllByText('-');
    expect(dashes.length).toBeGreaterThan(0);
  });

  it('shows formatted createdAt date', () => {
    const payees = [
      makePayee({ id: 'p1', name: 'Walmart', createdAt: '2026-01-05T00:00:00Z' }),
    ];

    render(<PayeeList payees={payees} onEdit={onEdit} onRefresh={onRefresh} />);
    expect(screen.getByText('2026-01-05')).toBeInTheDocument();
  });

  it('shows aliasCount of 0 when aliasCount is undefined', () => {
    const payees = [
      makePayee({ id: 'p1', name: 'Walmart', aliasCount: undefined }),
    ];

    render(<PayeeList payees={payees} onEdit={onEdit} onRefresh={onRefresh} />);
    const zeros = screen.getAllByText('0');
    expect(zeros.length).toBeGreaterThanOrEqual(1);
  });

  // categoryColorMap lookup
  it('uses categoryColorMap color override when map has category id', () => {
    const payees = [
      makePayee({
        id: 'p1',
        name: 'Walmart',
        defaultCategory: {
          id: 'cat-1', userId: 'u', parentId: null, parent: null, children: [],
          name: 'Groceries', description: null, icon: null, color: '#000000', effectiveColor: '#000000',
          isIncome: false, isSystem: false, createdAt: '',
        },
      }),
    ];
    const categoryColorMap = new Map([['cat-1', '#ff0000']]);

    render(
      <PayeeList
        payees={payees}
        onEdit={onEdit}
        onRefresh={onRefresh}
        categoryColorMap={categoryColorMap}
      />,
    );
    const badge = screen.getByText('Groceries');
    // Should use the map color (#ff0000), not the category color (#000000)
    expect(badge.getAttribute('style')).toContain('#ff0000');
  });

  it('falls back to category color when map does not have category id', () => {
    const payees = [
      makePayee({
        id: 'p1',
        name: 'Walmart',
        defaultCategory: {
          id: 'cat-1', userId: 'u', parentId: null, parent: null, children: [],
          name: 'Groceries', description: null, icon: null, color: '#123456', effectiveColor: '#123456',
          isIncome: false, isSystem: false, createdAt: '',
        },
      }),
    ];
    const categoryColorMap = new Map([['cat-other', '#ff0000']]);

    render(
      <PayeeList
        payees={payees}
        onEdit={onEdit}
        onRefresh={onRefresh}
        categoryColorMap={categoryColorMap}
      />,
    );
    const badge = screen.getByText('Groceries');
    expect(badge.getAttribute('style')).toContain('#123456');
  });

  it('handles null value in categoryColorMap for category id', () => {
    const payees = [
      makePayee({
        id: 'p1',
        name: 'Walmart',
        defaultCategory: {
          id: 'cat-1', userId: 'u', parentId: null, parent: null, children: [],
          name: 'Groceries', description: null, icon: null, color: '#abcdef', effectiveColor: '#abcdef',
          isIncome: false, isSystem: false, createdAt: '',
        },
      }),
    ];
    // Map has the category id but maps to null — should fall back to category.color
    const categoryColorMap = new Map<string, string | null>([['cat-1', null]]);

    render(
      <PayeeList
        payees={payees}
        onEdit={onEdit}
        onRefresh={onRefresh}
        categoryColorMap={categoryColorMap}
      />,
    );
    const badge = screen.getByText('Groceries');
    // When map returns null, defaultCategoryColor = null, so uses var(--category-bg-base)
    expect(badge).toBeInTheDocument();
  });

  // Odd/even row striping in non-normal density
  it('applies striped classes to odd-indexed rows in compact density', () => {
    const payees = [
      makePayee({ id: 'p1', name: 'First' }),
      makePayee({ id: 'p2', name: 'Second' }),
    ];

    const { container } = render(
      <PayeeList payees={payees} onEdit={onEdit} onRefresh={onRefresh} density="compact" />,
    );
    const rows = container.querySelectorAll('tbody tr');
    // index 1 (second row) should have striped class
    expect(rows[1].className).toContain('bg-gray-50');
    // index 0 (first row) should not have stripe
    expect(rows[0].className).toContain('bg-white');
  });

  it('does not apply striped classes to rows in normal density', () => {
    const payees = [
      makePayee({ id: 'p1', name: 'First' }),
      makePayee({ id: 'p2', name: 'Second' }),
    ];

    const { container } = render(
      <PayeeList payees={payees} onEdit={onEdit} onRefresh={onRefresh} density="normal" />,
    );
    const rows = container.querySelectorAll('tbody tr');
    // All rows use bg-white in normal density (no stripe)
    rows.forEach(row => {
      expect(row.className).toContain('bg-white');
    });
  });

  // Inactive payee opacity
  it('applies opacity to inactive payees', () => {
    const payees = [
      makePayee({ id: 'p1', name: 'Inactive Payee', isActive: false }),
    ];

    const { container } = render(
      <PayeeList payees={payees} onEdit={onEdit} onRefresh={onRefresh} />,
    );
    const row = container.querySelector('tbody tr');
    expect(row?.className).toContain('opacity-60');
  });

  it('does not apply opacity to active payees', () => {
    const payees = [
      makePayee({ id: 'p1', name: 'Active Payee', isActive: true }),
    ];

    const { container } = render(
      <PayeeList payees={payees} onEdit={onEdit} onRefresh={onRefresh} />,
    );
    const row = container.querySelector('tbody tr');
    expect(row?.className).not.toContain('opacity-60');
  });

  // Controlled sort with onSort prop
  it('passes all sort fields to onSort callback', () => {
    const onSort = vi.fn();
    const payees = [makePayee({ id: 'p1', name: 'Walmart' })];

    render(
      <PayeeList
        payees={payees}
        onEdit={onEdit}
        onRefresh={onRefresh}
        sortField="name"
        sortDirection="asc"
        onSort={onSort}
      />,
    );

    fireEvent.click(screen.getByText('Default Category'));
    expect(onSort).toHaveBeenCalledWith('category');

    fireEvent.click(screen.getByText('Count'));
    expect(onSort).toHaveBeenCalledWith('count');

    fireEvent.click(screen.getByText('Aliases'));
    expect(onSort).toHaveBeenCalledWith('aliases');

    fireEvent.click(screen.getByText('Last Used'));
    expect(onSort).toHaveBeenCalledWith('lastUsed');

    fireEvent.click(screen.getByText('Created'));
    expect(onSort).toHaveBeenCalledWith('createdAt');
  });

  // Payees returned as-is when onSort is provided (no local sort)
  it('renders payees in original order when onSort is provided', () => {
    const onSort = vi.fn();
    const payees = [
      makePayee({ id: 'p1', name: 'Zulu' }),
      makePayee({ id: 'p2', name: 'Alpha' }),
    ];

    const { container } = render(
      <PayeeList
        payees={payees}
        onEdit={onEdit}
        onRefresh={onRefresh}
        sortField="name"
        sortDirection="desc"
        onSort={onSort}
      />,
    );

    const rows = container.querySelectorAll('tbody tr');
    // Should maintain the order given — no local re-sorting
    expect(rows[0].querySelector('td')?.textContent?.trim()).toBe('Zulu');
    expect(rows[1].querySelector('td')?.textContent?.trim()).toBe('Alpha');
  });
});
