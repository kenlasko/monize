import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@/test/render';
import { OverrideEditorDialog } from './OverrideEditorDialog';

vi.mock('@/lib/scheduled-transactions', () => ({
  scheduledTransactionsApi: {
    createOverride: vi.fn().mockResolvedValue({}),
    updateOverride: vi.fn().mockResolvedValue({}),
    deleteOverride: vi.fn().mockResolvedValue({}),
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

describe('OverrideEditorDialog', () => {
  const scheduledTransaction = {
    id: 's1', name: 'Rent', amount: -1500, currencyCode: 'CAD',
    accountId: 'a1', categoryId: 'c1', description: 'Monthly rent',
    isTransfer: false, isSplit: false,
  } as any;

  const categories = [{ id: 'c1', name: 'Housing', parentId: null }] as any[];
  const accounts = [{ id: 'a1', name: 'Checking' }] as any[];

  it('renders dialog title', () => {
    render(
      <OverrideEditorDialog
        isOpen={true} scheduledTransaction={scheduledTransaction} overrideDate="2025-03-01"
        categories={categories} accounts={accounts} onClose={vi.fn()} onSave={vi.fn()}
      />
    );
    expect(screen.getByText('Edit Occurrence')).toBeInTheDocument();
    expect(screen.getByText(/Rent/)).toBeInTheDocument();
  });

  it('shows Save Override button for new override', () => {
    render(
      <OverrideEditorDialog
        isOpen={true} scheduledTransaction={scheduledTransaction} overrideDate="2025-03-01"
        categories={categories} accounts={accounts} onClose={vi.fn()} onSave={vi.fn()}
      />
    );
    expect(screen.getByText('Save Override')).toBeInTheDocument();
  });

  it('shows Update Override button for existing override', () => {
    const existingOverride = { id: 'o1', originalDate: '2025-03-01', overrideDate: '2025-03-01', amount: -1600 } as any;
    render(
      <OverrideEditorDialog
        isOpen={true} scheduledTransaction={scheduledTransaction} overrideDate="2025-03-01"
        categories={categories} accounts={accounts} existingOverride={existingOverride}
        onClose={vi.fn()} onSave={vi.fn()}
      />
    );
    expect(screen.getByText('Update Override')).toBeInTheDocument();
    expect(screen.getByText('Reset to Default')).toBeInTheDocument();
  });

  it('shows occurrence date and amount fields', () => {
    render(
      <OverrideEditorDialog
        isOpen={true} scheduledTransaction={scheduledTransaction} overrideDate="2025-03-01"
        categories={categories} accounts={accounts} onClose={vi.fn()} onSave={vi.fn()}
      />
    );
    expect(screen.getByText('Occurrence Date')).toBeInTheDocument();
    expect(screen.getByText('Amount')).toBeInTheDocument();
  });
});
