'use client';

import { useTranslations } from 'next-intl';
import { RuleEffectsLines } from '@/components/ai/RuleEffectsLines';
import { useDateFormat } from '@/hooks/useDateFormat';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import type { QuickAddBlocker, QuickAddInterpretation } from '@/types/quick-add';

/** The blockers this client has a sentence for; anything newer reads as `unknown`. */
const KNOWN_BLOCKERS: ReadonlySet<QuickAddBlocker> = new Set<QuickAddBlocker>([
  'missingAmount',
  'zeroAmount',
  'amountPrecision',
  'missingAccount',
  'ambiguousAccount',
  'missingToAccount',
  'sameAccount',
  'foreignCurrency',
  'crossCurrencyTransfer',
]);

/**
 * What saving the reading would do and why it cannot, under the chips: the
 * balance line (the FROM account's, the predicate `create()` uses), one
 * sentence per blocker, and what the reader's rules will change, drawn by the
 * same `RuleEffectsLines` the assistant's confirmation cards use.
 */
export function QuickAddSummary({ reading }: { reading: QuickAddInterpretation }) {
  const t = useTranslations('transactions.quickAdd');
  const { formatCurrency } = useNumberFormat();
  const { formatDate } = useDateFormat();

  const balance = reading.balance;
  const accountName =
    balance &&
    ([reading.account.value, reading.toAccount.value].find((a) => a?.id === balance.accountId)
      ?.name ?? null);

  return (
    <div className="space-y-2 text-sm">
      {balance && accountName && (
        <p className="text-gray-700 dark:text-gray-300" data-testid="quick-add-balance">
          {balance.after !== null
            ? t('balance.after', {
                account: accountName,
                current: formatCurrency(balance.current, balance.currencyCode),
                after: formatCurrency(balance.after, balance.currencyCode),
              })
            : balance.movesOn
              ? t('balance.movesOn', {
                  account: accountName,
                  current: formatCurrency(balance.current, balance.currencyCode),
                  date: formatDate(balance.movesOn),
                })
              : t('balance.current', {
                  account: accountName,
                  current: formatCurrency(balance.current, balance.currencyCode),
                })}
        </p>
      )}
      {reading.blockers.length > 0 && (
        <ul className="space-y-1 text-amber-700 dark:text-amber-400" data-testid="quick-add-blockers">
          {reading.blockers.map((blocker) => (
            <li key={blocker}>
              {KNOWN_BLOCKERS.has(blocker) ? t(`blockers.${blocker}`) : t('blockers.unknown')}
            </li>
          ))}
        </ul>
      )}
      {/* The server previews the rules only for an entry it can save. */}
      {reading.blockers.length === 0 && (
        <RuleEffectsLines effects={reading.ruleEffects} currencyCode={reading.account.value?.currencyCode} />
      )}
    </div>
  );
}
