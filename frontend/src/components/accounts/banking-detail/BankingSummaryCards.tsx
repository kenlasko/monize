'use client';

import { useTranslations } from 'next-intl';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import {
  SummaryCardGrid,
  SummaryCardItem,
  summaryGridClass,
} from '@/components/accounts/shared/SummaryCardGrid';
import { UnknownAmount } from '@/components/ui/UnknownAmount';
import { balanceColor } from '@/lib/format';
import type { Account } from '@/types/account';
import type { BalanceForecastOverdue } from '@/types/banking-detail';

interface BankingSummaryCardsProps {
  account: Account;
  /**
   * `null` when the server could not complete the projection (issue #1247): the
   * current balance is NOT a stand-in, because a figure captioned "projected"
   * that equals today's is a measurement the reader did not get.
   */
  projectedBalance: number | null;
  /**
   * The overdue occurrences the projection applied (discussion #1784), named under
   * the projected figure they move, since nothing on the schedule ahead
   * explains that part of it.
   */
  overdue?: BalanceForecastOverdue | null;
  /** `null` is unknown (a failed read, a withheld total), not zero. */
  moneyIn: number | null;
  moneyOut: number | null;
  interestEarnedYtd: number;
  averageBalance: number;
  onMoneyInClick?: () => void;
  onMoneyOutClick?: () => void;
  onInterestClick?: () => void;
}

/** Key figures for a chequing/savings/cash account. */
export function BankingSummaryCards({
  account,
  projectedBalance,
  overdue = null,
  moneyIn,
  moneyOut,
  interestEarnedYtd,
  averageBalance,
  onMoneyInClick,
  onMoneyOutClick,
  onInterestClick,
}: BankingSummaryCardsProps) {
  const t = useTranslations('accountDetail-banking');
  const tc = useTranslations('common');
  const { formatCurrency, formatPercentTrimmed } = useNumberFormat();
  const currency = account.currencyCode;
  const currentBalance = Number(account.currentBalance) || 0;

  const cards: SummaryCardItem[] = [
    {
      label: t('summary.currentBalance'),
      value: formatCurrency(currentBalance, currency),
      valueClass: balanceColor(currentBalance),
    },
    {
      label: t('summary.projectedBalance'),
      value:
        projectedBalance === null ? (
          <UnknownAmount />
        ) : (
          formatCurrency(projectedBalance, currency)
        ),
      valueClass: projectedBalance === null ? undefined : balanceColor(projectedBalance),
      note:
        projectedBalance !== null && overdue !== null ? (
          <>
            {t('summary.projectedNote')}
            <span className="block">
              {tc('scheduledOverdue.included', { count: overdue.count })}
            </span>
          </>
        ) : (
          t('summary.projectedNote')
        ),
    },
    {
      label: t('summary.moneyIn'),
      value: moneyIn === null ? <UnknownAmount reason="displayFx" /> : formatCurrency(Math.abs(moneyIn), currency),
      valueClass: 'text-green-600 dark:text-green-400',
      note: t('summary.thisMonth'),
      onClick: onMoneyInClick,
    },
    {
      label: t('summary.moneyOut'),
      value: moneyOut === null ? <UnknownAmount reason="displayFx" /> : formatCurrency(Math.abs(moneyOut), currency),
      valueClass: 'text-red-600 dark:text-red-400',
      note: t('summary.thisMonth'),
      onClick: onMoneyOutClick,
    },
    {
      label: t('summary.averageBalance'),
      value: formatCurrency(averageBalance, currency),
      note: t('summary.averageNote'),
    },
  ];

  if (account.interestRate != null) {
    cards.push({
      label: t('summary.interestRate'),
      value: `${formatPercentTrimmed(account.interestRate)}`,
    });
  }

  if (interestEarnedYtd > 0) {
    cards.push({
      label: t('summary.interestEarnedYtd'),
      value: formatCurrency(interestEarnedYtd, currency),
      valueClass: 'text-green-600 dark:text-green-400',
      note: t('summary.ytd'),
      onClick: onInterestClick,
    });
  }

  // Five, six or seven cards depending on the account's interest, so the grid
  // is sized to the row rather than fixed.
  return <SummaryCardGrid cards={cards} className={summaryGridClass(cards.length)} />;
}
