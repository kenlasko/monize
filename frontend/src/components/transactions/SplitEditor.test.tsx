import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@/test/render';
import { SplitEditor, SplitRow, createEmptySplits, toSplitRows, toCreateSplitData } from './SplitEditor';

vi.mock('@/lib/format', () => ({
  getCurrencySymbol: () => '$',
  getDecimalPlacesForCurrency: () => 2,
  roundToCents: (v: number) => Math.round(v * 100) / 100,
  roundToDecimals: (v: number, d: number) => { const f = Math.pow(10, d); return Math.round(v * f) / f; },
  formatAmount: (v: number | undefined | null) => (v === undefined || v === null || isNaN(v)) ? '' : (Math.round(v * 100) / 100).toFixed(2),
  formatAmountWithCommas: (v: number | undefined | null) => (v === undefined || v === null || isNaN(v)) ? '' : (Math.round(v * 100) / 100).toFixed(2),
  parseAmount: (input: string) => { const n = parseFloat(input.replace(/[^0-9.-]/g, '')); return isNaN(n) ? undefined : Math.round(n * 100) / 100; },
  filterCurrencyInput: (input: string) => input.replace(/[^0-9.-]/g, ''),
  filterCalculatorInput: (input: string) => input.replace(/[^0-9.+\-*/() ]/g, ''),
  hasCalculatorOperators: (input: string) => /[+*/()]/.test(input.replace(/^-/, '')) || /(?!^)-/.test(input),
  evaluateExpression: vi.fn().mockImplementation(() => undefined),
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

  it('always shows type selector even when no accounts provided', () => {
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

    // Type column is always shown since supportsTransfers is always true
    expect(screen.getByText('Type')).toBeInTheDocument();
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

  describe('transaction total sign inference from first split category', () => {
    it('flips positive total to negative when expense category is selected on first split', () => {
      const mockOnAmountChange = vi.fn();
      const splits: SplitRow[] = [
        createSplitRow({ id: 'split-1', amount: 50 }),
        createSplitRow({ id: 'split-2', amount: 50 }),
      ];

      render(
        <SplitEditor
          splits={splits}
          onChange={mockOnChange}
          categories={mockCategories}
          transactionAmount={100}
          onTransactionAmountChange={mockOnAmountChange}
        />
      );

      // Open category dropdown on first split and select expense category
      const categoryInputs = screen.getAllByPlaceholderText('Select category...');
      fireEvent.click(categoryInputs[0]);
      fireEvent.click(screen.getByText('Groceries'));

      // Total should be flipped to negative
      expect(mockOnAmountChange).toHaveBeenCalledWith(-100);

      // Splits should be updated
      expect(mockOnChange).toHaveBeenCalled();
      const newSplits = mockOnChange.mock.calls[0][0];
      // First split: expense category → negative
      expect(newSplits[0].amount).toBe(-50);
      // Second split: no category, flipped to match new total sign
      expect(newSplits[1].amount).toBe(-50);
    });

    it('keeps positive total when income category is selected on first split', () => {
      const mockOnAmountChange = vi.fn();
      const splits: SplitRow[] = [
        createSplitRow({ id: 'split-1', amount: 50 }),
        createSplitRow({ id: 'split-2', amount: 50 }),
      ];

      render(
        <SplitEditor
          splits={splits}
          onChange={mockOnChange}
          categories={mockCategories}
          transactionAmount={100}
          onTransactionAmountChange={mockOnAmountChange}
        />
      );

      const categoryInputs = screen.getAllByPlaceholderText('Select category...');
      fireEvent.click(categoryInputs[0]);
      fireEvent.click(screen.getByText('Salary'));

      // Total already positive, income category → no change needed
      expect(mockOnAmountChange).not.toHaveBeenCalled();
    });

    it('flips negative total to positive when income category is selected on first split', () => {
      const mockOnAmountChange = vi.fn();
      const splits: SplitRow[] = [
        createSplitRow({ id: 'split-1', amount: -50 }),
        createSplitRow({ id: 'split-2', amount: -50 }),
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

      const categoryInputs = screen.getAllByPlaceholderText('Select category...');
      fireEvent.click(categoryInputs[0]);
      fireEvent.click(screen.getByText('Salary'));

      // Total should be flipped to positive (income)
      expect(mockOnAmountChange).toHaveBeenCalledWith(100);

      const newSplits = mockOnChange.mock.calls[0][0];
      // First split: income → positive
      expect(newSplits[0].amount).toBe(50);
      // Second split: no category, flipped to match
      expect(newSplits[1].amount).toBe(50);
    });

    it('does not flip total when category is set on non-first split', () => {
      const mockOnAmountChange = vi.fn();
      const splits: SplitRow[] = [
        createSplitRow({ id: 'split-1', amount: 50 }),
        createSplitRow({ id: 'split-2', amount: 50 }),
      ];

      render(
        <SplitEditor
          splits={splits}
          onChange={mockOnChange}
          categories={mockCategories}
          transactionAmount={100}
          onTransactionAmountChange={mockOnAmountChange}
        />
      );

      // Select category on second split (index 1 in mobile layout)
      const categoryInputs = screen.getAllByPlaceholderText('Select category...');
      fireEvent.click(categoryInputs[1]);
      fireEvent.click(screen.getByText('Groceries'));

      // Total should NOT be flipped (only first split triggers this)
      expect(mockOnAmountChange).not.toHaveBeenCalled();
    });

    it('does not flip total when sign already matches category type', () => {
      const mockOnAmountChange = vi.fn();
      const splits: SplitRow[] = [
        createSplitRow({ id: 'split-1', amount: -50 }),
        createSplitRow({ id: 'split-2', amount: -50 }),
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

      const categoryInputs = screen.getAllByPlaceholderText('Select category...');
      fireEvent.click(categoryInputs[0]);
      fireEvent.click(screen.getByText('Groceries'));

      // Total is already negative, expense category → no change needed
      expect(mockOnAmountChange).not.toHaveBeenCalled();
    });

    it('only flips uncategorized splits when total sign changes', () => {
      const mockOnAmountChange = vi.fn();
      const splits: SplitRow[] = [
        createSplitRow({ id: 'split-1', amount: 50 }),
        createSplitRow({ id: 'split-2', amount: 50, categoryId: 'cat-2' }),
      ];

      render(
        <SplitEditor
          splits={splits}
          onChange={mockOnChange}
          categories={mockCategories}
          transactionAmount={100}
          onTransactionAmountChange={mockOnAmountChange}
        />
      );

      const categoryInputs = screen.getAllByPlaceholderText('Select category...');
      fireEvent.click(categoryInputs[0]);
      fireEvent.click(screen.getByText('Groceries'));

      expect(mockOnAmountChange).toHaveBeenCalledWith(-100);

      const newSplits = mockOnChange.mock.calls[0][0];
      // First split: expense → negative
      expect(newSplits[0].amount).toBe(-50);
      // Second split: already has category, should NOT be flipped
      expect(newSplits[1].amount).toBe(50);
    });

    it('respects explicit sign override on split amount after auto-sign', () => {
      const splits: SplitRow[] = [
        createSplitRow({ id: 'split-1', categoryId: 'cat-1', amount: -50 }),
        createSplitRow({ id: 'split-2', amount: -50 }),
      ];

      render(
        <SplitEditor
          splits={splits}
          onChange={mockOnChange}
          categories={mockCategories}
          transactionAmount={-100}
        />
      );

      // Find the amount input for the first split (showing -50.00)
      const amountInputs = screen.getAllByDisplayValue('-50.00');
      // Change to positive 50 (explicit sign change — same absolute value)
      fireEvent.change(amountInputs[0], { target: { value: '50.00' } });

      // The onChange should be called with the explicit sign override respected
      expect(mockOnChange).toHaveBeenCalled();
      const newSplits = mockOnChange.mock.calls[0][0];
      // User explicitly changed from -50 to 50, should be respected even though category is expense
      expect(newSplits[0].amount).toBe(50);
    });

    it('still auto-adjusts sign on split amount when value magnitude changes', () => {
      const splits: SplitRow[] = [
        createSplitRow({ id: 'split-1', categoryId: 'cat-1', amount: -50 }),
        createSplitRow({ id: 'split-2', amount: -50 }),
      ];

      render(
        <SplitEditor
          splits={splits}
          onChange={mockOnChange}
          categories={mockCategories}
          transactionAmount={-100}
        />
      );

      // Find the amount input for the first split and change to a different magnitude
      const amountInputs = screen.getAllByDisplayValue('-50.00');
      fireEvent.change(amountInputs[0], { target: { value: '75' } });

      expect(mockOnChange).toHaveBeenCalled();
      const newSplits = mockOnChange.mock.calls[0][0];
      // Different magnitude: auto-sign should apply (expense → negative)
      expect(newSplits[0].amount).toBe(-75);
    });

    it('does not flip total when onTransactionAmountChange is not provided', () => {
      const splits: SplitRow[] = [
        createSplitRow({ id: 'split-1', amount: 50 }),
        createSplitRow({ id: 'split-2', amount: 50 }),
      ];

      render(
        <SplitEditor
          splits={splits}
          onChange={mockOnChange}
          categories={mockCategories}
          transactionAmount={100}
        />
      );

      const categoryInputs = screen.getAllByPlaceholderText('Select category...');
      fireEvent.click(categoryInputs[0]);
      fireEvent.click(screen.getByText('Groceries'));

      // Split amount adjusted but no total change
      expect(mockOnChange).toHaveBeenCalled();
      const newSplits = mockOnChange.mock.calls[0][0];
      expect(newSplits[0].amount).toBe(-50);
      // Second split NOT flipped (no total change triggered)
      expect(newSplits[1].amount).toBe(50);
    });
  });
});

describe('SplitEditor — convert to regular transaction', () => {
  const mockOnChange = vi.fn();
  const mockOnConvert = vi.fn();
  const mockCategories = [
    { id: 'cat-1', name: 'Groceries', parentId: null, isIncome: false },
    { id: 'cat-2', name: 'Dining', parentId: null, isIncome: false },
  ] as any[];
  const mockAccounts = [
    { id: 'acc-1', name: 'Chequing', isClosed: false, accountSubType: null },
    { id: 'acc-2', name: 'Savings', isClosed: false, accountSubType: null },
  ] as any[];

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('enables the trash buttons at two category splits when onConvertToRegular is provided', () => {
    const splits: SplitRow[] = [
      createSplitRow({ id: 'split-1', categoryId: 'cat-1', amount: -30 }),
      createSplitRow({ id: 'split-2', categoryId: 'cat-2', amount: -20 }),
    ];

    render(
      <SplitEditor
        splits={splits}
        onChange={mockOnChange}
        categories={mockCategories}
        transactionAmount={-50}
        onConvertToRegular={mockOnConvert}
      />
    );

    const removeButtons = screen.getAllByTitle('Remove split and convert to a regular transaction');
    expect(removeButtons.length).toBeGreaterThan(0);
    removeButtons.forEach((btn) => expect(btn).not.toBeDisabled());
  });

  it('keeps the trash buttons disabled at two splits when no onConvertToRegular is provided', () => {
    const splits: SplitRow[] = [
      createSplitRow({ id: 'split-1', categoryId: 'cat-1', amount: -30 }),
      createSplitRow({ id: 'split-2', categoryId: 'cat-2', amount: -20 }),
    ];

    render(
      <SplitEditor
        splits={splits}
        onChange={mockOnChange}
        categories={mockCategories}
        transactionAmount={-50}
      />
    );

    const removeButtons = screen.getAllByTitle('Minimum 2 splits required');
    expect(removeButtons.length).toBeGreaterThan(0);
    removeButtons.forEach((btn) => expect(btn).toBeDisabled());
  });

  it('warns and converts using the remaining split category on confirm', () => {
    const splits: SplitRow[] = [
      createSplitRow({ id: 'split-1', categoryId: 'cat-1', amount: -30 }),
      createSplitRow({ id: 'split-2', categoryId: 'cat-2', amount: -20 }),
    ];

    render(
      <SplitEditor
        splits={splits}
        onChange={mockOnChange}
        categories={mockCategories}
        transactionAmount={-50}
        onConvertToRegular={mockOnConvert}
      />
    );

    // Delete the first split (mobile button is first in the DOM); the remaining
    // split is split-2 (cat-2).
    const removeButtons = screen.getAllByTitle('Remove split and convert to a regular transaction');
    fireEvent.click(removeButtons[0]);

    // Warning dialog is shown and nothing has changed yet.
    expect(screen.getByText('Convert to a regular transaction?')).toBeInTheDocument();
    expect(mockOnConvert).not.toHaveBeenCalled();
    expect(mockOnChange).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Convert' }));

    expect(mockOnConvert).toHaveBeenCalledTimes(1);
    expect(mockOnConvert).toHaveBeenCalledWith('cat-2');
  });

  it('does not convert when the warning is cancelled', () => {
    const splits: SplitRow[] = [
      createSplitRow({ id: 'split-1', categoryId: 'cat-1', amount: -30 }),
      createSplitRow({ id: 'split-2', categoryId: 'cat-2', amount: -20 }),
    ];

    render(
      <SplitEditor
        splits={splits}
        onChange={mockOnChange}
        categories={mockCategories}
        transactionAmount={-50}
        onConvertToRegular={mockOnConvert}
      />
    );

    const removeButtons = screen.getAllByTitle('Remove split and convert to a regular transaction');
    fireEvent.click(removeButtons[0]);

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(mockOnConvert).not.toHaveBeenCalled();
    expect(screen.queryByText('Convert to a regular transaction?')).not.toBeInTheDocument();
  });

  it('only offers conversion when the remaining split is a category split', () => {
    // Removing split-2 (transfer) leaves split-1 (category) -> eligible.
    // Removing split-1 (category) leaves split-2 (transfer) -> not eligible.
    const splits: SplitRow[] = [
      createSplitRow({ id: 'split-1', splitType: 'category', categoryId: 'cat-1', amount: -30 }),
      createSplitRow({ id: 'split-2', splitType: 'transfer', transferAccountId: 'acc-2', amount: -20 }),
    ];

    render(
      <SplitEditor
        splits={splits}
        onChange={mockOnChange}
        categories={mockCategories}
        accounts={mockAccounts}
        sourceAccountId="acc-1"
        transactionAmount={-50}
        onConvertToRegular={mockOnConvert}
      />
    );

    // The category row's remove button is blocked (would leave a transfer).
    const blocked = screen.getAllByTitle('Minimum 2 splits required');
    expect(blocked.length).toBeGreaterThan(0);
    blocked.forEach((btn) => expect(btn).toBeDisabled());

    // The transfer row's remove button is convert-eligible.
    const eligible = screen.getAllByTitle('Remove split and convert to a regular transaction');
    expect(eligible.length).toBeGreaterThan(0);
    eligible.forEach((btn) => expect(btn).not.toBeDisabled());
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

describe('SplitEditor — desktop layout interactions', () => {
  const mockOnChange = vi.fn();
  const mockCategories = [
    { id: 'cat-1', name: 'Groceries', parentId: null, isIncome: false },
    { id: 'cat-2', name: 'Dining', parentId: null, isIncome: false },
    { id: 'cat-3', name: 'Salary', parentId: null, isIncome: true },
  ] as any[];

  const mockAccounts = [
    { id: 'acc-1', name: 'Chequing', isClosed: false, accountSubType: null, isFavourite: false, favouriteSortOrder: 0, currencyCode: 'CAD' },
    { id: 'acc-2', name: 'Savings', isClosed: false, accountSubType: null, isFavourite: false, favouriteSortOrder: 0, currencyCode: 'CAD' },
    { id: 'acc-3', name: 'Investment', isClosed: false, accountSubType: 'INVESTMENT_BROKERAGE', isFavourite: false, favouriteSortOrder: 0, currencyCode: 'CAD' },
    { id: 'acc-4', name: 'Closed Account', isClosed: true, accountSubType: null, isFavourite: false, favouriteSortOrder: 0, currencyCode: 'CAD' },
  ] as any[];

  const mockTags = [
    { id: 'tag-1', name: 'Essential' },
    { id: 'tag-2', name: 'Discretionary' },
  ] as any[];

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('updates memo via desktop "Optional memo" placeholder', () => {
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

    // Target desktop-specific "Optional memo" placeholder
    const desktopMemoInputs = screen.getAllByPlaceholderText('Optional memo');
    expect(desktopMemoInputs.length).toBeGreaterThan(0);
    fireEvent.change(desktopMemoInputs[0], { target: { value: 'Desktop memo' } });

    expect(mockOnChange).toHaveBeenCalledTimes(1);
    const newSplits = mockOnChange.mock.calls[0][0];
    expect(newSplits[0].memo).toBe('Desktop memo');
  });

  it('changes split type to transfer via desktop type selector', () => {
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

    // There are 2 mobile selects + 2 desktop selects for split type — pick the 3rd (first desktop)
    const typeSelects = screen.getAllByDisplayValue('Category');
    // Desktop selects appear after mobile ones in the DOM
    fireEvent.change(typeSelects[typeSelects.length - 2], { target: { value: 'transfer' } });

    expect(mockOnChange).toHaveBeenCalledTimes(1);
    const newSplits = mockOnChange.mock.calls[0][0];
    expect(newSplits[0].splitType).toBe('transfer');
    expect(newSplits[0].categoryId).toBeUndefined();
  });

  it('renders transfer account selector in desktop when splitType is transfer', () => {
    const splits: SplitRow[] = [
      createSplitRow({ id: 'split-1', splitType: 'transfer', transferAccountId: 'acc-2', amount: -30 }),
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

    // Account selectors should be present (one for mobile, one for desktop)
    const accountSelects = screen.getAllByDisplayValue('Savings');
    expect(accountSelects.length).toBeGreaterThan(0);
  });

  it('updates transferAccountId via desktop account selector', () => {
    const splits: SplitRow[] = [
      createSplitRow({ id: 'split-1', splitType: 'transfer', transferAccountId: '', amount: -30 }),
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

    // Get all "Select account..." selects (mobile + desktop)
    const accountSelects = screen.getAllByDisplayValue('Select account...');
    // Fire on the last one (desktop)
    fireEvent.change(accountSelects[accountSelects.length - 1], { target: { value: 'acc-2' } });

    expect(mockOnChange).toHaveBeenCalledTimes(1);
    const newSplits = mockOnChange.mock.calls[0][0];
    expect(newSplits[0].transferAccountId).toBe('acc-2');
  });

  it('clears transferAccountId when empty value selected in desktop account selector', () => {
    const splits: SplitRow[] = [
      createSplitRow({ id: 'split-1', splitType: 'transfer', transferAccountId: 'acc-2', amount: -30 }),
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

    const accountSelects = screen.getAllByDisplayValue('Savings');
    fireEvent.change(accountSelects[accountSelects.length - 1], { target: { value: '' } });

    expect(mockOnChange).toHaveBeenCalledTimes(1);
    const newSplits = mockOnChange.mock.calls[0][0];
    expect(newSplits[0].transferAccountId).toBeUndefined();
  });

  it('renders tags MultiSelect trigger buttons when tags are provided', () => {
    const splits: SplitRow[] = [
      createSplitRow({ id: 'split-1', amount: -30 }),
      createSplitRow({ id: 'split-2', amount: -20 }),
    ];

    render(
      <SplitEditor
        splits={splits}
        onChange={mockOnChange}
        categories={mockCategories}
        tags={mockTags}
        transactionAmount={-50}
      />
    );

    // MultiSelect renders placeholder text inside a button (not an input placeholder)
    // With 2 splits and both mobile + desktop layouts, we get 4 "Tags..." buttons
    const tagButtons = screen.getAllByText('Tags...');
    expect(tagButtons.length).toBeGreaterThan(0);
  });

  it('handles tagIds change from mobile MultiSelect', () => {
    const splits: SplitRow[] = [
      createSplitRow({ id: 'split-1', amount: -30, tagIds: [] }),
      createSplitRow({ id: 'split-2', amount: -20 }),
    ];

    render(
      <SplitEditor
        splits={splits}
        onChange={mockOnChange}
        categories={mockCategories}
        tags={mockTags}
        transactionAmount={-50}
      />
    );

    // MultiSelect renders placeholder as button text, not input placeholder
    const tagButtons = screen.getAllByText('Tags...');
    // Click the first Tags... button (mobile, split-1)
    fireEvent.click(tagButtons[0]);
    const essentialOptions = screen.getAllByText('Essential');
    fireEvent.click(essentialOptions[0]);

    expect(mockOnChange).toHaveBeenCalledTimes(1);
    const newSplits = mockOnChange.mock.calls[0][0];
    expect(newSplits[0].tagIds).toContain('tag-1');
  });

  it('handles tagIds change from desktop MultiSelect', () => {
    const splits: SplitRow[] = [
      createSplitRow({ id: 'split-1', amount: -30, tagIds: [] }),
      createSplitRow({ id: 'split-2', amount: -20 }),
    ];

    render(
      <SplitEditor
        splits={splits}
        onChange={mockOnChange}
        categories={mockCategories}
        tags={mockTags}
        transactionAmount={-50}
      />
    );

    // With 2 splits in both layouts: 4 "Tags..." buttons total
    // Mobile: split-1, split-2 | Desktop: split-1, split-2
    const tagButtons = screen.getAllByText('Tags...');
    // Click the 3rd button (desktop, split-1)
    fireEvent.click(tagButtons[2]);
    const essentialOptions = screen.getAllByText('Essential');
    fireEvent.click(essentialOptions[0]);

    expect(mockOnChange).toHaveBeenCalledTimes(1);
    const newSplits = mockOnChange.mock.calls[0][0];
    expect(newSplits[0].tagIds).toContain('tag-1');
  });

  it('add remaining button in desktop layout adds remaining amount to split', () => {
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
    // Both mobile and desktop add-remaining buttons exist; click the desktop one
    const addRemainingButtons = screen.getAllByTitle(/Add remaining to this split/);
    // Desktop buttons appear after mobile ones
    fireEvent.click(addRemainingButtons[addRemainingButtons.length - 2]);

    expect(mockOnChange).toHaveBeenCalledTimes(1);
    const newSplits = mockOnChange.mock.calls[0][0];
    expect(newSplits[0].amount).toBe(-40);
  });

  it('remove split button in desktop layout removes a split when more than 2 exist', () => {
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

    const removeButtons = screen.getAllByTitle('Remove split');
    // Click the last remove button (desktop)
    fireEvent.click(removeButtons[removeButtons.length - 1]);

    expect(mockOnChange).toHaveBeenCalledTimes(1);
    const newSplits = mockOnChange.mock.calls[0][0];
    expect(newSplits).toHaveLength(2);
  });

  it('includes closed transfer account in accountOptions when it is already selected', () => {
    const splits: SplitRow[] = [
      createSplitRow({ id: 'split-1', splitType: 'transfer', transferAccountId: 'acc-4', amount: -30 }),
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

    // Closed Account should appear in the dropdown since it's already selected
    const closedAccountOptions = screen.getAllByText('Closed Account (Closed)');
    expect(closedAccountOptions.length).toBeGreaterThan(0);
  });

  it('filters out investment accounts from transfer account options', () => {
    const splits: SplitRow[] = [
      createSplitRow({ id: 'split-1', splitType: 'transfer', transferAccountId: '', amount: -30 }),
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

    // Investment account should NOT appear in any dropdown
    expect(screen.queryByText(/Investment/)).not.toBeInTheDocument();
  });

  it('changes split type from transfer to category via desktop selector', () => {
    const splits: SplitRow[] = [
      createSplitRow({ id: 'split-1', splitType: 'transfer', transferAccountId: 'acc-2', amount: -30 }),
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

    const transferSelects = screen.getAllByDisplayValue('Transfer');
    // Change the last one (desktop) back to category
    fireEvent.change(transferSelects[transferSelects.length - 1], { target: { value: 'category' } });

    expect(mockOnChange).toHaveBeenCalledTimes(1);
    const newSplits = mockOnChange.mock.calls[0][0];
    expect(newSplits[0].splitType).toBe('category');
    expect(newSplits[0].transferAccountId).toBeUndefined();
  });
});

describe('SplitEditor — additional branch coverage', () => {
  const mockOnChange = vi.fn();
  const mockCategories = [
    { id: 'cat-1', name: 'Groceries', parentId: null, isIncome: false },
    { id: 'cat-2', name: 'Dining', parentId: null, isIncome: false },
    { id: 'cat-3', name: 'Salary', parentId: null, isIncome: true },
  ] as any[];

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('does not call onTransactionAmountChange when splitsTotal is zero', () => {
    const mockOnAmountChange = vi.fn();
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
        onTransactionAmountChange={mockOnAmountChange}
      />
    );

    // setTotalToSplitsSum should not fire when splitsTotal is 0
    const setTotalButtons = screen.queryAllByText(/Set total to/);
    // Button should NOT appear because splitsTotal is 0
    expect(setTotalButtons).toHaveLength(0);
  });

  it('does not adjust amount when categoryId field is set to falsy value', () => {
    const splits: SplitRow[] = [
      createSplitRow({ id: 'split-1', categoryId: 'cat-1', amount: -50 }),
      createSplitRow({ id: 'split-2', amount: -50 }),
    ];

    render(
      <SplitEditor
        splits={splits}
        onChange={mockOnChange}
        categories={mockCategories}
        transactionAmount={-100}
      />
    );

    // Clear the category (set to undefined) via combobox
    const categoryInputs = screen.getAllByPlaceholderText('Select category...');
    fireEvent.click(categoryInputs[0]);
    // Clear the selection by typing nothing and clicking elsewhere
    fireEvent.change(categoryInputs[0], { target: { value: '' } });

    // onChange may or may not be called depending on combobox implementation
    // But if it is called, the amount should be preserved unchanged
    if (mockOnChange.mock.calls.length > 0) {
      const newSplits = mockOnChange.mock.calls[0][0];
      // Amount should remain -50 since category cleared = no sign enforcement
      expect(newSplits[0].amount).toBe(-50);
    }
  });

  it('does not adjust amount sign when new amount is zero', () => {
    const splits: SplitRow[] = [
      createSplitRow({ id: 'split-1', categoryId: 'cat-1', amount: -50 }),
      createSplitRow({ id: 'split-2', amount: -50 }),
    ];

    render(
      <SplitEditor
        splits={splits}
        onChange={mockOnChange}
        categories={mockCategories}
        transactionAmount={-100}
      />
    );

    // Change amount to 0 — the sign adjustment branch should be skipped
    const amountInputs = screen.getAllByDisplayValue('-50.00');
    fireEvent.change(amountInputs[0], { target: { value: '0' } });

    expect(mockOnChange).toHaveBeenCalledTimes(1);
    const newSplits = mockOnChange.mock.calls[0][0];
    // Zero amount → no sign adjustment applied
    expect(newSplits[0].amount).toBe(0);
  });

  it('does not adjust amount sign when no category is set', () => {
    const splits: SplitRow[] = [
      createSplitRow({ id: 'split-1', amount: -50 }),
      createSplitRow({ id: 'split-2', amount: -50 }),
    ];

    render(
      <SplitEditor
        splits={splits}
        onChange={mockOnChange}
        categories={mockCategories}
        transactionAmount={-100}
      />
    );

    // Change amount — no category means no sign enforcement
    const amountInputs = screen.getAllByDisplayValue('-50.00');
    fireEvent.change(amountInputs[0], { target: { value: '75' } });

    expect(mockOnChange).toHaveBeenCalledTimes(1);
    const newSplits = mockOnChange.mock.calls[0][0];
    expect(newSplits[0].amount).toBe(75);
  });

  it('handles category change when current amount is zero', () => {
    const splits: SplitRow[] = [
      createSplitRow({ id: 'split-1', amount: 0 }),
      createSplitRow({ id: 'split-2', amount: 0 }),
    ];

    render(
      <SplitEditor
        splits={splits}
        onChange={mockOnChange}
        categories={mockCategories}
        transactionAmount={0}
      />
    );

    const categoryInputs = screen.getAllByPlaceholderText('Select category...');
    fireEvent.click(categoryInputs[0]);
    fireEvent.click(screen.getByText('Groceries'));

    expect(mockOnChange).toHaveBeenCalled();
    const newSplits = mockOnChange.mock.calls[0][0];
    // Amount was 0, so no sign adjustment made
    expect(newSplits[0].amount).toBe(0);
  });

  it('distribute proportionally does nothing when balanced (remaining < 0.01)', () => {
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

    // Button is disabled when balanced
    const distributeBtn = screen.getByText('Distribute Proportionally');
    expect(distributeBtn.closest('button')).toBeDisabled();
    fireEvent.click(distributeBtn);

    expect(mockOnChange).not.toHaveBeenCalled();
  });

  it('distribute proportionally handles 3 splits with non-zero amounts', () => {
    // Remaining = -10, split proportions: -60/-90, -20/-90, -10/-90
    const splits: SplitRow[] = [
      createSplitRow({ id: 'split-1', amount: -60 }),
      createSplitRow({ id: 'split-2', amount: -20 }),
      createSplitRow({ id: 'split-3', amount: -10 }),
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
    expect(newSplits).toHaveLength(3);
    // Total of new splits should equal transaction amount
    const total = newSplits.reduce((sum: number, s: SplitRow) => sum + s.amount, 0);
    expect(Math.round(total * 100) / 100).toBe(-100);
  });

  it('distribute proportionally falls back equally for 3 zero-amount splits', () => {
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
        transactionAmount={-99}
      />
    );

    fireEvent.click(screen.getByText('Distribute Proportionally'));

    expect(mockOnChange).toHaveBeenCalledTimes(1);
    const newSplits = mockOnChange.mock.calls[0][0];
    expect(newSplits).toHaveLength(3);
    const total = newSplits.reduce((sum: number, s: SplitRow) => sum + s.amount, 0);
    expect(Math.round(total * 100) / 100).toBe(-99);
  });

  it('shows category combobox for transfer split that falls through to category display', () => {
    // Verify that split with splitType transfer renders account selector, not combobox
    const splits: SplitRow[] = [
      createSplitRow({ id: 'split-1', splitType: 'transfer', amount: -50 }),
      createSplitRow({ id: 'split-2', amount: -50 }),
    ];

    render(
      <SplitEditor
        splits={splits}
        onChange={mockOnChange}
        categories={mockCategories}
        transactionAmount={-100}
      />
    );

    // Should show "Select account..." for transfer split type
    const accountSelects = screen.getAllByDisplayValue('Select account...');
    expect(accountSelects.length).toBeGreaterThan(0);
  });

  it('syncs localSplits when splits prop changes', () => {
    const initialSplits: SplitRow[] = [
      createSplitRow({ id: 'split-1', amount: -30 }),
      createSplitRow({ id: 'split-2', amount: -20 }),
    ];

    const { rerender } = render(
      <SplitEditor
        splits={initialSplits}
        onChange={mockOnChange}
        categories={mockCategories}
        transactionAmount={-50}
      />
    );

    const updatedSplits: SplitRow[] = [
      createSplitRow({ id: 'split-1', amount: -40 }),
      createSplitRow({ id: 'split-2', amount: -10 }),
    ];

    rerender(
      <SplitEditor
        splits={updatedSplits}
        onChange={mockOnChange}
        categories={mockCategories}
        transactionAmount={-50}
      />
    );

    // After rerender, the totals display should reflect updated amounts
    const totalValues = screen.getAllByText('$-50.00');
    expect(totalValues.length).toBeGreaterThan(0);
  });

  it('does not flip uncategorized split with zero amount when total sign changes', () => {
    const mockOnAmountChange = vi.fn();
    const splits: SplitRow[] = [
      createSplitRow({ id: 'split-1', amount: 50 }),
      createSplitRow({ id: 'split-2', amount: 0 }),
    ];

    render(
      <SplitEditor
        splits={splits}
        onChange={mockOnChange}
        categories={mockCategories}
        transactionAmount={50}
        onTransactionAmountChange={mockOnAmountChange}
      />
    );

    const categoryInputs = screen.getAllByPlaceholderText('Select category...');
    fireEvent.click(categoryInputs[0]);
    fireEvent.click(screen.getByText('Groceries'));

    expect(mockOnAmountChange).toHaveBeenCalledWith(-50);
    const newSplits = mockOnChange.mock.calls[0][0];
    // First split gets expense sign (-50)
    expect(newSplits[0].amount).toBe(-50);
    // Second split had amount 0, should NOT be flipped (0 stays 0)
    expect(newSplits[1].amount).toBe(0);
  });
});

describe('toSplitRows — tags branch', () => {
  it('maps tags to tagIds when tags are provided', () => {
    const apiSplits = [
      {
        id: 'split-1',
        categoryId: 'cat-1',
        transferAccountId: null,
        amount: -30,
        memo: 'Food',
        tags: [{ id: 'tag-1' }, { id: 'tag-2' }],
      },
    ];

    const rows = toSplitRows(apiSplits);
    expect(rows[0].tagIds).toEqual(['tag-1', 'tag-2']);
  });

  it('returns empty array for tagIds when tags is undefined', () => {
    const apiSplits = [
      {
        id: 'split-1',
        categoryId: 'cat-1',
        transferAccountId: null,
        amount: -30,
        memo: null,
      },
    ];

    const rows = toSplitRows(apiSplits);
    expect(rows[0].tagIds).toEqual([]);
  });

  it('returns empty array for tagIds when tags is empty array', () => {
    const apiSplits = [
      {
        id: 'split-1',
        categoryId: 'cat-1',
        transferAccountId: null,
        amount: -30,
        memo: null,
        tags: [],
      },
    ];

    const rows = toSplitRows(apiSplits);
    expect(rows[0].tagIds).toEqual([]);
  });
});

describe('toCreateSplitData — tagIds branch', () => {
  it('includes tagIds when present and non-empty', () => {
    const rows: SplitRow[] = [
      { id: 'temp-123', splitType: 'category', categoryId: 'cat-1', transferAccountId: undefined, amount: -30, memo: '', tagIds: ['tag-1', 'tag-2'] },
    ];

    const data = toCreateSplitData(rows);
    expect(data[0].tagIds).toEqual(['tag-1', 'tag-2']);
  });

  it('sets tagIds to undefined when tagIds is empty array', () => {
    const rows: SplitRow[] = [
      { id: 'temp-123', splitType: 'category', categoryId: 'cat-1', transferAccountId: undefined, amount: -30, memo: '', tagIds: [] },
    ];

    const data = toCreateSplitData(rows);
    expect(data[0].tagIds).toBeUndefined();
  });

  it('sets tagIds to undefined when tagIds is not provided', () => {
    const rows: SplitRow[] = [
      { id: 'temp-123', splitType: 'category', categoryId: 'cat-1', transferAccountId: undefined, amount: -30, memo: '' },
    ];

    const data = toCreateSplitData(rows);
    expect(data[0].tagIds).toBeUndefined();
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

describe('SplitEditor — investment kind gating by parent account', () => {
  const baseAccounts = [
    { id: 'acc-cash', name: 'Chequing', isClosed: false, accountSubType: null, isFavourite: false, favouriteSortOrder: 0, currencyCode: 'CAD' },
    { id: 'acc-savings', name: 'Savings', isClosed: false, accountSubType: null, isFavourite: false, favouriteSortOrder: 0, currencyCode: 'CAD' },
  ] as any[];

  const baseSplits = [
    { id: 's1', splitType: 'category', categoryId: undefined, transferAccountId: undefined, amount: -50, memo: '' },
    { id: 's2', splitType: 'category', categoryId: undefined, transferAccountId: undefined, amount: -50, memo: '' },
  ] as any[];

  it('shows the Investment option when parentAccountSubType is INVESTMENT_CASH', () => {
    render(
      <SplitEditor
        splits={baseSplits}
        onChange={vi.fn()}
        categories={[]}
        accounts={baseAccounts}
        sourceAccountId="acc-cash"
        parentAccountSubType="INVESTMENT_CASH"
        transactionAmount={-100}
      />,
    );
    // Both desktop and mobile renderings include the Investment option
    expect(screen.getAllByRole('option', { name: 'Investment' }).length).toBeGreaterThan(0);
  });

  it('omits the Investment option for non-INVESTMENT_CASH parents', () => {
    render(
      <SplitEditor
        splits={baseSplits}
        onChange={vi.fn()}
        categories={[]}
        accounts={baseAccounts}
        sourceAccountId="acc-cash"
        parentAccountSubType={null}
        transactionAmount={-100}
      />,
    );
    expect(screen.queryByRole('option', { name: 'Investment' })).toBeNull();
  });
});

describe('toSplitRows — investment shapes', () => {
  it('hydrates investment fields from a transaction-split investmentTransaction relation', () => {
    const rows = toSplitRows([
      {
        id: 's1',
        amount: -750,
        kind: 'investment',
        categoryId: null,
        transferAccountId: null,
        investmentTransaction: {
          action: 'BUY',
          securityId: 'sec-1',
          quantity: 75,
          price: 10,
          commission: 0,
          exchangeRate: 1,
        },
      },
    ]);
    expect(rows[0].splitType).toBe('investment');
    expect(rows[0].investment).toMatchObject({
      action: 'BUY',
      securityId: 'sec-1',
      quantity: 75,
      price: 10,
      commission: 0,
      exchangeRate: 1,
    });
  });

  it('hydrates investment fields from scheduled-transaction-split denormalized columns', () => {
    const rows = toSplitRows([
      {
        id: 's1',
        amount: -750,
        kind: 'investment',
        categoryId: null,
        transferAccountId: null,
        investmentAction: 'BUY',
        investmentSecurityId: 'sec-1',
        investmentQuantity: 75,
        investmentPrice: 10,
        investmentCommission: 0,
        investmentExchangeRate: 1,
      } as any,
    ]);
    expect(rows[0].splitType).toBe('investment');
    expect(rows[0].investment).toMatchObject({
      action: 'BUY',
      securityId: 'sec-1',
      quantity: 75,
      price: 10,
      commission: 0,
      exchangeRate: 1,
    });
  });

  it('hydrates investment fields from override JSON shape (splitKind + investment object)', () => {
    const rows = toSplitRows([
      {
        amount: -750,
        splitKind: 'investment',
        categoryId: null,
        investment: {
          action: 'SELL',
          securityId: 'sec-1',
          quantity: 5,
          price: 100,
          commission: 1,
          exchangeRate: 1,
        },
      } as any,
    ]);
    expect(rows[0].splitType).toBe('investment');
    expect(rows[0].investment).toMatchObject({
      action: 'SELL',
      quantity: 5,
      price: 100,
      commission: 1,
    });
  });

  it('still classifies plain category and transfer rows correctly', () => {
    const rows = toSplitRows([
      { id: 'c', amount: -10, categoryId: 'cat-1' },
      { id: 't', amount: -20, transferAccountId: 'acc-2' },
    ]);
    expect(rows[0].splitType).toBe('category');
    expect(rows[0].investment).toBeUndefined();
    expect(rows[1].splitType).toBe('transfer');
    expect(rows[1].investment).toBeUndefined();
  });
});
