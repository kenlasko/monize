'use client';

import { memo, type JSX } from 'react';
import { Transaction, TransactionStatus } from '@/types/transaction';
import { CategoryBudgetStatus } from '@/types/budget';
import { DensityLevel } from '@/hooks/useTableDensity';

export interface TransactionRowProps {
  transaction: Transaction;
  index: number;
  density: DensityLevel;
  cellPadding: string;
  isSingleAccountView: boolean;
  runningBalance: number | undefined;
  isDeleting: boolean;
  formatDate: (date: string) => string;
  formatAmount: (amount: number, currencyCode?: string) => JSX.Element;
  formatBalance: (balance: number, currencyCode?: string) => JSX.Element;
  onRowClick: (transaction: Transaction) => void;
  onLongPressStart: (transaction: Transaction) => void;
  onLongPressStartTouch: (transaction: Transaction, e: React.TouchEvent) => void;
  onLongPressEnd: () => void;
  onTouchMove: (e: React.TouchEvent) => void;
  onPayeeClick?: (payeeId: string) => void;
  onTransferClick?: (linkedAccountId: string, linkedTransactionId: string) => void;
  onCategoryClick?: (categoryId: string) => void;
  onCycleStatus: (transaction: Transaction) => void;
  onEdit?: (transaction: Transaction) => void;
  onDeleteClick: (transaction: Transaction) => void;
  isSelected?: boolean;
  selectionMode?: boolean;
  onToggleSelection?: () => void;
  categoryColorMap?: Map<string, string | null>;
  budgetStatusMap?: Record<string, CategoryBudgetStatus>;
}

export const TransactionRow = memo(function TransactionRow({
  transaction,
  index,
  density,
  cellPadding,
  isSingleAccountView,
  runningBalance,
  isDeleting,
  formatDate,
  formatAmount,
  formatBalance,
  onRowClick,
  onLongPressStart,
  onLongPressStartTouch,
  onLongPressEnd,
  onTouchMove,
  onPayeeClick,
  onTransferClick,
  onCategoryClick,
  onCycleStatus,
  onEdit,
  onDeleteClick,
  isSelected,
  selectionMode,
  onToggleSelection,
  categoryColorMap,
  budgetStatusMap,
}: TransactionRowProps) {
  const isVoid = transaction.status === TransactionStatus.VOID;
  const categoryColor = transaction.category
    ? (categoryColorMap?.get(transaction.category.id) ?? transaction.category.color)
    : null;

  return (
    <tr
      onClick={() => onRowClick(transaction)}
      onMouseDown={() => onLongPressStart(transaction)}
      onMouseUp={onLongPressEnd}
      onMouseLeave={onLongPressEnd}
      onTouchStart={(e) => onLongPressStartTouch(transaction, e)}
      onTouchMove={onTouchMove}
      onTouchEnd={onLongPressEnd}
      onTouchCancel={onLongPressEnd}
      className={`hover:bg-gray-100 dark:hover:bg-gray-800 ${density !== 'normal' && index % 2 === 1 ? 'bg-gray-50 dark:bg-gray-800/50' : ''} ${isVoid ? 'opacity-50' : ''} ${onEdit ? 'cursor-pointer' : ''} ${isSelected ? 'bg-blue-50 dark:bg-blue-900/20' : ''}`}
    >
      {selectionMode && (
        <td className={`${cellPadding} whitespace-nowrap w-10`} onClick={e => e.stopPropagation()}>
          <input
            type="checkbox"
            checked={isSelected || false}
            onChange={() => onToggleSelection?.()}
            className="rounded border-gray-300 dark:border-gray-600 text-blue-600 focus:ring-blue-500 h-4 w-4 cursor-pointer"
          />
        </td>
      )}
      <td className={`${cellPadding} whitespace-nowrap text-sm text-gray-900 dark:text-gray-100 ${isVoid ? 'line-through' : ''}`}>
        {formatDate(transaction.transactionDate)}
      </td>
      <td className={`${cellPadding} whitespace-nowrap text-sm text-gray-900 dark:text-gray-100 ${isVoid ? 'line-through' : ''} hidden md:table-cell`}>
        {transaction.account?.name || '-'}
      </td>
      <td className={`${cellPadding} max-w-[100px] sm:max-w-none overflow-hidden`}>
        {transaction.payeeId && onPayeeClick ? (
          <button
            onClick={(e) => { e.stopPropagation(); onPayeeClick(transaction.payeeId!); }}
            className={`text-sm font-medium text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-300 hover:underline block truncate sm:max-w-[280px] text-left ${isVoid ? 'line-through' : ''}`}
            title={`Edit payee: ${transaction.payeeName}`}
          >
            {transaction.payeeName || '-'}
          </button>
        ) : (
          <div
            className={`text-sm font-medium text-gray-900 dark:text-gray-100 truncate sm:max-w-[280px] ${isVoid ? 'line-through' : ''}`}
            title={transaction.payeeName || undefined}
          >
            {transaction.payeeName || '-'}
          </div>
        )}
        {density === 'normal' && transaction.referenceNumber && (
          <div className="text-xs text-gray-500 dark:text-gray-400">
            Ref: {transaction.referenceNumber}
          </div>
        )}
      </td>
      <td className={`${cellPadding} ${density !== 'normal' ? 'whitespace-nowrap' : ''} hidden lg:table-cell`}>
        {transaction.linkedInvestmentTransactionId ? (
          <span
            className={`inline-flex text-xs leading-5 font-semibold rounded-full bg-emerald-100 dark:bg-emerald-900 text-emerald-800 dark:text-emerald-200 ${density === 'dense' ? 'px-1.5 py-0.5' : 'px-2 py-1'}`}
            title="This transaction is linked to an investment transaction"
          >
            Investment
          </span>
        ) : transaction.isTransfer ? (
          onTransferClick && transaction.linkedTransaction?.account?.id && transaction.linkedTransactionId ? (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onTransferClick(transaction.linkedTransaction!.account!.id, transaction.linkedTransactionId!);
              }}
              className={`inline-flex text-xs leading-5 font-semibold rounded-full bg-blue-100 dark:bg-blue-900 text-blue-800 dark:text-blue-200 truncate max-w-[160px] hover:bg-blue-200 dark:hover:bg-blue-800 transition-colors ${density === 'dense' ? 'px-1.5 py-0.5' : 'px-2 py-1'}`}
              title={`Click to view in ${transaction.linkedTransaction.account.name}`}
            >
              {Number(transaction.amount) < 0
                ? `\u2192 ${transaction.linkedTransaction.account.name}`
                : `${transaction.linkedTransaction.account.name} \u2192`}
            </button>
          ) : (
            <span
              className={`inline-flex text-xs leading-5 font-semibold rounded-full bg-blue-100 dark:bg-blue-900 text-blue-800 dark:text-blue-200 truncate max-w-[160px] ${density === 'dense' ? 'px-1.5 py-0.5' : 'px-2 py-1'}`}
              title={transaction.linkedTransaction?.account?.name
                ? `Transfer ${Number(transaction.amount) < 0 ? 'to' : 'from'} ${transaction.linkedTransaction.account.name}`
                : 'Transfer'}
            >
              {transaction.linkedTransaction?.account?.name
                ? (Number(transaction.amount) < 0
                    ? `\u2192 ${transaction.linkedTransaction.account.name}`
                    : `${transaction.linkedTransaction.account.name} \u2192`)
                : 'Transfer'}
            </span>
          )
        ) : transaction.isSplit ? (
          <div>
            <span className={`inline-flex text-xs leading-5 font-semibold rounded-full bg-purple-100 dark:bg-purple-900 text-purple-800 dark:text-purple-200 ${density === 'dense' ? 'px-1.5 py-0.5' : 'px-2 py-1'}`}>
              Split{transaction.splits ? ` (${transaction.splits.length})` : ''}
            </span>
            {density === 'normal' && transaction.splits && transaction.splits.length > 0 && (
              <div className="mt-1 text-xs text-gray-500 dark:text-gray-400 space-y-0.5">
                {[...transaction.splits]
                  .sort((a, b) => Math.abs(Number(b.amount)) - Math.abs(Number(a.amount)))
                  .slice(0, 3)
                  .map((split, idx) => (
                  <div key={split.id || idx} className="truncate max-w-[180px]">
                    {split.transferAccount ? (
                      <span className="text-blue-600 dark:text-blue-400">
                        {Number(split.amount) < 0
                          ? `\u2192 ${split.transferAccount.name}`
                          : `${split.transferAccount.name} \u2192`}: ${Math.abs(Number(split.amount)).toFixed(2)}
                      </span>
                    ) : (
                      <>{split.category?.name || 'Uncategorized'}: ${Math.abs(Number(split.amount)).toFixed(2)}</>
                    )}
                  </div>
                ))}
                {transaction.splits.length > 3 && (
                  <div className="text-gray-400 dark:text-gray-500">+{transaction.splits.length - 3} more</div>
                )}
              </div>
            )}
          </div>
        ) : transaction.category ? (
          (() => {
            const budgetStatus = budgetStatusMap?.[transaction.category!.id];
            const budgetIndicator = budgetStatus && budgetStatus.budgeted > 0 ? (
              <span
                className={`inline-block w-1.5 h-1.5 rounded-full ml-1 flex-shrink-0 ${
                  budgetStatus.percentUsed > 100
                    ? 'bg-red-500'
                    : budgetStatus.percentUsed >= 80
                      ? 'bg-amber-500'
                      : ''
                }`}
                title={
                  budgetStatus.percentUsed > 100
                    ? `Over budget: ${budgetStatus.percentUsed.toFixed(0)}% used ($${budgetStatus.spent.toFixed(2)} / $${budgetStatus.budgeted.toFixed(2)})`
                    : budgetStatus.percentUsed >= 80
                      ? `Approaching limit: ${budgetStatus.percentUsed.toFixed(0)}% used ($${budgetStatus.remaining.toFixed(2)} remaining)`
                      : undefined
                }
              />
            ) : null;

            return onCategoryClick ? (
              <span className="inline-flex items-center">
                <button
                  onClick={(e) => { e.stopPropagation(); onCategoryClick(transaction.category!.id); }}
                  className={`inline-flex text-xs leading-5 font-semibold rounded-full truncate max-w-[160px] hover:opacity-80 transition-opacity ${density === 'dense' ? 'px-1.5 py-0.5' : 'px-2 py-1'}`}
                  style={{
                    backgroundColor: categoryColor
                      ? `color-mix(in srgb, ${categoryColor} 15%, var(--category-bg-base, #e5e7eb))`
                      : 'var(--category-bg-base, #e5e7eb)',
                    color: categoryColor
                      ? `color-mix(in srgb, ${categoryColor} 85%, var(--category-text-mix, #000))`
                      : 'var(--category-text-base, #6b7280)',
                  }}
                  title={`Filter by ${transaction.category!.name}`}
                >
                  {transaction.category!.name}
                </button>
                {budgetIndicator}
              </span>
            ) : (
              <span className="inline-flex items-center">
                <span
                  className={`inline-flex text-xs leading-5 font-semibold rounded-full truncate max-w-[160px] ${density === 'dense' ? 'px-1.5 py-0.5' : 'px-2 py-1'}`}
                  style={{
                    backgroundColor: categoryColor
                      ? `color-mix(in srgb, ${categoryColor} 15%, var(--category-bg-base, #e5e7eb))`
                      : 'var(--category-bg-base, #e5e7eb)',
                    color: categoryColor
                      ? `color-mix(in srgb, ${categoryColor} 85%, var(--category-text-mix, #000))`
                      : 'var(--category-text-base, #6b7280)',
                  }}
                  title={transaction.category!.name}
                >
                  {transaction.category!.name}
                </span>
                {budgetIndicator}
              </span>
            );
          })()
        ) : (
          <span className="text-sm text-gray-400 dark:text-gray-500">-</span>
        )}
      </td>
      <td className={`${cellPadding} text-sm text-gray-500 dark:text-gray-400 hidden xl:table-cell`}>
        <div
          className={`truncate max-w-[320px] ${isVoid ? 'line-through' : ''}`}
          title={transaction.description || undefined}
        >
          {transaction.description || '-'}
        </div>
      </td>
      <td className={`${cellPadding} whitespace-nowrap text-sm font-medium text-right ${isVoid ? 'line-through' : ''}`}>
        {formatAmount(transaction.amount, transaction.currencyCode)}
      </td>
      {isSingleAccountView && (
        <td className={`${cellPadding} whitespace-nowrap text-sm font-medium text-right`}>
          {runningBalance !== undefined
            ? formatBalance(runningBalance, transaction.currencyCode)
            : '-'}
        </td>
      )}
      <td className={`${cellPadding} whitespace-nowrap text-center hidden sm:table-cell`}>
        <button
          onClick={(e) => { e.stopPropagation(); onCycleStatus(transaction); }}
          className="text-sm px-3 py-1.5 -my-1 rounded-md hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
          title="Click to cycle status"
        >
          {transaction.status === TransactionStatus.RECONCILED ? (
            <span className="text-blue-600 dark:text-blue-400">{density === 'dense' ? 'R' : 'Reconciled'}</span>
          ) : transaction.status === TransactionStatus.CLEARED ? (
            <span className="text-green-600 dark:text-green-400">{density === 'dense' ? 'C' : 'Cleared'}</span>
          ) : transaction.status === TransactionStatus.VOID ? (
            <span className="text-red-600 dark:text-red-400">{density === 'dense' ? 'V' : 'VOID'}</span>
          ) : (
            <span className="text-gray-400 dark:text-gray-500">{density === 'dense' ? '\u25CB' : 'Pending'}</span>
          )}
        </button>
      </td>
      <td className={`${cellPadding} whitespace-nowrap text-right text-sm font-medium space-x-2 hidden min-[480px]:table-cell`}>
        {onEdit && (
          <button
            onClick={(e) => { e.stopPropagation(); onEdit(transaction); }}
            className={transaction.linkedInvestmentTransactionId
              ? "text-emerald-600 hover:text-emerald-900 dark:text-emerald-400 dark:hover:text-emerald-300"
              : "text-blue-600 hover:text-blue-900 dark:text-blue-400 dark:hover:text-blue-300"
            }
            title={transaction.linkedInvestmentTransactionId ? "View in Investments" : undefined}
          >
            {transaction.linkedInvestmentTransactionId
              ? (density === 'dense' ? '\uD83D\uDCC8' : 'View')
              : (density === 'dense' ? '\u270E' : 'Edit')}
          </button>
        )}
        {!transaction.linkedInvestmentTransactionId && (
          <button
            onClick={(e) => { e.stopPropagation(); onDeleteClick(transaction); }}
            disabled={isDeleting}
            className="text-red-600 hover:text-red-900 dark:text-red-400 dark:hover:text-red-300 disabled:opacity-50"
          >
            {isDeleting ? '...' : density === 'dense' ? '\u2715' : 'Delete'}
          </button>
        )}
      </td>
    </tr>
  );
});
