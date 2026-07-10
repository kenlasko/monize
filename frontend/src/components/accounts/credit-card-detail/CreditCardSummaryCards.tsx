'use client';

import { useTranslations } from 'next-intl';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { utilizationColour } from '@/lib/credit-utilization';
import { SummaryCardGrid, SummaryCardItem } from '@/components/accounts/shared/SummaryCardGrid';
import type { Account } from '@/types/account';

interface CreditCardSummaryCardsProps {
  account: Account;
}

/** Key figures for a credit card: balance, limit, available, utilization, rate. */
export function CreditCardSummaryCards({ account }: CreditCardSummaryCardsProps) {
  const t = useTranslations('accountDetail-creditCard');
  const { formatCurrency } = useNumberFormat();
  const currency = account.currencyCode;

  const used = Math.abs(Number(account.currentBalance) || 0);
  const limit = Number(account.creditLimit) || 0;
  const hasLimit = limit > 0;
  const available = Math.max(0, limit - used);
  const utilizationPercent = hasLimit ? (used / limit) * 100 : 0;

  const cards: SummaryCardItem[] = [
    {
      label: t('summary.currentBalance'),
      value: formatCurrency(used, currency),
      valueClass: 'text-red-600 dark:text-red-400',
    },
    {
      label: t('summary.creditLimit'),
      value: hasLimit ? formatCurrency(limit, currency) : t('summary.notSet'),
    },
    {
      label: t('summary.availableCredit'),
      value: hasLimit ? formatCurrency(available, currency) : t('summary.notSet'),
      valueClass: hasLimit ? 'text-green-600 dark:text-green-400' : undefined,
    },
    {
      label: t('summary.interestRate'),
      value: account.interestRate != null ? `${account.interestRate}%` : t('summary.notSet'),
    },
  ];

  if (hasLimit) {
    cards.push({
      label: t('summary.utilization'),
      value: (
        <span style={{ color: utilizationColour(utilizationPercent) }}>
          {utilizationPercent.toFixed(1)}%
        </span>
      ),
      note: (
        <div className="mt-2 h-2 rounded-full bg-gray-200 dark:bg-gray-700 overflow-hidden">
          <div
            className="h-full rounded-full"
            style={{
              width: `${Math.min(100, utilizationPercent)}%`,
              backgroundColor: utilizationColour(utilizationPercent),
            }}
          />
        </div>
      ),
    });
  }

  return (
    <SummaryCardGrid
      cards={cards}
      className={`grid grid-cols-2 md:grid-cols-3 ${hasLimit ? 'lg:grid-cols-5' : 'lg:grid-cols-4'} gap-4`}
    />
  );
}
