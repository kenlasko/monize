'use client';

import { useTranslations } from 'next-intl';
import { EmptyState } from '@/components/ui/EmptyState';
import { TABLE_BODY_CLASS, TABLE_CLASS, Td, Th } from '@/components/ui/Table';
import { useRuleChangeText } from '@/components/rules/use-rule-change-text';
import { useDateFormat } from '@/hooks/useDateFormat';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import type { RuleRunPreview, RuleRunSkippedRow } from '@/types/transaction-rule-run';

/** The reason a row was left alone, as a sentence. */
export function useSkipReasonText(): (reason: string) => string {
  const t = useTranslations('rules.run.skipReasons');
  return (reason) => {
    switch (reason) {
      case 'reconciled_locked':
      case 'transfer_leg_category':
      case 'split_category':
      case 'cross_owner_transfer_payee':
      case 'empty_render':
      case 'payee_not_found':
      case 'row_is_transfer_leg':
      case 'row_has_splits':
      case 'row_is_void':
      case 'zero_amount':
      case 'transfer_direction_mismatch':
      case 'transfer_same_account':
      case 'transfer_account_unavailable':
      case 'transfer_currency_mismatch':
      case 'split_amount_unparseable':
      case 'split_sum_mismatch':
      case 'split_too_few_parts':
        return t(reason);
      default:
        // A reason newer than this client still says that the row was left alone.
        return t('other');
    }
  };
}

/** Skipped rows carry only an id; the reason is what the reader can act on. */
export function RuleRunSkippedList({ skipped }: { skipped: readonly RuleRunSkippedRow[] }) {
  const t = useTranslations('rules.run');
  const reasonText = useSkipReasonText();
  if (skipped.length === 0) return null;

  // One line per reason with a count: the ids alone would tell the reader nothing.
  const counts = new Map<string, number>();
  for (const row of skipped) counts.set(row.reason, (counts.get(row.reason) ?? 0) + 1);

  return (
    <div className="mt-4" data-testid="rule-run-skipped">
      <h3 className="text-sm font-medium text-gray-900 dark:text-gray-100">
        {t('skipped.title', { count: skipped.length })}
      </h3>
      <ul className="mt-1 list-disc space-y-0.5 pl-5 text-sm text-gray-600 dark:text-gray-300">
        {[...counts].map(([reason, count]) => (
          <li key={reason}>{t('skipped.line', { count, reason: reasonText(reason) })}</li>
        ))}
      </ul>
    </div>
  );
}

interface RuleRunPreviewTableProps {
  preview: RuleRunPreview;
}

/**
 * What a test or a run would change: a count line, the rows with their planned
 * change in words, and the rows the rule reached but leaves alone. "Nothing
 * matched" is its own message, never an empty table.
 */
export function RuleRunPreviewTable({ preview }: RuleRunPreviewTableProps) {
  const t = useTranslations('rules.run');
  const { formatDate } = useDateFormat();
  const { formatCurrency } = useNumberFormat();
  const changeText = useRuleChangeText();
  const { labels } = preview;
  const names = {
    category: (id: string) => labels.categories[id],
    payee: (id: string) => labels.payees[id],
    tag: (id: string) => labels.tags[id],
    account: (id: string) => labels.accounts[id],
  };

  return (
    <div>
      <p className="text-sm text-gray-700 dark:text-gray-300">
        {t('summary', { matched: preview.matched.length, scanned: preview.scanned })}
      </p>
      {preview.truncated && (
        <p className="mt-1 text-sm text-amber-700 dark:text-amber-400">{t('truncated')}</p>
      )}

      {preview.matched.length === 0 ? (
        <EmptyState
          className="py-6"
          title={t('noMatches.title')}
          description={
            preview.conditionMatchedCount > 0
              ? t('noChange', {
                  matched: preview.conditionMatchedCount,
                  scanned: preview.scanned,
                })
              : t('noMatches.body')
          }
        />
      ) : (
        <div className="mt-3 max-h-96 overflow-auto">
          <table className={TABLE_CLASS}>
            <thead className="bg-gray-50 dark:bg-gray-800">
              <tr>
                <Th>{t('table.date')}</Th>
                <Th>{t('table.payee')}</Th>
                <Th align="right">{t('table.amount')}</Th>
                <Th>{t('table.change')}</Th>
              </tr>
            </thead>
            <tbody className={TABLE_BODY_CLASS}>
              {preview.matched.map((row) => (
                <tr key={row.transactionId}>
                  <Td className="whitespace-nowrap">{formatDate(row.date)}</Td>
                  <Td>{row.payeeName ?? <span className="text-gray-500 dark:text-gray-400">{t('table.noPayee')}</span>}</Td>
                  <Td align="right" className="whitespace-nowrap">
                    {formatCurrency(row.amount, row.currencyCode)}
                  </Td>
                  <Td>
                    <ul className="space-y-0.5">
                      {changeText(row.changes, names, { currencyCode: row.currencyCode }).map((line) => (
                        <li key={line}>{line}</li>
                      ))}
                    </ul>
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <RuleRunSkippedList skipped={preview.skipped} />
    </div>
  );
}
