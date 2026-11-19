'use client';

import { InstitutionLogo, type InstitutionLogoData } from '@/components/institutions/InstitutionLogo';
import { AccountTypeIcon } from '@/lib/account-type-meta';
import type { AccountType } from '@/types/account';

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
