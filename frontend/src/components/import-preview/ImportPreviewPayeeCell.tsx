'use client';

import { useTranslations } from 'next-intl';
import { InfoTooltip } from '@/components/ui/InfoTooltip';
import { payeeTip } from '@/lib/import-preview';
import type { ImportPreviewPayee } from '@/types/import-preview';

interface ImportPreviewPayeeCellProps {
  /** The payee as the row shows it. */
  text: string;
  /** How it was resolved; the tooltip says so when that is not obvious. */
  payee: ImportPreviewPayee | null;
}

/**
 * The payee of an import preview row: the resolved name, truncated with the
 * whole text in its title, and beside it a tooltip with the source's own text,
 * the payee it maps to and how (an alias, a new payee, a rule). A payee that is
 * the source's text needs no tooltip.
 */
export function ImportPreviewPayeeCell({ text, payee }: ImportPreviewPayeeCellProps) {
  const t = useTranslations('import.preview.payeeTip');
  const tip = payeeTip(payee);
  return (
    <div className="flex min-w-0 items-center gap-1">
      <span className="min-w-0 truncate" title={text}>
        {text}
      </span>
      {tip !== null && <InfoTooltip text={t(tip.kind, tip)} usePortal />}
    </div>
  );
}
