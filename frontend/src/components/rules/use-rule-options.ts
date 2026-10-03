'use client';

import { useMemo } from 'react';
import { useAccountOptionLabel } from '@/hooks/useMainAccountName';
import type { RuleLookups } from '@/hooks/useRuleLookups';
import { buildAccountDropdownOptions } from '@/lib/account-utils';
import { getCategorySelectOptions } from '@/lib/categoryUtils';
import type { Category } from '@/types/category';

export interface RuleOption {
  value: string;
  label: string;
}

/** The lists the editor's pickers offer, built once from the loaded lookups. */
export interface RuleOptions {
  readonly accounts: RuleOption[];
  /**
   * The accounts a transfer may name: the transfer form's own rule (no
   * brokerage account, no closed one), in the same order and labels as `accounts`.
   */
  readonly transferAccounts: RuleOption[];
  readonly payees: RuleOption[];
  readonly categories: RuleOption[];
  readonly tags: RuleOption[];
  readonly currencyCodes: readonly string[];
}

const SEPARATOR = '__separator__';

export function useRuleOptions(lookups: RuleLookups): RuleOptions {
  const accountLabel = useAccountOptionLabel();
  return useMemo(
    () => ({
      accounts: buildAccountDropdownOptions([...lookups.accounts], () => true, accountLabel)
        .filter((option) => option.value !== SEPARATOR)
        .map(({ value, label }) => ({ value, label })),
      transferAccounts: buildAccountDropdownOptions(
        [...lookups.accounts],
        (account) => account.accountSubType !== 'INVESTMENT_BROKERAGE' && !account.isClosed,
        accountLabel,
      )
        .filter((option) => option.value !== SEPARATOR)
        .map(({ value, label }) => ({ value, label })),
      payees: lookups.payees.map((p) => ({ value: p.id, label: p.name })),
      categories: getCategorySelectOptions(lookups.categories as Category[]),
      tags: lookups.tags.map((t) => ({ value: t.id, label: t.name })),
      currencyCodes: lookups.currencyCodes,
    }),
    [lookups, accountLabel],
  );
}
