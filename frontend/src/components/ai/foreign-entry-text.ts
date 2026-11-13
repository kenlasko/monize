import type { useTranslations } from 'next-intl';
import type { PendingActionForeignEntry } from '@/types/ai';

type AiTranslator = ReturnType<typeof useTranslations<'ai'>>;

/**
 * A create or edit card's foreign-currency entry as both confirmation cards
 * say it: what was paid in the other currency, and the rate with where it came
 * from (as given, derived from the two amounts, or the market rate for the
 * date), so the approver sees which one the commit uses.
 * `null` when the card carries no entry; `cleared` when the edit removes one.
 */
export function foreignEntryText(
  entry: PendingActionForeignEntry,
  accountCurrency: string | undefined,
  t: AiTranslator,
  format: {
    currency: (amount: number, currency: string) => string;
    rate: (rate: number) => string;
  },
): { cleared: true } | { paid: string; rate: string | null } | null {
  if (entry.originalCurrencyCode === undefined) return null;
  if (entry.originalCurrencyCode === null) return { cleared: true };
  if (entry.originalAmount === undefined || entry.originalAmount === null) return null;
  const paid = format.currency(entry.originalAmount, entry.originalCurrencyCode);
  if (entry.exchangeRate === undefined || !accountCurrency) return { paid, rate: null };
  const values = {
    from: entry.originalCurrencyCode,
    rate: format.rate(entry.exchangeRate),
    to: accountCurrency,
  };
  const rate =
    entry.exchangeRateSource === 'derived'
      ? t('confirmAction.fxRateDerived', values)
      : entry.exchangeRateSource === 'market'
        ? t('confirmAction.fxRateMarket', values)
        : t('confirmAction.fxRateSupplied', values);
  return { paid, rate };
}
