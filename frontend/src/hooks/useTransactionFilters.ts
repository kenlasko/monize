'use client';

import { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { isInvestmentBrokerageAccount } from '@/lib/account-utils';
import {
  buildCategoryColorMap,
  buildCategoryIconMap,
  buildCategoryLabelMap,
  buildCategoryFilterOptions,
  canonicalizeCategoryFilter,
  isSpecialCategoryFilterId,
  resolveSelectedCategories,
} from '@/lib/categoryUtils';
import { useCategoryFilterLabels } from '@/hooks/useCategoryFilterLabels';
import { Account } from '@/types/account';
import { Category } from '@/types/category';
import { Payee } from '@/types/payee';
import { Tag } from '@/types/tag';
import { TransactionStatus } from '@/types/transaction';
import { isUuid } from '@/lib/uuid';

// LocalStorage keys for filter persistence
const STORAGE_KEYS = {
  accountIds: 'transactions.filter.accountIds',
  accountStatus: 'transactions.filter.accountStatus',
  categoryIds: 'transactions.filter.categoryIds',
  payeeIds: 'transactions.filter.payeeIds',
  startDate: 'transactions.filter.startDate',
  endDate: 'transactions.filter.endDate',
  search: 'transactions.filter.search',
  timePeriod: 'transactions.filter.timePeriod',
  amountFrom: 'transactions.filter.amountFrom',
  amountTo: 'transactions.filter.amountTo',
  tagIds: 'transactions.filter.tagIds',
  statuses: 'transactions.filter.statuses',
  originalCurrencyCodes: 'transactions.filter.originalCurrencyCodes',
  tagKey: 'transactions.filter.tagKey',
  tagKeyOp: 'transactions.filter.tagKeyOp',
  tagKeyValue: 'transactions.filter.tagKeyValue',
  hasAttachments: 'transactions.filter.hasAttachments',
};

export type TagKeyOp = 'hasValue' | 'noValue' | 'contains' | 'notContains';
const VALID_TAG_KEY_OPS = new Set<string>([
  'hasValue',
  'noValue',
  'contains',
  'notContains',
]);
function sanitizeTagKeyOp(value: string): TagKeyOp {
  return VALID_TAG_KEY_OPS.has(value) ? (value as TagKeyOp) : 'hasValue';
}

// Attachment presence filter: '' (any), 'yes' (has attachments), 'no' (none).
export type HasAttachmentsFilter = '' | 'yes' | 'no';
function sanitizeHasAttachments(value: string): HasAttachmentsFilter {
  return value === 'yes' || value === 'no' ? value : '';
}

const VALID_TRANSACTION_STATUSES = new Set<string>(Object.values(TransactionStatus));

function sanitizeStatuses(values: string[]): TransactionStatus[] {
  return values.filter((v): v is TransactionStatus => VALID_TRANSACTION_STATUSES.has(v));
}

/**
 * Window event dispatched by the global header search to ask the
 * transactions page (if mounted) to drop existing filters and run a
 * fresh search. Carries `{ term: string }` in `detail`.
 */
export const HEADER_SEARCH_EVENT = 'transactions:applyHeaderSearch';

export interface HeaderSearchEventDetail {
  term: string;
}

/**
 * Wipe every persisted transaction filter from localStorage. Called by
 * the header search before navigating so the hook initializes from a
 * clean slate (including `accountStatus`, which is not represented in
 * the URL).
 */
export function clearTransactionFilterStorage(): void {
  if (typeof window === 'undefined') return;
  for (const key of Object.values(STORAGE_KEYS)) {
    localStorage.removeItem(key);
  }
}

// Helper to get filter values as array
// If ANY URL params are present (navigation from reports), ignore localStorage entirely
function getFilterValues(key: string, urlParam: string | null, hasAnyUrlParams: boolean): string[] {
  if (hasAnyUrlParams) {
    return urlParam ? urlParam.split(',').map(s => s.trim()).filter(s => s) : [];
  }
  if (typeof window === 'undefined') return [];
  const stored = localStorage.getItem(key);
  if (!stored) return [];
  try {
    return JSON.parse(stored);
  } catch {
    return [];
  }
}

// Helper to get single string filter value
function getFilterValue(key: string, urlParam: string | null, hasAnyUrlParams: boolean): string {
  if (hasAnyUrlParams) {
    return urlParam || '';
  }
  if (typeof window === 'undefined') return '';
  return localStorage.getItem(key) || '';
}

/**
 * Signature of the single-entity deep-link params (the SINGULAR forms only:
 * `accountId`/`categoryId`/`payeeId`). The page's own URL rewrites
 * (`updateUrl`) emit exclusively the plural forms, so a singular param can
 * only come from an external deep link -- a sibling page's row click or an AI
 * chat entity link. Comparing signatures lets the soft-navigation watcher
 * below detect a NEW deep link without re-firing on the page's own rewrites.
 * Returns null when no singular param is present.
 */
function buildEntityParamSignature(
  params: Pick<URLSearchParams, 'get'>,
): string | null {
  const accountId = params.get('accountId');
  const categoryId = params.get('categoryId');
  const payeeId = params.get('payeeId');
  if (!accountId && !categoryId && !payeeId) return null;
  return `a:${accountId ?? ''}|c:${categoryId ?? ''}|p:${payeeId ?? ''}`;
}

// Helper to get stored value (for non-URL params like account status)
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

interface UseTransactionFiltersOptions {
  resetPageOnMount?: boolean;
  accounts: Account[];
  categories: Category[];
  payees: Payee[];
  tags: Tag[];
  weekStartsOn: 0 | 1 | 2 | 3 | 4 | 5 | 6;
}

export function useTransactionFilters({ accounts, categories, payees, tags, weekStartsOn: _weekStartsOn, resetPageOnMount = false }: UseTransactionFiltersOptions) {
  const router = useRouter();
  const searchParams = useSearchParams();

  // Pagination state - initialize from URL
  const [currentPage, setCurrentPage] = useState(() => {
    const pageParam = resetPageOnMount ? null : searchParams.get('page');
    return pageParam ? parseInt(pageParam, 10) : 1;
  });

  // Filters - initialize from URL params, falling back to localStorage
  const [filterAccountIds, setFilterAccountIds] = useState<string[]>([]);
  const [filterAccountStatus, setFilterAccountStatus] = useState<'active' | 'closed' | ''>(() =>
    getStoredValue<'active' | 'closed' | ''>(STORAGE_KEYS.accountStatus, '')
  );
  const [rawFilterCategoryIds, setFilterCategoryIds] = useState<string[]>([]);
  // What the user ticked, with any whole type collapsed to its pseudo-id. Every
  // reader (the requests, the URL, localStorage, the chips, the picker) sees
  // this form, so a selection of every category is never sent as an id list.
  const filterCategoryIds = useMemo(
    () => canonicalizeCategoryFilter(rawFilterCategoryIds, categories),
    [rawFilterCategoryIds, categories],
  );
  const [filterPayeeIds, setFilterPayeeIds] = useState<string[]>([]);
  const [filterStartDate, setFilterStartDate] = useState<string>('');
  const [filterEndDate, setFilterEndDate] = useState<string>('');
  const [filterSearch, setFilterSearch] = useState<string>('');
  const [searchInput, setSearchInput] = useState<string>('');
  const [filterTimePeriod, setFilterTimePeriod] = useState<string>('');
  const [filterAmountFrom, setFilterAmountFrom] = useState<string>('');
  const [filterAmountTo, setFilterAmountTo] = useState<string>('');
  const [filterTagIds, setFilterTagIds] = useState<string[]>([]);
  const [filterStatuses, setFilterStatuses] = useState<TransactionStatus[]>([]);
  // Currencies a transaction was entered in (foreign-entry filter).
  const [filterOriginalCurrencyCodes, setFilterOriginalCurrencyCodes] = useState<string[]>([]);
  // KEY:VALUE tag filter (e.g. key "country", op "contains", value "usa").
  const [filterTagKey, setFilterTagKey] = useState<string>('');
  const [filterTagKeyOp, setFilterTagKeyOp] = useState<TagKeyOp>('hasValue');
  const [filterTagKeyValue, setFilterTagKeyValue] = useState<string>('');
  // Attachment presence filter ('' any, 'yes' has, 'no' none).
  const [filterHasAttachments, setFilterHasAttachments] = useState<HasAttachmentsFilter>('');
  const searchDebounceRef = useRef<NodeJS.Timeout | null>(null);
  const [filtersInitialized, setFiltersInitialized] = useState(false);
  const [filtersExpanded, setFiltersExpanded] = useState(true);
  // Transaction id to flash/scroll to after a deep link (e.g. the AI chat's
  // "View transaction" link). Initialized from the URL once on mount.
  const [highlightTransactionId, setHighlightTransactionId] = useState<string | null>(null);

  // Track when we're syncing state from browser back/forward navigation
  const syncingFromPopstateRef = useRef(false);

  // Track if this is a filter-triggered change (to reset page to 1)
  const isFilterChange = useRef(false);
  // Target transaction ID for navigating to a specific transaction
  const targetTransactionIdRef = useRef<string | null>(null);
  // The `targetTransactionId` deep link already applied, so a soft navigation
  // to the same id (or the mount-time init) is not re-processed. Tracked
  // separately from targetTransactionIdRef because the latter is consumed (set
  // back to null) by each load.
  const appliedTargetRef = useRef<string | null>(null);
  // Same idea for single-entity deep links (`accountId`/`categoryId`/`payeeId`
  // singular params, e.g. an AI chat entity link clicked while this page is
  // already mounted): the signature already applied, so neither the mount-time
  // init nor the page's own URL rewrites re-trigger the watcher.
  const appliedEntityFilterRef = useRef<string | null>(null);
  // Debounce timer for filter-triggered loads
  const filterDebounceRef = useRef<NodeJS.Timeout | null>(null);

  // Update URL when filters or page change
  const updateUrl = useCallback((page: number, filters: {
    accountIds: string[];
    categoryIds: string[];
    payeeIds: string[];
    tagIds: string[];
    startDate: string;
    endDate: string;
    search: string;
    amountFrom: string;
    amountTo: string;
    statuses: TransactionStatus[];
    originalCurrencyCodes: string[];
    tagKey: string;
    tagKeyOp: TagKeyOp;
    tagKeyValue: string;
    hasAttachments: HasAttachmentsFilter;
  }, push: boolean = false) => {
    const params = new URLSearchParams();
    const currentQuery = new URLSearchParams(window.location.search);
    const basis = currentQuery.has('targetTransactionId') || currentQuery.has('highlightTransactionId') ? 'cash' : currentQuery.get('basis');
    if (basis === 'cash' || basis === 'accrual') params.set('basis', basis);
    if (page > 1) params.set('page', page.toString());
    if (filters.accountIds.length) params.set('accountIds', filters.accountIds.join(','));
    if (filters.categoryIds.length) params.set('categoryIds', filters.categoryIds.join(','));
    if (filters.payeeIds.length) params.set('payeeIds', filters.payeeIds.join(','));
    if (filters.tagIds.length) params.set('tagIds', filters.tagIds.join(','));
    if (filters.startDate) params.set('startDate', filters.startDate);
    if (filters.endDate) params.set('endDate', filters.endDate);
    if (filters.search) params.set('search', filters.search);
    if (filters.amountFrom) params.set('amountFrom', filters.amountFrom);
    if (filters.amountTo) params.set('amountTo', filters.amountTo);
    if (filters.statuses.length) params.set('statuses', filters.statuses.join(','));
    if (filters.originalCurrencyCodes.length) params.set('originalCurrencyCodes', filters.originalCurrencyCodes.join(','));
    if (filters.tagKey) {
      params.set('tagKey', filters.tagKey);
      params.set('tagKeyOp', filters.tagKeyOp);
      if (
        (filters.tagKeyOp === 'contains' || filters.tagKeyOp === 'notContains') &&
        filters.tagKeyValue
      ) {
        params.set('tagKeyValue', filters.tagKeyValue);
      }
    }
    if (filters.hasAttachments) params.set('hasAttachments', filters.hasAttachments);

    const queryString = params.toString();
    const newUrl = queryString ? `/transactions?${queryString}` : '/transactions';
    // The page re-syncs on every load and data refresh, mostly to the URL it is
    // already on. That is a server round trip for nothing, and when a full-page
    // navigation cancels it Next falls back to a hard load of this page,
    // aborting the navigation away.
    if (newUrl === `${window.location.pathname}${window.location.search}`) return;
    if (push) {
      router.push(newUrl, { scroll: false });
    } else {
      router.replace(newUrl, { scroll: false });
    }
  }, [router]);

  // Get display info for selected filters
  const categoryFilterLabels = useCategoryFilterLabels();
  const selectedCategories = resolveSelectedCategories(filterCategoryIds, categories, categoryFilterLabels);

  const selectedPayees = filterPayeeIds
    .map(id => payees.find(p => p.id === id))
    .filter((p): p is Payee => p !== undefined);

  const selectedAccounts = filterAccountIds
    .map(id => accounts.find(a => a.id === id))
    .filter((a): a is Account => a !== undefined);

  const selectedTags = filterTagIds
    .map(id => tags.find(t => t.id === id))
    .filter((t): t is Tag => t !== undefined);

  // Filter accounts by status for the dropdown
  const filteredAccounts = useMemo(() => {
    return accounts.filter(account => {
      if (isInvestmentBrokerageAccount(account)) return false;
      if (filterAccountStatus === 'active') return !account.isClosed;
      if (filterAccountStatus === 'closed') return account.isClosed;
      return true;
    });
  }, [accounts, filterAccountStatus]);

  // Memoize filter option arrays
  const categoryFilterOptions = useMemo(
    () => buildCategoryFilterOptions(categories, categoryFilterLabels),
    [categories, categoryFilterLabels],
  );

  const categoryColorMap = useMemo(() => buildCategoryColorMap(categories), [categories]);
  const categoryIconMap = useMemo(() => buildCategoryIconMap(categories), [categories]);
  const categoryLabelMap = useMemo(() => buildCategoryLabelMap(categories), [categories]);

  const accountFilterOptions = useMemo(() => {
    // Copy before sorting: `filteredAccounts` is a memoized array other
    // consumers read (it is what the bulk-update account scope is derived
    // from), and Array.prototype.sort reorders in place.
    return [...filteredAccounts]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(account => ({ value: account.id, label: account.name }));
  }, [filteredAccounts]);

  const payeeFilterOptions = useMemo(() => {
    return payees
      .filter(payee => payee.isActive)
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
      .map(payee => ({ value: payee.id, label: payee.name }));
  }, [payees]);

  const tagFilterOptions = useMemo(() => {
    return [...tags]
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
      .map(tag => ({ value: tag.id, label: tag.name }));
  }, [tags]);

  // When account status filter changes, remove any selected accounts that no longer match
  useEffect(() => {
    if (!filtersInitialized || filterAccountIds.length === 0 || accounts.length === 0) return;
    const filteredIds = new Set(filteredAccounts.map(a => a.id));
    const validSelectedIds = filterAccountIds.filter(id => filteredIds.has(id));
    if (validSelectedIds.length !== filterAccountIds.length) {
      setFilterAccountIds(validSelectedIds); // eslint-disable-line react-hooks/set-state-in-effect -- sync invalid selections after data change
    }
  }, [filterAccountStatus, filteredAccounts, filtersInitialized, accounts.length]); // eslint-disable-line react-hooks/exhaustive-deps

  // When payees change, remove any selected payee filter IDs that no longer exist
  useEffect(() => {
    if (!filtersInitialized || filterPayeeIds.length === 0 || payees.length === 0) return;
    const payeeIds = new Set(payees.map(p => p.id));
    const validSelectedIds = filterPayeeIds.filter(id => payeeIds.has(id));
    if (validSelectedIds.length !== filterPayeeIds.length) {
      setFilterPayeeIds(validSelectedIds); // eslint-disable-line react-hooks/set-state-in-effect -- sync invalid selections after data change
    }
  }, [payees, filtersInitialized]); // eslint-disable-line react-hooks/exhaustive-deps

  // When tags change, remove any selected tag filter IDs that no longer exist
  useEffect(() => {
    if (!filtersInitialized || filterTagIds.length === 0 || tags.length === 0) return;
    const tagIdSet = new Set(tags.map(t => t.id));
    const validSelectedIds = filterTagIds.filter(id => tagIdSet.has(id));
    if (validSelectedIds.length !== filterTagIds.length) {
      setFilterTagIds(validSelectedIds); // eslint-disable-line react-hooks/set-state-in-effect -- sync invalid selections after data change
    }
  }, [tags, filtersInitialized]); // eslint-disable-line react-hooks/exhaustive-deps

  // When categories change, remove any selected category filter IDs that no longer exist
  useEffect(() => {
    if (!filtersInitialized || filterCategoryIds.length === 0 || categories.length === 0) return;
    const categoryIds = new Set(categories.map(c => c.id));
    const validSelectedIds = filterCategoryIds.filter(id => isSpecialCategoryFilterId(id) || categoryIds.has(id));
    if (validSelectedIds.length !== filterCategoryIds.length) {
      setFilterCategoryIds(validSelectedIds); // eslint-disable-line react-hooks/set-state-in-effect -- sync invalid selections after data change
    }
  }, [categories, filtersInitialized]); // eslint-disable-line react-hooks/exhaustive-deps

  // Calculate active filter count
  const activeFilterCount = useMemo(() => {
    let count = 0;
    count += filterAccountIds.length;
    count += filterCategoryIds.length;
    count += filterPayeeIds.length;
    count += filterTagIds.length;
    count += filterStatuses.length;
    count += filterOriginalCurrencyCodes.length;
    if (filterStartDate) count++;
    if (filterEndDate) count++;
    if (filterSearch) count++;
    if (filterAmountFrom) count++;
    if (filterAmountTo) count++;
    if (filterTagKey) count++;
    if (filterHasAttachments) count++;
    return count;
  }, [filterAccountIds, filterCategoryIds, filterPayeeIds, filterTagIds, filterStatuses, filterOriginalCurrencyCodes, filterStartDate, filterEndDate, filterSearch, filterAmountFrom, filterAmountTo, filterTagKey, filterHasAttachments]);

  // Auto-collapse filters when there are active filters, expand when none
  useEffect(() => {
    if (filtersInitialized) {
      setFiltersExpanded(activeFilterCount === 0); // eslint-disable-line react-hooks/set-state-in-effect -- set once on init
    }
  }, [filtersInitialized]); // eslint-disable-line react-hooks/exhaustive-deps

  // Initialize filters on mount
  /* eslint-disable react-hooks/set-state-in-effect -- mount-time initialization from URL/localStorage */
  useEffect(() => {
    const hasAnyUrlParams = searchParams.has('accountId') ||
      searchParams.has('accountIds') ||
      searchParams.has('accountStatus') ||
      searchParams.has('categoryId') ||
      searchParams.has('categoryIds') ||
      searchParams.has('categoryType') ||
      searchParams.has('payeeId') ||
      searchParams.has('payeeIds') ||
      searchParams.has('startDate') ||
      searchParams.has('endDate') ||
      searchParams.has('search') ||
      searchParams.has('amountFrom') ||
      searchParams.has('amountTo') ||
      searchParams.has('tagIds') ||
      searchParams.has('statuses') ||
      searchParams.has('originalCurrencyCodes') ||
      searchParams.has('tagKey') ||
      searchParams.has('hasAttachments') ||
      searchParams.has('targetTransactionId');

    const getAccountIds = () => {
      const ids = searchParams.get('accountIds');
      const id = searchParams.get('accountId');
      return getFilterValues(STORAGE_KEYS.accountIds, ids || id, hasAnyUrlParams);
    };
    const getCategoryIds = () => {
      // A type deep link is the pseudo-id itself; the server expands it.
      const categoryType = searchParams.get('categoryType');
      if (categoryType === 'income' || categoryType === 'expense') {
        return [categoryType];
      }
      const ids = searchParams.get('categoryIds');
      const id = searchParams.get('categoryId');
      return getFilterValues(STORAGE_KEYS.categoryIds, ids || id, hasAnyUrlParams);
    };
    const getPayeeIds = () => {
      const ids = searchParams.get('payeeIds');
      const id = searchParams.get('payeeId');
      return getFilterValues(STORAGE_KEYS.payeeIds, ids || id, hasAnyUrlParams);
    };

    setFilterAccountIds(getAccountIds());
    // An explicit accountStatus param (e.g. when opening a closed account from
    // the Institutions page) overrides the stored Show Accounts filter so the
    // selected account is not pruned and its transactions are visible.
    const accountStatusParam = searchParams.get('accountStatus');
    if (
      accountStatusParam === 'all' ||
      accountStatusParam === 'active' ||
      accountStatusParam === 'closed'
    ) {
      setFilterAccountStatus(accountStatusParam === 'all' ? '' : accountStatusParam);
    }
    setFilterCategoryIds(getCategoryIds());
    setFilterPayeeIds(getPayeeIds());
    setFilterTagIds(getFilterValues(STORAGE_KEYS.tagIds, searchParams.get('tagIds'), hasAnyUrlParams));
    const initialStartDate = getFilterValue(STORAGE_KEYS.startDate, searchParams.get('startDate'), hasAnyUrlParams);
    const initialEndDate = getFilterValue(STORAGE_KEYS.endDate, searchParams.get('endDate'), hasAnyUrlParams);
    setFilterStartDate(initialStartDate);
    setFilterEndDate(initialEndDate);
    const initialSearch = getFilterValue(STORAGE_KEYS.search, searchParams.get('search'), hasAnyUrlParams);
    setFilterSearch(initialSearch);
    setSearchInput(initialSearch);
    setFilterAmountFrom(getFilterValue(STORAGE_KEYS.amountFrom, searchParams.get('amountFrom'), hasAnyUrlParams));
    setFilterAmountTo(getFilterValue(STORAGE_KEYS.amountTo, searchParams.get('amountTo'), hasAnyUrlParams));
    setFilterStatuses(sanitizeStatuses(getFilterValues(STORAGE_KEYS.statuses, searchParams.get('statuses'), hasAnyUrlParams)));
    setFilterOriginalCurrencyCodes(getFilterValues(STORAGE_KEYS.originalCurrencyCodes, searchParams.get('originalCurrencyCodes'), hasAnyUrlParams));
    setFilterTagKey(getFilterValue(STORAGE_KEYS.tagKey, searchParams.get('tagKey'), hasAnyUrlParams));
    setFilterTagKeyOp(sanitizeTagKeyOp(getFilterValue(STORAGE_KEYS.tagKeyOp, searchParams.get('tagKeyOp'), hasAnyUrlParams)));
    setFilterTagKeyValue(getFilterValue(STORAGE_KEYS.tagKeyValue, searchParams.get('tagKeyValue'), hasAnyUrlParams));
    setFilterHasAttachments(sanitizeHasAttachments(getFilterValue(STORAGE_KEYS.hasAttachments, searchParams.get('hasAttachments'), hasAnyUrlParams)));
    if (hasAnyUrlParams) {
      setFilterTimePeriod((initialStartDate || initialEndDate) ? 'custom' : '');
    } else {
      setFilterTimePeriod(getFilterValue(STORAGE_KEYS.timePeriod, null, false));
    }
    // Deep link to a specific transaction (e.g. the AI chat "View transaction"
    // link). The backend resolves which page contains it; we flash/scroll to it
    // once it renders. A bogus value is ignored so the list still loads.
    const targetId = searchParams.get('targetTransactionId');
    if (targetId && isUuid(targetId)) {
      targetTransactionIdRef.current = targetId;
      setHighlightTransactionId(targetId);
      appliedTargetRef.current = targetId;
    }
    // Singular entity params in the mount URL were just applied above (along
    // with any co-present params like dates or search). Seed the applied
    // signature so the soft-navigation watcher below does not re-apply them
    // and wipe those co-applied filters.
    appliedEntityFilterRef.current = buildEntityParamSignature(searchParams);
    setFiltersInitialized(true);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  /* eslint-enable react-hooks/set-state-in-effect */

  // Honour a `targetTransactionId` deep link that arrives while this page is
  // already mounted -- e.g. the AI chat bubble's "View transaction" link
  // clicked without navigating away. A soft navigation only rewrites the query
  // string; the mount-time init effect above does not re-run, so the highlight
  // never fired. Watch the param here and apply it the same way a fresh page
  // load does: drop the existing filters (so the target is not hidden by them),
  // then flash/scroll to the row. The deferred load reads targetTransactionIdRef
  // and lets the backend resolve which page the row is on.
  useEffect(() => {
    if (!filtersInitialized) return;
    const targetId = searchParams.get('targetTransactionId');
    if (!targetId || !isUuid(targetId)) {
      // The param has been consumed/stripped (or was never a valid deep link),
      // so allow a future identical link to re-trigger -- e.g. clicking the
      // same "View transaction" link again to jump back to the row.
      appliedTargetRef.current = null;
      return;
    }
    if (targetId === appliedTargetRef.current) return;
    appliedTargetRef.current = targetId;
    // Resolve the target's page from the backend rather than resetting to 1.
    isFilterChange.current = false;
    // Note: filterAccountStatus (the Show Accounts toggle) is intentionally left
    // untouched -- the cross-page deep-link path keeps it too (it is seeded from
    // localStorage and only overridden by an explicit ?accountStatus param), so
    // clearing it here would diverge and permanently wipe the user's preference.
    setFilterAccountIds([]);
    setFilterCategoryIds([]);
    setFilterPayeeIds([]);
    setFilterTagIds([]);
    setFilterStartDate('');
    setFilterEndDate('');
    setFilterTimePeriod('');
    setFilterAmountFrom('');
    setFilterAmountTo('');
    setFilterStatuses([]);
    setFilterOriginalCurrencyCodes([]);
    setFilterTagKey('');
    setFilterTagKeyOp('hasValue');
    setFilterTagKeyValue('');
    setFilterHasAttachments('');
    if (searchDebounceRef.current) {
      clearTimeout(searchDebounceRef.current);
      searchDebounceRef.current = null;
    }
    setSearchInput('');
    setFilterSearch('');
    targetTransactionIdRef.current = targetId;
    setHighlightTransactionId(targetId);
  }, [searchParams, filtersInitialized]);

  // Honour a single-entity deep link (`?accountId=`/`?categoryId=`/`?payeeId=`,
  // singular) that arrives while this page is already mounted -- e.g. an AI
  // chat entity link clicked from the chat bubble without navigating away.
  // Mirrors the targetTransactionId watcher above: the mount-time init effect
  // does not re-run on a soft navigation, so without this the query string
  // would change but the filters would not. The page's own URL rewrites only
  // emit plural params, so a singular param is always an external deep link.
  // `isFilterChange` is deliberately left false: the link click already pushed
  // a history entry, and a replace-rewrite to the plural form keeps Back
  // returning to the pre-click page instead of looping on the singular URL.
  /* eslint-disable react-hooks/set-state-in-effect -- apply deep link from URL */
  useEffect(() => {
    if (!filtersInitialized) return;
    // Never fight the targetTransactionId watcher over one URL change.
    const targetId = searchParams.get('targetTransactionId');
    if (targetId && isUuid(targetId)) return;
    const signature = buildEntityParamSignature(searchParams);
    if (!signature) {
      // Params consumed (rewritten to plural) or never present: allow the
      // same link to re-trigger later, e.g. clicking it a second time.
      appliedEntityFilterRef.current = null;
      return;
    }
    if (signature === appliedEntityFilterRef.current) return;
    appliedEntityFilterRef.current = signature;

    const accountId = searchParams.get('accountId');
    const categoryId = searchParams.get('categoryId');
    const payeeId = searchParams.get('payeeId');
    const entity = accountId
      ? { kind: 'account' as const, id: accountId }
      : categoryId
        ? { kind: 'category' as const, id: categoryId }
        : { kind: 'payee' as const, id: payeeId as string };
    // A malformed id is ignored rather than applied, matching the
    // targetTransactionId handling (special category pseudo-ids excepted).
    const isSpecialCategory =
      entity.kind === 'category' && isSpecialCategoryFilterId(entity.id);
    if (!isSpecialCategory && !isUuid(entity.id)) return;

    setFilterAccountIds(entity.kind === 'account' ? [entity.id] : []);
    setFilterCategoryIds(entity.kind === 'category' ? [entity.id] : []);
    setFilterPayeeIds(entity.kind === 'payee' ? [entity.id] : []);
    // Deep links to accounts carry `accountStatus` (e.g. `all`) so a closed
    // account is not pruned by the stored Show Accounts toggle; apply it the
    // same way the mount-time init does. Absent the param, the toggle is left
    // untouched (same rationale as the targetTransactionId watcher).
    const accountStatusParam = searchParams.get('accountStatus');
    if (
      accountStatusParam === 'all' ||
      accountStatusParam === 'active' ||
      accountStatusParam === 'closed'
    ) {
      setFilterAccountStatus(accountStatusParam === 'all' ? '' : accountStatusParam);
    }
    setFilterTagIds([]);
    setFilterStartDate('');
    setFilterEndDate('');
    setFilterTimePeriod('');
    setFilterAmountFrom('');
    setFilterAmountTo('');
    setFilterStatuses([]);
    setFilterOriginalCurrencyCodes([]);
    setFilterTagKey('');
    setFilterTagKeyOp('hasValue');
    setFilterTagKeyValue('');
    setFilterHasAttachments('');
    if (searchDebounceRef.current) {
      clearTimeout(searchDebounceRef.current);
      searchDebounceRef.current = null;
    }
    setSearchInput('');
    setFilterSearch('');
    setCurrentPage(1);
  }, [searchParams, filtersInitialized]);
  /* eslint-enable react-hooks/set-state-in-effect */

  // Persist filter changes to localStorage
  useEffect(() => {
    localStorage.setItem(STORAGE_KEYS.accountStatus, JSON.stringify(filterAccountStatus));
  }, [filterAccountStatus]);

  useEffect(() => {
    if (!filtersInitialized) return;
    localStorage.setItem(STORAGE_KEYS.accountIds, JSON.stringify(filterAccountIds));
    localStorage.setItem(STORAGE_KEYS.categoryIds, JSON.stringify(filterCategoryIds));
    localStorage.setItem(STORAGE_KEYS.payeeIds, JSON.stringify(filterPayeeIds));
    localStorage.setItem(STORAGE_KEYS.tagIds, JSON.stringify(filterTagIds));
    localStorage.setItem(STORAGE_KEYS.startDate, filterStartDate);
    localStorage.setItem(STORAGE_KEYS.endDate, filterEndDate);
    localStorage.setItem(STORAGE_KEYS.search, filterSearch);
    localStorage.setItem(STORAGE_KEYS.timePeriod, filterTimePeriod);
    localStorage.setItem(STORAGE_KEYS.amountFrom, filterAmountFrom);
    localStorage.setItem(STORAGE_KEYS.amountTo, filterAmountTo);
    localStorage.setItem(STORAGE_KEYS.statuses, JSON.stringify(filterStatuses));
    localStorage.setItem(STORAGE_KEYS.originalCurrencyCodes, JSON.stringify(filterOriginalCurrencyCodes));
    localStorage.setItem(STORAGE_KEYS.tagKey, filterTagKey);
    localStorage.setItem(STORAGE_KEYS.tagKeyOp, filterTagKeyOp);
    localStorage.setItem(STORAGE_KEYS.tagKeyValue, filterTagKeyValue);
    localStorage.setItem(STORAGE_KEYS.hasAttachments, filterHasAttachments);
  }, [filterAccountIds, filterCategoryIds, filterPayeeIds, filterTagIds, filterStartDate, filterEndDate, filterSearch, filterTimePeriod, filterAmountFrom, filterAmountTo, filterStatuses, filterOriginalCurrencyCodes, filterTagKey, filterTagKeyOp, filterTagKeyValue, filterHasAttachments, filtersInitialized]);

  // Helper to update array filter and mark as filter change
  const handleArrayFilterChange = useCallback(<T,>(setter: (value: T) => void, value: T) => {
    isFilterChange.current = true;
    setter(value);
  }, []);

  // Helper to update string filter and mark as filter change
  const handleFilterChange = useCallback((setter: (value: string) => void, value: string) => {
    isFilterChange.current = true;
    setter(value);
  }, []);

  // Debounced search handler
  const handleSearchChange = useCallback((value: string) => {
    setSearchInput(value);
    if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
    searchDebounceRef.current = setTimeout(() => {
      isFilterChange.current = true;
      setFilterSearch(value);
    }, 300);
  }, []);

  // Cleanup debounce timers on unmount
  useEffect(() => {
    const searchRef = searchDebounceRef;
    const filterRef = filterDebounceRef;
    return () => {
      if (searchRef.current) clearTimeout(searchRef.current);
      if (filterRef.current) clearTimeout(filterRef.current);
    };
  }, []);

  // Apply a fresh search dispatched from the global header search box.
  // Drops every other filter (including the account-status toggle) so
  // the user lands on a clean Transactions view filtered only by their
  // typed term, with the filter panel collapsed and the chips visible.
  useEffect(() => {
    const handleHeaderSearch = (event: Event) => {
      const detail = (event as CustomEvent<HeaderSearchEventDetail>).detail;
      const term = (detail?.term ?? '').trim();
      if (searchDebounceRef.current) {
        clearTimeout(searchDebounceRef.current);
        searchDebounceRef.current = null;
      }
      isFilterChange.current = true;
      setFilterAccountIds([]);
      setFilterAccountStatus('');
      setFilterCategoryIds([]);
      setFilterPayeeIds([]);
      setFilterTagIds([]);
      setFilterStartDate('');
      setFilterEndDate('');
      setFilterTimePeriod('');
      setFilterAmountFrom('');
      setFilterAmountTo('');
      setFilterStatuses([]);
    setFilterOriginalCurrencyCodes([]);
      setFilterTagKey('');
      setFilterTagKeyOp('hasValue');
      setFilterTagKeyValue('');
      setFilterHasAttachments('');
      setSearchInput(term);
      setFilterSearch(term);
      setCurrentPage(1);
      setFiltersExpanded(false);
    };
    window.addEventListener(HEADER_SEARCH_EVENT, handleHeaderSearch);
    return () => window.removeEventListener(HEADER_SEARCH_EVENT, handleHeaderSearch);
  }, []);

  // Re-sync filter state when browser back/forward is pressed
  useEffect(() => {
    const handlePopstate = () => {
      const params = new URLSearchParams(window.location.search);
      syncingFromPopstateRef.current = true;

      setFilterAccountIds(params.get('accountIds')?.split(',').filter(Boolean) || []);
      setFilterCategoryIds(params.get('categoryIds')?.split(',').filter(Boolean) || []);
      setFilterPayeeIds(params.get('payeeIds')?.split(',').filter(Boolean) || []);
      setFilterTagIds(params.get('tagIds')?.split(',').filter(Boolean) || []);
      setFilterStartDate(params.get('startDate') || '');
      setFilterEndDate(params.get('endDate') || '');
      const search = params.get('search') || '';
      setFilterSearch(search);
      setSearchInput(search);
      setFilterAmountFrom(params.get('amountFrom') || '');
      setFilterAmountTo(params.get('amountTo') || '');
      setFilterStatuses(sanitizeStatuses(params.get('statuses')?.split(',').filter(Boolean) || []));
      setFilterOriginalCurrencyCodes(params.get('originalCurrencyCodes')?.split(',').filter(Boolean) || []);
      setFilterTagKey(params.get('tagKey') || '');
      setFilterTagKeyOp(sanitizeTagKeyOp(params.get('tagKeyOp') || ''));
      setFilterTagKeyValue(params.get('tagKeyValue') || '');
      setFilterHasAttachments(sanitizeHasAttachments(params.get('hasAttachments') || ''));
      const hasDateParams = params.has('startDate') || params.has('endDate');
      setFilterTimePeriod(hasDateParams ? 'custom' : '');
      const pageParam = params.get('page');
      setCurrentPage(pageParam ? parseInt(pageParam, 10) : 1);
    };

    window.addEventListener('popstate', handlePopstate);
    return () => window.removeEventListener('popstate', handlePopstate);
  }, []);

  const handleCategoryClick = useCallback((categoryId: string) => {
    isFilterChange.current = true;
    setFilterAccountIds([]);
    setFilterAccountStatus('');
    setFilterCategoryIds([categoryId]);
  }, []);

  const handleDateFilterClick = useCallback((date: string) => {
    isFilterChange.current = true;
    setFilterStartDate(date);
    setFilterEndDate(date);
    setFilterTimePeriod('custom');
  }, []);

  const handleAccountFilterClick = useCallback((accountId: string) => {
    isFilterChange.current = true;
    setFilterAccountStatus('');
    setFilterAccountIds([accountId]);
  }, []);

  const handlePayeeFilterClick = useCallback((payeeId: string) => {
    isFilterChange.current = true;
    setFilterPayeeIds([payeeId]);
  }, []);

  const handleTagFilterClick = useCallback((tagId: string) => {
    isFilterChange.current = true;
    setFilterTagIds([tagId]);
  }, []);

  const handleTransferClick = useCallback((linkedAccountId: string, _linkedTransactionId: string) => {
    targetTransactionIdRef.current = _linkedTransactionId;
    setFilterAccountStatus('');
    isFilterChange.current = true;
    setFilterAccountIds([linkedAccountId]);
  }, []);

  const clearFilters = useCallback(() => {
    setCurrentPage(1);
    setFilterAccountIds([]);
    setFilterCategoryIds([]);
    setFilterPayeeIds([]);
    setFilterTagIds([]);
    setFilterStartDate('');
    setFilterEndDate('');
    if (searchDebounceRef.current) {
      clearTimeout(searchDebounceRef.current);
      searchDebounceRef.current = null;
    }
    setSearchInput('');
    setFilterSearch('');
    setFilterTimePeriod('');
    setFilterAmountFrom('');
    setFilterAmountTo('');
    setFilterStatuses([]);
    setFilterOriginalCurrencyCodes([]);
    setFilterTagKey('');
    setFilterTagKeyOp('hasValue');
    setFilterTagKeyValue('');
    setFilterHasAttachments('');
    localStorage.removeItem(STORAGE_KEYS.accountIds);
    localStorage.removeItem(STORAGE_KEYS.categoryIds);
    localStorage.removeItem(STORAGE_KEYS.payeeIds);
    localStorage.removeItem(STORAGE_KEYS.tagIds);
    localStorage.removeItem(STORAGE_KEYS.startDate);
    localStorage.removeItem(STORAGE_KEYS.endDate);
    localStorage.removeItem(STORAGE_KEYS.search);
    localStorage.removeItem(STORAGE_KEYS.timePeriod);
    localStorage.removeItem(STORAGE_KEYS.amountFrom);
    localStorage.removeItem(STORAGE_KEYS.amountTo);
    localStorage.removeItem(STORAGE_KEYS.statuses);
    localStorage.removeItem(STORAGE_KEYS.originalCurrencyCodes);
    localStorage.removeItem(STORAGE_KEYS.tagKey);
    localStorage.removeItem(STORAGE_KEYS.tagKeyOp);
    localStorage.removeItem(STORAGE_KEYS.tagKeyValue);
    localStorage.removeItem(STORAGE_KEYS.hasAttachments);
    const basis = new URLSearchParams(window.location.search).get('basis');
    router.replace(basis === 'cash' || basis === 'accrual' ? `/transactions?basis=${basis}` : '/transactions', { scroll: false });
  }, [router]);

  const goToPage = useCallback((page: number) => {
    setCurrentPage(page);
  }, []);

  return {
    // Pagination
    currentPage, setCurrentPage,

    // Filter state
    filterAccountIds, setFilterAccountIds,
    filterAccountStatus, setFilterAccountStatus,
    filterCategoryIds, setFilterCategoryIds,
    filterPayeeIds, setFilterPayeeIds,
    filterStartDate, setFilterStartDate,
    filterEndDate, setFilterEndDate,
    filterSearch, setFilterSearch,
    searchInput,
    filterTimePeriod, setFilterTimePeriod,
    filterAmountFrom, setFilterAmountFrom,
    filterAmountTo, setFilterAmountTo,
    filterTagIds, setFilterTagIds,
    filterStatuses, setFilterStatuses,
    filterOriginalCurrencyCodes, setFilterOriginalCurrencyCodes,
    filterTagKey, setFilterTagKey,
    filterTagKeyOp, setFilterTagKeyOp,
    filterTagKeyValue, setFilterTagKeyValue,
    filterHasAttachments, setFilterHasAttachments,
    filtersInitialized,
    filtersExpanded, setFiltersExpanded,
    activeFilterCount,
    highlightTransactionId, setHighlightTransactionId,

    // Derived filter data
    filteredAccounts,
    selectedAccounts,
    selectedCategories,
    selectedPayees,
    selectedTags,

    // Filter options
    accountFilterOptions,
    categoryFilterOptions,
    payeeFilterOptions,
    tagFilterOptions,
    categoryColorMap,
    categoryIconMap,
    categoryLabelMap,

    // Filter handlers
    handleArrayFilterChange,
    handleFilterChange,
    handleSearchChange,
    handleCategoryClick,
    handleDateFilterClick,
    handleAccountFilterClick,
    handlePayeeFilterClick,
    handleTagFilterClick,
    handleTransferClick,
    clearFilters,
    goToPage,

    // URL sync internals (needed by the page component)
    updateUrl,
    isFilterChange,
    syncingFromPopstateRef,
    filterDebounceRef,
    targetTransactionIdRef,
  };
}
