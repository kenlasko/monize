'use client';

import { useTranslations } from 'next-intl';
import { gainLossColor } from '@/lib/format';
import { SCHEDULED_KIND_AMOUNT_CLASSES } from '@/lib/scheduled-kind';
import { UnknownAmount } from '@/components/ui/UnknownAmount';
import { CARD_CLASS } from '@/components/ui/Card';
import type { BudgetVelocity } from '@/types/budget';

interface BudgetUpcomingBillsProps {
  /**
   * The server's answer (`GET /budgets/:id/velocity`): which scheduled
   * occurrences are this budget's bills, what each costs, and their total. The
   * server decides what the budget tracks -- a scheduled transfer only where a
   * budget line takes it, nothing out of an excluded account -- so this panel
   * shows the same list and figures as the velocity widget beside it instead of
   * deriving its own.
   */
  velocity: Pick<
    BudgetVelocity,
    | 'upcomingBills'
    | 'totalUpcomingBills'
    | 'upcomingBillsMissingRates'
    | 'trulyAvailable'
  >;
  /**
   * `currencyCode` omitted means "the budget's own currency". A row shows the
   * occurrence's currency, because that is the currency its amount is in.
   */
  formatCurrency: (amount: number, currencyCode?: string) => string;
}

export function BudgetUpcomingBills({
  velocity,
  formatCurrency,
}: BudgetUpcomingBillsProps) {
  const t = useTranslations('budgets');
  const { upcomingBills, totalUpcomingBills, trulyAvailable } = velocity;
  // A named currency pair is a display rate to refresh; an unnamed shortfall is
  // the occurrence's own settlement rate. Different screens fix them.
  const unknownReason =
    (velocity.upcomingBillsMissingRates?.length ?? 0) > 0
      ? 'displayFx'
      : 'scheduledFx';

  return (
    <div className={`${CARD_CLASS} p-4 sm:p-6`}>
      <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">
        {t('upcomingBills.title')}
      </h2>
      {upcomingBills.length === 0 ? (
        <p className="text-sm text-gray-500 dark:text-gray-400">
          {t('upcomingBills.empty')}
        </p>
      ) : (
        <div className="space-y-2">
          {upcomingBills.slice(0, 5).map((bill) => (
            <div
              key={bill.id}
              className="flex items-center justify-between text-sm"
            >
              <div className="flex items-center gap-2 min-w-0">
                <span className="text-gray-900 dark:text-gray-100 truncate">
                  {bill.name}
                </span>
                <span className="text-xs text-gray-500 dark:text-gray-400 whitespace-nowrap">
                  {bill.dueDate}
                </span>
              </div>
              <span
                className={`font-medium ml-2 whitespace-nowrap ${
                  SCHEDULED_KIND_AMOUNT_CLASSES[
                    bill.amount !== null && bill.amount > 0
                      ? 'bill'
                      : bill.amount === null
                        ? 'unknown'
                        : 'reminder'
                  ]
                }`}
              >
                {bill.amount === null ? (
                  <UnknownAmount />
                ) : (
                  formatCurrency(bill.amount, bill.currencyCode)
                )}
              </span>
            </div>
          ))}
          {upcomingBills.length > 5 && (
            <p className="text-xs text-gray-500 dark:text-gray-400">
              {t('upcomingBills.more', { count: String(upcomingBills.length - 5) })}
            </p>
          )}
        </div>
      )}
      <div className="mt-4 pt-4 border-t border-gray-200 dark:border-gray-700 space-y-2">
        <div className="flex items-center justify-between text-sm">
          <span className="text-gray-600 dark:text-gray-400">{t('upcomingBills.totalUpcoming')}</span>
          {/* A total is only a total when every component is known: the server
              sends `null` while any bill's amount or rate is missing (issue
              #1247), and the rows above already mark which one. */}
          {totalUpcomingBills !== null ? (
            <span className="font-semibold text-red-600 dark:text-red-400">
              {formatCurrency(totalUpcomingBills)}
            </span>
          ) : (
            <UnknownAmount reason={unknownReason} />
          )}
        </div>
        <div className="flex items-center justify-between text-sm">
          <span className="text-gray-600 dark:text-gray-400">{t('upcomingBills.trulyAvailable')}</span>
          {/* Derived from the total above, so it is unknown for the same reason. */}
          {trulyAvailable === null ? (
            <UnknownAmount reason={unknownReason} />
          ) : (
            <span className={`font-semibold ${gainLossColor(trulyAvailable)}`}>
              {formatCurrency(Math.abs(trulyAvailable))}
              {trulyAvailable < 0 && t('upcomingBills.over')}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
