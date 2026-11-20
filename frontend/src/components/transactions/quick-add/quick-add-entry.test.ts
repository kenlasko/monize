import { describe, it, expect } from 'vitest';
import { TransactionStatus } from '@/types/transaction';
import { qaField, qaMissing, qaPaymentReading, qaTransferReading } from '@/test/quick-add-fixtures';
import { buildQuickAddDraft, buildQuickAddSave } from './quick-add-entry';

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

  it('sends a new payee by name with no id, for the server to create', () => {
    const request = buildQuickAddSave(qaPaymentReading({ payee: qaField({ id: null, name: 'Corner Cafe' }) }));
    expect(request?.body).toMatchObject({ payeeId: null, payeeName: 'Corner Cafe' });
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
    const reading = qaPaymentReading({ blockers: ['foreignCurrency'], memo: 'latte' });
    expect(buildQuickAddDraft(reading, {})).toEqual({
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
    expect(buildQuickAddDraft(qaTransferReading(), {})).toMatchObject({
      mode: 'transfer',
      accountId: 'acc-chq',
      toAccountId: 'acc-sav',
      amount: 500,
      categoryId: undefined,
    });
  });

  it('falls back to the pins when there is no reading', () => {
    expect(buildQuickAddDraft(null, { kind: 'deposit', amount: 20, accountId: 'acc-chq' })).toMatchObject({
      mode: 'normal',
      accountId: 'acc-chq',
      amount: 20,
    });
  });
});
