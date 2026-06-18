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

  const title =
    type === 'create_transaction'
      ? t('confirmAction.createTransactionTitle')
      : type === 'categorize_transaction'
        ? t('confirmAction.categorizeTitle')
        : type === 'create_investment_transaction'
          ? t('confirmAction.createInvestmentTransactionTitle')
          : t('confirmAction.createPayeeTitle');

  const none = t('confirmAction.none');
  const rows: Array<{ label: string; value: string }> = [];

  if (type === 'create_transaction') {
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
    rows.push({
      label: t('confirmAction.category'),
      value: preview.categoryName || none,
    });
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
  } else if (type === 'create_investment_transaction') {
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
  } else {
    rows.push({
      label: t('confirmAction.name'),
      value: preview.name || none,
    });
    rows.push({
      label: t('confirmAction.category'),
      value: preview.categoryName || none,
    });
  }

  const isInvestmentResult = type === 'create_investment_transaction';
  const isTransactionResult =
    type === 'create_transaction' || type === 'categorize_transaction';
  // The created/updated record's home, surfaced as a "view" link on success.
  const viewLink = isInvestmentResult
    ? { href: '/investments', label: t('confirmAction.viewInvestments') }
    : isTransactionResult
      ? { href: '/transactions', label: t('confirmAction.viewTransaction') }
      : null;
  const successMessage =
    type === 'create_transaction'
      ? t('confirmAction.createdTransaction')
      : type === 'categorize_transaction'
        ? t('confirmAction.categorized')
        : type === 'create_investment_transaction'
          ? t('confirmAction.createdInvestmentTransaction')
          : t('confirmAction.createdPayee');

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
