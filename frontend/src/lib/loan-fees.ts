import apiClient from './api';
import { dedupe, invalidateCache } from './apiCache';
import type { LoanFee, LoanFeeBasis, LoanFeeCalculation, LoanFeeInput } from '@/types/loan-fee';

/**
 * A mortgage's fees (docs/specs/mortgage-fees.md section 7). A write changes
 * the lines and the amount of the mortgage's scheduled payment, so it drops
 * the scheduled caches with the fee list.
 */
function afterWrite(accountId: string): void {
  invalidateCache(`loan-fees:${accountId}`);
  invalidateCache('scheduled:');
}

/** The `accounts.loanFees.calculations.*` catalog key of each calculation. */
export const LOAN_FEE_CALCULATION_KEYS: Record<LoanFeeCalculation, string> = {
  FIXED: 'fixed',
  PERCENT_CURRENT_BALANCE: 'percentCurrentBalance',
  PERCENT_ORIGINAL_BALANCE: 'percentOriginalBalance',
};

export const loanFeesApi = {
  list: async (accountId: string): Promise<LoanFee[]> =>
    dedupe(`loan-fees:${accountId}`, async () => {
      const response = await apiClient.get<LoanFee[]>(`/accounts/${accountId}/loan-fees`);
      return response.data;
    }),

  /** Replace the whole set; the server updates the scheduled payment to match. */
  replace: async (accountId: string, fees: LoanFeeInput[]): Promise<LoanFee[]> => {
    const response = await apiClient.put<LoanFee[]>(`/accounts/${accountId}/loan-fees`, { fees });
    afterWrite(accountId);
    return response.data;
  },
};

/** One row of the fee editor: a fee being written, not yet validated. */
export interface LoanFeeDraft {
  /** A stable React key; never sent. */
  key: string;
  categoryId: string;
  name: string;
  calculation: LoanFeeCalculation;
  basis: LoanFeeBasis;
  /** The amount for a FIXED fee, the rate in percent otherwise. */
  value: number | undefined;
}

export function newLoanFeeDraft(): LoanFeeDraft {
  return {
    key: crypto.randomUUID(),
    categoryId: '',
    name: '',
    calculation: 'FIXED',
    basis: 'PER_PAYMENT',
    value: undefined,
  };
}

/** A stored fee as the editor holds it, at its stored precision. */
export function loanFeeToDraft(fee: LoanFee): LoanFeeDraft {
  return {
    key: fee.id,
    categoryId: fee.categoryId,
    name: fee.name,
    calculation: fee.calculation,
    basis: fee.basis,
    value: (fee.calculation === 'FIXED' ? fee.amount : fee.rate) ?? undefined,
  };
}

/** What is wrong with each draft, by field; an empty object when it is complete. */
export type LoanFeeDraftErrors = Partial<Record<'name' | 'categoryId' | 'value', 'required' | 'duplicate' | 'range'>>;

/**
 * The problems the server would refuse, found before the request: a missing
 * name, category or value, a category used twice or by the interest line, a
 * rate above 100 %.
 */
export function loanFeeDraftErrors(
  drafts: readonly LoanFeeDraft[],
  interestCategoryId?: string | null,
): LoanFeeDraftErrors[] {
  return drafts.map((draft, index) => {
    const errors: LoanFeeDraftErrors = {};
    if (!draft.name.trim()) errors.name = 'required';
    if (!draft.categoryId) errors.categoryId = 'required';
    else if (
      draft.categoryId === interestCategoryId ||
      drafts.some((other, j) => j < index && other.categoryId === draft.categoryId)
    ) {
      errors.categoryId = 'duplicate';
    }
    if (draft.value === undefined || !(draft.value > 0)) errors.value = 'required';
    else if (draft.calculation !== 'FIXED' && draft.value > 100) errors.value = 'range';
    return errors;
  });
}

/** The drafts as the API takes them. Call only once `loanFeeDraftErrors` is clean. */
export function loanFeeDraftsToInputs(drafts: readonly LoanFeeDraft[]): LoanFeeInput[] {
  return drafts.map((draft) => {
    const fixed = draft.calculation === 'FIXED';
    return {
      categoryId: draft.categoryId,
      name: draft.name.trim(),
      calculation: draft.calculation,
      basis: draft.basis,
      amount: fixed ? (draft.value ?? null) : null,
      rate: fixed ? null : (draft.value ?? null),
    };
  });
}
