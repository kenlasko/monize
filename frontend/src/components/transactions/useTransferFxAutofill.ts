'use client';

import { useEffect, useRef, useState } from 'react';
import { exchangeRatesApi } from '@/lib/exchange-rates';
import { getDecimalPlacesForCurrency, roundToDecimals } from '@/lib/format';

interface UseTransferFxAutofillArgs {
  /** Source account currency; null when the transfer is not cross-currency. */
  fromCurrency: string | null;
  /** Destination account currency; null when the transfer is not cross-currency. */
  toCurrency: string | null;
  /** Transaction date, `YYYY-MM-DD`; the rate is the one for this day. */
  date: string | undefined;
  /**
   * The converting account's foreign-transaction fee, in percent: a cost
   * folded into the conversion, so less arrives than the market rate gives.
   * Null or 0 means no fee.
   */
  fxFeePercent: number | null | undefined;
  /** Current "Transfer Amount", in `fromCurrency`. */
  amount: number | undefined;
  /** Current "Amount Received", in `toCurrency`. */
  targetAmount: number | undefined;
  setAmount: (value: number) => void;
  setTargetAmount: (value: number | undefined) => void;
}

const isFilled = (value: number | undefined): value is number =>
  value !== undefined && value > 0;

/** A currency's decimal places; 2 while the transfer is not cross-currency. */
const decimalsOf = (currency: string | null): number =>
  currency ? getDecimalPlacesForCurrency(currency) : 2;

const feeFraction = (fxFeePercent: number | null | undefined): number =>
  fxFeePercent && fxFeePercent > 0 ? fxFeePercent / 100 : 0;

/**
 * What arrives for `sent`: the converted amount less the FX fee, rounded the
 * way the foreign-entry panel rounds its base and fee (`docs/financial-semantics.md`,
 * "Conversion"), at the receiving currency's own precision (`receivedDecimals`,
 * 0 for JPY), so a figure is never finer than the currency can hold.
 */
export function receivedForSent(
  sent: number,
  rate: number,
  fxFeePercent: number | null | undefined,
  receivedDecimals = 2,
): number {
  const base = roundToDecimals(sent * rate, receivedDecimals);
  const fee = roundToDecimals(base * feeFraction(fxFeePercent), receivedDecimals);
  return roundToDecimals(base - fee, receivedDecimals);
}

/**
 * What must be sent for `received` to arrive, the inverse of
 * `receivedForSent`, at the sending currency's precision; null when a 100% fee
 * leaves nothing to arrive.
 */
export function sentForReceived(
  received: number,
  rate: number,
  fxFeePercent: number | null | undefined,
  sentDecimals = 2,
): number | null {
  const kept = 1 - feeFraction(fxFeePercent);
  if (kept <= 0) return null;
  return roundToDecimals(received / kept / rate, sentDecimals);
}

/**
 * Fills the other side of a cross-currency transfer from the day's rate.
 *
 * A side is only written while it is empty or still holds a figure this hook
 * put there: once the user types into a side it is theirs, so a received
 * amount corrected for the bank's FX fee is never re-priced by a later edit of
 * the sent amount (or a date change). With both sides typed by the user
 * nothing is filled at all.
 *
 * The rate comes from `exchangeRatesApi.getRateForDate(from, to, date)`, the
 * same lookup the foreign-currency entry panel uses; `from * rate = to`, less
 * the converting account's `fxFeePercent`. A failed lookup or a missing rate
 * fills nothing, rather than guessing.
 */
export function useTransferFxAutofill({
  fromCurrency,
  toCurrency,
  date,
  fxFeePercent,
  amount,
  targetAmount,
  setAmount,
  setTargetAmount,
}: UseTransferFxAutofillArgs) {
  // The rate is kept with the pair and date it was fetched for, so a rate for
  // a previous date or account is never applied to the current one.
  const [fetched, setFetched] = useState<{ key: string; rate: number | null } | null>(null);
  // Which side currently holds a figure derived from the rate, not typed.
  const amountAutoRef = useRef(false);
  const targetAutoRef = useRef(false);
  // Latest values for the fetch callback, which must not re-run on edits.
  const latestRef = useRef({ amount, targetAmount, fxFeePercent, setAmount, setTargetAmount });
  useEffect(() => {
    latestRef.current = { amount, targetAmount, fxFeePercent, setAmount, setTargetAmount };
  });

  const key =
    fromCurrency && toCurrency && fromCurrency !== toCurrency && date
      ? `${fromCurrency}:${toCurrency}:${date}:${feeFraction(fxFeePercent)}`
      : null;
  const rate = key !== null && fetched?.key === key ? fetched.rate : null;

  // A rate arriving (or changing with the date or an account) re-derives a
  // side this hook filled, or fills an empty side from the other.
  const applyRate = (value: number) => {
    const current = latestRef.current;
    if (isFilled(current.amount) && (targetAutoRef.current || !isFilled(current.targetAmount))) {
      targetAutoRef.current = true;
      current.setTargetAmount(receivedForSent(current.amount, value, current.fxFeePercent, decimalsOf(toCurrency)));
    } else if (
      isFilled(current.targetAmount) &&
      (amountAutoRef.current || !isFilled(current.amount))
    ) {
      const sent = sentForReceived(current.targetAmount, value, current.fxFeePercent, decimalsOf(fromCurrency));
      if (sent === null) return;
      amountAutoRef.current = true;
      current.setAmount(sent);
    }
  };

  useEffect(() => {
    if (key === null) return;
    let cancelled = false;
    const handle = setTimeout(() => {
      exchangeRatesApi
        .getRateForDate(fromCurrency as string, toCurrency as string, date as string)
        .then((value) => {
          if (cancelled) return;
          const known = value && value > 0 ? value : null;
          setFetched({ key, rate: known });
          if (known !== null) applyRate(known);
        })
        .catch(() => {
          if (!cancelled) setFetched({ key, rate: null });
        });
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
    // fromCurrency/toCurrency/date (and the fee, read through latestRef) are
    // all encoded in `key`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const handleAmountChange = (value: number | undefined) => {
    amountAutoRef.current = false;
    setAmount(value ?? 0);
    if (rate === null) return;
    if (!targetAutoRef.current && isFilled(targetAmount)) return;
    if (isFilled(value)) {
      targetAutoRef.current = true;
      setTargetAmount(receivedForSent(value, rate, fxFeePercent, decimalsOf(toCurrency)));
    } else if (targetAutoRef.current) {
      targetAutoRef.current = false;
      setTargetAmount(undefined);
    }
  };

  const handleTargetAmountChange = (value: number | undefined) => {
    targetAutoRef.current = false;
    setTargetAmount(value);
    if (rate === null) return;
    if (!amountAutoRef.current && isFilled(amount)) return;
    const sent = isFilled(value) ? sentForReceived(value, rate, fxFeePercent, decimalsOf(fromCurrency)) : null;
    if (sent !== null) {
      amountAutoRef.current = true;
      setAmount(sent);
    } else if (amountAutoRef.current) {
      amountAutoRef.current = false;
      setAmount(0);
    }
  };

  return { handleAmountChange, handleTargetAmountChange };
}
