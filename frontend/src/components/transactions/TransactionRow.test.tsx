import { describe, it, expect, vi } from 'vitest';
import { fireEvent, screen } from '@testing-library/react';
import { render } from '@/test/render';
import { TransactionRow, type TransactionRowProps } from './TransactionRow';
import { TransactionStatus, type Transaction } from '@/types/transaction';
import { REGISTER_PAYEE_PRIORITY_SHARE } from './register-columns';

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
    originalAmount: null,
    originalCurrencyCode: null,
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

  it('flashes and scrolls to the row when highlighted', () => {
    const scrollSpy = vi
      .spyOn(Element.prototype, 'scrollIntoView')
      .mockImplementation(() => {});
    renderRow({ isHighlighted: true });
    const row = screen.getByText('Coffee Co').closest('tr')!;
    expect(row.className).toContain('animate-highlight-flash');
    expect(scrollSpy).toHaveBeenCalled();
    scrollSpy.mockRestore();
  });

  it('does not highlight or scroll by default', () => {
    const scrollSpy = vi
      .spyOn(Element.prototype, 'scrollIntoView')
      .mockImplementation(() => {});
    renderRow();
    const row = screen.getByText('Coffee Co').closest('tr')!;
    expect(row.className).not.toContain('animate-highlight-flash');
    expect(scrollSpy).not.toHaveBeenCalled();
    scrollSpy.mockRestore();
  });

  it('renders payee as button when onPayeeClick provided', () => {
    const onPayeeClick = vi.fn();
    renderRow({ onPayeeClick });
    fireEvent.click(screen.getByText('Coffee Co'));
    expect(onPayeeClick).toHaveBeenCalledWith('p1');
  });

  it('resolves a blank transfer payee from the linked account (issue #1214)', () => {
    // A transfer persisted with no payee (the stored state since #1214)
    // shows "Transfer to <account>" resolved at render time from the linked
    // leg's CURRENT account name, localized -- not a dash, and not a stamped
    // string from creation time.
    renderRow({}, {
      payeeId: null,
      payeeName: null,
      payee: null,
      isTransfer: true,
      amount: -250,
      categoryId: null,
      category: null,
      linkedTransactionId: 't2',
      linkedTransaction: {
        id: 't2',
        accountId: 'a2',
        account: { id: 'a2', name: 'Savings' },
      } as any,
    });
    expect(screen.getByText('Transfer to Savings')).toBeInTheDocument();
  });

  it('resolves the receiving leg as Transfer from (issue #1214)', () => {
    renderRow({}, {
      payeeId: null,
      payeeName: null,
      payee: null,
      isTransfer: true,
      amount: 250,
      categoryId: null,
      category: null,
      linkedTransactionId: 't2',
      linkedTransaction: {
        id: 't2',
        accountId: 'a2',
        account: { id: 'a2', name: 'Chequing' },
      } as any,
    });
    expect(screen.getByText('Transfer from Chequing')).toBeInTheDocument();
  });

  it('keeps a stored payee over the resolved transfer label', () => {
    // A custom label (or a legacy stamp the migration could not match) wins.
    renderRow({}, {
      payeeId: null,
      payeeName: 'Transfer to Old Name',
      payee: null,
      isTransfer: true,
      amount: -250,
      linkedTransactionId: 't2',
      linkedTransaction: {
        id: 't2',
        accountId: 'a2',
        account: { id: 'a2', name: 'Savings' },
      } as any,
    });
    expect(screen.getByText('Transfer to Old Name')).toBeInTheDocument();
    expect(screen.queryByText('Transfer to Savings')).not.toBeInTheDocument();
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
    const badge = screen.getByText('Investment');
    expect(badge).toBeInTheDocument();
    expect(badge).toHaveAttribute(
      'title',
      'This transaction is linked to an investment transaction',
    );
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

  it('renders the reference number once, in the Ref # column, not under the payee', () => {
    renderRow({ density: 'normal' }, { referenceNumber: 'REF-12345' });
    expect(screen.getAllByText('REF-12345')).toHaveLength(1);
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

  it('renders account name in a multi-account view', () => {
    renderRow({ isSingleAccountView: false });
    expect(screen.getByText('Checking')).toBeInTheDocument();
  });

  it('omits the Account cell entirely in a single-account view', () => {
    // Structural, not responsive: on a single account's page every row would
    // repeat the page's own title, so the cell must not exist at any width
    // (register-columns.ts). The default renderRow props are single-account.
    renderRow();
    expect(screen.queryByText('Checking')).not.toBeInTheDocument();
  });

  it('shows dash when account is null', () => {
    renderRow({ isSingleAccountView: false }, { account: null as any });
    expect(screen.getAllByText('-').length).toBeGreaterThan(0);
  });

  it('renders the attachment count when the transaction has attachments', () => {
    renderRow({}, { attachmentCount: 3 });
    expect(screen.getByText('3')).toBeInTheDocument();
  });

  it('renders a dash when there are no attachments', () => {
    renderRow({}, { attachmentCount: 0 });
    expect(screen.getAllByText('-').length).toBeGreaterThan(0);
  });

  it('renders a dash when attachmentCount is undefined', () => {
    renderRow({}, { attachmentCount: undefined });
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

  it('draws the icon a category inherited from its parent', () => {
    // The joined category row carries only its own icon, so without the map a
    // child of an icon-bearing parent shows a bare pill while the categories
    // list beside it shows a glyph.
    const { container } = renderRow({
      categoryIconMap: new Map([['c1', 'shopping-cart']]),
    });
    expect(container.querySelector('svg')).toBeTruthy();
  });

  it('draws no glyph when neither the row nor the map has an icon', () => {
    const { container } = renderRow({ categoryIconMap: new Map() });
    expect(container.querySelector('svg')).toBeNull();
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

  it('names a return of capital split line rather than printing the raw action (#1800)', () => {
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
            amount: 40,
            kind: 'investment',
            category: null,
            transferAccount: null,
            investmentTransaction: {
              id: 'inv1',
              action: 'RETURN_OF_CAPITAL',
              securityId: 'sec1',
              security: { id: 'sec1', symbol: 'XYZ', name: 'XYZ Fund' },
              quantity: null,
              price: 40,
              commission: 0,
              exchangeRate: 1,
            },
          } as any,
        ],
      },
    );
    expect(screen.getByText(/Return of Capital: XYZ:/)).toBeInTheDocument();
    expect(screen.queryByText(/RETURN_OF_CAPITAL/)).not.toBeInTheDocument();
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

describe('TransactionRow payee brand icon', () => {
  const withLogo = {
    id: 'p1',
    name: 'Coffee Co',
    hasLogo: true,
  } as Transaction['payee'];

  it('renders the cached favicon at normal density', () => {
    const { container } = renderRow({}, { payee: withLogo });
    const img = container.querySelector('td img') as HTMLImageElement;
    expect(img).toBeTruthy();
    expect(img.getAttribute('src')).toBe('/api/v1/payees/p1/logo');
  });

  it('renders the cached favicon at compact density', () => {
    const { container } = renderRow({ density: 'compact' }, { payee: withLogo });
    expect(container.querySelector('td img')).toBeTruthy();
  });

  it('draws no badge at dense density', () => {
    // A dense row is one line of data; a chip on every row is noise there.
    const { container } = renderRow({ density: 'dense' }, { payee: withLogo });
    expect(container.querySelector('td img')).toBeNull();
    expect(screen.queryByText('C')).toBeNull();
  });

  it('falls back to the initial badge when the payee has no cached icon', () => {
    const { container } = renderRow(
      {},
      { payee: { ...withLogo, hasLogo: false } as Transaction['payee'] },
    );
    // hasLogo false must not issue a request that is a guaranteed 404.
    expect(container.querySelector('td img')).toBeNull();
    expect(screen.getByText('C')).toBeInTheDocument();
  });

  it('badges a free-text payee from its name', () => {
    // payeeId/payee are null for a name typed straight onto the transaction;
    // there is no logo route to read, but the column still has to line up.
    const { container } = renderRow(
      {},
      { payeeId: null, payee: null, payeeName: 'Corner Shop' },
    );
    expect(container.querySelector('td img')).toBeNull();
    expect(screen.getByText('C')).toBeInTheDocument();
  });

  it('draws no badge when the row has no payee at all', () => {
    const { container } = renderRow(
      {},
      { payeeId: null, payee: null, payeeName: null },
    );
    expect(container.querySelector('td img')).toBeNull();
    expect(container.querySelector('td span[aria-hidden="true"]')).toBeNull();
  });

  it('hides the favicon on phones with a variant, never a bare hidden', () => {
    // `.hidden` is emitted before every other display utility, so on the
    // fallback badge (whose own classes include `inline-flex`) a bare
    // `hidden` loses and the letter circle stays visible on mobile. The
    // reliable spelling is `max-sm:hidden` -- a variant sorts after the base
    // utilities and wins below the breakpoint.
    const { container } = renderRow({}, { payee: withLogo });
    const img = container.querySelector('td img') as HTMLImageElement;
    expect(img.classList.contains('max-sm:hidden')).toBe(true);
    expect(img.classList.contains('hidden')).toBe(false);
  });

  it('hides the letter badge on phones with a variant, never a bare hidden', () => {
    const { container } = renderRow(
      {},
      { payee: { ...withLogo, hasLogo: false } as Transaction['payee'] },
    );
    const badge = container.querySelector('td span[aria-hidden="true"]')!;
    expect(badge.classList.contains('max-sm:hidden')).toBe(true);
    expect(badge.classList.contains('hidden')).toBe(false);
  });

  it('keeps the payee button\'s text to the name alone', () => {
    // The badge is a sibling of the button, never inside it: a glyph in there
    // changes what every textContent assertion over the cell reads.
    renderRow({ onPayeeClick: vi.fn() }, { payee: withLogo });
    // getByText matches an element's own text, so a badge moved inside the
    // button would make this fail rather than quietly pass.
    const button = screen.getByText('Coffee Co');
    expect(button.tagName).toBe('BUTTON');
    expect(button.textContent).toBe('Coffee Co');
  });
});

describe('TransactionRow long payee names', () => {
  // A nowrap `truncate` name counts its full width in the column's
  // min-content, so with the Account column showing it pushed Amount and
  // Balance behind the sticky Actions column (issue #1470). Normal now wraps
  // the name; Compact and Dense ellipsize it inside a grid that does not hold
  // the column open. jsdom does no layout, so what is checkable here is that
  // each density's classes reach both payee renderings (the filter button and
  // the plain name).
  const renderings = [
    ['the payee button', { onPayeeClick: vi.fn() }],
    ['the plain payee name', {}],
  ] as const;

  it.each(renderings)('wraps %s onto more lines at normal density', (_label, props) => {
    renderRow({ ...props, density: 'normal' });
    const name = screen.getByText('Coffee Co');
    expect(name.className).toContain('sm:wrap-anywhere');
    // Phones keep the original single-line payee.
    expect(name.className.split(' ')).not.toContain('truncate');
    expect(name.className).toContain('max-sm:truncate');
  });

  it.each(
    (['compact', 'dense'] as const).flatMap((density) =>
      renderings.map(([label, props]) => [density, label, props] as const),
    ),
  )('ellipsizes at %s density on %s without holding the column open', (density, _label, props) => {
    renderRow({ ...props, density });
    const name = screen.getByText('Coffee Co');
    expect(name.className).toContain('truncate');
    expect(name.className).not.toContain('wrap-anywhere');
    expect(name.parentElement!.className).toContain('auto-cols-[minmax(0,max-content)]');
    // ...except from the tier where Description appears, where the payee
    // holds its width before Description takes the rest.
    expect(name.className).toContain(REGISTER_PAYEE_PRIORITY_SHARE);
    expect(name.parentElement!.className).toContain('@min-[1536px]:flex');
  });
});

describe('TransactionRow compact dates (the day/month view)', () => {
  // Born as a phone-only trade -- the payee is what runs out of room there,
  // and the year is the part a register row can spare -- and now the user's
  // date view at every width, so the cell renders ONE format rather than a
  // phone/desktop CSS split.
  const formatCompactDate = (d: string) => d.slice(5);

  it('renders the full date alone when the option is off', () => {
    const { container } = renderRow();
    const dateCell = container.querySelector('td')!;
    expect(dateCell.textContent).toBe('2025-06-15');
    expect(dateCell.querySelector('.sm\\:hidden')).toBeNull();
  });

  it('renders the year-less date at every width when the option is on', () => {
    const { container } = renderRow({ compactDates: true, formatCompactDate });
    const dateCell = container.querySelector('td')!;

    // The day survives -- it is the year that goes, so a register row still
    // says which day it happened on. One rendering, no breakpoint split: the
    // chosen view holds on desktop as well as on phones.
    expect(dateCell.textContent).toBe('06-15');
    expect(dateCell.querySelector('.sm\\:hidden')).toBeNull();
    expect(dateCell.querySelector('.sm\\:inline')).toBeNull();
  });

  it('widens the phone-width payee cap when compact dates are on', () => {
    const { container } = renderRow({ compactDates: true, formatCompactDate });
    const payeeCell = screen.getByText('Coffee Co').closest('td')!;
    expect(payeeCell.className).toContain('max-w-[160px]');
    expect(payeeCell.className).not.toContain('max-w-[100px]');
    expect(payeeCell.className).toContain('sm:max-w-none');
    expect(container).toBeTruthy();
  });

  it('keeps the 100px payee cap when the option is off', () => {
    renderRow();
    const payeeCell = screen.getByText('Coffee Co').closest('td')!;
    expect(payeeCell.className).toContain('max-w-[100px]');
    expect(payeeCell.className).toContain('sm:max-w-none');
  });

  it('does not abbreviate without a compact formatter, whatever the flag says', () => {
    const { container } = renderRow({ compactDates: true });
    const dateCell = container.querySelector('td')!;
    expect(dateCell.textContent).toBe('2025-06-15');
  });

  describe('a web address in the description', () => {
    const WITH_LINK = 'Concert tickets https://tix.test/a8Fq2';

    it('is clickable, and opens away from the register', () => {
      renderRow({}, { description: WITH_LINK });
      const link = screen.getByRole('link', { name: 'https://tix.test/a8Fq2' });
      expect(link.getAttribute('href')).toBe('https://tix.test/a8Fq2');
      expect(link.getAttribute('target')).toBe('_blank');
      expect(link.getAttribute('rel')).toBe('noopener noreferrer');
    });

    it('does not open the transaction as well', () => {
      // The row is clickable, so without stopping the event a tap on the link
      // opened the ticket page and the edit modal behind it.
      const { props } = renderRow({}, { description: WITH_LINK });
      fireEvent.click(screen.getByRole('link'));
      expect(props.onRowClick).not.toHaveBeenCalled();
    });

    it('does not start the row long-press', () => {
      const { props } = renderRow({}, { description: WITH_LINK });
      fireEvent.mouseDown(screen.getByRole('link'));
      fireEvent.touchStart(screen.getByRole('link'));
      expect(props.onLongPressStart).not.toHaveBeenCalled();
      expect(props.onLongPressStartTouch).not.toHaveBeenCalled();
    });

    it('leaves the rest of the description cell opening the transaction', () => {
      const { props } = renderRow({}, { description: WITH_LINK });
      fireEvent.click(screen.getByText(/Concert tickets/));
      expect(props.onRowClick).toHaveBeenCalled();
    });

    it('shows the description unchanged, link and all', () => {
      renderRow({}, { description: WITH_LINK });
      const cell = screen.getByText(/Concert tickets/).closest('td')!;
      expect(cell.textContent).toBe(WITH_LINK);
    });

    it('leaves a description with no address as plain text', () => {
      const { container } = renderRow({}, { description: 'Latte' });
      expect(screen.getByText('Latte')).toBeInTheDocument();
      expect(container.querySelector('a[target="_blank"]')).toBeNull();
    });

    it('still shows a dash when there is no description', () => {
      renderRow({}, { description: null });
      expect(screen.getAllByText('-').length).toBeGreaterThan(0);
    });
  });
});

describe('TransactionRow hidden columns', () => {
  // The register's hidden set reaches the row as a prop; a hidden column's
  // cell is absent from the DOM at every width, in the tier row and the phone
  // card alike (lib/hidden-columns.ts, decision 4 of the plan).
  const tags = [{ id: 'tag1', name: 'work', color: null, icon: null }] as Transaction['tags'];

  it('renders every column with nothing hidden, as before', () => {
    const { container } = renderRow({ hidden: new Set() }, { referenceNumber: 'CHK-1', tags, attachmentCount: 2 });
    expect(screen.getByText('Latte')).toBeInTheDocument();
    expect(screen.getByText('CHK-1')).toBeInTheDocument();
    expect(screen.getByText('work')).toBeInTheDocument();
    expect(screen.getByTestId('attachment-badge')).toBeInTheDocument();
    expect(screen.getByTitle('Click to cycle status')).toBeInTheDocument();
    // Date, payee, category, the five hideable, amount, balance, actions.
    expect(container.querySelectorAll('td')).toHaveLength(11);
  });

  it('omits a hidden tier cell from the DOM', () => {
    const { container } = renderRow(
      { hidden: new Set(['description', 'refNumber', 'tags', 'attachments', 'status']) },
      { referenceNumber: 'CHK-1', tags, attachmentCount: 2 },
    );
    expect(screen.queryByText('Latte')).not.toBeInTheDocument();
    expect(screen.queryByText('CHK-1')).not.toBeInTheDocument();
    expect(screen.queryByText('work')).not.toBeInTheDocument();
    expect(screen.queryByTestId('attachment-badge')).not.toBeInTheDocument();
    expect(screen.queryByTitle('Click to cycle status')).not.toBeInTheDocument();
    // Date, payee, category, amount, balance (single-account view), actions.
    expect(container.querySelectorAll('td')).toHaveLength(4 + 1 + 1);
    // The structural columns are untouched.
    expect(screen.getByText('Coffee Co')).toBeInTheDocument();
    expect(screen.getByText('Food')).toBeInTheDocument();
  });

  it('hides one column without moving the others', () => {
    const { container } = renderRow({ hidden: new Set(['status']) }, { referenceNumber: 'CHK-1' });
    expect(screen.queryByTitle('Click to cycle status')).not.toBeInTheDocument();
    expect(screen.getByText('Latte')).toBeInTheDocument();
    expect(screen.getByText('CHK-1')).toBeInTheDocument();
    expect(container.querySelectorAll('td')).toHaveLength(10);
  });

  it('gates the phone card: the status pill', () => {
    renderRow({ wrapped: true, hidden: new Set(['status']) });
    expect(screen.queryByTitle('Click to cycle status')).not.toBeInTheDocument();
    expect(screen.getByText('Coffee Co')).toBeInTheDocument();
  });

  it('gates the phone card: the attachment badge', () => {
    renderRow({ wrapped: true, hidden: new Set(['attachments']) }, { attachmentCount: 2 });
    expect(screen.queryByTestId('attachment-badge')).not.toBeInTheDocument();
    expect(screen.getByTitle('Click to cycle status')).toBeInTheDocument();
  });

  it('gates the phone card: the tags line', () => {
    const { container } = renderRow({ wrapped: true, hidden: new Set(['tags']) }, { tags });
    expect(screen.queryByText('work')).not.toBeInTheDocument();
    // The card is back to two lines: no third `col-span-3` block after line 2.
    const grid = container.querySelector('td > div')!;
    expect(grid.querySelectorAll(':scope > .col-span-3')).toHaveLength(1);
  });

  it('keeps the card as it was with nothing hidden', () => {
    const { container } = renderRow({ wrapped: true, hidden: new Set() }, { tags, attachmentCount: 2 });
    expect(screen.getByText('work')).toBeInTheDocument();
    expect(screen.getByTestId('attachment-badge')).toBeInTheDocument();
    expect(screen.getByTitle('Click to cycle status')).toBeInTheDocument();
    const grid = container.querySelector('td > div')!;
    expect(grid.querySelectorAll(':scope > .col-span-3')).toHaveLength(2);
  });
});

describe('TransactionRow warranties', () => {
  it('renders exactly as before on a row without warranties', () => {
    const first = renderRow({}, { warrantyCount: 0, attachmentCount: 2 });
    const before = first.container.innerHTML;
    first.unmount();
    const { container: without } = renderRow({}, { attachmentCount: 2 });
    expect(without.innerHTML).toBe(before);
    expect(screen.queryByTestId('warranty-badge')).not.toBeInTheDocument();
  });

  it('shows the shield and count beside the paperclip in the attachments cell', () => {
    renderRow({}, { warrantyCount: 2, attachmentCount: 1 });
    const badge = screen.getByRole('img', { name: '2 warranties' });
    expect(badge).toHaveTextContent('2');
    const attachment = screen.getByTestId('attachment-badge');
    expect(badge.closest('td')).toBe(attachment.closest('td'));
  });

  it('shows the shield alone, without the dash, on a row with no attachments', () => {
    renderRow({}, { warrantyCount: 1 });
    const badge = screen.getByRole('img', { name: '1 warranty' });
    expect(badge.closest('td')).not.toHaveTextContent('-');
    expect(screen.queryByTestId('attachment-badge')).not.toBeInTheDocument();
  });

  it('shows the shield on the phone card, and gates it with the attachments column', () => {
    const first = renderRow({ wrapped: true }, { warrantyCount: 3 });
    expect(screen.getByRole('img', { name: '3 warranties' })).toBeInTheDocument();
    first.unmount();
    renderRow({ wrapped: true, hidden: new Set(['attachments']) }, { warrantyCount: 3 });
    expect(screen.queryByTestId('warranty-badge')).not.toBeInTheDocument();
  });

  it('offers no warranty action in the Copy menu, with or without warranties', () => {
    // A warranty is not a copy: it is added from the transaction's form or the
    // Warranties page, and the row's shield says one exists.
    for (const warrantyCount of [0, 1]) {
      const view = renderRow({ onDuplicate: vi.fn(), onScheduleRecurring: vi.fn() }, { warrantyCount });
      fireEvent.click(screen.getByText('Copy'));
      expect(screen.getByText('Duplicate')).toBeInTheDocument();
      expect(screen.queryByText('Add warranty')).not.toBeInTheDocument();
      expect(screen.queryByText('View warranties')).not.toBeInTheDocument();
      view.unmount();
    }
  });

  it('keeps the single Duplicate button on a row with warranties', () => {
    renderRow({ onDuplicate: vi.fn() }, { warrantyCount: 2 });
    expect(screen.getByTitle('Duplicate transaction')).toBeInTheDocument();
  });
});
it('recognition rows open the parent without exposing independent mutation controls', () => {
  const edit=vi.fn();
  renderRow({onEdit:edit,onDuplicate:vi.fn(),onScheduleRecurring:vi.fn(),showRunningBalance:false}, {
    id:'recognition',
    reportingProvenance:{readOnly:true,reportId:'recognition',sourceTransactionId:'parent',cashDate:'2025-06-15',effectiveDate:'2025-06-30',sourceAmount:'-306',nativeAmount:'-25.5'},
  });
  expect(screen.queryByRole('button',{name:'Edit'})).not.toBeInTheDocument();
  expect(screen.queryByRole('button',{name:'Delete'})).not.toBeInTheDocument();
  expect(screen.queryByRole('button',{name:'Accrual'})).not.toBeInTheDocument();
  expect(screen.getByText('Accrued')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button',{name:'View'}));
  expect(edit).toHaveBeenCalledWith(expect.objectContaining({reportingProvenance:expect.objectContaining({sourceTransactionId:'parent'})}));
});
it('marks a not-yet-reached recognition row Scheduled instead of Accrued', () => {
  renderRow({showRunningBalance:false}, {
    id:'recognition',
    transactionDate:'2099-01-31',
    reportingProvenance:{readOnly:true,reportId:'recognition',sourceTransactionId:'parent',cashDate:'2098-01-15',effectiveDate:'2099-01-31',sourceAmount:'-306',nativeAmount:'-25.5'},
  });
  expect(screen.getByText('Scheduled')).toBeInTheDocument();
  expect(screen.queryByText('Accrued')).not.toBeInTheDocument();
});
