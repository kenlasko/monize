import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@/test/render';
import { CategoryForm } from './CategoryForm';

vi.mock('@hookform/resolvers/zod', () => ({
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

  it('renders colour swatches with palette options', () => {
    render(<CategoryForm categories={categories} onSubmit={onSubmit} onCancel={onCancel} />);
    expect(screen.getByText('Colour')).toBeInTheDocument();
    expect(screen.getByTitle('Red')).toBeInTheDocument();
    expect(screen.getByTitle('Blue')).toBeInTheDocument();
    expect(screen.getByTitle('Green')).toBeInTheDocument();
    expect(screen.getByTitle('No colour')).toBeInTheDocument();
  });

  it('shows "No colour" title when no parent is selected', () => {
    render(<CategoryForm categories={categories} onSubmit={onSubmit} onCancel={onCancel} />);
    expect(screen.getByTitle('No colour')).toBeInTheDocument();
  });

  it('shows "Inherit from parent" title when parent is selected', () => {
    const categoriesWithColor = [
      { id: 'c1', name: 'Food', parentId: null, isIncome: false, effectiveColor: '#ef4444', color: '#ef4444' },
      { id: 'c2', name: 'Salary', parentId: null, isIncome: true, effectiveColor: null, color: null },
    ] as any[];

    render(<CategoryForm categories={categoriesWithColor} onSubmit={onSubmit} onCancel={onCancel} />);

    // Select a parent category
    const parentSelect = screen.getByLabelText('Parent Category');
    fireEvent.change(parentSelect, { target: { value: 'c1' } });

    expect(screen.getByTitle('Inherit from parent')).toBeInTheDocument();
  });

  it('shows inheritance message when parent has colour and child has none', () => {
    const categoriesWithColor = [
      { id: 'c1', name: 'Food', parentId: null, isIncome: false, effectiveColor: '#ef4444', color: '#ef4444' },
    ] as any[];

    render(<CategoryForm categories={categoriesWithColor} onSubmit={onSubmit} onCancel={onCancel} />);

    const parentSelect = screen.getByLabelText('Parent Category');
    fireEvent.change(parentSelect, { target: { value: 'c1' } });

    expect(screen.getByText('Colour inherited from parent (Food)')).toBeInTheDocument();
  });

  it('selects colour when swatch is clicked', () => {
    render(<CategoryForm categories={categories} onSubmit={onSubmit} onCancel={onCancel} />);

    const redSwatch = screen.getByTitle('Red');
    fireEvent.click(redSwatch);

    // The red swatch should now have the selected ring style
    expect(redSwatch.className).toContain('ring-2');
  });
});
