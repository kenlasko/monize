'use client';

import { useCallback } from 'react';
import { Transaction } from '@/types/transaction';
import { Modal } from '@/components/ui/Modal';

interface TransactionActionSheetProps {
  isOpen: boolean;
  transaction: Transaction | null;
  formatDate: (date: string) => string;
  onClose: () => void;
  onEdit?: (transaction: Transaction) => void;
  onDeleteClick: (transaction: Transaction) => void;
  onDateFilterClick?: (date: string) => void;
  onAccountFilterClick?: (accountId: string) => void;
  onPayeeFilterClick?: (payeeId: string) => void;
  onCategoryClick?: (categoryId: string) => void;
}

export function TransactionActionSheet({
  isOpen,
  transaction,
  formatDate,
  onClose,
  onEdit,
  onDeleteClick,
  onDateFilterClick,
  onAccountFilterClick,
  onPayeeFilterClick,
  onCategoryClick,
}: TransactionActionSheetProps) {
  const handleFilterDate = useCallback(() => {
    if (!transaction) return;
    onClose();
    if (transaction.transactionDate && onDateFilterClick) {
      onDateFilterClick(transaction.transactionDate);
    }
  }, [transaction, onClose, onDateFilterClick]);

  const handleFilterAccount = useCallback(() => {
    if (!transaction) return;
    onClose();
    if (transaction.account?.id && onAccountFilterClick) {
      onAccountFilterClick(transaction.account.id);
    }
  }, [transaction, onClose, onAccountFilterClick]);

  const handleFilterPayee = useCallback(() => {
    if (!transaction) return;
    onClose();
    if (transaction.payeeId && onPayeeFilterClick) {
      onPayeeFilterClick(transaction.payeeId);
    }
  }, [transaction, onClose, onPayeeFilterClick]);

  const handleFilterCategory = useCallback(() => {
    if (!transaction) return;
    onClose();
    if (transaction.category?.id && onCategoryClick) {
      onCategoryClick(transaction.category.id);
    }
  }, [transaction, onClose, onCategoryClick]);

  const handleDelete = useCallback(() => {
    if (!transaction) return;
    onClose();
    onDeleteClick(transaction);
  }, [transaction, onClose, onDeleteClick]);

  return (
    <Modal isOpen={isOpen} onClose={onClose} maxWidth="sm" className="p-0">
      <div className="py-2">
        <div className="px-4 py-2 border-b border-gray-200 dark:border-gray-700">
          <p className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">
            {transaction?.payeeName || 'Transaction'}
          </p>
          <p className="text-xs text-gray-500 dark:text-gray-400">
            {transaction && formatDate(transaction.transactionDate)}
          </p>
        </div>
        {onDateFilterClick && transaction?.transactionDate && (
          <button
            onClick={handleFilterDate}
            className="w-full px-4 py-3 text-left text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 flex items-center gap-3"
          >
            <svg className="w-4 h-4 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
            </svg>
            Filter by date &ldquo;{formatDate(transaction.transactionDate)}&rdquo;
          </button>
        )}
        {onAccountFilterClick && transaction?.account && (
          <button
            onClick={handleFilterAccount}
            className="w-full px-4 py-3 text-left text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 flex items-center gap-3"
          >
            <svg className="w-4 h-4 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 10h18M7 15h1m4 0h1m-7 4h12a3 3 0 003-3V8a3 3 0 00-3-3H6a3 3 0 00-3 3v8a3 3 0 003 3z" />
            </svg>
            Filter by &ldquo;{transaction.account.name}&rdquo;
          </button>
        )}
        {onPayeeFilterClick && transaction?.payeeId && (
          <button
            onClick={handleFilterPayee}
            className="w-full px-4 py-3 text-left text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 flex items-center gap-3"
          >
            <svg className="w-4 h-4 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
            </svg>
            Filter by &ldquo;{transaction.payeeName || 'Payee'}&rdquo;
          </button>
        )}
        {onCategoryClick && transaction?.category && (
          <button
            onClick={handleFilterCategory}
            className="w-full px-4 py-3 text-left text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 flex items-center gap-3"
          >
            <svg className="w-4 h-4 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2.586a1 1 0 01-.293.707l-6.414 6.414a1 1 0 00-.293.707V17l-4 4v-6.586a1 1 0 00-.293-.707L3.293 7.293A1 1 0 013 6.586V4z" />
            </svg>
            Filter by &ldquo;{transaction.category.name}&rdquo;
          </button>
        )}
        {onEdit && (
          <button
            onClick={() => { onClose(); onEdit!(transaction!); }}
            className="w-full px-4 py-3 text-left text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 flex items-center gap-3"
          >
            <svg className="w-4 h-4 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
            </svg>
            Edit
          </button>
        )}
        {!transaction?.linkedInvestmentTransactionId && (
          <button
            onClick={handleDelete}
            className="w-full px-4 py-3 text-left text-sm text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 flex items-center gap-3"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
            </svg>
            Delete
          </button>
        )}
      </div>
    </Modal>
  );
}
