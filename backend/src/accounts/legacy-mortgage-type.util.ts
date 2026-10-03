/**
 * The mortgage type of an account snapshot written before the contract
 * migration (docs/specs/mortgage-types.md, task P3-B1), for the two paths that
 * replay one into today's schema: a backup restore and an action-history undo.
 *
 * Before Phase 1 a snapshot carries `is_canadian_mortgage` / `is_variable_rate`
 * and no type; in Phases 1 and 2 it carries a type that is null on every
 * non-mortgage row and on a mortgage a pre-Phase-1 pod wrote. The column is now
 * NOT NULL and the flags are gone, so the restore's column filter would drop
 * the flags and either insert the default (turning a Canadian fixed-rate
 * mortgage into ANNUITY) or the null (refused by NOT NULL).
 *
 * The answer is the contract migration's: a stored type stands; a missing one
 * on a MORTGAGE is the type its flags denote (spec table 4.2: Canadian and not
 * variable is CANADIAN_FIXED, a NULL flag reading as false); on every other
 * account it is the column default, ANNUITY. A stored value is passed through
 * unchecked, as every other restored column is: the CHECK refuses a bad one.
 *
 * This module is the one place in `src/` that names the dropped flags.
 */
function mortgageTypeOfSnapshot(
  accountType: unknown,
  mortgageType: unknown,
  isCanadianMortgage: unknown,
  isVariableRate: unknown,
): unknown {
  if (mortgageType !== null && mortgageType !== undefined) return mortgageType;
  return accountType === "MORTGAGE" &&
    isCanadianMortgage === true &&
    isVariableRate !== true
    ? "CANADIAN_FIXED"
    : "ANNUITY";
}

/** The legacy flag columns, which today's schema no longer has. */
const LEGACY_FLAG_COLUMNS = ["is_canadian_mortgage", "is_variable_rate"];
const LEGACY_FLAG_PROPERTIES = ["isCanadianMortgage", "isVariableRate"];

/**
 * A backup's `accounts` row (snake_case) with `mortgage_type` resolved and the
 * legacy flag columns removed. A new object; the input is not mutated.
 */
export function withResolvedMortgageTypeColumn(
  row: Record<string, unknown>,
): Record<string, unknown> {
  const resolved: Record<string, unknown> = {
    ...row,
    mortgage_type: mortgageTypeOfSnapshot(
      row.account_type,
      row.mortgage_type,
      row.is_canadian_mortgage,
      row.is_variable_rate,
    ),
  };
  for (const column of LEGACY_FLAG_COLUMNS) delete resolved[column];
  return resolved;
}

/**
 * An action-history account snapshot (camelCase) with `mortgageType` resolved
 * and the legacy flag properties removed. A new object; the input is not
 * mutated. A snapshot without `accountType` is not a whole row, so its type is
 * left as it is (absent leaves the stored column alone on an update).
 */
export function withResolvedMortgageTypeProperty(
  snapshot: Record<string, unknown>,
): Record<string, unknown> {
  const resolved: Record<string, unknown> =
    "accountType" in snapshot
      ? {
          ...snapshot,
          mortgageType: mortgageTypeOfSnapshot(
            snapshot.accountType,
            snapshot.mortgageType,
            snapshot.isCanadianMortgage,
            snapshot.isVariableRate,
          ),
        }
      : { ...snapshot };
  for (const property of LEGACY_FLAG_PROPERTIES) delete resolved[property];
  return resolved;
}
