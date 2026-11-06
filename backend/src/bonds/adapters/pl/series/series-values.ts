import { SeriesFetchError } from "../../../bond-adapter";
import { ExactDecimal } from "../../../domain/exact-decimal";
import { echo } from "../../../series-echo";
import { ParsedSeriesCode } from "./series-code";
import { SeriesTemplate } from "./templates";

/** The per-series values of a template, however they were obtained. */
export interface SeriesValues {
  /** A fraction as a 4-place string: "0.0655". */
  readonly firstPeriodRate: string;
  /** The margin or spread, same format; null for a fixed-rate product. */
  readonly addend: string | null;
  /** "3.00"; null for a product that charges no fee. */
  readonly fee: string | null;
  readonly saleWindow: { readonly from: string; readonly to: string };
  /** "96/2024". */
  readonly letterNumber: string;
  /** YYYY-MM-DD. */
  readonly letterDate: string;
}

/** The bounds of spec bond-series-fetch 4.3. */
const RATE_MAX = "0.25";
const ADDEND_MAX = "0.05";
const FEE_MAX = "10";

const MONTHS_GENITIVE = [
  "stycznia",
  "lutego",
  "marca",
  "kwietnia",
  "maja",
  "czerwca",
  "lipca",
  "sierpnia",
  "września",
  "października",
  "listopada",
  "grudnia",
];

export function formatError(
  code: "SOURCE_FORMAT_CHANGED" | "SOURCE_INCONSISTENT",
  params: Record<string, string>,
): SeriesFetchError {
  return new SeriesFetchError(code, params);
}

/** "6,55" (a percentage) as the fraction "0.0655"; null when it is not one. */
export function percentToFraction(text: string): string | null {
  if (!/^\d{1,3}(?:[.,]\d{1,6})?$/.test(text)) return null;
  return ExactDecimal.parse(text.replace(",", "."))
    .div(ExactDecimal.fromInt(100))
    .toTrimmedString(10, 4);
}

/** "3,00" as "3.00"; null when it is not an amount in whole grosze. */
export function plnToDecimal(text: string): string | null {
  if (!/^\d{1,6}(?:[.,]\d{1,2})?$/.test(text)) return null;
  return ExactDecimal.parse(text.replace(",", ".")).toFixed(2);
}

function isoDate(year: number, month: number, day: number): string | null {
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return date.toISOString().slice(0, 10);
}

/** "01.10.2026" as "2026-10-01"; null for anything else or a date that does not exist. */
export function dottedDateToIso(text: string): string | null {
  const m = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(text);
  return m ? isoDate(+m[3], +m[2], +m[1]) : null;
}

/** "22 sierpnia 2024" (month in the genitive) as "2024-08-22"; null otherwise. */
export function longDateToIso(
  day: string,
  monthName: string,
  year: string,
): string | null {
  const month = MONTHS_GENITIVE.indexOf(monthName.toLowerCase()) + 1;
  return month === 0 ? null : isoDate(+year, month, +day);
}

export function isIsoDate(text: unknown): text is string {
  if (typeof text !== "string") return false;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  return m !== null && isoDate(+m[1], +m[2], +m[3]) === text;
}

function outOfBounds(
  field: string,
  value: string,
  bound: string,
): SeriesFetchError {
  return new SeriesFetchError("SOURCE_INCONSISTENT", {
    field,
    value: echo(value),
    expected: bound,
  });
}

/**
 * The checks every origin of values goes through (spec 4.3), before the strict
 * terms parser: bounds, the sale window inside the code's sale month, and the
 * letter dated before the sale starts. Throws a `SeriesFetchError`.
 */
export function assertSeriesValues(
  code: ParsedSeriesCode,
  template: SeriesTemplate,
  values: SeriesValues,
): void {
  const rate = ExactDecimal.parse(values.firstPeriodRate);
  if (
    rate.isZero() ||
    rate.isNegative() ||
    rate.cmp(ExactDecimal.parse(RATE_MAX)) > 0
  ) {
    throw outOfBounds(
      "firstPeriodRate",
      values.firstPeriodRate,
      `0<x<=${RATE_MAX}`,
    );
  }
  if (template.addend === null) {
    if (values.addend !== null) {
      throw formatError("SOURCE_FORMAT_CHANGED", { field: "addend" });
    }
  } else {
    if (values.addend === null) {
      throw formatError("SOURCE_FORMAT_CHANGED", { field: template.addend });
    }
    const addend = ExactDecimal.parse(values.addend);
    if (addend.isNegative() || addend.cmp(ExactDecimal.parse(ADDEND_MAX)) > 0) {
      throw outOfBounds(template.addend, values.addend, `0<=x<=${ADDEND_MAX}`);
    }
  }
  if (!template.hasFee) {
    if (values.fee !== null) {
      throw formatError("SOURCE_FORMAT_CHANGED", { field: "fee" });
    }
  } else {
    if (values.fee === null) {
      throw formatError("SOURCE_FORMAT_CHANGED", { field: "fee" });
    }
    const fee = ExactDecimal.parse(values.fee);
    if (fee.isNegative() || fee.cmp(ExactDecimal.parse(FEE_MAX)) > 0) {
      throw outOfBounds("fee", values.fee, `0<=x<=${FEE_MAX}`);
    }
  }
  const { from, to } = values.saleWindow;
  if (from < code.saleWindow.from || to > code.saleWindow.to || from > to) {
    throw new SeriesFetchError("SOURCE_INCONSISTENT", {
      field: "saleWindow",
      source: `${from}/${to}`,
      expected: `${code.saleWindow.from}/${code.saleWindow.to}`,
    });
  }
  if (values.letterDate >= from) {
    throw new SeriesFetchError("SOURCE_INCONSISTENT", {
      field: "letterDate",
      source: values.letterDate,
      expected: `<${from}`,
    });
  }
}
