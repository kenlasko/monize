'use client';

import { useTranslations } from 'next-intl';
import { useRuleChangeText } from '@/components/rules/use-rule-change-text';
import { useSkipReasonText } from '@/components/rules/RuleRunPreviewTable';
import { useDateFormat } from '@/hooks/useDateFormat';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import type { PendingActionRuleTest } from '@/types/ai';

const HEADING_CLASS = 'text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400';

interface RuleTestResultProps {
  test: PendingActionRuleTest;
  /** The heading over the result. */
  title: string;
}

/**
 * What a rule would change on existing transactions, as the assistant's card
 * shows it: the counts over everything examined, the first rows with the
 * planned change in words, and the rows the rule reaches but leaves alone.
 * Every count is the server's; the rows are only the first few of them.
 */
export function RuleTestResult({ test, title }: RuleTestResultProps) {
  const t = useTranslations('rules.run');
  const tc = useTranslations('ai.confirmAction.rule');
  const { formatDate } = useDateFormat();
  const { formatCurrency } = useNumberFormat();
  const changeText = useRuleChangeText();
  const skipReason = useSkipReasonText();
  const { labels } = test;
  const names = {
    category: (id: string) => labels.categories[id],
    payee: (id: string) => labels.payees[id],
    tag: (id: string) => labels.tags[id],
    account: (id: string) => labels.accounts?.[id],
  };

  // One line per reason among the rows shown; the total is the server's count.
  const reasons = new Map<string, number>();
  for (const row of test.skipped) reasons.set(row.reason, (reasons.get(row.reason) ?? 0) + 1);

  return (
    <section className="space-y-1" data-testid="rule-test-result">
      <h4 className={HEADING_CLASS}>{title}</h4>
      <p className="text-sm text-gray-900 dark:text-gray-100">
        {t('summary', { matched: test.matchedCount, scanned: test.scanned })}
      </p>
      {test.conditionMatchedCount === 0 && test.scanned > 0 && (
        <p role="status" className="text-sm font-medium text-amber-700 dark:text-amber-400">
          {t('matchesNone', { scanned: test.scanned })}
        </p>
      )}
      {test.conditionMatchedCount > 0 && test.matchedCount === 0 && (
        <p role="status" className="text-sm text-gray-600 dark:text-gray-300">
          {t('noChange', {
            matched: test.conditionMatchedCount,
            scanned: test.scanned,
          })}
        </p>
      )}
      {test.truncated && <p className="text-sm text-amber-700 dark:text-amber-400">{t('truncated')}</p>}

      {test.rows.length > 0 && (
        <ul className="space-y-1.5 text-sm">
          {test.rows.map((row) => (
            <li key={row.transactionId} className="text-gray-900 dark:text-gray-100">
              <div className="flex justify-between gap-3">
                <span className="break-words">
                  {formatDate(row.date)}
                  {' · '}
                  {row.payeeName ?? t('table.noPayee')}
                </span>
                <span className="whitespace-nowrap">{formatCurrency(row.amount, row.currencyCode)}</span>
              </div>
              <ul className="pl-3 text-gray-600 dark:text-gray-300">
                {changeText(row.changes, names, { currencyCode: row.currencyCode }).map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
      {test.matchedCount > test.rows.length && (
        <p className="text-xs text-gray-500 dark:text-gray-400">
          {tc('rowsShown', {
            shown: test.rows.length,
            count: test.matchedCount,
          })}
        </p>
      )}

      {test.skippedCount > 0 && (
        <div data-testid="rule-test-skipped">
          <p className="text-sm font-medium text-gray-900 dark:text-gray-100">
            {t('skipped.title', { count: test.skippedCount })}
          </p>
          <ul className="list-disc space-y-0.5 pl-5 text-sm text-gray-600 dark:text-gray-300">
            {[...reasons].map(([reason, count]) => (
              <li key={reason}>{t('skipped.line', { count, reason: skipReason(reason) })}</li>
            ))}
          </ul>
          {test.skippedCount > test.skipped.length && (
            <p className="text-xs text-gray-500 dark:text-gray-400">
              {tc('skippedMore', { shown: test.skipped.length })}
            </p>
          )}
        </div>
      )}

      {test.aiReviewRequests > 0 && (
        <p className="text-sm text-gray-900 dark:text-gray-100">
          {tc('aiReviewRequests', { count: test.aiReviewRequests })}
        </p>
      )}
    </section>
  );
}
