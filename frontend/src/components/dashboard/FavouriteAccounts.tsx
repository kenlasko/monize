'use client';

import { useState, useCallback, useMemo } from 'react';
import { gainLossColor } from '@/lib/format';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Account } from '@/types/account';
import { isInvestmentCashHalf } from '@/lib/account-utils';
import { buildLogicalAccounts, type LogicalAccount } from '@/lib/logical-accounts';
import { useMainAccountName } from '@/hooks/useMainAccountName';
import { usePreferencesStore } from '@/store/preferencesStore';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { accountsApi } from '@/lib/accounts';
import { InfoTooltip } from '@/components/ui/InfoTooltip';
import { getOrdinal } from '@/lib/ordinal';
import { useDragReorder, DropIndicatorLine } from '@/hooks/useDragReorder';
import { WidgetHeading } from './widget-meta';
import { CARD_CLASS } from '@/components/ui/Card';

interface FavouriteAccountsProps {
  accounts: Account[];
  brokerageMarketValues?: Map<string, number>;
  /** Holdings account id -> how many of its holdings have no price. */
  unpricedHoldingCounts?: Map<string, number>;
  isLoading: boolean;
  onAccountsChanged?: () => void;
}

export function FavouriteAccounts({ accounts, brokerageMarketValues, unpricedHoldingCounts, isLoading, onAccountsChanged: _onAccountsChanged }: FavouriteAccountsProps) {
  const mainAccountName = useMainAccountName();
  const t = useTranslations('dashboard');
  const tAccounts = useTranslations('accounts');
  const router = useRouter();
  const preferences = usePreferencesStore((s) => s.preferences);
  const { formatCurrency: formatCurrencyBase } = useNumberFormat();
  const defaultCurrency = preferences?.defaultCurrency || 'CAD';
  const [reordering, setReordering] = useState(false);
  const [localOrder, setLocalOrder] = useState<{ accounts: Account[]; order: Account[] } | null>(null);

  // Invalidate local order when parent accounts reference changes
  const effectiveLocalOrder = localOrder?.accounts === accounts ? localOrder.order : null;

  // The entity each card stands for, keyed by either of its ledger ids, so a
  // card knows the account's name and what it is worth across both halves.
  const logicalByMemberId = useMemo(() => {
    const map = new Map<string, LogicalAccount>();
    for (const logical of buildLogicalAccounts(accounts, mainAccountName, {
      marketValues: brokerageMarketValues ?? new Map(),
      unpricedCounts: unpricedHoldingCounts ?? new Map(),
    })) {
      for (const id of logical.memberIds) map.set(id, logical);
    }
    return map;
  }, [accounts, mainAccountName, brokerageMarketValues, unpricedHoldingCounts]);

  // Favouriting both halves of a pair is favouriting one account, so it gets
  // one card -- the brokerage half stands for the entity.
  const favouritedIds = useMemo(
    () => new Set(accounts.filter((a) => a.isFavourite && !a.isClosed).map((a) => a.id)),
    [accounts],
  );

  const favouriteAccounts = effectiveLocalOrder ??
    [...accounts]
      .filter((a) => a.isFavourite && !a.isClosed)
      .filter(
        (a) =>
          !(isInvestmentCashHalf(a) && favouritedIds.has(a.linkedAccountId!)),
      )
      .sort((a, b) => a.favouriteSortOrder - b.favouriteSortOrder);

  /**
   * Where a card goes when it is clicked. Nothing moves while the list is being
   * reordered -- a drag that ends over a card must not navigate.
   */
  const navigateTo = (account: Account) => () => {
    if (reordering) return;
    const logical = logicalByMemberId.get(account.id);
    const target = logical?.primary ?? account;
    router.push(
      target.accountSubType === 'INVESTMENT_BROKERAGE'
        ? `/investments?accountId=${target.id}`
        : `/transactions?accountId=${target.id}`,
    );
  };

  const formatCurrency = (amount: number | string | null | undefined, currency: string) => {
    const numericAmount = Number(amount) || 0;
    const formatted = formatCurrencyBase(numericAmount, currency);

    // Only show currency code if it differs from user's default currency
    if (currency !== defaultCurrency) {
      return `${formatted} ${currency}`;
    }
    return formatted;
  };

  const applyReorder = useCallback(
    async (from: number, to: number) => {
      const current = effectiveLocalOrder ??
        [...accounts]
          .filter((a) => a.isFavourite && !a.isClosed)
          .filter(
            (a) =>
              !(
                isInvestmentCashHalf(a) &&
                a.linkedAccountId !== null &&
                accounts.some(
                  (other) =>
                    other.id === a.linkedAccountId &&
                    other.isFavourite &&
                    !other.isClosed,
                )
              ),
          )
          .sort((a, b) => a.favouriteSortOrder - b.favouriteSortOrder);

      if (from === to || to < 0 || to >= current.length) return;

      const reordered = [...current];
      const [moved] = reordered.splice(from, 1);
      reordered.splice(to, 0, moved);

      setLocalOrder({ accounts, order: reordered });

      try {
        await accountsApi.reorderFavourites(reordered.map((a) => a.id));
      } catch {
        setLocalOrder(null);
      }
    },
    [accounts, effectiveLocalOrder],
  );

  const moveAccount = useCallback(
    (index: number, direction: -1 | 1) => applyReorder(index, index + direction),
    [applyReorder],
  );

  const { dragIndex, rowProps, dropIndicator } = useDragReorder(applyReorder);

  if (isLoading) {
    return (
      <div className={`${CARD_CLASS} p-3 sm:p-6 lg:self-start`}>
        <WidgetHeading id="favourite-accounts" className="mb-4">
          {t('favouriteAccounts.title')}
        </WidgetHeading>
        <div className="animate-pulse space-y-3">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-12 bg-gray-200 dark:bg-gray-700 rounded" />
          ))}
        </div>
      </div>
    );
  }

  if (favouriteAccounts.length === 0) {
    return (
      <div className={`${CARD_CLASS} p-3 sm:p-6 lg:self-start`}>
        <WidgetHeading id="favourite-accounts" className="mb-4">
          {t('favouriteAccounts.title')}
        </WidgetHeading>
        <p className="text-gray-500 dark:text-gray-400 text-sm">
          {t('favouriteAccounts.empty')}
        </p>
      </div>
    );
  }

  return (
    <div className={`${CARD_CLASS} p-3 sm:p-6 lg:self-start`}>
      <div className="flex items-center justify-between mb-4">
        <WidgetHeading id="favourite-accounts">
          {t('favouriteAccounts.title')}
        </WidgetHeading>
        {favouriteAccounts.length > 1 && (
          <button
            onClick={() => setReordering(!reordering)}
            className={`text-xs px-2 py-1 rounded transition-colors ${
              reordering
                ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400'
                : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700'
            }`}
            title={reordering ? t('favouriteAccounts.done') : t('favouriteAccounts.reorder')}
          >
            {reordering ? t('favouriteAccounts.done') : t('favouriteAccounts.reorder')}
          </button>
        )}
      </div>
      {reordering && (
        <p className="-mt-2 mb-3 text-xs text-gray-500 dark:text-gray-400">
          {t('favouriteAccounts.dragToReorder')}
        </p>
      )}
      <div className="space-y-2 sm:space-y-3">
        {favouriteAccounts.map((account, index) => (
          <div
            key={account.id}
            data-testid={`favourite-account-row-${account.id}`}
            {...(reordering ? rowProps(index) : {})}
            draggable={reordering}
            className={`relative flex items-center gap-1 rounded-lg ${
              reordering ? 'cursor-grab' : ''
            } ${dragIndex === index ? 'opacity-50' : ''}`}
          >
            <DropIndicatorLine position={dropIndicator(index, favouriteAccounts.length)} />
            {reordering && (
              <span aria-hidden="true" className="select-none text-gray-400 flex-shrink-0">
                ⠿
              </span>
            )}
            {reordering && (
              <div className="flex flex-col gap-0.5 flex-shrink-0">
                <button
                  onClick={() => moveAccount(index, -1)}
                  disabled={index === 0}
                  className="p-0.5 rounded text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                  title={t('favouriteAccounts.moveUp')}
                >
                  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 15.75l7.5-7.5 7.5 7.5" />
                  </svg>
                </button>
                <button
                  onClick={() => moveAccount(index, 1)}
                  disabled={index === favouriteAccounts.length - 1}
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
                (`InfoTooltip` does that for every call site). */}
            <div
              onClick={navigateTo(account)}
              className={`flex-1 rounded-lg border border-gray-200 dark:border-gray-700 transition-colors ${
                reordering
                  ? ''
                  : 'cursor-pointer hover:border-blue-400 hover:bg-gray-50 dark:hover:border-blue-500 dark:hover:bg-gray-700/50'
              }`}
            >
            <button
              onClick={(event) => {
                // The wrapper already navigates; without this the click arrives
                // twice.
                event.stopPropagation();
                navigateTo(account)();
              }}
              className={`w-full flex items-center justify-between p-2 sm:p-3 text-left ${
                reordering ? 'cursor-default' : ''
              }`}
            >
              <div className="flex items-center gap-2 min-w-0">
                <svg
                  className="w-4 h-4 text-yellow-500"
                  fill="currentColor"
                  viewBox="0 0 20 20"
                >
                  <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" />
                </svg>
                <div className="min-w-0">
                  <div className="font-medium text-gray-900 dark:text-gray-100 truncate">
                    {/* The account, not the ledger: a pair's stored names carry
                        a suffix the user never chose. */}
                    {logicalByMemberId.get(account.id)?.displayName ?? account.name}
                  </div>
                  {account.institution && (
                    <div className="text-xs text-gray-500 dark:text-gray-400">
                      {account.institution}
                    </div>
                  )}
                </div>
              </div>
              {(() => {
                const logical = logicalByMemberId.get(account.id);
                const holdsSecurities = !!logical?.holdingsAccountId;
                const combined = logical?.combinedValue ?? null;
                if (holdsSecurities && combined === null) {
                  // Showing the cash we do know, in a total's place, would read
                  // as the account being worth that much.
                  return (
                    <div className="text-right ml-2">
                      <div className="font-semibold whitespace-nowrap text-gray-500 dark:text-gray-400">
                        {'\u2014'}
                      </div>
                      <div className="text-xs text-gray-500 dark:text-gray-400">
                        {tAccounts('row.combinedUnknown')}
                      </div>
                    </div>
                  );
                }
                const marketValue = logical?.holdingsAccountId
                  ? brokerageMarketValues?.get(logical.holdingsAccountId)
                  : undefined;
                const displayValue = combined ??
                  (Number(account.currentBalance) || 0) + (Number(account.futureTransactionsSum) || 0);
                return (
                  <div className="text-right ml-2">
                    <div
                      className={`font-semibold whitespace-nowrap ${
                        gainLossColor(displayValue)
                      }`}
                    >
                      {formatCurrency(displayValue, account.currencyCode)}
                    </div>
                    {holdsSecurities && marketValue !== undefined && (
                      <div className="text-xs text-gray-500 dark:text-gray-400">
                        {tAccounts('row.combinedBreakdown', {
                          investments: formatCurrency(marketValue, account.currencyCode),
                          cash: formatCurrency(
                            logical?.cash
                              ? (Number(logical.cash.currentBalance) || 0) +
                                  (Number(logical.cash.futureTransactionsSum) || 0)
                              : (Number(account.currentBalance) || 0) +
                                  (Number(account.futureTransactionsSum) || 0),
                            account.currencyCode,
                          ),
                        })}
                      </div>
                    )}
                  </div>
                );
              })()}
            </button>
            {/* Below the navigation button, not within it, so the help
                triggers are its siblings. Indented to the account name's
                column so the line still reads as part of the card. */}
            {account.accountType === 'CREDIT_CARD' &&
              (account.statementDueDay || account.statementSettlementDay) && (
              <div className="flex flex-col sm:flex-row sm:items-center sm:gap-2 text-xs text-gray-500 dark:text-gray-400 -mt-1 ml-8 px-2 pb-2 sm:px-3 sm:pb-3">
                {account.statementDueDay && (
                  <span className="flex items-center">
                    {t('favouriteAccounts.due', { ordinal: getOrdinal(account.statementDueDay) })}
                    <InfoTooltip text={t('favouriteAccounts.dueTooltip')} />
                  </span>
                )}
                {account.statementSettlementDay && (
                  <span className="flex items-center">
                    {t('favouriteAccounts.settlement', { ordinal: getOrdinal(account.statementSettlementDay) })}
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
