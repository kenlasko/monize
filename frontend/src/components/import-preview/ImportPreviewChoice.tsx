'use client';

import { useTranslations } from 'next-intl';
import type { UncheckedChoice } from '@/lib/import-preview';

interface ImportPreviewChoiceProps {
  /** Makes the radio group's name unique to its row. */
  rowId: string;
  /** What the row is called, for the group's legend. */
  rowLabel: string;
  choice: UncheckedChoice;
  onChange: (choice: UncheckedChoice) => void;
  disabled?: boolean;
}

/**
 * What an unchecked row of an import preview does: skipped for now (written
 * nowhere, offered again next time) or added to the exceptions (never imported
 * until taken back). Two radios in a group, so it works by keyboard and is
 * announced as one choice.
 */
export function ImportPreviewChoice({ rowId, rowLabel, choice, onChange, disabled = false }: ImportPreviewChoiceProps) {
  const t = useTranslations('import.preview.choice');
  const option = (value: UncheckedChoice) => (
    <label key={value} className="flex cursor-pointer items-center gap-1.5">
      <input
        type="radio"
        name={`choice-${rowId}`}
        className="h-3.5 w-3.5 cursor-pointer text-blue-600 focus-visible:ring-2 focus-visible:ring-blue-500"
        checked={choice === value}
        onChange={() => onChange(value)}
        disabled={disabled}
      />
      <span>{t(value)}</span>
    </label>
  );
  return (
    <fieldset className="mt-1 space-y-0.5 text-xs text-gray-600 dark:text-gray-300">
      <legend className="sr-only">{t('legend', { payee: rowLabel })}</legend>
      {option('skip')}
      {option('except')}
    </fieldset>
  );
}
