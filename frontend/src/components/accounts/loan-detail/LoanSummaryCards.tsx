'use client';

import { useTranslations } from 'next-intl';
import { format, parseISO } from 'date-fns';
import { Account } from '@/types/account';
import { LoanScheduleResult } from '@/lib/loan-schedule';
import { useNumberFormat } from '@/hooks/useNumberFormat';

interface LoanSummaryCardsProps {
  account: Account;
  /** Original loan amount (opening balance or derived from history) */
  startingBalance: number;
  /** Projection from the current balance; null when the loan can't project */
  baseline: LoanScheduleResult | null;
}

/**
 * Key figures for the loan detail page: balance, original amount, rate,
 * payment, and the baseline projection's payoff date / remaining interest.
 */
export function LoanSummaryCards({ account, startingBalance, baseline }: LoanSummaryCardsProps) {
  const t = useTranslations('accounts');
  const { formatCurrency } = useNumberFormat();
  const currency = account.currencyCode;

  const isCanadianFixed = account.isCanadianMortgage && !account.isVariableRate;
  const effectiveRate =
    isCanadianFixed && account.interestRate
      ? (Math.pow(1 + account.interestRate / 100 / 2, 2) - 1) * 100
      : null;

  const frequencyLabel = account.paymentFrequency
    ? t(`loanDetail.frequency.${account.paymentFrequency}` as Parameters<typeof t>[0])
    : null;

  const payoffLabel = baseline?.payoffDate
    ? format(parseISO(baseline.payoffDate), 'MMM yyyy')
    : null;

  return (
    <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
      <SummaryCard
        label={t('loanDetail.summary.currentBalance')}
        value={formatCurrency(Math.abs(account.currentBalance), currency)}
        valueClass="text-red-600 dark:text-red-400"
      />
      <SummaryCard
        label={t('loanDetail.summary.originalAmount')}
        value={formatCurrency(startingBalance, currency)}
      />
      <SummaryCard
        label={t('loanDetail.summary.interestRate')}
        value={account.interestRate != null ? `${account.interestRate}%` : t('loanDetail.summary.notSet')}
        note={
          effectiveRate != null
            ? t('loanDetail.summary.effectiveRate', { rate: effectiveRate.toFixed(3) })
            : undefined
        }
      />
      <SummaryCard
        label={t('loanDetail.summary.payment')}
        value={account.paymentAmount ? formatCurrency(account.paymentAmount, currency) : t('loanDetail.summary.notSet')}
        note={frequencyLabel ?? undefined}
      />
      <SummaryCard
        label={t('loanDetail.summary.estPayoff')}
        value={
          Math.abs(account.currentBalance) <= 0.01
            ? t('loanDetail.summary.paidOff')
            : payoffLabel ?? t('loanDetail.summary.notAvailable')
        }
        valueClass="text-purple-600 dark:text-purple-400"
      />
      <SummaryCard
        label={t('loanDetail.summary.estRemainingInterest')}
        value={baseline ? formatCurrency(baseline.totalInterest, currency) : t('loanDetail.summary.notAvailable')}
        valueClass="text-orange-600 dark:text-orange-400"
      />
    </div>
  );
}

function SummaryCard({
  label,
  value,
  note,
  valueClass = 'text-gray-900 dark:text-gray-100',
}: {
  label: string;
  value: string;
  note?: string;
  valueClass?: string;
}) {
  return (
    <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4">
      <div className="text-sm text-gray-500 dark:text-gray-400">{label}</div>
      <div className={`text-lg font-bold ${valueClass}`}>{value}</div>
      {note && <div className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">{note}</div>}
    </div>
  );
}
