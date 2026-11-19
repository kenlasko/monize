'use client';

import { forwardRef, useMemo } from 'react';
import { IconSelect, type IconSelectProps } from '@/components/ui/IconSelect';
import { useInstitutionLogos } from '@/hooks/useInstitutionLogos';
import type { AccountSelectOption } from '@/lib/account-utils';
import { AccountPickerIcon } from './AccountPickerIcon';

export interface AccountSelectProps extends Omit<IconSelectProps, 'options'> {
  /** Usually `buildAccountDropdownOptions`'s; a row without `accountType` gets no mark. */
  options: AccountSelectOption[];
}

/**
 * Every account dropdown: `Select`'s props and behaviour, with each account
 * row -- and the picked one, in the closed field -- marked by its
 * institution's logo, else its account-type icon (`AccountPickerIcon`).
 * Favourites first and the rule after them come from the options, exactly as
 * `buildAccountDropdownOptions` orders them.
 */
export const AccountSelect = forwardRef<HTMLSelectElement, AccountSelectProps>(
  function AccountSelect({ options, ...props }, ref) {
    const institutionLogos = useInstitutionLogos();
    const decorated = useMemo(
      () =>
        options.map(({ accountType, institutionId, ...option }) =>
          accountType
            ? {
                ...option,
                icon: (
                  <AccountPickerIcon
                    institution={institutionId ? institutionLogos.get(institutionId) : undefined}
                    accountType={accountType}
                  />
                ),
              }
            : option,
        ),
      [options, institutionLogos],
    );
    return <IconSelect ref={ref} options={decorated} {...props} />;
  },
);
