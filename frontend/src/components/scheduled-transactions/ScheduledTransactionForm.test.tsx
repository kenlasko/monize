import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@/test/render';
import { ScheduledTransactionForm } from './ScheduledTransactionForm';

vi.mock('@/hooks/useNumberFormat', () => ({
  useNumberFormat: () => ({ defaultCurrency: 'CAD' }),
}));

vi.mock('@/lib/zodResolver', () => ({
  zodResolver: () => async () => ({ values: {}, errors: {} }),
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

vi.mock('@/lib/accounts', () => ({
  accountsApi: { getAll: vi.fn().mockResolvedValue([]) },
}));

vi.mock('@/lib/categories', () => ({
  categoriesApi: { getAll: vi.fn().mockResolvedValue([]), create: vi.fn().mockResolvedValue({ id: 'new', name: 'New' }) },
}));

vi.mock('@/lib/payees', () => ({
  payeesApi: { getAll: vi.fn().mockResolvedValue([]), create: vi.fn().mockResolvedValue({ id: 'new', name: 'New' }) },
}));

vi.mock('@/lib/scheduled-transactions', () => ({
  scheduledTransactionsApi: {
    create: vi.fn().mockResolvedValue({}),
    update: vi.fn().mockResolvedValue({}),
  },
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() }),
}));

vi.mock('@/lib/categoryUtils', () => ({
  buildCategoryTree: () => [],
}));

vi.mock('@/components/transactions/SplitEditor', () => ({
  SplitEditor: () => null,
  createEmptySplits: () => [],
  toSplitRows: () => [],
  toCreateSplitData: () => [],
}));

vi.mock('@/components/ui/Combobox', () => ({
  Combobox: ({ label, placeholder }: any) => (
    <div>
      {label && <label>{label}</label>}
      <input placeholder={placeholder} />
    </div>
  ),
}));

describe('ScheduledTransactionForm', () => {
  it('renders form with payment and transfer toggle', () => {
    render(<ScheduledTransactionForm />);
    expect(screen.getByText('Bill / Deposit')).toBeInTheDocument();
    expect(screen.getByText('Transfer')).toBeInTheDocument();
  });

  it('renders name and frequency fields', () => {
    render(<ScheduledTransactionForm />);
    expect(screen.getByText('Name')).toBeInTheDocument();
    expect(screen.getByText('Frequency')).toBeInTheDocument();
    expect(screen.getByText('Next Due Date')).toBeInTheDocument();
  });

  it('shows Create button for new form', () => {
    render(<ScheduledTransactionForm />);
    expect(screen.getByText('Create')).toBeInTheDocument();
  });

  it('shows Update button when editing', () => {
    const st = {
      id: 's1', accountId: 'a1', name: 'Rent', amount: -1500, currencyCode: 'CAD',
      frequency: 'MONTHLY', nextDueDate: '2024-02-01', isActive: true, autoPost: false,
      reminderDaysBefore: 3, isTransfer: false, isSplit: false,
    } as any;
    render(<ScheduledTransactionForm scheduledTransaction={st} />);
    expect(screen.getByText('Update')).toBeInTheDocument();
  });
});
