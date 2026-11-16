'use client';

import { useTranslations } from 'next-intl';
import type { ReactNode } from 'react';
import { IMPORT_PREVIEW_HEADING_CLASS } from '@/components/import-preview/ImportPreviewPayeeMapping';
import { LinkifiedText } from '@/components/ui/LinkifiedText';
import { useDateFormat } from '@/hooks/useDateFormat';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { previewAmount } from '@/lib/bank-sync-preview';
import type { DuplicateChoice } from '@/lib/import-duplicates';
import type { ImportDuplicateExisting } from '@/types/import-preview';

interface ImportPreviewDuplicatePanelProps {
  /** Makes the radio group's name unique to its row. */
  rowId: string;
  /** What the incoming row is called, for the group's legend. */
  rowLabel: string;
  existing: ImportDuplicateExisting;
  /** The account's currency: the existing transaction's amount is in it. */
  currencyCode: string;
  /** The choices the row offers, in order (`duplicateOptions`). */
  options: readonly DuplicateChoice[];
  choice: DuplicateChoice;
  onChange: (choice: DuplicateChoice) => void;
  disabled?: boolean;
}

/**
 * A possible duplicate of an import (docs/specs/import-duplicate-review.md
 * section 3): the transaction already in the account that the incoming row
 * looks like, beside the decision about it. Shared by every source; the row
 * itself is the source's to draw. The choices are radios in one group, so the
 * decision works by keyboard and is announced as one choice.
 */
export function ImportPreviewDuplicatePanel({
  rowId,
  rowLabel,
  existing,
  currencyCode,
  options,
  choice,
  onChange,
  disabled = false,
}: ImportPreviewDuplicatePanelProps) {
  const t = useTranslations('import.preview.duplicate');
  const { formatDate } = useDateFormat();
  const { formatCurrency } = useNumberFormat();
  const amount = previewAmount(existing.amount);

  const facts: { label: string; value: string; shown?: ReactNode }[] = [
    { label: t('date'), value: formatDate(existing.transactionDate) },
    {
      label: t('amount'),
      value: amount === null ? t('amountUnknown') : formatCurrency(amount, currencyCode),
    },
    { label: t('payee'), value: existing.payeeName ?? '' },
    {
      label: t('category'),
      value: existing.isTransfer
        ? existing.transferAccountName
          ? t('transferWith', { account: existing.transferAccountName })
          : t('transfer')
        : existing.isSplit
          ? t('split')
          : (existing.categoryName ?? ''),
    },
    { label: t('status'), value: t(`statuses.${existing.status}`) },
  ];
  if (existing.referenceNumber) facts.push({ label: t('reference'), value: existing.referenceNumber });
  if (existing.description) {
    facts.push({
      label: t('description'),
      value: existing.description,
      shown: <LinkifiedText text={existing.description} />,
    });
  }

  return (
    <div className="space-y-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-gray-900 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-gray-100">
      <h4 className={IMPORT_PREVIEW_HEADING_CLASS}>{t('looksLike')}</h4>
      <dl className="grid grid-cols-1 gap-x-6 gap-y-1 sm:grid-cols-2">
        {facts.map(({ label, value, shown }) => (
          <div key={label} className="flex min-w-0 gap-2">
            <dt className="shrink-0 text-gray-500 dark:text-gray-400">{label}</dt>
            <dd className="min-w-0 truncate" title={value}>
              {shown ?? value}
            </dd>
          </div>
        ))}
      </dl>
      <fieldset className="space-y-1 pt-1">
        <legend className="mb-1 text-xs font-medium text-gray-700 dark:text-gray-300">
          {t('legend', { payee: rowLabel })}
        </legend>
        {options.map((value) => (
          <label key={value} className="flex cursor-pointer items-start gap-2">
            <input
              type="radio"
              name={`duplicate-${rowId}`}
              className="mt-0.5 h-3.5 w-3.5 cursor-pointer text-blue-600 focus-visible:ring-2 focus-visible:ring-blue-500"
              checked={choice === value}
              onChange={() => onChange(value)}
              disabled={disabled}
            />
            <span>
              <span className="font-medium">{t(`choice.${value}`)}</span>{' '}
              <span className="text-xs text-gray-600 dark:text-gray-300">{t(`choiceHelp.${value}`)}</span>
            </span>
          </label>
        ))}
      </fieldset>
    </div>
  );
}
