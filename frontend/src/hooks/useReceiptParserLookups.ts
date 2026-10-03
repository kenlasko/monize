'use client';

import { useCallback, useEffect, useState } from 'react';
import { categoriesApi } from '@/lib/categories';
import { getCategorySelectOptions } from '@/lib/categoryUtils';
import { createLogger } from '@/lib/logger';
import { payeesApi } from '@/lib/payees';

const logger = createLogger('ReceiptParserLookups');

export interface ReceiptParserOption {
  value: string;
  label: string;
}

export interface ReceiptParserLookups {
  readonly payees: readonly ReceiptParserOption[];
  /** Every category in tree order, a child labelled `Parent: Child`. */
  readonly categories: readonly ReceiptParserOption[];
}

export type ReceiptParserLookupsState =
  | { readonly status: 'loading' }
  | { readonly status: 'error' }
  | { readonly status: 'ready'; readonly lookups: ReceiptParserLookups };

/**
 * The two lists the parser editor's pickers read. Either failing is a failure
 * of both: an editor with the category list missing would show a stored
 * category id as a blank field, and saving would send the blank over it.
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
    ])
      .then(([payees, categories]) => {
        if (cancelled) return;
        setState({
          status: 'ready',
          lookups: {
            payees: payees.map((p) => ({ value: p.id, label: p.name })),
            categories: getCategorySelectOptions(categories).map(({ value, label }) => ({ value, label })),
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
