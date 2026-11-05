import { describe, it, expect } from 'vitest';
import type { Account } from '@/types/account';
import {
  crossCurrencyTransferTarget,
  receivedAmountToSend,
  splitTransferPair,
} from './split-transfer-currency';

const accounts = [
  { id: 'cad-chq', currencyCode: 'CAD', fxFeePercent: 2.5 },
  { id: 'usd-sav', currencyCode: 'USD', fxFeePercent: null },
  { id: 'usd-card', currencyCode: 'USD', fxFeePercent: 3 },
  { id: 'cad-sav', currencyCode: 'CAD', fxFeePercent: null },
] as unknown as Account[];

const transfer = (transferAccountId: string, amount: number, extra = {}) => ({
  splitType: 'transfer',
  transferAccountId,
  amount,
  ...extra,
});

describe('crossCurrencyTransferTarget', () => {
  it('names the target of a transfer line in another currency', () => {
    expect(crossCurrencyTransferTarget(transfer('usd-sav', -40), accounts, 'CAD')?.id).toBe('usd-sav');
  });

  it('is null for a same-currency target, an unknown one, or a category line', () => {
    expect(crossCurrencyTransferTarget(transfer('cad-sav', -40), accounts, 'CAD')).toBeNull();
    expect(crossCurrencyTransferTarget(transfer('gone', -40), accounts, 'CAD')).toBeNull();
    expect(
      crossCurrencyTransferTarget({ splitType: 'category', transferAccountId: 'usd-sav' }, accounts, 'CAD'),
    ).toBeNull();
  });
});

describe('splitTransferPair', () => {
  it('charges the parent fee when the line sends money out of it', () => {
    expect(splitTransferPair(transfer('usd-sav', -40), accounts, 'CAD', 'cad-chq', -1)).toEqual({
      toCurrency: 'USD',
      fxFeePercent: 2.5,
    });
  });

  it('charges the target fee when the line brings money in', () => {
    expect(splitTransferPair(transfer('usd-card', 40), accounts, 'CAD', 'cad-chq', -1)).toEqual({
      toCurrency: 'USD',
      fxFeePercent: 3,
    });
  });

  it('falls back to the receiving account fee when the sender has none', () => {
    // The fee-free USD account sends; the CAD account's fee is the only one.
    expect(splitTransferPair(transfer('usd-sav', 40), accounts, 'CAD', 'cad-chq', -1)?.fxFeePercent).toBe(2.5);
  });

  it('reads a zero line by the parent direction', () => {
    expect(splitTransferPair(transfer('usd-card', 0), accounts, 'CAD', 'cad-chq', 1)?.fxFeePercent).toBe(3);
    expect(splitTransferPair(transfer('usd-card', 0), accounts, 'CAD', 'cad-chq', -1)?.fxFeePercent).toBe(2.5);
  });

  it('is null for a same-currency line', () => {
    expect(splitTransferPair(transfer('cad-sav', -40), accounts, 'CAD', 'cad-chq', -1)).toBeNull();
  });
});

describe('receivedAmountToSend', () => {
  it('sends a cross-currency line figure stated against the current currency', () => {
    const line = transfer('usd-sav', -40, { transferTargetAmount: 29.2, transferTargetFromCurrency: 'CAD' });
    expect(receivedAmountToSend(line, accounts, 'CAD')).toBe(29.2);
  });

  it('sends nothing for a figure stated against another currency', () => {
    const line = transfer('usd-sav', -40, { transferTargetAmount: 29.2, transferTargetFromCurrency: 'EUR' });
    expect(receivedAmountToSend(line, accounts, 'CAD')).toBeUndefined();
  });

  it('sends nothing for a same-currency line', () => {
    const line = transfer('cad-sav', -40, { transferTargetAmount: 40, transferTargetFromCurrency: 'CAD' });
    expect(receivedAmountToSend(line, accounts, 'CAD')).toBeUndefined();
  });
});
