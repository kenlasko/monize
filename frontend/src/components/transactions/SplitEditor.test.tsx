import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@/test/render';
import { SplitEditor, SplitRow, createEmptySplits, toSplitRows, toCreateSplitData } from './SplitEditor';

vi.mock('@/lib/format', () => ({
  getCurrencySymbol: () => '$',
  roundToCents: (v: number) => Math.round(v * 100) / 100,
  formatAmount: (v: number | undefined | null) => (v === undefined || v === null || isNaN(v)) ? '' : (Math.round(v * 100) / 100).toFixed(2),
  formatAmountWithCommas: (v: number | undefined | null) => (v === undefined || v === null || isNaN(v)) ? '' : (Math.round(v * 100) / 100).toFixed(2),
  parseAmount: (input: string) => { const n = parseFloat(input.replace(/[^0-9.-]/g, '')); return isNaN(n) ? undefined : Math.round(n * 100) / 100; },
  filterCurrencyInput: (input: string) => input.replace(/[^0-9.-]/g, ''),
  filterCalculatorInput: (input: string) => input.replace(/[^0-9.+\-*/() ]/g, ''),
  hasCalculatorOperators: (input: string) => /[+*/()]/.test(input.replace(/^-/, '')) || /(?!^)-/.test(input),
  evaluateExpression: (input: string) => { try { const r = new Function(`"use strict"; return (${input})`)(); return typeof r === 'number' && isFinite(r) ? Math.round(r * 100) / 100 : undefined; } catch { return undefined; } },
  formatCurrency: (amount: number) => `$${amount.toFixed(2)}`,
}));

vi.mock('@/lib/categoryUtils', () => ({
  buildCategoryTree: (cats: any[]) => cats.map((c: any) => ({ category: c, children: [] })),
}));

function createSplitRow(overrides: Partial<SplitRow> = {}): SplitRow {
  return {
    id: `temp-${Date.now()}-${Math.random()}`,
    splitType: 'category',
    categoryId: undefined,
    transferAccountId: undefined,
    amount: 0,
    memo: '',
    ...overrides,
  };
}

describe('SplitEditor', () => {
  const mockOnChange = vi.fn();
  const mockCategories = [
    { id: 'cat-1', name: 'Groceries', parentId: null, isIncome: false },
    { id: 'cat-2', name: 'Dining', parentId: null, isIncome: false },
  ] as any[];

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders split rows', () => {
    const splits: SplitRow[] = [
      createSplitRow({ id: 'split-1', amount: -30 }),
      createSplitRow({ id: 'split-2', amount: -20 }),
    ];

    render(
      <SplitEditor
        splits={splits}
        onChange={mockOnChange}
        categories={mockCategories}
        transactionAmount={-50}
      />
    );

    expect(screen.getByText('Split Details')).toBeInTheDocument();
    // Should have Add Split button(s) - desktop and mobile versions
    const addSplitButtons = screen.getAllByText('Add Split');
    expect(addSplitButtons.length).toBeGreaterThan(0);
  });

  it('shows balanced indicator when splits sum matches transaction amount', () => {
    const splits: SplitRow[] = [
      createSplitRow({ id: 'split-1', amount: -30 }),
      createSplitRow({ id: 'split-2', amount: -20 }),
    ];

    render(
      <SplitEditor
        splits={splits}
        onChange={mockOnChange}
        categories={mockCategories}
        transactionAmount={-50}
      />
    );

    const balancedTexts = screen.getAllByText('Balanced');
    expect(balancedTexts.length).toBeGreaterThan(0);
  });

  it('shows unbalanced indicator when splits do not sum to transaction amount', () => {
    const splits: SplitRow[] = [
      createSplitRow({ id: 'split-1', amount: -30 }),
      createSplitRow({ id: 'split-2', amount: -10 }),
    ];

    render(
      <SplitEditor
        splits={splits}
        onChange={mockOnChange}
        categories={mockCategories}
        transactionAmount={-50}
      />
    );

    // Should show "Remaining" text since splits (-40) don't match amount (-50)
    const remainingTexts = screen.getAllByText(/Remaining/);
    expect(remainingTexts.length).toBeGreaterThan(0);
  });

  it('calls onChange when Add Split is clicked', () => {
    const splits: SplitRow[] = [
      createSplitRow({ id: 'split-1', amount: -30 }),
      createSplitRow({ id: 'split-2', amount: -20 }),
    ];

    render(
      <SplitEditor
        splits={splits}
        onChange={mockOnChange}
        categories={mockCategories}
        transactionAmount={-50}
      />
    );

    // Click the first "Add Split" button found
    const addSplitButtons = screen.getAllByText('Add Split');
    fireEvent.click(addSplitButtons[0]);

    expect(mockOnChange).toHaveBeenCalledTimes(1);
    // The new splits array should have 3 items
    const newSplits = mockOnChange.mock.calls[0][0];
    expect(newSplits).toHaveLength(3);
  });

  it('does not remove splits when there are only 2 (minimum enforced)', () => {
    const splits: SplitRow[] = [
      createSplitRow({ id: 'split-1', amount: -30 }),
      createSplitRow({ id: 'split-2', amount: -20 }),
    ];

    render(
      <SplitEditor
        splits={splits}
        onChange={mockOnChange}
        categories={mockCategories}
        transactionAmount={-50}
      />
    );

    // Remove buttons should be disabled when only 2 splits
    const removeButtons = screen.getAllByTitle('Minimum 2 splits required');
    expect(removeButtons.length).toBeGreaterThan(0);
    removeButtons.forEach((btn) => {
      expect(btn).toBeDisabled();
    });
  });

  it('renders Distribute Evenly and Distribute Proportionally buttons', () => {
    const splits: SplitRow[] = [
      createSplitRow({ id: 'split-1', amount: -30 }),
      createSplitRow({ id: 'split-2', amount: -20 }),
    ];

    render(
      <SplitEditor
        splits={splits}
        onChange={mockOnChange}
        categories={mockCategories}
        transactionAmount={-50}
      />
    );

    expect(screen.getByText('Distribute Evenly')).toBeInTheDocument();
    expect(screen.getByText('Distribute Proportionally')).toBeInTheDocument();
  });

  it('calls onChange when Distribute Evenly is clicked', () => {
    const splits: SplitRow[] = [
      createSplitRow({ id: 'split-1', amount: 0 }),
      createSplitRow({ id: 'split-2', amount: 0 }),
    ];

    render(
      <SplitEditor
        splits={splits}
        onChange={mockOnChange}
        categories={mockCategories}
        transactionAmount={-100}
      />
    );

    fireEvent.click(screen.getByText('Distribute Evenly'));

    expect(mockOnChange).toHaveBeenCalledTimes(1);
    const newSplits = mockOnChange.mock.calls[0][0];
    expect(newSplits).toHaveLength(2);
    // Each split should be roughly -50
    expect(newSplits[0].amount).toBe(-50);
    expect(newSplits[1].amount).toBe(-50);
  });
});

describe('createEmptySplits', () => {
  it('returns 2 splits', () => {
    const splits = createEmptySplits(-100);
    expect(splits).toHaveLength(2);
  });

  it('splits the amount in half', () => {
    const splits = createEmptySplits(-100);
    expect(splits[0].amount).toBe(-50);
    expect(splits[1].amount).toBe(-50);
  });

  it('handles odd amounts correctly', () => {
    const splits = createEmptySplits(-99.99);
    // The two halves should sum to -99.99
    const total = splits[0].amount + splits[1].amount;
    expect(Math.round(total * 100) / 100).toBe(-99.99);
  });

  it('creates splits with category splitType by default', () => {
    const splits = createEmptySplits(-100);
    expect(splits[0].splitType).toBe('category');
    expect(splits[1].splitType).toBe('category');
  });

  it('creates splits with empty memo', () => {
    const splits = createEmptySplits(-100);
    expect(splits[0].memo).toBe('');
    expect(splits[1].memo).toBe('');
  });
});

describe('toSplitRows', () => {
  it('converts API format to SplitRow format', () => {
    const apiSplits = [
      { id: 'split-1', categoryId: 'cat-1', transferAccountId: null, amount: -30, memo: 'Food' },
      { id: 'split-2', categoryId: 'cat-2', transferAccountId: null, amount: -20, memo: null },
    ];

    const rows = toSplitRows(apiSplits);

    expect(rows).toHaveLength(2);
    expect(rows[0].id).toBe('split-1');
    expect(rows[0].categoryId).toBe('cat-1');
    expect(rows[0].splitType).toBe('category');
    expect(rows[0].amount).toBe(-30);
    expect(rows[0].memo).toBe('Food');
  });

  it('sets splitType to transfer when transferAccountId is present', () => {
    const apiSplits = [
      { id: 'split-1', categoryId: null, transferAccountId: 'acc-2', amount: -50, memo: null },
    ];

    const rows = toSplitRows(apiSplits);
    expect(rows[0].splitType).toBe('transfer');
    expect(rows[0].transferAccountId).toBe('acc-2');
  });

  it('converts null memo to empty string', () => {
    const apiSplits = [
      { id: 'split-1', categoryId: 'cat-1', transferAccountId: null, amount: -30, memo: null },
    ];

    const rows = toSplitRows(apiSplits);
    expect(rows[0].memo).toBe('');
  });
});

describe('toCreateSplitData', () => {
  it('removes temp fields (id, splitType)', () => {
    const rows: SplitRow[] = [
      { id: 'temp-123', splitType: 'category', categoryId: 'cat-1', transferAccountId: undefined, amount: -30, memo: 'Food' },
      { id: 'temp-456', splitType: 'category', categoryId: 'cat-2', transferAccountId: undefined, amount: -20, memo: '' },
    ];

    const data = toCreateSplitData(rows);

    expect(data).toHaveLength(2);
    expect(data[0]).not.toHaveProperty('id');
    expect(data[0]).not.toHaveProperty('splitType');
    expect(data[0].categoryId).toBe('cat-1');
    expect(data[0].amount).toBe(-30);
    expect(data[0].memo).toBe('Food');
  });

  it('sets categoryId to undefined for transfer splits', () => {
    const rows: SplitRow[] = [
      { id: 'temp-123', splitType: 'transfer', categoryId: undefined, transferAccountId: 'acc-2', amount: -50, memo: '' },
    ];

    const data = toCreateSplitData(rows);

    expect(data[0].categoryId).toBeUndefined();
    expect(data[0].transferAccountId).toBe('acc-2');
  });

  it('sets transferAccountId to undefined for category splits', () => {
    const rows: SplitRow[] = [
      { id: 'temp-123', splitType: 'category', categoryId: 'cat-1', transferAccountId: undefined, amount: -30, memo: '' },
    ];

    const data = toCreateSplitData(rows);

    expect(data[0].transferAccountId).toBeUndefined();
    expect(data[0].categoryId).toBe('cat-1');
  });

  it('converts empty memo to undefined', () => {
    const rows: SplitRow[] = [
      { id: 'temp-123', splitType: 'category', categoryId: 'cat-1', transferAccountId: undefined, amount: -30, memo: '' },
    ];

    const data = toCreateSplitData(rows);
    expect(data[0].memo).toBeUndefined();
  });
});
