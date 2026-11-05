import { Account } from '@/types/account';
import {
  currentTransferTargetAmount,
  SplitFxPair,
} from './useSplitTransferFxAutofill';

/** The parts of a split line that decide its transfer currencies. */
interface TransferLine {
  splitType: string;
  transferAccountId?: string;
  amount: number;
  transferTargetAmount?: number;
  transferTargetFromCurrency?: string;
}

/**
 * The target account of a transfer line whose account is in another currency
 * than the parent's (`currencyCode`), else null.
 */
export function crossCurrencyTransferTarget(
  split: Pick<TransferLine, 'splitType' | 'transferAccountId'>,
  accounts: Account[],
  currencyCode: string,
): Account | null {
  if (split.splitType !== 'transfer' || !split.transferAccountId) return null;
  const target = accounts.find((a) => a.id === split.transferAccountId);
  if (!target || target.currencyCode.toUpperCase() === currencyCode.toUpperCase()) return null;
  return target;
}

const feeOf = (account: Account | undefined): number | null => {
  const fee = account?.fxFeePercent;
  return fee != null && Number(fee) > 0 ? Number(fee) : null;
};

/**
 * A cross-currency transfer line's pair, else null. The fee is the sending
 * account's, the one that converts: the parent's when the line takes money
 * out of it (a zero line under an outgoing parent counts as taking), the
 * target's when the line brings money in. The other account's fee applies only
 * when the sender has none, the choice the transfer form makes.
 */
export function splitTransferPair(
  split: TransferLine,
  accounts: Account[],
  currencyCode: string,
  sourceAccountId: string,
  defaultSign: 1 | -1,
): SplitFxPair | null {
  const target = crossCurrencyTransferTarget(split, accounts, currencyCode);
  if (!target) return null;
  const amount = Number(split.amount) || 0;
  const outgoing = amount < 0 || (amount === 0 && defaultSign < 0);
  const source = accounts.find((a) => a.id === sourceAccountId);
  const [sender, receiver] = outgoing ? [source, target] : [target, source];
  return {
    toCurrency: target.currencyCode,
    fxFeePercent: feeOf(sender) ?? feeOf(receiver),
  };
}

/**
 * The received amount a split line sends, or undefined: only a cross-currency
 * transfer line carries one, and only a figure stated against the parent's
 * current currency. A same-currency line has nothing to say beyond its amount,
 * and a figure for a previous parent currency describes another pair.
 */
export function receivedAmountToSend(
  split: TransferLine,
  accounts: Account[],
  currencyCode: string,
): number | undefined {
  if (!crossCurrencyTransferTarget(split, accounts, currencyCode)) return undefined;
  return currentTransferTargetAmount(split, currencyCode);
}
