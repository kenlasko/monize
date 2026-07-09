'use client';

import { useTranslations } from 'next-intl';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { useDateFormat } from '@/hooks/useDateFormat';
import { computeAppreciation } from '@/lib/asset-equity';
import { SummaryCardGrid, SummaryCardItem } from '@/components/accounts/shared/SummaryCardGrid';
import type { Account } from '@/types/account';

interface AssetSummaryCardsProps {
  account: Account;
  categoryName: string | null;
}

/** Parse a `YYYY-MM-DD` string into a local Date without timezone drift. */
function toLocalDate(value: string): Date {
  const [y, m, d] = value.split('-').map(Number);
  return new Date(y, m - 1, d);
}

/** Key figures for an asset/other account: value, purchase, appreciation, category. */
export function AssetSummaryCards({ account, categoryName }: AssetSummaryCardsProps) {
  const t = useTranslations('accountDetail-asset');
  const { formatCurrency, formatPercent } = useNumberFormat();
  const { formatDate } = useDateFormat();
  const currency = account.currencyCode;

  const currentValue = Number(account.currentBalance) || 0;
  const purchaseValue = Number(account.openingBalance) || 0;
  const appreciation = computeAppreciation(
    currentValue,
    purchaseValue,
    account.dateAcquired,
    new Date(),
  );
  const gainClass =
    appreciation.total < 0
      ? 'text-red-600 dark:text-red-400'
      : 'text-green-600 dark:text-green-400';

  const cards: SummaryCardItem[] = [
    {
      label: t('summary.currentValue'),
      value: formatCurrency(currentValue, currency),
    },
    {
      label: t('summary.purchaseValue'),
      value: formatCurrency(purchaseValue, currency),
      note: account.dateAcquired
        ? t('summary.acquired', { date: formatDate(toLocalDate(account.dateAcquired)) })
        : undefined,
    },
    {
      label: t('summary.appreciation'),
      value: formatCurrency(appreciation.total, currency),
      valueClass: gainClass,
      note:
        purchaseValue !== 0 ? `${appreciation.totalPercent >= 0 ? '+' : ''}${formatPercent(appreciation.totalPercent)}` : undefined,
    },
    {
      label: t('summary.annualized'),
      value:
        appreciation.annualizedPercent != null
          ? `${appreciation.annualizedPercent >= 0 ? '+' : ''}${formatPercent(appreciation.annualizedPercent)}`
          : t('summary.notSet'),
      valueClass:
        appreciation.annualizedPercent != null && appreciation.annualizedPercent < 0
          ? 'text-red-600 dark:text-red-400'
          : appreciation.annualizedPercent != null
            ? 'text-green-600 dark:text-green-400'
            : undefined,
    },
    {
      label: t('summary.category'),
      value: categoryName ?? t('summary.notSet'),
    },
  ];

  return (
    <SummaryCardGrid cards={cards} className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4" />
  );
}
