'use client';

import { type CategoryType, categoryTypeOf } from '@/lib/category-type';
import { useTranslations } from 'next-intl';
import { KeyValueList, type KeyValueRow } from '@/components/ui/KeyValueList';
import { useDateFormat } from '@/hooks/useDateFormat';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import type { CategoryDetail } from '@/types/category';

/** Beyond this many, the payee names give way to a "+N" tail. */
const MAX_DEFAULT_PAYEE_LINKS = 4;

interface CategoryKeyInfoCardProps {
  detail: CategoryDetail;
  /** The parent's name, resolved by the page from its category list. */
  parentName: string | null;
  /** Open the parent category's own detail page. */
  onSelectParent: () => void;
  /** Narrow the register to one day (for the largest transaction). */
  onSelectDate: (date: string) => void;
  /** Open a payee's detail page (for the default-category designations). */
  onSelectPayee: (payeeId: string) => void;
}

/**
 * The reference facts about the category, beside the chart. Rows without a
 * value are dropped by `KeyValueList`, so a fresh category shows a short list
 * rather than a column of dashes.
 */
export function CategoryKeyInfoCard({
  detail,
  parentName,
  onSelectParent,
  onSelectDate,
  onSelectPayee,
}: CategoryKeyInfoCardProps) {
  const t = useTranslations('categoryDetail');
  const { formatDate } = useDateFormat();
  const { formatCurrency, formatNumber } = useNumberFormat();

  const { category, stats, largestTransaction, defaultCategoryForPayees } = detail;

  const shownPayees = defaultCategoryForPayees.slice(0, MAX_DEFAULT_PAYEE_LINKS);
  const hiddenPayeeCount = defaultCategoryForPayees.length - shownPayees.length;

  const typeLabel = (type: CategoryType) => {
    switch (type) {
      case 'income':
        return t('keyInfo.income');
      case 'transfer':
        return t('keyInfo.transfer');
      default:
        return t('keyInfo.expense');
    }
  };

  const rows: KeyValueRow[] = [
    {
      key: 'type',
      label: t('keyInfo.type'),
      value: typeLabel(categoryTypeOf(category)),
    },
    {
      key: 'parent',
      label: t('keyInfo.parent'),
      value: parentName ? (
        <button
          type="button"
          onClick={onSelectParent}
          className="text-right text-blue-600 hover:underline dark:text-blue-400"
        >
          {parentName}
        </button>
      ) : null,
    },
    {
      key: 'subcategories',
      label: t('keyInfo.subcategories'),
      value: stats.subcategoryCount > 0 ? formatNumber(stats.subcategoryCount, 0) : null,
    },
    {
      key: 'payees',
      label: t('keyInfo.payees'),
      value: stats.payeeCount > 0 ? formatNumber(stats.payeeCount, 0) : null,
    },
    {
      key: 'created',
      label: t('keyInfo.created'),
      value: category.createdAt ? formatDate(category.createdAt) : null,
    },
    {
      key: 'firstTransaction',
      label: t('keyInfo.firstTransaction'),
      value: stats.firstTransactionDate ? formatDate(stats.firstTransactionDate) : null,
    },
    {
      key: 'largestTransaction',
      label: t('keyInfo.largestTransaction'),
      value: largestTransaction ? (
        <button
          type="button"
          onClick={() => onSelectDate(largestTransaction.transactionDate)}
          className="text-right text-blue-600 hover:underline dark:text-blue-400"
        >
          {t('keyInfo.largestValue', {
            amount: formatCurrency(
              Math.abs(largestTransaction.amount),
              largestTransaction.currencyCode,
            ),
            date: formatDate(largestTransaction.transactionDate),
          })}
        </button>
      ) : null,
    },
    {
      key: 'defaultFor',
      label: t('keyInfo.defaultFor'),
      value:
        defaultCategoryForPayees.length > 0 ? (
          <span className="inline-flex flex-wrap justify-end gap-x-2">
            {shownPayees.map((payee) => (
              <button
                key={payee.payeeId}
                type="button"
                onClick={() => onSelectPayee(payee.payeeId)}
                className="text-blue-600 hover:underline dark:text-blue-400"
              >
                {payee.payeeName}
              </button>
            ))}
            {hiddenPayeeCount > 0 && (
              <span className="text-gray-500 dark:text-gray-400">
                {t('keyInfo.defaultForMore', { count: hiddenPayeeCount })}
              </span>
            )}
          </span>
        ) : null,
    },
    {
      key: 'description',
      label: t('keyInfo.description'),
      value: category.description || null,
    },
  ];

  return (
    <div className="rounded-lg bg-white p-4 shadow dark:bg-gray-800 dark:shadow-gray-700/50">
      <h3 className="mb-3 text-lg font-semibold text-gray-900 dark:text-gray-100">
        {t('keyInfo.title')}
      </h3>
      <KeyValueList rows={rows} />
    </div>
  );
}
