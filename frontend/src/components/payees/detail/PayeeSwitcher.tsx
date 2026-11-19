'use client';

import { useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import type { EntitySwitcherItem } from '@/components/ui/EntitySwitcher';
import type { CollapsedHeaderSwitcher } from '@/store/mobileChromeStore';
import type { Payee } from '@/types/payee';
import { PayeeLogo } from '@/components/payees/PayeeLogo';

/**
 * The caret beside the payee's name that jumps straight to another one, without
 * going back to the list and clicking again. The menu, filter and keyboard
 * behaviour are `EntitySwitcher`'s; this only says what a payee row looks like
 * and which payees are destinations.
 *
 * Only active payees are offered: a deactivated payee is one the user has put
 * away, and the switcher is for moving between the ones in use. The payee on
 * screen may itself be inactive; it is never listed either way.
 *
 * Picking a payee navigates, and the route is built here, as the report
 * switcher does. Returns `EntitySwitcher`'s props, memoized, so the header
 * draws the caret with `<EntitySwitcher {...switcher} />` and hands the very
 * same menu to the app header's collapsed title.
 *
 * @param payees Payees to switch between. Empty until the list has loaded.
 */
export function usePayeeSwitcher(
  currentId: string,
  payees: readonly Payee[],
): CollapsedHeaderSwitcher {
  const t = useTranslations('payeeDetail');
  const router = useRouter();

  const items = useMemo<EntitySwitcherItem[]>(
    () =>
      payees
        .filter((payee) => payee.isActive)
        .map((payee) => ({
          id: payee.id,
          primary: payee.name,
          secondary: payee.defaultCategory?.name,
          icon: <PayeeLogo payee={payee} size={20} />,
        })),
    [payees],
  );

  return useMemo(
    () => ({
      currentId,
      items,
      onSelect: (id: string) => router.push(`/payees/${id}`),
      triggerLabel: t('header.switchPayee'),
      filterPlaceholder: t('header.switchPlaceholder'),
      noMatchesLabel: t('header.switchNoMatches'),
    }),
    [currentId, items, router, t],
  );
}
