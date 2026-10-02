'use client';

import { useTranslations } from 'next-intl';
import { ChevronDownIcon, ChevronRightIcon } from '@heroicons/react/24/outline';

interface ImportPreviewExpandButtonProps {
  expanded: boolean;
  /** The id of the details this button opens; pointed at only while they are in the DOM. */
  detailsId: string;
  /** What the row is called, for the button's hidden label. */
  rowLabel: string;
  onToggle: () => void;
}

/** The chevron that opens a preview row's details (`aria-expanded`, a label only a screen reader sees). */
export function ImportPreviewExpandButton({ expanded, detailsId, rowLabel, onToggle }: ImportPreviewExpandButtonProps) {
  const t = useTranslations('import.preview.expand');
  const Chevron = expanded ? ChevronDownIcon : ChevronRightIcon;
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={expanded}
      aria-controls={expanded ? detailsId : undefined}
      className="rounded p-0.5 text-gray-500 hover:text-gray-900 focus-visible:ring-2 focus-visible:ring-blue-500 motion-reduce:transition-none dark:text-gray-400 dark:hover:text-gray-100"
    >
      <Chevron className="h-4 w-4" aria-hidden="true" />
      <span className="sr-only">{expanded ? t('hide', { payee: rowLabel }) : t('show', { payee: rowLabel })}</span>
    </button>
  );
}
