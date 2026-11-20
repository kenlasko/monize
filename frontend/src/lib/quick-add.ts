import apiClient from './api';
import type {
  QuickAddField,
  QuickAddInterpretRequest,
  QuickAddInterpretation,
} from '@/types/quick-add';

/**
 * The longest line the server reads (`QUICK_ADD_TEXT_MAX_LENGTH` in
 * `backend/src/transactions/quick-add/dto/quick-add-interpret.dto.ts`); a
 * longer one (counted after NFKC, `isQuickAddTextTooLong`) is refused with
 * 400, so the dialog and the palette do not ask.
 */
export const QUICK_ADD_TEXT_MAX_LENGTH = 200;

/**
 * Whether the server would refuse `text` as too long. It counts after NFKC
 * normalizing, which can expand one character into many (an ellipsis, U+FDFA),
 * so the box's raw `maxLength` alone cannot keep a line inside the bound.
 */
export function isQuickAddTextTooLong(text: string): boolean {
  return text.normalize('NFKC').length > QUICK_ADD_TEXT_MAX_LENGTH;
}

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
