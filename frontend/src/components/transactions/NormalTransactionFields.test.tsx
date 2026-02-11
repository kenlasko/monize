import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@/test/render';
import { NormalTransactionFields } from './NormalTransactionFields';

vi.mock('@/lib/format', () => ({
  getCurrencySymbol: () => '$',
}));

vi.mock('@/components/ui/Combobox', () => ({
  Combobox: ({ label }: any) => <div data-testid={`combobox-${label}`}>{label}</div>,
}));

vi.mock('@/components/ui/CurrencyInput', () => ({
  CurrencyInput: ({ label }: any) => <div data-testid={`currency-input-${label}`}>{label}</div>,
}));

describe('NormalTransactionFields', () => {
  const mockRegister = vi.fn().mockReturnValue({
    name: 'fieldName', onChange: vi.fn(), onBlur: vi.fn(), ref: vi.fn(),
  });

  const defaultProps = {
    register: mockRegister,
    errors: {},
    watchedAccountId: '',
    watchedAmount: 0,
    watchedCurrencyCode: 'CAD',
    accounts: [],
    selectedPayeeId: '',
    selectedCategoryId: '',
    payees: [],
    categoryOptions: [],
    handlePayeeChange: vi.fn(),
    handlePayeeCreate: vi.fn(),
    handleCategoryChange: vi.fn(),
    handleCategoryCreate: vi.fn(),
    handleAmountChange: vi.fn(),
    handleModeChange: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders Account select', () => {
    render(<NormalTransactionFields {...defaultProps} />);

    expect(screen.getByText('Account')).toBeInTheDocument();
  });

  it('renders Date input', () => {
    render(<NormalTransactionFields {...defaultProps} />);

    expect(screen.getByText('Date')).toBeInTheDocument();
  });

  it('renders Payee combobox', () => {
    render(<NormalTransactionFields {...defaultProps} />);

    expect(screen.getByText('Payee')).toBeInTheDocument();
  });

  it('renders Category combobox', () => {
    render(<NormalTransactionFields {...defaultProps} />);

    expect(screen.getByText('Category')).toBeInTheDocument();
  });

  it('renders Amount input', () => {
    render(<NormalTransactionFields {...defaultProps} />);

    expect(screen.getByText('Amount')).toBeInTheDocument();
  });

  it('renders Reference Number input', () => {
    render(<NormalTransactionFields {...defaultProps} />);

    expect(screen.getByText('Reference Number')).toBeInTheDocument();
  });
});
