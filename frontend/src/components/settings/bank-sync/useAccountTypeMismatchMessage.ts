'use client';

import { useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { accountTypeMismatch } from '@/lib/bank-sync-account-type';
import { formatAccountType } from '@/lib/account-utils';
import type { AccountType } from '@/types/account';
import { useBankAccountTypeLabel } from './useBankAccountTypeLabel';

/**
 * The warning for a bank account linked to a Monize account of a kind it does
 * not look like (a card linked to a chequing account), or null when the two
 * agree or the bank did not say what the account is. One place, so the link
 * dialog and the row show the same sentence for the same mismatch.
 */
export function useAccountTypeMismatchMessage() {
  const t = useTranslations('settings.bankSync.mismatch');
  const tc = useTranslations('common');
  const bankTypeLabel = useBankAccountTypeLabel();

  return useCallback(
    (
      bankType: string | null | undefined,
      account: { name: string; accountType: AccountType } | undefined,
    ): string | null => {
      if (!account) return null;
      const mismatch = accountTypeMismatch(bankType, account.accountType);
      if (mismatch === 'bankCard') {
        return t('bankCard', {
          account: account.name,
          type: formatAccountType(account.accountType, tc),
          creditCard: formatAccountType('CREDIT_CARD', tc),
        });
      }
      if (mismatch === 'monizeCard') {
        return t('monizeCard', {
          account: account.name,
          creditCard: formatAccountType('CREDIT_CARD', tc),
          bankType: bankTypeLabel(bankType) ?? '',
        });
      }
      return null;
    },
    [t, tc, bankTypeLabel],
  );
}
