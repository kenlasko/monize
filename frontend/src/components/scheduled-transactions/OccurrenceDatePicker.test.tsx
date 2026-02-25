import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@/test/render';
import { OccurrenceDatePicker } from './OccurrenceDatePicker';

vi.mock('@/hooks/useDateFormat', () => ({
  useDateFormat: () => ({ formatDate: (d: string) => d }),
}));

vi.mock('@/hooks/useNumberFormat', () => ({
  useNumberFormat: () => ({
    formatCurrency: (amount: number, currency: string) => `${currency} ${amount.toFixed(2)}`,
  }),
}));

vi.mock('@/lib/utils', () => ({
  parseLocalDate: (d: string) => {
    const dateStr = d.includes('T') ? d.split('T')[0] : d;
    return new Date(dateStr + 'T00:00:00');
  },
}));

describe('OccurrenceDatePicker', () => {
  const scheduledTransaction = {
    id: 's1',
    name: 'Rent',
    nextDueDate: '2025-03-01',
    frequency: 'MONTHLY' as const,
    amount: -1200,
    currencyCode: 'USD',
    categoryId: 'cat1',
    description: null,
    isSplit: false,
  } as any;

  const onSelect = vi.fn();
  const onClose = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  // --- Basic rendering ---
  it('renders dialog title and transaction name', () => {
    render(
      <OccurrenceDatePicker isOpen={true} scheduledTransaction={scheduledTransaction} onSelect={onSelect} onClose={onClose} />
    );
    expect(screen.getByText('Select Occurrence Date')).toBeInTheDocument();
    expect(screen.getByText(/Rent/)).toBeInTheDocument();
  });

  it('renders instruction text', () => {
    render(
      <OccurrenceDatePicker isOpen={true} scheduledTransaction={scheduledTransaction} onSelect={onSelect} onClose={onClose} />
    );
    expect(screen.getByText(/Choose which occurrence/)).toBeInTheDocument();
  });

  it('does not render when isOpen is false', () => {
    render(
      <OccurrenceDatePicker isOpen={false} scheduledTransaction={scheduledTransaction} onSelect={onSelect} onClose={onClose} />
    );
    expect(screen.queryByText('Select Occurrence Date')).not.toBeInTheDocument();
  });

  // --- Calculated occurrence dates ---
  it('renders calculated occurrence dates for monthly frequency', () => {
    render(
      <OccurrenceDatePicker isOpen={true} scheduledTransaction={scheduledTransaction} onSelect={onSelect} onClose={onClose} />
    );
    // Should show 5 dates for monthly frequency starting from 2025-03-01
    expect(screen.getByText('2025-03-01')).toBeInTheDocument();
    expect(screen.getByText('2025-04-01')).toBeInTheDocument();
    expect(screen.getByText('2025-05-01')).toBeInTheDocument();
    expect(screen.getByText('2025-06-01')).toBeInTheDocument();
    expect(screen.getByText('2025-07-01')).toBeInTheDocument();
  });

  it('renders dates for weekly frequency', () => {
    const weeklyTransaction = {
      ...scheduledTransaction,
      frequency: 'WEEKLY' as const,
    };
    render(
      <OccurrenceDatePicker isOpen={true} scheduledTransaction={weeklyTransaction} onSelect={onSelect} onClose={onClose} />
    );
    expect(screen.getByText('2025-03-01')).toBeInTheDocument();
    expect(screen.getByText('2025-03-08')).toBeInTheDocument();
    expect(screen.getByText('2025-03-15')).toBeInTheDocument();
    expect(screen.getByText('2025-03-22')).toBeInTheDocument();
    expect(screen.getByText('2025-03-29')).toBeInTheDocument();
  });

  it('renders dates for biweekly frequency', () => {
    const biweeklyTransaction = {
      ...scheduledTransaction,
      frequency: 'BIWEEKLY' as const,
    };
    render(
      <OccurrenceDatePicker isOpen={true} scheduledTransaction={biweeklyTransaction} onSelect={onSelect} onClose={onClose} />
    );
    expect(screen.getByText('2025-03-01')).toBeInTheDocument();
    expect(screen.getByText('2025-03-15')).toBeInTheDocument();
    expect(screen.getByText('2025-03-29')).toBeInTheDocument();
  });

  it('renders dates for daily frequency', () => {
    const dailyTransaction = {
      ...scheduledTransaction,
      frequency: 'DAILY' as const,
    };
    render(
      <OccurrenceDatePicker isOpen={true} scheduledTransaction={dailyTransaction} onSelect={onSelect} onClose={onClose} />
    );
    expect(screen.getByText('2025-03-01')).toBeInTheDocument();
    expect(screen.getByText('2025-03-02')).toBeInTheDocument();
    expect(screen.getByText('2025-03-03')).toBeInTheDocument();
    expect(screen.getByText('2025-03-04')).toBeInTheDocument();
    expect(screen.getByText('2025-03-05')).toBeInTheDocument();
  });

  it('renders dates for quarterly frequency', () => {
    const quarterlyTransaction = {
      ...scheduledTransaction,
      frequency: 'QUARTERLY' as const,
    };
    render(
      <OccurrenceDatePicker isOpen={true} scheduledTransaction={quarterlyTransaction} onSelect={onSelect} onClose={onClose} />
    );
    expect(screen.getByText('2025-03-01')).toBeInTheDocument();
    expect(screen.getByText('2025-06-01')).toBeInTheDocument();
    expect(screen.getByText('2025-09-01')).toBeInTheDocument();
    expect(screen.getByText('2025-12-01')).toBeInTheDocument();
    expect(screen.getByText('2026-03-01')).toBeInTheDocument();
  });

  it('renders dates for yearly frequency', () => {
    const yearlyTransaction = {
      ...scheduledTransaction,
      frequency: 'YEARLY' as const,
    };
    render(
      <OccurrenceDatePicker isOpen={true} scheduledTransaction={yearlyTransaction} onSelect={onSelect} onClose={onClose} />
    );
    expect(screen.getByText('2025-03-01')).toBeInTheDocument();
    expect(screen.getByText('2026-03-01')).toBeInTheDocument();
    expect(screen.getByText('2027-03-01')).toBeInTheDocument();
    expect(screen.getByText('2028-03-01')).toBeInTheDocument();
    expect(screen.getByText('2029-03-01')).toBeInTheDocument();
  });

  it('renders only one date for ONCE frequency', () => {
    const onceTransaction = {
      ...scheduledTransaction,
      frequency: 'ONCE' as const,
    };
    render(
      <OccurrenceDatePicker isOpen={true} scheduledTransaction={onceTransaction} onSelect={onSelect} onClose={onClose} />
    );
    expect(screen.getByText('2025-03-01')).toBeInTheDocument();
    // Should only have one date button
    const buttons = screen.getAllByRole('button');
    // Cancel button + the one date button = 2 + X close button
    const dateButtons = buttons.filter(b => b.textContent?.includes('2025'));
    expect(dateButtons.length).toBe(1);
  });

  // --- Date selection ---
  it('calls onSelect when a date is clicked', () => {
    render(
      <OccurrenceDatePicker isOpen={true} scheduledTransaction={scheduledTransaction} onSelect={onSelect} onClose={onClose} />
    );
    fireEvent.click(screen.getByText('2025-03-01'));
    expect(onSelect).toHaveBeenCalledWith('2025-03-01');
  });

  it('calls onSelect with the correct date for non-first date', () => {
    render(
      <OccurrenceDatePicker isOpen={true} scheduledTransaction={scheduledTransaction} onSelect={onSelect} onClose={onClose} />
    );
    fireEvent.click(screen.getByText('2025-05-01'));
    expect(onSelect).toHaveBeenCalledWith('2025-05-01');
  });

  // --- Cancel button ---
  it('renders Cancel button', () => {
    render(
      <OccurrenceDatePicker isOpen={true} scheduledTransaction={scheduledTransaction} onSelect={onSelect} onClose={onClose} />
    );
    expect(screen.getByText('Cancel')).toBeInTheDocument();
  });

  it('calls onClose when Cancel button is clicked', () => {
    render(
      <OccurrenceDatePicker isOpen={true} scheduledTransaction={scheduledTransaction} onSelect={onSelect} onClose={onClose} />
    );
    fireEvent.click(screen.getByText('Cancel'));
    expect(onClose).toHaveBeenCalled();
  });

  // --- Override dates ---
  const makeOverride = (original: string, override: string) => ({
    id: `o-${original}`, scheduledTransactionId: 's1',
    originalDate: original, overrideDate: override,
    amount: null, categoryId: null, category: null,
    description: null, isSplit: null, splits: null,
    createdAt: '', updatedAt: '',
  });

  it('marks overridden dates as modified', () => {
    const overrides = [makeOverride('2025-03-01', '2025-03-05')];
    render(
      <OccurrenceDatePicker isOpen={true} scheduledTransaction={scheduledTransaction} overrides={overrides} onSelect={onSelect} onClose={onClose} />
    );
    expect(screen.getByText('Modified')).toBeInTheDocument();
  });

  it('shows override date instead of original calculated date', () => {
    const overrides = [makeOverride('2025-03-01', '2025-03-05')];
    render(
      <OccurrenceDatePicker isOpen={true} scheduledTransaction={scheduledTransaction} overrides={overrides} onSelect={onSelect} onClose={onClose} />
    );
    // Override date should be shown
    expect(screen.getByText('2025-03-05')).toBeInTheDocument();
    // Original calculated date should be replaced (not shown as a separate button)
    // But the next dates should still be present
    expect(screen.getByText('2025-04-01')).toBeInTheDocument();
  });

  it('handles multiple overrides', () => {
    const overrides = [
      makeOverride('2025-03-01', '2025-03-05'),
      makeOverride('2025-04-01', '2025-04-10'),
    ];
    render(
      <OccurrenceDatePicker isOpen={true} scheduledTransaction={scheduledTransaction} overrides={overrides} onSelect={onSelect} onClose={onClose} />
    );
    const modifiedBadges = screen.getAllByText('Modified');
    expect(modifiedBadges.length).toBe(2);
    expect(screen.getByText('2025-03-05')).toBeInTheDocument();
    expect(screen.getByText('2025-04-10')).toBeInTheDocument();
  });

  it('calls onSelect with override date when override date button is clicked', () => {
    const overrides = [makeOverride('2025-03-01', '2025-03-05')];
    render(
      <OccurrenceDatePicker isOpen={true} scheduledTransaction={scheduledTransaction} overrides={overrides} onSelect={onSelect} onClose={onClose} />
    );
    fireEvent.click(screen.getByText('2025-03-05'));
    expect(onSelect).toHaveBeenCalledWith('2025-03-05');
  });

  // --- Next Due badge ---
  it('shows Next Due badge on the first occurrence date', () => {
    render(
      <OccurrenceDatePicker isOpen={true} scheduledTransaction={scheduledTransaction} onSelect={onSelect} onClose={onClose} />
    );
    expect(screen.getByText('Next Due')).toBeInTheDocument();
  });

  it('does not show Next Due badge on non-first occurrence dates', () => {
    render(
      <OccurrenceDatePicker isOpen={true} scheduledTransaction={scheduledTransaction} onSelect={onSelect} onClose={onClose} />
    );
    // Only one Next Due badge should be present
    const badges = screen.getAllByText('Next Due');
    expect(badges.length).toBe(1);
  });

  // --- Close button (X) ---
  it('calls onClose when X button is clicked', () => {
    render(
      <OccurrenceDatePicker isOpen={true} scheduledTransaction={scheduledTransaction} onSelect={onSelect} onClose={onClose} />
    );
    const closeButtons = screen.getAllByRole('button');
    const xButton = closeButtons.find(b => b.querySelector('svg path[d*="M6 18L18 6"]'));
    if (xButton) {
      fireEvent.click(xButton);
      expect(onClose).toHaveBeenCalled();
    }
  });

  // --- Semimonthly frequency ---
  it('renders dates for semimonthly frequency', () => {
    const semimonthlyTransaction = {
      ...scheduledTransaction,
      nextDueDate: '2025-03-15',
      frequency: 'SEMIMONTHLY' as const,
    };
    render(
      <OccurrenceDatePicker isOpen={true} scheduledTransaction={semimonthlyTransaction} onSelect={onSelect} onClose={onClose} />
    );
    // Semimonthly from the 15th goes to end of month, then 15th of next month, etc.
    expect(screen.getByText('2025-03-15')).toBeInTheDocument();
    expect(screen.getByText('2025-03-31')).toBeInTheDocument();
    expect(screen.getByText('2025-04-15')).toBeInTheDocument();
  });

  // --- Empty overrides array ---
  it('renders correctly with empty overrides array', () => {
    render(
      <OccurrenceDatePicker isOpen={true} scheduledTransaction={scheduledTransaction} overrides={[]} onSelect={onSelect} onClose={onClose} />
    );
    expect(screen.getByText('2025-03-01')).toBeInTheDocument();
    expect(screen.queryByText('Modified')).not.toBeInTheDocument();
  });

  // --- No overrides prop ---
  it('renders correctly without overrides prop', () => {
    render(
      <OccurrenceDatePicker isOpen={true} scheduledTransaction={scheduledTransaction} onSelect={onSelect} onClose={onClose} />
    );
    expect(screen.getByText('2025-03-01')).toBeInTheDocument();
    expect(screen.queryByText('Modified')).not.toBeInTheDocument();
  });

  // --- Next due date with T suffix ---
  it('handles nextDueDate with T00:00:00Z suffix', () => {
    const transactionWithTSuffix = {
      ...scheduledTransaction,
      nextDueDate: '2025-03-01T00:00:00Z',
    };
    render(
      <OccurrenceDatePicker isOpen={true} scheduledTransaction={transactionWithTSuffix} onSelect={onSelect} onClose={onClose} />
    );
    // The component splits on 'T' to get the date part for nextDueDate badge
    expect(screen.getByText('Next Due')).toBeInTheDocument();
  });

  // --- Modification details ---
  it('shows date moved detail when override changes the date', () => {
    const overrides = [{
      id: 'o1', scheduledTransactionId: 's1',
      originalDate: '2025-03-01', overrideDate: '2025-03-05',
      amount: null, categoryId: null, category: null,
      description: null, isSplit: null, splits: null,
      createdAt: '', updatedAt: '',
    }];
    render(
      <OccurrenceDatePicker isOpen={true} scheduledTransaction={scheduledTransaction} overrides={overrides} onSelect={onSelect} onClose={onClose} />
    );
    expect(screen.getByText('Date moved from 2025-03-01')).toBeInTheDocument();
  });

  it('shows overridden amount when different from base', () => {
    const overrides = [{
      id: 'o1', scheduledTransactionId: 's1',
      originalDate: '2025-03-01', overrideDate: '2025-03-01',
      amount: -75.50, categoryId: null, category: null,
      description: null, isSplit: null, splits: null,
      createdAt: '', updatedAt: '',
    }];
    render(
      <OccurrenceDatePicker isOpen={true} scheduledTransaction={scheduledTransaction} overrides={overrides} onSelect={onSelect} onClose={onClose} />
    );
    expect(screen.getByText('Amount: USD 75.50')).toBeInTheDocument();
  });

  it('does not show amount when override amount matches base', () => {
    const overrides = [{
      id: 'o1', scheduledTransactionId: 's1',
      originalDate: '2025-03-01', overrideDate: '2025-03-05',
      amount: -1200, categoryId: null, category: null,
      description: null, isSplit: null, splits: null,
      createdAt: '', updatedAt: '',
    }];
    render(
      <OccurrenceDatePicker isOpen={true} scheduledTransaction={scheduledTransaction} overrides={overrides} onSelect={onSelect} onClose={onClose} />
    );
    expect(screen.getByText('Date moved from 2025-03-01')).toBeInTheDocument();
    expect(screen.queryByText(/Amount:/)).not.toBeInTheDocument();
  });

  it('shows overridden category when different from base', () => {
    const overrides = [{
      id: 'o1', scheduledTransactionId: 's1',
      originalDate: '2025-03-01', overrideDate: '2025-03-01',
      amount: null, categoryId: 'c2', category: { id: 'c2', name: 'Utilities' } as any,
      description: null, isSplit: null, splits: null,
      createdAt: '', updatedAt: '',
    }];
    render(
      <OccurrenceDatePicker isOpen={true} scheduledTransaction={scheduledTransaction} overrides={overrides} onSelect={onSelect} onClose={onClose} />
    );
    expect(screen.getByText('Category: Utilities')).toBeInTheDocument();
  });

  it('does not show category when override category matches base', () => {
    const overrides = [{
      id: 'o1', scheduledTransactionId: 's1',
      originalDate: '2025-03-01', overrideDate: '2025-03-05',
      amount: null, categoryId: 'cat1', category: { id: 'cat1', name: 'Rent' } as any,
      description: null, isSplit: null, splits: null,
      createdAt: '', updatedAt: '',
    }];
    render(
      <OccurrenceDatePicker isOpen={true} scheduledTransaction={scheduledTransaction} overrides={overrides} onSelect={onSelect} onClose={onClose} />
    );
    expect(screen.getByText('Date moved from 2025-03-01')).toBeInTheDocument();
    expect(screen.queryByText(/Category:/)).not.toBeInTheDocument();
  });

  it('shows overridden description', () => {
    const overrides = [{
      id: 'o1', scheduledTransactionId: 's1',
      originalDate: '2025-03-01', overrideDate: '2025-03-01',
      amount: null, categoryId: null, category: null,
      description: 'Partial payment', isSplit: null, splits: null,
      createdAt: '', updatedAt: '',
    }];
    render(
      <OccurrenceDatePicker isOpen={true} scheduledTransaction={scheduledTransaction} overrides={overrides} onSelect={onSelect} onClose={onClose} />
    );
    expect(screen.getByText('Note: Partial payment')).toBeInTheDocument();
  });

  it('shows split modified when override isSplit differs from base', () => {
    const overrides = [{
      id: 'o1', scheduledTransactionId: 's1',
      originalDate: '2025-03-01', overrideDate: '2025-03-01',
      amount: null, categoryId: null, category: null,
      description: null, isSplit: true, splits: [{ categoryId: 'c1', amount: 50 }],
      createdAt: '', updatedAt: '',
    }];
    render(
      <OccurrenceDatePicker isOpen={true} scheduledTransaction={scheduledTransaction} overrides={overrides} onSelect={onSelect} onClose={onClose} />
    );
    expect(screen.getByText('Split modified')).toBeInTheDocument();
  });

  it('does not show split modified when override isSplit matches base', () => {
    const overrides = [{
      id: 'o1', scheduledTransactionId: 's1',
      originalDate: '2025-03-01', overrideDate: '2025-03-05',
      amount: null, categoryId: null, category: null,
      description: null, isSplit: false, splits: null,
      createdAt: '', updatedAt: '',
    }];
    render(
      <OccurrenceDatePicker isOpen={true} scheduledTransaction={scheduledTransaction} overrides={overrides} onSelect={onSelect} onClose={onClose} />
    );
    expect(screen.getByText('Date moved from 2025-03-01')).toBeInTheDocument();
    expect(screen.queryByText('Split modified')).not.toBeInTheDocument();
  });

  it('shows multiple modification details at once', () => {
    const overrides = [{
      id: 'o1', scheduledTransactionId: 's1',
      originalDate: '2025-03-01', overrideDate: '2025-03-10',
      amount: -200, categoryId: 'c2', category: { id: 'c2', name: 'Insurance' } as any,
      description: 'Annual premium', isSplit: null, splits: null,
      createdAt: '', updatedAt: '',
    }];
    render(
      <OccurrenceDatePicker isOpen={true} scheduledTransaction={scheduledTransaction} overrides={overrides} onSelect={onSelect} onClose={onClose} />
    );
    expect(screen.getByText('Date moved from 2025-03-01')).toBeInTheDocument();
    expect(screen.getByText('Amount: USD 200.00')).toBeInTheDocument();
    expect(screen.getByText('Category: Insurance')).toBeInTheDocument();
    expect(screen.getByText('Note: Annual premium')).toBeInTheDocument();
  });

  it('does not show modification details for non-overridden dates', () => {
    const overrides = [{
      id: 'o1', scheduledTransactionId: 's1',
      originalDate: '2025-03-01', overrideDate: '2025-03-05',
      amount: -100, categoryId: null, category: null,
      description: null, isSplit: null, splits: null,
      createdAt: '', updatedAt: '',
    }];
    render(
      <OccurrenceDatePicker isOpen={true} scheduledTransaction={{ ...scheduledTransaction, currencyCode: 'USD' }} overrides={overrides} onSelect={onSelect} onClose={onClose} />
    );
    // Only one "Amount:" detail should exist (for the overridden date)
    const amountDetails = screen.getAllByText(/Amount:/);
    expect(amountDetails.length).toBe(1);
  });

  it('only shows date moved when override copies all base values but changes date', () => {
    const overrides = [{
      id: 'o1', scheduledTransactionId: 's1',
      originalDate: '2025-03-01', overrideDate: '2025-03-05',
      amount: -1200, categoryId: 'cat1', category: { id: 'cat1', name: 'Rent' } as any,
      description: null, isSplit: false, splits: null,
      createdAt: '', updatedAt: '',
    }];
    render(
      <OccurrenceDatePicker isOpen={true} scheduledTransaction={scheduledTransaction} overrides={overrides} onSelect={onSelect} onClose={onClose} />
    );
    expect(screen.getByText('Modified')).toBeInTheDocument();
    expect(screen.getByText('Date moved from 2025-03-01')).toBeInTheDocument();
    expect(screen.queryByText(/Amount:/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Category:/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Note:/)).not.toBeInTheDocument();
    expect(screen.queryByText('Split modified')).not.toBeInTheDocument();
  });

  it('does not show date moved when original and override dates are the same', () => {
    const overrides = [{
      id: 'o1', scheduledTransactionId: 's1',
      originalDate: '2025-03-01', overrideDate: '2025-03-01',
      amount: -50, categoryId: null, category: null,
      description: null, isSplit: null, splits: null,
      createdAt: '', updatedAt: '',
    }];
    render(
      <OccurrenceDatePicker isOpen={true} scheduledTransaction={{ ...scheduledTransaction, currencyCode: 'USD' }} overrides={overrides} onSelect={onSelect} onClose={onClose} />
    );
    expect(screen.queryByText(/Date moved/)).not.toBeInTheDocument();
    expect(screen.getByText('Amount: USD 50.00')).toBeInTheDocument();
  });
});
