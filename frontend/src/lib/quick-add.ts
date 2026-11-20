import apiClient from './api';
import type {
  QuickAddField,
  QuickAddInterpretRequest,
  QuickAddInterpretation,
} from '@/types/quick-add';

/**
 * The longest line the server reads (`QUICK_ADD_TEXT_MAX_LENGTH` in
 * `backend/src/transactions/quick-add/dto/quick-add-interpret.dto.ts`); a
 * longer one is refused with 400, so the box stops there and the palette does
 * not ask.
 */
export const QUICK_ADD_TEXT_MAX_LENGTH = 200;

/** `NUMERIC` can cross the wire as a decimal string; the readers branch on a number. */
function numericField(field: QuickAddField<number | string>): QuickAddField<number> {
  return {
    ...field,
    value: field.value === null || field.value === undefined ? null : Number(field.value),
    alternatives: field.alternatives.map((value) => Number(value)),
  };
}

/** The reading with its money as numbers, whatever the wire carried. */
export function normalizeQuickAddInterpretation(
  raw: QuickAddInterpretation,
): QuickAddInterpretation {
  const balance = raw.balance;
  const foreign = raw.foreignAmount;
  return {
    ...raw,
    amount: numericField(raw.amount as QuickAddField<number | string>),
    balance: balance
      ? {
          ...balance,
          current: Number(balance.current),
          after: balance.after === null || balance.after === undefined ? null : Number(balance.after),
        }
      : null,
    // Absent reads as none: a figure in another currency is never guessed.
    foreignAmount: foreign
      ? { currencyCode: foreign.currencyCode ?? null, amount: Number(foreign.amount) }
      : null,
  };
}

export const quickAddApi = {
  // Read a typed line as a payment, deposit or transfer. Read-only: the
  // server writes nothing, so no cache is dropped here; the save goes through
  // `transactionsApi.create` / `createTransfer`, which drop the balances.
  interpret: async (request: QuickAddInterpretRequest): Promise<QuickAddInterpretation> => {
    const response = await apiClient.post<QuickAddInterpretation>(
      '/transactions/quick-add/interpret',
      request,
    );
    return normalizeQuickAddInterpretation(response.data);
  },
};
