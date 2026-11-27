'use client';

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { accountsApi } from '@/lib/accounts';
import { categoriesApi } from '@/lib/categories';
import { getCategorySelectOptionsFor } from '@/lib/categoryUtils';
import { exchangeRatesApi } from '@/lib/exchange-rates';
import { createLogger } from '@/lib/logger';
import { payeesApi } from '@/lib/payees';
import type { Account, AccountType } from '@/types/account';
import { withCategoryIcons } from '@/components/categories/CategoryPickerIcon';
import { withPayeeIcons } from '@/components/payees/withPayeeIcons';

const logger = createLogger('ReceiptParserLookups');

export interface ReceiptParserOption {
  value: string;
  label: string;
  /** The row's mark in a picker: a payee's favicon, a category's glyph. */
  icon?: ReactNode;
}

/** An account a trade profile may name, or one a stored profile names. */
export interface ReceiptParserAccountOption extends ReceiptParserOption {
  currencyCode: string;
  /**
   * An open INVESTMENT account of the user's own that is not the cash sleeve:
   * the only kind the server lets a trade profile book to.
   */
  tradable: boolean;
  /** What the account picker draws the row's mark from. */
  accountType?: AccountType;
  institutionId?: string | null;
}

export interface ReceiptParserLookups {
  readonly payees: readonly ReceiptParserOption[];
  /** Every category in tree order, a child labelled `Parent: Child`. */
  readonly categories: readonly ReceiptParserOption[];
  /** Every account of the user's (closed ones too, so a stored id is named), A-Z. */
  readonly accounts: readonly ReceiptParserAccountOption[];
  /** The codes of the user's active currencies, for a trade profile's currency pickers. */
  readonly currencyCodes: readonly string[];
}

/** Whether a trade can be booked to this account (`usableTradeAccountIds` on the server). */
export const isTradableAccount = (account: Account): boolean =>
  account.accountType === 'INVESTMENT' &&
  account.accountSubType !== 'INVESTMENT_CASH' &&
  !account.isClosed &&
  account.isJoint !== true;

/** The user's accounts as the trade pickers and readings name them, A-Z. */
export function toReceiptAccountOptions(accounts: readonly Account[]): ReceiptParserAccountOption[] {
  return [...accounts]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((account) => ({
      value: account.id,
      label: account.name,
      currencyCode: account.currencyCode,
      tradable: isTradableAccount(account),
      accountType: account.accountType,
      institutionId: account.institutionId,
    }));
}

export type ReceiptParserLookupsState =
  | { readonly status: 'loading' }
  | { readonly status: 'error' }
  | { readonly status: 'ready'; readonly lookups: ReceiptParserLookups };

/** Where a stored account id stands: one a trade can be booked to, an account of the user's that is not one, or no account of theirs. */
export type TradeAccountStanding = 'tradable' | 'not_tradable' | 'unknown';

export function accountStanding(accounts: readonly ReceiptParserAccountOption[], accountId: string): TradeAccountStanding {
  const account = accounts.find((option) => option.value === accountId);
  if (!account) return 'unknown';
  return account.tradable ? 'tradable' : 'not_tradable';
}

/**
 * The lists the parser editor's pickers read: payees, categories, and for a
 * trade profile the accounts and the active currencies. Any one failing is a
 * failure of all: an editor with a list missing would show a stored id as a
 * blank field, and saving would send the blank over it.
 */
export function useReceiptParserLookups(): { state: ReceiptParserLookupsState; reload: () => void } {
  const [state, setState] = useState<ReceiptParserLookupsState>({ status: 'loading' });
  // Bumped by `reload`; each value is one request and only the newest answers.
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      // Inactive payees too: a stored parser may name one that was deactivated.
      payeesApi.getAll('all'),
      categoriesApi.getAll(),
      // Closed accounts too: a stored profile may name one that was closed since.
      accountsApi.getAll(true),
      exchangeRatesApi.getCurrencies(),
    ])
      .then(([payees, categories, accounts, currencies]) => {
        if (cancelled) return;
        setState({
          status: 'ready',
          lookups: {
            payees: withPayeeIcons(
              payees.map((p) => ({ value: p.id, label: p.name })),
              payees,
            ),
            categories: withCategoryIcons(
              getCategorySelectOptionsFor(categories, 'category').map(({ value, label }) => ({ value, label })),
              categories,
            ),
            accounts: toReceiptAccountOptions(accounts),
            currencyCodes: currencies.filter((currency) => currency.isActive).map((currency) => currency.code),
          },
        });
      })
      .catch((error) => {
        if (cancelled) return;
        logger.error(error);
        setState({ status: 'error' });
      });
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  const reload = useCallback(() => {
    setState({ status: 'loading' });
    setAttempt((n) => n + 1);
  }, []);

  return { state, reload };
}
