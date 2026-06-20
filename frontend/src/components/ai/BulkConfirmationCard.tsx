'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/Button';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import type { PendingAction, PendingActionPreviewRow } from '@/types/ai';

interface BulkConfirmationCardProps {
  action: PendingAction;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * Confirmation card for the bulk "paste a table" actions
 * (`create_transactions`, `create_investment_transactions`). Renders one row
 * per parsed entry with a per-row badge for flagged rows that will be skipped,
 * and a single Approve all / Cancel control. The signed descriptor only carries
 * the valid rows; flagged rows are shown for transparency but never created.
 */
export function BulkConfirmationCard({
  action,
  onConfirm,
  onCancel,
}: BulkConfirmationCardProps) {
  const t = useTranslations('ai');
  const { formatCurrency, formatCurrencyPrecise, formatQuantity } =
    useNumberFormat();
  const { preview, type, status } = action;
  // The generic batch envelope carries the operation on the (verbatim)
  // descriptor; standard create-bulk uses the dedicated create_transactions type.
  const batchOp =
    type === 'batch_actions'
      ? (action.descriptor as { operation?: string }).operation
      : undefined;
  // Investment rows: the dedicated bulk-create type, or a batch_actions envelope
  // carrying investment edits/deletions.
  const isInvestment =
    type === 'create_investment_transactions' ||
    batchOp === 'update_investment' ||
    batchOp === 'delete_investment';
  const isTransfer = batchOp === 'create_transfer';
  const isPayee =
    batchOp === 'create_payee' ||
    batchOp === 'update_payee' ||
    batchOp === 'delete_payee';
  const isSecurity =
    batchOp === 'create_security' ||
    batchOp === 'update_security' ||
    batchOp === 'delete_security';

  const rows = preview.rows ?? [];
  const validCount = rows.filter((r) => r.status === 'ok').length;
  const flaggedCount = rows.length - validCount;

  const title =
    batchOp === 'update_investment'
      ? t('confirmAction.updateInvestmentTransactionsTitle')
      : batchOp === 'delete_investment'
        ? t('confirmAction.deleteInvestmentTransactionsTitle')
        : type === 'create_investment_transactions'
          ? t('confirmAction.createInvestmentTransactionsTitle')
          : batchOp === 'create_payee'
            ? t('confirmAction.createPayeesTitle')
            : batchOp === 'update_payee'
              ? t('confirmAction.updatePayeesTitle')
              : batchOp === 'delete_payee'
                ? t('confirmAction.deletePayeesTitle')
                : batchOp === 'create_security'
                  ? t('confirmAction.createSecuritiesTitle')
                  : batchOp === 'update_security'
                    ? t('confirmAction.updateSecuritiesTitle')
                    : batchOp === 'delete_security'
                      ? t('confirmAction.deleteSecuritiesTitle')
                      : batchOp === 'update'
                  ? t('confirmAction.updateTransactionsTitle')
                  : batchOp === 'delete'
                    ? t('confirmAction.deleteTransactionsTitle')
                    : isTransfer
                      ? t('confirmAction.createTransfersTitle')
                      : t('confirmAction.createTransactionsTitle');

  const viewLink = isInvestment
    ? { href: '/investments', label: t('confirmAction.viewInvestments') }
    : isPayee
      ? { href: '/payees', label: t('confirmAction.viewPayees') }
      : isSecurity
        ? { href: '/securities', label: t('confirmAction.viewSecurities') }
        : { href: '/transactions', label: t('confirmAction.viewTransaction') };

  // On success, prefer the server's actual affected count; fall back to the
  // number of valid rows the card displayed.
  const createdCount = action.resultCount ?? validCount;
  const successMessage =
    batchOp === 'update_investment'
      ? t('confirmAction.updatedInvestmentTransactions', { count: createdCount })
      : batchOp === 'delete_investment'
        ? t('confirmAction.deletedInvestmentTransactions', {
            count: createdCount,
          })
        : type === 'create_investment_transactions'
          ? t('confirmAction.createdInvestmentTransactions', {
              count: createdCount,
            })
          : batchOp === 'create_payee'
            ? t('confirmAction.createdPayees', { count: createdCount })
            : batchOp === 'update_payee'
              ? t('confirmAction.updatedPayees', { count: createdCount })
              : batchOp === 'delete_payee'
                ? t('confirmAction.deletedPayees', { count: createdCount })
                : batchOp === 'create_security'
                  ? t('confirmAction.createdSecurities', { count: createdCount })
                  : batchOp === 'update_security'
                    ? t('confirmAction.updatedSecurities', {
                        count: createdCount,
                      })
                    : batchOp === 'delete_security'
                      ? t('confirmAction.deletedSecurities', {
                          count: createdCount,
                        })
                      : batchOp === 'update'
                  ? t('confirmAction.updatedTransactions', { count: createdCount })
                  : batchOp === 'delete'
                    ? t('confirmAction.deletedTransactions', {
                        count: createdCount,
                      })
                    : isTransfer
                      ? t('confirmAction.createdTransfers', { count: createdCount })
                      : t('confirmAction.createdTransactions', {
                          count: createdCount,
                        });
  const skippedAtConfirm = action.resultSkipped?.length ?? 0;

  function describeRow(row: PendingActionPreviewRow): {
    primary: string;
    secondary: string;
  } {
    const date = row.transactionDate ?? '';
    if (isInvestment) {
      const actionLabel = row.investmentAction
        ? t(
            `confirmAction.investmentActions.${row.investmentAction}` as Parameters<
              typeof t
            >[0],
          )
        : '';
      const symbol = row.symbol ?? '';
      const primary = [date, [actionLabel, symbol].filter(Boolean).join(' ')]
        .filter(Boolean)
        .join(' · ');
      const parts: string[] = [];
      if (row.quantity !== undefined && row.quantity !== null) {
        const priceText =
          row.price !== undefined && row.price !== null
            ? ` @ ${formatCurrencyPrecise(row.price, row.securityCurrency ?? undefined)}`
            : '';
        parts.push(`${formatQuantity(row.quantity)}${priceText}`);
      }
      if (row.totalAmount) {
        parts.push(
          formatCurrency(row.totalAmount, row.securityCurrency ?? undefined),
        );
      }
      return { primary, secondary: parts.join(' · ') };
    }
    if (isTransfer) {
      const route = [row.fromAccountName, row.toAccountName]
        .filter(Boolean)
        .join(' → ');
      const primary = [date, route].filter(Boolean).join(' · ');
      const parts: string[] = [];
      if (row.amount !== undefined) {
        parts.push(formatCurrency(row.amount, row.currencyCode));
      }
      if (
        row.toAmount !== undefined &&
        row.toAmount !== null &&
        (row.toCurrencyCode !== row.currencyCode || row.toAmount !== row.amount)
      ) {
        parts.push(
          `→ ${formatCurrency(row.toAmount, row.toCurrencyCode ?? undefined)}`,
        );
      }
      if (row.payeeName)
        parts.push(
          row.payeeWillBeCreated
            ? `${row.payeeName} ${t('confirmAction.newPayee')}`
            : row.payeeName,
        );
      return { primary, secondary: parts.join(' · ') };
    }
    if (isPayee) {
      return {
        primary: row.name || '',
        secondary: row.categoryName || '',
      };
    }
    if (isSecurity) {
      return {
        primary: row.symbol || '',
        secondary: row.securityName || '',
      };
    }
    const payee = row.payeeName || row.accountName || '';
    const primary = [date, payee].filter(Boolean).join(' · ');
    const parts: string[] = [];
    if (row.amount !== undefined) {
      parts.push(formatCurrency(row.amount, row.currencyCode));
    }
    if (row.categoryName) parts.push(row.categoryName);
    return { primary, secondary: parts.join(' · ') };
  }

  return (
    <div className="rounded-lg border border-blue-200 dark:border-blue-900/60 bg-blue-50/60 dark:bg-blue-900/20 overflow-hidden">
      <div className="px-3 py-2 border-b border-blue-200 dark:border-blue-900/60 flex items-center justify-between gap-2">
        <span className="text-sm font-semibold text-blue-800 dark:text-blue-200">
          {title}
        </span>
        <span className="text-xs text-blue-700/80 dark:text-blue-300/80">
          {t('confirmAction.bulkRowSummary', {
            valid: validCount,
            skipped: flaggedCount,
          })}
        </span>
      </div>
      <div className="max-h-64 overflow-y-auto divide-y divide-blue-100 dark:divide-blue-900/40">
        {rows.map((row, i) => {
          const { primary, secondary } = describeRow(row);
          const isError = row.status === 'error';
          return (
            <div
              key={i}
              className={`px-3 py-1.5 text-sm ${isError ? 'opacity-70' : ''}`}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-gray-900 dark:text-gray-100 break-words">
                  {primary || `#${i + 1}`}
                </span>
                {isError && (
                  <span className="flex-shrink-0 text-[10px] uppercase tracking-wide rounded px-1.5 py-0.5 bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-300">
                    {t('confirmAction.rowSkippedBadge')}
                  </span>
                )}
              </div>
              {!isError && secondary && (
                <div className="text-xs text-gray-500 dark:text-gray-400">
                  {secondary}
                </div>
              )}
              {isError && row.error && (
                <div className="text-xs text-amber-700 dark:text-amber-400">
                  {row.error}
                </div>
              )}
            </div>
          );
        })}
      </div>
      <div className="px-3 py-2 border-t border-blue-200 dark:border-blue-900/60">
        {status === 'pending' && (
          <div className="flex gap-2 justify-end">
            <Button variant="outline" size="sm" onClick={onCancel}>
              {t('confirmAction.cancel')}
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={onConfirm}
              disabled={validCount === 0}
            >
              {t('confirmAction.approveAll')}
            </Button>
          </div>
        )}
        {status === 'confirming' && (
          <div className="flex justify-end">
            <Button variant="primary" size="sm" isLoading disabled>
              {t('confirmAction.submitting')}
            </Button>
          </div>
        )}
        {status === 'confirmed' && (
          <div className="flex items-center justify-between gap-2 text-sm">
            <span className="text-green-700 dark:text-green-400 font-medium">
              {successMessage}
              {skippedAtConfirm > 0 &&
                ` · ${t('confirmAction.rowsSkipped', { count: skippedAtConfirm })}`}
            </span>
            <Link
              href={viewLink.href}
              className="text-blue-600 dark:text-blue-400 hover:underline"
            >
              {viewLink.label}
            </Link>
          </div>
        )}
        {status === 'cancelled' && (
          <span className="text-sm text-gray-500 dark:text-gray-400">
            {t('confirmAction.cancelled')}
          </span>
        )}
        {status === 'expired' && (
          <span className="text-sm text-gray-500 dark:text-gray-400">
            {t('confirmAction.expired')}
          </span>
        )}
        {status === 'error' && (
          <div className="flex items-center justify-between gap-2 text-sm">
            <span className="text-red-600 dark:text-red-400">
              {action.errorMessage || t('confirmAction.error')}
            </span>
            <Button variant="outline" size="sm" onClick={onConfirm}>
              {t('confirmAction.retry')}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
