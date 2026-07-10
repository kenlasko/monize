'use client';

import { useTranslations } from 'next-intl';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { useDateFormat } from '@/hooks/useDateFormat';
import { SummaryCardGrid, SummaryCardItem } from '@/components/accounts/shared/SummaryCardGrid';
import type { StatementCycle } from '@/types/credit-card-detail';

interface StatementPanelProps {
  cycle: StatementCycle | null;
  isLoading: boolean;
}

/** Parse a `YYYY-MM-DD` string into a local Date without timezone drift. */
function toLocalDate(value: string): Date {
  const [y, m, d] = value.split('-').map(Number);
  return new Date(y, m - 1, d);
}

/**
 * The credit card's current statement cycle: window, statement balance as of
 * the last settlement, payment due countdown, and amount paid since the
 * statement. Shows a hint when no settlement day is configured.
 */
export function StatementPanel({ cycle, isLoading }: StatementPanelProps) {
  const t = useTranslations('accountDetail-creditCard');
  const { formatCurrency } = useNumberFormat();
  const { formatDate } = useDateFormat();

  if (isLoading) {
    return (
      <section aria-busy="true">
        <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">
          {t('statement.title')}
        </h2>
        <div className="h-24 rounded-lg bg-gray-100 dark:bg-gray-800 animate-pulse" />
      </section>
    );
  }

  if (!cycle) {
    return (
      <section>
        <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-2">
          {t('statement.title')}
        </h2>
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4">
          <p className="text-sm font-medium text-gray-900 dark:text-gray-100">
            {t('statement.unavailable')}
          </p>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
            {t('statement.unavailableHint')}
          </p>
        </div>
      </section>
    );
  }

  const currency = cycle.currencyCode;

  const cards: SummaryCardItem[] = [
    {
      label: t('statement.statementBalance'),
      value: formatCurrency(Math.abs(cycle.statementBalance), currency),
      // "As of" the last reconciliation; falls back to the cycle's settlement
      // date when nothing has been reconciled yet.
      note: t('statement.statementBalanceNote', {
        date: formatDate(
          toLocalDate(cycle.statementBalanceDate ?? cycle.lastSettlementDate),
        ),
      }),
    },
    {
      label: t('statement.expensesSinceStatement'),
      value: formatCurrency(cycle.expensesSinceStatement, currency),
      valueClass: 'text-red-600 dark:text-red-400',
      note: t('statement.expensesSinceStatementNote'),
    },
    {
      label: t('statement.amountPaid'),
      value: formatCurrency(cycle.amountPaidSinceStatement, currency),
      valueClass: 'text-green-600 dark:text-green-400',
    },
    {
      label: t('statement.paymentDue'),
      value: cycle.paymentDueDate
        ? formatDate(toLocalDate(cycle.paymentDueDate))
        : t('statement.noDueDate'),
      note:
        cycle.daysUntilPaymentDue != null
          ? t('statement.dueIn', { days: cycle.daysUntilPaymentDue })
          : undefined,
    },
    {
      label: t('statement.settlement'),
      value: formatDate(toLocalDate(cycle.nextSettlementDate)),
      note: t('statement.settlesIn', { days: cycle.daysUntilSettlement }),
    },
  ];

  return (
    <section>
      <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-1">
        {t('statement.title')}
      </h2>
      <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
        {t('statement.cycleWindow', {
          start: formatDate(toLocalDate(cycle.cycleStart)),
          end: formatDate(toLocalDate(cycle.cycleEnd)),
        })}
      </p>
      <SummaryCardGrid cards={cards} className="grid grid-cols-2 lg:grid-cols-5 gap-4" />
    </section>
  );
}
