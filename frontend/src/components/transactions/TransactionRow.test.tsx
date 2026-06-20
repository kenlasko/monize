import { describe, it, expect, vi } from 'vitest';
import { fireEvent, screen } from '@testing-library/react';
import { render } from '@/test/render';
import { TransactionRow, type TransactionRowProps } from './TransactionRow';
import { TransactionStatus, type Transaction } from '@/types/transaction';

function makeTx(overrides: Partial<Transaction> = {}): Transaction {
  return {
    id: 't1',
    userId: 'u1',
    accountId: 'a1',
    account: { id: 'a1', name: 'Checking', userId: 'u1', currencyCode: 'CAD' } as any,
    transactionDate: '2025-06-15',
    payeeId: 'p1',
    payeeName: 'Coffee Co',
    payee: null,
    categoryId: 'c1',
    category: { id: 'c1', name: 'Food', color: '#ff0000' } as any,
    amount: -25.5,
    currencyCode: 'CAD',
    exchangeRate: 1,
    description: 'Latte',
    referenceNumber: null,
    status: TransactionStatus.UNRECONCILED,
    isCleared: false,
    isReconciled: false,
    isVoid: false,
    reconciledDate: null,
    isSplit: false,
    parentTransactionId: null,
    isTransfer: false,
    linkedTransactionId: null,
    linkedTransaction: null,
    splits: [],
    tags: [],
    createdAt: '2025-06-15T00:00:00Z',
    updatedAt: '2025-06-15T00:00:00Z',
    ...overrides,
  };
}

function renderRow(overrides: Partial<TransactionRowProps> = {}, txOverrides: Partial<Transaction> = {}) {
  const tx = makeTx(txOverrides);
  const props: TransactionRowProps = {
    transaction: tx,
    index: 0,
    density: 'normal',
    cellPadding: 'p-2',
    isSingleAccountView: true,
    runningBalance: 100,
    isDeleting: false,
    formatDate: (d) => d,
    formatAmount: (a) => <span>{a.toFixed(2)}</span>,
    formatBalance: (b) => <span>{b.toFixed(2)}</span>,
    onRowClick: vi.fn(),
    onLongPressStart: vi.fn(),
    onLongPressStartTouch: vi.fn(),
    onLongPressEnd: vi.fn(),
    onTouchMove: vi.fn(),
    onContextMenu: vi.fn(),
    onCycleStatus: vi.fn(),
    onDeleteClick: vi.fn(),
    ...overrides,
  };
  // Need to wrap in a table to render <tr> properly
  return {
    ...render(<table><tbody><TransactionRow {...props} /></tbody></table>),
    props,
  };
}

describe('TransactionRow', () => {
  it('renders normal transaction with category', () => {
    renderRow();
    expect(screen.getByText('Coffee Co')).toBeInTheDocument();
    expect(screen.getByText('Food')).toBeInTheDocument();
    expect(screen.getByText('Pending')).toBeInTheDocument();
  });

  it('calls onRowClick when row is clicked', () => {
    const onRowClick = vi.fn();
    renderRow({ onRowClick });
    fireEvent.click(screen.getByText('Coffee Co').closest('tr')!);
    expect(onRowClick).toHaveBeenCalled();
  });

  it('renders payee as button when onPayeeClick provided', () => {
    const onPayeeClick = vi.fn();
    renderRow({ onPayeeClick });
    fireEvent.click(screen.getByText('Coffee Co'));
    expect(onPayeeClick).toHaveBeenCalledWith('p1');
  });

  it('renders payee as text when no payeeId', () => {
    renderRow({}, { payeeId: null, payeeName: null });
    // Multiple "-" in row
    const dashes = screen.getAllByText('-');
    expect(dashes.length).toBeGreaterThan(0);
  });

  it('falls back to the linked payee name when payeeName is null (button branch)', () => {
    const onPayeeClick = vi.fn();
    renderRow(
      { onPayeeClick },
      {
        payeeId: 'p1',
        payeeName: null,
        payee: { id: 'p1', name: 'Linked Payee' } as Transaction['payee'],
      },
    );
    fireEvent.click(screen.getByText('Linked Payee'));
    expect(onPayeeClick).toHaveBeenCalledWith('p1');
  });

  it('falls back to the linked payee name when payeeName is null (text branch)', () => {
    renderRow(
      {},
      {
        payeeId: 'p1',
        payeeName: null,
        payee: { id: 'p1', name: 'Linked Payee' } as Transaction['payee'],
      },
    );
    expect(screen.getByText('Linked Payee')).toBeInTheDocument();
  });

  it('renders category as clickable when onCategoryClick provided', () => {
    const onCategoryClick = vi.fn();
    renderRow({ onCategoryClick });
    fireEvent.click(screen.getByText('Food'));
    expect(onCategoryClick).toHaveBeenCalledWith('c1');
  });

  it('renders transfer label when isTransfer', () => {
    renderRow(
      {},
      {
        isTransfer: true,
        linkedTransactionId: 'l1',
        linkedTransaction: {
          id: 'l1',
          account: { id: 'a2', name: 'Savings' },
        } as any,
      },
    );
    expect(screen.getByText(/Savings/)).toBeInTheDocument();
  });

  it('calls onTransferClick when transfer label clicked', () => {
    const onTransferClick = vi.fn();
    renderRow(
      { onTransferClick },
      {
        isTransfer: true,
        linkedTransactionId: 'l1',
        linkedTransaction: { id: 'l1', account: { id: 'a2', name: 'Savings' } } as any,
      },
    );
    fireEvent.click(screen.getByText(/Savings/));
    expect(onTransferClick).toHaveBeenCalledWith('a2', 'l1');
  });

  it('renders transfer without linked account', () => {
    renderRow({}, { isTransfer: true, linkedTransaction: null, linkedTransactionId: null, category: null, categoryId: null });
    expect(screen.getByText('Transfer')).toBeInTheDocument();
  });

  it('shows the assigned category alongside the transfer arrow for a categorized transfer', () => {
    const onCategoryClick = vi.fn();
    renderRow(
      { onCategoryClick },
      {
        isTransfer: true,
        linkedTransactionId: 'l1',
        linkedTransaction: { id: 'l1', account: { id: 'a2', name: 'Savings' } } as any,
        category: { id: 'c9', name: 'Investments', color: '#00ff00' } as any,
        categoryId: 'c9',
        amount: -1000,
      },
    );
    // The assigned category is no longer hidden behind the transfer chip.
    expect(screen.getByText('Investments')).toBeInTheDocument();
    expect(screen.getByText(/Savings/)).toBeInTheDocument();
    // The category chip filters by category, like a normal category chip.
    fireEvent.click(screen.getByText('Investments'));
    expect(onCategoryClick).toHaveBeenCalledWith('c9');
  });

  it('renders Investment badge when linkedInvestmentTransactionId', () => {
    renderRow({}, { linkedInvestmentTransactionId: 'inv1' });
    expect(screen.getByText('Investment')).toBeInTheDocument();
  });

  it('renders split badge with summary', () => {
    renderRow(
      {},
      {
        isSplit: true,
        splits: [
          { id: 's1', amount: -10, category: { id: 'c1', name: 'Food' } } as any,
          { id: 's2', amount: -15, category: { id: 'c2', name: 'Gas' } } as any,
          { id: 's3', amount: -2, category: null, transferAccount: { id: 'a3', name: 'Savings' } } as any,
          { id: 's4', amount: -1, category: null } as any,
        ],
      },
    );
    expect(screen.getByText(/Split \(4\)/)).toBeInTheDocument();
    expect(screen.getByText(/\+1 more/)).toBeInTheDocument();
  });

  it('renders status badges - reconciled', () => {
    renderRow({}, { status: TransactionStatus.RECONCILED });
    expect(screen.getByText('Reconciled')).toBeInTheDocument();
  });

  it('renders status badges - cleared', () => {
    renderRow({}, { status: TransactionStatus.CLEARED });
    expect(screen.getByText('Cleared')).toBeInTheDocument();
  });

  it('renders VOID status with line-through', () => {
    renderRow({}, { status: TransactionStatus.VOID });
    expect(screen.getByText('VOID')).toBeInTheDocument();
  });

  it('cycles status when status button clicked', () => {
    const onCycleStatus = vi.fn();
    renderRow({ onCycleStatus });
    fireEvent.click(screen.getByText('Pending'));
    expect(onCycleStatus).toHaveBeenCalled();
  });

  it('renders Edit button when onEdit provided and calls it', () => {
    const onEdit = vi.fn();
    renderRow({ onEdit });
    fireEvent.click(screen.getByText('Edit'));
    expect(onEdit).toHaveBeenCalled();
  });

  it('renders View instead of Edit for investment-linked transaction', () => {
    const onEdit = vi.fn();
    renderRow({ onEdit }, { linkedInvestmentTransactionId: 'inv1' });
    expect(screen.getByText('View')).toBeInTheDocument();
  });

  it('renders Delete button and calls onDeleteClick', () => {
    const onDeleteClick = vi.fn();
    renderRow({ onDeleteClick });
    fireEvent.click(screen.getByText('Delete'));
    expect(onDeleteClick).toHaveBeenCalled();
  });

  it('shows ... when isDeleting', () => {
    renderRow({ isDeleting: true });
    expect(screen.getByText('...')).toBeInTheDocument();
  });

  it('renders selection checkbox when selectionMode and toggles', () => {
    const onToggleSelection = vi.fn();
    renderRow({ selectionMode: true, isSelected: true, onToggleSelection });
    fireEvent.click(screen.getByRole('checkbox'));
    expect(onToggleSelection).toHaveBeenCalled();
  });

  it('renders running balance when showRunningBalance', () => {
    renderRow({ showRunningBalance: true, runningBalance: 1234.56 });
    expect(screen.getByText('1234.56')).toBeInTheDocument();
  });

  it('shows dash when runningBalance undefined', () => {
    renderRow({ showRunningBalance: true, runningBalance: undefined });
    expect(screen.getAllByText('-').length).toBeGreaterThan(0);
  });

  it('shows displayAmount with marker when provided', () => {
    renderRow({ displayAmount: 5 });
    expect(screen.getByText('*')).toBeInTheDocument();
  });

  it('renders single Copy button when only onDuplicate provided', () => {
    const onDuplicate = vi.fn();
    renderRow({ onDuplicate });
    fireEvent.click(screen.getByText('Copy'));
    expect(onDuplicate).toHaveBeenCalled();
  });

  it('renders Copy dropdown with both actions', () => {
    const onDuplicate = vi.fn();
    const onScheduleRecurring = vi.fn();
    renderRow({ onDuplicate, onScheduleRecurring });
    // Click the Copy span to open dropdown
    fireEvent.click(screen.getByText('Copy'));
    fireEvent.click(screen.getByText('Duplicate'));
    expect(onDuplicate).toHaveBeenCalled();
  });

  it('renders Schedule as Recurring action in dropdown', () => {
    const onDuplicate = vi.fn();
    const onScheduleRecurring = vi.fn();
    renderRow({ onDuplicate, onScheduleRecurring });
    fireEvent.click(screen.getByText('Copy'));
    fireEvent.click(screen.getByText('Schedule as Recurring'));
    expect(onScheduleRecurring).toHaveBeenCalled();
  });

  it('renders tags clickable', () => {
    const onTagClick = vi.fn();
    renderRow(
      { onTagClick },
      {
        tags: [
          { id: 'tag1', name: 'work', color: '#00ff00', icon: null } as any,
        ],
      },
    );
    fireEvent.click(screen.getByText('work'));
    expect(onTagClick).toHaveBeenCalledWith('tag1');
  });

  it('renders tags non-clickable when no onTagClick', () => {
    renderRow(
      {},
      {
        tags: [{ id: 'tag1', name: 'work', color: null, icon: null } as any],
      },
    );
    expect(screen.getByText('work')).toBeInTheDocument();
  });

  it('renders budget indicator when over budget', () => {
    renderRow(
      {},
      {},
    );
    // category id c1
    const props: Partial<TransactionRowProps> = {
      budgetStatusMap: {
        c1: { budgeted: 100, spent: 120, remaining: -20, percentUsed: 120 } as any,
      },
    };
    renderRow(props);
    // The dot has a title indicating over-budget
    const dot = document.querySelector('[title^="Over budget"]');
    expect(dot).not.toBeNull();
  });

  it('renders budget indicator when approaching limit', () => {
    renderRow({
      budgetStatusMap: {
        c1: { budgeted: 100, spent: 85, remaining: 15, percentUsed: 85 } as any,
      },
    });
    expect(document.querySelector('[title^="Approaching limit"]')).not.toBeNull();
  });

  it('renders dense density without normal extras', () => {
    renderRow({ density: 'dense' });
    // Dense uses 'C', 'R', 'V', circle for status; here Pending renders as circle
    // The button still has a title attribute
    expect(screen.getByTitle('Click to cycle status')).toBeInTheDocument();
  });

  it('renders compact density', () => {
    renderRow({ density: 'compact' });
    expect(screen.getByText('Coffee Co')).toBeInTheDocument();
  });

  it('shows isFuture opacity class for non-void future transaction', () => {
    const { container } = renderRow({ isFuture: true });
    const tr = container.querySelector('tr')!;
    expect(tr.className).toContain('opacity-60');
  });

  it('does not apply isFuture opacity for void future transaction', () => {
    const { container } = renderRow({ isFuture: true }, { status: TransactionStatus.VOID });
    const tr = container.querySelector('tr')!;
    // VOID applies opacity-50; isFuture+VOID should not stack the 60% opacity
    expect(tr.className).toContain('opacity-50');
    expect(tr.className).not.toContain('opacity-60');
  });

  it('applies isSelected class to row', () => {
    const { container } = renderRow({ isSelected: true });
    const tr = container.querySelector('tr')!;
    expect(tr.className).toContain('bg-blue-50');
  });

  it('applies cursor-pointer when onEdit is provided', () => {
    const { container } = renderRow({ onEdit: vi.fn() });
    const tr = container.querySelector('tr')!;
    expect(tr.className).toContain('cursor-pointer');
  });

  it('does not apply cursor-pointer when onEdit is not provided', () => {
    const { container } = renderRow({});
    const tr = container.querySelector('tr')!;
    expect(tr.className).not.toContain('cursor-pointer');
  });

  it('renders reference number in normal density', () => {
    renderRow({ density: 'normal' }, { referenceNumber: 'REF-12345' });
    expect(screen.getByText('Ref: REF-12345')).toBeInTheDocument();
  });

  it('does not render reference number in dense density', () => {
    renderRow({ density: 'dense' }, { referenceNumber: 'REF-12345' });
    expect(screen.queryByText('Ref: REF-12345')).not.toBeInTheDocument();
  });

  it('does not render reference number in compact density', () => {
    renderRow({ density: 'compact' }, { referenceNumber: 'REF-12345' });
    expect(screen.queryByText('Ref: REF-12345')).not.toBeInTheDocument();
  });

  it('renders description when provided', () => {
    renderRow({}, { description: 'Test transaction description' });
    expect(screen.getByText('Test transaction description')).toBeInTheDocument();
  });

  it('renders dash for empty description', () => {
    renderRow({}, { description: null });
    expect(screen.getAllByText('-').length).toBeGreaterThan(0);
  });

  it('renders account name in row', () => {
    renderRow();
    expect(screen.getByText('Checking')).toBeInTheDocument();
  });

  it('shows dash when account is null', () => {
    renderRow({}, { account: null as any });
    expect(screen.getAllByText('-').length).toBeGreaterThan(0);
  });

  it('renders status R in dense mode for reconciled', () => {
    renderRow({ density: 'dense' }, { status: TransactionStatus.RECONCILED });
    expect(screen.getByText('R')).toBeInTheDocument();
  });

  it('renders status C in dense mode for cleared', () => {
    renderRow({ density: 'dense' }, { status: TransactionStatus.CLEARED });
    expect(screen.getByText('C')).toBeInTheDocument();
  });

  it('renders status V in dense mode for void', () => {
    renderRow({ density: 'dense' }, { status: TransactionStatus.VOID });
    expect(screen.getByText('V')).toBeInTheDocument();
  });

  it('renders Edit button with investment style for investment transaction', () => {
    const onEdit = vi.fn();
    const { container } = renderRow({ onEdit }, { linkedInvestmentTransactionId: 'inv1' });
    const editBtn = container.querySelector('button[title="View in Investments"]');
    expect(editBtn).not.toBeNull();
  });

  it('does not show CopyDropdown for investment-linked transaction', () => {
    const onDuplicate = vi.fn();
    renderRow({ onDuplicate }, { linkedInvestmentTransactionId: 'inv1' });
    expect(screen.queryByText('Copy')).not.toBeInTheDocument();
  });

  it('does not show Delete button for investment-linked transaction', () => {
    const onDeleteClick = vi.fn();
    renderRow({ onDeleteClick }, { linkedInvestmentTransactionId: 'inv1' });
    expect(screen.queryByText('Delete')).not.toBeInTheDocument();
    expect(screen.queryByText('...')).not.toBeInTheDocument();
  });

  it('renders no-category dash in category cell', () => {
    renderRow({}, { category: null, categoryId: null, isSplit: false, isTransfer: false });
    // Should show "-" for missing category
    expect(screen.getAllByText('-').length).toBeGreaterThan(0);
  });

  it('renders payee name even when payeeId present but onPayeeClick not provided', () => {
    renderRow({}, { payeeId: 'p1', payeeName: 'Starbucks' });
    // No onPayeeClick → renders as div, not button
    expect(screen.getByText('Starbucks')).toBeInTheDocument();
  });

  it('renders payee dash when payeeName is null and no payeeId', () => {
    renderRow({}, { payeeId: null, payeeName: null });
    expect(screen.getAllByText('-').length).toBeGreaterThan(0);
  });

  it('shows tags with icon when tag has icon', () => {
    const onTagClick = vi.fn();
    renderRow(
      { onTagClick },
      {
        tags: [
          { id: 'tag2', name: 'travel', color: '#0000ff', icon: 'airplane' } as any,
        ],
      },
    );
    expect(screen.getByText('travel')).toBeInTheDocument();
  });

  it('renders tags non-clickable with icon', () => {
    renderRow(
      {},
      {
        tags: [{ id: 'tag2', name: 'travel', color: '#0000ff', icon: 'airplane' } as any],
      },
    );
    expect(screen.getByText('travel')).toBeInTheDocument();
  });

  it('renders multiple tags', () => {
    const onTagClick = vi.fn();
    renderRow(
      { onTagClick },
      {
        tags: [
          { id: 'tag1', name: 'work', color: '#00ff00', icon: null } as any,
          { id: 'tag2', name: 'travel', color: null, icon: null } as any,
        ],
      },
    );
    expect(screen.getByText('work')).toBeInTheDocument();
    expect(screen.getByText('travel')).toBeInTheDocument();
  });

  it('renders split badge without splits array', () => {
    renderRow({}, { isSplit: true, splits: undefined as any });
    expect(screen.getByText(/Split/)).toBeInTheDocument();
  });

  it('renders split badge with empty splits array', () => {
    renderRow({}, { isSplit: true, splits: [] });
    expect(screen.getByText(/Split \(0\)/)).toBeInTheDocument();
  });

  it('renders split summary at most 3 items and no more badge for 3 splits', () => {
    renderRow(
      { density: 'normal' },
      {
        isSplit: true,
        splits: [
          { id: 's1', amount: -10, category: { id: 'c1', name: 'Food' } } as any,
          { id: 's2', amount: -5, category: { id: 'c2', name: 'Gas' } } as any,
          { id: 's3', amount: -3, category: { id: 'c3', name: 'Shopping' } } as any,
        ],
      },
    );
    expect(screen.getByText(/Split \(3\)/)).toBeInTheDocument();
    expect(screen.queryByText(/more/)).not.toBeInTheDocument();
  });

  it('renders transfer with positive amount (incoming) correctly', () => {
    renderRow(
      {},
      {
        isTransfer: true,
        amount: 100,
        linkedTransactionId: 'l1',
        linkedTransaction: {
          id: 'l1',
          account: { id: 'a2', name: 'Savings' },
        } as any,
      },
    );
    // Positive amount = money flowing from linked account → "Savings →"
    expect(screen.getByText(/Savings/)).toBeInTheDocument();
  });

  it('renders transfer span (no onTransferClick) with positive amount', () => {
    renderRow(
      {},
      {
        isTransfer: true,
        amount: 50,
        linkedTransactionId: null,
        linkedTransaction: {
          id: 'l1',
          account: { id: 'a2', name: 'Wallet' },
        } as any,
      },
    );
    expect(screen.getByText(/Wallet/)).toBeInTheDocument();
  });

  it('renders transfer span with no linked account name', () => {
    renderRow(
      {},
      {
        isTransfer: true,
        amount: -50,
        linkedTransactionId: null,
        linkedTransaction: { id: 'l1', account: null } as any,
      },
    );
    expect(screen.getByText('Transfer')).toBeInTheDocument();
  });

  it('renders transfer clickable with negative amount (outgoing)', () => {
    const onTransferClick = vi.fn();
    renderRow(
      { onTransferClick },
      {
        isTransfer: true,
        amount: -50,
        linkedTransactionId: 'l1',
        linkedTransaction: { id: 'l1', account: { id: 'a2', name: 'Savings' } } as any,
      },
    );
    expect(screen.getByText(/Savings/)).toBeInTheDocument();
  });

  it('renders no budget indicator when percentUsed is low', () => {
    renderRow({
      budgetStatusMap: {
        c1: { budgeted: 100, spent: 50, remaining: 50, percentUsed: 50 } as any,
      },
    });
    // No over-budget or approaching-limit dot
    expect(document.querySelector('[title^="Over budget"]')).toBeNull();
    expect(document.querySelector('[title^="Approaching limit"]')).toBeNull();
  });

  it('renders no budget indicator when budgetStatusMap has no entry for category', () => {
    renderRow({
      budgetStatusMap: {
        other_cat: { budgeted: 100, spent: 90, remaining: 10, percentUsed: 90 } as any,
      },
    });
    // Category id is c1, no entry for c1
    expect(document.querySelector('[title^="Approaching limit"]')).toBeNull();
  });

  it('renders no budget indicator when budgeted is 0', () => {
    renderRow({
      budgetStatusMap: {
        c1: { budgeted: 0, spent: 10, remaining: -10, percentUsed: 0 } as any,
      },
    });
    expect(document.querySelector('[title^="Over budget"]')).toBeNull();
  });

  it('renders no budget indicator when no categoryColorMap entry', () => {
    renderRow({
      categoryColorMap: new Map([['other_id', '#ff0000']]),
    });
    // Falls back to transaction.category.color
    expect(screen.getByText('Food')).toBeInTheDocument();
  });

  it('renders category badge using categoryColorMap color override', () => {
    renderRow({
      categoryColorMap: new Map([['c1', '#abcdef']]),
    });
    expect(screen.getByText('Food')).toBeInTheDocument();
  });

  it('renders category without onCategoryClick using color from categoryColorMap', () => {
    renderRow({
      categoryColorMap: new Map([['c1', '#abcdef']]),
      // no onCategoryClick
    });
    const span = screen.getByTitle('Food');
    expect(span).not.toBeNull();
  });

  it('renders showRunningBalance=false hides balance column', () => {
    renderRow({ showRunningBalance: false, isSingleAccountView: false });
    expect(screen.queryByText('100.00')).not.toBeInTheDocument();
  });

  it('renders CopyDropdown with only onScheduleRecurring (no onDuplicate)', () => {
    const onScheduleRecurring = vi.fn();
    renderRow({ onScheduleRecurring });
    // With only onScheduleRecurring and no onDuplicate, dropdown button still renders
    fireEvent.click(screen.getByText('Copy'));
    expect(screen.getByText('Schedule as Recurring')).toBeInTheDocument();
  });

  it('CopyDropdown closes when clicking outside', () => {
    const onDuplicate = vi.fn();
    const onScheduleRecurring = vi.fn();
    renderRow({ onDuplicate, onScheduleRecurring });

    // Open dropdown
    fireEvent.click(screen.getByText('Copy'));
    expect(screen.getByText('Duplicate')).toBeInTheDocument();

    // Click outside
    fireEvent.mouseDown(document.body);
    expect(screen.queryByText('Duplicate')).not.toBeInTheDocument();
  });

  it('CopyDropdown closes on window scroll', () => {
    const onDuplicate = vi.fn();
    const onScheduleRecurring = vi.fn();
    renderRow({ onDuplicate, onScheduleRecurring });

    fireEvent.click(screen.getByText('Copy'));
    expect(screen.getByText('Duplicate')).toBeInTheDocument();

    fireEvent.scroll(window);
    expect(screen.queryByText('Duplicate')).not.toBeInTheDocument();
  });

  it('row triggers onLongPressStart on mouseDown', () => {
    const onLongPressStart = vi.fn();
    renderRow({ onLongPressStart });
    const tr = screen.getByText('Coffee Co').closest('tr')!;
    fireEvent.mouseDown(tr);
    expect(onLongPressStart).toHaveBeenCalled();
  });

  it('row triggers onLongPressEnd on mouseUp', () => {
    const onLongPressEnd = vi.fn();
    renderRow({ onLongPressEnd });
    const tr = screen.getByText('Coffee Co').closest('tr')!;
    fireEvent.mouseUp(tr);
    expect(onLongPressEnd).toHaveBeenCalled();
  });

  it('row triggers onLongPressEnd on mouseLeave', () => {
    const onLongPressEnd = vi.fn();
    renderRow({ onLongPressEnd });
    const tr = screen.getByText('Coffee Co').closest('tr')!;
    fireEvent.mouseLeave(tr);
    expect(onLongPressEnd).toHaveBeenCalled();
  });

  it('row triggers onLongPressStartTouch on touchStart', () => {
    const onLongPressStartTouch = vi.fn();
    renderRow({ onLongPressStartTouch });
    const tr = screen.getByText('Coffee Co').closest('tr')!;
    fireEvent.touchStart(tr, { touches: [{ clientX: 0, clientY: 0 }] });
    expect(onLongPressStartTouch).toHaveBeenCalled();
  });

  it('row triggers onTouchMove on touchMove', () => {
    const onTouchMove = vi.fn();
    renderRow({ onTouchMove });
    const tr = screen.getByText('Coffee Co').closest('tr')!;
    fireEvent.touchMove(tr);
    expect(onTouchMove).toHaveBeenCalled();
  });

  it('row triggers onLongPressEnd on touchEnd', () => {
    const onLongPressEnd = vi.fn();
    renderRow({ onLongPressEnd });
    const tr = screen.getByText('Coffee Co').closest('tr')!;
    fireEvent.touchEnd(tr);
    expect(onLongPressEnd).toHaveBeenCalled();
  });

  it('row triggers onLongPressEnd on touchCancel', () => {
    const onLongPressEnd = vi.fn();
    renderRow({ onLongPressEnd });
    const tr = screen.getByText('Coffee Co').closest('tr')!;
    fireEvent.touchCancel(tr);
    expect(onLongPressEnd).toHaveBeenCalled();
  });

  it('row triggers onContextMenu on right-click', () => {
    const onContextMenu = vi.fn();
    renderRow({ onContextMenu });
    const tr = screen.getByText('Coffee Co').closest('tr')!;
    fireEvent.contextMenu(tr);
    expect(onContextMenu).toHaveBeenCalled();
  });

  it('selection checkbox cell stops propagation on click', () => {
    const onRowClick = vi.fn();
    renderRow({ selectionMode: true, isSelected: false, onToggleSelection: vi.fn(), onRowClick });
    const checkboxCell = screen.getByRole('checkbox').closest('td')!;
    fireEvent.click(checkboxCell);
    expect(onRowClick).not.toHaveBeenCalled();
  });

  it('renders split items with transfer accounts correctly', () => {
    renderRow(
      { density: 'normal' },
      {
        isSplit: true,
        splits: [
          { id: 's1', amount: -20, category: null, transferAccount: { id: 'acc3', name: 'Wallet' } } as any,
          { id: 's2', amount: -5, category: { id: 'c2', name: 'Gas' }, transferAccount: null } as any,
        ],
      },
    );
    expect(screen.getByText(/Wallet/)).toBeInTheDocument();
    expect(screen.getByText(/Gas/)).toBeInTheDocument();
  });

  it('renders positive-amount split transfer arrows', () => {
    renderRow(
      { density: 'normal' },
      {
        isSplit: true,
        splits: [
          { id: 's1', amount: 20, category: null, transferAccount: { id: 'acc3', name: 'Source' } } as any,
        ],
      },
    );
    expect(screen.getByText(/Source/)).toBeInTheDocument();
  });

  it('renders investment split with action label and security symbol', () => {
    renderRow(
      { density: 'normal' },
      {
        isSplit: true,
        splits: [
          {
            id: 's1',
            amount: 2500,
            kind: 'category',
            category: { id: 'cat-salary', name: 'Salary' },
            transferAccount: null,
            investmentTransaction: null,
          } as any,
          {
            id: 's2',
            amount: -1000,
            kind: 'investment',
            category: null,
            transferAccount: null,
            investmentTransaction: {
              id: 'inv1',
              action: 'BUY',
              securityId: 'sec1',
              security: { id: 'sec1', symbol: 'AAPL', name: 'Apple Inc.' },
              quantity: 5,
              price: 200,
              commission: 0,
              exchangeRate: 1,
            },
          } as any,
        ],
      },
    );
    expect(screen.getByText(/Salary:/)).toBeInTheDocument();
    expect(screen.getByText(/Buy: AAPL:/)).toBeInTheDocument();
  });

  it('falls back to raw action when investment split lacks a security', () => {
    renderRow(
      { density: 'normal' },
      {
        isSplit: true,
        splits: [
          {
            id: 's1',
            amount: -50,
            kind: 'investment',
            category: null,
            transferAccount: null,
            investmentTransaction: {
              id: 'inv1',
              action: 'DIVIDEND',
              securityId: null,
              security: null,
              quantity: null,
              price: null,
              commission: 0,
              exchangeRate: 1,
            },
          } as any,
        ],
      },
    );
    expect(screen.getByText(/Dividend:/)).toBeInTheDocument();
  });
});
