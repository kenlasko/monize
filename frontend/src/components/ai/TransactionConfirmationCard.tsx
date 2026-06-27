'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/Button';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import type { PendingAction } from '@/types/ai';

interface TransactionConfirmationCardProps {
  action: PendingAction;
  onConfirm: () => void;
  onCancel: () => void;
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-3 text-sm">
      <span className="text-gray-500 dark:text-gray-400">{label}</span>
      <span className="text-gray-900 dark:text-gray-100 text-right break-words">
        {value}
      </span>
    </div>
  );
}

export function TransactionConfirmationCard({
  action,
  onConfirm,
  onCancel,
}: TransactionConfirmationCardProps) {
  const t = useTranslations('ai');
  const { formatCurrency, formatCurrencyPrecise, formatQuantity } =
    useNumberFormat();
  const { preview, type, status } = action;

  // Create, update, and delete share the same field layout per domain (cash vs
  // investment); only the title and success copy differ.
  const isCashTxType =
    type === 'create_transaction' ||
    type === 'update_transaction' ||
    type === 'delete_transaction';
  const isInvestmentTxType =
    type === 'create_investment_transaction' ||
    type === 'update_investment_transaction' ||
    type === 'delete_investment_transaction';
  const isTransferType =
    type === 'create_transfer' || type === 'update_transfer';

  const titleByType: Partial<Record<typeof type, string>> = {
    create_transaction: t('confirmAction.createTransactionTitle'),
    update_transaction: t('confirmAction.updateTransactionTitle'),
    delete_transaction: t('confirmAction.deleteTransactionTitle'),
    categorize_transaction: t('confirmAction.categorizeTitle'),
    create_investment_transaction: t(
      'confirmAction.createInvestmentTransactionTitle',
    ),
    update_investment_transaction: t(
      'confirmAction.updateInvestmentTransactionTitle',
    ),
    delete_investment_transaction: t(
      'confirmAction.deleteInvestmentTransactionTitle',
    ),
    create_security: t('confirmAction.createSecurityTitle'),
    update_security: t('confirmAction.updateSecurityTitle'),
    delete_security: t('confirmAction.deleteSecurityTitle'),
    create_payee: t('confirmAction.createPayeeTitle'),
    update_payee: t('confirmAction.updatePayeeTitle'),
    delete_payee: t('confirmAction.deletePayeeTitle'),
    create_transfer: t('confirmAction.createTransferTitle'),
    update_transfer: t('confirmAction.updateTransferTitle'),
  };
  const title = titleByType[type] ?? t('confirmAction.createPayeeTitle');

  const none = t('confirmAction.none');
  const rows: Array<{ label: string; value: string }> = [];

  if (isCashTxType) {
    if (preview.accountName)
      rows.push({ label: t('confirmAction.account'), value: preview.accountName });
    if (preview.amount !== undefined)
      rows.push({
        label: t('confirmAction.amount'),
        value: formatCurrency(preview.amount, preview.currencyCode),
      });
    if (preview.transactionDate)
      rows.push({ label: t('confirmAction.date'), value: preview.transactionDate });
    rows.push({
      label: t('confirmAction.payee'),
      value: preview.payeeName
        ? preview.payeeWillBeCreated
          ? `${preview.payeeName} ${t('confirmAction.newPayee')}`
          : preview.payeeName
        : none,
    });
    // A split transaction shows its per-category breakdown in place of the
    // single category row.
    if (preview.splits && preview.splits.length > 0) {
      preview.splits.forEach((split, i) => {
        const label =
          i === 0 ? t('confirmAction.splits') : '';
        const category = split.categoryName || none;
        rows.push({
          label,
          value: split.memo
            ? `${category}: ${formatCurrency(split.amount, preview.currencyCode)} (${split.memo})`
            : `${category}: ${formatCurrency(split.amount, preview.currencyCode)}`,
        });
      });
    } else {
      rows.push({
        label: t('confirmAction.category'),
        value: preview.categoryName || none,
      });
    }
    if (preview.description)
      rows.push({
        label: t('confirmAction.description'),
        value: preview.description,
      });
  } else if (type === 'categorize_transaction') {
    if (preview.payeeName)
      rows.push({ label: t('confirmAction.payee'), value: preview.payeeName });
    if (preview.amount !== undefined)
      rows.push({
        label: t('confirmAction.amount'),
        value: formatCurrency(preview.amount, preview.currencyCode),
      });
    if (preview.transactionDate)
      rows.push({ label: t('confirmAction.date'), value: preview.transactionDate });
    rows.push({
      label: t('confirmAction.currentCategory'),
      value: preview.currentCategoryName || none,
    });
    rows.push({
      label: t('confirmAction.newCategory'),
      value: preview.newCategoryName || none,
    });
  } else if (isInvestmentTxType) {
    if (preview.accountName)
      rows.push({ label: t('confirmAction.account'), value: preview.accountName });
    if (preview.investmentAction)
      rows.push({
        label: t('confirmAction.investmentType'),
        value: t(
          `confirmAction.investmentActions.${preview.investmentAction}` as Parameters<
            typeof t
          >[0],
        ),
      });
    if (preview.transactionDate)
      rows.push({ label: t('confirmAction.date'), value: preview.transactionDate });
    if (preview.symbol)
      rows.push({
        label: t('confirmAction.security'),
        value: preview.securityName
          ? `${preview.symbol} (${preview.securityName})`
          : preview.symbol,
      });
    if (preview.quantity !== undefined && preview.quantity !== null)
      rows.push({
        label: t('confirmAction.shares'),
        value: formatQuantity(preview.quantity),
      });
    if (preview.price !== undefined && preview.price !== null)
      rows.push({
        label: t('confirmAction.price'),
        value: formatCurrencyPrecise(preview.price, preview.securityCurrency ?? undefined),
      });
    if (preview.commission)
      rows.push({
        label: t('confirmAction.commission'),
        value: formatCurrency(preview.commission, preview.securityCurrency ?? undefined),
      });
    // Share-only actions (transfers, splits, share adjustments) carry no cash
    // total, so only surface it when there is one.
    if (preview.totalAmount)
      rows.push({
        label: t('confirmAction.total'),
        value: formatCurrency(preview.totalAmount, preview.securityCurrency ?? undefined),
      });
    if (
      preview.cashAccountName &&
      preview.cashAmount !== undefined &&
      preview.cashAmount !== null
    )
      rows.push({
        label: t('confirmAction.cashImpact'),
        value: `${formatCurrency(preview.cashAmount, preview.cashCurrency ?? undefined)} (${preview.cashAccountName})`,
      });
    if (preview.description)
      rows.push({
        label: t('confirmAction.description'),
        value: preview.description,
      });
  } else if (isTransferType) {
    if (preview.fromAccountName)
      rows.push({
        label: t('confirmAction.fromAccount'),
        value: preview.fromAccountName,
      });
    if (preview.toAccountName)
      rows.push({
        label: t('confirmAction.toAccount'),
        value: preview.toAccountName,
      });
    if (preview.amount !== undefined)
      rows.push({
        label: t('confirmAction.amount'),
        value: formatCurrency(preview.amount, preview.currencyCode),
      });
    // Only surface the destination amount for a cross-currency transfer, where
    // it differs from the source amount/currency.
    if (
      preview.toAmount !== undefined &&
      preview.toAmount !== null &&
      (preview.toCurrencyCode !== preview.currencyCode ||
        preview.toAmount !== preview.amount)
    )
      rows.push({
        label: t('confirmAction.toAmount'),
        value: formatCurrency(
          preview.toAmount,
          preview.toCurrencyCode ?? undefined,
        ),
      });
    if (preview.transactionDate)
      rows.push({ label: t('confirmAction.date'), value: preview.transactionDate });
    if (preview.payeeName)
      rows.push({
        label: t('confirmAction.payee'),
        value: preview.payeeWillBeCreated
          ? `${preview.payeeName} ${t('confirmAction.newPayee')}`
          : preview.payeeName,
      });
    if (preview.categoryName)
      rows.push({
        label: t('confirmAction.category'),
        value: preview.categoryName,
      });
    if (preview.description)
      rows.push({
        label: t('confirmAction.description'),
        value: preview.description,
      });
  } else if (type === 'delete_security') {
    if (preview.symbol)
      rows.push({ label: t('confirmAction.symbol'), value: preview.symbol });
    if (preview.securityName)
      rows.push({ label: t('confirmAction.name'), value: preview.securityName });
  } else if (type === 'create_security' || type === 'update_security') {
    if (preview.symbol)
      rows.push({ label: t('confirmAction.symbol'), value: preview.symbol });
    if (preview.securityName)
      rows.push({ label: t('confirmAction.name'), value: preview.securityName });
    rows.push({
      label: t('confirmAction.securityType'),
      value: preview.securityType || none,
    });
    rows.push({
      label: t('confirmAction.exchange'),
      value: preview.exchange || none,
    });
    if (preview.securityCurrency)
      rows.push({
        label: t('confirmAction.currency'),
        value: preview.securityCurrency,
      });
    if (preview.isFavourite)
      rows.push({
        label: t('confirmAction.favourite'),
        value: t('confirmAction.favouriteYes'),
      });
  } else if (type === 'delete_payee') {
    rows.push({
      label: t('confirmAction.name'),
      value: preview.name || none,
    });
  } else {
    // create_payee | update_payee
    rows.push({
      label: t('confirmAction.name'),
      value: preview.name || none,
    });
    rows.push({
      label: t('confirmAction.category'),
      value: preview.categoryName || none,
    });
  }

  const isSecurityResult =
    type === 'create_security' || type === 'update_security';
  const isPayeeWriteType = type === 'create_payee' || type === 'update_payee';
  // A deletion removes the record, so there is nothing to navigate to.
  const isDeletion =
    type === 'delete_transaction' ||
    type === 'delete_investment_transaction' ||
    type === 'delete_payee' ||
    type === 'delete_security';
  // The affected record's home, surfaced as a "view" link on success. For
  // list-backed destinations we deep-link to the created/edited record
  // (?highlight=<id>) so the list flashes and scrolls to it; without a result
  // id we fall back to the plain list.
  const highlightHref = (base: string) =>
    action.resultId ? `${base}?highlight=${action.resultId}` : base;
  const viewLink = isDeletion
    ? null
    : isInvestmentTxType
      ? { href: '/investments', label: t('confirmAction.viewInvestments') }
      : isSecurityResult
        ? { href: highlightHref('/securities'), label: t('confirmAction.viewSecurities') }
        : isPayeeWriteType
          ? { href: highlightHref('/payees'), label: t('confirmAction.viewPayees') }
          : isCashTxType || isTransferType || type === 'categorize_transaction'
            ? {
                // Deep-link to the affected transaction so the list jumps to and
                // flashes that row; fall back to the unfiltered list if the id
                // is missing (e.g. an older pending action without a result).
                href: action.resultId
                  ? `/transactions?targetTransactionId=${action.resultId}`
                  : '/transactions',
                label: t('confirmAction.viewTransaction'),
              }
            : null;
  const successByType: Partial<Record<typeof type, string>> = {
    create_transaction: t('confirmAction.createdTransaction'),
    update_transaction: t('confirmAction.updatedTransaction'),
    delete_transaction: t('confirmAction.deletedTransaction'),
    categorize_transaction: t('confirmAction.categorized'),
    create_investment_transaction: t(
      'confirmAction.createdInvestmentTransaction',
    ),
    update_investment_transaction: t(
      'confirmAction.updatedInvestmentTransaction',
    ),
    delete_investment_transaction: t(
      'confirmAction.deletedInvestmentTransaction',
    ),
    create_security: t('confirmAction.createdSecurity'),
    update_security: t('confirmAction.updatedSecurity'),
    delete_security: t('confirmAction.deletedSecurity'),
    create_payee: t('confirmAction.createdPayee'),
    update_payee: t('confirmAction.updatedPayee'),
    delete_payee: t('confirmAction.deletedPayee'),
    create_transfer: t('confirmAction.createdTransfer'),
    update_transfer: t('confirmAction.updatedTransfer'),
  };
  const successMessage =
    successByType[type] ?? t('confirmAction.createdPayee');

  return (
    <div className="rounded-lg border border-blue-200 dark:border-blue-900/60 bg-blue-50/60 dark:bg-blue-900/20 overflow-hidden">
      <div className="px-3 py-2 border-b border-blue-200 dark:border-blue-900/60">
        <span className="text-sm font-semibold text-blue-800 dark:text-blue-200">
          {title}
        </span>
      </div>
      <div className="px-3 py-2 space-y-1">
        {rows.map((row, i) => (
          <Row key={i} label={row.label} value={row.value} />
        ))}
        {preview.isReconciled &&
          (type === 'update_transaction' ||
            type === 'delete_transaction') && (
            <p className="text-xs text-amber-700 dark:text-amber-400 pt-1">
              {t('confirmAction.reconciledWarning')}
            </p>
          )}
      </div>
      <div className="px-3 py-2 border-t border-blue-200 dark:border-blue-900/60">
        {status === 'pending' && (
          <div className="flex gap-2 justify-end">
            <Button variant="outline" size="sm" onClick={onCancel}>
              {t('confirmAction.cancel')}
            </Button>
            <Button variant="primary" size="sm" onClick={onConfirm}>
              {t('confirmAction.approve')}
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
            </span>
            {viewLink && (
              <Link
                href={viewLink.href}
                className="text-blue-600 dark:text-blue-400 hover:underline"
              >
                {viewLink.label}
              </Link>
            )}
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
