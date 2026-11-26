'use client';

import { useEffect, useState } from 'react';
import type { RuleLookups } from '@/hooks/useRuleLookups';
import type { EditorAction } from '@/lib/rule-actions';
import { createLogger } from '@/lib/logger';
import { scheduledTransactionsApi } from '@/lib/scheduled-transactions';

const logger = createLogger('RuleEditor');

/** The linked bill of the loan a settlement action names, or null when the draft has none. */
export function settlementScheduleId(actions: readonly EditorAction[], lookups: RuleLookups): string | null {
  const settle = actions.find((action) => action.type === 'settle_loan_installment');
  if (settle === undefined || settle.type !== 'settle_loan_installment' || settle.loanAccountId === '') return null;
  return lookups.accounts.find((account) => account.id === settle.loanAccountId)?.scheduledTransactionId ?? null;
}

/**
 * What on the loan's linked bill posts itself: `'bill'` when the bill does,
 * `'occurrence'` when only an upcoming installment opted in on Edit Occurrence
 * (`anyOccurrenceAutoPosts`), `null` when nothing does. Either way the bill and
 * a settled bank debit could both pay an installment, so the editor warns.
 */
export type LoanBillAutoPost = 'bill' | 'occurrence' | null;

/** The answer for one bill as the single-bill read returns it. */
export function loanBillAutoPostOf(bill: {
  autoPost: boolean;
  anyOccurrenceAutoPosts?: boolean;
}): LoanBillAutoPost {
  if (bill.autoPost) return 'bill';
  return bill.anyOccurrenceAutoPosts ? 'occurrence' : null;
}

/**
 * `LoanBillAutoPost` for the loan a settlement action names. Fetched only
 * while a settlement names a loan with a bill; the answer is kept with the id
 * it was asked for, so a stale answer never warns about another loan, and a
 * failed lookup does not warn (unknown, not "off").
 */
export function useLoanBillAutoPost(scheduleId: string | null): LoanBillAutoPost {
  const [answer, setAnswer] = useState<{ id: string; kind: LoanBillAutoPost } | null>(null);
  useEffect(() => {
    if (scheduleId === null) return;
    let live = true;
    scheduledTransactionsApi
      .getById(scheduleId)
      .then((bill) => {
        if (live) setAnswer({ id: scheduleId, kind: loanBillAutoPostOf(bill) });
      })
      .catch((error: unknown) => {
        logger.warn('The loan bill could not be loaded', error);
      });
    return () => {
      live = false;
    };
  }, [scheduleId]);
  return answer !== null && answer.id === scheduleId ? answer.kind : null;
}
