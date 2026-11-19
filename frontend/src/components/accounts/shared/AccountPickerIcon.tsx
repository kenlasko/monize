'use client';

import { InstitutionLogo, type InstitutionLogoData } from '@/components/institutions/InstitutionLogo';
import { AccountTypeIcon } from '@/lib/account-type-meta';
import { useCallback, type ReactNode } from 'react';
import { useInstitutionLogos } from '@/hooks/useInstitutionLogos';
import type { Account, AccountType } from '@/types/account';

interface AccountPickerIconProps {
  /** The account's institution, when it has one the picker could resolve. */
  institution?: InstitutionLogoData;
  accountType: AccountType;
  size?: number;
}

/**
 * The mark an account row carries in a picker: its institution's favicon, else
 * the institution's initial, else the account-type icon -- the same fallback
 * order the accounts list draws, so an account looks alike in both.
 */
export function AccountPickerIcon({ institution, accountType, size = 20 }: AccountPickerIconProps) {
  return (
    <InstitutionLogo
      institution={institution}
      size={size}
      fallbackIcon={<AccountTypeIcon type={accountType} className="h-3.5 w-3.5" />}
    />
  );
}

/**
 * A function from an account to its picker mark, for a surface that builds its
 * own option list (a filter's `MultiSelect`). Stable until the institutions
 * load, so a memoized option list is rebuilt once, not every render.
 */
export function useAccountPickerIcon(): (
  account: Pick<Account, 'accountType' | 'institutionId'>,
) => ReactNode {
  const institutionLogos = useInstitutionLogos();
  return useCallback(
    (account) => (
      <AccountPickerIcon
        institution={account.institutionId ? institutionLogos.get(account.institutionId) : undefined}
        accountType={account.accountType}
      />
    ),
    [institutionLogos],
  );
}
