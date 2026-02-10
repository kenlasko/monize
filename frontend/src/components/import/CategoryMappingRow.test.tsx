import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@/test/render';
import { CategoryMappingRow } from './CategoryMappingRow';

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
  ] as any[];

  const onMappingChange = vi.fn();
  const formatCategoryPath = (path: string) => path.replace(':', ' > ');

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
  });
});
