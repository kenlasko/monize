import { describe, it, expect } from 'vitest';
import { TransactionStatus } from '@/types/transaction';
import { QA_CHEQUING, qaField, qaMissing, qaPaymentReading, qaTransferReading } from '@/test/quick-add-fixtures';
import { buildQuickAddDraft, buildQuickAddSave, withSavedPayee } from './quick-add-entry';

const NO_LINE = { text: '', pins: {} };

describe('buildQuickAddSave', () => {
  it('sends a payment negative, in the account currency, with the form body', () => {
    expect(buildQuickAddSave(qaPaymentReading({ memo: 'weekly shop' }))).toEqual({
      kind: 'transaction',
      body: {
        accountId: 'acc-chq',
        transactionDate: '2026-11-20',
        payeeId: 'payee-lob',
        payeeName: 'Loblaws',
        categoryId: 'cat-groc',
        amount: -84.37,
        currencyCode: 'USD',
        description: 'weekly shop',
        referenceNumber: null,
        status: TransactionStatus.UNRECONCILED,
        splits: undefined,
        tagIds: [],
      },
    });
  });

  it('sends a deposit positive', () => {
    const request = buildQuickAddSave(qaPaymentReading({ kind: qaField('deposit') }));
    expect(request?.kind).toBe('transaction');
    expect(request?.body).toMatchObject({ amount: 84.37 });
  });

  it('builds a payee nobody has yet by name, for the save to create and swap in', () => {
    const request = buildQuickAddSave(qaPaymentReading({ payee: qaField({ id: null, name: 'Corner Cafe' }) }));
    expect(request?.body).toMatchObject({ payeeId: null, payeeName: 'Corner Cafe' });
    expect(withSavedPayee(request!, { id: 'p-new', name: 'Corner Cafe' }).body).toMatchObject({
      payeeId: 'p-new',
      payeeName: 'Corner Cafe',
      amount: -84.37,
    });
  });

  it('saves a payee or category the reader cleared as none', () => {
    const request = buildQuickAddSave(
      qaPaymentReading({ payee: qaMissing('pinned'), category: qaMissing('pinned') }),
    );
    expect(request?.body).toMatchObject({ payeeId: null, payeeName: null, categoryId: null });
  });

  it('sends a transfer as its magnitude from the account to the to-account', () => {
    expect(buildQuickAddSave(qaTransferReading())).toEqual({
      kind: 'transfer',
      body: {
        fromAccountId: 'acc-chq',
        toAccountId: 'acc-sav',
        transactionDate: '2026-11-20',
        amount: 500,
        fromCurrencyCode: 'USD',
        toCurrencyCode: 'USD',
        description: null,
        referenceNumber: null,
        status: TransactionStatus.UNRECONCILED,
        payeeId: null,
        payeeName: null,
        categoryId: null,
        tagIds: [],
      },
    });
  });

  it("carries a transfer's leftover words as its description", () => {
    expect(buildQuickAddSave(qaTransferReading({ memo: 'rent top-up' }))?.body).toMatchObject({
      description: 'rent top-up',
    });
  });

  it('builds nothing for a blocked reading', () => {
    expect(buildQuickAddSave(qaPaymentReading({ blockers: ['foreignCurrency'] }))).toBeNull();
    expect(buildQuickAddSave(qaPaymentReading({ amount: qaMissing() }))).toBeNull();
    expect(buildQuickAddSave(qaTransferReading({ toAccount: qaMissing() }))).toBeNull();
  });
});

describe('buildQuickAddDraft', () => {
  it('hands a blocked payment over signed, with what the line settled', () => {
    const reading = qaPaymentReading({ blockers: ['ambiguousAccount'], memo: 'latte' });
    expect(buildQuickAddDraft(reading, NO_LINE)).toEqual({
      mode: 'normal',
      accountId: 'acc-chq',
      toAccountId: undefined,
      amount: -84.37,
      date: '2026-11-20',
      payeeId: 'payee-lob',
      payeeName: 'Loblaws',
      categoryId: 'cat-groc',
      description: 'latte',
    });
  });

  it('hands a transfer over as a transfer, with no category', () => {
    expect(buildQuickAddDraft(qaTransferReading(), NO_LINE)).toMatchObject({
      mode: 'transfer',
      accountId: 'acc-chq',
      toAccountId: 'acc-sav',
      amount: 500,
      categoryId: undefined,
    });
  });

  it('hands the typed line over as the description beside the pins when there is no reading', () => {
    expect(
      buildQuickAddDraft(null, {
        text: '  20 corner cafe ',
        pins: { kind: 'deposit', amount: 20, accountId: 'acc-chq' },
      }),
    ).toMatchObject({
      mode: 'normal',
      accountId: 'acc-chq',
      amount: 20,
      description: '20 corner cafe',
    });
  });

  it('hands a figure typed in another currency over in that currency, never as the account\'s', () => {
    const reading = qaPaymentReading({
      // 20 € against a USD account.
      amount: qaField(20),
      blockers: ['foreignCurrency'],
      foreignAmount: { currencyCode: 'EUR', amount: 20 },
    });
    const draft = buildQuickAddDraft(reading, NO_LINE);
    expect(draft).toMatchObject({ mode: 'normal', accountId: 'acc-chq', originalCurrencyCode: 'EUR', originalAmount: -20 });
    expect(draft.amount).toBeUndefined();
  });

  it('hands a figure typed in a currency over alone while no account is known', () => {
    const draft = buildQuickAddDraft(
      qaPaymentReading({
        amount: qaField(20),
        account: qaMissing(),
        blockers: ['missingAccount'],
        balance: null,
        foreignAmount: { currencyCode: 'EUR', amount: 20 },
      }),
      NO_LINE,
    );
    expect(draft).toMatchObject({ originalCurrencyCode: 'EUR', originalAmount: -20 });
    expect(draft.accountId).toBeUndefined();
    expect(draft.amount).toBeUndefined();
  });

  it('hands a figure typed in the account\'s own currency over as a plain amount', () => {
    const draft = buildQuickAddDraft(
      qaPaymentReading({
        amount: qaField(20),
        blockers: ['foreignCurrency'],
        foreignAmount: { currencyCode: 'usd', amount: 20 },
      }),
      NO_LINE,
    );
    expect(draft.amount).toBe(-20);
    expect(draft.originalCurrencyCode).toBeUndefined();
    expect(draft.originalAmount).toBeUndefined();
  });

  it('hands no amount at all when the typed currency is not known', () => {
    const draft = buildQuickAddDraft(
      qaPaymentReading({
        amount: qaField(20),
        blockers: ['foreignCurrency'],
        foreignAmount: { currencyCode: null, amount: 20 },
      }),
      NO_LINE,
    );
    expect(draft.amount).toBeUndefined();
    expect(draft.originalCurrencyCode).toBeUndefined();
    expect(draft.originalAmount).toBeUndefined();
    expect(draft).toMatchObject({ accountId: 'acc-chq', payeeId: 'payee-lob' });
  });

  it('does not preselect an account that matched others equally', () => {
    const draft = buildQuickAddDraft(
      qaPaymentReading({
        account: qaField(QA_CHEQUING, 'typed', {
          ambiguous: true,
          alternatives: [{ id: 'acc-chq2', name: 'Chequing 2', currencyCode: 'USD' }],
        }),
        blockers: ['ambiguousAccount'],
      }),
      NO_LINE,
    );
    expect(draft.accountId).toBeUndefined();
    expect(draft).toMatchObject({ amount: -84.37, payeeId: 'payee-lob', categoryId: 'cat-groc' });
  });

  it('hands an amount over at its currency\'s entry places, the figure the form will submit', () => {
    const draft = buildQuickAddDraft(
      qaPaymentReading({ amount: qaField(84.375), blockers: ['amountPrecision'] }),
      NO_LINE,
    );
    expect(draft.amount).toBe(-84.38);
  });
});
