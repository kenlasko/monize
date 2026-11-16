'use client';

import { useTranslations } from 'next-intl';
import { ImportPreviewDuplicatePanel } from '@/components/import-preview/ImportPreviewDuplicatePanel';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { LinkifiedText } from '@/components/ui/LinkifiedText';
import { useDateFormat } from '@/hooks/useDateFormat';
import { useDuplicateChoices } from '@/hooks/useDuplicateChoices';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { gainLossColor } from '@/lib/format';
import type { ImportDuplicateDecision } from '@/lib/import';
import { duplicateChoiceOf, duplicateOptions } from '@/lib/import-duplicates';
import type { ImportDuplicateReviewFile } from '@/app/import/import-utils';
import type { ImportDuplicateAction } from '@/types/import-preview';

/** The key a row's decision is kept under: its file and its position in it. */
const keyOf = (fileIndex: number, row: number) => `${fileIndex}:${row}`;

/**
 * The decisions of the duplicates step, per file index: every listed pair gets
 * one, `keep` unless the person chose otherwise.
 */
export function duplicateDecisionsFor(
  review: readonly ImportDuplicateReviewFile[],
  choiceOf: (key: string, options: readonly ImportDuplicateAction[]) => ImportDuplicateAction,
): Map<number, ImportDuplicateDecision[]> {
  return new Map(
    review.map((file) => [
      file.fileIndex,
      file.rows.map((row) => ({
        row: row.row,
        transactionId: row.existingTransaction.id,
        action: choiceOf(keyOf(file.fileIndex, row.row), row.duplicateActions),
      })),
    ]),
  );
}

interface DuplicatesStepProps {
  review: readonly ImportDuplicateReviewFile[];
  isLoading: boolean;
  onBack: () => void;
  onImport: (decisions: Map<number, ImportDuplicateDecision[]>) => void;
}

/**
 * The rows of the file that look like transactions already in the account,
 * listed immediately before the import (docs/specs/import-duplicate-review.md
 * section 5). Each shows the file's row beside the transaction it looks like
 * and what to do with it; every one is "Keep mine" until changed, so nothing
 * the person did not choose is written twice.
 */
export function DuplicatesStep({ review, isLoading, onBack, onImport }: DuplicatesStepProps) {
  const t = useTranslations('import.duplicates');
  // The same labels the existing transaction's side uses.
  const tFact = useTranslations('import.preview.duplicate');
  const { formatDate } = useDateFormat();
  const { formatCurrency } = useNumberFormat();
  const { choices, setChoice } = useDuplicateChoices();

  const choiceOf = (key: string, options: readonly ImportDuplicateAction[]): ImportDuplicateAction =>
    duplicateChoiceOf(choices, key, 'keep', options) as ImportDuplicateAction;
  const total = review.reduce((sum, file) => sum + file.rows.length, 0);

  return (
    <div className="mx-auto max-w-3xl">
      <Card padding="md">
        <h2 className="mb-2 text-xl font-semibold text-gray-900 dark:text-gray-100">
          {t('heading', { count: total })}
        </h2>
        <p className="mb-4 text-sm text-gray-600 dark:text-gray-300">{t('intro')}</p>
        <div className="space-y-6">
          {review.map((file) => (
            <section key={file.fileIndex} aria-label={t('fileHeading', { file: file.fileName, account: file.accountName })}>
              {review.length > 1 && (
                <h3 className="mb-2 font-medium text-gray-900 dark:text-gray-100">
                  {t('fileHeading', { file: file.fileName, account: file.accountName })}
                </h3>
              )}
              <ul className="space-y-4">
                {file.rows.map((row) => {
                  const key = keyOf(file.fileIndex, row.row);
                  const options = duplicateOptions(row.duplicateActions);
                  const label = row.payee ?? t('noPayee');
                  return (
                    <li key={key} className="space-y-2">
                      <div className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
                        <span className="min-w-0">
                          <span className="text-gray-500 dark:text-gray-400">
                            {t('fromFile', { date: formatDate(row.transactionDate) })}
                          </span>{' '}
                          <span className="font-medium text-gray-900 dark:text-gray-100">{label}</span>
                          {row.memo && (
                            <span className="block truncate text-xs text-gray-500 dark:text-gray-400" title={row.memo}>
                              <LinkifiedText text={row.memo} />
                            </span>
                          )}
                          {row.referenceNumber && (
                            <span className="block truncate text-xs text-gray-500 dark:text-gray-400">
                              {tFact('reference')}{' '}
                              <span className="text-gray-700 dark:text-gray-300">{row.referenceNumber}</span>
                            </span>
                          )}
                        </span>
                        <span className={`whitespace-nowrap font-medium tabular-nums ${gainLossColor(row.amount)}`}>
                          {formatCurrency(row.amount, file.currencyCode)}
                        </span>
                      </div>
                      <ImportPreviewDuplicatePanel
                        rowId={key}
                        rowLabel={label}
                        existing={row.existingTransaction}
                        currencyCode={file.currencyCode}
                        options={options}
                        choice={choiceOf(key, row.duplicateActions)}
                        onChange={(choice) => setChoice(key, choice)}
                        disabled={isLoading}
                      />
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
        </div>
        <div className="mt-6 flex justify-between">
          <Button variant="outline" onClick={onBack} disabled={isLoading}>
            {t('back')}
          </Button>
          <Button onClick={() => onImport(duplicateDecisionsFor(review, choiceOf))} isLoading={isLoading}>
            {t('import')}
          </Button>
        </div>
      </Card>
    </div>
  );
}
