import type {
  QuickAddAccountRef,
  QuickAddField,
  QuickAddInterpretation,
  QuickAddSource,
} from '@/types/quick-add';

/** One field of a reading; `source` defaults to typed. */
export function qaField<T>(
  value: T | null,
  source: QuickAddSource = 'typed',
  extra: Partial<Pick<QuickAddField<T>, 'ambiguous' | 'alternatives'>> = {},
): QuickAddField<T> {
  return { value, source, ambiguous: false, alternatives: [], ...extra };
}

/** A field the line did not give and nothing filled. */
export function qaMissing<T>(source: QuickAddSource = 'none'): QuickAddField<T> {
  return { value: null, source, ambiguous: false, alternatives: [] };
}

export const QA_CHEQUING: QuickAddAccountRef = { id: 'acc-chq', name: 'Chequing', currencyCode: 'USD' };
export const QA_SAVINGS: QuickAddAccountRef = { id: 'acc-sav', name: 'Savings', currencyCode: 'USD' };

/**
 * `84.37 loblaws groceries` read against a USD chequing account, as the plan's
 * "What should be observed" describes it: the kind guessed, the amount, payee
 * and category typed, the account and date assumed.
 */
export function qaPaymentReading(overrides: Partial<QuickAddInterpretation> = {}): QuickAddInterpretation {
  return {
    kind: qaField('payment', 'inferred'),
    amount: qaField(84.37),
    date: qaField('2026-11-20', 'default'),
    account: qaField(QA_CHEQUING, 'default'),
    toAccount: qaMissing(),
    payee: qaField({ id: 'payee-lob', name: 'Loblaws' }),
    category: qaField({ id: 'cat-groc', name: 'Food: Groceries' }),
    memo: null,
    blockers: [],
    balance: {
      accountId: QA_CHEQUING.id,
      currencyCode: 'USD',
      current: 1200,
      after: 1115.63,
      movesOn: null,
    },
    ...overrides,
  };
}

/** `500 chequing to savings`. */
export function qaTransferReading(overrides: Partial<QuickAddInterpretation> = {}): QuickAddInterpretation {
  return qaPaymentReading({
    kind: qaField('transfer', 'inferred'),
    amount: qaField(500),
    account: qaField(QA_CHEQUING),
    toAccount: qaField(QA_SAVINGS),
    payee: qaMissing(),
    category: qaMissing(),
    balance: { accountId: QA_CHEQUING.id, currencyCode: 'USD', current: 1200, after: 700, movesOn: null },
    ...overrides,
  });
}
