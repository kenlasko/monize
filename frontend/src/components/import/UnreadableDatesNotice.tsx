'use client';

import { useTranslations } from 'next-intl';
import type { ImportFileType } from '@/app/import/import-utils';
import type { CsvUnreadableDates } from '@/lib/import';

/** How many unreadable rows a file lists before it counts the rest. */
const SHOWN_ROWS = 5;

/** The part of a file the notice reads; `ImportFileData` fits it. */
interface UnreadableDatesFile {
  fileName: string;
  fileType: ImportFileType;
  parsedData: { unreadableDates?: CsvUnreadableDates; detectedDateFormat: string };
}

interface UnreadableDatesNoticeProps {
  importFiles: UnreadableDatesFile[];
  /** Name each file above its rows, for a bulk import. */
  showFileNames: boolean;
}

/**
 * The rows the import will leave out because their date cannot be read, by
 * position and raw text, before anything is written. A CSV row is read under
 * the chosen date format: a day above 12 under the wrong day/month order is how
 * a statement loses rows while the rest import on swapped dates. A QIF record
 * is named by its line and an OFX transaction by its position, with advice
 * that fits a file with no mapping.
 */
export function UnreadableDatesNotice({ importFiles, showFileNames }: UnreadableDatesNoticeProps) {
  const t = useTranslations('import');
  const files = importFiles.filter((f) => (f.parsedData?.unreadableDates?.count ?? 0) > 0);
  if (files.length === 0) return null;
  const hasCsv = files.some((f) => f.fileType === 'csv');
  const hasOther = files.some((f) => f.fileType !== 'csv');

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
              {file.fileType === 'csv'
                ? t('review.unreadableDatesNotice', {
                    count,
                    format: file.parsedData.detectedDateFormat,
                  })
                : t('review.unreadableDatesFileNotice', { count })}
            </p>
            <ul className="ml-4 list-disc">
              {shown.map((row) => (
                <li key={row.rowNumber}>
                  {file.fileType === 'csv'
                    ? row.rawDate
                      ? t('review.unreadableDateRow', { line: row.rowNumber, rawDate: row.rawDate })
                      : t('review.missingDateRow', { line: row.rowNumber })
                    : row.rawDate
                      ? t('review.unreadableDateFileRow', {
                          kind: file.fileType,
                          line: row.rowNumber,
                          rawDate: row.rawDate,
                        })
                      : t('review.missingDateFileRow', { kind: file.fileType, line: row.rowNumber })}
                </li>
              ))}
              {more > 0 && <li>{t('review.unreadableDatesMore', { count: more })}</li>}
            </ul>
          </div>
        );
      })}
      {hasCsv && <p>{t('review.unreadableDatesGoBack')}</p>}
      {hasOther && <p>{t('review.unreadableDatesFileGoBack')}</p>}
    </div>
  );
}
