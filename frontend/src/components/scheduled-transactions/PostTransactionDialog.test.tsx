import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@/test/render';
import { PostTransactionDialog } from './PostTransactionDialog';

vi.mock('@/lib/scheduled-transactions', () => ({
  scheduledTransactionsApi: {
    post: vi.fn().mockResolvedValue({}),
  },
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

vi.mock('@/lib/categoryUtils', () => ({
  buildCategoryTree: () => [],
}));

vi.mock('@/components/transactions/SplitEditor', () => ({
  SplitEditor: () => null,
  SplitRow: null,
  createEmptySplits: () => [],
  toSplitRows: () => [],
}));

vi.mock('@/components/ui/Combobox', () => ({
  Combobox: ({ placeholder }: any) => <input placeholder={placeholder} />,
}));

describe('PostTransactionDialog', () => {
  const scheduledTransaction = {
    id: 's1', name: 'Netflix', amount: -15.99, currencyCode: 'CAD',
    accountId: 'a1', categoryId: 'c1', description: 'Monthly sub',
    nextDueDate: '2025-02-15', isTransfer: false, isSplit: false,
    account: { name: 'Checking' },
  } as any;

  const categories = [{ id: 'c1', name: 'Entertainment', parentId: null }] as any[];
  const accounts = [{ id: 'a1', name: 'Checking' }] as any[];

  it('renders dialog title', () => {
    render(
      <PostTransactionDialog
        isOpen={true} scheduledTransaction={scheduledTransaction}
        categories={categories} accounts={accounts} onClose={vi.fn()} onPosted={vi.fn()}
      />
    );
    const elements = screen.getAllByText('Post Transaction');
    expect(elements.length).toBeGreaterThanOrEqual(1);
  });

  it('shows posting description with transaction name', () => {
    render(
      <PostTransactionDialog
        isOpen={true} scheduledTransaction={scheduledTransaction}
        categories={categories} accounts={accounts} onClose={vi.fn()} onPosted={vi.fn()}
      />
    );
    expect(screen.getByText(/Netflix/)).toBeInTheDocument();
  });

  it('renders transaction date and amount fields', () => {
    render(
      <PostTransactionDialog
        isOpen={true} scheduledTransaction={scheduledTransaction}
        categories={categories} accounts={accounts} onClose={vi.fn()} onPosted={vi.fn()}
      />
    );
    expect(screen.getByText('Transaction Date')).toBeInTheDocument();
    expect(screen.getByText('Amount')).toBeInTheDocument();
  });

  it('renders Post Transaction button', () => {
    render(
      <PostTransactionDialog
        isOpen={true} scheduledTransaction={scheduledTransaction}
        categories={categories} accounts={accounts} onClose={vi.fn()} onPosted={vi.fn()}
      />
    );
    const buttons = screen.getAllByText('Post Transaction');
    // Title and button
    expect(buttons.length).toBeGreaterThanOrEqual(2);
  });
});
