'use client';

import { useTranslations } from 'next-intl';
import { useDateFormat } from '@/hooks/useDateFormat';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import type { ImportSkippedRow, ImportSkipReason } from '@/lib/import';

/** How many rows the list shows before it counts the rest. */
const DEFAULT_LIMIT = 50;

const REASON_KEYS = {
  alreadyImported: 'complete.skipReasonAlreadyImported',
  duplicateTransfer: 'complete.skipReasonDuplicateTransfer',
  unreadableDate: 'complete.skipReasonUnreadableDate',
  missingSecurity: 'complete.skipReasonMissingSecurity',
  missingQuantity: 'complete.skipReasonMissingQuantity',
  missingAmount: 'complete.skipReasonMissingAmount',
  missingProceeds: 'complete.skipReasonMissingProceeds',
  missingSplitRatio: 'complete.skipReasonMissingSplitRatio',
} as const satisfies Record<ImportSkipReason, string>;

interface SkippedRowsListProps {
  rows: ImportSkippedRow[] | undefined;
  /** Show at most this many rows, then how many more there are. */
  limit?: number;
  /**
   * How many rows the import skipped in all (`skipped`). The server names only
   * the first of them, so the count of the rest comes from here.
   */
  total?: number;
}

/**
 * The rows an import left out, each with its date (or, for a date the import
 * could not read, its line and raw text; for an investment row the parse
 * rejected, its line and date), amount, payee and why, so a person can check
 * them against the file.
 */
export function SkippedRowsList({ rows, limit = DEFAULT_LIMIT, total }: SkippedRowsListProps) {
  const t = useTranslations('import');
  const { formatDate } = useDateFormat();
  const { formatCurrency } = useNumberFormat();

  if (!rows || rows.length === 0) return null;
  const shown = rows.slice(0, limit);
  const more = Math.max(total ?? rows.length, rows.length) - shown.length;

  // A row whose date could not be read has no date to format: it is named by
  // its line in the file and the text the file gave. Any other row the parse
  // left out (an investment row missing data) has both its line and its date.
  const describeDate = (row: ImportSkippedRow) => {
    if (row.reason !== 'unreadableDate') {
      return row.rowNumber !== undefined
        ? t('complete.skippedRowLineAt', { line: row.rowNumber, date: formatDate(row.date) })
        : formatDate(row.date);
    }
    return row.rawDate
      ? t('complete.skippedRowLineDate', { line: row.rowNumber ?? '', rawDate: row.rawDate })
      : t('complete.skippedRowLine', { line: row.rowNumber ?? '' });
  };
  const describeReason = (row: ImportSkippedRow) =>
    row.reason === 'unreadableDate' && !row.rawDate
      ? t('complete.skipReasonNoDate')
      : t(REASON_KEYS[row.reason]);

  const describe = (row: ImportSkippedRow) => {
    const values = {
      date: describeDate(row),
      amount: formatCurrency(row.amount, row.currencyCode),
      reason: describeReason(row),
    };
    return row.payee
      ? t('complete.skippedRow', { ...values, payee: row.payee })
      : t('complete.skippedRowNoPayee', values);
  };

  return (
    <div className="mt-2">
      <p className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
        {t('complete.skippedRowsHeading')}
      </p>
      <ul className="text-xs text-gray-600 dark:text-gray-400 space-y-1 max-h-32 overflow-y-auto">
        {shown.map((row, i) => (
          <li key={i}>{describe(row)}</li>
        ))}
        {more > 0 && <li>{t('complete.andMoreSkipped', { count: more })}</li>}
      </ul>
    </div>
  );
}
