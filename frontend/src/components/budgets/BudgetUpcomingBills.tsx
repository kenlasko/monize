'use client';

import { useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { gainLossColor } from '@/lib/format';
import {
  SCHEDULED_KIND_AMOUNT_CLASSES,
  occurrenceKind,
} from '@/lib/scheduled-kind';
import { differenceInDays, startOfDay, parseISO } from 'date-fns';
import type { ScheduledTransaction } from '@/types/scheduled-transaction';
import {
  nextOccurrenceDueDate,
  nextOccurrenceEffectiveAmount,
  sumEffectiveOccurrences,
  templateTransferLineTotal,
  withoutTransferLines,
} from '@/lib/scheduled-effective-amount';
import { UnknownAmount } from '@/components/ui/UnknownAmount';
import { isComplete } from '@/lib/currency-total';
import { useExchangeRates } from '@/hooks/useExchangeRates';
import { OVERDUE_CARRY_DAYS } from '@/lib/forecast';
import { CARD_CLASS } from '@/components/ui/Card';

interface BudgetUpcomingBillsProps {
  scheduledTransactions: ScheduledTransaction[];
  /** `null` when the period's spending is unknown (a row had no rate). */
  currentSpent: number | null;
  totalBudgeted: number;
  periodEnd: string;
  /**
   * The currency this panel's own figures are reported in -- the budget's, which
   * is what `currentSpent` and `totalBudgeted` are in. Each occurrence is
   * converted into it before joining a total.
   */
  displayCurrency: string;
  /**
   * `currencyCode` omitted means "the budget's own currency". A row shows the
   * occurrence's currency, because that is the currency its amount is in.
   */
  formatCurrency: (amount: number, currencyCode?: string) => string;
}

// What is DUE is the whole amount (the rows); what counts against the budget
// is SPENDING, the part that is not a transfer line, and only where that part
// is an outflow. This panel shows each schedule's NEXT occurrence only, so
// its `nextOverride` is the governing one and the template's lines the rest.
function getSpending(st: ScheduledTransaction) {
  const spending = withoutTransferLines(
    nextOccurrenceEffectiveAmount(st),
    templateTransferLineTotal(st, st.nextOverride),
  );
  // The occurrence's own spending part, not the template's sign: an inflow
  // (a refund beside a larger transfer line) spends nothing.
  const spent = spending.amount;
  return spent !== null && spent > 0 ? { ...spending, amount: 0 } : spending;
}

export function BudgetUpcomingBills({
  scheduledTransactions,
  currentSpent,
  totalBudgeted,
  periodEnd,
  displayCurrency,
  formatCurrency,
}: BudgetUpcomingBillsProps) {
  const today = startOfDay(new Date());
  const endDate = parseISO(periodEnd);
  const { convert } = useExchangeRates();

  // What this occurrence would cost TODAY, from the server's effective-amount
  // contract (issue #1247). Never `nextOverride?.amount ?? amount`: that scalar
  // was computed at whatever FX rate was current when it was written, so an
  // FX-sensitive schedule made this panel disagree with the cash-flow forecast
  // -- and with what the posting will actually book.
  const getEffective = (st: ScheduledTransaction) =>
    nextOccurrenceEffectiveAmount(st);

  const upcomingBills = useMemo(() => {
    return scheduledTransactions
      .filter((st) => {
        if (!st.isActive) return false;
        // Bills, plus zero-amount reminders: a schedule left at 0 because the
        // amount is not known until it arrives is still a payment the user has
        // to make, and dropping it made it invisible here (issue #1124). It
        // contributes 0 to the total below -- the placeholder is not a claim
        // about what the payment will cost. Deposits and transfers are not
        // budgeted spending and stay out.
        const kind = occurrenceKind(getEffective(st), st);
        // `unknown` is kept: the server could not derive the direction, so this
        // occurrence MIGHT be a bill, and dropping it would leave the panel's
        // total looking complete while a possible payment went uncounted. Its
        // amount is unknown too, so the total below is withheld either way.
        if (kind !== 'bill' && kind !== 'reminder' && kind !== 'unknown') {
          return false;
        }
        const dueDate = parseISO(nextOccurrenceDueDate(st));
        const daysUntil = differenceInDays(dueDate, today);
        const daysUntilEnd = differenceInDays(endDate, dueDate);
        // A bill due in the last `OVERDUE_CARRY_DAYS` and neither posted nor
        // skipped is still owed (discussion #1784): the server's safe-to-spend
        // counts it, and leaving it out here made this panel's figure larger.
        return daysUntil >= -OVERDUE_CARRY_DAYS && daysUntilEnd >= 0;
      })
      .sort(
        (a, b) =>
          parseISO(nextOccurrenceDueDate(a)).getTime() -
          parseISO(nextOccurrenceDueDate(b)).getTime(),
      );
  }, [scheduledTransactions, today, endDate]);

  // One bill with an unknown current amount makes both this total and "truly
  // available" unknowable, not smaller (issue #1247). The partial sum is kept
  // separately and shown as a subtotal through `PartialTotal`, which is also what
  // tells the reader a figure is missing rather than zero.
  const upcomingTotal = useMemo(
    () =>
      sumEffectiveOccurrences(
        upcomingBills,
        getSpending,
        (amount, from) => convert(amount, from, displayCurrency),
        Math.abs,
      ),
    [upcomingBills, convert, displayCurrency],
  );

  const t = useTranslations('budgets');
  // A named currency pair is a display rate to refresh; an unnamed shortfall is
  // the occurrence's own settlement rate. Different screens fix them.
  const unknownReason =
    upcomingTotal.missingCurrencies.length > 0 ? 'displayFx' : 'scheduledFx';
  // Incomplete for either reason -- an occurrence nobody can price, or one in a
  // currency with no rate into the budget's -- leaves this unknown rather than
  // larger. `isComplete` is the one definition of "nothing left out".
  const trulyAvailable = isComplete(upcomingTotal) && currentSpent !== null
    ? totalBudgeted - currentSpent - upcomingTotal.value
    : null;

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
                  {nextOccurrenceDueDate(bill)}
                </span>
              </div>
              <span
                className={`font-medium ml-2 whitespace-nowrap ${
                  SCHEDULED_KIND_AMOUNT_CLASSES[
                    occurrenceKind(getEffective(bill), bill)
                  ]
                }`}
              >
                {getEffective(bill).amount === null ? (
                  <UnknownAmount />
                ) : (
                  formatCurrency(
                    Math.abs(getEffective(bill).amount!),
                    getEffective(bill).currencyCode,
                  )
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
          {/* A total is only a total when every component is known. One bill
              whose current amount could not be resolved makes this unknowable,
              and the per-bill rows above already mark which one (issue #1247). */}
          {isComplete(upcomingTotal) ? (
            <span className="font-semibold text-red-600 dark:text-red-400">
              {formatCurrency(upcomingTotal.value)}
            </span>
          ) : (
            <UnknownAmount reason={unknownReason} />
          )}
        </div>
        <div className="flex items-center justify-between text-sm">
          <span className="text-gray-600 dark:text-gray-400">{t('upcomingBills.trulyAvailable')}</span>
          {/* Derived from the total above, so it is unknown for the same reason.
              Showing a number here would be the whole defect: a budget that
              silently counted a stale bill (issue #1247). */}
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
