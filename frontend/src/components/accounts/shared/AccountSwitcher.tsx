'use client';

import { useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { EntitySwitcher, type EntitySwitcherItem } from '@/components/ui/EntitySwitcher';
import { formatAccountType, orderForPicker } from '@/lib/account-utils';
import { buildLogicalAccounts } from '@/lib/logical-accounts';
import { useMainAccountName } from '@/hooks/useMainAccountName';
import type { Account } from '@/types/account';
import { useInstitutionLogos } from '@/hooks/useInstitutionLogos';
import { AccountPickerIcon } from './AccountPickerIcon';

interface AccountSwitcherProps {
  /** The account currently on screen; it is not offered as a destination. */
  currentId: string;
  /** Accounts to switch between. Empty until the list has loaded. */
  accounts: readonly Account[];
  onSelect: (id: string) => void;
}

/**
 * A caret beside the account's name that jumps straight to another one, without
 * going back to the list. The menu, filter and keyboard behaviour are
 * `EntitySwitcher`'s; this only says what an account row looks like.
 */
export function AccountSwitcher({ currentId, accounts, onSelect }: AccountSwitcherProps) {
  const t = useTranslations('accountDetail');
  const tc = useTranslations('common');
  const stripAccountName = useMainAccountName();
  const institutionLogos = useInstitutionLogos();

  // A linked brokerage/cash pair is one account, so it is one entry here --
  // otherwise the switcher offers the same account twice, under two names the
  // user never chose.
  const logicalAccounts = useMemo(
    () => buildLogicalAccounts([...accounts], stripAccountName),
    [accounts, stripAccountName],
  );

  const items = useMemo<EntitySwitcherItem[]>(() => {
    // Favourites first, in the user's own arrangement, then the rest
    // alphabetically -- the order every account picker uses. A pair's star
    // lives on the row the accounts list draws, which is the primary, so
    // reading it there is what makes this menu agree with that list.
    // The name it sorts on is the one it SHOWS: `displayName` has the
    // " - Brokerage" suffix stripped, so ordering by the stored name would
    // read as unsorted.
    const { favourites, rest } = orderForPicker(logicalAccounts, (logical) => ({
      isFavourite: logical.primary.isFavourite,
      favouriteSortOrder: logical.primary.favouriteSortOrder,
      name: logical.displayName,
    }));
    // Sectioned only when a starred account will actually be OFFERED:
    // `EntitySwitcher` drops the account already on screen, so a reader whose
    // only favourite is the one they are looking at would otherwise get an
    // "Other accounts" heading over the whole list with nothing above it.
    const sectioned = favourites.some((logical) => logical.id !== currentId);
    const toItem = (
      logical: (typeof logicalAccounts)[number],
      group?: string,
    ): EntitySwitcherItem => {
      const type = formatAccountType(logical.primary.accountType, tc);
      const storedNames = logical.cash
        ? `${logical.primary.name} ${logical.cash.name}`
        : logical.primary.name;
      return {
        id: logical.id,
        primary: logical.displayName,
        // The type disambiguates the several accounts a reader names alike
        // ("Joint" at two banks), the same way the payee switcher shows a
        // default category.
        secondary: type,
        // Either ledger's stored name still finds the account it belongs to,
        // and a starred account stays findable from either section.
        searchText: `${logical.displayName} ${storedNames} ${type}`,
        group,
        icon: (
          <AccountPickerIcon
            institution={
              logical.primary.institutionId
                ? institutionLogos.get(logical.primary.institutionId)
                : undefined
            }
            accountType={logical.primary.accountType}
          />
        ),
      };
    };
    // Emitted favourites-first: `EntitySwitcher` takes its section order from
    // the order the items appear in.
    return [
      ...favourites.map((logical) =>
        toItem(logical, sectioned ? t('header.switchFavourites') : undefined),
      ),
      ...rest.map((logical) =>
        toItem(logical, sectioned ? t('header.switchOtherAccounts') : undefined),
      ),
    ];
  }, [logicalAccounts, currentId, institutionLogos, t, tc]);

  return (
    <EntitySwitcher
      currentId={currentId}
      items={items}
      onSelect={onSelect}
      triggerLabel={t('header.switchAccount')}
      filterPlaceholder={t('header.switchPlaceholder')}
      noMatchesLabel={t('header.switchNoMatches')}
      tall
    />
  );
}
