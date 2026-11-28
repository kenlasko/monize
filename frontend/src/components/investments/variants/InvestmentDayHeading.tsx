'use client';

import { useLocale, useTranslations } from 'next-intl';
import { renderForStyle, useUiStyle, type StyleVariants } from '@/hooks/useUiStyle';
import {
  previousDay,
  registerGroupLabel,
} from '@/components/transactions/register-style-data';

interface InvestmentDayHeadingProps {
  /** The trading day the rows below it share, `YYYY-MM-DD`. */
  date: string;
  /** The user's own calendar day (`useFinancialToday`), for "Today". */
  today: string;
}

/**
 * The date heading over a day's trades in the brokerage register's phone card
 * layout under Folio and Pebble (issue #2508), so the investment tab reads the
 * way the cash register beside it does on a phone. The card below drops its
 * own date, since the heading names the day.
 *
 * It carries the date alone. The cash register's heading prints the day's
 * closing balance, but a trade register has no running balance, and a day's
 * net across trades would be a client-side sum of rows in their own
 * currencies, which no surface does (`frontend/CLAUDE.md`, "An investment
 * row's money").
 *
 * One table row spanning the card's single column, as every row of the
 * wrapped layout does.
 */
function FolioHeading({ date, today }: InvestmentDayHeadingProps) {
  const locale = useLocale();
  return (
    <tr className="ui-register-group-row">
      {/* `ui-register-group` is Folio's date group row; under a table holding
          `ui-register-card-grouped` cards it is the phone's small-caps
          eyebrow over a heavy rule (`ui-styles-register.css`). */}
      <th scope="colgroup" colSpan={1} className="ui-register-group">
        {registerGroupLabel(date, locale, today)}
      </th>
    </tr>
  );
}

/** Pebble's day title: "Today", "Yesterday", then the date, as its day blocks read. */
function PebbleHeading({ date, today }: InvestmentDayHeadingProps) {
  const locale = useLocale();
  const t = useTranslations('transactions');
  const title =
    date === today
      ? t('list.today')
      : date === previousDay(today)
        ? t('list.pebble.yesterday')
        : registerGroupLabel(date, locale, today);
  return (
    <tr className="ui-register-group-row">
      <th
        scope="colgroup"
        colSpan={1}
        className="px-4 pt-4 pb-2 text-left font-sans text-sm font-semibold text-gray-900 dark:text-gray-100 bg-white dark:bg-gray-900"
      >
        {title}
      </th>
    </tr>
  );
}

/** Standard keeps the date on each card and draws no heading. */
function NoHeading() {
  return null;
}

const VARIANTS: StyleVariants<InvestmentDayHeadingProps> = {
  standard: NoHeading,
  folio: FolioHeading,
  pebble: PebbleHeading,
};

export function InvestmentDayHeading(props: InvestmentDayHeadingProps) {
  return renderForStyle(useUiStyle(), VARIANTS, props);
}
