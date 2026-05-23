import { describe, it, expect, vi } from 'vitest';
import { fireEvent, screen } from '@testing-library/react';
import { render } from '@/test/render';
import { TransactionActionSheet } from './TransactionActionSheet';
import { TransactionStatus, type Transaction } from '@/types/transaction';

const tx: Transaction = {
  id: 't1',
  userId: 'u1',
  accountId: 'a1',
  account: { id: 'a1', name: 'Checking' } as any,
  transactionDate: '2025-06-15',
  payeeId: 'p1',
  payeeName: 'Coffee Co',
  payee: null,
  categoryId: 'c1',
  category: { id: 'c1', name: 'Food' } as any,
  amount: -10,
  currencyCode: 'USD',
  exchangeRate: 1,
  description: null,
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
  tags: [{ id: 'tag1', name: 'Coffee' } as any],
  createdAt: '2025-06-15T00:00:00Z',
  updatedAt: '2025-06-15T00:00:00Z',
};

describe('TransactionActionSheet', () => {
  const baseProps = {
    isOpen: true,
    transaction: tx,
    formatDate: (d: string) => `D:${d}`,
    onClose: vi.fn(),
    onDeleteClick: vi.fn(),
  };

  it('renders header with payee name and date', () => {
    render(<TransactionActionSheet {...baseProps} />);
    expect(screen.getByText('Coffee Co')).toBeInTheDocument();
    expect(screen.getByText('D:2025-06-15')).toBeInTheDocument();
  });

  it('renders Transaction header when no payeeName', () => {
    render(<TransactionActionSheet {...baseProps} transaction={{ ...tx, payeeName: null }} />);
    expect(screen.getByText('Transaction')).toBeInTheDocument();
  });

  it('triggers Delete button', () => {
    const onDeleteClick = vi.fn();
    const onClose = vi.fn();
    render(<TransactionActionSheet {...baseProps} onClose={onClose} onDeleteClick={onDeleteClick} />);
    fireEvent.click(screen.getByText('Delete'));
    expect(onDeleteClick).toHaveBeenCalledWith(tx);
    expect(onClose).toHaveBeenCalled();
  });

  it('triggers Edit and onClose', () => {
    const onEdit = vi.fn();
    const onClose = vi.fn();
    render(<TransactionActionSheet {...baseProps} onEdit={onEdit} onClose={onClose} />);
    fireEvent.click(screen.getByText('Edit'));
    expect(onEdit).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it('triggers Duplicate', () => {
    const onDuplicate = vi.fn();
    render(<TransactionActionSheet {...baseProps} onDuplicate={onDuplicate} />);
    fireEvent.click(screen.getByText('Duplicate'));
    expect(onDuplicate).toHaveBeenCalled();
  });

  it('triggers Schedule as Recurring', () => {
    const onScheduleRecurring = vi.fn();
    render(<TransactionActionSheet {...baseProps} onScheduleRecurring={onScheduleRecurring} />);
    fireEvent.click(screen.getByText('Schedule as Recurring'));
    expect(onScheduleRecurring).toHaveBeenCalled();
  });

  it('hides Duplicate/Delete for investment-linked transactions', () => {
    render(
      <TransactionActionSheet
        {...baseProps}
        onDuplicate={vi.fn()}
        transaction={{ ...tx, linkedInvestmentTransactionId: 'inv1' }}
      />,
    );
    expect(screen.queryByText('Duplicate')).not.toBeInTheDocument();
    expect(screen.queryByText('Delete')).not.toBeInTheDocument();
  });

  it('triggers date filter and account/payee/category/tag filters', () => {
    const onDateFilterClick = vi.fn();
    const onAccountFilterClick = vi.fn();
    const onPayeeFilterClick = vi.fn();
    const onCategoryClick = vi.fn();
    const onTagFilterClick = vi.fn();
    render(
      <TransactionActionSheet
        {...baseProps}
        onDateFilterClick={onDateFilterClick}
        onAccountFilterClick={onAccountFilterClick}
        onPayeeFilterClick={onPayeeFilterClick}
        onCategoryClick={onCategoryClick}
        onTagFilterClick={onTagFilterClick}
      />,
    );
    fireEvent.click(screen.getByText(/Filter by date/));
    expect(onDateFilterClick).toHaveBeenCalledWith('2025-06-15');
    fireEvent.click(screen.getByText(/Filter by .Checking/));
    expect(onAccountFilterClick).toHaveBeenCalledWith('a1');
    fireEvent.click(screen.getByText(/Filter by .Coffee Co/));
    expect(onPayeeFilterClick).toHaveBeenCalledWith('p1');
    fireEvent.click(screen.getByText(/Filter by .Food/));
    expect(onCategoryClick).toHaveBeenCalledWith('c1');
    fireEvent.click(screen.getByText(/Filter by tag .Coffee/));
    expect(onTagFilterClick).toHaveBeenCalledWith('tag1');
  });

  it('renders a category filter for each unique split category', () => {
    const onCategoryClick = vi.fn();
    const splitTx: Transaction = {
      ...tx,
      categoryId: null,
      category: null,
      isSplit: true,
      splits: [
        { id: 's1', transactionId: 't1', kind: 'category', categoryId: 'c1', category: { id: 'c1', name: 'Groceries' } as any, transferAccountId: null, transferAccount: null, linkedTransactionId: null, amount: -5, memo: null, createdAt: '2025-06-15T00:00:00Z' },
        { id: 's2', transactionId: 't1', kind: 'category', categoryId: 'c2', category: { id: 'c2', name: 'Household' } as any, transferAccountId: null, transferAccount: null, linkedTransactionId: null, amount: -3, memo: null, createdAt: '2025-06-15T00:00:00Z' },
        // Duplicate category should not produce a second button
        { id: 's3', transactionId: 't1', kind: 'category', categoryId: 'c1', category: { id: 'c1', name: 'Groceries' } as any, transferAccountId: null, transferAccount: null, linkedTransactionId: null, amount: -2, memo: null, createdAt: '2025-06-15T00:00:00Z' },
        // Transfer split has no category and should be skipped
        { id: 's4', transactionId: 't1', kind: 'transfer', categoryId: null, category: null, transferAccountId: 'a2', transferAccount: { id: 'a2', name: 'Savings' } as any, linkedTransactionId: 'l1', amount: -1, memo: null, createdAt: '2025-06-15T00:00:00Z' },
      ],
    };
    render(<TransactionActionSheet {...baseProps} transaction={splitTx} onCategoryClick={onCategoryClick} />);
    expect(screen.getByText(/Filter by .Groceries/)).toBeInTheDocument();
    expect(screen.getByText(/Filter by .Household/)).toBeInTheDocument();
    expect(screen.getAllByText(/Filter by .Groceries/)).toHaveLength(1);
    expect(screen.queryByText(/Filter by .Savings/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByText(/Filter by .Household/));
    expect(onCategoryClick).toHaveBeenCalledWith('c2');
  });

  it('does not crash when transaction is null', () => {
    render(<TransactionActionSheet {...baseProps} transaction={null} />);
    expect(screen.getByText('Transaction')).toBeInTheDocument();
  });
});
