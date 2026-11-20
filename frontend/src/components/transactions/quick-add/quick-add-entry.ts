import {
  TransactionStatus,
  type CreateTransactionData,
  type CreateTransferData,
} from '@/types/transaction';
import type { QuickAddInterpretation, QuickAddKind, QuickAddPins } from '@/types/quick-add';
import type { TransactionFormDraft } from '../transaction-form-draft';

/** What Save sends: the body New Transaction builds for the same fields. */
export type QuickAddSaveRequest =
  | { kind: 'transaction'; body: CreateTransactionData }
  | { kind: 'transfer'; body: CreateTransferData };

/**
 * The stored sign of an amount the reading holds as a magnitude
 * (`docs/financial-semantics.md`): a payment leaves the account, a deposit
 * arrives. A transfer keeps the magnitude; its legs are signed on the server.
 */
export function signedQuickAddAmount(kind: QuickAddKind, magnitude: number): number {
  const size = Math.abs(magnitude);
  return kind === 'payment' ? -size : size;
}

/**
 * The create call for a reading the server says can be saved, or null when it
 * cannot be (a blocker, or a field the blockers should have named is absent).
 * The body mirrors `TransactionForm`'s for these fields: the currency is the
 * account's, never the reading's guess, and cleared optional fields go as null.
 */
export function buildQuickAddSave(reading: QuickAddInterpretation): QuickAddSaveRequest | null {
  if (reading.blockers.length > 0) return null;
  const kind = reading.kind.value;
  const amount = reading.amount.value;
  const account = reading.account.value;
  const date = reading.date.value;
  if (kind === null || amount === null || amount === 0 || account === null || date === null) {
    return null;
  }
  const payee = reading.payee.value;
  if (kind === 'transfer') {
    const toAccount = reading.toAccount.value;
    if (toAccount === null || toAccount.id === account.id) return null;
    return {
      kind: 'transfer',
      body: {
        fromAccountId: account.id,
        toAccountId: toAccount.id,
        transactionDate: date,
        amount: Math.abs(amount),
        fromCurrencyCode: account.currencyCode,
        toCurrencyCode: toAccount.currencyCode,
        description: reading.memo ?? null,
        referenceNumber: null,
        status: TransactionStatus.UNRECONCILED,
        payeeId: payee?.id || null,
        payeeName: payee?.name || null,
        categoryId: null,
        tagIds: [],
      },
    };
  }
  return {
    kind: 'transaction',
    body: {
      accountId: account.id,
      transactionDate: date,
      payeeId: payee?.id || null,
      payeeName: payee?.name || null,
      categoryId: reading.category.value?.id || null,
      amount: signedQuickAddAmount(kind, amount),
      currencyCode: account.currencyCode,
      description: reading.memo ?? null,
      referenceNumber: null,
      status: TransactionStatus.UNRECONCILED,
      splits: undefined,
      tagIds: [],
    },
  };
}

/**
 * The entry handed to the full form: whatever the reading settled, blocked or
 * not, so a split or a foreign amount is finished there. Without a reading
 * (none yet, or the request failed) the reader's own pins are all there is.
 */
export function buildQuickAddDraft(
  reading: QuickAddInterpretation | null,
  pins: QuickAddPins,
): TransactionFormDraft {
  if (!reading) {
    const kind = pins.kind ?? 'payment';
    return {
      mode: kind === 'transfer' ? 'transfer' : 'normal',
      accountId: pins.accountId,
      toAccountId: kind === 'transfer' ? pins.toAccountId : undefined,
      amount: pins.amount === undefined ? undefined : signedQuickAddAmount(kind, pins.amount),
      date: pins.date,
      payeeId: pins.payeeId,
      payeeName: pins.payeeName,
      categoryId: kind === 'transfer' ? undefined : pins.categoryId,
    };
  }
  const kind = reading.kind.value ?? 'payment';
  const transfer = kind === 'transfer';
  const amount = reading.amount.value;
  const payee = reading.payee.value;
  return {
    mode: transfer ? 'transfer' : 'normal',
    accountId: reading.account.value?.id,
    toAccountId: transfer ? reading.toAccount.value?.id : undefined,
    amount: amount === null ? undefined : signedQuickAddAmount(kind, amount),
    date: reading.date.value ?? undefined,
    payeeId: payee?.id ?? undefined,
    payeeName: payee?.name,
    categoryId: transfer ? undefined : reading.category.value?.id,
    description: reading.memo ?? undefined,
  };
}
