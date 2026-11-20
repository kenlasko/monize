'use client';

import { useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { getMainAccountName } from '@/lib/account-utils';
import { formatAccountOptionLabel } from '@/lib/logical-accounts';
import { labelWithForeignCurrency, preferredCurrency } from '@/lib/default-currency';
import { usePreferencesStore } from '@/store/preferencesStore';
import { Account } from '@/types/account';

/**
 * Returns a stable function that strips the " - Brokerage"/" - Cash" suffix
 * from a linked investment account name. Investment pair names are generated
 * server-side with a localized suffix, so the stripper uses the current
 * locale's translated words; the English originals are always stripped too so
 * accounts created in English (or before localization) still resolve.
 */
export function useMainAccountName(): (name: string) => string {
  const t = useTranslations('accounts');
  // Keyed on the resolved words rather than on `t`, whose identity is not
  // stable across renders: a stripper that changes every render invalidates
  // every memo built on it, and re-runs every effect that depends on one.
  const brokerageSuffix = t('nameSuffix.brokerage');
  const cashSuffix = t('nameSuffix.cash');
  return useCallback(
    (name: string) => getMainAccountName(name, [brokerageSuffix, cashSuffix]),
    [brokerageSuffix, cashSuffix],
  );
}

/** The reader's default currency, falling back the way every surface does. */
function useDefaultCurrency(): string {
  return preferredCurrency(
    usePreferencesStore((state) => state.preferences?.defaultCurrency),
  );
}

/**
 * Appends a currency code to a picker label only when it is not the reader's
 * default currency (`labelWithForeignCurrency`). For a picker whose label is
 * not an account option -- a security, or a list that keeps the stored name.
 */
export function useForeignCurrencyLabel(): (
  label: string,
  currencyCode: string,
) => string {
  const defaultCurrency = useDefaultCurrency();
  return useCallback(
    (label: string, currencyCode: string) =>
      labelWithForeignCurrency(label, currencyCode, defaultCurrency),
    [defaultCurrency],
  );
}

/**
 * The one way an account picker labels its options: the account's name with any
 * investment pair suffix stripped, its currency when that is not the user's
 * default currency, and a closed marker.
 *
 * Every picker uses this rather than building a label from `account.name`, so a
 * linked cash half reads as the account the user knows ("TFSA") instead of
 * exposing the storage detail ("TFSA - Cash"). Pass it to
 * `buildAccountDropdownOptions` as the `labelFn`.
 */
export function useAccountOptionLabel(options: {
  /**
   * Narrow rows (a split line) drop the currency; everything else shows it for
   * an account outside the user's default currency.
   */
  withCurrency?: boolean;
} = {}): (account: Account) => string {
  const stripName = useMainAccountName();
  const t = useTranslations('accounts');
  const closedLabel = t('row.statusClosed');
  const withCurrency = options.withCurrency ?? true;
  const defaultCurrency = useDefaultCurrency();
  return useCallback(
    (account: Account) =>
      formatAccountOptionLabel(account, stripName, closedLabel, {
        withCurrency,
        defaultCurrency,
      }),
    [stripName, closedLabel, withCurrency, defaultCurrency],
  );
}
