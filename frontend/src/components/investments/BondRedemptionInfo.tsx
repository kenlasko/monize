'use client';

import { useTranslations } from 'next-intl';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import type { BondRedemptionSplitResult } from './useBondRedemptionSplit';

interface BondRedemptionInfoProps {
  result: BondRedemptionSplitResult;
  currencyCode: string;
}

/**
 * What the redemption pays, split: the interest, the early-redemption deduction
 * and the cash. A refusal, a refused quantity and a failed read are each said as
 * what they are; an unknown figure is never shown as zero.
 */
export function BondRedemptionInfo({ result, currencyCode }: BondRedemptionInfoProps) {
  const t = useTranslations('investments');
  const tDetail = useTranslations('securityDetail');
  const { formatCurrency } = useNumberFormat();
  const { split, refusalCode, failed } = result;

  let text: string | null = null;
  let tone: 'info' | 'warn' = 'info';
  if (split !== null && split.refusal !== null) {
    tone = 'warn';
    text =
      split.refusal === 'PURCHASE_OUTSIDE_SALE_WINDOW'
        ? t('transactionForm.bondRedemption.outsideSaleWindow')
        : split.refusal === 'PURCHASE_AFTER_MATURITY'
          ? t('transactionForm.bondRedemption.afterMaturity')
          : tDetail(`bond.earlyRefusal.${split.refusal}`);
  } else if (split !== null && split.interest !== null && split.deduction !== null && split.payout !== null) {
    text = t('transactionForm.bondRedemption.summary', {
      interest: formatCurrency(Number(split.interest), currencyCode),
      deduction: formatCurrency(Number(split.deduction), currencyCode),
      payout: formatCurrency(Number(split.payout), currencyCode),
    });
  } else if (refusalCode !== null) {
    tone = 'warn';
    text = tDetail(`bond.lotsRefusal.${refusalCode}`);
  } else if (failed) {
    tone = 'warn';
    text = t('transactionForm.bondRedemption.failed');
  }
  if (text === null) return null;
  return (
    <p
      role="status"
      className={`text-xs ${
        tone === 'warn' ? 'text-amber-700 dark:text-amber-300' : 'text-gray-600 dark:text-gray-400'
      }`}
    >
      {text}
    </p>
  );
}
