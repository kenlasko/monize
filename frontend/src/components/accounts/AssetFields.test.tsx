import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@/test/render';
import { AssetFields } from './AssetFields';
import { Category } from '@/types/category';

vi.mock('@/components/ui/Combobox', () => ({
  Combobox: ({ label }: any) => <div data-testid={`combobox-${label}`}>{label}</div>,
}));

const mockCategories: Category[] = [
  {
    id: 'cat-1', userId: 'user-1', parentId: null, parent: null, children: [],
    name: 'Home Value Change', description: null, icon: null, color: null,
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
    accountAssetCategoryId: null,
    handleAssetCategoryChange: vi.fn(),
    handleAssetCategoryCreate: vi.fn(),
    register: mockRegister,
    errors: {},
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
});
