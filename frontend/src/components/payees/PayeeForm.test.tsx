import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@/test/render';
import { PayeeForm } from './PayeeForm';

vi.mock('@hookform/resolvers/zod', () => ({
  zodResolver: () => async () => ({ values: {}, errors: {} }),
}));

vi.mock('@/lib/categoryUtils', () => ({
  buildCategoryTree: (cats: any[]) => cats.map((c: any) => ({ category: c, level: 0 })),
}));

vi.mock('@/lib/payees', () => ({
  payeesApi: {
    getAliases: vi.fn().mockResolvedValue([]),
    createAlias: vi.fn().mockResolvedValue({ id: 'a1', alias: 'test', payeeId: 'p1' }),
    deleteAlias: vi.fn().mockResolvedValue(undefined),
  },
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

  it('renders update form when editing', async () => {
    const payee = { id: 'p1', name: 'Walmart', defaultCategoryId: 'c1', notes: 'Groceries' } as any;
    await act(async () => {
      render(<PayeeForm payee={payee} categories={categories} onSubmit={onSubmit} onCancel={onCancel} />);
    });
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

  it('renders alias manager when creating a new payee', () => {
    render(<PayeeForm categories={categories} onSubmit={onSubmit} onCancel={onCancel} />);
    expect(screen.getByText('Aliases')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('e.g., STARBUCKS #*')).toBeInTheDocument();
  });

  it('renders alias manager when editing an existing payee', async () => {
    const payee = { id: 'p1', name: 'Walmart', defaultCategoryId: 'c1', notes: '' } as any;
    await act(async () => {
      render(<PayeeForm payee={payee} categories={categories} onSubmit={onSubmit} onCancel={onCancel} />);
    });
    expect(screen.getByText('Aliases')).toBeInTheDocument();
  });

  it('shows category options in dropdown', async () => {
    Element.prototype.scrollIntoView = vi.fn();
    render(<PayeeForm categories={categories} onSubmit={onSubmit} onCancel={onCancel} />);
    const categoryInput = screen.getByPlaceholderText('Select category...');
    await act(async () => {
      fireEvent.focus(categoryInput);
    });
    expect(screen.getByText('Food')).toBeInTheDocument();
  });
});
