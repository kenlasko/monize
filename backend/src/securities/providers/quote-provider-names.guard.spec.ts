import { readFileSync } from "fs";
import { join } from "path";
import {
  DEFAULT_QUOTE_PROVIDER_NAMES,
  QUOTE_PROVIDER_NAMES,
} from "./quote-provider.interface";

/**
 * `quote-provider.interface.ts` documents `QUOTE_PROVIDER_NAMES` as the single
 * source of truth for the provider set, including the database CHECK on
 * `quote_provider` / `default_quote_provider`. Nothing in TypeScript can read a
 * SQL CHECK, so this guard is what actually binds the two: it fails if the list
 * in `database/schema.sql` drifts from the constant in either direction. Without
 * it, adding a provider to the const while forgetting the paired migration
 * passes the `@IsIn` DTO validators and then fails every INSERT at runtime.
 */
const SCHEMA = readFileSync(
  join(__dirname, "../../../../database/schema.sql"),
  "utf8",
);

/** The quoted values of the `<column> IN ('a','b',...)` CHECK in schema.sql. */
function checkInList(column: string): string[] {
  const match = new RegExp(`\\b${column}\\b\\s+IN\\s*\\(([^)]*)\\)`, "i").exec(
    SCHEMA,
  );
  if (!match) throw new Error(`no CHECK IN (...) found for ${column}`);
  return match[1]
    .split(",")
    .map((entry) => entry.trim().replace(/^'|'$/g, ""))
    .filter((entry) => entry.length > 0);
}

describe("the provider lists match the database CHECK constraints", () => {
  it("the quote_provider CHECK lists exactly QUOTE_PROVIDER_NAMES", () => {
    expect(checkInList("quote_provider").sort()).toEqual(
      [...QUOTE_PROVIDER_NAMES].sort(),
    );
  });

  // A user's default applies to every security without an override, so it
  // can never be a provider that needs a page the security names: the column
  // holds exactly the providers a person may choose as the default.
  it("the default_quote_provider CHECK lists exactly DEFAULT_QUOTE_PROVIDER_NAMES", () => {
    expect(checkInList("default_quote_provider").sort()).toEqual(
      [...DEFAULT_QUOTE_PROVIDER_NAMES].sort(),
    );
  });
});
