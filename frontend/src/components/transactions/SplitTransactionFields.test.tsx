import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@/test/render';
import { SplitTransactionFields } from './SplitTransactionFields';

vi.mock('@/lib/format', () => ({
  getCurrencySymbol: () => '$',
}));

vi.mock('@/components/ui/Combobox', () => ({
  Combobox: ({ label }: any) => <div data-testid={`combobox-${label}`}>{label}</div>,
}));

vi.mock('@/components/ui/CurrencyInput', () => ({
  CurrencyInput: ({ label }: any) => <div data-testid={`currency-input-${label}`}>{label}</div>,
}));

describe('SplitTransactionFields', () => {
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
    payees: [],
    handlePayeeChange: vi.fn(),
    handlePayeeCreate: vi.fn(),
    setValue: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders Account select', () => {
    render(<SplitTransactionFields {...defaultProps} />);

    expect(screen.getByText('Account')).toBeInTheDocument();
  });

  it('renders Date input', () => {
    render(<SplitTransactionFields {...defaultProps} />);

    expect(screen.getByText('Date')).toBeInTheDocument();
  });

  it('renders Payee combobox', () => {
    render(<SplitTransactionFields {...defaultProps} />);

    expect(screen.getByText('Payee')).toBeInTheDocument();
  });

  it('renders Total Amount input', () => {
    render(<SplitTransactionFields {...defaultProps} />);

    expect(screen.getByText('Total Amount')).toBeInTheDocument();
  });

  it('renders Reference Number input', () => {
    render(<SplitTransactionFields {...defaultProps} />);

    expect(screen.getByText('Reference Number')).toBeInTheDocument();
  });
});
