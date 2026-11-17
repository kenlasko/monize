'use client';

import { useState } from 'react';
import {
  readTransactionsRegisterSnapshot,
  type TransactionsRegisterSnapshot,
} from '@/lib/transactions-page-snapshot';

/**
 * Draws the register's last answer at once on a return, but only when it
 * answered this very request: `requestKey` is `registerRequestKey` of the
 * filters, order and page now in force, or `null` until the filters have
 * initialised. `adopt` writes the snapshot into the page's state; it runs at
 * most once, during render (the "information from the previous render"
 * pattern), and only while the page is still loading. The page's own load
 * runs either way and replaces it.
 */
export function useTransactionsRegisterSnapshot(
  isLoading: boolean,
  requestKey: string | null,
  adopt: (snapshot: TransactionsRegisterSnapshot) => void,
): void {
  const [snapshot] = useState(readTransactionsRegisterSnapshot);
  const [adopted, setAdopted] = useState(false);
  if (isLoading && !adopted && snapshot && requestKey !== null && snapshot.key === requestKey) {
    setAdopted(true);
    adopt(snapshot);
  }
}
