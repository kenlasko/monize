'use client';

import { useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { isKnownBankAccountType, normalizeBankAccountType } from '@/lib/bank-sync-account-type';

/**
 * The reader's name for the type a bank reported an account as: `CACC` a
 * current account, `CARD` a card, `SVGS` savings, `LOAN` a loan, any other code
 * "Account type {code}". Null when the bank stated none -- an unstated type is
 * not named, so it is never guessed.
 */
export function useBankAccountTypeLabel() {
  const t = useTranslations('settings.bankSync.accountType');
  return useCallback(
    (code: string | null | undefined): string | null => {
      const normalized = normalizeBankAccountType(code);
      if (normalized === null) return null;
      return isKnownBankAccountType(normalized) ? t(normalized) : t('other', { code: normalized });
    },
    [t],
  );
}
