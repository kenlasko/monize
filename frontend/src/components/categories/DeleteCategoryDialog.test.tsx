import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@/test/render';
import { DeleteCategoryDialog } from './DeleteCategoryDialog';

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
    { id: 'c1', name: 'Food', parentId: null, isIncome: false },
    { id: 'c2', name: 'Transport', parentId: null, isIncome: false },
  ] as any[];

  const onConfirm = vi.fn();
  const onCancel = vi.fn();

  it('returns null when no category', () => {
    const { container } = render(
      <DeleteCategoryDialog isOpen={true} category={null} categories={categories} onConfirm={onConfirm} onCancel={onCancel} />
    );
    expect(container.innerHTML).toBe('');
  });

  it('renders dialog with category name', () => {
    render(
      <DeleteCategoryDialog isOpen={true} category={categories[0]} categories={categories} onConfirm={onConfirm} onCancel={onCancel} />
    );
    expect(screen.getByText('Delete "Food"?')).toBeInTheDocument();
    expect(screen.getByText('This action cannot be undone.')).toBeInTheDocument();
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
    expect(onConfirm).toHaveBeenCalledWith(null);
  });
});
