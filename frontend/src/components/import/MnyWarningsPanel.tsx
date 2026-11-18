'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { ChevronRightIcon } from '@heroicons/react/24/outline';
import { useDateFormat } from '@/hooks/useDateFormat';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { MnyFlaggedRow, MnyWarningSummary } from '@/lib/import-mny';
import { Th } from '@/components/ui/Table';
import { BinaryImportFormat, MNY_FORMAT } from '@/lib/binary-import-format';

interface MnyWarningsPanelProps {
  warnings: MnyWarningSummary[];
  /** Section heading. The review step and the report word it differently. */
  heading: string;
  /** Which file format the warnings came from; Money when omitted. */
  format?: BinaryImportFormat;
}

/**
 * What the import flagged, grouped by reason, each group expanding to the
 * transactions behind it.
 *
 * A count alone ("2 splits had legs that do not add up") tells a user something
 * is wrong and nothing about where. The point of this panel is that they can
 * open the group, read the date, account, payee and amount of each flagged row,
 * go and fix it in Money, and import again -- which only the review step, shown
 * *before* the import, can act on. The same panel renders in the post-import
 * report so the two never drift into saying different things about the same
 * warning.
 *
 * Only row-level warnings carry rows; a missing table or a renamed account has
 * nothing to expand and stays a plain line.
 */
export function MnyWarningsPanel({
  warnings,
  heading,
  format = MNY_FORMAT,
}: MnyWarningsPanelProps) {
  const t = useTranslations('import');
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());

  if (warnings.length === 0) {
    return null;
  }

  const toggle = (code: string) => {
    const next = new Set(expanded);
    if (next.has(code)) {
      next.delete(code);
    } else {
      next.add(code);
    }
    setExpanded(next);
  };

  return (
    <div className="mb-6">
      <h3 className="text-sm font-semibold text-foreground mb-2">{heading}</h3>
      <ul className="bg-card border border-border rounded-lg divide-y divide-border text-sm">
        {warnings.map((warning) => {
          const isOpen = expanded.has(warning.code);
          const rows = warning.rows ?? [];
          const summary = (
            <>
              <span className="text-foreground">
                {t(format.warningKey(warning.code), { count: warning.count })}
              </span>
              {warning.samples.length > 0 && (
                <span className="block text-xs text-muted-foreground">
                  {warning.samples.join(', ')}
                </span>
              )}
            </>
          );

          if (rows.length === 0) {
            return (
              <li key={warning.code} className="px-4 py-2">
                {summary}
              </li>
            );
          }

          return (
            <li key={warning.code}>
              <button
                type="button"
                onClick={() => toggle(warning.code)}
                aria-expanded={isOpen}
                className="flex w-full items-start gap-2 px-4 py-2 text-left hover:bg-muted/50 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
              >
                <ChevronRightIcon
                  className={`mt-0.5 h-4 w-4 flex-shrink-0 text-muted-foreground transition-transform ${
                    isOpen ? 'rotate-90' : ''
                  }`}
                  aria-hidden="true"
                />
                <span className="flex-1">
                  {summary}
                  <span className="block text-xs text-primary">
                    {isOpen
                      ? t('mnyWarnings.hideTransactions')
                      : t('mnyWarnings.showTransactions', {
                          count: rows.length,
                        })}
                  </span>
                </span>
              </button>

              {isOpen && (
                <div className="border-t border-border px-4 py-3">
                  <p className="mb-2 text-xs text-muted-foreground">
                    {warning.rowsTruncated
                      ? t(format.copy.reviewInSourceTruncated, {
                          shown: rows.length,
                          total: warning.count,
                        })
                      : t(format.copy.reviewInSource)}
                  </p>
                  <FlaggedRowsTable rows={rows} />
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/**
 * The flagged rows, bounded and scrollable.
 *
 * Fifty rows inside a card would drag the wizard's layout around, so the list
 * caps its height and scrolls with `scrollbar-slim` -- the pattern for a long
 * list that lives inside a card rather than on its own page.
 */
function FlaggedRowsTable({ rows }: { rows: MnyFlaggedRow[] }) {
  const t = useTranslations('import');
  const { formatDate } = useDateFormat();
  const { formatCurrency } = useNumberFormat();

  return (
    <div className="scrollbar-slim max-h-80 overflow-y-auto overflow-x-auto pr-1">
      <table className="min-w-full text-xs">
        <thead>
          <tr>
            <Th className="px-2 py-1">
              {t('mnyWarnings.table.date')}
            </Th>
            <Th className="px-2 py-1">
              {t('mnyWarnings.table.account')}
            </Th>
            <Th className="px-2 py-1">
              {t('mnyWarnings.table.payee')}
            </Th>
            <Th align="right" className="px-2 py-1">
              {t('mnyWarnings.table.amount')}
            </Th>
            <Th className="px-2 py-1">
              {t('mnyWarnings.table.problem')}
            </Th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {rows.map((row) => (
            <tr key={row.handle}>
              <td className="whitespace-nowrap px-2 py-1 text-muted-foreground">
                {row.date ? formatDate(row.date) : t('mnyWarnings.noValue')}
              </td>
              <td className="px-2 py-1 text-foreground">
                {row.accountName ?? t('mnyWarnings.noValue')}
                {row.reference && (
                  <span className="block text-muted-foreground">
                    {t('mnyWarnings.reference', { reference: row.reference })}
                  </span>
                )}
              </td>
              <td className="px-2 py-1 text-foreground">
                {row.payeeName ?? t('mnyWarnings.noValue')}
                {row.memo && (
                  <span className="block text-muted-foreground">{row.memo}</span>
                )}
              </td>
              <td className="whitespace-nowrap px-2 py-1 text-right text-foreground">
                {row.amount === null
                  ? t('mnyWarnings.noValue')
                  : formatCurrency(row.amount, row.currencyCode ?? undefined)}
              </td>
              <td className="px-2 py-1 font-mono text-muted-foreground">
                {row.detail ?? `htrn=${row.handle}`}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
