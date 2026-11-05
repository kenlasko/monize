import {
  CatalogEntry,
  ManualSeriesValues,
  SeriesFetchError,
} from "../../../bond-adapter";
import { ExactDecimal } from "../../../domain/exact-decimal";
import { parseSeriesCode } from "./series-code";
import { assertTemplateCovers, buildSeriesEntry } from "./series-entry";
import { echo } from "../../../series-echo";
import { isIsoDate, SeriesValues } from "./series-values";
import { seriesPageUrl } from "./series-source";
import { SERIES_TEMPLATES } from "./templates";

const badField = (field: string, value: unknown) =>
  new SeriesFetchError("MANUAL_ENTRY_INVALID", { field, value: echo(value) });

/** A decimal string of at most `places` places, in the 4-place or 2-place form. */
function decimalString(
  value: unknown,
  field: string,
  places: number,
  maxPlaces: number,
): string {
  if (
    typeof value !== "string" ||
    !new RegExp(`^\\d{1,3}(\\.\\d{1,${maxPlaces}})?$`).test(value)
  ) {
    throw badField(field, value);
  }
  return places === 2
    ? ExactDecimal.parse(value).toFixed(2)
    : ExactDecimal.parse(value).toTrimmedString(10, 4);
}

function optional(
  value: string | null | undefined,
  field: string,
  places: number,
  maxPlaces: number,
): string | null {
  return value === null || value === undefined
    ? null
    : decimalString(value, field, places, maxPlaces);
}

/**
 * An administrator's entry for a series whose official source cannot be read:
 * the same template, bounds and strict parser as a fetched series, the sale
 * window must match the code, and the stored source is `manual`.
 */
export function manualSeries(
  seriesCode: string,
  values: ManualSeriesValues,
): CatalogEntry {
  const code = parseSeriesCode(seriesCode);
  const template = SERIES_TEMPLATES[code.product];
  assertTemplateCovers(code, template);

  const { from, to } = values.saleWindow ?? { from: undefined, to: undefined };
  if (!isIsoDate(from)) throw badField("saleWindow", from);
  if (!isIsoDate(to)) throw badField("saleWindow", to);
  const number = values.letter?.number;
  if (typeof number !== "string" || !/^\d{1,4}\/\d{4}$/.test(number)) {
    throw badField("letterNumber", number);
  }
  const date = values.letter?.date;
  if (!isIsoDate(date)) throw badField("letterDate", date);

  const parsed: SeriesValues = {
    firstPeriodRate: decimalString(
      values.firstPeriodRate,
      "firstPeriodRate",
      4,
      6,
    ),
    addend: optional(values.addend, template.addend ?? "addend", 4, 6),
    fee: optional(values.fee, "fee", 2, 2),
    saleWindow: { from, to },
    letterNumber: number,
    letterDate: date,
  };
  // Presence follows the template (a margin only where the product has one, a
  // fee only where it charges one): the administrator typed it, so the refusal
  // names their field rather than a changed source.
  if ((parsed.addend === null) !== (template.addend === null)) {
    throw badField(template.addend ?? "addend", values.addend);
  }
  if ((parsed.fee === null) === template.hasFee) {
    throw badField("fee", values.fee);
  }
  return buildSeriesEntry(code, template, parsed, {
    provider: "manual",
    url: seriesPageUrl(code),
  });
}
