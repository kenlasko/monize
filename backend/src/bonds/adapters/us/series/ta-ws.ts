import { SeriesFetchError } from "../../../bond-adapter";
import { isValidYMD } from "../../../domain/calendar-date";
import { ExactDecimal } from "../../../domain/exact-decimal";

/** One auction of a CUSIP, as TreasuryDirect's `TA_WS` JSON gives it. */
export type AuctionRecord = Readonly<Record<string, unknown>>;

const DATE_PATTERN = /^(\d{4}-\d{2}-\d{2})(?:T00:00:00)?$/;
const PERCENT_PATTERN = /^\d{1,3}(?:\.\d{1,9})?$/;
const LEVEL_PATTERN = /^\d{1,4}(?:\.\d{1,9})?$/;
const SIGNED_PERCENT_PATTERN = /^-?\d{1,3}(?:\.\d{1,9})?$/;

export function formatChanged(field: string): SeriesFetchError {
  return new SeriesFetchError("SOURCE_FORMAT_CHANGED", { field });
}

/** The body as the array of auction records; anything else is a changed format. */
export function parseAuctionArray(body: Uint8Array): AuctionRecord[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8").decode(body));
  } catch {
    throw formatChanged("json");
  }
  if (!Array.isArray(parsed)) throw formatChanged("array");
  for (const item of parsed) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      throw formatChanged("auction");
    }
  }
  return parsed as AuctionRecord[];
}

/**
 * The text of a field: "" when it is absent, null or blank. A JSON number or
 * object is refused, never read (a money or a rate is a string, INV-BOND-003).
 */
export function optionalText(record: AuctionRecord, field: string): string {
  const value = record[field];
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") throw formatChanged(field);
  return value.trim();
}

export function requiredText(record: AuctionRecord, field: string): string {
  const text = optionalText(record, field);
  if (text === "") throw formatChanged(field);
  return text;
}

/** `YYYY-MM-DD`, optionally followed by `T00:00:00`, a real calendar date. */
export function parseDate(text: string, field: string): string {
  const match = DATE_PATTERN.exec(text);
  if (!match || !isValidYMD(match[1])) throw formatChanged(field);
  return match[1];
}

/** A percent string ("4.285000") as an exact decimal; not negative. */
export function parsePercent(text: string, field: string): ExactDecimal {
  if (!PERCENT_PATTERN.test(text)) throw formatChanged(field);
  return ExactDecimal.parse(text);
}

/** An index level ("177.50000"), not negative. */
export function parseIndexLevel(text: string, field: string): ExactDecimal {
  if (!LEVEL_PATTERN.test(text)) throw formatChanged(field);
  return ExactDecimal.parse(text);
}

/** A percent string that may be negative (a floating rate note's spread). */
export function parseSignedPercent(text: string, field: string): ExactDecimal {
  if (!SIGNED_PERCENT_PATTERN.test(text)) throw formatChanged(field);
  return ExactDecimal.parse(text);
}

/** The flags are "Yes" or "No". */
export function parseFlag(text: string, field: string): boolean {
  if (text === "Yes") return true;
  if (text === "No") return false;
  throw formatChanged(field);
}

export function requiredDate(record: AuctionRecord, field: string): string {
  return parseDate(requiredText(record, field), field);
}

export function requiredFlag(record: AuctionRecord, field: string): boolean {
  return parseFlag(requiredText(record, field), field);
}
