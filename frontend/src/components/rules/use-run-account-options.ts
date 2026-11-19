'use client';

import { useEffect, useMemo, useState } from 'react';
import { useAccountOptionLabel } from '@/hooks/useMainAccountName';
import type { RuleOption } from '@/components/rules/use-rule-options';
import { accountsApi } from '@/lib/accounts';
import { buildAccountDropdownOptions, SEPARATOR_VALUE } from '@/lib/account-utils';
import { createLogger } from '@/lib/logger';
import type { Account } from '@/types/account';

const logger = createLogger('RunAccountOptions');


export type RunAccountOptionsState =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; options: readonly RuleOption[] };

/**
 * The accounts a run can be limited to: the caller's own, since a rule may not
 * act on a shared one. The editor already holds them and passes `provided`;
 * the list page has nothing loaded and fetches them. A failed load is an
 * error with a retry, never an empty picker that would read as "all accounts".
 */
export function useRunAccountOptions(provided?: readonly RuleOption[]): {
  state: RunAccountOptionsState;
  reload: () => void;
} {
  const accountLabel = useAccountOptionLabel();
  const [loaded, setLoaded] = useState<{ status: 'loading' } | { status: 'error' } | { status: 'ready'; accounts: Account[] }>({
    status: 'loading',
  });
  const [attempt, setAttempt] = useState(0);
  const needsFetch = provided === undefined;

  useEffect(() => {
    if (!needsFetch) return;
    let cancelled = false;
    accountsApi
      .getAll(true)
      .then((accounts) => {
        if (!cancelled) setLoaded({ status: 'ready', accounts: accounts.filter((a) => !a.isJoint) });
      })
      .catch((error) => {
        if (cancelled) return;
        logger.error(error);
        setLoaded({ status: 'error' });
      });
    return () => {
      cancelled = true;
    };
  }, [needsFetch, attempt]);

  const fetched = useMemo(
    () =>
      loaded.status === 'ready'
        ? buildAccountDropdownOptions(loaded.accounts, () => true, accountLabel)
            .filter((option) => option.value !== SEPARATOR_VALUE)
            .map(({ value, label }) => ({ value, label }))
        : [],
    [loaded, accountLabel],
  );

  const state: RunAccountOptionsState = provided
    ? { status: 'ready', options: provided }
    : loaded.status === 'ready'
      ? { status: 'ready', options: fetched }
      : { status: loaded.status };

  return {
    state,
    reload: () => {
      setLoaded({ status: 'loading' });
      setAttempt((n) => n + 1);
    },
  };
}
