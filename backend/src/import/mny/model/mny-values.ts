import { MnyValue } from "../msisam/open-mny";

/**
 * Normalisation of raw Jet values into the shapes the rest of the importer
 * uses. Every converter accepts `null` -- a column absent from this Money
 * version reads as null, so tolerance lives here rather than in each reader.
 *
 * `mdb-reader` already decodes Jet types natively: datetimes arrive as `Date`
 * built from an absolute epoch value (so UTC accessors are timezone-safe), and
 * currency columns arrive as exact decimal *strings*, never floats.
 */

/**
 * Earliest year a Money date may plausibly carry. Jet's zero date is
 * 1899-12-30; Money writes it for "no date".
 */
export const MNY_MIN_YEAR = 1900;
/**
 * Latest plausible year. Money's other "no date" sentinel is year 10000
 * (`+010000-02-28`), which is what the sample files actually contain -- 1320
 * of the 2292 date values in `money2002.mny` are it.
 */
export const MNY_MAX_YEAR = 2199;

/** Handle values Money uses to mean "no reference". */
const NULL_HANDLES: ReadonlySet<number> = new Set([0, -1]);

/**
 * Microsoft Money amounts are fiat and carry four places at most, so the .mny
 * import stays at four (`docs/specs/money-precision.md` section 10), not the
 * `NUMERIC(24,8)` the columns now hold.
 */
const AMOUNT_SCALE = 10000;

/** Trimmed text, or an empty string when absent. */
export function toText(value: MnyValue): string {
  return typeof value === "string" ? value.trim() : "";
}

/** Trimmed text, or null when absent or blank after trimming. */
export function toOptionalText(value: MnyValue): string | null {
  const text = toText(value);
  return text === "" ? null : text;
}

/**
 * A Money row handle (`hacct`, `hcat`, `lHpay`, ...), or null when the row
 * points at nothing. Money is inconsistent about this: older files leave the
 * column null, Money Plus writes -1, and 0 appears in both.
 */
export function toHandle(value: MnyValue): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  return NULL_HANDLES.has(value) ? null : value;
}

/** An integer column (`at`, `cs`, `act`, flag words), defaulting to `fallback`. */
export function toInteger(value: MnyValue, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.trunc(value)
    : fallback;
}

/** A floating-point column (`qty`, `dPrice`, `rate`), defaulting to `fallback`. */
export function toNumber(value: MnyValue, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/**
 * A money column. Jet currency values arrive as exact decimal strings, so this
 * rounds through integer arithmetic rather than accumulating float error --
 * the repository's financial-math rule.
 */
export function toAmount(value: MnyValue): number {
  const raw =
    typeof value === "string"
      ? Number(value)
      : typeof value === "number"
        ? value
        : 0;
  return Number.isFinite(raw)
    ? Math.round(raw * AMOUNT_SCALE) / AMOUNT_SCALE
    : 0;
}

/** A Jet boolean column. Absent reads as false, which is Money's own default. */
export function toBoolean(value: MnyValue): boolean {
  return value === true;
}

/**
 * A Money date as `YYYY-MM-DD`, or null when it is absent or one of Money's
 * "no date" sentinels. The repository stores DATE columns as strings to avoid
 * timezone shifting, and `mdb-reader` gives absolute-epoch `Date`s, so UTC
 * accessors are the correct -- and only safe -- way to read the parts.
 */
export function toDate(value: MnyValue): string | null {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    return null;
  }

  const year = value.getUTCFullYear();
  if (year < MNY_MIN_YEAR || year > MNY_MAX_YEAR) {
    return null;
  }

  const month = String(value.getUTCMonth() + 1).padStart(2, "0");
  const day = String(value.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
