import type {
  BankSyncConnectionEntry,
  BankSyncFailure,
  BankSyncResult,
} from '@/types/bank-sync';

/** True for the entry of an account that could not be synced. */
export function isBankSyncFailure(entry: BankSyncConnectionEntry): entry is BankSyncFailure {
  return 'error' in entry && typeof entry.error === 'object' && entry.error !== null;
}

/**
 * The code of an account a sync of the whole connection skipped because its
 * first import has not been confirmed from the preview (spec section 7a). It is
 * not a failure of the account: nothing was read, nothing was recorded, and the
 * way forward is the preview, which the toast names in its own sentence.
 */
export const BANK_SYNC_NEEDS_PREVIEW_CODE = 'needs_preview';

/** True for the failure entry of an account that was skipped until its preview is confirmed. */
export function isNeedsPreviewFailure(failure: BankSyncFailure): boolean {
  return failure.error.code === BANK_SYNC_NEEDS_PREVIEW_CODE;
}

/** The entries that are results: the accounts that did sync. */
export function syncedResults(entries: readonly BankSyncConnectionEntry[]): BankSyncResult[] {
  return entries.filter((entry): entry is BankSyncResult => !isBankSyncFailure(entry));
}

/** What one or more syncs did, added up. */
export interface BankSyncTotals {
  imported: number;
  skipped: number;
  refused: Record<string, number>;
}

/** The refusal reasons the catalog has a sentence for. */
export const KNOWN_REFUSAL_REASONS = [
  'missing_date',
  'future_date',
  'invalid_amount',
  'unknown_direction',
  'currency_mismatch',
] as const;

/**
 * Add the results of every account a sync touched.
 *
 * Whole counts, so plain addition is exact. A reason nobody has written a
 * sentence for is kept under its own name and rendered as `other` at the edge,
 * never dropped: a refusal the reader is not told about is a row missing from
 * their ledger with no explanation.
 */
export function totalSyncResults(
  results: readonly Pick<BankSyncResult, 'imported' | 'skipped' | 'refused'>[],
): BankSyncTotals {
  const totals: BankSyncTotals = { imported: 0, skipped: 0, refused: {} };
  for (const result of results) {
    totals.imported += result.imported;
    totals.skipped += result.skipped;
    for (const [reason, count] of Object.entries(result.refused)) {
      totals.refused[reason] = (totals.refused[reason] ?? 0) + count;
    }
  }
  return totals;
}

/** Every refused row, whatever its reason. */
export function totalRefused(refused: Record<string, number>): number {
  return Object.values(refused).reduce((sum, count) => sum + count, 0);
}

/**
 * The refusal reasons grouped for display: each known reason under its own key,
 * everything else folded into `other`, zero counts left out.
 */
export function groupRefusalReasons(
  refused: Record<string, number>,
): { reason: (typeof KNOWN_REFUSAL_REASONS)[number] | 'other'; count: number }[] {
  const known = new Set<string>(KNOWN_REFUSAL_REASONS);
  const grouped = new Map<string, number>();
  for (const [reason, count] of Object.entries(refused)) {
    if (count <= 0) continue;
    const key = known.has(reason) ? reason : 'other';
    grouped.set(key, (grouped.get(key) ?? 0) + count);
  }
  return [...grouped.entries()].map(([reason, count]) => ({
    reason: reason as (typeof KNOWN_REFUSAL_REASONS)[number] | 'other',
    count,
  }));
}
