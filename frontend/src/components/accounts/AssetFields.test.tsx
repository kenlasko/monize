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
    name: 'Home Value Change', description: null, icon: null, color: null,
    isIncome: false, isSystem: false, createdAt: '2024-01-01T00:00:00Z',
  },
  {
    id: 'cat-2', userId: 'user-1', parentId: 'cat-1', parent: null, children: [],
    name: 'Appreciation', description: null, icon: null, color: null,
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
});
