import { CreateSplitData, InvestmentSplitDetails } from '@/types/transaction';
import { moneyDecimalsForCurrency, roundMoney } from '@/lib/format';
import { isUuid } from '@/lib/uuid';

// A split editor's rows and their conversion to and from the API: the
// serializers every split surface (transactions, scheduled transactions,
// overrides, posting) shares. `SplitEditor` re-exports them.

export type SplitType = 'category' | 'transfer' | 'investment';

export interface SplitRow extends CreateSplitData {
  id: string; // Temporary ID for React keys
  splitType: SplitType;
  // Real user intent (issue #1167 R9-F2): true once the user edits this line's FX
  // rate input, so a re-entered rate on a *continuing* investment line is honoured
  // for the current pair even when its value equals the stale stored one. Reset
  // when the security (and thus the pair) changes. UI-only -- the serializer turns
  // it into `rateExplicit`; it never reaches an ordinary transaction DTO.
  exchangeRateEdited?: boolean;
  // The parent currency `transferTargetAmount` was stated against. UI-only: a
  // figure for another parent currency is stale, so it is neither shown nor
  // sent (`receivedAmountToSend`).
  transferTargetFromCurrency?: string;
}

/**
 * Two new split rows halving `transactionAmount`, at the money precision of
 * the account currency `currencyCode` (four for fiat, a coin's eight), the
 * second taking the rounding so the pair sums to the total.
 */
export function createEmptySplits(
  transactionAmount: number,
  currencyCode?: string | null,
): SplitRow[] {
  const money = moneyDecimalsForCurrency(currencyCode);
  const halfAmount = roundMoney(Number(transactionAmount) / 2, money);
  const otherHalf = roundMoney(Number(transactionAmount) - halfAmount, money);

  return [
    {
      id: `temp-${Date.now()}-1`,
      splitType: 'category',
      categoryId: undefined,
      transferAccountId: undefined,
      amount: halfAmount,
      memo: '',
    },
    {
      id: `temp-${Date.now()}-2`,
      splitType: 'category',
      categoryId: undefined,
      transferAccountId: undefined,
      amount: otherHalf,
      memo: '',
    },
  ];
}

// Convert API splits to SplitRow format. Accepts both transaction splits (with
// `investmentTransaction` relation) and scheduled-transaction splits (with the
// investment payload denormalized as `investment*` columns on the row itself).
// A real server-issued split id is a UUID. A synthetic React key (a
// pre-migration override's `override-N`, or a `temp-...` row the user just
// added) is not, and must never be treated as source identity (issue #1167
// R8-F1) -- it would be rejected by the DTO's `@IsUUID` and could masquerade as
// a persistent id, so it is checked with `isUuid`.
// `options.receivedAmountsIn` is the parent currency of the row being edited:
// a transfer line's received amount is loaded from its counterpart only then,
// tagged with that currency. A duplicate or a quick fill names none, so the
// new row's received amounts come from the rate for its own date rather than
// copying a conversion made on another day.
export function toSplitRows(splits: {
  id?: string;
  kind?: 'category' | 'transfer' | 'investment';
  categoryId?: string | null;
  transferAccountId?: string | null;
  amount: number;
  memo?: string | null;
  tags?: { id: string }[];
  // A transfer line's counterpart: what arrived, in the target's currency.
  linkedTransaction?: { amount: number } | null;
  investmentTransaction?: {
    action: string;
    securityId: string | null;
    quantity: number | null;
    price: number | null;
    commission: number;
    exchangeRate: number;
  } | null;
  // Scheduled-transaction-split shape
  investmentAction?: string | null;
  investmentSecurityId?: string | null;
  investmentQuantity?: number | null;
  investmentPrice?: number | null;
  investmentCommission?: number | null;
  investmentExchangeRate?: number | null;
  investmentExchangeRateFromCurrency?: string | null;
  investmentExchangeRateToCurrency?: string | null;
  // Override JSON shape
  splitKind?: 'category' | 'transfer' | 'investment';
  investment?: {
    action: string;
    securityId?: string;
    quantity?: number;
    price?: number;
    commission?: number;
    exchangeRate?: number;
    exchangeRateFromCurrency?: string;
    exchangeRateToCurrency?: string;
  };
}[], options: { receivedAmountsIn?: string } = {}): SplitRow[] {
  return splits.map((split, index) => {
    const kind: SplitType =
      split.kind === 'investment' ||
      split.splitKind === 'investment' ||
      split.investmentTransaction ||
      split.investmentAction ||
      split.investment
        ? 'investment'
        : split.transferAccountId
          ? 'transfer'
          : 'category';
    let investment: InvestmentSplitDetails | undefined;
    if (split.investmentTransaction) {
      investment = {
        action: split.investmentTransaction.action as InvestmentSplitDetails['action'],
        securityId: split.investmentTransaction.securityId ?? undefined,
        quantity: Number(split.investmentTransaction.quantity ?? 0),
        price: Number(split.investmentTransaction.price ?? 0),
        commission: Number(split.investmentTransaction.commission ?? 0),
        // A persisted rate of null is unknown FX, not 1 (issue #1167 R10-F1):
        // coercing it to 1 lets the server bless a synthetic 1 as the current
        // pair. Preserve undefined so the split carries no rate.
        exchangeRate:
          split.investmentTransaction.exchangeRate != null
            ? Number(split.investmentTransaction.exchangeRate)
            : undefined,
      };
    } else if (split.investmentAction) {
      investment = {
        action: split.investmentAction as InvestmentSplitDetails['action'],
        securityId: split.investmentSecurityId ?? undefined,
        quantity: Number(split.investmentQuantity ?? 0),
        price: Number(split.investmentPrice ?? 0),
        commission: Number(split.investmentCommission ?? 0),
        // A persisted scheduled rate of null is unknown FX, not 1 (issue #1167
        // R10-F1): coercing it to 1 lets a cosmetic edit bless a synthetic 1 as
        // the current cross-currency pair. Preserve undefined -- the cross-currency
        // field then resolves the real rate, and a matched null-rate source is not
        // stamped unless the user actually enters one.
        exchangeRate:
          split.investmentExchangeRate != null
            ? Number(split.investmentExchangeRate)
            : undefined,
        // Carry the server-recorded currency pair (issue #1167 F5-1) so a Post
        // that resends this line unchanged lets the server tell a still-valid
        // rate from a since-stale one, rather than trusting the scalar blindly.
        exchangeRateFromCurrency:
          split.investmentExchangeRateFromCurrency ?? undefined,
        exchangeRateToCurrency:
          split.investmentExchangeRateToCurrency ?? undefined,
      };
    } else if (split.investment) {
      investment = {
        action: split.investment.action as InvestmentSplitDetails['action'],
        securityId: split.investment.securityId,
        quantity: split.investment.quantity,
        price: split.investment.price,
        commission: split.investment.commission,
        exchangeRate: split.investment.exchangeRate,
        exchangeRateFromCurrency: split.investment.exchangeRateFromCurrency,
        exchangeRateToCurrency: split.investment.exchangeRateToCurrency,
      };
    }
    return {
      id: split.id || `temp-${Date.now()}-${index}`,
      // The source split's real id (undefined for a row the user just added), so
      // an edit/post can name it as `sourceSplitId` and the server decides FX
      // provenance by identity (issue #1167 F4). Only a real server id (a UUID)
      // may become source identity: a synthetic React key (a pre-migration
      // override's `override-N`, or a `temp-` row) is UI-only and would be
      // rejected by the DTO's `@IsUUID` and, worse, could masquerade as a
      // persistent id (issue #1167 R8-F1). Anything else stays undefined, which
      // the server reads as "new/unidentified line".
      sourceSplitId: isUuid(split.id) ? split.id : undefined,
      splitType: kind,
      categoryId: split.categoryId || undefined,
      transferAccountId: split.transferAccountId || undefined,
      investment,
      amount: Number(split.amount),
      // Loaded from the leg it describes, at its stored precision, so an
      // unedited save sends back what arrived rather than re-converting it.
      ...(options.receivedAmountsIn && kind === 'transfer' && split.linkedTransaction
        ? {
            transferTargetAmount: Math.abs(Number(split.linkedTransaction.amount)),
            transferTargetFromCurrency: options.receivedAmountsIn,
          }
        : {}),
      memo: split.memo || '',
      tagIds: split.tags?.map(t => t.id) || [],
    };
  });
}

// Convert SplitRow to API format (removes temporary id and splitType)
// Convert SplitRow to API format (removes temporary id and splitType).
//
// `includeSourceIdentity` is opt-in and OFF by default: `sourceSplitId` is a
// scheduled-transaction correlation field (issue #1167 F4) that the ordinary
// transaction DTO does not accept, so emitting it there fails validation under
// `forbidNonWhitelisted` (R7-F1). Only the scheduled create/update surface passes
// it true.
//
// `transferTargetAmountOf` gives each line's received amount to send: the
// transaction form passes `receivedAmountToSend`; every other surface omits
// it, so no line carries one and the server converts at the market rate (or
// keeps the recorded figure of a line that continues unchanged).
export function toCreateSplitData(
  splits: SplitRow[],
  options: {
    includeSourceIdentity?: boolean;
    transferTargetAmountOf?: (split: SplitRow) => number | undefined;
  } = {},
): CreateSplitData[] {
  return splits.map((split) => ({
    splitKind: split.splitType,
    categoryId: split.splitType === 'category' ? split.categoryId : undefined,
    transferAccountId: split.splitType === 'transfer' ? split.transferAccountId : undefined,
    investment: split.splitType === 'investment' ? split.investment : undefined,
    amount: split.amount,
    transferTargetAmount:
      split.splitType === 'transfer' ? options.transferTargetAmountOf?.(split) : undefined,
    memo: split.memo || undefined,
    tagIds: split.tagIds && split.tagIds.length > 0 ? split.tagIds : undefined,
    // Carry the source split id only for scheduled surfaces that decide FX
    // provenance by identity; undefined for a row the user added.
    sourceSplitId: options.includeSourceIdentity
      ? split.sourceSplitId
      : undefined,
    // The line's FX rate is a deliberate value for the current settlement pair,
    // so the server stamps that pair rather than treating the line as an
    // unidentified legacy row (issue #1167 R8-F2/R9-F2). True for a genuinely new
    // investment line (no source identity), or a continuing one whose rate the
    // user actually edited (`exchangeRateEdited`) -- the latter closes the
    // same-value re-entry edge where the re-typed value equals the stale stored
    // one. Scheduled surfaces only, alongside the source-identity opt-in.
    rateExplicit:
      options.includeSourceIdentity &&
      split.splitType === 'investment' &&
      (!split.sourceSplitId || split.exchangeRateEdited === true)
        ? true
        : undefined,
  }));
}
