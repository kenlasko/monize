import { ExactDecimal, RoundingMode } from "./exact-decimal";
import {
  BondTermsError,
  decimal,
  integer,
  object,
  oneOf,
  Json,
} from "./terms-readers";

/**
 * Where a figure is rounded (`docs/specs/bond-marketable-primitives.md` 4):
 * `PER_UNIT` rounds each bond's figure and multiplies it by the quantity (the
 * default); `PER_HOLDING` rounds the lot's figure once, after an optional
 * per-unit rounding of the intermediate; `REFERENCE_AMOUNT` rounds the value of
 * one reference amount of face, scales it to the holding and rounds again.
 */
export type RoundingBasis = "PER_UNIT" | "PER_HOLDING" | "REFERENCE_AMOUNT";

export interface BondRounding {
  readonly moneyDecimals: 0 | 1 | 2 | 3 | 4;
  readonly mode: RoundingMode;
  /** Absent is `PER_UNIT`; read it through `roundingBasisOf`. */
  readonly basis?: RoundingBasis;
  /**
   * Decimals a per-unit intermediate is rounded to before the holding is
   * rounded (0 to 12); null leaves it exact. Only with `PER_HOLDING` and
   * `REFERENCE_AMOUNT`.
   */
  readonly unitDecimals?: number | null;
  /** The face the value of `REFERENCE_AMOUNT` is rounded for: a positive multiple of `faceValue`. */
  readonly referenceAmount?: string;
}

/** The basis the terms round on: `PER_UNIT` when the document names none. */
export function roundingBasisOf(terms: {
  readonly rounding: BondRounding;
}): RoundingBasis {
  return terms.rounding.basis ?? "PER_UNIT";
}

const BASES: readonly RoundingBasis[] = [
  "PER_UNIT",
  "PER_HOLDING",
  "REFERENCE_AMOUNT",
];

const MAX_UNIT_DECIMALS = 12;

function moneyDecimals(value: unknown, path: string): 0 | 1 | 2 | 3 | 4 {
  if (value !== 0 && value !== 1 && value !== 2 && value !== 3 && value !== 4) {
    throw new BondTermsError(path, "must be an integer from 0 to 4");
  }
  return value;
}

/** An unknown mode is an unsupported primitive, like an unknown `type`. */
function roundingMode(value: unknown, path: string): RoundingMode {
  if (typeof value !== "string") {
    throw new BondTermsError(path, "must be a string");
  }
  const known: readonly RoundingMode[] = ["HALF_UP", "HALF_EVEN", "DOWN"];
  if (!known.includes(value as RoundingMode)) {
    throw new BondTermsError(
      path,
      `unsupported rounding mode ${JSON.stringify(value)}; supported: ${known.join(", ")}`,
      "UNSUPPORTED_PRIMITIVE",
    );
  }
  return value as RoundingMode;
}

function unitDecimals(value: unknown, path: string): number | null {
  if (value === null) return null;
  const n = integer(value, path, 0);
  if (n > MAX_UNIT_DECIMALS) {
    throw new BondTermsError(
      path,
      `must be an integer from 0 to ${MAX_UNIT_DECIMALS}, or null`,
    );
  }
  return n;
}

/** True when `amount` is a whole number of `face`. */
function isMultipleOf(amount: string, face: string): boolean {
  return (
    ExactDecimal.parse(amount).div(ExactDecimal.parse(face)).denominator === 1n
  );
}

/**
 * Reads `terms.rounding`. A document with none of the basis fields yields
 * exactly the two-field object it always did, so a stored document parses to
 * what it parsed to before the basis existed (INV-BOND-001).
 */
export function parseRounding(
  value: unknown,
  path: string,
  faceValue: string,
): BondRounding {
  const r: Json = object(
    value,
    path,
    ["moneyDecimals", "mode"],
    ["basis", "unitDecimals", "referenceAmount"],
  );
  const base = {
    moneyDecimals: moneyDecimals(r.moneyDecimals, `${path}.moneyDecimals`),
    mode: roundingMode(r.mode, `${path}.mode`),
  };
  const basis =
    r.basis === undefined ? undefined : oneOf(r.basis, `${path}.basis`, BASES);
  const effective: RoundingBasis = basis ?? "PER_UNIT";

  if (effective === "PER_UNIT") {
    for (const field of ["unitDecimals", "referenceAmount"] as const) {
      if (r[field] !== undefined) {
        throw new BondTermsError(
          `${path}.${field}`,
          "not allowed with the PER_UNIT basis",
        );
      }
    }
    return basis === undefined ? base : { ...base, basis };
  }

  if (effective === "PER_HOLDING" && r.referenceAmount !== undefined) {
    throw new BondTermsError(
      `${path}.referenceAmount`,
      "only for the REFERENCE_AMOUNT basis",
    );
  }
  let referenceAmount: string | undefined;
  if (effective === "REFERENCE_AMOUNT") {
    if (r.referenceAmount === undefined) {
      throw new BondTermsError(
        `${path}.referenceAmount`,
        "required for the REFERENCE_AMOUNT basis",
      );
    }
    referenceAmount = decimal(r.referenceAmount, `${path}.referenceAmount`);
    const positive = !ExactDecimal.parse(referenceAmount).isZero();
    if (!positive || !isMultipleOf(referenceAmount, faceValue)) {
      throw new BondTermsError(
        `${path}.referenceAmount`,
        "must be a positive multiple of the face value",
      );
    }
  }
  return {
    ...base,
    basis: effective,
    ...(r.unitDecimals === undefined
      ? {}
      : { unitDecimals: unitDecimals(r.unitDecimals, `${path}.unitDecimals`) }),
    ...(referenceAmount === undefined ? {} : { referenceAmount }),
  };
}
