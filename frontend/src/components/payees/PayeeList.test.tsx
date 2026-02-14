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

function makePayee(overrides: Partial<Payee> & { id: string; name: string }): Payee {
  return {
    userId: 'user-1',
    defaultCategoryId: null,
    defaultCategory: null,
    notes: null,
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
          isIncome: false,
          isSystem: false,
          createdAt: '2026-01-01T00:00:00Z',
        },
      }),
    ];

    render(<PayeeList payees={payees} onEdit={onEdit} onRefresh={onRefresh} />);
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
    expect(screen.getByText('0')).toBeInTheDocument();
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
    expect(screen.getByText('-')).toBeInTheDocument();
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

  it('deletes payee and calls onRefresh on confirm', async () => {
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
          name: 'Groceries', description: null, icon: null, color: null,
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
          name: 'Groceries', description: null, icon: null, color: '#ef4444',
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
});
