import type { BondRateRule, BondValuationRefusal } from '@/types/bond';

/** The subset of next-intl's translator the label helpers need. */
interface Translator {
  (key: string): string;
  has: (key: string) => boolean;
}

/** A translator that also takes message arguments. */
interface ArgTranslator extends Translator {
  (key: string, values: Record<string, string | number>): string;
}

/** Investment action enum to its key in `investments.transactionList`. */
export const ACTION_LABEL_KEYS: Record<string, string> = {
  BUY: 'actionBuy',
  SELL: 'actionSell',
  DIVIDEND: 'actionDividend',
  INTEREST: 'actionInterest',
  CAPITAL_GAIN: 'actionCapitalGain',
  SPLIT: 'actionSplit',
  TRANSFER_IN: 'actionTransferIn',
  TRANSFER_OUT: 'actionTransferOut',
  REINVEST: 'actionReinvest',
  ADD_SHARES: 'actionAddShares',
  REMOVE_SHARES: 'actionRemoveShares',
};

/** A benchmark by its translated name where the catalog has one, else by its id. */
export function benchmarkLabel(t: Translator, benchmarkId: string): string {
  return t.has(`bond.benchmarks.${benchmarkId}`)
    ? t(`bond.benchmarks.${benchmarkId}`)
    : benchmarkId;
}

/** An issuer by its translated name where the catalog has one, else by its code. */
export function issuerLabel(t: Translator, issuerCode: string): string {
  return t.has(`bond.issuers.${issuerCode}`)
    ? t(`bond.issuers.${issuerCode}`)
    : issuerCode;
}

/** A program by its translated name where the catalog has one, else by its code. */
export function programLabel(t: Translator, programCode: string): string {
  return t.has(`bond.programs.${programCode}`)
    ? t(`bond.programs.${programCode}`)
    : programCode;
}

/**
 * How a rate rule reads, in words, one line per sentence. `pct` formats a
 * fraction string as a percentage (the caller owns the number format); a rule
 * with a missing figure says nothing rather than a guess.
 */
export function rateRuleLines(
  t: ArgTranslator,
  rule: BondRateRule,
  pct: (fraction: string) => string,
): string[] {
  if (rule.type === 'ZERO_COUPON_DISCOUNT') return [t('bond.rate.rule.discount')];
  if (rule.type === 'FIXED') {
    return rule.annualRate === null
      ? []
      : [t('bond.rate.rule.fixed', { rate: pct(rule.annualRate) })];
  }
  if (rule.benchmarkId === null || rule.addend === null) return [];
  const benchmark = benchmarkLabel(t, rule.benchmarkId);
  const addend = pct(rule.addend);
  if (rule.type === 'DAILY_INDEX_PLUS_SPREAD') {
    const daily = [t('bond.rate.rule.daily', { benchmark, addend })];
    // The engine floors the day's rate (index plus spread), not the index.
    if (rule.benchmarkFloor !== null) {
      daily.push(
        t('bond.rate.rule.dailyFloor', { floor: pct(rule.benchmarkFloor) }),
      );
    }
    if (rule.lockoutBusinessDays) {
      daily.push(t('bond.rate.rule.lockout', { days: rule.lockoutBusinessDays }));
    }
    return daily;
  }
  const lines =
    rule.firstPeriodRate === null
      ? [t('bond.rate.rule.every', { benchmark, addend })]
      : [
          t('bond.rate.rule.firstThen', {
            firstRate: pct(rule.firstPeriodRate),
            benchmark,
            addend,
          }),
        ];
  if (rule.benchmarkFloor !== null && Number(rule.benchmarkFloor) === 0) {
    lines.push(t('bond.rate.rule.floorZero', { benchmark }));
  }
  return lines;
}

/**
 * Why a lot is not valued, in words: one case per refusal code, so a code the
 * server adds fails to compile here instead of reading as another code's
 * message. A code this client does not know says nothing (the row already
 * reads "Not valued").
 */
export function valuationRefusalText(
  t: ArgTranslator,
  refusal: BondValuationRefusal,
  formatDate: (date: string) => string,
): string | null {
  switch (refusal.code) {
    case 'PURCHASE_AFTER_MATURITY':
      return t('bond.valuationRefusal.PURCHASE_AFTER_MATURITY', {
        maturityDate: formatDate(refusal.params.maturityDate),
        purchaseDate: formatDate(refusal.params.purchaseDate),
      });
    case 'PURCHASE_OUTSIDE_SALE_WINDOW':
      return t('bond.valuationRefusal.PURCHASE_OUTSIDE_SALE_WINDOW', {
        from: formatDate(refusal.params.from),
        to: formatDate(refusal.params.to),
        purchaseDate: formatDate(refusal.params.purchaseDate),
      });
    default: {
      const unreachable: never = refusal;
      void unreachable;
      return null;
    }
  }
}
