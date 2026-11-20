import {
  TransactionStatus,
  type CreateTransactionData,
  type CreateTransferData,
} from '@/types/transaction';
import { roundToEntryPlaces } from '@/lib/format';
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
 * The save with the payee the line named swapped for the one the save just
 * created or reactivated, so the row is linked to it rather than carrying its
 * name as text.
 */
export function withSavedPayee(
  request: QuickAddSaveRequest,
  payee: { id: string; name: string },
): QuickAddSaveRequest {
  return request.kind === 'transfer'
    ? { kind: 'transfer', body: { ...request.body, payeeId: payee.id, payeeName: payee.name } }
    : { kind: 'transaction', body: { ...request.body, payeeId: payee.id, payeeName: payee.name } };
}

/** What Full Form hands over when there is no reading to build from. */
export interface QuickAddDraftFallback {
  /** The line as typed: it becomes the description, so the words are not lost. */
  text: string;
  /** The reader's own pins, already stripped of any the server refused. */
  pins: QuickAddPins;
}

/**
 * The entry handed to the full form: whatever the reading settled, blocked or
 * not, so a split or a foreign amount is finished there.
 *
 * - A figure typed in another currency goes over in that currency when the
 *   reading names it (the form's foreign entry, signed like any amount), and
 *   with no amount at all when it does not: it is never an account-currency
 *   figure. A transfer has no foreign entry in the form, so it goes without.
 * - An amount goes at its currency's entry places, so the form submits the
 *   figure it shows (a reading blocked by `amountPrecision` carries more).
 * - An ambiguous account is not preselected.
 *
 * Without a reading (none arrived, or the request failed or was refused) the
 * typed line goes over as the description beside the reader's pins.
 */
export function buildQuickAddDraft(
  reading: QuickAddInterpretation | null,
  fallback: QuickAddDraftFallback,
): TransactionFormDraft {
  if (!reading) {
    const { pins } = fallback;
    const kind = pins.kind ?? 'payment';
    const transfer = kind === 'transfer';
    const description = fallback.text.trim();
    return {
      mode: transfer ? 'transfer' : 'normal',
      accountId: pins.accountId,
      toAccountId: transfer ? pins.toAccountId : undefined,
      amount: pins.amount === undefined ? undefined : signedQuickAddAmount(kind, pins.amount),
      date: pins.date,
      payeeId: pins.payeeId,
      payeeName: pins.payeeName,
      categoryId: transfer ? undefined : pins.categoryId,
      description: description || undefined,
    };
  }
  const kind = reading.kind.value ?? 'payment';
  const transfer = kind === 'transfer';
  const account = reading.account.ambiguous ? null : reading.account.value;
  const toAccount = reading.toAccount.ambiguous ? null : reading.toAccount.value;
  const amount = reading.amount.value;
  const foreign = reading.foreignAmount;
  const foreignEntry = !transfer && foreign?.currencyCode ? foreign : null;
  const payee = reading.payee.value;
  return {
    mode: transfer ? 'transfer' : 'normal',
    accountId: account?.id,
    toAccountId: transfer ? toAccount?.id : undefined,
    amount:
      foreign || amount === null
        ? undefined
        : // At the currency the reading read it in, chosen or not.
          roundToEntryPlaces(signedQuickAddAmount(kind, amount), reading.account.value?.currencyCode),
    ...(foreignEntry?.currencyCode
      ? {
          // `foreignAmount` is set exactly when the reading's `amount` is not
          // in the account's currency, so `amount` above stays unset.
          originalCurrencyCode: foreignEntry.currencyCode,
          originalAmount: roundToEntryPlaces(
            signedQuickAddAmount(kind, foreignEntry.amount),
            foreignEntry.currencyCode,
          ),
        }
      : {}),
    date: reading.date.value ?? undefined,
    payeeId: payee?.id ?? undefined,
    payeeName: payee?.name,
    categoryId: transfer ? undefined : reading.category.value?.id,
    description: reading.memo ?? undefined,
  };
}
