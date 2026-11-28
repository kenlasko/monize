'use client';

import { useState, useCallback, useMemo } from 'react';
import { withCurrencyCode } from '@/lib/format';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Account } from '@/types/account';
import { isInvestmentCashHalf } from '@/lib/account-utils';
import { buildLogicalAccounts, type LogicalAccount } from '@/lib/logical-accounts';
import { useMainAccountName } from '@/hooks/useMainAccountName';
import { usePreferencesStore } from '@/store/preferencesStore';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { accountsApi } from '@/lib/accounts';
import type { InstitutionLogoData } from '@/components/institutions/InstitutionLogo';
import { useDragReorder } from '@/hooks/useDragReorder';
import { renderForStyle, useUiStyle, type StyleVariants } from '@/hooks/useUiStyle';
import type { FavouriteAccountRow, FavouriteAccountsViewProps } from './variants/favourite-accounts-view';
import { FavouriteAccountsStandard } from './variants/FavouriteAccountsStandard';
import { FavouriteAccountsFolio } from './variants/FavouriteAccountsFolio';
import { FavouriteAccountsPebble } from './variants/FavouriteAccountsPebble';
import { WidgetHeading } from './widget-meta';
import { CARD_CLASS } from '@/components/ui/Card';
import { preferredCurrency } from '@/lib/default-currency';
import { useViewDefault } from '@/hooks/useViewDefault';
import { opensAccountDashboard } from '@/lib/account-detail-views';
import { BUILT_IN_VIEW_DEFAULTS } from '@/lib/view-defaults';

interface FavouriteAccountsProps {
  accounts: Account[];
  brokerageMarketValues?: Map<string, number>;
  /** Holdings account id -> how many of its holdings have no price. */
  unpricedHoldingCounts?: Map<string, number>;
  /** Holdings account ids whose valuation is a subtotal for any cause, a missing rate included. */
  incompleteHoldingAccountIds?: ReadonlySet<string>;
  /** Where each card's logo comes from; a card without one shows the star. */
  institutions?: InstitutionLogoData[];
  isLoading: boolean;
  /** The accounts request failed; `accounts` is then empty, not "no favourites". */
  error?: boolean;
  onAccountsChanged?: () => void;
}

const FAVOURITE_ACCOUNTS_VARIANTS: StyleVariants<FavouriteAccountsViewProps> = {
  standard: FavouriteAccountsStandard,
  folio: FavouriteAccountsFolio,
  pebble: FavouriteAccountsPebble,
};

export function FavouriteAccounts({ accounts, brokerageMarketValues, unpricedHoldingCounts, incompleteHoldingAccountIds, institutions, isLoading, error = false, onAccountsChanged: _onAccountsChanged }: FavouriteAccountsProps) {
  const mainAccountName = useMainAccountName();
  const t = useTranslations('dashboard');
  const uiStyle = useUiStyle();
  const tAccounts = useTranslations('accounts');
  const router = useRouter();
  const preferences = usePreferencesStore((s) => s.preferences);
  const accountOpenTarget =
    useViewDefault('accountOpenTarget') ?? BUILT_IN_VIEW_DEFAULTS.accountOpenTarget;
  const { formatCurrency } = useNumberFormat();
  const defaultCurrency = preferredCurrency(preferences?.defaultCurrency);
  const [reordering, setReordering] = useState(false);
  const [localOrder, setLocalOrder] = useState<{ accounts: Account[]; order: Account[] } | null>(null);

  // Invalidate local order when parent accounts reference changes
  const effectiveLocalOrder = localOrder?.accounts === accounts ? localOrder.order : null;

  const institutionsById = useMemo(
    () => new Map((institutions ?? []).map((i) => [i.id, i])),
    [institutions],
  );

  // The entity each card stands for, keyed by either of its ledger ids, so a
  // card knows the account's name and what it is worth across both halves.
  const logicalByMemberId = useMemo(() => {
    const map = new Map<string, LogicalAccount>();
    for (const logical of buildLogicalAccounts(accounts, mainAccountName, {
      marketValues: brokerageMarketValues ?? new Map(),
      unpricedCounts: unpricedHoldingCounts ?? new Map(),
      incompleteAccountIds: incompleteHoldingAccountIds,
    })) {
      for (const id of logical.memberIds) map.set(id, logical);
    }
    return map;
  }, [accounts, mainAccountName, brokerageMarketValues, unpricedHoldingCounts, incompleteHoldingAccountIds]);

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
   * Where a card goes when it is clicked: the account's register, or its
   * detail page for a reader who chose the dashboard in Settings
   * (`accountOpenTarget`). Nothing moves while the list is being reordered --
   * a drag that ends over a card must not navigate.
   */
  const navigateTo = (account: Account) => () => {
    if (reordering) return;
    const logical = logicalByMemberId.get(account.id);
    const target = logical?.primary ?? account;
    router.push(
      opensAccountDashboard(target.accountType, accountOpenTarget)
        ? `/accounts/${target.id}`
        : target.accountSubType === 'INVESTMENT_BROKERAGE'
          ? `/investments?accountId=${target.id}`
          : `/transactions?accountId=${target.id}`,
    );
  };

  // An account's figures are in its own currency, named when that is not the
  // reader's.
  const formatInAccountCurrency = (amount: number, currencyCode: string) =>
    withCurrencyCode(formatCurrency(amount, currencyCode), currencyCode, defaultCurrency);

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

  const drag = useDragReorder(applyReorder);

  if (isLoading) {
    return (
      <div className={`${CARD_CLASS} p-3 sm:p-6`}>
        <WidgetHeading id="favourite-accounts" href="/accounts" className="mb-4">
          {t('favouriteAccounts.title')}
        </WidgetHeading>
        <div className="animate-pulse skeleton-shimmer space-y-3">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-12 bg-gray-200 dark:bg-gray-700 rounded" />
          ))}
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className={`${CARD_CLASS} p-3 sm:p-6`}>
        <WidgetHeading id="favourite-accounts" href="/accounts" className="mb-4">
          {t('favouriteAccounts.title')}
        </WidgetHeading>
        <p role="alert" className="text-gray-500 dark:text-gray-400 text-sm">
          {t('favouriteAccounts.loadFailed')}
        </p>
      </div>
    );
  }

  if (favouriteAccounts.length === 0) {
    return (
      <div className={`${CARD_CLASS} p-3 sm:p-6`}>
        <WidgetHeading id="favourite-accounts" href="/accounts" className="mb-4">
          {t('favouriteAccounts.title')}
        </WidgetHeading>
        <p className="text-gray-500 dark:text-gray-400 text-sm">
          {t('favouriteAccounts.empty')}
        </p>
      </div>
    );
  }

  const rows: FavouriteAccountRow[] = favouriteAccounts.map((account) => {
    const logical = logicalByMemberId.get(account.id);
    const holdsSecurities = !!logical?.holdingsAccountId;
    const combined = logical?.combinedValue ?? null;
    const isCard = account.accountType === 'CREDIT_CARD';
    const base = {
      id: account.id,
      // The account, not the ledger: a pair's stored names carry a suffix the
      // user never chose.
      name: logical?.displayName ?? account.name,
      institution: account.institution || null,
      institutionLogo: account.institutionId ? institutionsById.get(account.institutionId) : undefined,
      statementDueDay: isCard ? account.statementDueDay || null : null,
      statementSettlementDay: isCard ? account.statementSettlementDay || null : null,
      open: navigateTo(account),
    };
    if (holdsSecurities && combined === null) {
      // Showing the cash we do know, in a total's place, would read as the
      // account being worth that much.
      return { ...base, value: { known: false } };
    }
    const marketValue = logical?.holdingsAccountId
      ? brokerageMarketValues?.get(logical.holdingsAccountId)
      : undefined;
    const displayValue = combined ??
      (Number(account.currentBalance) || 0) + (Number(account.futureTransactionsSum) || 0);
    return {
      ...base,
      value: {
        known: true,
        amount: displayValue,
        currencyCode: account.currencyCode,
        foreign: account.currencyCode !== defaultCurrency,
        text: formatInAccountCurrency(displayValue, account.currencyCode),
        breakdown:
          holdsSecurities && marketValue !== undefined
            ? tAccounts('row.combinedBreakdown', {
                investments: formatInAccountCurrency(marketValue, account.currencyCode),
                cash: formatInAccountCurrency(
                  logical?.cash
                    ? (Number(logical.cash.currentBalance) || 0) +
                        (Number(logical.cash.futureTransactionsSum) || 0)
                    : (Number(account.currentBalance) || 0) +
                        (Number(account.futureTransactionsSum) || 0),
                  account.currencyCode,
                ),
              })
            : null,
      },
    };
  });

  return renderForStyle(uiStyle, FAVOURITE_ACCOUNTS_VARIANTS, {
    rows,
    reordering,
    onToggleReorder: () => setReordering(!reordering),
    onMove: moveAccount,
    drag,
  });
}
