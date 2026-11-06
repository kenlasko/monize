'use client';

import { useTranslations } from 'next-intl';
import type { ImportFileData } from '@/app/import/import-utils';

/** How many unreadable rows a file lists before it counts the rest. */
const SHOWN_ROWS = 5;

interface UnreadableDatesNoticeProps {
  importFiles: ImportFileData[];
  /** Name each file above its rows, for a bulk import. */
  showFileNames: boolean;
}

/**
 * The CSV rows the import will leave out because their date cannot be read
 * under the chosen date format, by line and raw text, before anything is
 * written: a day above 12 under the wrong day/month order is how a statement
 * loses rows while the rest import on swapped dates.
 */
export function UnreadableDatesNotice({ importFiles, showFileNames }: UnreadableDatesNoticeProps) {
  const t = useTranslations('import');
  const files = importFiles.filter((f) => (f.parsedData?.unreadableDates?.count ?? 0) > 0);
  if (files.length === 0) return null;

  return (
    <div className="rounded-lg p-4 bg-amber-50 dark:bg-amber-900/20 text-sm text-amber-800 dark:text-amber-300 space-y-2">
      {files.map((file) => {
        const { count, rows } = file.parsedData.unreadableDates!;
        const shown = rows.slice(0, SHOWN_ROWS);
        const more = count - shown.length;
        return (
          <div key={file.fileName}>
            {showFileNames && <p className="font-medium">{file.fileName}</p>}
            <p>
              {t('review.unreadableDatesNotice', {
                count,
                format: file.parsedData.detectedDateFormat,
              })}
            </p>
            <ul className="ml-4 list-disc">
              {shown.map((row) => (
                <li key={row.rowNumber}>
                  {row.rawDate
                    ? t('review.unreadableDateRow', { line: row.rowNumber, rawDate: row.rawDate })
                    : t('review.missingDateRow', { line: row.rowNumber })}
                </li>
              ))}
              {more > 0 && <li>{t('review.unreadableDatesMore', { count: more })}</li>}
            </ul>
          </div>
        );
      })}
      <p>{t('review.unreadableDatesGoBack')}</p>
    </div>
  );
}
