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

// jsdom does not implement scrollIntoView
Element.prototype.scrollIntoView = vi.fn();

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
    { id: 'cat-3', name: 'Salary', parentId: null, isIncome: true },
  ] as any[];

  const mockAccounts = [
    { id: 'acc-1', name: 'Chequing', isClosed: false, accountSubType: null },
    { id: 'acc-2', name: 'Savings', isClosed: false, accountSubType: null },
    { id: 'acc-3', name: 'Investment', isClosed: false, accountSubType: 'INVESTMENT_BROKERAGE' },
    { id: 'acc-4', name: 'Closed Account', isClosed: true, accountSubType: null },
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

  it('distributes evenly across 3 splits with remainder on last split', () => {
    const splits: SplitRow[] = [
      createSplitRow({ id: 'split-1', amount: 0 }),
      createSplitRow({ id: 'split-2', amount: 0 }),
      createSplitRow({ id: 'split-3', amount: 0 }),
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
    expect(newSplits).toHaveLength(3);
    // -100 / 3 = -33.33 each, last gets remainder
    expect(newSplits[0].amount).toBe(-33.33);
    expect(newSplits[1].amount).toBe(-33.33);
    // Last split absorbs remainder: -100 - (-33.33 * 2) = -33.34
    expect(newSplits[2].amount).toBe(-33.34);
  });

  it('removes a split when more than 2 exist', () => {
    const splits: SplitRow[] = [
      createSplitRow({ id: 'split-1', amount: -30 }),
      createSplitRow({ id: 'split-2', amount: -20 }),
      createSplitRow({ id: 'split-3', amount: -10 }),
    ];

    render(
      <SplitEditor
        splits={splits}
        onChange={mockOnChange}
        categories={mockCategories}
        transactionAmount={-60}
      />
    );

    // When 3 splits exist, remove buttons should have "Remove split" title
    const removeButtons = screen.getAllByTitle('Remove split');
    expect(removeButtons.length).toBeGreaterThan(0);

    // Click the first remove button
    fireEvent.click(removeButtons[0]);

    expect(mockOnChange).toHaveBeenCalledTimes(1);
    const newSplits = mockOnChange.mock.calls[0][0];
    expect(newSplits).toHaveLength(2);
  });

  it('new split is pre-filled with remaining amount', () => {
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

    const addSplitButtons = screen.getAllByText('Add Split');
    fireEvent.click(addSplitButtons[0]);

    expect(mockOnChange).toHaveBeenCalledTimes(1);
    const newSplits = mockOnChange.mock.calls[0][0];
    expect(newSplits).toHaveLength(3);
    // Remaining is -50 - (-40) = -10
    expect(newSplits[2].amount).toBe(-10);
  });

  it('distributes proportionally based on current amounts', () => {
    // Transaction is -100, splits total -80, remaining is -20
    const splits: SplitRow[] = [
      createSplitRow({ id: 'split-1', amount: -60 }),
      createSplitRow({ id: 'split-2', amount: -20 }),
    ];

    render(
      <SplitEditor
        splits={splits}
        onChange={mockOnChange}
        categories={mockCategories}
        transactionAmount={-100}
      />
    );

    fireEvent.click(screen.getByText('Distribute Proportionally'));

    expect(mockOnChange).toHaveBeenCalledTimes(1);
    const newSplits = mockOnChange.mock.calls[0][0];
    expect(newSplits).toHaveLength(2);
    // Proportional: split-1 has 60/80=0.75, split-2 has 20/80=0.25 of remaining (-20)
    // split-1 gets -60 + (-20 * 0.75) = -60 + -15 = -75
    // split-2 gets -20 + remainder (-20 - (-15)) = -20 + (-5) = -25
    expect(newSplits[0].amount).toBe(-75);
    expect(newSplits[1].amount).toBe(-25);
  });

  it('distribute proportionally falls back to equal when all amounts are zero', () => {
    // Transaction is -100, splits total 0, remaining is -100
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

    fireEvent.click(screen.getByText('Distribute Proportionally'));

    expect(mockOnChange).toHaveBeenCalledTimes(1);
    const newSplits = mockOnChange.mock.calls[0][0];
    expect(newSplits).toHaveLength(2);
    // Falls back to equal: each gets -100 / 2 = -50
    expect(newSplits[0].amount).toBe(-50);
    expect(newSplits[1].amount).toBe(-50);
  });

  it('distribute proportionally is disabled when balanced', () => {
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

    const distributeButton = screen.getByText('Distribute Proportionally');
    expect(distributeButton.closest('button')).toBeDisabled();
  });

  it('shows Set total button when unbalanced and onTransactionAmountChange is provided', () => {
    const mockOnAmountChange = vi.fn();
    const splits: SplitRow[] = [
      createSplitRow({ id: 'split-1', amount: -30 }),
      createSplitRow({ id: 'split-2', amount: -20 }),
    ];

    render(
      <SplitEditor
        splits={splits}
        onChange={mockOnChange}
        categories={mockCategories}
        transactionAmount={-100}
        onTransactionAmountChange={mockOnAmountChange}
      />
    );

    // Splits total is -50, transaction amount is -100, so unbalanced
    const setTotalButtons = screen.getAllByText(/Set total to/);
    expect(setTotalButtons.length).toBeGreaterThan(0);
  });

  it('calls onTransactionAmountChange when Set total button is clicked', () => {
    const mockOnAmountChange = vi.fn();
    const splits: SplitRow[] = [
      createSplitRow({ id: 'split-1', amount: -30 }),
      createSplitRow({ id: 'split-2', amount: -20 }),
    ];

    render(
      <SplitEditor
        splits={splits}
        onChange={mockOnChange}
        categories={mockCategories}
        transactionAmount={-100}
        onTransactionAmountChange={mockOnAmountChange}
      />
    );

    const setTotalButtons = screen.getAllByText(/Set total to/);
    fireEvent.click(setTotalButtons[0]);

    expect(mockOnAmountChange).toHaveBeenCalledWith(-50);
  });

  it('does not show Set total button when balanced', () => {
    const mockOnAmountChange = vi.fn();
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
        onTransactionAmountChange={mockOnAmountChange}
      />
    );

    expect(screen.queryByText(/Set total to/)).not.toBeInTheDocument();
  });

  it('does not show Set total button when onTransactionAmountChange is not provided', () => {
    const splits: SplitRow[] = [
      createSplitRow({ id: 'split-1', amount: -30 }),
      createSplitRow({ id: 'split-2', amount: -20 }),
    ];

    render(
      <SplitEditor
        splits={splits}
        onChange={mockOnChange}
        categories={mockCategories}
        transactionAmount={-100}
      />
    );

    expect(screen.queryByText(/Set total to/)).not.toBeInTheDocument();
  });

  it('shows type selector when accounts and sourceAccountId are provided', () => {
    const splits: SplitRow[] = [
      createSplitRow({ id: 'split-1', amount: -30 }),
      createSplitRow({ id: 'split-2', amount: -20 }),
    ];

    render(
      <SplitEditor
        splits={splits}
        onChange={mockOnChange}
        categories={mockCategories}
        accounts={mockAccounts}
        sourceAccountId="acc-1"
        transactionAmount={-50}
      />
    );

    // Should show Type column header in desktop layout
    expect(screen.getByText('Type')).toBeInTheDocument();
  });

  it('does not show type selector when no accounts provided', () => {
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

    expect(screen.queryByText('Type')).not.toBeInTheDocument();
  });

  it('displays currency total in the footer', () => {
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

    // Total label should be present
    const totalLabels = screen.getAllByText('Total');
    expect(totalLabels.length).toBeGreaterThan(0);
    // The total should show the sum of splits
    const totalValues = screen.getAllByText('$-50.00');
    expect(totalValues.length).toBeGreaterThan(0);
  });

  it('disables all controls when disabled prop is true', () => {
    const splits: SplitRow[] = [
      createSplitRow({ id: 'split-1', amount: -30 }),
      createSplitRow({ id: 'split-2', amount: -20 }),
    ];

    render(
      <SplitEditor
        splits={splits}
        onChange={mockOnChange}
        categories={mockCategories}
        transactionAmount={-100}
        disabled
      />
    );

    // Distribute Evenly should be disabled
    expect(screen.getByText('Distribute Evenly').closest('button')).toBeDisabled();
    // Distribute Proportionally should be disabled
    expect(screen.getByText('Distribute Proportionally').closest('button')).toBeDisabled();
    // Add Split buttons should be disabled
    const addSplitButtons = screen.getAllByText('Add Split');
    addSplitButtons.forEach((btn) => {
      expect(btn.closest('button')).toBeDisabled();
    });
  });

  it('handles add remaining to split button', () => {
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

    // Remaining = -50 - (-40) = -10
    // The add-remaining buttons should be enabled (not the "No unassigned amount" ones)
    const addRemainingButtons = screen.getAllByTitle(/Add remaining to this split/);
    expect(addRemainingButtons.length).toBeGreaterThan(0);

    fireEvent.click(addRemainingButtons[0]);

    expect(mockOnChange).toHaveBeenCalledTimes(1);
    const newSplits = mockOnChange.mock.calls[0][0];
    // First split should have -30 + (-10) = -40
    expect(newSplits[0].amount).toBe(-40);
  });

  it('add remaining buttons disabled when balanced', () => {
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

    const addRemainingButtons = screen.getAllByTitle('No unassigned amount');
    expect(addRemainingButtons.length).toBeGreaterThan(0);
    addRemainingButtons.forEach((btn) => {
      expect(btn).toBeDisabled();
    });
  });

  it('updates memo field for a split', () => {
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

    // Find memo inputs (there are placeholders for Memo and Optional memo from mobile and desktop)
    const memoInputs = screen.getAllByPlaceholderText(/[Mm]emo/);
    expect(memoInputs.length).toBeGreaterThan(0);

    fireEvent.change(memoInputs[0], { target: { value: 'Test memo' } });

    expect(mockOnChange).toHaveBeenCalledTimes(1);
    const newSplits = mockOnChange.mock.calls[0][0];
    expect(newSplits[0].memo).toBe('Test memo');
  });

  it('displays remaining amount in desktop footer when unbalanced', () => {
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

    // Desktop shows "Need $-50.00 (remaining: $-10.00)"
    expect(screen.getByText(/remaining: \$-10.00/)).toBeInTheDocument();
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

  it('creates splits with undefined categoryId and transferAccountId', () => {
    const splits = createEmptySplits(-100);
    expect(splits[0].categoryId).toBeUndefined();
    expect(splits[0].transferAccountId).toBeUndefined();
    expect(splits[1].categoryId).toBeUndefined();
    expect(splits[1].transferAccountId).toBeUndefined();
  });

  it('creates splits with temporary IDs', () => {
    const splits = createEmptySplits(-100);
    expect(splits[0].id).toMatch(/^temp-/);
    expect(splits[1].id).toMatch(/^temp-/);
    // IDs should be different
    expect(splits[0].id).not.toBe(splits[1].id);
  });

  it('handles zero amount', () => {
    const splits = createEmptySplits(0);
    expect(splits[0].amount).toBe(0);
    expect(splits[1].amount).toBe(0);
  });

  it('handles positive amount', () => {
    const splits = createEmptySplits(100);
    expect(splits[0].amount).toBe(50);
    expect(splits[1].amount).toBe(50);
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

  it('generates temp IDs when no id provided', () => {
    const apiSplits = [
      { categoryId: 'cat-1', transferAccountId: null, amount: -30, memo: null },
    ];

    const rows = toSplitRows(apiSplits);
    expect(rows[0].id).toMatch(/^temp-/);
  });

  it('converts null categoryId to undefined', () => {
    const apiSplits = [
      { id: 'split-1', categoryId: null, transferAccountId: null, amount: -30, memo: null },
    ];

    const rows = toSplitRows(apiSplits);
    expect(rows[0].categoryId).toBeUndefined();
  });

  it('converts null transferAccountId to undefined', () => {
    const apiSplits = [
      { id: 'split-1', categoryId: 'cat-1', transferAccountId: null, amount: -30, memo: null },
    ];

    const rows = toSplitRows(apiSplits);
    expect(rows[0].transferAccountId).toBeUndefined();
  });

  it('converts amount to number', () => {
    const apiSplits = [
      { id: 'split-1', categoryId: 'cat-1', transferAccountId: null, amount: -30.5 as any, memo: null },
    ];

    const rows = toSplitRows(apiSplits);
    expect(typeof rows[0].amount).toBe('number');
    expect(rows[0].amount).toBe(-30.5);
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

  it('preserves non-empty memo', () => {
    const rows: SplitRow[] = [
      { id: 'temp-123', splitType: 'category', categoryId: 'cat-1', transferAccountId: undefined, amount: -30, memo: 'Test note' },
    ];

    const data = toCreateSplitData(rows);
    expect(data[0].memo).toBe('Test note');
  });

  it('preserves amount values', () => {
    const rows: SplitRow[] = [
      { id: 'temp-123', splitType: 'category', categoryId: 'cat-1', transferAccountId: undefined, amount: -30.55, memo: '' },
    ];

    const data = toCreateSplitData(rows);
    expect(data[0].amount).toBe(-30.55);
  });

  it('handles mixed category and transfer splits', () => {
    const rows: SplitRow[] = [
      { id: 'temp-1', splitType: 'category', categoryId: 'cat-1', transferAccountId: undefined, amount: -30, memo: '' },
      { id: 'temp-2', splitType: 'transfer', categoryId: undefined, transferAccountId: 'acc-2', amount: -20, memo: 'Transfer' },
    ];

    const data = toCreateSplitData(rows);

    expect(data[0].categoryId).toBe('cat-1');
    expect(data[0].transferAccountId).toBeUndefined();
    expect(data[1].categoryId).toBeUndefined();
    expect(data[1].transferAccountId).toBe('acc-2');
    expect(data[1].memo).toBe('Transfer');
  });
});
