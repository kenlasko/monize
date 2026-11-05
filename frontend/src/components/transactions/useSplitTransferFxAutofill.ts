'use client';

import { useEffect, useRef, useState } from 'react';
import { exchangeRatesApi } from '@/lib/exchange-rates';
import { getDecimalPlacesForCurrency } from '@/lib/format';
import { receivedForSent, sentForReceived } from './useTransferFxAutofill';

/** The parts of a split line this hook reads and writes. */
export interface SplitFxLine {
  id: string;
  /**
   * The counterpart account. A remembered received amount belongs to it
   * alone: a line pointed at another account starts empty, as on a transfer.
   */
  transferAccountId?: string;
  /** Signed, in the parent account's currency. */
  amount: number;
  /** Unsigned, in the target account's currency. */
  transferTargetAmount?: number;
  /**
   * The parent currency `transferTargetAmount` was stated against. A received
   * amount belongs to one pair: once the parent moves to an account in another
   * currency it describes nothing, and is neither shown, kept nor sent.
   */
  transferTargetFromCurrency?: string;
}

/** A cross-currency transfer line's target currency and conversion fee. */
export interface SplitFxPair {
  toCurrency: string;
  /** The converting account's foreign-transaction fee, in percent. */
  fxFeePercent: number | null;
}

export type SplitFxPatch = Partial<
  Pick<SplitFxLine, 'amount' | 'transferTargetAmount' | 'transferTargetFromCurrency'>
>;

interface UseSplitTransferFxAutofillArgs<T extends SplitFxLine> {
  /** The parent account's currency, which every split amount is in. */
  fromCurrency: string;
  /** Transaction date, `YYYY-MM-DD`; the rate is the one for this day. */
  date: string | undefined;
  lines: T[];
  /** The line's pair when it is a cross-currency transfer, else null. */
  pairOf: (line: T) => SplitFxPair | null;
  /** The sign a derived amount takes on a line whose amount is zero. */
  defaultSign: 1 | -1;
  /** Writes the figures a rate arriving derived, all lines at once. */
  onPatch: (patches: Record<string, SplitFxPatch>) => void;
}

const isFilled = (value: number | undefined): value is number =>
  value !== undefined && value > 0;

const feeFraction = (fxFeePercent: number | null): number =>
  fxFeePercent && fxFeePercent > 0 ? fxFeePercent / 100 : 0;

const magnitude = (amount: number): number => Math.abs(Number(amount) || 0);

/**
 * A line's received amount when it was stated against `fromCurrency`, else
 * undefined: a figure for another parent currency is stale, not a value.
 */
export function currentTransferTargetAmount(
  line: Pick<SplitFxLine, 'transferTargetAmount' | 'transferTargetFromCurrency'>,
  fromCurrency: string,
): number | undefined {
  return line.transferTargetFromCurrency === fromCurrency
    ? line.transferTargetAmount
    : undefined;
}

/**
 * `useTransferFxAutofill` for the transfer lines of a split: each
 * cross-currency transfer line has a "Transfer Amount" (the split amount, in
 * the parent's currency) and an "Amount Received" (in the target's currency),
 * and either fills the other from the day's rate, less the fee, while the
 * other is empty or still holds a figure this hook put there. Once the user
 * types into a side it is theirs, exactly as on a plain transfer.
 *
 * A split amount also changes without being typed (distribute, add the
 * remainder), so the editor routes every change of its lines through
 * `reconcile`, which re-derives the received amount of any line whose amount
 * moved. Typing the received amount goes through `editTarget` instead.
 *
 * A received amount is tagged with the parent currency it was stated against
 * (`transferTargetFromCurrency`). One stated against another currency is
 * treated as empty, so it is re-derived for the new pair. A figure the user
 * stated (typed, or loaded with the row) is remembered with its pair and line
 * amount, and comes back when the parent returns to that currency with the
 * line unchanged: picking another account by mistake and then the right one
 * again must not trade the bank's figure for a re-derived one.
 *
 * A failed lookup or a missing rate fills nothing, rather than guessing; the
 * server then converts the line at the market rate or refuses it.
 */
export function useSplitTransferFxAutofill<T extends SplitFxLine>({
  fromCurrency,
  date,
  lines,
  pairOf,
  defaultSign,
  onPatch,
}: UseSplitTransferFxAutofillArgs<T>) {
  // Rates by pair, date and fee, each kept with the key it was fetched for so
  // a rate for another date or account is never applied to a line.
  const [rates, setRates] = useState<Record<string, number | null>>({});
  // Which lines currently hold a side derived from the rate, not typed.
  const amountAutoRef = useRef(new Set<string>());
  const targetAutoRef = useRef(new Set<string>());
  // The key whose rate was last applied to each line.
  const appliedKeyRef = useRef(new Map<string, string>());
  // Each line's stated (typed or loaded) received amount, with the parent
  // currency, counterpart account and line amount it was stated for.
  const statedRef = useRef(
    new Map<
      string,
      { from: string; account: string | undefined; amount: number; target: number }
    >(),
  );
  // Lines a restore was issued for that do not hold it yet: until the patch
  // lands, the line still shows the derived figure it replaces, which must not
  // be remembered as the user's.
  const restoringRef = useRef(new Set<string>());
  const latestRef = useRef({ fromCurrency, date, lines, pairOf, defaultSign, onPatch });
  useEffect(() => {
    latestRef.current = { fromCurrency, date, lines, pairOf, defaultSign, onPatch };
  });

  const keyOf = (
    line: T,
    ctx: { fromCurrency: string; date: string | undefined; pairOf: (line: T) => SplitFxPair | null },
  ): string | null => {
    const pair = ctx.pairOf(line);
    if (!pair || !ctx.date || pair.toCurrency === ctx.fromCurrency) return null;
    return `${ctx.fromCurrency}:${pair.toCurrency}:${ctx.date}:${feeFraction(pair.fxFeePercent)}`;
  };

  const signOf = (line: T, fallback: 1 | -1): 1 | -1 => {
    const amount = Number(line.amount) || 0;
    if (amount < 0) return -1;
    if (amount > 0) return 1;
    return fallback;
  };

  // The two conversions at each currency's own precision.
  const received = (sent: number, rate: number, pair: SplitFxPair) =>
    receivedForSent(sent, rate, pair.fxFeePercent, getDecimalPlacesForCurrency(pair.toCurrency));
  const sentFor = (target: number, rate: number, pair: SplitFxPair, from: string) =>
    sentForReceived(target, rate, pair.fxFeePercent, getDecimalPlacesForCurrency(from));

  // Remember a line's figure while it is the user's own (not derived here).
  const noteStated = (line: T) => {
    if (restoringRef.current.has(line.id)) return;
    if (
      isFilled(line.transferTargetAmount) &&
      line.transferTargetFromCurrency !== undefined &&
      !targetAutoRef.current.has(line.id)
    ) {
      statedRef.current.set(line.id, {
        from: line.transferTargetFromCurrency,
        account: line.transferAccountId,
        amount: Number(line.amount),
        target: line.transferTargetAmount,
      });
    }
  };

  // The patch that brings a line's stated figure back, when the parent is in
  // that figure's currency again with the line unchanged (same counterpart
  // account, same amount) and the line does not already hold it; null otherwise.
  const restorePatch = (line: T, from: string): SplitFxPatch | null => {
    const stated = statedRef.current.get(line.id);
    if (
      !stated ||
      stated.from !== from ||
      stated.account !== line.transferAccountId ||
      stated.amount !== Number(line.amount)
    ) {
      return null;
    }
    if (
      line.transferTargetFromCurrency === from &&
      line.transferTargetAmount === stated.target
    ) {
      restoringRef.current.delete(line.id);
      return null;
    }
    targetAutoRef.current.delete(line.id);
    restoringRef.current.add(line.id);
    return { transferTargetAmount: stated.target, transferTargetFromCurrency: from };
  };

  // Every line that needs a rate, with the key it needs; the effect re-runs
  // only when that set changes, not on every amount typed.
  const signature = lines
    .map((line) => {
      const key = keyOf(line, { fromCurrency, date, pairOf });
      return key ? `${line.id}=${key}` : null;
    })
    .filter((entry): entry is string => entry !== null)
    .join('|');

  useEffect(() => {
    if (!signature) return;
    let cancelled = false;

    // A rate arriving (or changing with the date or an account) re-derives a
    // side this hook filled, or fills an empty side from the other.
    const applyRate = (key: string, rate: number) => {
      const ctx = latestRef.current;
      const patches: Record<string, SplitFxPatch> = {};
      for (const line of ctx.lines) {
        if (keyOf(line, ctx) !== key || appliedKeyRef.current.get(line.id) === key) continue;
        appliedKeyRef.current.set(line.id, key);
        noteStated(line);
        const restored = restorePatch(line, ctx.fromCurrency);
        if (restored) {
          patches[line.id] = restored;
          continue;
        }
        const pair = ctx.pairOf(line) as SplitFxPair;
        const sent = magnitude(line.amount);
        const target = currentTransferTargetAmount(line, ctx.fromCurrency);
        if (sent > 0 && (targetAutoRef.current.has(line.id) || !isFilled(target))) {
          targetAutoRef.current.add(line.id);
          patches[line.id] = {
            transferTargetAmount: received(sent, rate, pair),
            transferTargetFromCurrency: ctx.fromCurrency,
          };
        } else if (isFilled(target) && (amountAutoRef.current.has(line.id) || sent === 0)) {
          const derived = sentFor(target, rate, pair, ctx.fromCurrency);
          if (derived === null) continue;
          amountAutoRef.current.add(line.id);
          patches[line.id] = { amount: signOf(line, ctx.defaultSign) * derived };
        }
      }
      if (Object.keys(patches).length > 0) ctx.onPatch(patches);
    };

    const handle = setTimeout(() => {
      const ctx = latestRef.current;
      const wanted = new Map<string, string>();
      // A stated figure comes back without waiting on a rate, which may never
      // arrive.
      const restores: Record<string, SplitFxPatch> = {};
      for (const line of ctx.lines) {
        const key = keyOf(line, ctx);
        if (key === null || appliedKeyRef.current.get(line.id) === key) continue;
        noteStated(line);
        const restored = restorePatch(line, ctx.fromCurrency);
        if (restored) restores[line.id] = restored;
        wanted.set(key, (ctx.pairOf(line) as SplitFxPair).toCurrency);
      }
      if (Object.keys(restores).length > 0) ctx.onPatch(restores);
      wanted.forEach((toCurrency, key) => {
        exchangeRatesApi
          .getRateForDate(ctx.fromCurrency, toCurrency, ctx.date as string)
          .then((value) => {
            if (cancelled) return;
            const known = value && value > 0 ? value : null;
            setRates((prev) => ({ ...prev, [key]: known }));
            if (known !== null) applyRate(key, known);
          })
          .catch(() => {
            if (!cancelled) setRates((prev) => ({ ...prev, [key]: null }));
          });
      });
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
    // The lines, the pair resolver and the date are read through latestRef;
    // what decides a fetch is all encoded in `signature`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);

  const ctx = { fromCurrency, date, pairOf };
  const knownRate = (line: T): number | null => {
    const key = keyOf(line, ctx);
    if (key === null) return null;
    const rate = rates[key];
    return rate === undefined ? null : rate;
  };

  /**
   * The lines as they should be committed: any cross-currency transfer line
   * whose amount moved gets its received amount re-derived, unless the user
   * typed that one.
   */
  const reconcile = (prev: readonly T[], next: T[]): T[] =>
    next.map((line) => {
      const before = prev.find((p) => p.id === line.id);
      if (!before || Number(before.amount) === Number(line.amount)) return line;
      amountAutoRef.current.delete(line.id);
      const pair = pairOf(line);
      const rate = knownRate(line);
      if (!pair || rate === null) return line;
      const autoTarget = targetAutoRef.current.has(line.id);
      if (!autoTarget && isFilled(currentTransferTargetAmount(line, fromCurrency))) return line;
      const sent = magnitude(line.amount);
      if (sent > 0) {
        targetAutoRef.current.add(line.id);
        return {
          ...line,
          transferTargetAmount: received(sent, rate, pair),
          transferTargetFromCurrency: fromCurrency,
        };
      }
      if (autoTarget) {
        targetAutoRef.current.delete(line.id);
        return { ...line, transferTargetAmount: undefined };
      }
      return line;
    });

  /** The change typing `value` into a line's received amount makes. */
  const editTarget = (line: T, value: number | undefined): SplitFxPatch => {
    targetAutoRef.current.delete(line.id);
    restoringRef.current.delete(line.id);
    if (isFilled(value)) {
      statedRef.current.set(line.id, {
        from: fromCurrency,
        account: line.transferAccountId,
        amount: Number(line.amount),
        target: value,
      });
    } else {
      statedRef.current.delete(line.id);
    }
    const patch: SplitFxPatch = {
      transferTargetAmount: value,
      transferTargetFromCurrency: fromCurrency,
    };
    const pair = pairOf(line);
    const rate = knownRate(line);
    if (!pair || rate === null) return patch;
    const amountAuto = amountAutoRef.current.has(line.id);
    if (!amountAuto && magnitude(line.amount) > 0) return patch;
    const derived = isFilled(value) ? sentFor(value, rate, pair, fromCurrency) : null;
    if (derived !== null) {
      amountAutoRef.current.add(line.id);
      patch.amount = signOf(line, defaultSign) * derived;
    } else if (amountAuto) {
      amountAutoRef.current.delete(line.id);
      patch.amount = 0;
    }
    return patch;
  };

  return { reconcile, editTarget };
}
