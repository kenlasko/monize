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
    renderRow({}, { isTransfer: true, linkedTransaction: null, linkedTransactionId: null });
    expect(screen.getByText('Transfer')).toBeInTheDocument();
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
});
