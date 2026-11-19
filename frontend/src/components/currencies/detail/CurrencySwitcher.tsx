'use client';

import { useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import type { EntitySwitcherItem } from '@/components/ui/EntitySwitcher';
import type { CollapsedHeaderSwitcher } from '@/store/mobileChromeStore';
import type { CurrencyInfo } from '@/lib/exchange-rates';

/**
 * The caret beside the currency's name that jumps straight to another one,
 * without going back to the list. The menu, filter and keyboard behaviour are
 * `EntitySwitcher`'s; this only says what a currency row looks like and which
 * currencies are destinations.
 *
 * Only active currencies are offered: the page loads inactive ones too (one
 * can be on screen), but an inactive currency is one the user has put away.
 * The currency on screen is never listed either way.
 *
 * Picking a currency navigates, and the route is built here, as the report
 * switcher does. Returns `EntitySwitcher`'s props, memoized, so the header
 * draws the caret with `<EntitySwitcher {...switcher} />` and hands the very
 * same menu to the app header's collapsed title.
 *
 * @param currencies Currencies to switch between. Empty until the list has loaded.
 */
export function useCurrencySwitcher(
  currentCode: string,
  currencies: readonly CurrencyInfo[],
): CollapsedHeaderSwitcher {
  const t = useTranslations('currencyDetail');
  const router = useRouter();

  const items = useMemo<EntitySwitcherItem[]>(
    () =>
      currencies
        .filter((currency) => currency.isActive)
        .map((currency) => ({
          id: currency.code,
          primary: currency.code,
          secondary: currency.name,
          searchText: `${currency.code} ${currency.name}`,
        })),
    [currencies],
  );

  return useMemo(
    () => ({
      currentId: currentCode,
      items,
      onSelect: (code: string) => router.push(`/currencies/${code}`),
      triggerLabel: t('header.switchCurrency'),
      filterPlaceholder: t('header.switchPlaceholder'),
      noMatchesLabel: t('header.switchNoMatches'),
    }),
    [currentCode, items, router, t],
  );
}
