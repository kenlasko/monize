'use client';

import { useTranslations } from 'next-intl';
import { balanceColor } from '@/lib/format';
import { getOrdinal } from '@/lib/ordinal';
import { CARD_CLASS, HOVER_ROW_ON_PAGE } from '@/components/ui/Card';
import { MoneyFigure } from '@/components/ui/MoneyFigure';
import { WidgetHeading } from '../widget-meta';
import { FavouriteAccountsStandard, ReorderToggle } from './FavouriteAccountsStandard';
import type { FavouriteAccountRow, FavouriteAccountsViewProps } from './favourite-accounts-view';

/** The figure at a row's right: the balance, its cents set back; a dash when unknown. */
export function FavouriteAccountFigure({ row, className = '' }: { row: FavouriteAccountRow; className?: string }) {
  const tAccounts = useTranslations('accounts');
  if (!row.value.known) {
    return (
      <span className={`text-right ${className}`}>
        <span className="block text-gray-500 dark:text-gray-400">{'—'}</span>
        <span className="block text-xs font-normal tracking-normal text-gray-500 dark:text-gray-400">
          {tAccounts('row.combinedUnknown')}
        </span>
      </span>
    );
  }
  const { amount, currencyCode, foreign, text, breakdown } = row.value;
  return (
    <span className={`text-right ${className}`}>
      <span className={`block whitespace-nowrap ${balanceColor(amount)}`}>
        {foreign ? text : <MoneyFigure amount={amount} currencyCode={currencyCode} className="ui-money-quiet" />}
      </span>
      {breakdown !== null && (
        <span className="block text-xs font-normal tracking-normal text-gray-500 dark:text-gray-400">{breakdown}</span>
      )}
    </span>
  );
}

/** "TD Canada Trust", with the card's due day after it. */
export function FavouriteAccountMeta({ row }: { row: FavouriteAccountRow }) {
  const t = useTranslations('dashboard');
  const due = row.statementDueDay ? t('favouriteAccounts.dueShort', { ordinal: getOrdinal(row.statementDueDay) }) : null;
  if (!row.institution && !due) return null;
  return (
    <span className="block truncate text-xs text-gray-500 dark:text-gray-400">
      {row.institution && due
        ? t('favouriteAccounts.metaWithDue', { institution: row.institution, due })
        : (row.institution ?? due)}
    </span>
  );
}

/**
 * Favourite Accounts in the Classic style: a ruled list under the section
 * rule, the balance right-aligned with its cents set back. Reordering keeps
 * the Standard tiles, which carry the drag handles.
 */
export function FavouriteAccountsClassic(props: FavouriteAccountsViewProps) {
  const t = useTranslations('dashboard');
  const { rows, reordering, onToggleReorder } = props;
  if (reordering) return <FavouriteAccountsStandard {...props} />;
  return (
    <div className={`${CARD_CLASS} p-3 sm:p-6`}>
      <div className="ui-widget-head flex items-baseline justify-between gap-4">
        <WidgetHeading id="favourite-accounts" href="/accounts">
          {t('favouriteAccounts.title')}
        </WidgetHeading>
        {rows.length > 1 && (
          <ReorderToggle
            reordering={false}
            onToggle={onToggleReorder}
            className="text-[13px] text-blue-600 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:text-blue-400"
          />
        )}
      </div>
      <ul>
        {rows.map((row) => (
          <li key={row.id} data-testid={`favourite-account-row-${row.id}`} className="border-b border-gray-200 dark:border-gray-700">
            <button
              type="button"
              onClick={row.open}
              className={`flex w-full items-center gap-4 py-3.5 text-left ${HOVER_ROW_ON_PAGE} focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500`}
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[15px] font-medium text-gray-900 dark:text-gray-100">{row.name}</span>
                <FavouriteAccountMeta row={row} />
              </span>
              <FavouriteAccountFigure row={row} className="text-base" />
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
