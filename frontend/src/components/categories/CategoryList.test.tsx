import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@/test/render';
import { CategoryList } from './CategoryList';

vi.mock('@/lib/categories', () => ({
  categoriesApi: {
    getTransactionCount: vi.fn().mockResolvedValue(0),
    reassignTransactions: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() }),
}));

vi.mock('@/lib/categoryUtils', () => ({
  buildCategoryTree: (cats: any[]) => cats.map((c: any) => ({ category: c, level: 0 })),
}));

describe('CategoryList', () => {
  const onEdit = vi.fn();
  const onRefresh = vi.fn();

  it('renders empty state', () => {
    render(<CategoryList categories={[]} onEdit={onEdit} onRefresh={onRefresh} />);
    expect(screen.getByText('No categories')).toBeInTheDocument();
  });

  it('renders categories table with data', () => {
    const categories = [
      { id: 'c1', name: 'Food', isIncome: false, parentId: null, transactionCount: 5, isSystem: false },
      { id: 'c2', name: 'Salary', isIncome: true, parentId: null, transactionCount: 12, isSystem: false },
    ] as any[];

    render(<CategoryList categories={categories} onEdit={onEdit} onRefresh={onRefresh} />);
    expect(screen.getByText('Food')).toBeInTheDocument();
    expect(screen.getByText('Salary')).toBeInTheDocument();
  });

  it('calls onEdit when edit button is clicked', () => {
    const categories = [
      { id: 'c1', name: 'Food', isIncome: false, parentId: null, transactionCount: 0, isSystem: false },
    ] as any[];

    render(<CategoryList categories={categories} onEdit={onEdit} onRefresh={onRefresh} />);
    fireEvent.click(screen.getByText('Edit'));
    expect(onEdit).toHaveBeenCalledWith(expect.objectContaining({ name: 'Food' }));
  });

  it('shows system category label', () => {
    const categories = [
      { id: 'c1', name: 'Transfer', isIncome: false, parentId: null, transactionCount: 0, isSystem: true },
    ] as any[];

    render(<CategoryList categories={categories} onEdit={onEdit} onRefresh={onRefresh} />);
    expect(screen.getByText('(System)')).toBeInTheDocument();
    // System categories should not have delete button
    expect(screen.queryByText('Delete')).not.toBeInTheDocument();
  });
});
