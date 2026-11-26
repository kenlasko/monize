'use client';

import type { ReactNode } from 'react';
import { useFormatter, useTranslations } from 'next-intl';
import { ExclamationTriangleIcon } from '@heroicons/react/24/outline';
import { useLoanBillAutoPost } from '@/components/rules/use-loan-bill-auto-post';
import { useRuleErrorMessage } from '@/components/rules/use-rule-error-message';
import { Button } from '@/components/ui/Button';
import { ruleInvalidReasonKeys } from '@/lib/rule-summary';
import type { RuleErrorEntry } from '@/lib/rule-errors';
import type { TransactionRule } from '@/types/transaction-rule';

const TONES = {
  red: 'border-red-300 bg-red-50 text-red-800 dark:border-red-700 dark:bg-red-900/20 dark:text-red-200',
  amber: 'border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-700 dark:bg-amber-900/20 dark:text-amber-200',
} as const;

export function Banner({ tone, title, children }: { tone: keyof typeof TONES; title?: string; children?: ReactNode }) {
  return (
    <div role="alert" className={`flex items-start gap-3 rounded-lg border p-3 text-sm ${TONES[tone]}`}>
      <ExclamationTriangleIcon className="mt-0.5 h-5 w-5 shrink-0" aria-hidden="true" />
      <div className="min-w-0 flex-1 space-y-1">
        {title && <p className="font-medium">{title}</p>}
        {children}
      </div>
    </div>
  );
}

interface RuleEditorBannersProps {
  /** The stored rule being edited; null for a new one. */
  rule: TransactionRule | null;
  /** Parts of the stored definition the editor had to drop or reset. */
  repaired: number;
  /** True after a save was refused with a revision conflict. */
  conflict: boolean;
  onReload: () => void;
  /** True after a save the server refused with per-card errors. */
  refused: boolean;
  /** Entries whose path names no card. */
  unplaced: readonly RuleErrorEntry[];
  /** A refusal that carried no per-card entries, in the server's own words. */
  message: string | null;
  /** The linked bill of the loan a settlement action names (`settlementScheduleId`); null for none. */
  loanScheduleId?: string | null;
}

/**
 * Everything the editor says above the form: why a stored rule cannot run,
 * what had to be repaired to open it, a revision conflict, what the server
 * refused, and a loan bill that would pay the installment a settlement pays. Errors that belong to a card are shown on the card, not here.
 */
export function RuleEditorBanners({
  rule,
  repaired,
  conflict,
  onReload,
  refused,
  unplaced,
  message,
  loanScheduleId = null,
}: RuleEditorBannersProps) {
  const t = useTranslations('rules');
  const billAutoPosts = useLoanBillAutoPost(loanScheduleId);
  const format = useFormatter();
  const errorMessage = useRuleErrorMessage();

  const reasons = rule?.invalid
    ? format.list(
        ruleInvalidReasonKeys(rule).map((key) => t(`invalid.reasons.${key}`)),
        { type: 'conjunction' },
      )
    : null;

  return (
    <>
      {reasons !== null && (
        <Banner tone="red" title={t('editor.invalid.title')}>
          <p>{t('invalid.tooltip', { reasons })}</p>
        </Banner>
      )}
      {repaired > 0 && (
        <Banner tone="amber">
          <p>{t('editor.invalid.repaired')}</p>
        </Banner>
      )}
      {conflict && (
        <Banner tone="amber" title={t('editor.conflict.title')}>
          <p>{t('editor.conflict.body')}</p>
          <Button type="button" size="sm" variant="outline" onClick={onReload}>
            {t('editor.conflict.reload')}
          </Button>
        </Banner>
      )}
      {billAutoPosts !== null && (
        <Banner tone="amber" title={t('editor.action.loan.autoPostTitle')}>
          <p>
            {billAutoPosts === 'bill'
              ? t('editor.action.loan.autoPostBody')
              : t('editor.action.loan.autoPostBodyOccurrence')}
          </p>
        </Banner>
      )}
      {(refused || message !== null) && (
        <Banner tone="red">
          <p>{message ?? t('editor.save.summary')}</p>
          {unplaced.length > 0 && (
            <ul className="list-disc pl-5">
              {unplaced.map((entry, index) => (
                <li key={`${entry.path}:${entry.code}:${index}`}>{errorMessage(entry.code)}</li>
              ))}
            </ul>
          )}
        </Banner>
      )}
    </>
  );
}
