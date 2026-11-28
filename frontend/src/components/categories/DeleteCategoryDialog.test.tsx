import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@/test/render';
import { DeleteCategoryDialog } from './DeleteCategoryDialog';
import { categoriesApi } from '@/lib/categories';

vi.mock('@/lib/categories', () => ({
  categoriesApi: {
    getTransactionCount: vi.fn().mockResolvedValue(0),
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
    vi.mocked(categoriesApi.getTransactionCount).mockReturnValueOnce(new Promise(() => {}));
    render(
      <DeleteCategoryDialog isOpen={true} category={categories[0]} categories={categories} onConfirm={onConfirm} onCancel={onCancel} />
    );
    expect(screen.getByText('Checking usage...')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Delete' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalled();
  });

  it('says usage is unknown, never "not used", when the lookup fails', async () => {
    vi.mocked(categoriesApi.getTransactionCount).mockRejectedValueOnce(new Error('boom'));
    render(
      <DeleteCategoryDialog isOpen={true} category={categories[0]} categories={categories} onConfirm={onConfirm} onCancel={onCancel} />
    );
    await screen.findByText(/Could not check where this category is used/);
    expect(screen.queryByText('This category is not used. It can be safely deleted.')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    // A plain delete: no reassignment is sent for a count that is unknown.
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
