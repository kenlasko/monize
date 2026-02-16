import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@/test/render';
import { PayeeForm } from './PayeeForm';

vi.mock('@hookform/resolvers/zod', () => ({
  zodResolver: () => async () => ({ values: {}, errors: {} }),
}));

vi.mock('@/lib/categoryUtils', () => ({
  buildCategoryTree: (cats: any[]) => cats.map((c: any) => ({ category: c, level: 0 })),
}));

describe('PayeeForm', () => {
  const categories = [
    { id: 'c1', name: 'Food', parentId: null },
  ] as any[];

  const onSubmit = vi.fn().mockResolvedValue(undefined);
  const onCancel = vi.fn();

  it('renders create form', () => {
    render(<PayeeForm categories={categories} onSubmit={onSubmit} onCancel={onCancel} />);
    expect(screen.getByText('Payee Name')).toBeInTheDocument();
    expect(screen.getByText('Default Category')).toBeInTheDocument();
    expect(screen.getByText('Create Payee')).toBeInTheDocument();
  });

  it('renders update form when editing', () => {
    const payee = { id: 'p1', name: 'Walmart', defaultCategoryId: 'c1', notes: 'Groceries' } as any;
    render(<PayeeForm payee={payee} categories={categories} onSubmit={onSubmit} onCancel={onCancel} />);
    expect(screen.getByText('Update Payee')).toBeInTheDocument();
  });

  it('calls onCancel when cancel is clicked', () => {
    render(<PayeeForm categories={categories} onSubmit={onSubmit} onCancel={onCancel} />);
    fireEvent.click(screen.getByText('Cancel'));
    expect(onCancel).toHaveBeenCalled();
  });

  it('renders notes field', () => {
    render(<PayeeForm categories={categories} onSubmit={onSubmit} onCancel={onCancel} />);
    expect(screen.getByText('Notes (optional)')).toBeInTheDocument();
  });
});
