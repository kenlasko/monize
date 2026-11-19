'use client';

import { useContext } from 'react';
import { useTranslations } from 'next-intl';
import { ChevronLeftIcon } from '@heroicons/react/24/outline';
import { Badge } from '@/components/ui/Badge';
import { EntitySwitcher } from '@/components/ui/EntitySwitcher';
import {
  CollapsingTitleContext,
  useCollapsingHeaderTitle,
} from '@/hooks/useCollapsingHeaderTitle';
import type { CurrencyInfo } from '@/lib/exchange-rates';
import { useCurrencySwitcher } from './CurrencySwitcher';

interface CurrencyDetailHeaderProps {
  currency: CurrencyInfo;
  /** The reader's reporting currency; its own page has no exchange rate. */
  defaultCurrency: string;
  onBack: () => void;
  /** Currencies the caret beside the name can jump to; inactive ones are left out. */
  currencies: readonly CurrencyInfo[];
}

/**
 * The identity block: which currency this is and how it is written, in the
 * layout of the payee and security detail headers. Editing and the rate
 * history dialog stay on the currencies list, where the row actions are.
 */
export function CurrencyDetailHeader({
  currency,
  defaultCurrency,
  onBack,
  currencies,
}: CurrencyDetailHeaderProps) {
  const t = useTranslations('currencyDetail');
  const tc = useTranslations('currencies');
  const isDefault = currency.code === defaultCurrency;
  const title = t('header.title', { code: currency.code, name: currency.name });
  const switcher = useCurrencySwitcher(currency.code, currencies);
  // Below `xl`, once the name scrolls behind the app header, the header reads
  // "Currencies - <this currency>" and carries the same caret.
  const collapses = useContext(CollapsingTitleContext);
  const titleRef = useCollapsingHeaderTitle<HTMLHeadingElement>(
    collapses ? { title: tc('page.title'), context: title, switcher } : null,
  );

  return (
    <div className="mb-6">
      <button
        type="button"
        onClick={onBack}
        className="mb-2 -ml-1 inline-flex items-center gap-1 rounded text-sm text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
      >
        <ChevronLeftIcon className="h-4 w-4" aria-hidden="true" />
        {t('backToCurrencies')}
      </button>

      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
        <div className="flex min-w-0 items-center gap-1">
          <h1 ref={titleRef} className="truncate text-2xl font-bold text-gray-900 dark:text-gray-100">
            {title}
          </h1>
          <EntitySwitcher {...switcher} />
        </div>
        {isDefault && <Badge variant="blue">{t('header.defaultBadge')}</Badge>}
        {currency.kind === 'CRYPTO' && <Badge variant="purple">{t('header.cryptoBadge')}</Badge>}
        {!currency.isActive && <Badge>{t('header.inactiveBadge')}</Badge>}
      </div>

      <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
        {t('header.subtitle', {
          symbol: currency.symbol,
          decimals: currency.decimalPlaces,
        })}
      </p>
    </div>
  );
}
