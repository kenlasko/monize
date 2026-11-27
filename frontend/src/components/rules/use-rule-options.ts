'use client';

import { createElement, useMemo, type ReactNode } from 'react';
import { AccountPickerIcon } from '@/components/accounts/shared/AccountPickerIcon';
import { withCategoryIcons } from '@/components/categories/CategoryPickerIcon';
import { withPayeeIcons } from '@/components/payees/withPayeeIcons';
import { useInstitutionLogos } from '@/hooks/useInstitutionLogos';
import { useAccountOptionLabel } from '@/hooks/useMainAccountName';
import type { RuleLookups } from '@/hooks/useRuleLookups';
import { buildAccountDropdownOptions, SEPARATOR_VALUE } from '@/lib/account-utils';
import { getCategorySelectOptions, getCategorySelectOptionsFor } from '@/lib/categoryUtils';
import type { Account } from '@/types/account';
import type { Category } from '@/types/category';

export interface RuleOption {
  value: string;
  label: string;
  /** The row's mark in a single-value picker (a `Combobox`); lists ignore it. */
  icon?: ReactNode;
}

/** The lists the editor's pickers offer, built once from the loaded lookups. */
export interface RuleOptions {
  readonly accounts: RuleOption[];
  /**
   * The accounts a transfer may name: the transfer form's own rule (no
   * brokerage account, no closed one), in the same order and labels as `accounts`.
   */
  readonly transferAccounts: RuleOption[];
  /** The loans a settlement may pay: the open `MORTGAGE` and `LOAN` accounts, same order and labels. */
  readonly loanAccounts: RuleOption[];
  readonly payees: RuleOption[];
  readonly categories: RuleOption[];
  /**
   * The categories a transfer may take: every type, Transfer categories
   * first (INV-CATEGORY-001), for a conversion's category.
   */
  readonly transferCategories: RuleOption[];
  readonly tags: RuleOption[];
  readonly currencyCodes: readonly string[];
}


export function useRuleOptions(lookups: RuleLookups): RuleOptions {
  const accountLabel = useAccountOptionLabel();
  const institutionLogos = useInstitutionLogos();
  return useMemo(() => {
    const accountsById = new Map(lookups.accounts.map((account) => [account.id, account]));
    const withAccountIcon = ({ value, label }: RuleOption): RuleOption => {
      const account: Account | undefined = accountsById.get(value);
      if (!account) return { value, label };
      return {
        value,
        label,
        icon: createElement(AccountPickerIcon, {
          institution: account.institutionId ? institutionLogos.get(account.institutionId) : undefined,
          accountType: account.accountType,
        }),
      };
    };
    return {
      accounts: buildAccountDropdownOptions([...lookups.accounts], () => true, accountLabel)
        .filter((option) => option.value !== SEPARATOR_VALUE)
        .map(withAccountIcon),
      transferAccounts: buildAccountDropdownOptions(
        [...lookups.accounts],
        (account) => account.accountSubType !== 'INVESTMENT_BROKERAGE' && !account.isClosed,
        accountLabel,
      )
        .filter((option) => option.value !== SEPARATOR_VALUE)
        .map(withAccountIcon),
      loanAccounts: buildAccountDropdownOptions(
        [...lookups.accounts],
        (account) => (account.accountType === 'MORTGAGE' || account.accountType === 'LOAN') && !account.isClosed,
        accountLabel,
      )
        .filter((option) => option.value !== SEPARATOR_VALUE)
        .map(withAccountIcon),
      payees: withPayeeIcons(
        lookups.payees.map((p) => ({ value: p.id, label: p.name })),
        lookups.payees,
      ),
      categories: withCategoryIcons(
        getCategorySelectOptions(lookups.categories as Category[]),
        lookups.categories,
      ),
      transferCategories: withCategoryIcons(
        getCategorySelectOptionsFor(lookups.categories as Category[], 'transfer'),
        lookups.categories,
      ),
      tags: lookups.tags.map((t) => ({ value: t.id, label: t.name })),
      currencyCodes: lookups.currencyCodes,
    };
  }, [lookups, accountLabel, institutionLogos]);
}
