import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@/test/render';
import { InvestmentTransactionForm } from './InvestmentTransactionForm';

vi.mock('@/hooks/useNumberFormat', () => ({
  useNumberFormat: () => ({
    defaultCurrency: 'CAD',
  }),
}));

vi.mock('@/lib/format', () => ({
  getCurrencySymbol: () => '$',
  roundToCents: (v: number) => Math.round(v * 100) / 100,
  formatAmountWithCommas: (v: number) => v?.toLocaleString() ?? '',
  parseAmount: (v: string) => parseFloat(v) || 0,
  filterCurrencyInput: (v: string) => v,
  filterCalculatorInput: (v: string) => v,
  hasCalculatorOperators: () => false,
  evaluateExpression: (v: string) => parseFloat(v) || 0,
}));

vi.mock('@/lib/investments', () => ({
  investmentsApi: {
    getSecurities: vi.fn().mockResolvedValue([]),
    createSecurity: vi.fn().mockResolvedValue({ id: 'new-sec', symbol: 'TEST', name: 'Test' }),
    createTransaction: vi.fn().mockResolvedValue({}),
    updateTransaction: vi.fn().mockResolvedValue({}),
  },
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() }),
}));

vi.mock('@/lib/zodResolver', () => ({
  zodResolver: () => async () => ({ values: {}, errors: {} }),
}));

describe('InvestmentTransactionForm', () => {
  const accounts = [
    { id: 'a1', name: 'RRSP Brokerage', accountType: 'INVESTMENT', accountSubType: 'INVESTMENT_BROKERAGE', currencyCode: 'CAD' },
  ] as any[];

  it('renders form fields', () => {
    render(<InvestmentTransactionForm accounts={accounts} />);
    expect(screen.getByText('Brokerage Account')).toBeInTheDocument();
    expect(screen.getByText('Transaction Type')).toBeInTheDocument();
    expect(screen.getByText('Date')).toBeInTheDocument();
  });

  it('shows Create Transaction button for new form', () => {
    render(<InvestmentTransactionForm accounts={accounts} />);
    expect(screen.getByText('Create Transaction')).toBeInTheDocument();
  });

  it('shows Update Transaction button for editing', () => {
    const transaction = {
      id: 't1', accountId: 'a1', action: 'BUY' as const, transactionDate: '2024-01-01',
      quantity: 10, price: 50, commission: 5, totalAmount: 505, description: '',
    } as any;

    render(<InvestmentTransactionForm accounts={accounts} transaction={transaction} />);
    expect(screen.getByText('Update Transaction')).toBeInTheDocument();
  });

  it('renders cancel button when onCancel provided', () => {
    const onCancel = vi.fn();
    render(<InvestmentTransactionForm accounts={accounts} onCancel={onCancel} />);
    expect(screen.getByText('Cancel')).toBeInTheDocument();
  });
});
