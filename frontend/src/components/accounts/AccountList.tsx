'use client';

import { useState, useEffect, useMemo, useCallback } from 'react';
import { sumConverted, type ConvertedTotal } from '@/lib/currency-total';
import { PartialTotal } from '@/components/ui/PartialTotal';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Account, AccountType } from '@/types/account';
import { Institution } from '@/types/institution';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { accountsApi } from '@/lib/accounts';
import { invalidateBalanceCaches } from '@/lib/apiCache';
import { useAuthStore } from '@/store/authStore';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import toast from 'react-hot-toast';
import { getErrorMessage } from '@/lib/errors';
import { AccountRow, buildAccountActions, type AccountActionLabels } from './AccountRow';
import { useLongPress } from '@/hooks/useLongPress';
import { RowActionSheet } from '@/components/ui/row-actions/RowActionSheet';
import { useTableDensity } from '@/hooks/useTableDensity';
import { useDensityPreference } from '@/store/densityStore';
import { SortIcon } from '@/components/ui/SortIcon';
import { MultiSelect, MultiSelectOption } from '@/components/ui/MultiSelect';
import { ToggleSwitch } from '@/components/ui/ToggleSwitch';
import { formatAccountType } from '@/lib/account-utils';
import { buildLogicalAccounts, type LogicalAccount } from '@/lib/logical-accounts';
import { useMainAccountName } from '@/hooks/useMainAccountName';
import { DensityToggleBar } from '@/components/ui/DensityToggle';
import { EmptyState } from '@/components/ui/EmptyState';
import { useIsMobile } from '@/hooks/useIsMobile';

type SortField = 'name' | 'type' | 'balance' | 'status';
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
  { field: 'balance', labelKey: 'list.columns.balance' },
] as const satisfies ReadonlyArray<{ field: SortField; labelKey: string }>;

// LocalStorage keys for filter persistence
const STORAGE_KEYS = {
  showFilters: 'accounts.filter.showFilters',
  status: 'accounts.filter.status',
  netWorth: 'accounts.filter.netWorth',
  joint: 'accounts.filter.joint',
  types: 'accounts.filter.types',
  search: 'accounts.filter.search',
  sortField: 'accounts.filter.sortField',
  sortDirection: 'accounts.filter.sortDirection',
  collapsedGroups: 'accounts.filter.collapsedGroups',
};

// Display order for account-type groups: assets first, then liabilities.
const ACCOUNT_TYPE_ORDER: AccountType[] = [
  'CHEQUING',
  'SAVINGS',
  'CASH',
  'INVESTMENT',
  'ASSET',
  'CREDIT_CARD',
  'LINE_OF_CREDIT',
  'LOAN',
  'MORTGAGE',
  'OTHER',
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
      <svg
        className={`w-4 h-4 text-gray-500 dark:text-gray-400 transition-transform ${isCollapsed ? '-rotate-90' : ''}`}
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
        aria-hidden="true"
      >
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
      </svg>
      <span className={`font-semibold text-gray-700 dark:text-gray-200 ${labelClassName}`}>{label}</span>
      <span className="text-xs text-gray-500 dark:text-gray-400 whitespace-nowrap">{count}</span>
    </>
  );
}

/** A group's converted total, in both layouts (partial when a rate is missing). */
function GroupHeaderTotal({
  total,
  displayCurrency,
  format,
}: {
  total: ConvertedTotal;
  displayCurrency: string;
  format: (value: number, currencyCode?: string) => string;
}) {
  return (
    <span
      className={`text-sm font-medium ${
        total.value >= 0
          ? 'text-gray-700 dark:text-gray-200'
          : 'text-red-600 dark:text-red-400'
      }`}
    >
      <PartialTotal total={total} displayCurrency={displayCurrency}>
        {format(total.value, displayCurrency)}
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

export function AccountList({ accounts, institutions, brokerageMarketValues, unpricedHoldingCounts, portfolioFailed, defaultCurrency, convertToDefault, onEdit, onRefresh }: AccountListProps) {
  const t = useTranslations('accounts');
  const tc = useTranslations('common');
  const stripAccountName = useMainAccountName();
  const router = useRouter();
  const isDelegateView = useAuthStore((s) => !!s.actingAsUserId);
  const { formatCurrency: formatCurrencyBase } = useNumberFormat();
  const [closeDialogOpen, setCloseDialogOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [accountToClose, setAccountToClose] = useState<Account | null>(null);
  const [accountToDelete, setAccountToDelete] = useState<Account | null>(null);
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

  // Filter state - initialize from localStorage
  const [showFilters, _setShowFilters] = useState(() =>
    getStoredValue<boolean>(STORAGE_KEYS.showFilters, false)
  );
  const [filterStatus, setFilterStatus] = useState<'active' | 'closed' | ''>(() =>
    getStoredValue<'active' | 'closed' | ''>(STORAGE_KEYS.status, '')
  );
  const [filterNetWorth, setFilterNetWorth] = useState<'included' | 'excluded' | ''>(() =>
    getStoredValue<'included' | 'excluded' | ''>(STORAGE_KEYS.netWorth, '')
  );
  // Joint filter: '' = all, 'joint' = only accounts shared TO the caller.
  // Only offered when at least one joint row is present (conditional-filter
  // precedent: the net-worth filter below).
  const [filterJoint, setFilterJoint] = useState<'joint' | ''>(() =>
    getStoredValue<'joint' | ''>(STORAGE_KEYS.joint, '')
  );
  // Account-type filter: an empty list means "all types". Persisted so the
  // chosen types survive navigating away and back to the page.
  const [filterTypes, setFilterTypes] = useState<AccountType[]>(() =>
    getStoredValue<AccountType[]>(STORAGE_KEYS.types, [])
  );
  // Free-text filter on account name.
  const [filterSearch, setFilterSearch] = useState<string>(() =>
    getStoredValue<string>(STORAGE_KEYS.search, '')
  );

  // Collapsed account-type groups - initialize from localStorage
  const [collapsedGroups, setCollapsedGroups] = useState<Set<AccountType>>(() => {
    const stored = getStoredValue<AccountType[]>(STORAGE_KEYS.collapsedGroups, []);
    return new Set(stored);
  });

  const toggleGroup = useCallback((type: AccountType) => {
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
    localStorage.setItem(STORAGE_KEYS.showFilters, JSON.stringify(showFilters));
  }, [showFilters]);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEYS.status, JSON.stringify(filterStatus));
  }, [filterStatus]);

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
  // action and from the detail page's own link.
  const handleRowClick = useCallback((account: Account) => {
    if (account.accountSubType === 'INVESTMENT_BROKERAGE') {
      router.push(`/accounts/${account.id}`);
    } else {
      router.push(`/transactions?accountId=${account.id}`);
    }
  }, [router]);

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
    });
  }, [accounts, favOverrides, stripAccountName, brokerageMarketValues, unpricedHoldingCounts]);

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
      result = result.filter((l) => typeSet.has(l.primary.accountType));
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
      }
      return sortDirection === 'asc' ? comparison : -comparison;
    });
  }, [logicalAccounts, filterStatus, filterNetWorth, filterJoint, filterTypes, filterSearch, sortField, sortDirection]);

  // Account-type options for the type filter, limited to the types actually
  // present and ordered to match the grouped list below (unknown types last).
  const typeOptions = useMemo<MultiSelectOption[]>(() => {
    const present = new Set(accounts.map((a) => a.accountType));
    const ordered = ACCOUNT_TYPE_ORDER.filter((type) => present.has(type));
    for (const type of present) {
      if (!ordered.includes(type)) ordered.push(type);
    }
    return ordered.map((type) => ({ value: type, label: formatAccountType(type, tc) }));
  }, [accounts, tc]);

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
    const groups = new Map<AccountType, LogicalAccount[]>();
    for (const logical of filteredAndSortedAccounts) {
      const existing = groups.get(logical.primary.accountType);
      if (existing) {
        existing.push(logical);
      } else {
        groups.set(logical.primary.accountType, [logical]);
      }
    }

    const result: { type: AccountType; accounts: LogicalAccount[] }[] = [];
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
    const totals = new Map<AccountType, ConvertedTotal>();
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
        (portfolioFailed === true || (unpricedHoldingCounts?.get(account.id) ?? 0) > 0);
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
      });
    }
    return totals;
  }, [groupedAccounts, brokerageMarketValues, unpricedHoldingCounts, portfolioFailed, convertToDefault]);

  // Flatten groups into a sequence of header / row entries with stable striping
  // indices so AccountRow alternation continues to look right across groups.
  const renderItems = useMemo(() => {
    type Item =
      | { kind: 'header'; type: AccountType; count: number; total: ConvertedTotal; isCollapsed: boolean }
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
  useEffect(() => {
    if (!hasExcludedAccounts && filterNetWorth) {
      setFilterNetWorth('');
    }
  }, [hasExcludedAccounts, filterNetWorth]);

  // Only show the joint filter when at least one account is shared to the
  // caller; clear it when the last joint account disappears (revoke).
  const hasJointAccounts = useMemo(
    () => accounts.some((a) => a.isJoint),
    [accounts],
  );
  useEffect(() => {
    if (!hasJointAccounts && filterJoint) {
      setFilterJoint('');
    }
  }, [hasJointAccounts, filterJoint]);

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDirection((prev) => (prev === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortField(field);
      setSortDirection('asc');
    }
  };

  const clearFilters = () => {
    setFilterStatus('');
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
      toast.error(getErrorMessage(error, t('toast.deleteFailed')));
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

  const formatCurrency = useCallback((amount: number | string | null | undefined, currency: string) => {
    const numericAmount = Number(amount) || 0;
    const formatted = formatCurrencyBase(numericAmount, currency);

    // Only show currency code if it differs from user's default currency
    if (currency !== defaultCurrency) {
      return `${formatted} ${currency}`;
    }
    return formatted;
  }, [formatCurrencyBase, defaultCurrency]);

  if (accounts.length === 0) {
    return (
      <EmptyState title={t('list.empty')} />
    );
  }

  return (
    <div>
      {/* Filter Bar */}
      <div className="px-3 sm:px-6 py-3 border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div className="flex items-center gap-4">
            {/* Status segmented control and Net Worth filter */}
            <div className="flex flex-col sm:flex-row items-start sm:items-center gap-2 sm:gap-3">
              {/* Status segmented control */}
              <div className="inline-flex rounded-md shadow-sm">
              <button
                onClick={() => setFilterStatus('')}
                className={`px-3 py-1.5 text-sm font-medium rounded-l-md border ${
                  filterStatus === ''
                    ? 'bg-blue-600 text-white border-blue-600'
                    : 'bg-white dark:bg-gray-700 text-gray-700 dark:text-gray-300 border-gray-300 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-600'
                }`}
              >
                {t('list.filter.all')}
              </button>
              <button
                onClick={() => setFilterStatus('active')}
                className={`px-3 py-1.5 text-sm font-medium border-t border-b ${
                  filterStatus === 'active'
                    ? 'bg-blue-600 text-white border-blue-600'
                    : 'bg-white dark:bg-gray-700 text-gray-700 dark:text-gray-300 border-gray-300 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-600'
                }`}
              >
                {t('list.filter.active')}
              </button>
              <button
                onClick={() => setFilterStatus('closed')}
                className={`px-3 py-1.5 text-sm font-medium rounded-r-md border ${
                  filterStatus === 'closed'
                    ? 'bg-blue-600 text-white border-blue-600'
                    : 'bg-white dark:bg-gray-700 text-gray-700 dark:text-gray-300 border-gray-300 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-600'
                }`}
              >
                {t('list.filter.closed')}
              </button>
              </div>

              {/* Account-type filter (multi-select) */}
              <div className="w-full sm:w-52">
                <MultiSelect
                  ariaLabel={t('list.filter.typeAriaLabel')}
                  options={typeOptions}
                  value={filterTypes}
                  onChange={(vals) => setFilterTypes(vals as AccountType[])}
                  placeholder={t('list.filter.typePlaceholder')}
                />
              </div>

              {/* Free-text name filter */}
              <div className="relative w-full sm:w-52">
                <input
                  type="text"
                  value={filterSearch}
                  onChange={(e) => setFilterSearch(e.target.value)}
                  placeholder={t('list.filter.searchPlaceholder')}
                  aria-label={t('list.filter.searchAriaLabel')}
                  className="w-full text-sm font-sans border border-gray-300 dark:border-gray-600 rounded-md pl-3 pr-8 py-1.5 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 dark:placeholder-gray-400"
                />
                {filterSearch && (
                  <button
                    type="button"
                    onClick={() => setFilterSearch('')}
                    aria-label={t('list.filter.searchClear')}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200"
                  >
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                )}
              </div>

              {/* Net Worth filter -- only shown when at least one account is excluded */}
              {hasExcludedAccounts && (
                <select
                  value={filterNetWorth}
                  onChange={(e) => setFilterNetWorth(e.target.value as 'included' | 'excluded' | '')}
                  className="text-sm font-sans border border-gray-300 dark:border-gray-600 rounded-md px-3 py-1.5 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 min-w-[16rem]"
                >
                  <option value="">{t('list.filter.netWorthAll')}</option>
                  <option value="included">{t('list.filter.inNetWorth')}</option>
                  <option value="excluded">{t('list.filter.excludedFromNetWorth')}</option>
                </select>
              )}

              {/* Joint filter -- only shown when something is shared to the
                  caller. The switch and its text are siblings, not nested:
                  ToggleSwitch is a <button>, which a <label> cannot label. */}
              {hasJointAccounts && (
                <div className="inline-flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300 whitespace-nowrap">
                  <ToggleSwitch
                    size="sm"
                    checked={filterJoint === 'joint'}
                    onChange={(v) => setFilterJoint(v ? 'joint' : '')}
                    label={t('list.filterJoint')}
                  />
                  <span>{t('list.filterJoint')}</span>
                </div>
              )}
            </div>
          </div>
          <span className="text-sm text-gray-500 dark:text-gray-400">
            {t('list.accountCount', { filtered: filteredAndSortedAccounts.length, total: logicalAccounts.length })}
          </span>
        </div>
      </div>

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
        {/* Density toggle */}
        <DensityToggleBar view="accounts" />
        <div className="overflow-x-auto">
        <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
          {/* On a phone the wrapped card labels its own values, so the column
              header is dropped -- but the controls in that header row must not
              go with it: these `<th>`s are how the list is sorted, and the
              chosen field is persisted, so a header showing fewer fields than
              the sort can be in would leave the list ordered by something the
              phone can neither see nor undo. A slim control header carries all
              four as buttons -- the card shows all four values -- and no column
              label of its own: the single card cell below holds name, balance,
              type and status at once, so naming this header after any one of
              them would misdescribe the column to a screen reader. Each button
              names itself with the label of the field it sorts by. */}
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
                className={`${headerPadding} text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-700 select-none hidden sm:table-cell`}
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
                className={`${headerPadding} text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-700 select-none hidden md:table-cell w-1 whitespace-nowrap`}
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
          <tbody className="bg-white dark:bg-gray-900 divide-y divide-gray-200 dark:divide-gray-700">
            {renderItems.map((item) =>
              item.kind === 'header' ? (
                <tr
                  key={`group-${item.type}`}
                  className="group bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700 cursor-pointer select-none"
                  onClick={() => toggleGroup(item.type)}
                  aria-expanded={!item.isCollapsed}
                >
                  {/* Every row of the wrapped layout is one cell, so the group
                      header is too: its label and its total share that cell
                      and the row stays as tappable as the tier version. */}
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
                            label={formatAccountType(item.type, tc)}
                            count={t('list.groupCount', { count: item.count })}
                            isCollapsed={item.isCollapsed}
                            labelClassName="truncate"
                          />
                        </div>
                        <span className="text-right whitespace-nowrap">
                          <GroupHeaderTotal
                            total={item.total}
                            displayCurrency={defaultCurrency}
                            format={formatCurrencyBase}
                          />
                        </span>
                      </div>
                    </td>
                  ) : (
                  <>
                  <td className={cellPadding}>
                    <div className="flex items-center gap-2 min-w-0 text-sm">
                      <GroupHeaderLabel
                        label={formatAccountType(item.type, tc)}
                        count={t('list.groupCount', { count: item.count })}
                        isCollapsed={item.isCollapsed}
                      />
                    </div>
                  </td>
                  <td className="hidden sm:table-cell" aria-hidden="true" />
                  <td className="hidden md:table-cell" aria-hidden="true" />
                  <td className={`${cellPadding} text-right whitespace-nowrap`}>
                    <GroupHeaderTotal
                      total={item.total}
                      displayCurrency={defaultCurrency}
                      format={formatCurrencyBase}
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
                  wrapped={wrapped}
                  cellPadding={cellPadding}
                  isDeletable={deletableAccounts.has(item.logical.id)}
                  accountNameMap={accountNameMap}
                  institution={item.logical.primary.institutionId ? institutionsById.get(item.logical.primary.institutionId) : undefined}
                  brokerageMarketValue={item.logical.holdingsAccountId ? brokerageMarketValues?.get(item.logical.holdingsAccountId) : undefined}
                  unpricedHoldingsCount={item.logical.holdingsAccountId ? unpricedHoldingCounts?.get(item.logical.holdingsAccountId) : undefined}
                  defaultCurrency={defaultCurrency}
                  formatCurrency={formatCurrency}
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

      {/* Close Account Confirmation Dialog */}
      <ConfirmDialog
        isOpen={closeDialogOpen}
        title={t('confirmDialog.closeTitle')}
        message={accountToClose
          ? t('confirmDialog.closeMessage', {
              name:
                logicalById.get(accountToClose.id)?.displayName ??
                accountToClose.name,
            })
          : ''
        }
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
    </div>
  );
}
