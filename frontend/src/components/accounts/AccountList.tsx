'use client';

import { useState, useEffect, useMemo, useCallback } from 'react';
import { sumConverted, type ConvertedTotal } from '@/lib/currency-total';
import { PartialTotal } from '@/components/ui/PartialTotal';
import { sumProvisionalCounts } from '@/lib/provisional-amount';
import { MoneyFigure } from '@/components/ui/MoneyFigure';
import { TABLE_CLASS, TABLE_BODY_CLASS } from '@/components/ui/Table';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Account, AccountType } from '@/types/account';
import { Institution } from '@/types/institution';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { accountsApi } from '@/lib/accounts';
import { invalidateBalanceCaches } from '@/lib/apiCache';
import { moneyDecimalsForCurrency, roundMoney } from '@/lib/format';
import { useAuthStore } from '@/store/authStore';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import toast from 'react-hot-toast';
import { getErrorMessage, getRecordInUseEntries, type RecordInUseEntry } from '@/lib/errors';
import { accountInUseHref } from '@/lib/record-in-use-hrefs';
import { RecordInUseDialog } from '@/components/ui/RecordInUseDialog';
import {
  AccountRow,
  buildAccountActions,
  reconcileLedgerOf,
  unreconciledCountOf,
  type AccountActionLabels,
} from './AccountRow';
import { ACCOUNT_COLUMN_TIER, ACCOUNT_TABLE_CONTAINER, accountActionDensity } from './account-list-columns';
import { useLongPress } from '@/hooks/useLongPress';
import { RowActionSheet } from '@/components/ui/row-actions/RowActionSheet';
import { useTableDensity } from '@/hooks/useTableDensity';
import { useDensityPreference } from '@/store/densityStore';
import { SortIcon } from '@/components/ui/SortIcon';
import { MultiSelectOption } from '@/components/ui/MultiSelect';
import { useLocalStorage } from '@/hooks/useLocalStorage';
import { AccountFilterPanel, type AccountJointFilter, type AccountNetWorthFilter, type AccountStatusFilter } from './AccountFilterPanel';
import { formatAccountType } from '@/lib/account-utils';
import { buildLogicalAccounts, holdingsValuationIncomplete, ownBalance, type LogicalAccount } from '@/lib/logical-accounts';
import { useMainAccountName } from '@/hooks/useMainAccountName';
import { DensityToggleBar } from '@/components/ui/DensityToggle';
import { EmptyState } from '@/components/ui/EmptyState';
import { useIsMobile } from '@/hooks/useIsMobile';
import { useViewDefault } from '@/hooks/useViewDefault';
import { opensAccountDashboard } from '@/lib/account-detail-views';
import { BUILT_IN_VIEW_DEFAULTS } from '@/lib/view-defaults';
import { ChevronDownIcon } from '@heroicons/react/24/outline';

type SortField = 'name' | 'type' | 'balance' | 'status' | 'lastReconciled' | 'unreconciled';
type SortDirection = 'asc' | 'desc';

/**
 * Every field the list sorts by, with the column label that names it, in the
 * tier header's own order. The phone's slim control header renders all of
 * them: the chosen field is persisted across sessions, so a header offering
 * fewer would leave the list ordered by a field the phone can neither see nor
 * undo.
 */
const SORT_FIELD_LABEL_KEYS = [
  { field: 'name', labelKey: 'list.columns.accountName' },
  { field: 'type', labelKey: 'list.columns.type' },
  { field: 'status', labelKey: 'list.columns.status' },
  { field: 'lastReconciled', labelKey: 'list.columns.lastReconciled' },
  { field: 'unreconciled', labelKey: 'list.columns.unreconciled' },
  { field: 'balance', labelKey: 'list.columns.balance' },
] as const satisfies ReadonlyArray<{ field: SortField; labelKey: string }>;

// LocalStorage keys for filter persistence
const STORAGE_KEYS = {
  filtersExpanded: 'accounts.filter.expanded',
  // Written only when the reader picks a status, so a browser that never
  // chose gets the default (Active).
  status: 'accounts.filter.statusChoice',
  netWorth: 'accounts.filter.netWorth',
  joint: 'accounts.filter.joint',
  types: 'accounts.filter.types',
  search: 'accounts.filter.search',
  sortField: 'accounts.filter.sortField',
  sortDirection: 'accounts.filter.sortDirection',
  collapsedGroups: 'accounts.filter.collapsedGroups',
};

/**
 * Superseded keys, removed on mount. `accounts.filter.status` was written on
 * every mount, so it cannot tell "chose All" from "never chose", and keeping it
 * would hold every existing browser on All instead of the Active default.
 */
const LEGACY_KEYS = ['accounts.filter.showFilters', 'accounts.filter.status'];

/** The status the list opens on: closed accounts stay out of the way. */
export const DEFAULT_ACCOUNT_STATUS_FILTER = 'active' as const;

type AccountGroupType = AccountType | "SHARED_SETTLEMENT";
const accountGroup = (account: Account): AccountGroupType =>
  account.managedPurpose === "SHARED_SETTLEMENT"
    ? "SHARED_SETTLEMENT"
    : account.accountType;

// Display order for account-type groups: assets first, then liabilities.
const ACCOUNT_TYPE_ORDER: AccountGroupType[] = [
  'CHEQUING',
  'SAVINGS',
  'CASH',
  'CRYPTO',
  'INVESTMENT',
  'ASSET',
  'CREDIT_CARD',
  'LINE_OF_CREDIT',
  'LOAN',
  'MORTGAGE',
  'OTHER',
  "SHARED_SETTLEMENT",
];

// Helper to get stored value
function getStoredValue<T>(key: string, defaultValue: T): T {
  if (typeof window === 'undefined') return defaultValue;
  const stored = localStorage.getItem(key);
  if (!stored) return defaultValue;
  try {
    return JSON.parse(stored) as T;
  } catch {
    return defaultValue;
  }
}

interface AccountListProps {
  accounts: Account[];
  institutions?: Institution[];
  brokerageMarketValues?: Map<string, number>;
  /**
   * Holdings account id -> how many of its holdings have no price. An account
   * with any unpriced holding has no knowable total, so its row says so rather
   * than showing the cash it does know.
   */
  unpricedHoldingCounts?: Map<string, number>;
  /**
   * Holdings account ids whose valuation is a subtotal for any cause, a missing
   * exchange rate included -- which `unpricedHoldingCounts` cannot see. Such an
   * account's row shows no total, like an unpriced one.
   */
  incompleteHoldingAccountIds?: ReadonlySet<string>;
  /** Holdings account id -> how many of its holdings have a non-zero quantity. */
  heldPositionCounts?: ReadonlyMap<string, number>;
  /**
   * True when the portfolio-summary request failed, so every brokerage market
   * value is unknown rather than a real zero. Group totals exclude and mark
   * those accounts instead of folding a fabricated 0 in.
   */
  portfolioFailed?: boolean;
  defaultCurrency: string;
  /** Returns `null` when no rate for the pair is known. */
  convertToDefault: (value: number, fromCurrency: string) => number | null;
  onEdit: (account: Account) => void;
  onRefresh: () => void;
}

/**
 * A column label with its sort indicator. Rendered by the full column header
 * and by the phone's slim control header from this one place, so the label a
 * sort control carries cannot drift from the field it sorts.
 */
function ColumnSortLabel({
  label,
  field,
  sortField,
  sortDirection,
  align = 'start',
}: {
  label: string;
  field: SortField;
  sortField: SortField;
  sortDirection: SortDirection;
  align?: 'start' | 'end';
}) {
  return (
    <div className={`flex items-center${align === 'end' ? ' justify-end' : ''}`}>
      {label}
      <SortIcon field={field} sortField={sortField} sortDirection={sortDirection} />
    </div>
  );
}

/**
 * The chevron, type name and account count of a group header, in both layouts.
 * `labelClassName` is how the wrapped layout lets the type name truncate: a
 * group header that cannot shrink sets the table's minimum width, and on a
 * phone that is not merely a scrollbar -- mobile Chrome sizes the viewport
 * `position: fixed` attaches to from the widest content on the page.
 */
function GroupHeaderLabel({
  label,
  count,
  isCollapsed,
  labelClassName = '',
}: {
  label: string;
  count: string;
  isCollapsed: boolean;
  labelClassName?: string;
}) {
  return (
    <>
      <ChevronDownIcon className={`w-4 h-4 text-gray-500 dark:text-gray-400 transition-transform ${isCollapsed ? '-rotate-90' : ''}`} aria-hidden="true" />
      <span className={`font-semibold text-gray-700 dark:text-gray-200 ${labelClassName}`}>{label}</span>
      <span className="text-xs text-gray-500 dark:text-gray-400 whitespace-nowrap">{count}</span>
    </>
  );
}

/** A group's converted total, in both layouts (partial when a rate is missing). */
function GroupHeaderTotal({
  total,
  displayCurrency,
  provisionalCount,
}: {
  total: ConvertedTotal;
  displayCurrency: string;
  /** The estimates inside the group's balances, marked beside the total. */
  provisionalCount: number;
}) {
  return (
    <span
      className={`text-sm font-medium ${
        total.value >= 0
          ? 'text-gray-700 dark:text-gray-200'
          : 'text-red-600 dark:text-red-400'
      }`}
    >
      <PartialTotal total={total} displayCurrency={displayCurrency} provisionalCount={provisionalCount}>
        <MoneyFigure amount={total.value} currencyCode={displayCurrency} className="ui-money-quiet" />
      </PartialTotal>
    </span>
  );
}

/** A group with nothing in it: complete, and zero. */
const EMPTY_CONVERTED_TOTAL: ConvertedTotal = {
  value: 0,
  missingCurrencies: [],
  excludedCount: 0,
};

export function AccountList({ accounts, institutions, brokerageMarketValues, unpricedHoldingCounts, incompleteHoldingAccountIds, heldPositionCounts, portfolioFailed, defaultCurrency, convertToDefault, onEdit, onRefresh }: AccountListProps) {
  const t = useTranslations('accounts');
  const ts = useTranslations("sharedExpenses");
  const tc = useTranslations('common');
  const groupLabel = useCallback(
    (type: AccountGroupType) =>
      type === "SHARED_SETTLEMENT"
        ? ts("settlements")
        : formatAccountType(type, tc),
    [ts, tc],);
  const stripAccountName = useMainAccountName();
  const router = useRouter();
  const isDelegateView = useAuthStore((s) => !!s.actingAsUserId);
  const { formatCurrency: formatCurrencyBase } = useNumberFormat();
  const [closeDialogOpen, setCloseDialogOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [accountToClose, setAccountToClose] = useState<Account | null>(null);
  const [accountToDelete, setAccountToDelete] = useState<Account | null>(null);
  const [inUse, setInUse] = useState<{ account: Account; entries: RecordInUseEntry[] } | null>(null);
  const [isClosing, setIsClosing] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  // Optimistic favourite state so toggling the star does not trigger a full
  // page reload. Keyed by account id; absence means "use the prop value".
  const [favOverrides, setFavOverrides] = useState<Record<string, boolean>>({});
  const deletableAccounts = useMemo(
    () => new Set(accounts.filter(a => a.canDelete).map(a => a.id)),
    [accounts],
  );

  // Sorting state - initialize from localStorage
  const [sortField, setSortField] = useState<SortField>(() =>
    getStoredValue<SortField>(STORAGE_KEYS.sortField, 'name')
  );
  const [sortDirection, setSortDirection] = useState<SortDirection>(() =>
    getStoredValue<SortDirection>(STORAGE_KEYS.sortDirection, 'asc')
  );

  // Whether the filter panel is unfolded. Written only when the reader folds
  // or unfolds it, so a browser that never chose starts with it open.
  const [filtersExpanded, setFiltersExpanded] = useLocalStorage<boolean>(
    STORAGE_KEYS.filtersExpanded,
    true,
  );

  // Settings once kept under keys that nothing reads now.
  useEffect(() => {
    for (const key of LEGACY_KEYS) localStorage.removeItem(key);
  }, []);

  // Filter state - initialize from localStorage
  const [filterStatus, setFilterStatus] = useState<AccountStatusFilter>(() =>
    getStoredValue<AccountStatusFilter>(STORAGE_KEYS.status, DEFAULT_ACCOUNT_STATUS_FILTER)
  );
  const chooseStatus = useCallback((status: AccountStatusFilter) => {
    setFilterStatus(status);
    localStorage.setItem(STORAGE_KEYS.status, JSON.stringify(status));
  }, []);
  const [filterNetWorth, setFilterNetWorth] = useState<AccountNetWorthFilter>(() =>
    getStoredValue<AccountNetWorthFilter>(STORAGE_KEYS.netWorth, '')
  );
  // Joint filter: '' = all, 'joint' = only accounts shared TO the caller.
  // Only offered when at least one joint row is present (conditional-filter
  // precedent: the net-worth filter below).
  const [filterJoint, setFilterJoint] = useState<AccountJointFilter>(() =>
    getStoredValue<AccountJointFilter>(STORAGE_KEYS.joint, '')
  );
  // Account-type filter: an empty list means "all types". Persisted so the
  // chosen types survive navigating away and back to the page.
  const [filterTypes, setFilterTypes] = useState<AccountGroupType[]>(() =>
    getStoredValue<AccountGroupType[]>(STORAGE_KEYS.types, []),
  );
  // Free-text filter on account name.
  const [filterSearch, setFilterSearch] = useState<string>(() =>
    getStoredValue<string>(STORAGE_KEYS.search, '')
  );

  // Collapsed account-type groups - initialize from localStorage
  const [collapsedGroups, setCollapsedGroups] = useState<Set<AccountGroupType>>(() => {
    const stored = getStoredValue<AccountGroupType[]>(STORAGE_KEYS.collapsedGroups, [],);
    return new Set(stored);
  },);

  const toggleGroup = useCallback((type: AccountGroupType) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(type)) {
        next.delete(type);
      } else {
        next.add(type);
      }
      return next;
    });
  }, []);

  // Persist filter/sort changes to localStorage
  useEffect(() => {
    localStorage.setItem(STORAGE_KEYS.netWorth, JSON.stringify(filterNetWorth));
  }, [filterNetWorth]);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEYS.joint, JSON.stringify(filterJoint));
  }, [filterJoint]);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEYS.types, JSON.stringify(filterTypes));
  }, [filterTypes]);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEYS.search, JSON.stringify(filterSearch));
  }, [filterSearch]);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEYS.sortField, JSON.stringify(sortField));
  }, [sortField]);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEYS.sortDirection, JSON.stringify(sortDirection));
  }, [sortDirection]);

  useEffect(() => {
    localStorage.setItem(
      STORAGE_KEYS.collapsedGroups,
      JSON.stringify(Array.from(collapsedGroups)),
    );
  }, [collapsedGroups]);

  // Long-press opens a per-row action sheet on mobile (and via right-click).
  const [contextAccount, setContextAccount] = useState<Account | null>(null);

  // An investment row opens the account's own detail page, the same as every
  // other row opens the thing it names, rather than the portfolio-wide
  // /investments view filtered to it. Closed accounts included, and they are
  // the case that was outright broken: `getInvestmentAccounts` filters
  // `isClosed: false`, so a closed brokerage is absent from the list
  // /investments matches its `accountId` query against, the filter is silently
  // dropped and the user lands on whatever selection was already stored. The
  // full portfolio view stays one click away, from the row's View Transactions
  // action and from the detail page's own link. A reader who chose the
  // dashboard in Settings (`accountOpenTarget`) gets every account's detail
  // page, its register still one click away from the same action.
  const accountOpenTarget =
    useViewDefault('accountOpenTarget') ?? BUILT_IN_VIEW_DEFAULTS.accountOpenTarget;
  const handleRowClick = useCallback((account: Account) => {
    if (
      account.accountSubType === 'INVESTMENT_BROKERAGE' ||
      opensAccountDashboard(account.accountType, accountOpenTarget)
    ) {
      router.push(`/accounts/${account.id}`);
    } else {
      router.push(`/transactions?accountId=${account.id}`);
    }
  }, [router, accountOpenTarget]);

  const { getRowHandlers } = useLongPress<Account>({
    onLongPress: setContextAccount,
    onClick: handleRowClick,
  });

  const accountActionLabels = useMemo<AccountActionLabels>(() => ({
    viewTransactions: t('row.actions.viewTransactions'),
    details: t('row.actions.details'),
    edit: tc('actions.edit'),
    reconcile: tc('actions.reconcile'),
    close: tc('actions.close'),
    closeTitleDisabled: t('row.actions.closeTitleDisabled'),
    closeTitleEnabled: t('row.actions.closeTitleEnabled'),
    closeTitleUnknownValue: t('row.actions.closeTitleUnknownValue'),
    reopen: tc('actions.reopen'),
    delete: tc('actions.delete'),
    includeInNetWorth: t('row.includeInNetWorth'),
    excludeFromNetWorth: t('row.excludeFromNetWorth'),
  }), [t, tc]);
  const { density } = useDensityPreference('accounts');
  const { cellPadding, headerPadding } = useTableDensity(density);
  // Model B: on a phone, density picks the LAYOUT rather than only the row
  // height. At Normal each account is a wrapped card carrying the type and
  // status this table hides below `sm`/`md`; Compact and Dense keep the tier
  // table, unchanged, and so does every non-phone width. Exactly one branch
  // renders per row, chosen here.
  const isMobile = useIsMobile();
  const wrapped = isMobile && density === 'normal';
  // The scroll wrapper's width, for the one width rule CSS cannot express:
  // whether Normal's text action buttons fit or give way to icons.
  const [tableWrapper, setTableWrapper] = useState<HTMLDivElement | null>(null);
  const [tableWidth, setTableWidth] = useState<number | null>(null);
  useEffect(() => {
    if (!tableWrapper || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(([entry]) => setTableWidth(entry.contentRect.width));
    observer.observe(tableWrapper);
    return () => observer.disconnect();
  }, [tableWrapper]);
  const actionDensity = accountActionDensity(density, tableWidth);

  // Every account as the user thinks of it: a linked brokerage/cash pair is one
  // entry, so it filters, sorts, counts and renders as a single account.
  const logicalAccounts = useMemo(() => {
    const withOverrides = accounts.map((a) =>
      a.id in favOverrides
        ? { ...a, isFavourite: favOverrides[a.id] }
        : a,
    );
    return buildLogicalAccounts(withOverrides, stripAccountName, {
      marketValues: brokerageMarketValues ?? new Map(),
      unpricedCounts: unpricedHoldingCounts ?? new Map(),
      incompleteAccountIds: incompleteHoldingAccountIds,
      positionCounts: heldPositionCounts,
    });
  }, [accounts, favOverrides, stripAccountName, brokerageMarketValues, unpricedHoldingCounts, incompleteHoldingAccountIds, heldPositionCounts]);

  // The segments' counts are over every account, as on Currencies, so a
  // segment says how many it holds before any other filter narrows it.
  const statusCounts = useMemo(() => {
    const closed = logicalAccounts.filter((l) => l.primary.isClosed).length;
    return { all: logicalAccounts.length, active: logicalAccounts.length - closed, closed };
  }, [logicalAccounts]);

  // Keyed on the primary id, which is the id every row action carries.
  const logicalById = useMemo(
    () => new Map(logicalAccounts.map((l) => [l.id, l])),
    [logicalAccounts],
  );

  // Filter and sort logical accounts. Filters read the entity's primary row --
  // the two halves of a pair share their type, status and sharing state.
  const filteredAndSortedAccounts = useMemo(() => {
    let result = logicalAccounts;

    // Apply filters
    if (filterStatus) {
      result = result.filter((l) =>
        filterStatus === 'active' ? !l.primary.isClosed : l.primary.isClosed
      );
    }
    if (filterNetWorth) {
      result = result.filter((l) =>
        filterNetWorth === 'excluded' ? l.primary.excludeFromNetWorth : !l.primary.excludeFromNetWorth
      );
    }
    if (filterJoint) {
      result = result.filter((l) => !!l.primary.isJoint);
    }
    if (filterTypes.length > 0) {
      const typeSet = new Set(filterTypes);
      result = result.filter((l) => typeSet.has(accountGroup(l.primary)));
    }
    const search = filterSearch.trim().toLowerCase();
    if (search) {
      // Match the name the row shows and the stored name of either ledger, so
      // searching "cash" or a suffix still finds the account it belongs to.
      result = result.filter(
        (l) =>
          l.displayName.toLowerCase().includes(search) ||
          l.primary.name.toLowerCase().includes(search) ||
          !!l.cash?.name.toLowerCase().includes(search),
      );
    }

    // Apply sorting
    return [...result].sort((a, b) => {
      let comparison = 0;
      switch (sortField) {
        case 'name':
          comparison = a.displayName.localeCompare(b.displayName);
          break;
        case 'type':
          comparison = a.primary.accountType.localeCompare(b.primary.accountType);
          break;
        case 'balance':
          // Sort key only: an unknown total sorts as zero rather than being
          // dropped from the list. What the row *shows* stays unknown.
          comparison = (a.combinedValue ?? 0) - (b.combinedValue ?? 0);
          break;
        case 'status':
          comparison = (a.primary.isClosed ? 1 : 0) - (b.primary.isClosed ? 1 : 0);
          break;
        case 'lastReconciled':
          // Ascending puts the longest-unreconciled first: never reconciled
          // (and no ledger to reconcile) ahead of the oldest date.
          comparison = (reconcileLedgerOf(a.primary, a)?.lastReconciledDate ?? '').localeCompare(
            reconcileLedgerOf(b.primary, b)?.lastReconciledDate ?? '',
          );
          break;
        case 'unreconciled':
          // A row with no count to show (no ledger to reconcile, or a joint
          // row) sorts below an account with nothing outstanding.
          comparison =
            (unreconciledCountOf(a.primary, a) ?? -1) - (unreconciledCountOf(b.primary, b) ?? -1);
          break;
      }
      return sortDirection === 'asc' ? comparison : -comparison;
    });
  }, [logicalAccounts, filterStatus, filterNetWorth, filterJoint, filterTypes, filterSearch, sortField, sortDirection]);

  // Account-type options for the type filter, limited to the types actually
  // present and ordered to match the grouped list below (unknown types last).
  const typeOptions = useMemo<MultiSelectOption[]>(() => {
    const present = new Set(accounts.map(accountGroup));
    const ordered = ACCOUNT_TYPE_ORDER.filter((type) => present.has(type));
    for (const type of present) {
      if (!ordered.includes(type)) ordered.push(type);
    }
    return ordered.map((type) => ({ value: type, label: groupLabel(type) }));
  }, [accounts, groupLabel]);

  // Build a map of account IDs to names for showing linked account pairs
  const accountNameMap = useMemo(() => {
    const map = new Map<string, string>();
    accounts.forEach((a) => map.set(a.id, a.name));
    return map;
  }, [accounts]);

  // Map institution id -> institution for the per-row brand icon.
  const institutionsById = useMemo(() => {
    const map = new Map<string, Institution>();
    (institutions || []).forEach((i) => map.set(i.id, i));
    return map;
  }, [institutions]);

  // Group logical accounts by account type. A pair no longer needs adjacency
  // ordering -- it is one entry.
  const groupedAccounts = useMemo(() => {
    const groups = new Map<AccountGroupType, LogicalAccount[]>();
    for (const logical of filteredAndSortedAccounts) {
      const existing = groups.get(accountGroup(logical.primary));
      if (existing) {
        existing.push(logical);
      } else {
        groups.set(accountGroup(logical.primary), [logical]);
      }
    }

    const result: { type: AccountGroupType; accounts: LogicalAccount[] }[] = [];
    for (const type of ACCOUNT_TYPE_ORDER) {
      const list = groups.get(type);
      if (list && list.length > 0) {
        result.push({ type, accounts: list });
        groups.delete(type);
      }
    }
    // Append any unrecognised types last (defensive against new enum values).
    for (const [type, list] of groups) {
      if (list.length > 0) result.push({ type, accounts: list });
    }
    return result;
  }, [filteredAndSortedAccounts]);

  // Per-group total balance, converted into the user's default currency.
  // Brokerage accounts use their portfolio market value (matching the page
  // summary calculation) so net-worth math stays consistent with the cards
  // above the list.
  // Summed over each entity's underlying ledgers, so the arithmetic is exactly
  // what it was when the pair was two rows. Deliberately NOT `combinedValue`:
  // that goes null on an unpriced holding, and a nullable group total has to be
  // threaded through the summary cards above the list to mean anything -- a
  // known gap recorded in the plan, not something this row total invents.
  const groupTotals = useMemo(() => {
    // A group total is partial when one of its accounts has no rate to the
    // display currency; `sumConverted` keeps the subtotal and the missing pairs
    // together so the header can mark it instead of quietly under-reporting.
    const totals = new Map<AccountGroupType, ConvertedTotal & { provisionalCount: number }>();
    for (const { type, accounts: groupAccounts } of groupedAccounts) {
      // Sum over each entity's underlying ledgers (a brokerage pair is primary
      // plus its cash sub-account) so the arithmetic is exactly what it was
      // when the pair was two rows. An unpriced holding is already excluded
      // from the brokerage market value -- that gap is surfaced by the row's
      // unpriced count, not by nulling the group total. A missing exchange
      // rate, by contrast, makes the total a subtotal, which `sumConverted`
      // records so the header can mark it.
      const members = groupAccounts.flatMap((logical) =>
        logical.cash ? [logical.primary, logical.cash] : [logical.primary],
      );
      // A brokerage market value is unknown when the valuation failed, and a
      // subtotal when some holdings could not be priced. Either way it is not a
      // measured number and has no currency to name, so the member is left out
      // by count -- matching the account row's unknown marker -- rather than
      // folded in as a fabricated 0.
      const isUnknownBrokerage = (account: Account) =>
        account.accountSubType === 'INVESTMENT_BROKERAGE' &&
        (portfolioFailed === true ||
          holdingsValuationIncomplete(account.id, unpricedHoldingCounts, incompleteHoldingAccountIds));
      const known = members.filter((account) => !isUnknownBrokerage(account));
      const unknownCount = members.length - known.length;
      const converted = sumConverted(
        known,
        (account) =>
          account.accountSubType === 'INVESTMENT_BROKERAGE'
            ? brokerageMarketValues?.get(account.id) ?? 0
            : (Number(account.currentBalance) || 0) +
              (Number(account.futureTransactionsSum) || 0),
        (account) => account.currencyCode,
        convertToDefault,
      );
      totals.set(type, {
        ...converted,
        excludedCount: converted.excludedCount + unknownCount,
        // Every member's balance is in the total, so every member's estimates.
        provisionalCount: sumProvisionalCounts(members),
      });
    }
    return totals;
  }, [groupedAccounts, brokerageMarketValues, unpricedHoldingCounts, incompleteHoldingAccountIds, portfolioFailed, convertToDefault]);

  // Flatten groups into a sequence of header / row entries with stable striping
  // indices so AccountRow alternation continues to look right across groups.
  const renderItems = useMemo(() => {
    type Item =
      | { kind: 'header'; type: AccountGroupType; count: number; total: ConvertedTotal; provisionalCount: number; isCollapsed: boolean }
      | { kind: 'row'; logical: LogicalAccount; index: number };
    const items: Item[] = [];
    let rowIndex = 0;
    for (const { type, accounts: groupAccounts } of groupedAccounts) {
      const isCollapsed = collapsedGroups.has(type);
      items.push({
        kind: 'header',
        type,
        // One entry per account the user has -- a pair counts once, which is
        // what `countLogicalAccounts` counted when these were two rows.
        count: groupAccounts.length,
        total: groupTotals.get(type) ?? EMPTY_CONVERTED_TOTAL,
        provisionalCount: groupTotals.get(type)?.provisionalCount ?? 0,
        isCollapsed,
      });
      if (!isCollapsed) {
        for (const logical of groupAccounts) {
          items.push({ kind: 'row', logical, index: rowIndex });
          rowIndex += 1;
        }
      }
    }
    return items;
  }, [groupedAccounts, collapsedGroups, groupTotals]);

  // Only show the net worth filter when at least one account is excluded
  const hasExcludedAccounts = useMemo(
    () => accounts.some((a) => a.excludeFromNetWorth),
    [accounts],
  );

  // Clear the net worth filter if no accounts are excluded (e.g. user toggled the flag off)
  if (!hasExcludedAccounts && filterNetWorth) {
    setFilterNetWorth('');
  }

  // Only show the joint filter when at least one account is shared to the
  // caller; clear it when the last joint account disappears (revoke).
  const hasJointAccounts = useMemo(
    () => accounts.some((a) => a.isJoint),
    [accounts],
  );
  if (!hasJointAccounts && filterJoint) {
    setFilterJoint('');
  }

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDirection((prev) => (prev === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortField(field);
      setSortDirection('asc');
    }
  };

  const clearFilters = () => {
    setFilterStatus(DEFAULT_ACCOUNT_STATUS_FILTER);
    setFilterNetWorth('');
    setFilterJoint('');
    setFilterTypes([]);
    setFilterSearch('');
    localStorage.removeItem(STORAGE_KEYS.status);
    localStorage.removeItem(STORAGE_KEYS.netWorth);
    localStorage.removeItem(STORAGE_KEYS.joint);
    localStorage.removeItem(STORAGE_KEYS.types);
    localStorage.removeItem(STORAGE_KEYS.search);
  };


  const handleViewTransactions = useCallback((account: Account) => {
    if (account.accountSubType === 'INVESTMENT_BROKERAGE') {
      router.push(`/investments?accountId=${account.id}`);
    } else {
      router.push(`/transactions?accountId=${account.id}`);
    }
  }, [router]);

  // The caller resolved which ledger to reconcile (a pair reconciles its cash
  // half), so this only navigates.
  const handleReconcile = useCallback((accountId: string) => {
    router.push(`/reconcile?accountId=${accountId}`);
  }, [router]);

  const handleDetails = useCallback((account: Account) => {
    router.push(`/accounts/${account.id}`);
  }, [router]);

  const handleCloseClick = useCallback((account: Account) => {
    setAccountToClose(account);
    setCloseDialogOpen(true);
  }, []);

  const handleDeleteClick = useCallback((account: Account) => {
    setAccountToDelete(account);
    setDeleteDialogOpen(true);
  }, []);

  const handleDeleteConfirm = async () => {
    if (!accountToDelete) return;

    setIsDeleting(true);
    try {
      // Both ledgers of a pair go, brokerage first. The server unlinks the
      // partner rather than cascading, so if the second call fails the
      // survivor is an ordinary cash account -- the least bad failure shape,
      // and one every surface already handles.
      const cashHalf = logicalById.get(accountToDelete.id)?.cash;
      await accountsApi.delete(accountToDelete.id);
      if (cashHalf) {
        await accountsApi.delete(cashHalf.id);
      }
      // Deleting a brokerage removes its holdings from the portfolio, so the
      // account list is not the only cached view that just went stale.
      invalidateBalanceCaches();
      toast.success(t('toast.deleteSuccess'));
      setDeleteDialogOpen(false);
      setAccountToDelete(null);
      onRefresh();
    } catch (error) {
      const entries = getRecordInUseEntries(error);
      if (entries) {
        setInUse({ account: accountToDelete, entries });
        setDeleteDialogOpen(false);
        setAccountToDelete(null);
      } else {
        toast.error(getErrorMessage(error, t('toast.deleteFailed')));
      }
    } finally {
      setIsDeleting(false);
    }
  };

  const handleDeleteCancel = () => {
    setDeleteDialogOpen(false);
    setAccountToDelete(null);
  };

  const handleCloseConfirm = async () => {
    if (!accountToClose) return;

    setIsClosing(true);
    try {
      await accountsApi.close(accountToClose.id);
      toast.success(t('toast.closeSuccess'));
      setCloseDialogOpen(false);
      setAccountToClose(null);
      onRefresh();
    } catch (error) {
      toast.error(getErrorMessage(error, t('toast.closeFailed')));
    } finally {
      setIsClosing(false);
    }
  };

  const handleCloseCancel = () => {
    setCloseDialogOpen(false);
    setAccountToClose(null);
  };

  const handleReopen = useCallback(async (account: Account) => {
    try {
      await accountsApi.reopen(account.id);
      toast.success(t('toast.reopenSuccess'));
      onRefresh();
    } catch (error) {
      toast.error(getErrorMessage(error, t('toast.reopenFailed')));
    }
  }, [onRefresh, t]);

  const handleToggleFavourite = useCallback(
    async (account: Account) => {
      const next = !account.isFavourite;
      // Optimistically flip the star in place -- no list reload/spinner.
      setFavOverrides((prev) => ({ ...prev, [account.id]: next }));
      try {
        // Owner favourites live on the account row; a delegate keeps an
        // independent overlay (the owner-scoped flag is never touched). A
        // joint row in the caller's own view uses the same overlay -- the
        // account object belongs to the sharing owner.
        if (isDelegateView || account.isJoint) {
          await accountsApi.setDelegateFavourite(account.id, next);
        } else {
          await accountsApi.update(account.id, { isFavourite: next });
        }
      } catch (error) {
        // Roll back the optimistic change on failure.
        setFavOverrides((prev) => ({ ...prev, [account.id]: !next }));
        toast.error(getErrorMessage(error, t('toast.favouriteError')));
      }
    },
    [isDelegateView, t],
  );

  const handleToggleNetWorthExclusion = useCallback(
    async (account: Account) => {
      try {
        await accountsApi.setNetWorthExclusion(
          account.id,
          !account.excludeFromNetWorth,
        );
        onRefresh();
      } catch (error) {
        toast.error(getErrorMessage(error, t('toast.updateFailed')));
      }
    },
    [onRefresh, t],
  );

  if (accounts.length === 0) {
    return (
      <EmptyState title={t('list.empty')} help="accounts" />
    );
  }

  return (
    <div>
      <AccountFilterPanel
        expanded={filtersExpanded}
        setExpanded={setFiltersExpanded}
        search={filterSearch}
        setSearch={setFilterSearch}
        status={filterStatus}
        setStatus={chooseStatus}
        statusCounts={statusCounts}
        types={filterTypes}
        setTypes={(vals) => setFilterTypes(vals as AccountGroupType[])}
        typeOptions={typeOptions}
        netWorth={filterNetWorth}
        setNetWorth={setFilterNetWorth}
        showNetWorth={hasExcludedAccounts}
        joint={filterJoint}
        setJoint={setFilterJoint}
        showJoint={hasJointAccounts}
        countLabel={t('list.accountCount', { filtered: filteredAndSortedAccounts.length, total: logicalAccounts.length })}
        onClear={clearFilters}
      />

      {filteredAndSortedAccounts.length === 0 ? (
        <EmptyState
          title={t('list.noMatch')}
          action={
            <button
              onClick={clearFilters}
              className="text-sm text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-300"
            >
              {t('list.clearFilters')}
            </button>
          }
        />
      ) : (
      <div>
        {/* On a phone the wrapped card labels its own values, so the column
              header is dropped -- but the controls in that header row must not
              go with it: these `<th>`s are how the list is sorted, and the
              chosen field is persisted, so a header showing fewer fields than
              the sort can be in would leave the list ordered by something the
              phone can neither see nor undo. A slim control header carries all
              six as buttons -- the card shows all six values -- and no column
              label of its own: the single card cell below holds name, balance,
              type, status, last reconciled and the unreconciled count at once, so naming this header after any one of
              them would misdescribe the column to a screen reader. Each button
              names itself with the label of the field it sorts by. */}
        <DensityToggleBar view="accounts" />
        <div ref={setTableWrapper} className={`overflow-x-auto ${ACCOUNT_TABLE_CONTAINER}`}>
        <table className={TABLE_CLASS}>
          {/* The one column is always sorted by something, and `aria-sort`
                  is the only place that direction is announced -- the arrow in
                  each button's label is a glyph, not a state. */}
          <thead className="bg-gray-50 dark:bg-gray-800">
            {wrapped ? (
            <tr>
              {/* The one column is always sorted by something, and `aria-sort`
                  is the only place that direction is announced -- the arrow in
                  each button's label is a glyph, not a state. */}
              <th
                className={`${headerPadding} text-left`}
                aria-sort={sortDirection === 'asc' ? 'ascending' : 'descending'}
              >
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                  {SORT_FIELD_LABEL_KEYS.map(({ field, labelKey }) => (
                    <button
                      key={field}
                      type="button"
                      onClick={() => handleSort(field)}
                      className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider rounded focus-visible:outline-2 focus-visible:outline-blue-500"
                    >
                      <ColumnSortLabel
                        label={t(labelKey)}
                        field={field}
                        sortField={sortField}
                        sortDirection={sortDirection}
                      />
                    </button>
                  ))}
                </div>
              </th>
            </tr>
            ) : (
            <tr>
              <th
                className={`${headerPadding} text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-700 select-none`}
                onClick={() => handleSort('name')}
              >
                <ColumnSortLabel
                  label={t('list.columns.accountName')}
                  field="name"
                  sortField={sortField}
                  sortDirection={sortDirection}
                />
              </th>
              <th
                className={`${headerPadding} text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-700 select-none ${ACCOUNT_COLUMN_TIER.type}`}
                onClick={() => handleSort('type')}
              >
                <ColumnSortLabel
                  label={t('list.columns.type')}
                  field="type"
                  sortField={sortField}
                  sortDirection={sortDirection}
                />
              </th>
              <th
                className={`${headerPadding} text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-700 select-none ${ACCOUNT_COLUMN_TIER.status} w-1 whitespace-nowrap`}
                onClick={() => handleSort('status')}
              >
                <ColumnSortLabel
                  label={t('list.columns.status')}
                  field="status"
                  sortField={sortField}
                  sortDirection={sortDirection}
                />
              </th>
              <th
                className={`${headerPadding} text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-700 select-none ${ACCOUNT_COLUMN_TIER.lastReconciled} w-1 whitespace-nowrap`}
                onClick={() => handleSort('lastReconciled')}
              >
                <ColumnSortLabel
                  label={t('list.columns.lastReconciled')}
                  field="lastReconciled"
                  sortField={sortField}
                  sortDirection={sortDirection}
                />
              </th>
              <th
                className={`${headerPadding} text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-700 select-none ${ACCOUNT_COLUMN_TIER.unreconciled} w-1 whitespace-nowrap`}
                onClick={() => handleSort('unreconciled')}
              >
                <ColumnSortLabel
                  label={t('list.columns.unreconciled')}
                  field="unreconciled"
                  sortField={sortField}
                  sortDirection={sortDirection}
                  align="end"
                />
              </th>
              <th
                className={`${headerPadding} text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-700 select-none`}
                onClick={() => handleSort('balance')}
              >
                <ColumnSortLabel
                  label={t('list.columns.balance')}
                  field="balance"
                  sortField={sortField}
                  sortDirection={sortDirection}
                  align="end"
                />
              </th>
              <th className={`${headerPadding} text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider hidden min-[480px]:table-cell sticky right-0 bg-gray-50 dark:bg-gray-800`}>
                {t('list.columns.actions')}
              </th>
            </tr>
            )}
          </thead>
          <tbody className={`bg-white dark:bg-gray-900 ${TABLE_BODY_CLASS}`}>
            {renderItems.map((item) =>
              item.kind === 'header' ? (
                <tr
                  key={`group-${item.type}`}
                  className="ui-ledger-group group bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700 cursor-pointer select-none"
                  onClick={() => toggleGroup(item.type)}
                  aria-expanded={!item.isCollapsed}
                >
                  {/* A grid, not a flex row, and for the reason the card
                          rows are: `minmax(0,1fr)` is a track that may be
                          zero, so the label truncates instead of setting the
                          table's minimum width. `min-w-0` on a flex item does
                          not do that -- the item still contributes the full
                          width of its nowrap text -- and a group header wider
                          than the phone displaces every fixed-position panel
                          on the page. */}
                  {wrapped ? (
                    <td className={cellPadding}>
                      {/* A grid, not a flex row, and for the reason the card
                          rows are: `minmax(0,1fr)` is a track that may be
                          zero, so the label truncates instead of setting the
                          table's minimum width. `min-w-0` on a flex item does
                          not do that -- the item still contributes the full
                          width of its nowrap text -- and a group header wider
                          than the phone displaces every fixed-position panel
                          on the page. */}
                      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 text-sm">
                        <div className="flex items-center gap-2 min-w-0">
                          <GroupHeaderLabel
                            label={groupLabel(item.type)}
                            count={t('list.groupCount', { count: item.count })}
                            isCollapsed={item.isCollapsed}
                            labelClassName="truncate"
                          />
                        </div>
                        <span className="text-right whitespace-nowrap">
                          <GroupHeaderTotal
                            total={item.total}
                            displayCurrency={defaultCurrency}
                            provisionalCount={item.provisionalCount}
                          />
                        </span>
                      </div>
                    </td>
                  ) : (
                  <>
                  <td className={cellPadding}>
                    <div className="flex items-center gap-2 min-w-0 text-sm">
                      <GroupHeaderLabel
                        label={groupLabel(item.type)}
                        count={t('list.groupCount', { count: item.count })}
                        isCollapsed={item.isCollapsed}
                      />
                    </div>
                  </td>
                  <td className={ACCOUNT_COLUMN_TIER.type} aria-hidden="true" />
                  <td className={ACCOUNT_COLUMN_TIER.status} aria-hidden="true" />
                  <td className={ACCOUNT_COLUMN_TIER.lastReconciled} aria-hidden="true" />
                  <td className={ACCOUNT_COLUMN_TIER.unreconciled} aria-hidden="true" />
                  <td className={`${cellPadding} text-right whitespace-nowrap`}>
                    <GroupHeaderTotal
                      total={item.total}
                      displayCurrency={defaultCurrency}
                      provisionalCount={item.provisionalCount}
                    />
                  </td>
                  <td
                    className="hidden min-[480px]:table-cell sticky right-0 bg-gray-100 dark:bg-gray-800 group-hover:bg-gray-200 dark:group-hover:bg-gray-700"
                    aria-hidden="true"
                  />
                  </>
                  )}
                </tr>
              ) : (
                <AccountRow
                  key={item.logical.id}
                  account={item.logical.primary}
                  logical={item.logical}
                  index={item.index}
                  density={density}
                  actionDensity={actionDensity}
                  wrapped={wrapped}
                  cellPadding={cellPadding}
                  isDeletable={deletableAccounts.has(item.logical.id)}
                  accountNameMap={accountNameMap}
                  institution={item.logical.primary.institutionId ? institutionsById.get(item.logical.primary.institutionId) : undefined}
                  brokerageMarketValue={item.logical.holdingsAccountId ? brokerageMarketValues?.get(item.logical.holdingsAccountId) : undefined}
                  unpricedHoldingsCount={item.logical.holdingsAccountId ? unpricedHoldingCounts?.get(item.logical.holdingsAccountId) : undefined}
                  valuationIncomplete={item.logical.holdingsAccountId ? incompleteHoldingAccountIds?.has(item.logical.holdingsAccountId) === true : false}
                  defaultCurrency={defaultCurrency}
                  formatCurrencyBase={formatCurrencyBase}
                  convertToDefault={convertToDefault}
                  formatAccountType={(type) => formatAccountType(type, tc)}
                  actionLabels={accountActionLabels}
                  onDetails={handleDetails}
                  onEdit={onEdit}
                  onReconcile={handleReconcile}
                  onCloseClick={handleCloseClick}
                  onDeleteClick={handleDeleteClick}
                  onReopen={handleReopen}
                  getRowHandlers={getRowHandlers}
                  onToggleFavourite={handleToggleFavourite}
                  onToggleNetWorthExclusion={handleToggleNetWorthExclusion}
                />
              ),
            )}
          </tbody>
        </table>
        </div>
      </div>
      )}

      {/* Long-press action sheet */}
      <RowActionSheet
        isOpen={!!contextAccount}
        title={
          contextAccount
            ? (logicalById.get(contextAccount.id)?.displayName ??
              contextAccount.name)
            : ''
        }
        subtitle={contextAccount
          ? `${logicalById.get(contextAccount.id)?.cash ? formatAccountType(contextAccount.accountType, tc) :
              contextAccount.accountSubType === 'INVESTMENT_BROKERAGE' ? t('contextMenu.subtypeBrokerage') :
              contextAccount.accountSubType === 'INVESTMENT_CASH' ? t('contextMenu.subtypeInvCash') :
              formatAccountType(contextAccount.accountType, tc)}${contextAccount.isClosed ? t('contextMenu.closedSuffix') : ''}`
          : undefined}
        actions={contextAccount
          ? buildAccountActions(contextAccount, deletableAccounts.has(contextAccount.id), accountActionLabels, {
              onViewTransactions: handleViewTransactions,
              onDetails: handleDetails,
              onEdit,
              onReconcile: handleReconcile,
              onCloseClick: handleCloseClick,
              onReopen: handleReopen,
              onDeleteClick: handleDeleteClick,
              onToggleNetWorthExclusion: handleToggleNetWorthExclusion,
            }, logicalById.get(contextAccount.id))
          : []}
        onClose={() => setContextAccount(null)}
      />

      {/* Delete Account Confirmation Dialog */}
      <ConfirmDialog
        isOpen={closeDialogOpen}
        title={t('confirmDialog.closeTitle')}
        message={(() => {
          if (!accountToClose) return '';
          const logical = logicalById.get(accountToClose.id);
          const name = logical?.displayName ?? accountToClose.name;
          // The cash a close leaves behind stays in the account, frozen, and
          // keeps counting unless the account is excluded from net worth --
          // which cannot be changed once it is closed, so the dialog says so
          // while it still can be.
          // The balance and its exclusion flag are the cash ledger's: the two
          // halves of a pair carry their own flags.
          const cashLedger = logical?.cash ?? accountToClose;
          const rounded = roundMoney(ownBalance(cashLedger), moneyDecimalsForCurrency(cashLedger.currencyCode));
          if (rounded === 0) return t('confirmDialog.closeMessage', { name });
          const balance = formatCurrencyBase(rounded, cashLedger.currencyCode);
          return cashLedger.excludeFromNetWorth
            ? t('confirmDialog.closeMessageWithBalanceExcluded', { name, balance })
            : t('confirmDialog.closeMessageWithBalance', { name, balance });
        })()}
        confirmLabel={isClosing ? t('confirmDialog.closeConfirmLoading') : t('confirmDialog.closeConfirm')}
        cancelLabel={tc('cancel')}
        variant="warning"
        onConfirm={handleCloseConfirm}
        onCancel={handleCloseCancel}
      />

      {/* Delete Account Confirmation Dialog */}
      <ConfirmDialog
        isOpen={deleteDialogOpen}
        title={t('confirmDialog.deleteTitle')}
        message={(() => {
          if (!accountToDelete) return '';
          const logical = logicalById.get(accountToDelete.id);
          // Deleting one row of a pair deletes both ledgers, so the dialog
          // names both rather than only the row that was clicked.
          return logical?.cash
            ? t('confirmDialog.deletePairMessage', {
                name: logical.displayName,
                brokerageName: logical.primary.name,
                cashName: logical.cash.name,
              })
            : t('confirmDialog.deleteMessage', { name: accountToDelete.name });
        })()}
        confirmLabel={isDeleting ? t('confirmDialog.deleteConfirmLoading') : t('confirmDialog.deleteConfirm')}
        cancelLabel={tc('cancel')}
        variant="danger"
        onConfirm={handleDeleteConfirm}
        onCancel={handleDeleteCancel}
      />

      <RecordInUseDialog
        inUse={inUse && { name: inUse.account.name, entries: inUse.entries }}
        hrefFor={(entry) => (inUse ? accountInUseHref(inUse.account.id, entry) : undefined)}
        onClose={() => setInUse(null)}
      />
    </div>
  );
}
