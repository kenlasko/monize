/**
 * What the Quick Add fill steps (`quick-add-fill.util.ts`) share: their
 * inputs, the field constructor and the ranking every list of candidates is
 * put in.
 */
import { TRANSACTION_PAYEE_NAME_MAX_LENGTH } from "../dto/create-transaction.dto";
import type { QuickAddReading } from "./quick-add-parse.util";
import {
  QuickAddAccountRef,
  QuickAddCandidateAccount,
  QuickAddCandidateCategory,
  QuickAddCandidatePayee,
  QuickAddCategoryRef,
  QuickAddField,
  QuickAddKind,
  QuickAddPayeeRef,
  QuickAddSource,
} from "./quick-add.types";

/** How many alternatives a field offers. */
export const QUICK_ADD_MAX_ALTERNATIVES = 5;
/** A leftover payee name is cut, at a word, to what a transaction create accepts. */
export const QUICK_ADD_PAYEE_NAME_MAX_LENGTH =
  TRANSACTION_PAYEE_NAME_MAX_LENGTH;

/** Fields the reader set by hand, with blanks already read as absent. */
export interface QuickAddPins {
  readonly kind?: QuickAddKind;
  readonly amount?: number;
  readonly date?: string;
  readonly account?: QuickAddCandidateAccount;
  readonly toAccount?: QuickAddCandidateAccount;
  /** An owned payee, active or not. */
  readonly payee?: QuickAddCandidatePayee;
  readonly payeeName?: string;
  readonly category?: QuickAddCandidateCategory;
  /** The reader cleared the payee: none, and never guessed again. */
  readonly clearPayee?: boolean;
  /** The reader cleared the category: none, and never guessed again. */
  readonly clearCategory?: boolean;
}

/** Transaction counts per id, for "the most used". */
export type QuickAddUsage = ReadonlyMap<string, number>;

/** A payee's recent history, newest first. */
export interface QuickAddPayeeHistory {
  /** Its last 10 non-void, non-transfer rows. */
  readonly recent: ReadonlyArray<{ accountId: string; amount: number }>;
  /** The categories of its last 10 non-void, unsplit, non-transfer rows. */
  readonly categoryIds: ReadonlyArray<string | null>;
}

export const EMPTY_PAYEE_HISTORY: QuickAddPayeeHistory = {
  recent: [],
  categoryIds: [],
};

export interface QuickAddPayeeResolution {
  readonly field: QuickAddField<QuickAddPayeeRef>;
  /** The existing payee the entry names, whose history fills the rest. */
  readonly payee: QuickAddCandidatePayee | null;
  readonly memo: string | null;
}

export interface QuickAddFillInput {
  readonly reading: QuickAddReading;
  readonly pins: QuickAddPins;
  readonly payee: QuickAddPayeeResolution;
  readonly today: string;
  readonly accounts: ReadonlyMap<string, QuickAddCandidateAccount>;
  readonly categories: ReadonlyMap<string, QuickAddCandidateCategory>;
  /** The register's account, already checked to be eligible. */
  readonly contextAccountId: string | null;
  readonly history: QuickAddPayeeHistory;
  /** The account of the reader's most recently created transaction. */
  readonly mostRecentAccountId: string | null;
  readonly accountUsage: QuickAddUsage;
  readonly categoryUsage: QuickAddUsage;
  /** `currencies.decimal_places` by code. */
  readonly currencyPlaces: ReadonlyMap<string, number>;
  /** The predicate `TransactionsService.create` decides the balance with. */
  readonly isFuture: (date: string) => boolean;
}

export function field<T>(
  value: T | null,
  source: QuickAddSource,
  alternatives: readonly T[] = [],
  ambiguous = false,
): QuickAddField<T> {
  return {
    value,
    source: value === null ? "none" : source,
    ambiguous,
    alternatives: alternatives.slice(0, QUICK_ADD_MAX_ALTERNATIVES),
  };
}

/** A field the reader cleared by hand: answered as none, as a pin. */
export function clearedField<T>(): QuickAddField<T> {
  return { value: null, source: "pinned", ambiguous: false, alternatives: [] };
}

/** Most used first, then by name, then by id, so the order is stable. */
export function rankByUsage<T extends { id: string; name: string }>(
  items: readonly T[],
  usage: QuickAddUsage,
): T[] {
  return [...items].sort(
    (a, b) =>
      (usage.get(b.id) ?? 0) - (usage.get(a.id) ?? 0) ||
      a.name.localeCompare(b.name) ||
      a.id.localeCompare(b.id),
  );
}

/**
 * The ids of a newest-first history, most frequent first, the most recent
 * winning a tie on frequency. Ids `keep` refuses (and nulls) are not counted.
 */
export function rankByRecentFrequency(
  ids: ReadonlyArray<string | null>,
  keep: (id: string) => boolean,
): string[] {
  const counts = new Map<string, { count: number; newest: number }>();
  for (const [index, id] of ids.entries()) {
    if (!id || !keep(id)) continue;
    const seen = counts.get(id);
    counts.set(id, {
      count: (seen?.count ?? 0) + 1,
      newest: seen?.newest ?? index,
    });
  }
  return [...counts.entries()]
    .sort((a, b) => b[1].count - a[1].count || a[1].newest - b[1].newest)
    .map(([id]) => id);
}

export function withoutIds<T extends { id: string | null }>(
  items: readonly T[],
  ids: ReadonlyArray<string | null | undefined>,
): T[] {
  const seen = new Set<string | null | undefined>(ids);
  return items.filter((item) => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
}

export const accountRef = (
  a: QuickAddCandidateAccount,
): QuickAddAccountRef => ({
  id: a.id,
  name: a.name,
  currencyCode: a.currencyCode,
});
export const payeeRef = (p: QuickAddCandidatePayee): QuickAddPayeeRef => ({
  id: p.id,
  name: p.name,
});
export const categoryRef = (
  c: QuickAddCandidateCategory,
): QuickAddCategoryRef => ({
  id: c.id,
  name: c.path,
});
