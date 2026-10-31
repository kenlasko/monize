/**
 * Every column that holds a `currencies(code)` value.
 *
 * The two SQL functions (migrations 136 and 137) answer the *database's*
 * questions about this list. This is the same list for the one caller that
 * cannot ask the database: the support backup rewrites currency codes inside an
 * in-memory export, after the rows have left Postgres.
 *
 * It is a hand-written list, which is exactly the thing that has gone wrong here
 * three times -- so `currency-references.spec.ts` parses
 * `database/schema.sql` and fails when this and the schema disagree in either
 * direction. Add a currency reference in a migration and the test names it.
 */
export const CURRENCY_REFERENCE_COLUMNS: Readonly<
  Record<string, readonly string[]>
> = {
  shared_groups: ["currency_code"],
  shared_entries: ["original_currency_code"],
  user_currency_preferences: ["currency_code"],
  // Global reference data with no owner. Present for completeness (the guard
  // test compares against every FK in the schema) but never in a user's export.
  exchange_rates: ["from_currency", "to_currency"],
  exchange_rate_coverage: ["from_currency", "to_currency"],
  // Global reference data with no owner (the bond catalog), never in an export.
  bond_programs: ["currency_code"],
  bond_instruments: ["currency_code"],
  accounts: ["currency_code"],
  transactions: ["currency_code", "original_currency_code"],
  securities: ["currency_code"],
  scheduled_transactions: ["currency_code", "original_currency_code"],
  budgets: ["currency_code"],
  // The informational purchase price's currency; NULL when no price is set.
  warranties: ["currency_code"],
  user_preferences: ["default_currency"],
};
