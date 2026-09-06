'use client';

import { memo, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { gainLossColor } from '@/lib/format';
import { Account, AccountType } from '@/types/account';
import { AccountTypePill, AccountTypeIcon } from '@/lib/account-type-meta';
import { hasAccountDetailView } from '@/lib/account-detail-views';
import { InstitutionLogo, InstitutionLogoData } from '@/components/institutions/InstitutionLogo';
import { RowActions } from '@/components/ui/row-actions/RowActions';
import type { LongPressRowHandlers } from '@/hooks/useLongPress';
import type { RowAction } from '@/components/ui/row-actions/rowAction';
import type { LogicalAccount } from '@/lib/logical-accounts';

export interface AccountActionLabels {
  viewTransactions: string;
  details: string;
  edit: string;
  reconcile: string;
  close: string;
  closeTitleDisabled: string;
  closeTitleEnabled: string;
  /** Why Close is unavailable when the account's total cannot be worked out. */
  closeTitleUnknownValue?: string;
  reopen: string;
  delete: string;
  includeInNetWorth?: string;
  excludeFromNetWorth?: string;
}

export interface AccountActionHandlers {
  onViewTransactions?: (account: Account) => void;
  onDetails?: (account: Account) => void;
  onEdit: (account: Account) => void;
  /**
   * Takes the id of the ledger to reconcile, which is not always the row's own
   * account: a linked pair reconciles its cash half.
   */
  onReconcile: (accountId: string) => void;
  onCloseClick: (account: Account) => void;
  onReopen: (account: Account) => void;
  onDeleteClick: (account: Account) => void;
  // Joint rows only: the grantee's per-account net-worth exclusion toggle.
  onToggleNetWorthExclusion?: (account: Account) => void;
}

/**
 * Builds the standard row actions for an account. Shared by the desktop
 * `RowActions` cell and the mobile `RowActionSheet`. The desktop surface omits
 * "View transactions" (a row tap already opens it) by leaving `onViewTransactions`
 * undefined; the action sheet supplies it.
 */
/**
 * The "approximately X in your display currency" line under a foreign balance.
 *
 * Renders nothing when the rate is unknown. Printing the unconverted amount
 * beside the display currency's symbol -- which is what happened before -- is a
 * wrong number, not an approximate one, and the "approximately" sign made it
 * look deliberate.
 */
function ApproxInDefault({
  amount,
  defaultCurrency,
  format,
}: {
  amount: number | null;
  defaultCurrency: string;
  format: (value: number, currencyCode: string) => string;
}) {
  if (amount === null) return null;
  return (
    <div className="text-xs text-gray-400 dark:text-gray-500">
      {'\u2248 '}
      {format(amount, defaultCurrency)}
    </div>
  );
}

/**
 * The favourite star. Rendered by both layouts (the tier row and the phone's
 * wrapped card) from this one place so the two cannot drift: it is a control
 * inside a clickable row, so its click must not also open the account.
 */
function FavouriteMark({
  account,
  onToggleFavourite,
}: {
  account: Account;
  onToggleFavourite?: (account: Account) => void;
}) {
  const t = useTranslations('accounts');
  if (onToggleFavourite) {
    return (
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onToggleFavourite(account);
        }}
        className={`mr-1 flex-shrink-0 ${account.isFavourite ? 'text-yellow-500' : 'text-gray-300 dark:text-gray-600 hover:text-yellow-500'}`}
        aria-label={
          account.isFavourite
            ? t('row.removeFromFavourites')
            : t('row.addToFavourites')
        }
        aria-pressed={account.isFavourite}
        title={
          account.isFavourite
            ? t('row.removeFromFavourites')
            : t('row.addToFavourites')
        }
      >
        <svg
          className="w-4 h-4"
          fill={account.isFavourite ? 'currentColor' : 'none'}
          stroke="currentColor"
          viewBox="0 0 20 20"
        >
          <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" />
        </svg>
      </button>
    );
  }
  if (!account.isFavourite) return null;
  return (
    <svg
      className="w-4 h-4 mr-1 flex-shrink-0 text-yellow-500"
      fill="currentColor"
      viewBox="0 0 20 20"
      aria-label={t('row.favourite')}
    >
      <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" />
    </svg>
  );
}

/** The "Joint" badge beside the name, in both layouts. */
function JointBadge({ account }: { account: Account }) {
  const t = useTranslations('accounts');
  if (!account.isJoint && account.jointGranteeCount === undefined) return null;
  return (
    <span
      className="ml-1.5 px-2 inline-flex flex-shrink-0 text-xs leading-5 font-semibold rounded-full bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200"
      title={
        account.isJoint
          ? t('row.jointSharedBy', { owner: account.ownerLabel ?? '' })
          : t('row.jointSharedWith', {
              count: account.jointGranteeCount ?? 0,
            })
      }
    >
      {t('row.jointBadge')}
    </span>
  );
}

/** Active/Closed pill, in both layouts. */
function AccountStatusPill({ account }: { account: Account }) {
  const t = useTranslations('accounts');
  return (
    <span
      className={`px-2 inline-flex text-xs leading-5 font-semibold rounded-full ${
        !account.isClosed
          ? 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200'
          : 'bg-gray-100 text-gray-800 dark:bg-gray-700 dark:text-gray-300'
      }`}
    >
      {!account.isClosed ? t('row.statusActive') : t('row.statusClosed')}
    </span>
  );
}

/**
 * The type label the row shows: a folded pair is one investment account, so it
 * takes the plain type; an unfolded half still says which half it is.
 */
function AccountTypeLabel({
  account,
  isFolded,
  formatAccountType,
}: {
  account: Account;
  isFolded: boolean;
  formatAccountType: (type: AccountType) => string;
}) {
  const t = useTranslations('accounts');
  return (
    <>
      {isFolded
        ? formatAccountType(account.accountType)
        : account.accountSubType === 'INVESTMENT_BROKERAGE'
          ? t('row.subtypeBrokerage')
          : account.accountSubType === 'INVESTMENT_CASH'
            ? t('row.subtypeInvCash')
            : formatAccountType(account.accountType)}
    </>
  );
}

export function buildAccountActions(
  account: Account,
  isDeletable: boolean,
  labels: AccountActionLabels,
  handlers: AccountActionHandlers,
  logical?: LogicalAccount,
): RowAction[] {
  // Closing empties the whole account, so the test is the entity's combined
  // value -- a brokerage's own `currentBalance` is always zero and says
  // nothing about the securities it holds.
  const balanceNonZero = logical
    ? logical.combinedValue === null ||
      Math.round(logical.combinedValue * 10000) !== 0
    : Number(account.currentBalance) !== 0;
  // An unknown total is not a zero one: Close stays unavailable, and says why.
  const valueUnknown = !!logical && logical.combinedValue === null;
  // Reconciling means comparing a cash ledger against a statement. A pair
  // reconciles its cash half; a brokerage with no cash half has no such ledger.
  const reconcileTargetId = logical
    ? logical.cashRegisterId
    : account.accountSubType === 'INVESTMENT_BROKERAGE'
      ? null
      : account.id;
  // A joint row is another user's account shown natively: the account object
  // itself (edit/close/reopen/delete) and reconciliation stay owner-only. The
  // grantee instead gets their personal net-worth inclusion toggle.
  const isJoint = !!account.isJoint;
  return [
    {
      key: 'view',
      label: labels.viewTransactions,
      icon: 'transactions',
      tone: 'neutral',
      onClick: () => handlers.onViewTransactions?.(account),
      hidden: !handlers.onViewTransactions,
    },
    {
      key: 'details',
      label: labels.details,
      icon: 'view',
      tone: 'primary',
      onClick: () => handlers.onDetails?.(account),
      hidden:
        !handlers.onDetails || !hasAccountDetailView(account.accountType),
    },
    {
      key: 'edit',
      label: labels.edit,
      icon: 'edit',
      tone: 'primary',
      onClick: () => handlers.onEdit(account),
      hidden: account.isClosed || isJoint,
    },
    {
      key: 'reconcile',
      label: labels.reconcile,
      icon: 'reconcile',
      tone: 'success',
      onClick: () =>
        reconcileTargetId && handlers.onReconcile(reconcileTargetId),
      hidden: account.isClosed || reconcileTargetId === null || isJoint,
    },
    {
      key: 'netWorthExclusion',
      label: account.excludeFromNetWorth
        ? (labels.includeInNetWorth ?? '')
        : (labels.excludeFromNetWorth ?? ''),
      icon: 'view',
      tone: 'neutral',
      onClick: () => handlers.onToggleNetWorthExclusion?.(account),
      hidden: !isJoint || !handlers.onToggleNetWorthExclusion,
    },
    {
      key: 'close',
      label: labels.close,
      icon: 'close',
      tone: 'warning',
      onClick: () => handlers.onCloseClick(account),
      hidden: account.isClosed || isJoint,
      disabled: balanceNonZero,
      title: valueUnknown
        ? (labels.closeTitleUnknownValue ?? labels.closeTitleDisabled)
        : balanceNonZero
          ? labels.closeTitleDisabled
          : labels.closeTitleEnabled,
    },
    {
      key: 'reopen',
      label: labels.reopen,
      icon: 'reopen',
      tone: 'primary',
      onClick: () => handlers.onReopen(account),
      hidden: !account.isClosed || isJoint,
    },
    {
      key: 'delete',
      label: labels.delete,
      icon: 'delete',
      tone: 'delete',
      destructive: true,
      onClick: () => handlers.onDeleteClick(account),
      hidden: !isDeletable || isJoint,
    },
  ];
}

export interface AccountRowProps {
  account: Account;
  index: number;
  density: 'normal' | 'compact' | 'dense';
  cellPadding: string;
  isDeletable: boolean;
  accountNameMap: Map<string, string>;
  // Institution the account belongs to (for the brand icon). Undefined for
  // cashflow-only accounts, which render a neutral fallback badge.
  institution?: InstitutionLogoData;
  /**
   * The account as the user thinks of it. Supplied by the accounts list, where
   * a linked brokerage/cash pair is one row: the row then shows the pair's
   * combined value and its name without the " - Brokerage" suffix. Omitted by
   * callers that render raw accounts, which keep the single-account
   * presentation.
   */
  logical?: LogicalAccount;
  /**
   * Render the row as a wrapped card instead of the tier table's cells. The
   * list sets it for phones at Normal density only (Model B: on a phone the
   * density toggle picks the layout); every other width and level renders the
   * tier row below, unchanged.
   *
   * The card carries every value the tier row shows at Normal density -- the
   * brand badge, the favourite star, the name with its Joint badge and its
   * paired/shared/description lines, the balance with its breakdown, credit
   * limit and approximate-in-default lines, the type pill and the status pill.
   * Only the Actions column is left out: they are what the long-press (and
   * right-click) action sheet these same row handlers open already carries.
   *
   * Note the two breakpoints are not the same one. The tier row's Actions cell
   * is `min-[480px]`, and `wrapped` covers everything below 640px, so between
   * 480px and 639px at Normal density the actions move from inline buttons to
   * that sheet -- which also means they stop being tab-reachable there, since
   * the sheet opens on long-press or right-click. It is the price of the card,
   * paid for the Type and Status this table hides below `sm`/`md`, and the
   * register's wrapped card makes the same trade at the same two widths
   * (`exceptPhones` is 480 in `register-columns.ts`, its card is `< 640`), so
   * the two tables behave alike. Compact density, one tap away, is the way
   * back to inline actions.
   */
  wrapped?: boolean;
  brokerageMarketValue: number | undefined;
  /** How many of this account's holdings have no price. Drives the unknown-value tooltip. */
  unpricedHoldingsCount?: number;
  defaultCurrency: string;
  formatCurrency: (amount: number | string | null | undefined, currency: string) => string;
  formatCurrencyBase: (value: number, currencyCode?: string) => string;
  /** Returns `null` when no rate for the pair is known. */
  convertToDefault: (value: number, fromCurrency: string) => number | null;
  formatAccountType: (type: AccountType) => string;
  actionLabels: AccountActionLabels;
  onDetails: (account: Account) => void;
  onEdit: (account: Account) => void;
  onReconcile: (accountId: string) => void;
  onCloseClick: (account: Account) => void;
  onDeleteClick: (account: Account) => void;
  onReopen: (account: Account) => void;
  getRowHandlers: (account: Account) => LongPressRowHandlers;
  // Provided only in delegate (acting) view: makes the favourite star an
  // interactive toggle for the delegate's own (non-shared) favourites.
  onToggleFavourite?: (account: Account) => void;
  // Joint rows only: the grantee's net-worth inclusion toggle.
  onToggleNetWorthExclusion?: (account: Account) => void;
}

export const AccountRow = memo(function AccountRow({
  account,
  index,
  density,
  cellPadding,
  isDeletable,
  accountNameMap,
  institution,
  logical,
  wrapped = false,
  brokerageMarketValue,
  unpricedHoldingsCount,
  defaultCurrency,
  formatCurrency,
  formatCurrencyBase,
  convertToDefault,
  formatAccountType,
  actionLabels,
  onDetails,
  onEdit,
  onReconcile,
  onCloseClick,
  onDeleteClick,
  onReopen,
  getRowHandlers,
  onToggleFavourite,
  onToggleNetWorthExclusion,
}: AccountRowProps) {
  const t = useTranslations('accounts');
  // A folded pair is one account with two ledgers behind it, so the row drops
  // the pairing chrome (the chain-link icon and the "Paired with" line) that
  // exists to explain two rows to each other, and shows the entity's name.
  const isFolded = !!logical?.cash;
  const displayName = logical?.displayName ?? account.name;
  // Standalone and orphan-brokerage investment accounts hold securities too,
  // so they get the same combined presentation -- the pair is not a special
  // case, it is the case with two ledgers.
  // Non-null exactly when this row should show a combined investment value.
  const combined =
    logical && logical.holdingsAccountId !== null ? logical : null;
  const ownTotalBalance =
    (Number(account.currentBalance) || 0) +
    (Number(account.futureTransactionsSum) || 0);
  const cashComponent = logical?.cash
    ? (Number(logical.cash.currentBalance) || 0) +
      (Number(logical.cash.futureTransactionsSum) || 0)
    : ownTotalBalance;
  const showPairingChrome =
    !isFolded &&
    !!account.linkedAccountId &&
    (account.accountSubType === 'INVESTMENT_CASH' ||
      account.accountSubType === 'INVESTMENT_BROKERAGE');
  const actions = buildAccountActions(account, isDeletable, actionLabels, {
    onDetails,
    onEdit,
    onReconcile,
    onCloseClick,
    onReopen,
    onDeleteClick,
    onToggleNetWorthExclusion,
  }, logical);

  // What the Balance column says, decided ONCE for both layouts. `figure` is
  // the headline number (or the em dash that says it cannot be worked out);
  // `details` are the secondary lines under it. The two layouts place them
  // differently -- the tier cell stacks them in one right-aligned `<td>`, the
  // card keeps the figure on line 1 beside the name and puts the details
  // below -- but neither decides WHICH of them to show, so a wrapped card and
  // a tier row can never disagree about an account's worth.
  const balance: { figure: ReactNode; details: ReactNode } = combined
    ? combined.combinedValue === null
      ? {
          /* Some component of the total is unknown. Showing the part we do
             know -- the cash -- would read as the account's worth, so the
             row says it cannot be worked out instead. */
          figure: (
            <div
              className="text-sm font-medium text-gray-500 dark:text-gray-400"
              title={
                unpricedHoldingsCount
                  ? t('row.combinedUnknownTooltip', { count: unpricedHoldingsCount })
                  : t('row.combinedUnknownNoPortfolio')
              }
            >
              {'—'}
            </div>
          ),
          details: density === 'normal' && (
            <div className="text-xs text-gray-500 dark:text-gray-400">
              {t('row.combinedUnknown')}
            </div>
          ),
        }
      : {
          figure: (
            <div className={`text-sm font-medium ${gainLossColor(combined.combinedValue)}`}>
              {formatCurrency(combined.combinedValue, account.currencyCode)}
            </div>
          ),
          details: (
            <>
              {density === 'normal' && brokerageMarketValue !== undefined && (
                <div className="text-xs text-gray-500 dark:text-gray-400">
                  {t('row.combinedBreakdown', {
                    investments: formatCurrency(brokerageMarketValue, account.currencyCode),
                    cash: formatCurrency(cashComponent, account.currencyCode),
                  })}
                </div>
              )}
              {density !== 'dense' && account.currencyCode !== defaultCurrency && (
                // Nothing rather than the unconverted amount under the display
                // currency's symbol: a missing rate makes the approximation
                // unknown, not zero (ApproxInDefault renders null then).
                <ApproxInDefault
                  amount={convertToDefault(combined.combinedValue, account.currencyCode)}
                  defaultCurrency={defaultCurrency}
                  format={formatCurrencyBase}
                />
              )}
            </>
          ),
        }
    : account.accountSubType === 'INVESTMENT_BROKERAGE' && brokerageMarketValue !== undefined
      ? {
          figure: (
            <div className="text-sm font-medium text-green-600 dark:text-green-400">
              {formatCurrency(brokerageMarketValue, account.currencyCode)}
            </div>
          ),
          details: (
            <>
              {density === 'normal' && (
                <div className="text-xs text-gray-500 dark:text-gray-400">
                  {t('row.marketValue')}
                </div>
              )}
              {density !== 'dense' && account.currencyCode !== defaultCurrency && (
                <ApproxInDefault
                  amount={convertToDefault(brokerageMarketValue, account.currencyCode)}
                  defaultCurrency={defaultCurrency}
                  format={formatCurrencyBase}
                />
              )}
            </>
          ),
        }
      : {
          figure: (
            <div className={`text-sm font-medium ${gainLossColor(ownTotalBalance)}`}>
              {formatCurrency(ownTotalBalance, account.currencyCode)}
            </div>
          ),
          details: (
            <>
              {density !== 'dense' && account.currencyCode !== defaultCurrency && (
                <ApproxInDefault
                  amount={convertToDefault(ownTotalBalance, account.currencyCode)}
                  defaultCurrency={defaultCurrency}
                  format={formatCurrencyBase}
                />
              )}
              {density !== 'dense' && account.creditLimit && (
                <div className="text-xs text-gray-500 dark:text-gray-400">
                  {t('row.limit', { amount: formatCurrency(account.creditLimit, account.currencyCode) })}
                </div>
              )}
            </>
          ),
        };

  // Phone + Normal density: one wrapped card per row instead of the tier
  // table's five cells (see the `wrapped` prop). It is a LAYOUT mode, not a
  // different set of facts -- every value below is the same value the tier
  // branch renders, from the same helper. Only the Actions cell is absent:
  // its actions are what the long-press sheet these same handlers open
  // already carries on a phone.
  if (wrapped) {
    return (
      <tr
        className="group hover:bg-gray-100 dark:hover:bg-gray-800 cursor-pointer select-none bg-white dark:bg-gray-900"
        {...getRowHandlers(account)}
      >
        <td className="p-0">
          {/* The inset is the density table's, not a hand-picked one: the
              group header rows between these cards read `cellPadding` too, and
              a card indented differently from the header above it reads as two
              lists. */}
          <div className={`${cellPadding} grid grid-cols-[auto_minmax(0,1fr)_auto] gap-x-3 gap-y-1.5 items-start`}>
            {/* The brand slot the tier row shows at this density: the
                institution's favicon, falling back to the account-type icon. */}
            <InstitutionLogo
              institution={institution}
              size={20}
              className="mt-0.5"
              fallbackIcon={<AccountTypeIcon type={account.accountType} className="h-3.5 w-3.5" />}
            />
            <div
              className={`min-w-0 ${account.isClosed ? 'opacity-50' : ''}`}
              title={showPairingChrome && account.linkedAccountId
                ? `${account.name} — ${t('row.pairedWith', { name: accountNameMap.get(account.linkedAccountId) || 'linked account' })}`
                : displayName}
            >
              <div className="flex items-center min-w-0 text-sm font-medium text-blue-600 dark:text-blue-400">
                <FavouriteMark account={account} onToggleFavourite={onToggleFavourite} />
                <span className="truncate">{displayName}</span>
                <JointBadge account={account} />
              </div>
              {showPairingChrome && account.linkedAccountId && (
                <div className="text-xs text-gray-400 dark:text-gray-500 truncate flex items-center gap-1">
                  <svg className="w-3 h-3 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
                  </svg>
                  {t('row.pairedWith', { name: accountNameMap.get(account.linkedAccountId) || 'linked account' })}
                </div>
              )}
              {account.isJoint && (
                <div className="text-xs text-amber-700 dark:text-amber-300 truncate">
                  {t('row.jointSharedBy', { owner: account.ownerLabel ?? '' })}
                </div>
              )}
              {!account.isJoint && account.jointGranteeCount !== undefined && (
                <div className="text-xs text-amber-700 dark:text-amber-300 truncate">
                  {t('row.jointSharedWith', { count: account.jointGranteeCount })}
                </div>
              )}
              {account.description && !showPairingChrome && (
                <div className="text-sm text-gray-500 dark:text-gray-400 truncate">{account.description}</div>
              )}
            </div>
            {/* The balance is the widest figure on the card, so it takes the
                right of line 1 and never wraps -- a locale that groups
                thousands with a space would otherwise break a number in half.
                Its secondary lines may wrap, and are capped so a long
                breakdown cannot squeeze the name column away. */}
            <div className={`text-right ${account.isClosed ? 'opacity-50' : ''}`}>
              <div className="whitespace-nowrap">{balance.figure}</div>
              <div className="max-w-[10rem]">{balance.details}</div>
            </div>
            <div className="col-span-3 flex flex-wrap items-center gap-1.5">
              <AccountTypePill
                type={account.accountType}
                className={account.isClosed ? 'opacity-50' : ''}
              >
                <AccountTypeLabel
                  account={account}
                  isFolded={isFolded}
                  formatAccountType={formatAccountType}
                />
              </AccountTypePill>
              <AccountStatusPill account={account} />
            </div>
          </div>
        </td>
      </tr>
    );
  }

  return (
    <tr
      className={`group hover:bg-gray-100 dark:hover:bg-gray-800 cursor-pointer select-none ${density !== 'normal' && index % 2 === 1 ? 'bg-gray-50 dark:bg-table-stripe-dark' : 'bg-white dark:bg-gray-900'}`}
      {...getRowHandlers(account)}
    >
      <td className={`${cellPadding} ${account.isClosed ? 'opacity-50' : ''} max-w-[50vw] sm:max-w-[180px] md:max-w-none`}>
        <div
          className="text-left w-full"
          title={showPairingChrome && account.linkedAccountId
            ? `${account.name} — ${t('row.pairedWith', { name: accountNameMap.get(account.linkedAccountId) || 'linked account' })}`
            : displayName}
        >
          <div className="flex items-center text-sm font-medium text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-300">
            {density !== 'dense' && (
              <InstitutionLogo
                institution={institution}
                size={20}
                className="mr-2"
                fallbackIcon={<AccountTypeIcon type={account.accountType} className="h-3.5 w-3.5" />}
              />
            )}
            <FavouriteMark account={account} onToggleFavourite={onToggleFavourite} />
            <span className="truncate">{displayName}</span>
            <JointBadge account={account} />
            {density !== 'normal' && showPairingChrome && (
              <svg className="w-3.5 h-3.5 ml-1 flex-shrink-0 text-gray-400 dark:text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
              </svg>
            )}
          </div>
          {density === 'normal' && showPairingChrome && account.linkedAccountId && (
            <div className="text-xs text-gray-400 dark:text-gray-500 truncate flex items-center gap-1">
              <svg className="w-3 h-3 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
              </svg>
              {t('row.pairedWith', { name: accountNameMap.get(account.linkedAccountId) || 'linked account' })}
            </div>
          )}
          {density === 'normal' && account.isJoint && (
            <div className="text-xs text-amber-700 dark:text-amber-300 truncate">
              {t('row.jointSharedBy', { owner: account.ownerLabel ?? '' })}
            </div>
          )}
          {density === 'normal' && !account.isJoint && account.jointGranteeCount !== undefined && (
            <div className="text-xs text-amber-700 dark:text-amber-300 truncate">
              {t('row.jointSharedWith', { count: account.jointGranteeCount })}
            </div>
          )}
          {density === 'normal' && account.description && !showPairingChrome && (
            <div className="text-sm text-gray-500 dark:text-gray-400 truncate">{account.description}</div>
          )}
        </div>
      </td>
      <td className={`${cellPadding} whitespace-nowrap ${account.isClosed ? 'opacity-50' : ''} hidden sm:table-cell`}>
        <AccountTypePill type={account.accountType}>
          <AccountTypeLabel
            account={account}
            isFolded={isFolded}
            formatAccountType={formatAccountType}
          />
        </AccountTypePill>
      </td>
      <td className={`${cellPadding} whitespace-nowrap hidden md:table-cell w-1`}>
        <AccountStatusPill account={account} />
      </td>
      <td className={`${cellPadding} whitespace-nowrap text-right ${account.isClosed ? 'opacity-50' : ''}`}>
        {balance.figure}
        {balance.details}
      </td>
      <td className={`${cellPadding} whitespace-nowrap text-right text-sm font-medium hidden min-[480px]:table-cell sticky right-0 ${density !== 'normal' && index % 2 === 1 ? 'bg-gray-50 dark:bg-table-stripe-dark' : 'bg-white dark:bg-gray-900'} group-hover:bg-gray-100 dark:group-hover:bg-gray-800`} onClick={(e) => e.stopPropagation()}>
        <RowActions actions={actions} density={density} />
      </td>
    </tr>
  );
});

