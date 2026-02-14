import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@/test/render';
import { CategoryMappingRow } from './CategoryMappingRow';
import type { CategoryMapping } from '@/lib/import';

describe('CategoryMappingRow', () => {
  const defaultMapping = {
    originalName: 'Entertainment:Movies',
    categoryId: undefined,
    createNew: undefined,
    parentCategoryId: undefined,
    isLoanCategory: false,
    loanAccountId: undefined,
    createNewLoan: undefined,
    newLoanAmount: undefined,
    newLoanInstitution: undefined,
  } as any;

  const categoryOptions = [
    { value: '', label: 'Select category...' },
    { value: 'c1', label: 'Entertainment' },
    { value: 'c2', label: 'Food' },
  ];

  const parentCategoryOptions = [
    { value: '', label: 'No parent' },
    { value: 'c1', label: 'Entertainment' },
  ];

  const loanAccounts = [
    { id: 'loan1', name: 'Mortgage', institution: 'TD Bank' },
    { id: 'loan2', name: 'Car Loan', institution: null },
  ] as any[];

  let onMappingChange: ReturnType<typeof vi.fn<(update: Partial<CategoryMapping>) => void>>;
  const formatCategoryPath = (path: string) => path.replace(':', ' > ');

  beforeEach(() => {
    onMappingChange = vi.fn();
  });

  // --- Highlighted (unmatched) view ---

  it('renders highlighted row with original category name', () => {
    render(
      <CategoryMappingRow
        mapping={defaultMapping}
        categoryOptions={categoryOptions}
        parentCategoryOptions={parentCategoryOptions}
        loanAccounts={loanAccounts}
        onMappingChange={onMappingChange}
        formatCategoryPath={formatCategoryPath}
        isHighlighted={true}
      />
    );
    expect(screen.getByText('Entertainment > Movies')).toBeInTheDocument();
  });

  it('shows loan payment checkbox when highlighted', () => {
    render(
      <CategoryMappingRow
        mapping={defaultMapping}
        categoryOptions={categoryOptions}
        parentCategoryOptions={parentCategoryOptions}
        loanAccounts={loanAccounts}
        onMappingChange={onMappingChange}
        formatCategoryPath={formatCategoryPath}
        isHighlighted={true}
      />
    );
    expect(screen.getByText('This is a loan payment')).toBeInTheDocument();
  });

  it('calls onMappingChange when loan checkbox is toggled', () => {
    render(
      <CategoryMappingRow
        mapping={defaultMapping}
        categoryOptions={categoryOptions}
        parentCategoryOptions={parentCategoryOptions}
        loanAccounts={loanAccounts}
        onMappingChange={onMappingChange}
        formatCategoryPath={formatCategoryPath}
        isHighlighted={true}
      />
    );
    fireEvent.click(screen.getByText('This is a loan payment'));
    expect(onMappingChange).toHaveBeenCalledWith(expect.objectContaining({ isLoanCategory: true }));
  });

  it('pre-fills loan name from last segment of originalName when enabling loan', () => {
    render(
      <CategoryMappingRow
        mapping={defaultMapping}
        categoryOptions={categoryOptions}
        parentCategoryOptions={parentCategoryOptions}
        loanAccounts={loanAccounts}
        onMappingChange={onMappingChange}
        formatCategoryPath={formatCategoryPath}
        isHighlighted={true}
      />
    );
    fireEvent.click(screen.getByText('This is a loan payment'));
    expect(onMappingChange).toHaveBeenCalledWith(
      expect.objectContaining({ createNewLoan: 'Movies' })
    );
  });

  it('shows loan UI when isLoanCategory is true', () => {
    const loanMapping = { ...defaultMapping, isLoanCategory: true };
    render(
      <CategoryMappingRow
        mapping={loanMapping}
        categoryOptions={categoryOptions}
        parentCategoryOptions={parentCategoryOptions}
        loanAccounts={loanAccounts}
        onMappingChange={onMappingChange}
        formatCategoryPath={formatCategoryPath}
        isHighlighted={true}
      />
    );
    expect(screen.getByText('Select existing loan')).toBeInTheDocument();
    expect(screen.getByText(/transferred to the selected loan account/)).toBeInTheDocument();
  });

  it('shows new loan fields when no loan account is selected', () => {
    const loanMapping = { ...defaultMapping, isLoanCategory: true };
    render(
      <CategoryMappingRow
        mapping={loanMapping}
        categoryOptions={categoryOptions}
        parentCategoryOptions={parentCategoryOptions}
        loanAccounts={loanAccounts}
        onMappingChange={onMappingChange}
        formatCategoryPath={formatCategoryPath}
        isHighlighted={true}
      />
    );
    expect(screen.getByText('Or create new loan')).toBeInTheDocument();
    expect(screen.getByText('Institution')).toBeInTheDocument();
    expect(screen.getByText('Initial loan amount')).toBeInTheDocument();
  });

  it('hides new loan fields when loanAccountId is set', () => {
    const loanMapping = { ...defaultMapping, isLoanCategory: true, loanAccountId: 'loan1' };
    render(
      <CategoryMappingRow
        mapping={loanMapping}
        categoryOptions={categoryOptions}
        parentCategoryOptions={parentCategoryOptions}
        loanAccounts={loanAccounts}
        onMappingChange={onMappingChange}
        formatCategoryPath={formatCategoryPath}
        isHighlighted={true}
      />
    );
    expect(screen.queryByText('Or create new loan')).not.toBeInTheDocument();
  });

  it('calls onMappingChange when a category is selected', () => {
    render(
      <CategoryMappingRow
        mapping={defaultMapping}
        categoryOptions={categoryOptions}
        parentCategoryOptions={parentCategoryOptions}
        loanAccounts={loanAccounts}
        onMappingChange={onMappingChange}
        formatCategoryPath={formatCategoryPath}
        isHighlighted={true}
      />
    );
    const selects = screen.getAllByRole('combobox');
    // The first select should be "Map to existing"
    fireEvent.change(selects[0], { target: { value: 'c1' } });
    expect(onMappingChange).toHaveBeenCalledWith(
      expect.objectContaining({
        categoryId: 'c1',
        createNew: undefined,
        isLoanCategory: false,
      })
    );
  });

  it('calls onMappingChange on create new input blur', () => {
    render(
      <CategoryMappingRow
        mapping={defaultMapping}
        categoryOptions={categoryOptions}
        parentCategoryOptions={parentCategoryOptions}
        loanAccounts={loanAccounts}
        onMappingChange={onMappingChange}
        formatCategoryPath={formatCategoryPath}
        isHighlighted={true}
      />
    );
    const createNewInput = screen.getByPlaceholderText('New category name');
    fireEvent.change(createNewInput, { target: { value: 'New Cat' } });
    fireEvent.blur(createNewInput);
    expect(onMappingChange).toHaveBeenCalledWith(
      expect.objectContaining({
        categoryId: undefined,
        createNew: 'New Cat',
      })
    );
  });

  it('shows parent category selector when create new has content', () => {
    render(
      <CategoryMappingRow
        mapping={defaultMapping}
        categoryOptions={categoryOptions}
        parentCategoryOptions={parentCategoryOptions}
        loanAccounts={loanAccounts}
        onMappingChange={onMappingChange}
        formatCategoryPath={formatCategoryPath}
        isHighlighted={true}
      />
    );
    const createNewInput = screen.getByPlaceholderText('New category name');
    fireEvent.change(createNewInput, { target: { value: 'New Cat' } });
    expect(screen.getByText('Parent category')).toBeInTheDocument();
  });

  it('calls onMappingChange when loan account is selected', () => {
    const loanMapping = { ...defaultMapping, isLoanCategory: true };
    render(
      <CategoryMappingRow
        mapping={loanMapping}
        categoryOptions={categoryOptions}
        parentCategoryOptions={parentCategoryOptions}
        loanAccounts={loanAccounts}
        onMappingChange={onMappingChange}
        formatCategoryPath={formatCategoryPath}
        isHighlighted={true}
      />
    );
    const selects = screen.getAllByRole('combobox');
    // Find the loan account select
    const loanSelect = selects.find((s) => {
      const options = Array.from(s.querySelectorAll('option'));
      return options.some((o) => o.textContent?.includes('Mortgage'));
    });
    expect(loanSelect).toBeDefined();
    fireEvent.change(loanSelect!, { target: { value: 'loan1' } });
    expect(onMappingChange).toHaveBeenCalledWith(
      expect.objectContaining({
        loanAccountId: 'loan1',
        createNewLoan: undefined,
      })
    );
  });

  it('shows loan accounts with institution in options', () => {
    const loanMapping = { ...defaultMapping, isLoanCategory: true };
    render(
      <CategoryMappingRow
        mapping={loanMapping}
        categoryOptions={categoryOptions}
        parentCategoryOptions={parentCategoryOptions}
        loanAccounts={loanAccounts}
        onMappingChange={onMappingChange}
        formatCategoryPath={formatCategoryPath}
        isHighlighted={true}
      />
    );
    expect(screen.getByText('Mortgage (TD Bank)')).toBeInTheDocument();
    expect(screen.getByText('Car Loan')).toBeInTheDocument();
  });

  // --- Compact (auto-matched) view ---

  it('renders compact view for auto-matched categories', () => {
    const matched = { ...defaultMapping, categoryId: 'c1' };
    render(
      <CategoryMappingRow
        mapping={matched}
        categoryOptions={categoryOptions}
        parentCategoryOptions={parentCategoryOptions}
        loanAccounts={loanAccounts}
        onMappingChange={onMappingChange}
        formatCategoryPath={formatCategoryPath}
        isHighlighted={false}
      />
    );
    expect(screen.getByText('Entertainment > Movies')).toBeInTheDocument();
    // Compact view should have arrow separator
    expect(screen.getByText('\u2192')).toBeInTheDocument();
  });

  it('shows Loan label in compact view for loan categories', () => {
    const loanMatched = {
      ...defaultMapping,
      isLoanCategory: true,
      loanAccountId: 'loan1',
    };
    render(
      <CategoryMappingRow
        mapping={loanMatched}
        categoryOptions={categoryOptions}
        parentCategoryOptions={parentCategoryOptions}
        loanAccounts={loanAccounts}
        onMappingChange={onMappingChange}
        formatCategoryPath={formatCategoryPath}
        isHighlighted={false}
      />
    );
    expect(screen.getByText(/Loan:/)).toBeInTheDocument();
    expect(screen.getByText(/Mortgage/)).toBeInTheDocument();
  });

  it('shows "(new)" suffix in compact view for create new loan', () => {
    const loanNew = {
      ...defaultMapping,
      isLoanCategory: true,
      createNewLoan: 'My New Loan',
    };
    render(
      <CategoryMappingRow
        mapping={loanNew}
        categoryOptions={categoryOptions}
        parentCategoryOptions={parentCategoryOptions}
        loanAccounts={loanAccounts}
        onMappingChange={onMappingChange}
        formatCategoryPath={formatCategoryPath}
        isHighlighted={false}
      />
    );
    expect(screen.getByText(/My New Loan \(new\)/)).toBeInTheDocument();
  });

  it('applies amber styling when highlighted', () => {
    const { container } = render(
      <CategoryMappingRow
        mapping={defaultMapping}
        categoryOptions={categoryOptions}
        parentCategoryOptions={parentCategoryOptions}
        loanAccounts={loanAccounts}
        onMappingChange={onMappingChange}
        formatCategoryPath={formatCategoryPath}
        isHighlighted={true}
      />
    );
    const row = container.firstElementChild;
    expect(row?.className).toContain('border-amber');
  });

  it('applies green styling when not highlighted', () => {
    const matched = { ...defaultMapping, categoryId: 'c1' };
    const { container } = render(
      <CategoryMappingRow
        mapping={matched}
        categoryOptions={categoryOptions}
        parentCategoryOptions={parentCategoryOptions}
        loanAccounts={loanAccounts}
        onMappingChange={onMappingChange}
        formatCategoryPath={formatCategoryPath}
        isHighlighted={false}
      />
    );
    const row = container.firstElementChild;
    expect(row?.className).toContain('border-green');
  });

  it('calls onMappingChange on new loan name blur', () => {
    const loanMapping = { ...defaultMapping, isLoanCategory: true };
    render(
      <CategoryMappingRow
        mapping={loanMapping}
        categoryOptions={categoryOptions}
        parentCategoryOptions={parentCategoryOptions}
        loanAccounts={loanAccounts}
        onMappingChange={onMappingChange}
        formatCategoryPath={formatCategoryPath}
        isHighlighted={true}
      />
    );
    const loanNameInput = screen.getByPlaceholderText('Loan account name');
    fireEvent.change(loanNameInput, { target: { value: 'Home Loan' } });
    fireEvent.blur(loanNameInput);
    expect(onMappingChange).toHaveBeenCalledWith(
      expect.objectContaining({ createNewLoan: 'Home Loan' })
    );
  });

  it('calls onMappingChange on new loan amount blur with cleaned value', () => {
    const loanMapping = { ...defaultMapping, isLoanCategory: true };
    render(
      <CategoryMappingRow
        mapping={loanMapping}
        categoryOptions={categoryOptions}
        parentCategoryOptions={parentCategoryOptions}
        loanAccounts={loanAccounts}
        onMappingChange={onMappingChange}
        formatCategoryPath={formatCategoryPath}
        isHighlighted={true}
      />
    );
    const amountInput = screen.getByPlaceholderText('e.g., 25000');
    fireEvent.change(amountInput, { target: { value: '$25,000' } });
    fireEvent.blur(amountInput);
    expect(onMappingChange).toHaveBeenCalledWith(
      expect.objectContaining({ newLoanAmount: 25000 })
    );
  });

  it('calls onMappingChange on institution blur', () => {
    const loanMapping = { ...defaultMapping, isLoanCategory: true };
    render(
      <CategoryMappingRow
        mapping={loanMapping}
        categoryOptions={categoryOptions}
        parentCategoryOptions={parentCategoryOptions}
        loanAccounts={loanAccounts}
        onMappingChange={onMappingChange}
        formatCategoryPath={formatCategoryPath}
        isHighlighted={true}
      />
    );
    const institutionInput = screen.getByPlaceholderText('e.g., TD Bank, RBC');
    fireEvent.change(institutionInput, { target: { value: 'BMO' } });
    fireEvent.blur(institutionInput);
    expect(onMappingChange).toHaveBeenCalledWith(
      expect.objectContaining({ newLoanInstitution: 'BMO' })
    );
  });

  it('clears loan fields when unchecking loan checkbox', () => {
    const loanMapping = { ...defaultMapping, isLoanCategory: true };
    render(
      <CategoryMappingRow
        mapping={loanMapping}
        categoryOptions={categoryOptions}
        parentCategoryOptions={parentCategoryOptions}
        loanAccounts={loanAccounts}
        onMappingChange={onMappingChange}
        formatCategoryPath={formatCategoryPath}
        isHighlighted={true}
      />
    );
    fireEvent.click(screen.getByText('This is a loan payment'));
    expect(onMappingChange).toHaveBeenCalledWith(
      expect.objectContaining({
        isLoanCategory: false,
        createNewLoan: undefined,
      })
    );
  });
});
