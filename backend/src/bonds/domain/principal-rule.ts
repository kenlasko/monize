import { ExactDecimal } from "./exact-decimal";
import {
  BondTermsError,
  decimal,
  integer,
  object,
  oneOf,
  primitive,
  text,
} from "./terms-readers";

/**
 * The principal tracks an index (`docs/specs/bond-marketable-primitives.md` 7.1):
 * `faceValue x indexRatio(date)`, the ratio of the reference index of the day to
 * the reference index of the dated date (`baseReference`). The reference index of
 * a day is read from a `MONTHLY` benchmark of unit `INDEX_LEVEL`, `lagMonths`
 * back, by daily linear interpolation, truncated to `truncateDecimals` and then
 * rounded to `roundDecimals`; so is the ratio. `maturityFloor: PAR` pays at least
 * the face value at maturity.
 */
export interface IndexRatioRule {
  readonly type: "INDEX_RATIO";
  readonly benchmarkId: string;
  /** The reference index of the dated date, as published: a positive decimal. */
  readonly baseReference: string;
  readonly lagMonths: number;
  readonly interpolation: "DAILY_LINEAR";
  readonly truncateDecimals: number;
  readonly roundDecimals: number;
  readonly maturityFloor: "PAR" | "NONE";
}

export type PrincipalRule = { readonly type: "FIXED_NOMINAL" } | IndexRatioRule;

/** The most decimals a reference index or ratio is cut to (a bound against a hostile document). */
const MAX_DECIMALS = 12;
const MAX_LAG_MONTHS = 12;

/** A principal rule: `FIXED_NOMINAL` (the face value) or `INDEX_RATIO`. */
export function parsePrincipalRule(
  value: unknown,
  path: string,
): PrincipalRule {
  const type = primitive(value, path, [
    "FIXED_NOMINAL",
    "INDEX_RATIO",
  ] as const);
  if (type === "FIXED_NOMINAL") {
    object(value, path, ["type"]);
    return { type };
  }
  const r = object(value, path, [
    "type",
    "benchmarkId",
    "baseReference",
    "lagMonths",
    "interpolation",
    "truncateDecimals",
    "roundDecimals",
    "maturityFloor",
  ]);
  const baseReference = decimal(r.baseReference, `${path}.baseReference`);
  if (ExactDecimal.parse(baseReference).isZero()) {
    throw new BondTermsError(`${path}.baseReference`, "must be positive");
  }
  const lagMonths = integer(r.lagMonths, `${path}.lagMonths`, 1);
  if (lagMonths > MAX_LAG_MONTHS) {
    throw new BondTermsError(
      `${path}.lagMonths`,
      `must be at most ${MAX_LAG_MONTHS}`,
    );
  }
  const truncateDecimals = integer(
    r.truncateDecimals,
    `${path}.truncateDecimals`,
    0,
  );
  const roundDecimals = integer(r.roundDecimals, `${path}.roundDecimals`, 0);
  if (truncateDecimals > MAX_DECIMALS) {
    throw new BondTermsError(
      `${path}.truncateDecimals`,
      `must be at most ${MAX_DECIMALS}`,
    );
  }
  if (roundDecimals > truncateDecimals) {
    throw new BondTermsError(
      `${path}.roundDecimals`,
      "must not be more than truncateDecimals",
    );
  }
  return {
    type,
    benchmarkId: text(r.benchmarkId, `${path}.benchmarkId`),
    baseReference,
    lagMonths,
    interpolation: oneOf(r.interpolation, `${path}.interpolation`, [
      "DAILY_LINEAR",
    ] as const),
    truncateDecimals,
    roundDecimals,
    maturityFloor: oneOf(r.maturityFloor, `${path}.maturityFloor`, [
      "PAR",
      "NONE",
    ] as const),
  };
}
