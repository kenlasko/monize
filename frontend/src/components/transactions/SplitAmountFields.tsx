'use client';

import { useTranslations } from 'next-intl';
import { CurrencyInput } from '@/components/ui/CurrencyInput';
import { getCurrencySymbol, getDecimalPlacesForCurrency } from '@/lib/format';
import type { SplitFxPair } from './useSplitTransferFxAutofill';

interface SplitAmountFieldsProps {
  /** Set on a cross-currency transfer line, which then shows both amounts. */
  pair: SplitFxPair | null;
  /** The currency the line amount is shown and typed in. */
  amountCurrencyCode: string;
  amountSymbol: string;
  amountDecimals: number;
  amountValue: number;
  onAmountChange: (value: number | undefined) => void;
  /** The line's received amount, in `pair.toCurrency`; undefined when unknown. */
  receivedValue: number | undefined;
  onReceivedChange: (value: number | undefined) => void;
  disabled: boolean;
}

/**
 * A split line's amount and, on a cross-currency transfer line, the amount
 * that arrives below it, each labelled with its currency: the table has no
 * room for a second column, and the column header cannot speak for every line.
 */
export function SplitAmountFields({
  pair,
  amountCurrencyCode,
  amountSymbol,
  amountDecimals,
  amountValue,
  onAmountChange,
  receivedValue,
  onReceivedChange,
  disabled,
}: SplitAmountFieldsProps) {
  const t = useTranslations('transactions');
  const amountInput = (
    <CurrencyInput
      label={
        pair
          ? t('form.fields.transferAmountInCurrency', { currency: amountCurrencyCode })
          : undefined
      }
      prefix={amountSymbol}
      decimalPlaces={amountDecimals}
      value={amountValue}
      onChange={onAmountChange}
      allowSignToggle
      disabled={disabled}
      className="w-full"
    />
  );
  if (!pair) return amountInput;
  return (
    <div className="space-y-2">
      {amountInput}
      <CurrencyInput
        label={t('form.fields.amountReceivedInCurrency', { currency: pair.toCurrency })}
        prefix={getCurrencySymbol(pair.toCurrency)}
        decimalPlaces={getDecimalPlacesForCurrency(pair.toCurrency)}
        value={receivedValue}
        onChange={(value) => onReceivedChange(value !== undefined ? Math.abs(value) : undefined)}
        allowNegative={false}
        disabled={disabled}
        className="w-full"
      />
    </div>
  );
}
