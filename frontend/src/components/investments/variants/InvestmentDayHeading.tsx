'use client';

import { useLocale } from 'next-intl';
import { renderForStyle, useUiStyle, type StyleVariants } from '@/hooks/useUiStyle';
import { registerGroupLabel } from '@/components/transactions/register-style-data';

interface InvestmentDayHeadingProps {
  /** The trading day the rows below it share, `YYYY-MM-DD`. */
  date: string;
  /** The user's own calendar day (`useFinancialToday`), for "Today". */
  today: string;
  /**
   * The columns the heading spans: one under the phone's card layout, the
   * tier table's column count in Folio's ledger (issue #2510).
   */
  colSpan?: number;
}

/**
 * The date heading over a day's trades in the brokerage register under Folio
 * (every width: the ledger's date group row, issues #2508, #2510), so the
 * investment tab reads the way the cash register beside it does. Pebble draws
 * no table at any width (`InvestmentPebbleRegister` titles its own day
 * blocks), so it has no heading here. The row below drops its own date, since
 * the heading names the day.
 *
 * It carries the date alone. The cash register's heading prints the day's
 * closing balance, but a trade register has no running balance, and a day's
 * net across trades would be a client-side sum of rows in their own
 * currencies, which no surface does (`frontend/CLAUDE.md`, "An investment
 * row's money").
 *
 * One table row spanning every column: the card's single one in the wrapped
 * layout, the ledger's full width otherwise.
 */
function FolioHeading({ date, today, colSpan = 1 }: InvestmentDayHeadingProps) {
  const locale = useLocale();
  return (
    <tr className="ui-register-group-row">
      {/* `ui-register-group` is Folio's date group row; under a table holding
          `ui-register-card-grouped` cards it is the phone's small-caps
          eyebrow over a heavy rule (`ui-styles-register.css`). */}
      <th scope="colgroup" colSpan={colSpan} className="ui-register-group">
        {registerGroupLabel(date, locale, today)}
      </th>
    </tr>
  );
}

/** Standard keeps the date on each row; Pebble never reaches the table. */
function NoHeading() {
  return null;
}

const VARIANTS: StyleVariants<InvestmentDayHeadingProps> = {
  standard: NoHeading,
  folio: FolioHeading,
  pebble: NoHeading,
};

export function InvestmentDayHeading(props: InvestmentDayHeadingProps) {
  return renderForStyle(useUiStyle(), VARIANTS, props);
}
