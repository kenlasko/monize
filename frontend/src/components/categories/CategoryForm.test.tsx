import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@/test/render';
import { CategoryForm } from './CategoryForm';

vi.mock('@/lib/zodResolver', () => ({
  zodResolver: () => async () => ({ values: {}, errors: {} }),
}));

describe('CategoryForm', () => {
  const categories = [
    { id: 'c1', name: 'Food', parentId: null, isIncome: false },
    { id: 'c2', name: 'Salary', parentId: null, isIncome: true },
  ] as any[];

  const onSubmit = vi.fn().mockResolvedValue(undefined);
  const onCancel = vi.fn();

  it('renders create form with all fields', () => {
    render(<CategoryForm categories={categories} onSubmit={onSubmit} onCancel={onCancel} />);
    expect(screen.getByText('Category Name')).toBeInTheDocument();
    expect(screen.getByText('Parent Category')).toBeInTheDocument();
    expect(screen.getByText('Type')).toBeInTheDocument();
    expect(screen.getByText('Create Category')).toBeInTheDocument();
  });

  it('renders update form when editing a category', () => {
    const category = { id: 'c1', name: 'Food', parentId: null, isIncome: false, description: 'Meals', icon: '', color: '' } as any;
    render(<CategoryForm category={category} categories={categories} onSubmit={onSubmit} onCancel={onCancel} />);
    expect(screen.getByText('Update Category')).toBeInTheDocument();
  });

  it('calls onCancel when cancel is clicked', () => {
    render(<CategoryForm categories={categories} onSubmit={onSubmit} onCancel={onCancel} />);
    fireEvent.click(screen.getByText('Cancel'));
    expect(onCancel).toHaveBeenCalled();
  });

  it('renders colour selector', () => {
    render(<CategoryForm categories={categories} onSubmit={onSubmit} onCancel={onCancel} />);
    expect(screen.getByText('Colour')).toBeInTheDocument();
  });
});
