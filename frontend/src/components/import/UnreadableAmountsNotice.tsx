'use client';

import { useTranslations } from 'next-intl';
import type { ImportFileType } from '@/app/import/import-utils';
import type { CsvUnreadableAmounts } from '@/lib/import';

/** How many unreadable rows a file lists before it counts the rest. */
const SHOWN_ROWS = 5;

/** The part of a file the notice reads; `ImportFileData` fits it. */
interface UnreadableAmountsFile {
  fileName: string;
  fileType: ImportFileType;
  parsedData: { unreadableAmounts?: CsvUnreadableAmounts };
}

interface UnreadableAmountsNoticeProps {
  importFiles: UnreadableAmountsFile[];
  /** Name each file above its rows, for a bulk import. */
  showFileNames: boolean;
}

/**
 * The rows the import will leave out because their amount holds text that
 * cannot be read as an amount, by position and raw text, before anything is
 * written: such a row is never imported at 0. A CSV row is named by row and
 * advised on its column mapping; a QIF record by its line and an OFX
 * transaction by its position, with advice that fits a file with no mapping.
 */
export function UnreadableAmountsNotice({ importFiles, showFileNames }: UnreadableAmountsNoticeProps) {
  const t = useTranslations('import');
  const files = importFiles.filter((f) => (f.parsedData?.unreadableAmounts?.count ?? 0) > 0);
  if (files.length === 0) return null;
  const rowKey = (type: ImportFileType) =>
    type === 'qif' ? 'review.unreadableAmountLine' : type === 'ofx' ? 'review.unreadableAmountTransaction' : 'review.unreadableAmountRow';
  const hasCsv = files.some((f) => f.fileType === 'csv');

  return (
    <div className="rounded-lg p-4 bg-amber-50 dark:bg-amber-900/20 text-sm text-amber-800 dark:text-amber-300 space-y-2">
      {files.map((file) => {
        const { count, rows } = file.parsedData.unreadableAmounts!;
        const shown = rows.slice(0, SHOWN_ROWS);
        const more = count - shown.length;
        return (
          <div key={file.fileName}>
            {showFileNames && <p className="font-medium">{file.fileName}</p>}
            <p>{t('review.unreadableAmountsNotice', { count })}</p>
            <ul className="ml-4 list-disc">
              {shown.map((row) => (
                <li key={row.rowNumber}>
                  {t(rowKey(file.fileType), { line: row.rowNumber, rawAmount: row.rawAmount })}
                </li>
              ))}
              {more > 0 && <li>{t('review.unreadableAmountsMore', { count: more })}</li>}
            </ul>
          </div>
        );
      })}
      <p>{t(hasCsv ? 'review.unreadableAmountsGoBack' : 'review.unreadableAmountsFileGoBack')}</p>
    </div>
  );
}
