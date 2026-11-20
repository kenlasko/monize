'use client';

import type { ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { useAccountPickerIcon } from '@/components/accounts/shared/AccountPickerIcon';
import { RuleEffectsLines } from '@/components/ai/RuleEffectsLines';
import { Badge } from '@/components/ui/Badge';
import { useDateFormat } from '@/hooks/useDateFormat';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import type { Account } from '@/types/account';
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
  'amountTooLarge',
  'foreignCurrency',
  'crossCurrencyTransfer',
]);

/**
 * The FROM account's balance as a card: "now -> after saving" when the entry
 * lands today or earlier, otherwise the current balance and the day it moves.
 * The visual row is hidden from screen readers, which get the same facts as
 * one sentence instead of an arrow between two amounts.
 */
function BalanceCard({
  accountName,
  icon,
  current,
  after,
  movesOn,
}: {
  accountName: string;
  /** The account's institution or type mark, when the account is in the list. */
  icon: ReactNode;
  current: string;
  after: string | null;
  movesOn: string | null;
}) {
  const t = useTranslations('transactions.quickAdd');
  const sentence =
    after !== null
      ? t('balance.after', { account: accountName, current, after })
      : movesOn
        ? t('balance.movesOn', { account: accountName, current, date: movesOn })
        : t('balance.current', { account: accountName, current });

  return (
    <div
      className="rounded-lg border border-gray-200 bg-gray-50 px-4 py-3 dark:border-gray-700 dark:bg-gray-900/50"
      data-testid="quick-add-balance"
    >
      <p className="sr-only">{sentence}</p>
      <div aria-hidden="true">
        <div className="flex items-center gap-2">
          {icon && <span className="flex shrink-0 items-center">{icon}</span>}
          <span className="min-w-0 truncate font-semibold text-gray-900 dark:text-gray-100">{accountName}</span>
          <span className="ml-auto shrink-0 text-xs text-gray-500 dark:text-gray-400">
            {t(after !== null ? 'balance.afterLabel' : 'balance.nowLabel')}
          </span>
        </div>
        <div className="mt-1.5 flex flex-wrap items-baseline gap-x-2 gap-y-1 tabular-nums">
          {after !== null ? (
            <>
              <span className="text-base text-gray-400 dark:text-gray-500">{current}</span>
              <span className="text-base text-gray-400 dark:text-gray-500">&rarr;</span>
              <span className="text-xl font-semibold text-gray-900 dark:text-gray-100">{after}</span>
            </>
          ) : (
            <span className="text-xl font-semibold text-gray-900 dark:text-gray-100">{current}</span>
          )}
          {movesOn && (
            <Badge variant="amber" className="ml-auto self-center">
              {t('balance.movesOnNote', { date: movesOn })}
            </Badge>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * What saving the reading would do and why it cannot, under the chips: the
 * balance line (the FROM account's, the predicate `create()` uses), one
 * sentence per blocker, and what the reader's rules will change, drawn by the
 * same `RuleEffectsLines` the assistant's confirmation cards use.
 */
export function QuickAddSummary({
  reading,
  accounts,
}: {
  reading: QuickAddInterpretation;
  /** The full accounts, for the balance card's institution or type icon. */
  accounts: Account[];
}) {
  const t = useTranslations('transactions.quickAdd');
  const { formatCurrency } = useNumberFormat();
  const { formatDate } = useDateFormat();
  const accountIcon = useAccountPickerIcon();

  const balance = reading.balance;
  const accountName =
    balance &&
    ([reading.account.value, reading.toAccount.value].find((a) => a?.id === balance.accountId)
      ?.name ?? null);

  return (
    <div className="space-y-3 text-sm">
      {balance && accountName && (
        <BalanceCard
          accountName={accountName}
          icon={(() => {
            const account = accounts.find((a) => a.id === balance.accountId);
            return account ? accountIcon(account) : null;
          })()}
          current={formatCurrency(balance.current, balance.currencyCode)}
          after={balance.after !== null ? formatCurrency(balance.after, balance.currencyCode) : null}
          movesOn={balance.after === null && balance.movesOn ? formatDate(balance.movesOn) : null}
        />
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
