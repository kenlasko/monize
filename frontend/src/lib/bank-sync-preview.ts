import { duplicateOptions, type DuplicateChoice } from '@/lib/import-duplicates';
import type { BankSyncPreview, BankSyncPreviewOutcome, BankSyncPreviewRow } from '@/types/bank-sync';

/** The filter tabs of the preview: every row, or the rows of one outcome. */
export const PREVIEW_FILTERS = [
  'all',
  'new',
  'possible_duplicate',
  'duplicate',
  'excluded',
  'refused',
  'pending',
  'before_cutoff',
] as const;
export type PreviewFilter = (typeof PREVIEW_FILTERS)[number];

/** How many rows each tab holds, counted from the rows themselves. */
export function previewFilterCounts(rows: readonly BankSyncPreviewRow[]): Record<PreviewFilter, number> {
  const counts: Record<PreviewFilter, number> = {
    all: rows.length,
    new: 0,
    possible_duplicate: 0,
    duplicate: 0,
    excluded: 0,
    refused: 0,
    pending: 0,
    before_cutoff: 0,
  };
  for (const row of rows) counts[row.outcome] += 1;
  return counts;
}

/** The rows a tab shows, in the order the bank listed them. */
export function filterPreviewRows(
  rows: readonly BankSyncPreviewRow[],
  filter: PreviewFilter,
): BankSyncPreviewRow[] {
  return filter === 'all' ? [...rows] : rows.filter((row) => row.outcome === filter);
}

/** The pill colour of each outcome; the label is the catalog's. */
export const OUTCOME_VARIANTS: Record<
  BankSyncPreviewOutcome,
  'green' | 'gray' | 'red' | 'amber' | 'blue' | 'purple'
> = {
  new: 'green',
  possible_duplicate: 'amber',
  duplicate: 'gray',
  excluded: 'purple',
  refused: 'red',
  pending: 'amber',
  before_cutoff: 'blue',
};

/** A decimal string from the API as a number, or null when there is none or it is unreadable. */
export function previewAmount(value: string | null | undefined): number | null {
  if (value === null || value === undefined || value.trim() === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * The tab to show first: the possible duplicates when there are any, since
 * they wait for a decision; else the rows the import would write; else every
 * row, so a preview of nothing new does not open on an empty tab.
 */
export function initialPreviewFilter(preview: Pick<BankSyncPreview, 'summary'>): PreviewFilter {
  if ((preview.summary.possibleDuplicate ?? 0) > 0) return 'possible_duplicate';
  return preview.summary.new > 0 ? 'new' : 'all';
}

/**
 * The possible duplicates of a preview with the choices each offers: the
 * actions the server allows for its pair, plus leaving it for later (the
 * default) and adding it to the exceptions.
 */
export function duplicateRowsOf(
  rows: readonly BankSyncPreviewRow[],
): { key: string; options: DuplicateChoice[] }[] {
  return rows.flatMap((row) =>
    row.outcome === 'possible_duplicate' && row.externalKey !== null
      ? [{ key: row.externalKey, options: duplicateOptions(row.duplicateActions ?? [], ['later', 'except']) }]
      : [],
  );
}

/** The keys of the rows a selection can name: the new rows, which are the only ones the server accepts. */
export function selectableKeys(rows: readonly BankSyncPreviewRow[]): string[] {
  return rows.flatMap((row) => (row.outcome === 'new' && row.externalKey !== null ? [row.externalKey] : []));
}

/** The keys of the rows that are exceptions, which "Remove from exceptions" can take back. */
export function exceptionKeys(rows: readonly BankSyncPreviewRow[]): string[] {
  return rows.flatMap((row) => (row.outcome === 'excluded' && row.externalKey !== null ? [row.externalKey] : []));
}
