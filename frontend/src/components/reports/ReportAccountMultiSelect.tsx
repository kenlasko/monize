'use client';

import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useMainAccountName } from '@/hooks/useMainAccountName';
import { MultiSelect, type MultiSelectOption } from '@/components/ui/MultiSelect';
import { orderForPicker } from '@/lib/account-utils';
import { Account } from '@/types/account';
import { buildLogicalAccounts } from '@/lib/logical-accounts';
import { useAccountPickerIcon } from '@/components/accounts/shared/AccountPickerIcon';

// Rapid checkbox toggles (the typical multi-account selection flow) should
// collapse into a single reload once the user pauses, matching the debounce in
// DividendIncomeReport. Without it, every checkbox click immediately re-renders
// the host report into its loading skeleton, unmounting this dropdown and
// forcing the user to re-open it for each account.
const ACCOUNT_DEBOUNCE_MS = 350;

interface ReportAccountMultiSelectProps {
  accounts: Account[];
  value: string[];
  onChange: (values: string[]) => void;
  /**
   * Which half of a linked investment pair this report is asking about.
   *
   * The pair is one option either way -- the difference is only which id it
   * submits: `transactions` reads the cash ledger, `portfolio` reads the
   * holdings. Reports used to express this by passing opposite predicates
   * ("drop the brokerage" vs "drop the cash"), which made two pickers that look
   * identical submit different ids for the same account.
   */
  mode?: 'transactions' | 'portfolio';
  /**
   * An additional domain restriction -- accounts with an FX fee, non-investment
   * accounts. Applied to the underlying rows: an entity is offered when either
   * of its ledgers passes. Not the place to express the pair split; use `mode`.
   */
  filter?: (account: Account) => boolean;
  className?: string;
}

const sameIds = (a: string[], b: string[]) =>
  a.length === b.length && a.every((id, i) => id === b[i]);

export function ReportAccountMultiSelect({
  accounts,
  value,
  onChange,
  mode = 'transactions',
  filter,
  className = 'w-48',
}: ReportAccountMultiSelectProps) {
  const t = useTranslations('reports');
  const mainAccountName = useMainAccountName();
  const accountIcon = useAccountPickerIcon();
  // One option per account the user has, whichever ledger the report reads.
  // An entity with no ledger for this mode -- an orphan brokerage has no cash
  // register, an orphan cash half holds no securities -- is not offered,
  // because there is no id to submit for it.
  const offered = buildLogicalAccounts(accounts, mainAccountName)
    .filter((logical) =>
      filter ? logical.memberIds.some((id) => {
        const member = accounts.find((a) => a.id === id);
        return member ? filter(member) : false;
      }) : true,
    )
    .map((logical) => ({
      logical,
      id: mode === 'portfolio' ? logical.holdingsAccountId : logical.cashRegisterId,
    }))
    .filter((entry): entry is { logical: typeof entry.logical; id: string } =>
      entry.id !== null,
    );
  // Favourites first, in the user's own arrangement, then the rest
  // alphabetically -- the order every account picker uses
  // (`orderForPicker`). A pair's star lives on its primary row, as in the
  // account switcher, and the name sorted on is the one shown.
  const { favourites, rest } = orderForPicker(offered, (entry) => ({
    isFavourite: entry.logical.primary.isFavourite === true,
    favouriteSortOrder: entry.logical.primary.favouriteSortOrder ?? 0,
    name: entry.logical.displayName,
  }));
  const options: MultiSelectOption[] = [...favourites, ...rest].map((entry, index) => ({
    value: entry.id,
    label: entry.logical.displayName,
    icon: accountIcon(entry.logical.primary),
    // A rule between the favourites and the rest, when there are both.
    ...(index === favourites.length - 1 && rest.length > 0 ? { separatorAfter: true } : {}),
  }));

  // Local draft so checkbox toggles render instantly and the dropdown stays
  // open while selecting. The host report (which reloads its data from this
  // selection) is only notified after the user pauses.
  const [draft, setDraft] = useState(value);
  const [syncedValue, setSyncedValue] = useState(value);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Adopt external value changes (e.g. a reset) without a setState-in-effect.
  if (value !== syncedValue && !sameIds(value, syncedValue)) {
    setSyncedValue(value);
    setDraft(value);
  }

  // Cancel any pending debounced notification whenever the parent pushes a new
  // value. This covers the external-reset case: without it, a toggle made just
  // before the reset would still fire its (now stale) onChange after the reset
  // and clobber it. When our own debounce commits, the timer has already
  // cleared itself, so this is a no-op in the common path.
  useEffect(() => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
  }, [value]);

  useEffect(
    () => () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    },
    [],
  );

  const handleChange = (next: string[]) => {
    setDraft(next);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      debounceRef.current = null;
      onChange(next);
    }, ACCOUNT_DEBOUNCE_MS);
  };

  return (
    <div className={className}>
      <MultiSelect
        ariaLabel={t('reportAccountMultiSelect.ariaLabel')}
        placeholder={t('reportAccountMultiSelect.placeholder')}
        options={options}
        value={draft}
        onChange={handleChange}
      />
    </div>
  );
}
