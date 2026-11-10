'use client';

import { useTranslations } from 'next-intl';
import type { ImportFileData } from '@/app/import/import-utils';

/** How many unreadable rows a file lists before it counts the rest. */
const SHOWN_ROWS = 5;

interface UnreadableAmountsNoticeProps {
  importFiles: ImportFileData[];
  /** Name each file above its rows, for a bulk import. */
  showFileNames: boolean;
}

/**
 * The CSV rows the import will leave out because their amount (or debit or
 * credit) field holds text that cannot be read as an amount, by line and raw
 * text, before anything is written: such a row is never imported at 0.
 */
export function UnreadableAmountsNotice({ importFiles, showFileNames }: UnreadableAmountsNoticeProps) {
  const t = useTranslations('import');
  const files = importFiles.filter((f) => (f.parsedData?.unreadableAmounts?.count ?? 0) > 0);
  if (files.length === 0) return null;

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
                  {t('review.unreadableAmountRow', { line: row.rowNumber, rawAmount: row.rawAmount })}
                </li>
              ))}
              {more > 0 && <li>{t('review.unreadableAmountsMore', { count: more })}</li>}
            </ul>
          </div>
        );
      })}
      <p>{t('review.unreadableAmountsGoBack')}</p>
    </div>
  );
}
