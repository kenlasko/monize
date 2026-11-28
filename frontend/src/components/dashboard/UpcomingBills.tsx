'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import {
  addMonths,
  differenceInDays,
  isPast,
  isToday,
  isTomorrow,
  startOfDay,
  startOfMonth,
  subMonths,
} from 'date-fns';
import { CalendarDaysIcon, ListBulletIcon } from '@heroicons/react/24/outline';
import { ScheduledTransaction } from '@/types/scheduled-transaction';
import { Account } from '@/types/account';
import { parseLocalDate } from '@/lib/utils';
import { useDateFormat } from '@/hooks/useDateFormat';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import {
  SCHEDULED_KIND_AMOUNT_CLASSES,
  occurrenceKind,
  type ScheduledKind,
} from '@/lib/scheduled-kind';
import {
  nextOccurrenceAutoPosts,
  nextOccurrenceDueDate,
  nextOccurrenceEffectiveAmount,
  occurrenceFollowsEstimate,
  occurrenceSettlementAccountId,
} from '@/lib/scheduled-effective-amount';
import { moneyDecimalsForCurrency, roundMoney } from '@/lib/format';
import { buildScheduledCalendarDays } from '@/lib/scheduled-calendar';
import { ScheduledCalendarGrid } from '@/components/bills/ScheduledCalendarGrid';
import { useWidgetConfig } from '@/hooks/useWidgetConfig';
import { useChartDateFormat } from '@/hooks/useChartDateFormat';
import { WidgetHeading } from './widget-meta';
import { WidgetSegmentedControl } from './WidgetSegmentedControl';
import { CARD_CLASS } from '@/components/ui/Card';
import { UPCOMING_BILLS_DEFAULT, UpcomingBillsConfig } from './widget-config';
import { buildUpcomingStrip, upcomingOccurrences } from './upcoming-occurrences';
import { renderForStyle, useUiStyle, type StyleVariants } from '@/hooks/useUiStyle';
import type { UpcomingBillRow, UpcomingBillsListProps } from './variants/upcoming-bills-view';
import { UpcomingBillsListStandard } from './variants/UpcomingBillsListStandard';
import { UpcomingBillsListFolio } from './variants/UpcomingBillsListFolio';
import { UpcomingBillsListPebble } from './variants/UpcomingBillsListPebble';

const WIDGET_ID = 'upcoming-bills';

const UPCOMING_LIST_VARIANTS: StyleVariants<UpcomingBillsListProps> = {
  standard: UpcomingBillsListStandard,
  folio: UpcomingBillsListFolio,
  pebble: UpcomingBillsListPebble,
};

const LIABILITY_TYPES = new Set(['CREDIT_CARD', 'LOAN', 'MORTGAGE', 'LINE_OF_CREDIT']);

interface UpcomingBillsProps {
  scheduledTransactions: ScheduledTransaction[];
  accounts: Account[];
  isLoading: boolean;
  maxItems: number;
}

export function UpcomingBills({ scheduledTransactions, accounts, isLoading, maxItems }: UpcomingBillsProps) {
  const t = useTranslations('dashboard');
  const uiStyle = useUiStyle();
  const router = useRouter();
  const { formatDate } = useDateFormat();
  const { formatCurrency } = useNumberFormat();
  const formatChartDate = useChartDateFormat();
  const { config, updateConfig } = useWidgetConfig<UpcomingBillsConfig>(
    WIDGET_ID,
    UPCOMING_BILLS_DEFAULT,
  );
  // Which month the calendar is showing. A view position rather than a setting:
  // reopening the dashboard should land on the current month, not on whichever
  // month was last paged to.
  const [calendarMonth, setCalendarMonth] = useState(() => startOfMonth(new Date()));

  // Active bills, deposits, transfers and reminders. Under `dueSoon` the list is
  // what is overdue plus what has entered its own reminder window; under `all`
  // it is every active schedule's next occurrence, however far off.
  const today = useMemo(() => startOfDay(new Date()), []);
  const showAll = config.scope === 'all';
  const upcomingItems = useMemo(
    () => upcomingOccurrences(scheduledTransactions, today, showAll),
    [scheduledTransactions, today, showAll],
  );

  // Build a map of account ID -> Account for quick lookups
  const accountMap = useMemo(() => {
    const map = new Map<string, Account>();
    for (const acc of accounts) {
      map.set(acc.id, acc);
    }
    return map;
  }, [accounts]);

  // Compute which upcoming items will cause a non-liability account balance to go negative.
  // Uses running balances per account, processing items in date order (which they already are).
  const negativeBalanceItems = useMemo(() => {
    const result = new Set<string>();
    // Running balance per settlement account: currentBalance + futureTransactionsSum
    const runningBalances = new Map<string, number>();
    /** Accounts whose projection hit an unknown amount and cannot continue. */
    const unknown = new Set<string>();

    for (const item of upcomingItems) {
      // The account the cash actually moves through, which for an investment
      // schedule is the settlement account and not `accountId` (the brokerage).
      // Charging the brokerage warned that a purchase would overdraw it while
      // the funding account covering the trade to the cent went unprojected
      // (issue #1247).
      const settlementAccountId = occurrenceSettlementAccountId(item, accountMap);
      if (!settlementAccountId) continue;
      const account = accountMap.get(settlementAccountId);
      if (!account) continue;

      // Skip liability accounts - they normally carry negative balances
      if (LIABILITY_TYPES.has(account.accountType)) continue;
      // The account currency's money precision: four for fiat, a coin's eight.
      const decimals = moneyDecimalsForCurrency(account.currencyCode);

      if (!runningBalances.has(settlementAccountId)) {
        runningBalances.set(
          settlementAccountId,
          roundMoney(
            (Number(account.currentBalance) || 0) + (Number(account.futureTransactionsSum) || 0),
            decimals,
          ),
        );
      }

      // A running balance built from an unknown amount is not a smaller
      // balance, it is an unknown one -- so the projection stops for that
      // account rather than carrying on as if the item cost nothing and
      // flagging (or clearing) the rows after it (issue #1247).
      const { amount: effectiveAmount, currencyCode } = nextOccurrenceEffectiveAmount(item);
      if (effectiveAmount === null) {
        unknown.add(settlementAccountId);
        continue;
      }
      // An amount and its currency are one value. Converting here would invent a
      // rate this widget holds no table for, and adding the bare number would
      // compare foreign units against this balance, so a mismatch is unknown.
      if (currencyCode !== account.currencyCode) {
        unknown.add(settlementAccountId);
        continue;
      }
      if (unknown.has(settlementAccountId)) continue;
      // Money precision, not float precision: a balance and the amount that
      // empties it are both stored at the currency's money precision, and only
      // the rounded difference is one. An unrounded sum lands a fraction of a
      // unit below zero and warns about an account that ends at exactly zero.
      const newBalance = roundMoney(runningBalances.get(settlementAccountId)! + effectiveAmount, decimals);
      runningBalances.set(settlementAccountId, newBalance);

      if (newBalance < 0) {
        result.add(item.id);
      }
    }
    return result;
  }, [upcomingItems, accountMap]);

  // The two weeks from today as the Folio and Pebble styles draw them: the
  // same scoped occurrences as the list, placed on their own due dates.
  const strip = useMemo(() => buildUpcomingStrip(upcomingItems, today), [upcomingItems, today]);

  const isOverdue = (dateStr: string) => {
    const date = parseLocalDate(dateStr);
    return isPast(date) && !isToday(date);
  };

  const getDueDateLabel = (dateStr: string) => {
    const date = parseLocalDate(dateStr);
    if (isPast(date) && !isToday(date)) return t('upcomingBills.overdue');
    if (isToday(date)) return t('upcomingBills.today');
    if (isTomorrow(date)) return t('upcomingBills.tomorrow');
    const days = differenceInDays(date, today);
    if (days <= 14) return t('upcomingBills.daysUntil', { count: days });
    return formatDate(dateStr);
  };

  const getDueDateColour = (dateStr: string) => {
    const date = parseLocalDate(dateStr);
    const days = differenceInDays(date, today);
    if (days <= 0) return 'text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/30';
    if (days <= 2) return 'text-orange-600 dark:text-orange-400 bg-orange-50 dark:bg-orange-900/30';
    return 'text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-900/30';
  };

  // The amount this occurrence would post TODAY, from the server's
  // effective-amount contract -- `null` when it cannot be determined (issue
  // #1247). Never `nextOverride?.amount ?? amount`: for an FX-sensitive schedule
  // that scalar was written at an older rate, which is how this widget came to
  // disagree with the cash-flow forecast about the same bill.
  const getEffective = (item: ScheduledTransaction) =>
    nextOccurrenceEffectiveAmount(item);

  const getItemType = (item: ScheduledTransaction): ScheduledKind =>
    occurrenceKind(getEffective(item), item);

  const getTypeBadge = (type: ScheduledKind) => {
    switch (type) {
      case 'bill':
        return <span className="px-1.5 py-0.5 bg-red-50 text-red-600 dark:bg-red-900/30 dark:text-red-400 text-xs rounded font-medium">{t('upcomingBills.typeBadge.bill')}</span>;
      case 'deposit':
        return <span className="px-1.5 py-0.5 bg-green-50 text-green-600 dark:bg-green-900/30 dark:text-green-400 text-xs rounded font-medium">{t('upcomingBills.typeBadge.deposit')}</span>;
      case 'transfer':
        return <span className="px-1.5 py-0.5 bg-blue-50 text-blue-600 dark:bg-blue-900/30 dark:text-blue-400 text-xs rounded font-medium">{t('upcomingBills.typeBadge.transfer')}</span>;
      case 'reminder':
        return <span className="px-1.5 py-0.5 bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300 text-xs rounded font-medium">{t('upcomingBills.typeBadge.reminder')}</span>;
      case 'unknown':
        // The server could not derive which way this occurrence goes, so the
        // badge says that rather than picking a colour: red would read as money
        // out and green as money in (issue #1247 re-audit).
        return <span className="px-1.5 py-0.5 bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300 text-xs rounded font-medium">{t('upcomingBills.typeBadge.unknown')}</span>;
    }
  };

  const getAmountDisplay = (item: ScheduledTransaction) => {
    const effective = getEffective(item);
    const type = getItemType(item);
    // A reminder carries no sign: its amount is a placeholder the user will fill
    // in when the real one arrives, so it is neither money out nor money in.
    const sign = type === 'bill' ? '-' : type === 'deposit' ? '+' : '';
    return {
      text:
        effective.amount === null
          ? null
          : `${sign}${formatCurrency(Math.abs(effective.amount), effective.currencyCode)}`,
      className: SCHEDULED_KIND_AMOUNT_CLASSES[type],
    };
  };

  const goToPost = (id: string) => {
    router.push(`/bills?postBillId=${encodeURIComponent(id)}`);
  };

  const sectionTitle = t('upcomingBills.title');

  // The calendar draws from the same filtered set as the list, so switching
  // views never changes which schedules are in scope -- only how they are laid
  // out. A month with nothing in it is still a month, so the calendar has no
  // empty state of its own.
  const calendarDays = buildScheduledCalendarDays(upcomingItems, calendarMonth);

  // Scope and view on one row: the view switch is icons so both fit beside the
  // heading on a phone instead of the second one wrapping to its own line. The
  // labels stay as the accessible name and the tooltip.
  //
  // On a phone the row takes the header's own line (`w-full sm:w-auto`, the
  // toolbar convention) and holds its two ends apart: scope against the left
  // edge, view against the right. Not `sm:ml-auto` on the view switch -- the
  // two groups are one row here, not a toolbar's leading and trailing groups,
  // and the scope pair must stay left whichever line the row lands on.
  const viewControls = (
    <div className="flex w-full items-center justify-between gap-2 sm:w-auto sm:justify-start">
      <WidgetSegmentedControl
        value={config.scope}
        onChange={(scope) => updateConfig({ scope })}
        options={[
          { value: 'dueSoon', label: t('upcomingBills.scope.dueSoon') },
          { value: 'all', label: t('upcomingBills.scope.all') },
        ]}
      />
      <WidgetSegmentedControl
        value={config.view}
        onChange={(view) => updateConfig({ view })}
        ariaLabel={t('upcomingBills.viewLabel')}
        options={[
          {
            value: 'list',
            label: t('upcomingBills.viewList'),
            icon: <ListBulletIcon className="w-4 h-4" aria-hidden="true" />,
          },
          {
            value: 'calendar',
            label: t('upcomingBills.viewCalendar'),
            icon: <CalendarDaysIcon className="w-4 h-4" aria-hidden="true" />,
          },
        ]}
      />
    </div>
  );

  if (isLoading) {
    return (
      <div className={`${CARD_CLASS} p-3 sm:p-6`}>
        <WidgetHeading id="upcoming-bills" href="/bills" className="mb-4">
          {sectionTitle}
        </WidgetHeading>
        <div className="animate-pulse skeleton-shimmer space-y-3">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-12 bg-gray-200 dark:bg-gray-700 rounded" />
          ))}
        </div>
      </div>
    );
  }

  if (upcomingItems.length === 0) {
    return (
      <div className={`${CARD_CLASS} p-3 sm:p-6`}>
        {/* The controls stay on screen: a scope that emptied the list is the
            most likely reason it is empty, and the way back out of it. */}
        <div className="ui-widget-head flex flex-wrap items-start justify-between gap-2 mb-4">
          <WidgetHeading id="upcoming-bills" href="/bills">
            {sectionTitle}
          </WidgetHeading>
          {viewControls}
        </div>
        <p className="text-gray-500 dark:text-gray-400 text-sm">
          {showAll ? t('upcomingBills.emptyAll') : t('upcomingBills.empty')}
        </p>
      </div>
    );
  }

  // This widget lists occurrences and nothing else: the summed "Total due" row
  // went in #1264 and "Total incoming" followed it, so no figure here stands for
  // more than the one occurrence printed beside it. Do not reintroduce a summary
  // row -- a per-row amount needs no completeness flag, no cross-currency
  // conversion and no subtotal marking, which is why the widget no longer reads
  // exchange rates at all.
  const visibleItems = upcomingItems.slice(0, maxItems);
  const hiddenCount = upcomingItems.length - visibleItems.length;
  const visibleRows: UpcomingBillRow[] = visibleItems.map((item) => {
    const dueDate = nextOccurrenceDueDate(item);
    const amountDisplay = getAmountDisplay(item);
    const type = getItemType(item);
    return {
      id: item.id,
      name: item.name,
      payee: item.payeeName || item.payee?.name || null,
      dueDate,
      overdue: isOverdue(dueDate),
      dueLabel: getDueDateLabel(dueDate),
      dueClass: getDueDateColour(dueDate),
      kind: type,
      typeBadge: getTypeBadge(type),
      amountText: amountDisplay.text,
      amountClass: amountDisplay.className,
      manual: !nextOccurrenceAutoPosts(item),
      estimated: occurrenceFollowsEstimate(item, item.nextOverride),
      overdraws: negativeBalanceItems.has(item.id),
    };
  });

  return (
    <div className={`${CARD_CLASS} p-3 sm:p-6`}>
      <div className="ui-widget-head flex flex-wrap items-start justify-between gap-2 mb-4">
        <WidgetHeading id="upcoming-bills" href="/bills">
          {sectionTitle}
        </WidgetHeading>
        {viewControls}
      </div>
      {config.view === 'calendar' ? (
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <button
              type="button"
              onClick={() => setCalendarMonth((month) => subMonths(month, 1))}
              aria-label={t('upcomingBills.previousMonth')}
              className="rounded-md px-2 py-1 text-sm text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-700"
            >
              {'<'}
            </button>
            <span className="text-sm font-medium text-gray-900 dark:text-gray-100">
              {formatChartDate(calendarMonth, 'MMMM yyyy')}
            </span>
            <button
              type="button"
              onClick={() => setCalendarMonth((month) => addMonths(month, 1))}
              aria-label={t('upcomingBills.nextMonth')}
              className="rounded-md px-2 py-1 text-sm text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-700"
            >
              {'>'}
            </button>
          </div>
          <ScheduledCalendarGrid
            days={calendarDays}
            onSelect={(item) => goToPost(item.id)}
            maxChipsPerDay={2}
            dayMinHeightClass="min-h-[64px]"
          />
        </div>
      ) : (
        renderForStyle(uiStyle, UPCOMING_LIST_VARIANTS, {
          rows: visibleRows,
          hiddenCount,
          strip,
          onOpen: goToPost,
          onShowAll: () => router.push('/bills'),
        })
      )}
    </div>
  );
}
