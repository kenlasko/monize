'use client';

import { useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import type { EntitySwitcherItem } from '@/components/ui/EntitySwitcher';
import type { CollapsedHeaderSwitcher } from '@/store/mobileChromeStore';
import type { Security } from '@/types/investment';

/**
 * The caret beside the security's name that jumps straight to another one,
 * without going back to the list and picking Details again. The menu, filter
 * and keyboard behaviour are `EntitySwitcher`'s; this only says what a security
 * row looks like, what the filter matches and which securities are
 * destinations.
 *
 * Only active securities are offered, whatever list the caller loaded: an
 * inactive security is one the user has put away. The security on screen may
 * itself be inactive; it is never listed either way.
 *
 * Picking a security navigates, and the route is built here, as the report
 * switcher does. Returns `EntitySwitcher`'s props, memoized, so the header
 * draws the caret with `<EntitySwitcher {...switcher} />` and hands the very
 * same menu to the app header's collapsed title.
 *
 * @param securities Securities to switch between. Empty until the list has loaded.
 */
export function useSecuritySwitcher(
  currentId: string,
  securities: readonly Security[],
): CollapsedHeaderSwitcher {
  const t = useTranslations('securityDetail');
  const router = useRouter();

  const items = useMemo<EntitySwitcherItem[]>(
    () =>
      securities
        .filter((security) => security.isActive)
        .map((security) => ({
          id: security.id,
          primary: security.symbol,
          secondary: security.name,
          // A reader reaches for either the ticker or the name, so both match.
          searchText: `${security.symbol} ${security.name}`,
        })),
    [securities],
  );

  return useMemo<CollapsedHeaderSwitcher>(
    () => ({
      currentId,
      items,
      onSelect: (id: string) => router.push(`/securities/${id}`),
      triggerLabel: t('header.switchSecurity'),
      filterPlaceholder: t('header.switchPlaceholder'),
      noMatchesLabel: t('header.switchNoMatches'),
      secondaryAlign: 'inline',
    }),
    [currentId, items, router, t],
  );
}
