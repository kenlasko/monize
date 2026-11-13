/**
 * Server-side arithmetic tool for the AI query engine.
 *
 * LLMs are unreliable at arithmetic. This tool lets the model delegate
 * calculations (percentages, ratios, differences, sums, averages) to
 * the server so the user always gets accurate results.
 *
 * `result` is the exact answer, never a display of it: the arithmetic is done
 * on the inputs' decimal values (`calculate-arithmetic.ts`), with no rounding
 * of an input or an intermediate, so a model that feeds `result` into the next
 * call gets the same answer as one call would. Display rounding (two places,
 * half away from zero) happens only in `formattedResult`.
 */

import type { DatedConversion } from "../../currencies/exchange-rate.service";
import { todayYMD } from "../../common/date-utils";
import { roundToDecimals } from "../../common/round.util";
import {
  exactAverage,
  exactDifference,
  exactQuotient,
  exactSum,
} from "./calculate-arithmetic";

/** Places `formattedResult` shows; `result` is never rounded to them. */
const DISPLAY_DECIMALS = 2;

export type CalculateOperation =
  "percentage" | "difference" | "ratio" | "sum" | "average";

/**
 * The one operation that is not arithmetic on the caller's own numbers: a
 * currency conversion, priced by the server at the rate that applied on a date.
 * Kept in the `calculate` tool because that is where a model is told to send
 * every figure it must not work out itself.
 */
export const CONVERT_OPERATION = "convert" as const;
export type ConvertOperation = typeof CONVERT_OPERATION;

export interface CalculateInput {
  operation: CalculateOperation;
  values: number[];
  label?: string;
}

export interface CalculateResult {
  /** The exact answer, unrounded, safe to feed into another calculation. */
  result: number;
  /** `result` for display: two places, half away from zero. */
  formattedResult: string;
  operation: CalculateOperation;
  label?: string;
}

export interface ConvertInput {
  /** `values[0]` of the tool call: the amount in `fromCurrency`. */
  values: number[];
  fromCurrency?: string;
  toCurrency?: string;
  /** YYYY-MM-DD; today when omitted. */
  date?: string;
  label?: string;
}

/**
 * Same envelope as `CalculateResult` (`result`, `formattedResult`,
 * `operation`, `label`) so a client renders it the same way, plus the inputs
 * and the rate the server applied, so a model can quote both sides.
 */
export interface ConvertResult {
  result: number;
  formattedResult: string;
  operation: ConvertOperation;
  label?: string;
  amount: number;
  fromCurrency: string;
  toCurrency: string;
  /** The day whose rate was applied (a future date is clamped to today). */
  date: string;
  /** `fromCurrency -> toCurrency`, 10dp. `1` only when the codes are equal. */
  rate: number;
}

/** What `executeConversion` needs from `ExchangeRateService`. */
export interface DatedConverter {
  convertOnDate(
    amount: number,
    fromCurrency: string,
    toCurrency: string,
    date?: string,
  ): Promise<DatedConversion | null>;
}

const CURRENCY_CODE = /^[A-Za-z]{3}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** True iff `value` is a real calendar day in YYYY-MM-DD form. */
function isCalendarDate(value: string): boolean {
  if (!ISO_DATE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return (
    !Number.isNaN(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === value
  );
}

/**
 * Convert `values[0]` from one currency to another at the rate that applied on
 * `date` (today by default). The rate itself comes from the domain service --
 * this only validates the request and shapes the answer -- so the AI Assistant
 * and the MCP server return byte-identical results for the same call.
 *
 * A pair with no rate is an error, never a pass-through of the input or a rate
 * of 1: the whole point of the tool is that the model does not guess.
 */
export async function executeConversion(
  input: ConvertInput,
  rates: DatedConverter,
): Promise<ConvertResult | { error: string }> {
  const { values, fromCurrency, toCurrency, date, label } = input;

  if (values.length !== 1) {
    return {
      error: "Conversion requires exactly 1 value: [amount].",
    };
  }
  const amount = values[0];
  if (!Number.isFinite(amount)) {
    return { error: "Conversion requires a finite amount." };
  }
  if (!fromCurrency || !CURRENCY_CODE.test(fromCurrency)) {
    return {
      error:
        "Conversion requires fromCurrency: a 3-letter ISO 4217 code (e.g. 'CAD').",
    };
  }
  if (!toCurrency || !CURRENCY_CODE.test(toCurrency)) {
    return {
      error:
        "Conversion requires toCurrency: a 3-letter ISO 4217 code (e.g. 'USD').",
    };
  }
  if (date !== undefined && !isCalendarDate(date)) {
    return { error: `Invalid date '${date}': expected YYYY-MM-DD.` };
  }

  const asOf = date ?? todayYMD();
  const conversion = await rates.convertOnDate(
    amount,
    fromCurrency,
    toCurrency,
    asOf,
  );
  if (conversion === null) {
    return {
      error:
        `No exchange rate is available for ${fromCurrency.toUpperCase()}->${toCurrency.toUpperCase()}` +
        ` on ${asOf}. The user can add one on the Currencies page.`,
    };
  }

  return {
    result: conversion.convertedAmount,
    formattedResult: `${toDisplay(conversion.convertedAmount).toFixed(DISPLAY_DECIMALS)} ${conversion.toCurrency}`,
    operation: CONVERT_OPERATION,
    ...(label && { label }),
    amount: conversion.amount,
    fromCurrency: conversion.fromCurrency,
    toCurrency: conversion.toCurrency,
    date: conversion.date,
    rate: conversion.rate,
  };
}

/**
 * Execute a calculation and return the result with formatting.
 *
 * Operations:
 * - percentage: (values[0] / values[1]) * 100  -- "what % of whole is part?"
 * - difference: values[0] - values[1]          -- "how much more is A than B?"
 * - ratio:      values[0] / values[1]          -- "A to B ratio"
 * - sum:        sum of all values
 * - average:    arithmetic mean of all values
 */
export function executeCalculation(
  input: CalculateInput,
): CalculateResult | { error: string } {
  const { operation, values, label } = input;

  if (values.length === 0) {
    return { error: "At least one value is required." };
  }
  if (!values.every((value) => Number.isFinite(value))) {
    return { error: "Every value must be a finite number." };
  }

  let result: number;

  switch (operation) {
    case "percentage": {
      if (values.length < 2) {
        return {
          error: "Percentage requires exactly 2 values: [part, whole].",
        };
      }
      const [part, whole] = values;
      if (whole === 0) {
        return { error: "Cannot calculate percentage: divisor is zero." };
      }
      result = exactQuotient(part, whole, 100);
      break;
    }

    case "difference": {
      if (values.length < 2) {
        return {
          error: "Difference requires exactly 2 values: [a, b].",
        };
      }
      result = exactDifference(values[0], values[1]);
      break;
    }

    case "ratio": {
      if (values.length < 2) {
        return { error: "Ratio requires exactly 2 values: [a, b]." };
      }
      if (values[1] === 0) {
        return { error: "Cannot calculate ratio: divisor is zero." };
      }
      result = exactQuotient(values[0], values[1]);
      break;
    }

    case "sum": {
      result = exactSum(values);
      break;
    }

    case "average": {
      if (values.length === 0) {
        return { error: "Average requires at least one value." };
      }
      result = exactAverage(values);
      break;
    }

    default:
      return { error: `Unknown operation: ${operation}` };
  }

  const formattedResult = formatResult(result, operation);

  return { result, formattedResult, operation, ...(label && { label }) };
}

/** `value` at the display precision; a rounded `-0` reads as `0`. */
function toDisplay(value: number): number {
  return roundToDecimals(value, DISPLAY_DECIMALS) || 0;
}

function formatResult(value: number, operation: CalculateOperation): string {
  const shown = toDisplay(value);
  switch (operation) {
    case "percentage":
      return `${shown}%`;
    case "ratio":
      return `${shown}:1`;
    default:
      return shown.toFixed(DISPLAY_DECIMALS);
  }
}
