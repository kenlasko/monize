import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@/test/render';
import { MapCategoriesStep } from './MapCategoriesStep';
import { createRef } from 'react';

vi.mock('@/components/import/CategoryMappingRow', () => ({
  CategoryMappingRow: ({ mapping }: any) => (
    <div data-testid="category-mapping-row">{mapping.originalName}</div>
  ),
}));

describe('MapCategoriesStep', () => {
  const defaultProps = {
    categoryMappings: [
      { originalName: 'Groceries', categoryId: '', isLoanCategory: false, loanAccountId: '', createNewLoan: '', newLoanAmount: undefined, newLoanInstitution: '' },
      { originalName: 'Utilities', categoryId: 'cat-1', isLoanCategory: false, loanAccountId: '', createNewLoan: '', newLoanAmount: undefined, newLoanInstitution: '' },
    ],
    setCategoryMappings: vi.fn(),
    categoryOptions: [{ value: 'cat-1', label: 'Utilities' }],
    parentCategoryOptions: [{ value: 'parent-1', label: 'Expenses' }],
    accounts: [],
    scrollContainerRef: createRef<HTMLDivElement>(),
    formatCategoryPath: vi.fn((path: string) => path),
    securityMappings: { length: 0 },
    shouldShowMapAccounts: false,
    setStep: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the heading', () => {
    render(<MapCategoriesStep {...defaultProps} />);

    expect(screen.getByText('Map Categories')).toBeInTheDocument();
  });

  it('shows unmatched count', () => {
    render(<MapCategoriesStep {...defaultProps} />);

    expect(screen.getByText(/1 need/)).toBeInTheDocument();
  });

  it('renders CategoryMappingRow for unmatched categories', () => {
    render(<MapCategoriesStep {...defaultProps} />);

    expect(screen.getByText('Groceries')).toBeInTheDocument();
  });

  it('shows Back button that navigates to selectAccount', () => {
    render(<MapCategoriesStep {...defaultProps} />);

    fireEvent.click(screen.getByRole('button', { name: /Back/i }));
    expect(defaultProps.setStep).toHaveBeenCalledWith('selectAccount');
  });

  it('navigates to review when no security mappings', () => {
    render(<MapCategoriesStep {...defaultProps} />);

    fireEvent.click(screen.getByRole('button', { name: /Next/i }));
    expect(defaultProps.setStep).toHaveBeenCalledWith('review');
  });

  it('navigates to mapSecurities when security mappings exist', () => {
    render(<MapCategoriesStep {...defaultProps} securityMappings={{ length: 2 }} />);

    fireEvent.click(screen.getByRole('button', { name: /Next/i }));
    expect(defaultProps.setStep).toHaveBeenCalledWith('mapSecurities');
  });
});
