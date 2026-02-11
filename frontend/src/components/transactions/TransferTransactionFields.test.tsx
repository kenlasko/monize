import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@/test/render';
import { TransferTransactionFields } from './TransferTransactionFields';

vi.mock('@/lib/format', () => ({
  getCurrencySymbol: () => '$',
}));

vi.mock('@/components/ui/Combobox', () => ({
  Combobox: ({ label }: any) => <div data-testid={`combobox-${label}`}>{label}</div>,
}));

vi.mock('@/components/ui/CurrencyInput', () => ({
  CurrencyInput: ({ label }: any) => <div data-testid={`currency-input-${label}`}>{label}</div>,
}));

describe('TransferTransactionFields', () => {
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
    setValue: vi.fn(),
    transferToAccountId: '',
    setTransferToAccountId: vi.fn(),
    transferTargetAmount: undefined,
    setTransferTargetAmount: vi.fn(),
    transferPayeeId: '',
    transferPayeeName: '',
    setTransferPayeeId: vi.fn(),
    setTransferPayeeName: vi.fn(),
    crossCurrencyInfo: null,
    payees: [],
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders Date input', () => {
    render(<TransferTransactionFields {...defaultProps} />);

    expect(screen.getByText('Date')).toBeInTheDocument();
  });

  it('renders From Account select', () => {
    render(<TransferTransactionFields {...defaultProps} />);

    expect(screen.getByText('From Account')).toBeInTheDocument();
  });

  it('renders To Account select', () => {
    render(<TransferTransactionFields {...defaultProps} />);

    expect(screen.getByText('To Account')).toBeInTheDocument();
  });

  it('renders Transfer Amount input', () => {
    render(<TransferTransactionFields {...defaultProps} />);

    expect(screen.getByText('Transfer Amount')).toBeInTheDocument();
  });

  it('renders Reference Number input', () => {
    render(<TransferTransactionFields {...defaultProps} />);

    expect(screen.getByText('Reference Number')).toBeInTheDocument();
  });

  it('does not show cross-currency section when crossCurrencyInfo is null', () => {
    render(<TransferTransactionFields {...defaultProps} />);

    expect(screen.queryByText('Received Amount')).not.toBeInTheDocument();
  });

  it('shows cross-currency section when crossCurrencyInfo is provided', () => {
    render(
      <TransferTransactionFields
        {...defaultProps}
        crossCurrencyInfo={{
          fromCurrency: 'CAD',
          toCurrency: 'USD',
          fromAccountName: 'CAD Account',
          toAccountName: 'USD Account',
        }}
      />
    );

    expect(screen.getByText('Amount Received (USD)')).toBeInTheDocument();
  });
});
