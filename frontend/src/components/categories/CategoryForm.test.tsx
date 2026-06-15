import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@/test/render';
import { CategoryForm } from './CategoryForm';

// jsdom does not implement scrollIntoView, which the Combobox calls when its
// dropdown opens with a selected or highlighted option.
Element.prototype.scrollIntoView = vi.fn();

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

  it('shows "Inherit from parent" title when parent is selected', async () => {
    const categoriesWithColor = [
      { id: 'c1', name: 'Food', parentId: null, isIncome: false, effectiveColor: '#ef4444', color: '#ef4444' },
      { id: 'c2', name: 'Salary', parentId: null, isIncome: true, effectiveColor: null, color: null },
    ] as any[];

    render(<CategoryForm categories={categoriesWithColor} onSubmit={onSubmit} onCancel={onCancel} />);

    // Select a parent category through the searchable combobox.
    const parentInput = screen.getByPlaceholderText('No parent (top-level)');
    await act(async () => { fireEvent.focus(parentInput); });
    await act(async () => { fireEvent.click(screen.getByText('Food')); });

    expect(screen.getByTitle('Inherit from parent')).toBeInTheDocument();
  });

  it('shows inheritance message when parent has colour and child has none', async () => {
    const categoriesWithColor = [
      { id: 'c1', name: 'Food', parentId: null, isIncome: false, effectiveColor: '#ef4444', color: '#ef4444' },
    ] as any[];

    render(<CategoryForm categories={categoriesWithColor} onSubmit={onSubmit} onCancel={onCancel} />);

    const parentInput = screen.getByPlaceholderText('No parent (top-level)');
    await act(async () => { fireEvent.focus(parentInput); });
    await act(async () => { fireEvent.click(screen.getByText('Food')); });

    expect(screen.getByText('Colour inherited from parent (Food)')).toBeInTheDocument();
  });

  it('renders the parent category as a searchable combobox, not a select', () => {
    render(<CategoryForm categories={categories} onSubmit={onSubmit} onCancel={onCancel} />);
    // The parent field is a text input using the "no parent" copy as its
    // placeholder, the same searchable Combobox the Payee form uses.
    const parentInput = screen.getByPlaceholderText('No parent (top-level)');
    expect(parentInput).toBeInTheDocument();
    expect(parentInput.tagName).toBe('INPUT');
  });

  it('filters parent options as the user types', async () => {
    const cats = [
      { id: 'c1', name: 'Food', parentId: null, isIncome: false },
      { id: 'c2', name: 'Salary', parentId: null, isIncome: true },
      { id: 'c3', name: 'Shopping', parentId: null, isIncome: false },
    ] as any[];
    render(<CategoryForm categories={cats} onSubmit={onSubmit} onCancel={onCancel} />);

    const parentInput = screen.getByPlaceholderText('No parent (top-level)');
    await act(async () => { fireEvent.focus(parentInput); });
    // Clear the just-opened guard so typed input is treated as a filter.
    await new Promise((r) => setTimeout(r, 150));
    await act(async () => { fireEvent.change(parentInput, { target: { value: 'Sal' } }); });

    await waitFor(() => {
      expect(screen.getByText('Salary')).toBeInTheDocument();
      expect(screen.queryByText('Food')).not.toBeInTheDocument();
      expect(screen.queryByText('Shopping')).not.toBeInTheDocument();
    });
  });

  it('excludes the edited category and its descendants from the parent options', async () => {
    const cats = [
      { id: 'c1', name: 'Food', parentId: null, isIncome: false },
      { id: 'c2', name: 'Groceries', parentId: 'c1', isIncome: false },
      { id: 'c3', name: 'Salary', parentId: null, isIncome: true },
    ] as any[];
    // Editing "Food": neither it nor its child "Groceries" may be offered as a
    // parent (that would create a cycle), but an unrelated category still is.
    render(<CategoryForm category={cats[0]} categories={cats} onSubmit={onSubmit} onCancel={onCancel} />);

    const parentInput = screen.getByPlaceholderText('No parent (top-level)');
    await act(async () => { fireEvent.focus(parentInput); });

    expect(screen.getByText('Salary')).toBeInTheDocument();
    expect(screen.queryByText('Food')).not.toBeInTheDocument();
    expect(screen.queryByText('Food: Groceries')).not.toBeInTheDocument();
  });

  it('selects colour when swatch is clicked', () => {
    render(<CategoryForm categories={categories} onSubmit={onSubmit} onCancel={onCancel} />);

    const redSwatch = screen.getByTitle('Red');
    fireEvent.click(redSwatch);

    // The red swatch should now have the selected ring style
    expect(redSwatch.className).toContain('ring-2');
  });

  it('does not render an icon field', () => {
    render(<CategoryForm categories={categories} onSubmit={onSubmit} onCancel={onCancel} />);
    expect(screen.queryByLabelText(/icon/i)).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText('e.g., shopping-cart')).not.toBeInTheDocument();
  });

  it('renders a mobile colour dropdown with all palette options', () => {
    render(<CategoryForm categories={categories} onSubmit={onSubmit} onCancel={onCancel} />);
    // The mobile select should contain colour options
    const selects = screen.getAllByRole('combobox');
    const colourSelect = selects.find(s => {
      const options = s.querySelectorAll('option');
      return Array.from(options).some(o => o.textContent === 'Red');
    });
    expect(colourSelect).toBeTruthy();

    // Verify all palette colours are present as options
    const options = colourSelect!.querySelectorAll('option');
    const optionLabels = Array.from(options).map(o => o.textContent);
    expect(optionLabels).toContain('No colour');
    expect(optionLabels).toContain('Red');
    expect(optionLabels).toContain('Blue');
    expect(optionLabels).toContain('Green');
  });

  it('selects colour via mobile dropdown', () => {
    render(<CategoryForm categories={categories} onSubmit={onSubmit} onCancel={onCancel} />);
    const selects = screen.getAllByRole('combobox');
    const colourSelect = selects.find(s => {
      const options = s.querySelectorAll('option');
      return Array.from(options).some(o => o.textContent === 'Red');
    });
    expect(colourSelect).toBeTruthy();

    fireEvent.change(colourSelect!, { target: { value: '#ef4444' } });

    // The desktop red swatch should now show as selected
    const redSwatch = screen.getByTitle('Red');
    expect(redSwatch.className).toContain('ring-2');
  });
});
