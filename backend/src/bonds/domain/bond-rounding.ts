import { RoundingMode } from "./exact-decimal";
import { BondTermsError, object } from "./terms-readers";

/** How a lot's figures are rounded: the decimals of its money and the mode. */
export interface BondRounding {
  readonly moneyDecimals: 0 | 1 | 2 | 3 | 4;
  readonly mode: RoundingMode;
}

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

/** Reads `terms.rounding` (spec 2.1). */
export function parseRounding(value: unknown, path: string): BondRounding {
  const r = object(value, path, ["moneyDecimals", "mode"]);
  return {
    moneyDecimals: moneyDecimals(r.moneyDecimals, `${path}.moneyDecimals`),
    mode: roundingMode(r.mode, `${path}.mode`),
  };
}
