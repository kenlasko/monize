'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { ClockIcon, ExclamationTriangleIcon, XMarkIcon } from '@heroicons/react/24/outline';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { CARD_CLASS, HOVER_ROW_ON_CARD } from '@/components/ui/Card';
import { useIsBelowDesktop } from '@/hooks/useIsMobile';
import { CategoryPill } from '@/components/transactions/CategoryPill';
import { PayeeLogo } from '@/components/payees/PayeeLogo';
import { UnknownAmount } from '@/components/ui/UnknownAmount';
import { BalanceForecastUnavailable } from '@/components/accounts/shared/BalanceForecastUnavailable';
import { CalendarDayNote } from '@/components/calendar/CalendarDayNote';
import { useDateFormat } from '@/hooks/useDateFormat';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { usePayeeDisplay } from '@/hooks/usePayeeDisplay';
import { balanceColor, gainLossColor } from '@/lib/format';
import { useInvestmentActionInfo } from '@/components/investments/InvestmentTransactionListParts';
import {
  redemptionTotalWithInterest,
  supportsAccruedInterest,
} from '@/lib/investment-actions';
import { isDailyValueComplete } from '@/hooks/useInvestmentDailyValues';
import type { CalendarDayRows } from '@/lib/calendar-rows';
import type { DailyBalanceTotal, DailyBalanceTotalsResponse } from '@/types/account';
import type { DailyInvestmentValue } from '@/types/net-worth';
import type { DayNote } from '@/types/calendar';
import type { InvestmentTransaction } from '@/types/investment';
import type { Transaction } from '@/types/transaction';

/** What the Balances layer knows about the day this panel is open on. */
export interface CalendarDayBalance {
  point: DailyBalanceTotal;
  /** The currency the total is reported in, which every scoped day shares. */
  currencyCode: string;
  /** The month's forecast state; a projected day is withheld whole on one gap. */
  forecast: DailyBalanceTotalsResponse['forecast'];
}

/** What the Values layer knows about the day this panel is open on. */
export interface CalendarDayValue {
  point: DailyInvestmentValue;
  currencyCode: string;
  /** Symbols for the securities a withheld value names, keyed by id. */
  securityLabels: ReadonlyMap<string, string>;
}

interface CalendarDayPanelProps {
  /** The day this panel is about, `YYYY-MM-DD`. */
  date: string;
  rows?: CalendarDayRows;
  /** Present only while the Balances layer is on and this day's figure arrived. */
  balance?: CalendarDayBalance;
  /** Present only while the Values layer is on and this day has a point. */
  value?: CalendarDayValue;
  /**
   * The note surface, absent in an acting-delegate session: a note is personal,
   * the routes are not delegate-reachable, and a section that could only fail is
   * worse than no section (design decision 12).
   */
  notes?: {
    /** The note COVERING this day; a multi-day note may start on another. */
    note?: DayNote;
    onSave: (
      anchorDate: string,
      note: { body: string; startDate: string; endDate: string },
    ) => Promise<unknown>;
    onDelete: (anchorDate: string) => Promise<unknown>;
    onDirtyChange: (dirty: boolean) => void;
  };
  onEditTransaction: (transaction: Transaction) => void;
  /** Opens a brokerage row; absent on a calendar that draws none. */
  onEditInvestment?: (transaction: InvestmentTransaction) => void;
  /** The label the day's create button carries, when it is not a transaction. */
  createLabel?: string;
  onCreateOnDay: (date: string) => void;
  onClose: () => void;
  categoryColorMap: ReadonlyMap<string, string | null>;
  categoryIconMap: ReadonlyMap<string, string | null>;
  categoryLabelMap: ReadonlyMap<string, string>;
}

/**
 * One day, in full: every row and occurrence on it, and the way to add another.
 *
 * The cell is a summary bounded by its own height; this is the surface that
 * shows the day whole. Clicking a row opens the register's own edit modal, so
 * the calendar adds no write path of its own (design I9).
 */
export function CalendarDayPanel({
  date,
  rows,
  balance,
  value,
  notes,
  onEditTransaction,
  onEditInvestment,
  createLabel,
  onCreateOnDay,
  onClose,
  categoryColorMap,
  categoryIconMap,
  categoryLabelMap,
}: CalendarDayPanelProps) {
  const t = useTranslations('calendar');
  const common = useTranslations('common');
  const { formatDate } = useDateFormat();
  // Below `lg` there is no column to put a panel in, so the day opens over the
  // month as a dialog: focus is trapped, Escape closes, and the grid is not
  // left half-covered by a card the reader has to scroll past.
  const asDialog = useIsBelowDesktop();
  const { formatCurrency } = useNumberFormat();
  const payeeDisplay = usePayeeDisplay();
  const actionInfo = useInvestmentActionInfo();

  const transactions = rows?.transactions ?? [];
  const occurrences = rows?.occurrences ?? [];
  const investments = rows?.investments ?? [];

  const body = (
    <aside
      className={asDialog ? 'p-1' : `${CARD_CLASS} p-4`}
      aria-label={formatDate(date)}
    >
      {/* As a dialog the day is named by `Modal`'s own title, which draws the
          heading and the close button; the card beside the grid draws its own. */}
      {!asDialog && (
        <div className="mb-3 flex items-center justify-between gap-2">
          <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
            {formatDate(date)}
          </h3>
          <button
            type="button"
            onClick={onClose}
            aria-label={common('close')}
            className={`p-1 rounded text-gray-500 dark:text-gray-400 ${HOVER_ROW_ON_CARD} focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500`}
          >
            <XMarkIcon className="w-4 h-4" />
          </button>
        </div>
      )}

      {balance && (
        <CalendarDayBalanceSection balance={balance} hasOccurrences={occurrences.length > 0} />
      )}

      {value && <CalendarDayValueSection value={value} />}

      {notes && (
        <CalendarDayNote
          date={date}
          note={notes.note}
          onSave={notes.onSave}
          onDelete={notes.onDelete}
          onDirtyChange={notes.onDirtyChange}
        />
      )}

      {transactions.length === 0 && occurrences.length === 0 && investments.length === 0 ? (
        <p className="text-sm text-gray-500 dark:text-gray-400">{t('day.noItems')}</p>
      ) : (
        <ul className="space-y-2">
          {investments.map((chip) => (
            <li key={chip.key}>
              <button
                type="button"
                onClick={() => onEditInvestment?.(chip.transaction)}
                className={`w-full rounded px-2 py-1.5 text-left ${HOVER_ROW_ON_CARD} focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 ${
                  chip.isVoid ? 'line-through opacity-50' : ''
                } ${chip.isFuture && !chip.isVoid ? 'opacity-60' : ''}`}
              >
                <span className="flex items-baseline justify-between gap-2">
                  <span className="truncate text-sm text-gray-900 dark:text-gray-100">
                    {chip.transaction.security?.symbol ?? t('chip.noSymbol')}{' '}
                    {actionInfo(chip.transaction.action).label}
                  </span>
                  <span className="shrink-0 text-sm tabular-nums text-gray-900 dark:text-gray-100">
                    {formatCurrency(
                      supportsAccruedInterest(chip.transaction.action)
                        ? redemptionTotalWithInterest(
                            chip.transaction.totalAmount,
                            chip.transaction.accruedInterest,
                          )
                        : chip.transaction.totalAmount,
                      chip.transaction.security?.currencyCode,
                    )}
                  </span>
                </span>
              </button>
            </li>
          ))}

          {transactions.map((chip) => (
            <li key={chip.key}>
              <button
                type="button"
                onClick={() => onEditTransaction(chip.transaction)}
                className={`w-full rounded px-2 py-1.5 text-left ${HOVER_ROW_ON_CARD} focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 ${
                  chip.isVoid ? 'line-through opacity-50' : ''
                } ${chip.isFuture && !chip.isVoid ? 'opacity-60' : ''}`}
              >
                <span className="flex items-center justify-between gap-2">
                  {/* The register's own badge, at the register's size: the day
                      panel is a list of the same rows, so a payee is recognised
                      here by the same mark it carries there. `PayeeLogo` falls
                      back to a letter badge, so the column stays aligned for a
                      free-text payee and for a row that names none. */}
                  <span className="flex min-w-0 items-center gap-2">
                    <PayeeLogo
                      payee={chip.transaction.payee}
                      name={payeeDisplay(chip.transaction)}
                      size={20}
                      className="shrink-0"
                    />
                    <span className="truncate text-sm text-gray-900 dark:text-gray-100">
                      {payeeDisplay(chip.transaction) ?? t('chip.noPayee')}
                    </span>
                  </span>
                  {/* The register's own reading of the sign: money in is green,
                      money out is red, through the same `gainLossColor` the
                      rest of the app signs a figure with. The row's amount is
                      already signed, so nothing here decides the direction. */}
                  <span
                    className={`shrink-0 text-sm tabular-nums ${gainLossColor(
                      Number(chip.transaction.amount),
                    )}`}
                  >
                    {formatCurrency(
                      Number(chip.transaction.amount),
                      chip.transaction.currencyCode,
                    )}
                  </span>
                </span>
                {chip.transaction.categoryId && (
                  <span className="mt-1 block">
                    <CategoryPill
                      name={categoryLabelMap.get(chip.transaction.categoryId) ?? ''}
                      color={categoryColorMap.get(chip.transaction.categoryId) ?? null}
                      icon={categoryIconMap.get(chip.transaction.categoryId) ?? null}
                      density="normal"
                    />
                  </span>
                )}
              </button>
            </li>
          ))}

          {occurrences.map((chip) => (
            <li key={chip.key}>
              <Link
                href={`/bills?highlight=${chip.occurrence.scheduledTransactionId}`}
                className={`block rounded px-2 py-1.5 ${HOVER_ROW_ON_CARD} focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500`}
              >
                <span className="flex items-baseline justify-between gap-2">
                  <span className="flex min-w-0 items-baseline gap-1">
                    {chip.isOverdue ? (
                      <ExclamationTriangleIcon
                        className="w-3.5 h-3.5 shrink-0 self-center"
                        aria-label={t('chip.overdue')}
                      />
                    ) : (
                      <ClockIcon
                        className="w-3.5 h-3.5 shrink-0 self-center"
                        aria-label={t('chip.scheduled')}
                      />
                    )}
                    <span className="truncate text-sm text-gray-900 dark:text-gray-100">
                      {chip.schedule.name}
                    </span>
                  </span>
                  <span className="shrink-0 text-sm tabular-nums text-gray-900 dark:text-gray-100">
                    {chip.occurrence.amount === null ? (
                      <UnknownAmount />
                    ) : (
                      formatCurrency(chip.occurrence.amount, chip.occurrence.currencyCode)
                    )}
                  </span>
                </span>
                <span className="mt-0.5 block text-xs text-gray-500 dark:text-gray-400">
                  {t('day.scheduledHint')}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}

      <Button
        variant="secondary"
        size="sm"
        className="mt-4 w-full"
        onClick={() => onCreateOnDay(date)}
      >
        {createLabel ?? t('day.newTransaction')}
      </Button>
    </aside>
  );

  if (!asDialog) return body;

  return (
    <Modal isOpen onClose={onClose} maxWidth="lg" padding="md" title={formatDate(date)}>
      {body}
    </Modal>
  );
}

/**
 * What the Balances layer has to say about the open day, in full.
 *
 * The cell has room for a figure and a marker; this is where the figure's
 * provenance goes -- whether it is an actual or a projection, and, when it is
 * withheld, which currency pair or which schedule withheld it. A withheld figure
 * that names no cause is a dead end, so every branch here ends in something the
 * reader can act on.
 */
function CalendarDayBalanceSection({
  balance,
  hasOccurrences,
}: {
  balance: CalendarDayBalance;
  hasOccurrences: boolean;
}) {
  const t = useTranslations('calendar');
  const { formatCurrency } = useNumberFormat();
  const { point, currencyCode, forecast } = balance;

  // A projected day is withheld whole when any scoped forecast is incomplete,
  // which is the server's decision; the gaps are what it withheld it for.
  const showGaps = point.isProjected && !forecast.complete;

  return (
    <section
      className="mb-3 border-b border-gray-200 dark:border-gray-700 pb-3"
      aria-label={point.isProjected ? t('balance.projectedTitle') : t('balance.actualTitle')}
    >
      <div className="flex items-baseline justify-between gap-2">
        <h4 className="text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
          {point.isProjected ? t('balance.projectedTitle') : t('balance.actualTitle')}
        </h4>
        {point.total === null ? (
          <UnknownAmount reason={point.missingRatePairs.length > 0 ? 'displayFx' : 'scheduledFx'} />
        ) : (
          <span
            className={`text-sm font-semibold tabular-nums ${balanceColor(point.total)} ${
              point.isProjected ? 'italic' : ''
            }`}
          >
            {formatCurrency(point.total, currencyCode)}
          </span>
        )}
      </div>

      {/* The partial sum, and only ever under a caption that says it is one. */}
      {point.total === null && (
        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
          {t('balance.partial', {
            amount: formatCurrency(point.knownSubtotal, currencyCode),
          })}
        </p>
      )}

      {point.isProjected && point.total !== null && (
        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
          {hasOccurrences ? t('balance.projectedFromItems') : t('balance.projectedHint')}
        </p>
      )}

      {point.missingRatePairs.length > 0 && (
        <p className="mt-1 text-xs text-gray-600 dark:text-gray-300">
          {t('balance.missingRates', { pairs: point.missingRatePairs.join(', ') })}
        </p>
      )}

      {showGaps && (
        <div className="mt-2">
          <BalanceForecastUnavailable gaps={forecast.gaps} />
        </div>
      )}

      {point.isProjected && forecast.unforecastableAccountIds.length > 0 && (
        <p className="mt-1 text-xs text-gray-600 dark:text-gray-300">
          {t('balance.unforecastable', { count: forecast.unforecastableAccountIds.length })}
        </p>
      )}
    </section>
  );
}

/**
 * What the Values layer has to say about the open day.
 *
 * A withheld value names the securities or the currency pairs behind it, which
 * is the difference between "we cannot value this day" and a figure the reader
 * can repair: one manual price on the security named here fixes every day from
 * its date forward.
 */
function CalendarDayValueSection({ value }: { value: CalendarDayValue }) {
  const t = useTranslations('calendar');
  const { formatCurrency } = useNumberFormat();
  const { point, currencyCode, securityLabels } = value;

  const unpriced = point.unpricedSecurityIds ?? [];
  const pairs = point.missingRatePairs ?? [];

  return (
    <section
      className="mb-3 border-b border-gray-200 dark:border-gray-700 pb-3"
      aria-label={t('value.title')}
    >
      <div className="flex items-baseline justify-between gap-2">
        <h4 className="text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
          {t('value.title')}
        </h4>
        {isDailyValueComplete(point) ? (
          <span className="text-sm font-semibold tabular-nums text-gray-900 dark:text-gray-100">
            {formatCurrency(point.value, currencyCode)}
          </span>
        ) : (
          <UnknownAmount reason={point.pricesComplete === false ? 'noPrice' : 'displayFx'} />
        )}
      </div>

      {point.pricesComplete === false && (
        <p className="mt-1 text-xs text-gray-600 dark:text-gray-300">
          {t('value.unpriced', {
            securities: unpriced.map((id) => securityLabels.get(id) ?? id).join(', '),
          })}
        </p>
      )}

      {point.fxComplete === false && (
        <p className="mt-1 text-xs text-gray-600 dark:text-gray-300">
          {t('value.missingRates', { pairs: pairs.join(', ') })}
        </p>
      )}
    </section>
  );
}
