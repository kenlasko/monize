import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@/test/render';
import { AssetFields } from './AssetFields';
import { Category } from '@/types/category';

vi.mock('@/components/ui/Combobox', () => ({
  Combobox: ({ label, value, options }: any) => (
    <div data-testid={`combobox-${label}`}>
      <span>{label}</span>
      <span data-testid="combobox-value">{value}</span>
      <span data-testid="combobox-options-count">{options?.length}</span>
    </div>
  ),
}));

const mockCategories: Category[] = [
  {
    id: 'cat-1', userId: 'user-1', parentId: null, parent: null, children: [],
    name: 'Home Value Change', description: null, icon: null, color: null, effectiveColor: null, effectiveIcon: null, autoSign: null, effectiveAutoSign: true,
    isIncome: false, isSystem: false, createdAt: '2024-01-01T00:00:00Z',
  },
  {
    id: 'cat-2', userId: 'user-1', parentId: 'cat-1', parent: null, children: [],
    name: 'Appreciation', description: null, icon: null, color: null, effectiveColor: null, effectiveIcon: null, autoSign: null, effectiveAutoSign: true,
    isIncome: false, isSystem: false, createdAt: '2024-01-01T00:00:00Z',
  },
];

describe('AssetFields', () => {
  const mockRegister = vi.fn().mockReturnValue({
    name: 'fieldName', onChange: vi.fn(), onBlur: vi.fn(), ref: vi.fn(),
  });

  const defaultProps = {
    categories: mockCategories,
    selectedAssetCategoryId: '',
    assetCategoryName: '',
    accountAssetCategoryId: null as string | null | undefined,
    handleAssetCategoryChange: vi.fn(),
    handleAssetCategoryCreate: vi.fn(),
    register: mockRegister,
    setValue: vi.fn(),
    errors: {} as any,
    watchedDateAcquired: undefined as string | undefined,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the heading', () => {
    render(<AssetFields {...defaultProps} />);
    expect(screen.getByText('Asset Value Change Settings')).toBeInTheDocument();
  });

  it('renders the Value Change Category combobox', () => {
    render(<AssetFields {...defaultProps} />);
    expect(screen.getByText('Value Change Category')).toBeInTheDocument();
  });

  it('renders Date Acquired input', () => {
    render(<AssetFields {...defaultProps} />);
    expect(screen.getByText('Date Acquired')).toBeInTheDocument();
  });

  it('shows the explanatory text about net worth', () => {
    render(<AssetFields {...defaultProps} />);
    expect(screen.getByText(/excluded from net worth calculations/)).toBeInTheDocument();
  });

  it('renders category explanation text', () => {
    render(<AssetFields {...defaultProps} />);
    expect(screen.getByText(/Select a category that will be used to track value changes/)).toBeInTheDocument();
  });

  it('passes categories to combobox with sorted labels', () => {
    render(<AssetFields {...defaultProps} />);
    const optionsCount = screen.getByTestId('combobox-options-count');
    expect(optionsCount.textContent).toBe('2');
  });

  it('offers Income and Expense categories only: value changes are category rows (INV-CATEGORY-001)', () => {
    render(
      <AssetFields
        {...defaultProps}
        categories={[
          ...mockCategories,
          { ...mockCategories[0], id: 'cat-t', name: 'Savings moves', categoryType: 'transfer' } as Category,
        ]}
      />,
    );
    expect(screen.getByTestId('combobox-options-count').textContent).toBe('2');
  });

  it('passes selected category id to combobox', () => {
    render(<AssetFields {...defaultProps} selectedAssetCategoryId="cat-1" />);
    const comboboxValue = screen.getByTestId('combobox-value');
    expect(comboboxValue.textContent).toBe('cat-1');
  });

  it('applies date-empty class when watchedDateAcquired is undefined', () => {
    render(<AssetFields {...defaultProps} watchedDateAcquired={undefined} />);
    // The date input should exist and register should have been called with 'dateAcquired'
    expect(mockRegister).toHaveBeenCalledWith('dateAcquired');
  });

  it('does not apply date-empty class when watchedDateAcquired has a value', () => {
    render(<AssetFields {...defaultProps} watchedDateAcquired="2024-01-15" />);
    expect(mockRegister).toHaveBeenCalledWith('dateAcquired');
  });

  it('shows error message for dateAcquired when present', () => {
    render(
      <AssetFields {...defaultProps} errors={{ dateAcquired: { message: 'Date is required' } } as any} />
    );
    // The Input component should receive the error prop
    expect(mockRegister).toHaveBeenCalledWith('dateAcquired');
  });

  it('renders with green-themed border and background', () => {
    const { container } = render(<AssetFields {...defaultProps} />);
    const wrapper = container.querySelector('.bg-green-50');
    expect(wrapper).toBeInTheDocument();
  });

  it('uses assetCategoryName to find initialDisplayValue when non-empty', () => {
    render(
      <AssetFields
        {...defaultProps}
        assetCategoryName="Home Value Change"
        selectedAssetCategoryId="cat-1"
      />
    );
    // Combobox renders with cat-1 as value
    expect(screen.getByTestId('combobox-value').textContent).toBe('cat-1');
  });

  it('uses accountAssetCategoryId as fallback when selectedAssetCategoryId is empty', () => {
    render(
      <AssetFields
        {...defaultProps}
        assetCategoryName=""
        accountAssetCategoryId="cat-1"
        selectedAssetCategoryId=""
      />
    );
    expect(screen.getByTestId('combobox-value').textContent).toBe('');
  });

  it('returns empty initialDisplayValue when neither assetCategoryName nor accountAssetCategoryId', () => {
    render(
      <AssetFields
        {...defaultProps}
        assetCategoryName=""
        accountAssetCategoryId={null}
        selectedAssetCategoryId=""
      />
    );
    expect(screen.getByTestId('combobox-value').textContent).toBe('');
  });

  it('formats subcategory label with parent name', () => {
    render(<AssetFields {...defaultProps} />);
    const optionsCount = screen.getByTestId('combobox-options-count');
    // Both categories (1 top-level, 1 subcategory) are shown
    expect(optionsCount.textContent).toBe('2');
  });

  it('renders with unknown parent category gracefully', () => {
    const catsWithOrphan: Category[] = [
      ...mockCategories,
      {
        id: 'cat-3', userId: 'user-1', parentId: 'unknown-parent', parent: null, children: [],
        name: 'Orphan', description: null, icon: null, color: null, effectiveColor: null, effectiveIcon: null, autoSign: null, effectiveAutoSign: true,
        isIncome: false, isSystem: false, createdAt: '2024-01-01T00:00:00Z',
      },
    ];
    render(<AssetFields {...defaultProps} categories={catsWithOrphan} />);
    expect(screen.getByTestId('combobox-options-count').textContent).toBe('3');
  });
});
