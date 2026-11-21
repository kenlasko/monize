'use client';

import { useTranslations } from 'next-intl';
import { CARD_CLASS } from '@/components/ui/Card';
import { TINT_CLASS } from '@/lib/tint-class';
import { WidgetHeading } from '../widget-meta';
import { FavouriteAccountsStandard, ReorderToggle } from './FavouriteAccountsStandard';
import { FavouriteAccountFigure, FavouriteAccountMeta } from './FavouriteAccountsFolio';
import type { FavouriteAccountsViewProps } from './favourite-accounts-view';

/** A wash per row from the palette's categorical slots, so every palette tints them. */
const AVATAR_TINTS = [
  '[--widget-tint:var(--chart-8)]',
  '[--widget-tint:var(--chart-4)]',
  '[--widget-tint:var(--chart-2)]',
  '[--widget-tint:var(--chart-3)]',
  '[--widget-tint:var(--chart-5)]',
  '[--widget-tint:var(--chart-6)]',
];

/**
 * Favourite Accounts in the Pebble style: a round letter mark, the name over
 * its institution, and the balance set large. Reordering keeps the Standard
 * tiles, which carry the drag handles.
 */
export function FavouriteAccountsPebble(props: FavouriteAccountsViewProps) {
  const t = useTranslations('dashboard');
  const { rows, reordering, onToggleReorder } = props;
  if (reordering) return <FavouriteAccountsStandard {...props} />;
  return (
    <div className={`${CARD_CLASS} p-3 sm:p-6`}>
      <div className="ui-widget-head flex items-center justify-between gap-4">
        <WidgetHeading id="favourite-accounts" href="/accounts">
          {t('favouriteAccounts.title')}
        </WidgetHeading>
        {rows.length > 1 && (
          <ReorderToggle
            reordering={false}
            onToggle={onToggleReorder}
            className="min-h-11 rounded-full px-2 text-gray-500 hover:text-gray-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:text-gray-400 dark:hover:text-gray-100"
          />
        )}
      </div>
      <ul>
        {rows.map((row, index) => (
          <li
            key={row.id}
            data-testid={`favourite-account-row-${row.id}`}
            className="border-t border-gray-100 dark:border-gray-700"
          >
            <button
              type="button"
              onClick={row.open}
              className="flex min-h-[68px] w-full items-center gap-3.5 rounded-2xl py-2 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
            >
              <span
                aria-hidden="true"
                className={`flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full font-bold ${
                  AVATAR_TINTS[index % AVATAR_TINTS.length]
                } ${TINT_CLASS}`}
              >
                {Array.from(row.name)[0]?.toUpperCase()}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[15px] font-semibold text-gray-900 dark:text-gray-100">
                  {row.name}
                </span>
                <FavouriteAccountMeta row={row} />
              </span>
              <FavouriteAccountFigure row={row} className="ui-display-figure text-xl font-semibold tracking-tight" />
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
