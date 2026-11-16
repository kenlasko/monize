'use client';

import { useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { EntitySwitcher, type EntitySwitcherItem } from '@/components/ui/EntitySwitcher';
import type { CurrencyInfo } from '@/lib/exchange-rates';

interface CurrencySwitcherProps {
  /** The currency on screen; it is not offered as a destination. */
  currentCode: string;
  /** Currencies to switch between. Empty until the list has loaded. */
  currencies: readonly CurrencyInfo[];
  onSelect: (code: string) => void;
}

/**
 * A caret beside the currency's name that jumps straight to another one,
 * without going back to the list. The menu, filter and keyboard behaviour are
 * `EntitySwitcher`'s; this only says what a currency row looks like.
 */
export function CurrencySwitcher({ currentCode, currencies, onSelect }: CurrencySwitcherProps) {
  const t = useTranslations('currencyDetail');

  const items = useMemo<EntitySwitcherItem[]>(
    () =>
      currencies.map((currency) => ({
        id: currency.code,
        primary: currency.code,
        secondary: currency.name,
        searchText: `${currency.code} ${currency.name}`,
      })),
    [currencies],
  );

  return (
    <EntitySwitcher
      currentId={currentCode}
      items={items}
      onSelect={onSelect}
      triggerLabel={t('header.switchCurrency')}
      filterPlaceholder={t('header.switchPlaceholder')}
      noMatchesLabel={t('header.switchNoMatches')}
    />
  );
}
