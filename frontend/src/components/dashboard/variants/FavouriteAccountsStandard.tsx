'use client';

import { useTranslations } from 'next-intl';
import { gainLossColor } from '@/lib/format';
import { InfoTooltip } from '@/components/ui/InfoTooltip';
import { InstitutionLogo, type InstitutionLogoData } from '@/components/institutions/InstitutionLogo';
import { getOrdinal } from '@/lib/ordinal';
import { DropIndicatorLine } from '@/hooks/useDragReorder';
import { CARD_CLASS, HOVER_ROW_ON_CARD, HOVER_TOOLBAR_BUTTON } from '@/components/ui/Card';
import { WidgetHeading } from '../widget-meta';
import type { FavouriteAccountsViewProps } from './favourite-accounts-view';

/** The mark beside an account's name: its institution's logo, or else the star. */
export function AccountMark({ institution }: { institution?: InstitutionLogoData }) {
  if (institution?.hasLogo) return <InstitutionLogo institution={institution} size={20} />;
  return (
    <span className="flex h-5 w-5 shrink-0 items-center justify-center">
      <svg
        data-testid="favourite-account-star"
        aria-hidden="true"
        className="h-4 w-4 text-yellow-500"
        fill="currentColor"
        viewBox="0 0 20 20"
      >
        <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" />
      </svg>
    </span>
  );
}

/** The Reorder / Done toggle in the widget's header. */
export function ReorderToggle({
  reordering,
  onToggle,
  className,
}: {
  reordering: boolean;
  onToggle: () => void;
  className: string;
}) {
  const t = useTranslations('dashboard');
  return (
    <button
      onClick={onToggle}
      className={className}
      title={reordering ? t('favouriteAccounts.done') : t('favouriteAccounts.reorder')}
    >
      {reordering ? t('favouriteAccounts.done') : t('favouriteAccounts.reorder')}
    </button>
  );
}

/**
 * Favourite Accounts in the Standard style: a bordered tile per account. Also
 * the reorder mode of every style, which needs the drag handles and arrows.
 */
export function FavouriteAccountsStandard({
  rows,
  reordering,
  onToggleReorder,
  onMove,
  drag,
}: FavouriteAccountsViewProps) {
  const t = useTranslations('dashboard');
  const tAccounts = useTranslations('accounts');
  const { dragIndex, rowProps, dropIndicator } = drag;

  return (
    <div className={`${CARD_CLASS} p-3 sm:p-6`}>
      <div className="ui-widget-head flex items-center justify-between mb-4">
        <WidgetHeading id="favourite-accounts" href="/accounts">
          {t('favouriteAccounts.title')}
        </WidgetHeading>
        {rows.length > 1 && (
          <ReorderToggle
            reordering={reordering}
            onToggle={onToggleReorder}
            className={`text-xs px-2 py-1 rounded transition-colors ${
              reordering
                ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400'
                : `text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300 ${HOVER_TOOLBAR_BUTTON}`
            }`}
          />
        )}
      </div>
      {reordering && (
        <p className="-mt-2 mb-3 text-xs text-gray-500 dark:text-gray-400">
          {t('favouriteAccounts.dragToReorder')}
        </p>
      )}
      <div className="space-y-2 sm:space-y-3">
        {rows.map((row, index) => (
          <div
            key={row.id}
            data-testid={`favourite-account-row-${row.id}`}
            {...(reordering ? rowProps(index) : {})}
            draggable={reordering}
            className={`relative flex items-center gap-1 rounded-lg ${
              reordering ? 'cursor-grab' : ''
            } ${dragIndex === index ? 'opacity-50' : ''}`}
          >
            <DropIndicatorLine position={dropIndicator(index, rows.length)} />
            {reordering && (
              <span aria-hidden="true" className="select-none text-gray-400 flex-shrink-0">
                ⠿
              </span>
            )}
            {reordering && (
              <div className="flex flex-col gap-0.5 flex-shrink-0">
                <button
                  onClick={() => onMove(index, -1)}
                  disabled={index === 0}
                  className="p-0.5 rounded text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                  title={t('favouriteAccounts.moveUp')}
                >
                  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 15.75l7.5-7.5 7.5 7.5" />
                  </svg>
                </button>
                <button
                  onClick={() => onMove(index, 1)}
                  disabled={index === rows.length - 1}
                  className="p-0.5 rounded text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                  title={t('favouriteAccounts.moveDown')}
                >
                  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
                  </svg>
                </button>
              </div>
            )}
            {/* The card is a bordered wrapper; the navigation button sits
                inside it rather than being it. The statement-day help below
                carries its own `<button>` trigger, and a button inside a
                button is not a nesting the HTML parser allows -- it closes the
                outer one at the inner tag, which cost the card most of its
                click target and made the server and client markup disagree on
                hydration. Making the two buttons siblings is what removes the
                conflict, and it leaves the help trigger a real button, so it
                stays announced and keyboard-reachable.

                The whole card carries the click, not only that button. The
                wrapper is what draws the hover, so with the statement line
                outside the button the bottom of a credit-card tile advertised
                itself as clickable and did nothing -- the same defect as putting
                a row's click on its name cell. This is the clickable-row rule
                applied to a card: the container takes the click, the inner
                button remains the keyboard and screen-reader affordance, and the
                controls inside it stop propagation so they act on themselves
                (`InfoTooltip` does that for every call site). The owner's
                `open` does nothing while the list is being reordered. */}
            <div
              onClick={row.open}
              className={`flex-1 rounded-lg border border-gray-200 dark:border-gray-700 transition-colors ${
                reordering
                  ? ''
                  : `cursor-pointer hover:border-blue-400 dark:hover:border-blue-500 ${HOVER_ROW_ON_CARD}`
              }`}
            >
              <button
                onClick={(event) => {
                  // The wrapper already navigates; without this the click arrives
                  // twice.
                  event.stopPropagation();
                  row.open();
                }}
                className={`w-full flex items-center justify-between p-2 sm:p-3 text-left ${
                  reordering ? 'cursor-default' : ''
                }`}
              >
                <div className="flex items-center gap-2 min-w-0">
                  <AccountMark institution={row.institutionLogo} />
                  <div className="min-w-0">
                    <div className="font-medium text-gray-900 dark:text-gray-100 truncate">{row.name}</div>
                    {row.institution && (
                      <div className="text-xs text-gray-500 dark:text-gray-400">{row.institution}</div>
                    )}
                  </div>
                </div>
                {!row.value.known ? (
                  // Showing the cash we do know, in a total's place, would read
                  // as the account being worth that much.
                  <div className="text-right ml-2">
                    <div className="font-semibold whitespace-nowrap text-gray-500 dark:text-gray-400">
                      {'—'}
                    </div>
                    <div className="text-xs text-gray-500 dark:text-gray-400">
                      {tAccounts('row.combinedUnknown')}
                    </div>
                  </div>
                ) : (
                  <div className="text-right ml-2">
                    <div className={`font-semibold whitespace-nowrap ${gainLossColor(row.value.amount)}`}>
                      {row.value.text}
                    </div>
                    {row.value.breakdown !== null && (
                      <div className="text-xs text-gray-500 dark:text-gray-400">{row.value.breakdown}</div>
                    )}
                  </div>
                )}
              </button>
              {/* Below the navigation button, not within it, so the help
                  triggers are its siblings. Indented to the account name's
                  column so the line still reads as part of the card. */}
              {(row.statementDueDay || row.statementSettlementDay) && (
                <div className="flex flex-col sm:flex-row sm:items-center sm:gap-2 text-xs text-gray-500 dark:text-gray-400 -mt-1 ml-7 px-2 pb-2 sm:px-3 sm:pb-3">
                  {row.statementDueDay && (
                    <span className="flex items-center">
                      {t('favouriteAccounts.due', { ordinal: getOrdinal(row.statementDueDay) })}
                      <InfoTooltip text={t('favouriteAccounts.dueTooltip')} />
                    </span>
                  )}
                  {row.statementSettlementDay && (
                    <span className="flex items-center">
                      {t('favouriteAccounts.settlement', { ordinal: getOrdinal(row.statementSettlementDay) })}
                      <InfoTooltip text={t('favouriteAccounts.settlementTooltip')} />
                    </span>
                  )}
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
