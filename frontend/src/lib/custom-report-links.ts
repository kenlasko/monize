import { addDays, endOfMonth, format, parseISO } from 'date-fns';
import { isSpecialCategoryFilterId } from '@/lib/categoryUtils';
import { buildTransactionsHref } from '@/lib/transactions-href';
import { isUuid } from '@/lib/uuid';
import {
  GroupByType,
  type FilterField,
  type ReportFilters,
  type ReportResult,
} from '@/types/custom-report';

/** The register filters a custom report's own filters translate into. */
export interface ReportRegisterFilters {
  accountIds: string[];
  categoryIds: string[];
  payeeIds: string[];
  tagIds: string[];
  search: string;
}

const valuesOf = (value: string | string[]): string[] =>
  (Array.isArray(value) ? value : [value]).filter((v) => typeof v === 'string' && v.length > 0);

/**
 * A custom report's filters as the Transactions register can apply them, read
 * the way `getFilteredTransactions` (backend/src/reports/reports.service.ts)
 * reads them: advanced filter groups win over the legacy fields when any are
 * present, and the legacy `tagIds` filter nothing there, so they filter
 * nothing here either.
 *
 * The register ANDs one list per field and ORs within it, so only a group
 * whose conditions all name the same field can be carried over. A group that
 * ORs two fields, a field two groups constrain, and a group of several text
 * conditions cannot be expressed and are left out: the register then lists
 * more than the report, never less, so a row the report showed is still there.
 */
export function reportRegisterFilters(filters: ReportFilters | null | undefined): ReportRegisterFilters {
  const groups = (filters?.filterGroups ?? []).filter((g) => (g.conditions ?? []).length > 0);
  if (groups.length === 0) {
    return {
      accountIds: [...(filters?.accountIds ?? [])],
      categoryIds: [...(filters?.categoryIds ?? [])],
      payeeIds: [...(filters?.payeeIds ?? [])],
      tagIds: [],
      search: filters?.searchText ?? '',
    };
  }

  // How many groups constrain each field, and what a single-field group asks.
  const constrained = new Map<FilterField, number>();
  const asked = new Map<FilterField, string[]>();
  for (const group of groups) {
    const fields = new Set(group.conditions.map((c) => c.field));
    for (const field of fields) constrained.set(field, (constrained.get(field) ?? 0) + 1);
    if (fields.size !== 1) continue;
    const [field] = fields;
    if (field === 'text' && group.conditions.length !== 1) continue;
    const values = [...new Set(group.conditions.flatMap((c) => valuesOf(c.value)))];
    if (values.length > 0) asked.set(field, values);
  }
  const carried = (field: FilterField): string[] =>
    constrained.get(field) === 1 ? (asked.get(field) ?? []) : [];

  return {
    accountIds: carried('account'),
    categoryIds: carried('category'),
    payeeIds: carried('payee'),
    tagIds: carried('tag'),
    search: carried('text')[0] ?? '',
  };
}

/**
 * The dates a time-grouped cell covers, from the key `aggregateByTime`
 * (backend/src/reports/reports.service.ts) gives it: `yyyy`, `yyyy-MM`, or the
 * `yyyy-MM-dd` of a day or of a week's first day (date-fns' default, Sunday).
 */
function timeBucketRange(groupBy: string, key: string): { start: string; end: string } | null {
  const ymd = (d: Date) => format(d, 'yyyy-MM-dd');
  switch (groupBy) {
    case GroupByType.YEAR:
      return /^\d{4}$/.test(key) ? { start: `${key}-01-01`, end: `${key}-12-31` } : null;
    case GroupByType.MONTH:
      return /^\d{4}-\d{2}$/.test(key)
        ? { start: `${key}-01`, end: ymd(endOfMonth(parseISO(`${key}-01`))) }
        : null;
    case GroupByType.WEEK:
      return /^\d{4}-\d{2}-\d{2}$/.test(key) ? { start: key, end: ymd(addDays(parseISO(key), 6)) } : null;
    case GroupByType.DAY:
      return /^\d{4}-\d{2}-\d{2}$/.test(key) ? { start: key, end: key } : null;
    default:
      return null;
  }
}

/**
 * Where clicking a custom report's row, bar, slice or legend entry goes: the
 * Transactions register over the report's dates and its own filters, narrowed
 * to what was clicked. A listed transaction is opened on the page that holds
 * it and flashed; a category, payee or tag replaces the report's filter on
 * that field; a period narrows the dates to the period's, inside the report's.
 * A group the register cannot filter on (no payee, untagged) keeps the
 * report's filters alone.
 */
export function customReportDrillDownHref(
  filters: ReportFilters | null | undefined,
  result: Pick<ReportResult, 'groupBy' | 'timeframe'>,
  id: string,
): string {
  const register = reportRegisterFilters(filters);
  const { groupBy, timeframe } = result;
  const bucket = timeBucketRange(groupBy, id);
  // A period's dates, kept inside the report's: the first and last periods
  // usually start and end part-way through.
  const startDate =
    bucket && (!timeframe.startDate || timeframe.startDate < bucket.start) ? bucket.start : timeframe.startDate;
  const endDate = bucket && (!timeframe.endDate || timeframe.endDate > bucket.end) ? bucket.end : timeframe.endDate;
  const clicked = (by: GroupByType, valid: boolean, own: string[]): string[] =>
    groupBy === by && valid ? [id] : own;
  const categoryIds = clicked(
    GroupByType.CATEGORY,
    isUuid(id) || isSpecialCategoryFilterId(id),
    register.categoryIds,
  );
  const payeeIds = clicked(GroupByType.PAYEE, isUuid(id), register.payeeIds);
  const tagIds = clicked(GroupByType.TAG, isUuid(id), register.tagIds);
  // An ungrouped list's rows carry the transaction id; its one aggregate cell
  // carries `total`.
  const targetTransactionId = groupBy === GroupByType.NONE && isUuid(id) ? id : undefined;

  return buildTransactionsHref({
    accountIds: register.accountIds,
    // A named account may be closed; the stored Show Accounts toggle would
    // otherwise prune it from the filter (the Institutions-page precedent).
    accountStatus: register.accountIds.length > 0 ? 'all' : undefined,
    categoryIds,
    payeeIds,
    tagIds,
    search: register.search || undefined,
    startDate: startDate || undefined,
    endDate: endDate || undefined,
    targetTransactionId,
  });
}
