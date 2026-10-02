import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import {
  MAX_TRANSACTION_PAGES,
  REQUEST_TIMEOUT_MS,
} from "./providers/enable-banking/enable-banking.client";
import {
  BANK_SYNC_CONNECTION_STATUSES,
  BANK_SYNC_DEFAULT_NOTIFY_SUCCESS,
  BANK_SYNC_DEFAULT_TAG_OPERATION_TYPE,
  BANK_SYNC_LAST_SYNC_STATUSES,
  BANK_SYNC_NOTIFY_SUCCESS_MODES,
  BANK_SYNC_PROVIDERS,
  BANK_SYNC_PSU_TYPES,
  SYNC_LEASE_TTL_MS,
} from "./bank-sync.constants";

/**
 * `bank-sync.constants.ts` documents each list as written once, and each is also
 * a database CHECK. Nothing in TypeScript can read a SQL CHECK, so this guard is
 * what binds them: it fails when a list in `database/schema.sql` or in the
 * bank-sync migration drifts from its constant in either direction. Without it,
 * adding a status to the constant while forgetting the paired migration passes
 * every DTO validator and then fails each INSERT at runtime.
 */
const DATABASE = join(__dirname, "../../../database");
const SCHEMA = readFileSync(join(DATABASE, "schema.sql"), "utf8");
const MIGRATION_FILE = readdirSync(join(DATABASE, "migrations")).filter(
  (name) => name.endsWith("_bank_sync.sql"),
);
const MIGRATION = MIGRATION_FILE.map((name) =>
  readFileSync(join(DATABASE, "migrations", name), "utf8"),
).join("\n");

/** The body of `CREATE TABLE [IF NOT EXISTS] <table> ( ... );`. */
function tableBody(sql: string, table: string): string {
  const match = new RegExp(
    `CREATE TABLE (?:IF NOT EXISTS )?${table}\\s*\\(([\\s\\S]*?)\\n\\);`,
  ).exec(sql);
  if (!match) throw new Error(`no CREATE TABLE ${table} found`);
  return match[1];
}

/** The quoted values of `<column> IN ('a', 'b', ...)` inside one table. */
function checkList(sql: string, table: string, column: string): string[] {
  const match = new RegExp(`\\b${column}\\b\\s+IN\\s*\\(([^)]*)\\)`).exec(
    tableBody(sql, table),
  );
  if (!match) throw new Error(`no ${column} IN (...) CHECK in ${table}`);
  return match[1]
    .split(",")
    .map((entry) => entry.trim().replace(/^'|'$/g, ""))
    .filter((entry) => entry.length > 0);
}

describe("bank-sync constants match the database CHECK constraints", () => {
  it("finds the migration it is checking", () => {
    // A scan that silently matched nothing would pass every case below.
    expect(MIGRATION_FILE).toHaveLength(1);
  });

  describe.each([
    ["schema.sql", SCHEMA],
    ["the migration", MIGRATION],
  ])("%s", (_label, sql) => {
    it.each(["bank_sync_credentials", "bank_sync_connections"])(
      "the %s provider CHECK lists exactly BANK_SYNC_PROVIDERS",
      (table) => {
        expect(checkList(sql, table, "provider").sort()).toEqual(
          [...BANK_SYNC_PROVIDERS].sort(),
        );
      },
    );

    it("the connection status CHECK lists exactly BANK_SYNC_CONNECTION_STATUSES", () => {
      expect(checkList(sql, "bank_sync_connections", "status").sort()).toEqual(
        [...BANK_SYNC_CONNECTION_STATUSES].sort(),
      );
    });

    it("the connection psu_type CHECK lists exactly BANK_SYNC_PSU_TYPES", () => {
      expect(
        checkList(sql, "bank_sync_connections", "psu_type").sort(),
      ).toEqual([...BANK_SYNC_PSU_TYPES].sort());
    });

    it("the bank account last_sync_status CHECK lists exactly BANK_SYNC_LAST_SYNC_STATUSES", () => {
      expect(
        checkList(sql, "bank_sync_accounts", "last_sync_status").sort(),
      ).toEqual([...BANK_SYNC_LAST_SYNC_STATUSES].sort());
    });
  });
});

describe("the notify_success mode list", () => {
  // The column arrives in its own migration, so it is read from that file and
  // from the schema, and both must list exactly BANK_SYNC_NOTIFY_SUCCESS_MODES.
  const NOTIFY_MIGRATION_FILES = readdirSync(
    join(DATABASE, "migrations"),
  ).filter((name) => name.endsWith("_bank_sync_notify_success.sql"));
  const NOTIFY_MIGRATION = NOTIFY_MIGRATION_FILES.map((name) =>
    readFileSync(join(DATABASE, "migrations", name), "utf8"),
  ).join("\n");

  /** The quoted values of the first `notify_success IN (...)` in a SQL text. */
  function notifyList(sql: string): string[] {
    const match = /\bnotify_success\b\s+IN\s*\(([^)]*)\)/.exec(sql);
    if (!match) throw new Error("no notify_success IN (...) CHECK found");
    return match[1]
      .split(",")
      .map((entry) => entry.trim().replace(/^'|'$/g, ""))
      .filter((entry) => entry.length > 0);
  }

  it("finds the migration it is checking", () => {
    expect(NOTIFY_MIGRATION_FILES).toHaveLength(1);
  });

  it.each([
    ["schema.sql", tableBody(SCHEMA, "bank_sync_connections")],
    ["the migration", NOTIFY_MIGRATION],
  ])("%s lists exactly BANK_SYNC_NOTIFY_SUCCESS_MODES", (_label, sql) => {
    expect(notifyList(sql).sort()).toEqual(
      [...BANK_SYNC_NOTIFY_SUCCESS_MODES].sort(),
    );
  });

  it.each([
    ["schema.sql", tableBody(SCHEMA, "bank_sync_connections")],
    ["the migration", NOTIFY_MIGRATION],
  ])("%s defaults the column to the application default", (_label, sql) => {
    expect(sql).toMatch(
      new RegExp(
        `notify_success VARCHAR\\(20\\) NOT NULL DEFAULT '${BANK_SYNC_DEFAULT_NOTIFY_SUCCESS}'`,
      ),
    );
  });

  it("fits the column", () => {
    for (const mode of BANK_SYNC_NOTIFY_SUCCESS_MODES) {
      expect(mode.length).toBeLessThanOrEqual(20);
    }
  });
});

describe("the columns of the preview details (spec section 7b)", () => {
  // Both columns arrive in their own migration, so each is read from that file
  // and from the schema, and the two must agree with the constant and the entity.
  const DETAILS_MIGRATION_FILES = readdirSync(
    join(DATABASE, "migrations"),
  ).filter((name) =>
    name.endsWith("_bank_sync_exceptions_and_operation_tags.sql"),
  );
  const DETAILS_MIGRATION = DETAILS_MIGRATION_FILES.map((name) =>
    readFileSync(join(DATABASE, "migrations", name), "utf8"),
  ).join("\n");

  it("finds the migration it is checking", () => {
    expect(DETAILS_MIGRATION_FILES).toHaveLength(1);
  });

  it.each([
    ["schema.sql", tableBody(SCHEMA, "bank_sync_connections")],
    ["the migration", DETAILS_MIGRATION],
  ])(
    "%s defaults tag_operation_type to the application default",
    (_label, sql) => {
      expect(sql).toMatch(
        new RegExp(
          `tag_operation_type BOOLEAN NOT NULL DEFAULT ${BANK_SYNC_DEFAULT_TAG_OPERATION_TYPE}\\b`,
        ),
      );
    },
  );

  it.each([
    ["schema.sql", tableBody(SCHEMA, "bank_sync_imported_transactions")],
    ["the migration", DETAILS_MIGRATION],
  ])(
    "%s adds a nullable excluded_at timestamp to the ledger",
    (_label, sql) => {
      expect(sql).toMatch(/excluded_at TIMESTAMPTZ(?!\s+NOT NULL)/);
    },
  );

  it("adds both columns idempotently and as an expand only", () => {
    expect(DETAILS_MIGRATION).toMatch(
      /ADD COLUMN IF NOT EXISTS excluded_at TIMESTAMPTZ;/,
    );
    expect(DETAILS_MIGRATION).toMatch(
      /ADD COLUMN IF NOT EXISTS tag_operation_type BOOLEAN NOT NULL DEFAULT true;/,
    );
    expect(DETAILS_MIGRATION).not.toMatch(/\b(DROP|RENAME)\b\s+(COLUMN|TO)/i);
  });
});

describe("the per-account sync lease", () => {
  it("outlasts the worst case of one sync: every page at the request timeout, then the balances", () => {
    // 100 pages x 15 s is 25 minutes; the balance reads come after them. A lease
    // that lapses earlier lets a second sync hit the bank while the first runs.
    const worstCaseMs = (MAX_TRANSACTION_PAGES + 2) * REQUEST_TIMEOUT_MS;
    expect(SYNC_LEASE_TTL_MS).toBeGreaterThan(worstCaseMs);
  });

  it("is 30 minutes", () => {
    expect(SYNC_LEASE_TTL_MS).toBe(30 * 60 * 1000);
  });
});
