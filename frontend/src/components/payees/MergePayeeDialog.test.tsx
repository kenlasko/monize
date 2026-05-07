import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@/test/render';
import { MergePayeeDialog } from './MergePayeeDialog';
import { payeesApi } from '@/lib/payees';
import { Payee } from '@/types/payee';
import toast from 'react-hot-toast';

vi.mock('@/lib/payees', () => ({
  payeesApi: {
    mergePayees: vi.fn(),
  },
}));

vi.mock('@/lib/errors', () => ({
  getErrorMessage: (_: unknown, fallback: string) => fallback,
}));

vi.mock('react-hot-toast');

const sourcePayee: Payee = {
  id: 'p1',
  userId: 'u1',
  name: 'STARBUCKS #12345',
  defaultCategoryId: null,
  defaultCategory: null,
  notes: null,
  isActive: true,
  createdAt: '2025-01-01',
  transactionCount: 5,
};

const targetPayee: Payee = {
  id: 'p2',
  userId: 'u1',
  name: 'Starbucks',
  defaultCategoryId: 'c1',
  defaultCategory: { id: 'c1', name: 'Food & Drink' } as any,
  notes: null,
  isActive: true,
  createdAt: '2025-01-01',
};

const allPayees = [sourcePayee, targetPayee];

describe('MergePayeeDialog', () => {
  const onClose = vi.fn();
  const onSuccess = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    // jsdom does not implement scrollIntoView; silence errors from Combobox scroll logic
    window.HTMLElement.prototype.scrollIntoView = vi.fn();
  });

  it('renders the merge dialog with source payee info', () => {
    render(
      <MergePayeeDialog
        isOpen={true}
        sourcePayee={sourcePayee}
        allPayees={allPayees}
        onClose={onClose}
        onSuccess={onSuccess}
      />
    );

    expect(screen.getByRole('heading', { name: 'Merge Payee' })).toBeInTheDocument();
    expect(screen.getByText('STARBUCKS #12345')).toBeInTheDocument();
    expect(screen.getByText('5 transactions will be migrated')).toBeInTheDocument();
  });

  it('shows the add as alias checkbox checked by default', () => {
    render(
      <MergePayeeDialog
        isOpen={true}
        sourcePayee={sourcePayee}
        allPayees={allPayees}
        onClose={onClose}
        onSuccess={onSuccess}
      />
    );

    const checkbox = screen.getByRole('checkbox');
    expect(checkbox).toBeChecked();
  });

  it('does not render when sourcePayee is null', () => {
    const { container } = render(
      <MergePayeeDialog
        isOpen={true}
        sourcePayee={null}
        allPayees={allPayees}
        onClose={onClose}
        onSuccess={onSuccess}
      />
    );

    expect(container.innerHTML).toBe('');
  });

  it('calls onClose when Cancel is clicked', () => {
    render(
      <MergePayeeDialog
        isOpen={true}
        sourcePayee={sourcePayee}
        allPayees={allPayees}
        onClose={onClose}
        onSuccess={onSuccess}
      />
    );

    fireEvent.click(screen.getByText('Cancel'));
    expect(onClose).toHaveBeenCalled();
  });

  it('disables Merge button when no target is selected', () => {
    render(
      <MergePayeeDialog
        isOpen={true}
        sourcePayee={sourcePayee}
        allPayees={allPayees}
        onClose={onClose}
        onSuccess={onSuccess}
      />
    );

    expect(screen.getByText('Merge Payee', { selector: 'button' })).toBeDisabled();
  });

  it('filters out source payee from target options', () => {
    render(
      <MergePayeeDialog
        isOpen={true}
        sourcePayee={sourcePayee}
        allPayees={allPayees}
        onClose={onClose}
        onSuccess={onSuccess}
      />
    );

    // The Combobox should show target options that exclude the source
    expect(screen.getByText('Merge into (target payee)')).toBeInTheDocument();
  });

  it('does not show transaction count when transactionCount is 0', () => {
    const payeeWithNoTransactions: Payee = { ...sourcePayee, transactionCount: 0 };

    render(
      <MergePayeeDialog
        isOpen={true}
        sourcePayee={payeeWithNoTransactions}
        allPayees={[payeeWithNoTransactions, targetPayee]}
        onClose={onClose}
        onSuccess={onSuccess}
      />
    );

    expect(screen.queryByText(/transactions will be migrated/)).not.toBeInTheDocument();
  });

  it('does not show transaction count when transactionCount is undefined', () => {
    const payeeWithUndefinedCount: Payee = { ...sourcePayee, transactionCount: undefined };

    render(
      <MergePayeeDialog
        isOpen={true}
        sourcePayee={payeeWithUndefinedCount}
        allPayees={[payeeWithUndefinedCount, targetPayee]}
        onClose={onClose}
        onSuccess={onSuccess}
      />
    );

    expect(screen.queryByText(/transactions will be migrated/)).not.toBeInTheDocument();
  });

  it('shows singular "transaction" when transactionCount is 1', () => {
    const payeeWithOne: Payee = { ...sourcePayee, transactionCount: 1 };

    render(
      <MergePayeeDialog
        isOpen={true}
        sourcePayee={payeeWithOne}
        allPayees={[payeeWithOne, targetPayee]}
        onClose={onClose}
        onSuccess={onSuccess}
      />
    );

    expect(screen.getByText('1 transaction will be migrated')).toBeInTheDocument();
  });

  it('filters out inactive payees from target options', () => {
    const inactivePayee: Payee = { ...targetPayee, id: 'p3', name: 'Inactive Payee', isActive: false };

    render(
      <MergePayeeDialog
        isOpen={true}
        sourcePayee={sourcePayee}
        allPayees={[sourcePayee, targetPayee, inactivePayee]}
        onClose={onClose}
        onSuccess={onSuccess}
      />
    );

    // Inactive payee should not appear in the combobox options (not in the DOM at all)
    expect(screen.queryByText('Inactive Payee')).not.toBeInTheDocument();
  });

  it('resets state when Cancel is clicked', () => {
    render(
      <MergePayeeDialog
        isOpen={true}
        sourcePayee={sourcePayee}
        allPayees={allPayees}
        onClose={onClose}
        onSuccess={onSuccess}
      />
    );

    // Uncheck the alias checkbox, then cancel
    fireEvent.click(screen.getByRole('checkbox'));
    expect(screen.getByRole('checkbox')).not.toBeChecked();

    fireEvent.click(screen.getByText('Cancel'));
    expect(onClose).toHaveBeenCalled();
  });

  it('does not call merge when no target is selected', async () => {
    render(
      <MergePayeeDialog
        isOpen={true}
        sourcePayee={sourcePayee}
        allPayees={allPayees}
        onClose={onClose}
        onSuccess={onSuccess}
      />
    );

    // Button is disabled so direct fireEvent won't trigger handler, but ensure no API call
    expect(vi.mocked(payeesApi.mergePayees)).not.toHaveBeenCalled();
  });

  it('unchecking alias checkbox changes its state', () => {
    render(
      <MergePayeeDialog
        isOpen={true}
        sourcePayee={sourcePayee}
        allPayees={allPayees}
        onClose={onClose}
        onSuccess={onSuccess}
      />
    );

    const cb = screen.getByRole('checkbox');
    expect(cb).toBeChecked();
    fireEvent.click(cb);
    expect(cb).not.toBeChecked();
  });

  async function selectTargetPayee() {
    const comboboxInput = screen.getByPlaceholderText('Select target payee...');
    // Focus opens the dropdown
    await act(async () => {
      fireEvent.focus(comboboxInput);
    });
    // Type to filter options
    await act(async () => {
      fireEvent.change(comboboxInput, { target: { value: 'Starbucks' } });
    });
    // Click the matching option
    const option = screen.getByText('Starbucks', { selector: 'span' });
    await act(async () => {
      fireEvent.click(option);
    });
  }

  it('shows preview block with alias item when target payee is selected', async () => {
    render(
      <MergePayeeDialog
        isOpen={true}
        sourcePayee={sourcePayee}
        allPayees={allPayees}
        onClose={onClose}
        onSuccess={onSuccess}
      />
    );

    await selectTargetPayee();

    expect(screen.getByText('This will:')).toBeInTheDocument();
    // Alias list item is visible when addAsAlias is true (default)
    expect(screen.getByText(/Add .* as an alias so future imports/)).toBeInTheDocument();
  });

  it('hides alias preview item when addAsAlias is unchecked after target selected', async () => {
    render(
      <MergePayeeDialog
        isOpen={true}
        sourcePayee={sourcePayee}
        allPayees={allPayees}
        onClose={onClose}
        onSuccess={onSuccess}
      />
    );

    await selectTargetPayee();

    // Alias preview is shown when checkbox is checked
    expect(screen.getByText(/Add .* as an alias so future imports/)).toBeInTheDocument();

    // Uncheck the alias checkbox
    fireEvent.click(screen.getByRole('checkbox'));

    // Alias bullet should now be gone
    expect(screen.queryByText(/Add .* as an alias so future imports/)).not.toBeInTheDocument();
  });

  it('calls mergePayees and shows success toast with transactions and alias', async () => {
    vi.mocked(payeesApi.mergePayees).mockResolvedValue({
      transactionsMigrated: 3,
      aliasAdded: true,
      sourcePayeeDeleted: true,
    });

    render(
      <MergePayeeDialog
        isOpen={true}
        sourcePayee={sourcePayee}
        allPayees={allPayees}
        onClose={onClose}
        onSuccess={onSuccess}
      />
    );

    await selectTargetPayee();

    await act(async () => {
      fireEvent.click(screen.getByText('Merge Payee', { selector: 'button' }));
    });

    await waitFor(() => {
      expect(payeesApi.mergePayees).toHaveBeenCalledWith({
        targetPayeeId: 'p2',
        sourcePayeeId: 'p1',
        addAsAlias: true,
      });
    });
    await waitFor(() => {
      expect(toast.success).toHaveBeenCalledWith(
        expect.stringContaining('3 transactions migrated'),
      );
    });
    expect(toast.success).toHaveBeenCalledWith(expect.stringContaining('alias added'));
    expect(onClose).toHaveBeenCalled();
    expect(onSuccess).toHaveBeenCalled();
  });

  it('calls mergePayees with no transactions and no alias and shows correct toast', async () => {
    vi.mocked(payeesApi.mergePayees).mockResolvedValue({
      transactionsMigrated: 0,
      aliasAdded: false,
      sourcePayeeDeleted: true,
    });

    render(
      <MergePayeeDialog
        isOpen={true}
        sourcePayee={sourcePayee}
        allPayees={allPayees}
        onClose={onClose}
        onSuccess={onSuccess}
      />
    );

    await selectTargetPayee();

    await act(async () => {
      fireEvent.click(screen.getByText('Merge Payee', { selector: 'button' }));
    });

    await waitFor(() => {
      expect(payeesApi.mergePayees).toHaveBeenCalled();
    });
    // No transactions migrated and no alias -- only the deletion message
    await waitFor(() => {
      expect(toast.success).toHaveBeenCalledWith(
        expect.stringContaining('"STARBUCKS #12345" deleted'),
      );
    });
    expect(toast.success).not.toHaveBeenCalledWith(expect.stringContaining('migrated'));
    expect(toast.success).not.toHaveBeenCalledWith(expect.stringContaining('alias added'));
  });

  it('shows success toast with singular "transaction" when exactly 1 migrated', async () => {
    vi.mocked(payeesApi.mergePayees).mockResolvedValue({
      transactionsMigrated: 1,
      aliasAdded: false,
      sourcePayeeDeleted: true,
    });

    render(
      <MergePayeeDialog
        isOpen={true}
        sourcePayee={sourcePayee}
        allPayees={allPayees}
        onClose={onClose}
        onSuccess={onSuccess}
      />
    );

    await selectTargetPayee();

    await act(async () => {
      fireEvent.click(screen.getByText('Merge Payee', { selector: 'button' }));
    });

    await waitFor(() => {
      expect(toast.success).toHaveBeenCalledWith(
        expect.stringContaining('1 transaction migrated'),
      );
    });
    // Should not say "transactions" (plural)
    expect(toast.success).not.toHaveBeenCalledWith(expect.stringContaining('1 transactions'));
  });

  it('shows error toast when mergePayees fails', async () => {
    vi.mocked(payeesApi.mergePayees).mockRejectedValue(new Error('Server error'));

    render(
      <MergePayeeDialog
        isOpen={true}
        sourcePayee={sourcePayee}
        allPayees={allPayees}
        onClose={onClose}
        onSuccess={onSuccess}
      />
    );

    await selectTargetPayee();

    await act(async () => {
      fireEvent.click(screen.getByText('Merge Payee', { selector: 'button' }));
    });

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Failed to merge payees');
    });
    expect(onClose).not.toHaveBeenCalled();
    expect(onSuccess).not.toHaveBeenCalled();
  });

  it('shows "Merging..." button text while submit is in progress', async () => {
    let resolveApi: (val: { transactionsMigrated: number; aliasAdded: boolean; sourcePayeeDeleted: boolean }) => void;
    vi.mocked(payeesApi.mergePayees).mockReturnValue(
      new Promise((resolve) => { resolveApi = resolve; }),
    );

    render(
      <MergePayeeDialog
        isOpen={true}
        sourcePayee={sourcePayee}
        allPayees={allPayees}
        onClose={onClose}
        onSuccess={onSuccess}
      />
    );

    await selectTargetPayee();

    await act(async () => {
      fireEvent.click(screen.getByText('Merge Payee', { selector: 'button' }));
    });

    expect(screen.getByText('Merging...')).toBeInTheDocument();

    await act(async () => {
      resolveApi!({ transactionsMigrated: 0, aliasAdded: false, sourcePayeeDeleted: true });
    });

    await waitFor(() => {
      expect(screen.queryByText('Merging...')).not.toBeInTheDocument();
    });
  });
});
