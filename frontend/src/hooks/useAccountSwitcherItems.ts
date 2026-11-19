'use client';

import { createElement, useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { Account } from '@/types/account';
import { formatAccountType, orderAccountsForPicker } from '@/lib/account-utils';
import type { EntitySwitcherItem } from '@/components/ui/EntitySwitcher';
import { AccountPickerIcon } from '@/components/accounts/shared/AccountPickerIcon';
import { useInstitutionLogos } from '@/hooks/useInstitutionLogos';

/**
 * An account switcher's rows: one per account the page's account filter
 * offers, each qualified by its type the way the account detail page's
 * switcher does, so alike-named accounts at two banks are told apart, and
 * marked with its institution's logo (else its type icon). The
 * order is `orderAccountsForPicker`'s -- the starred accounts in the order the
 * user arranged them, then the rest by name -- so the menu opens on the same
 * accounts, in the same order, as every account `<select>` in the app. The
 * Transactions page's Account Info widget, its folded bar and the app
 * header's collapsed title on Transactions and Investments all read it, so the
 * menus cannot drift apart.
 */
export function useAccountSwitcherItems(
  accounts: readonly Account[] | undefined,
  currentId: string | undefined,
  /** The name a row leads with; the Investments page strips " - Brokerage". Memoize it. */
  displayName?: (account: Account) => string,
): EntitySwitcherItem[] {
  const tc = useTranslations('common');
  // The account detail page's switcher copy, so the surfaces say the same thing.
  const ta = useTranslations('accountDetail');
  const institutionLogos = useInstitutionLogos();

  return useMemo<EntitySwitcherItem[]>(() => {
    const { favourites, rest } = orderAccountsForPicker(accounts ?? []);
    // Whether the menu is sectioned at all is decided by the favourites it will
    // actually OFFER, not by the ones the user has: `EntitySwitcher` drops the
    // account already on screen, so a reader whose only starred account is the
    // one they are looking at would otherwise get an "Other accounts" heading
    // over the whole list with nothing above it.
    const sectioned = favourites.some((candidate) => candidate.id !== currentId);
    const toItem = (candidate: Account, group?: string): EntitySwitcherItem => {
      const type = formatAccountType(candidate.accountType, tc);
      const name = displayName ? displayName(candidate) : candidate.name;
      return {
        id: candidate.id,
        primary: name,
        secondary: type,
        // A starred account is still findable by its own name and type, so
        // typing narrows across both sections rather than only below the fold.
        searchText: `${name} ${type}`,
        group,
        icon: createElement(AccountPickerIcon, {
          institution: candidate.institutionId
            ? institutionLogos.get(candidate.institutionId)
            : undefined,
          accountType: candidate.accountType,
        }),
      };
    };
    // Emitted favourites-first because `EntitySwitcher` takes its section order
    // from the order the items appear in.
    return [
      ...favourites.map((candidate) =>
        toItem(candidate, sectioned ? ta('header.switchFavourites') : undefined),
      ),
      ...rest.map((candidate) =>
        toItem(candidate, sectioned ? ta('header.switchOtherAccounts') : undefined),
      ),
    ];
  }, [accounts, currentId, displayName, institutionLogos, ta, tc]);
}
