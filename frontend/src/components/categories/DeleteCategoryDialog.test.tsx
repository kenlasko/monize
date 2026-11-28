import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@/test/render';
import { DeleteCategoryDialog } from './DeleteCategoryDialog';
import { categoriesApi } from '@/lib/categories';

vi.mock('@/lib/categories', () => ({
  categoriesApi: {
    getUsage: vi.fn().mockResolvedValue({ count: 0, movableCount: 0 }),
  },
}));

vi.mock('@/lib/categoryUtils', () => ({
  buildCategoryTree: (cats: any[]) => cats.map((c: any) => ({ category: c, level: 0 })),
}));

describe('DeleteCategoryDialog', () => {
  const categories = [
    { id: 'c1', name: 'Food', parentId: null, categoryType: 'expense' as const },
    { id: 'c2', name: 'Transport', parentId: null, categoryType: 'expense' as const },
  ] as any[];

  const onConfirm = vi.fn();
  const onCancel = vi.fn();

  it('returns null when no category', () => {
    const { container } = render(
      <DeleteCategoryDialog isOpen={true} category={null} categories={categories} onConfirm={onConfirm} onCancel={onCancel} />
    );
    expect(container.innerHTML).toBe('');
  });

  it('is named by its Modal title, which names the action rather than asking', async () => {
    render(
      <DeleteCategoryDialog isOpen={true} category={categories[0]} categories={categories} onConfirm={onConfirm} onCancel={onCancel} />
    );
    expect(await screen.findByRole('dialog', { name: 'Delete "Food"' })).toBeInTheDocument();
    await screen.findByText('This category is not used. It can be safely deleted.');
    expect(screen.getByText('This action cannot be undone.')).toBeInTheDocument();
  });

  it('offers Cancel while the usage check is still running', () => {
    vi.mocked(categoriesApi.getUsage).mockReturnValueOnce(new Promise(() => {}));
    render(
      <DeleteCategoryDialog isOpen={true} category={categories[0]} categories={categories} onConfirm={onConfirm} onCancel={onCancel} />
    );
    expect(screen.getByText('Checking usage...')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Delete' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalled();
  });

  it('says usage is unknown, never "not used", when the lookup fails', async () => {
    vi.mocked(categoriesApi.getUsage).mockRejectedValueOnce(new Error('boom'));
    render(
      <DeleteCategoryDialog isOpen={true} category={categories[0]} categories={categories} onConfirm={onConfirm} onCancel={onCancel} />
    );
    await screen.findByText(/Could not check where this category is used/);
    expect(screen.queryByText('This category is not used. It can be safely deleted.')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    // A plain delete: no reassignment is sent for a count that is unknown.
    expect(onConfirm).toHaveBeenLastCalledWith(undefined);
  });

  it('offers no reassign target when only kinds a reassign cannot move remain', async () => {
    // A budget-only category: moving rows would change nothing.
    vi.mocked(categoriesApi.getUsage).mockResolvedValueOnce({ count: 2, movableCount: 0 });
    render(
      <DeleteCategoryDialog isOpen={true} category={categories[0]} categories={categories} onConfirm={onConfirm} onCancel={onCancel} />
    );
    await screen.findByText(/This category is used by 2 records/);
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    // A plain delete, so the server's 409 lists what still uses it.
    expect(onConfirm).toHaveBeenLastCalledWith(undefined);
  });

  it('offers the reassign target when a reassign moves something', async () => {
    vi.mocked(categoriesApi.getUsage).mockResolvedValueOnce({ count: 3, movableCount: 1 });
    render(
      <DeleteCategoryDialog isOpen={true} category={categories[0]} categories={categories} onConfirm={onConfirm} onCancel={onCancel} />
    );
    expect(await screen.findByRole('combobox')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(onConfirm).toHaveBeenLastCalledWith(null);
  });

  it('forgets a failed lookup when reopened and the next one succeeds', async () => {
    vi.mocked(categoriesApi.getUsage)
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({ count: 3, movableCount: 3 });
    const { rerender } = render(
      <DeleteCategoryDialog isOpen={true} category={categories[0]} categories={categories} onConfirm={onConfirm} onCancel={onCancel} />
    );
    await screen.findByText(/Could not check where this category is used/);
    rerender(
      <DeleteCategoryDialog isOpen={false} category={categories[0]} categories={categories} onConfirm={onConfirm} onCancel={onCancel} />
    );
    rerender(
      <DeleteCategoryDialog isOpen={true} category={categories[0]} categories={categories} onConfirm={onConfirm} onCancel={onCancel} />
    );
    expect(await screen.findByRole('combobox')).toBeInTheDocument();
    expect(screen.queryByText(/Could not check where this category is used/)).not.toBeInTheDocument();
  });

  it('forgets a known count when reopened and the next lookup fails', async () => {
    vi.mocked(categoriesApi.getUsage)
      .mockResolvedValueOnce({ count: 3, movableCount: 3 })
      .mockRejectedValueOnce(new Error('boom'));
    const { rerender } = render(
      <DeleteCategoryDialog isOpen={true} category={categories[0]} categories={categories} onConfirm={onConfirm} onCancel={onCancel} />
    );
    await screen.findByRole('combobox');
    rerender(
      <DeleteCategoryDialog isOpen={false} category={categories[0]} categories={categories} onConfirm={onConfirm} onCancel={onCancel} />
    );
    rerender(
      <DeleteCategoryDialog isOpen={true} category={categories[0]} categories={categories} onConfirm={onConfirm} onCancel={onCancel} />
    );
    await screen.findByText(/Could not check where this category is used/);
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    // The old count must not turn into a reassignment the lookup no longer backs.
    expect(onConfirm).toHaveBeenLastCalledWith(undefined);
  });

  it('shows safe delete message when no transactions', async () => {
    render(
      <DeleteCategoryDialog isOpen={true} category={categories[0]} categories={categories} onConfirm={onConfirm} onCancel={onCancel} />
    );
    const message = await screen.findByText('This category is not used. It can be safely deleted.');
    expect(message).toBeInTheDocument();
  });

  it('calls onConfirm when delete is clicked', async () => {
    render(
      <DeleteCategoryDialog isOpen={true} category={categories[0]} categories={categories} onConfirm={onConfirm} onCancel={onCancel} />
    );
    await screen.findByText('This category is not used. It can be safely deleted.');
    fireEvent.click(screen.getByText('Delete'));
    expect(onConfirm).toHaveBeenCalledWith(undefined);
  });
});
