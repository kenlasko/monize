import {
  prepareSharedRestore,
  RESTORE_CLEARED_COLUMNS,
  RESTORE_PRINCIPAL_COLUMNS,
} from "./shared-backup";
import { BadRequestException } from "@nestjs/common";
import { randomUUID } from "crypto";
import { canonicalUuid, collectRowIdRemap } from "./backup-id-remap.util";
import { BackupData, backupTables } from "./backup-format";
import { DEFERRED_FK_COLUMNS, RESTORE_PLAN } from "./restore-plan";
import {
  CATALOG_ON_SEVERED,
  CATALOG_REFERENCE_COLUMNS,
  NON_UUID_ID_TABLES,
  remapRestoreRow,
  resolveRestoreReferences,
  RESTORE_REFERENCE_COLUMNS,
  SEVERED_WHEN_UNRESOLVED,
} from "./restore-references";
import {
  parseForeignKeys,
  parseTableColumns,
  readSchema,
} from "./__fixtures__/schema-foreign-keys";

/**
 * A restore may only write rows whose references name rows of the same file.
 *
 * The defect: `insertRows` forced `user_id` and nothing else, and the id remap
 * covered only the hyphenated UUID spelling of keys the file contained. A file
 * naming another user's account, transaction, security or schedule therefore
 * wrote rows pointing into that user's data, and a key spelled without hyphens
 * (which PostgreSQL accepts) was not remapped, conflicted on insert, and was
 * then rewritten in place by the Phase-3 `UPDATE ... WHERE id = $2`.
 */

const schema = readSchema();
const foreignKeys = parseForeignKeys(schema);
const restored = new Set(RESTORE_PLAN.map((step) => step.table));

// Ids as the exporter writes them: canonical, lower-case, hyphenated.
const ACCOUNT = "11111111-1111-4111-8111-111111111111";
const ACCOUNT_2 = "11111111-1111-4111-8111-111111111112";
const TXN = "22222222-2222-4222-8222-222222222222";
const TXN_2 = "22222222-2222-4222-8222-222222222223";
const SECURITY = "33333333-3333-4333-8333-333333333333";
const SCHEDULE = "44444444-4444-4444-8444-444444444444";
const OVERRIDE = "55555555-5555-4555-8555-555555555555";
const HOLDING = "66666666-6666-4666-8666-666666666666";
const INSTITUTION = "77777777-7777-4777-8777-777777777777";
// Somebody else's rows on the same instance.
const VICTIM_ACCOUNT = "aaaaaaaa-0000-4000-8000-00000000000a";
const VICTIM_TXN = "aaaaaaaa-0000-4000-8000-00000000000b";
const VICTIM_SECURITY = "aaaaaaaa-0000-4000-8000-00000000000c";
const VICTIM_SCHEDULE = "aaaaaaaa-0000-4000-8000-00000000000d";

function backup(tables: Record<string, unknown[]>): BackupData {
  return {
    version: 1,
    exportedAt: "2026-01-01T00:00:00.000Z",
    ...tables,
  } as unknown as BackupData;
}

/** What the exporter writes for a small, self-consistent ledger. */
function genuineBackup(): BackupData {
  return backup({
    institutions: [{ id: INSTITUTION, user_id: "u", name: "Bank" }],
    accounts: [
      {
        id: ACCOUNT,
        user_id: "u",
        institution_id: INSTITUTION,
        linked_account_id: ACCOUNT_2,
      },
      { id: ACCOUNT_2, user_id: "u", linked_account_id: ACCOUNT },
    ],
    securities: [{ id: SECURITY, user_id: "u", symbol: "VEA" }],
    security_prices: [{ id: "5", security_id: SECURITY, close_price: 1 }],
    holdings: [{ id: HOLDING, account_id: ACCOUNT, security_id: SECURITY }],
    scheduled_transactions: [
      {
        id: SCHEDULE,
        user_id: "u",
        account_id: ACCOUNT,
        tag_ids: [],
      },
    ],
    scheduled_transaction_overrides: [
      {
        id: OVERRIDE,
        scheduled_transaction_id: SCHEDULE,
        splits: [{ transferAccountId: ACCOUNT_2 }],
      },
    ],
    transactions: [
      {
        id: TXN,
        user_id: "u",
        account_id: ACCOUNT,
        linked_transaction_id: TXN_2,
      },
      {
        id: TXN_2,
        user_id: "u",
        account_id: ACCOUNT_2,
        linked_transaction_id: TXN,
      },
    ],
    currencies: [{ code: "USD", created_by_user_id: null }],
  });
}

function refusal(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(BadRequestException);
    return (error as BadRequestException).message;
  }
  throw new Error("expected the restore to be refused");
}

describe("canonicalUuid", () => {
  const canonical = "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11";

  it.each([
    canonical,
    "A0EEBC99-9C0B-4EF8-BB6D-6BB9BD380A11",
    "{a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11}",
    "a0eebc999c0b4ef8bb6d6bb9bd380a11",
    "a0ee-bc99-9c0b-4ef8-bb6d-6bb9-bd38-0a11",
    "{a0eebc99-9c0b4ef8-bb6d6bb9-bd380a11}",
  ])("reads %s as the UUID PostgreSQL would", (spelling) => {
    expect(canonicalUuid(spelling)).toBe(canonical);
  });

  it.each([
    "acc-1",
    "5",
    "",
    "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a1",
    "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11-",
    "-a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11",
    "a0eebc9-99c0b-4ef8-bb6d-6bb9bd380a11",
    "{a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11",
    "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11}",
    " a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11",
    "g0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11",
  ])("rejects %j, which PostgreSQL would not accept", (spelling) => {
    expect(canonicalUuid(spelling)).toBeNull();
  });

  it("rejects a value that is not a string", () => {
    expect(canonicalUuid(12)).toBeNull();
    expect(canonicalUuid(null)).toBeNull();
    expect(canonicalUuid({ id: canonical })).toBeNull();
  });
});

describe("RESTORE_REFERENCE_COLUMNS against database/schema.sql", () => {
  const declared = new Set(
    Object.entries(RESTORE_REFERENCE_COLUMNS).flatMap(([table, columns]) =>
      Object.entries(columns).map(
        ([column, target]) => `${table}.${column} -> ${target}`,
      ),
    ),
  );
  const schemaReferences = new Set(
    foreignKeys
      .filter(
        (fk) => restored.has(fk.table) && restored.has(fk.referencedTable),
      )
      .map((fk) => `${fk.table}.${fk.column} -> ${fk.referencedTable}`),
  );

  it("covers every foreign key between two restored tables", () => {
    // A reference column missing here is inserted verbatim: a crafted file can
    // point it at another user's row. Add it to RESTORE_REFERENCE_COLUMNS.
    const missing = [...schemaReferences].filter((key) => !declared.has(key));
    expect(missing).toEqual([]);
  });

  it("declares nothing the schema does not", () => {
    const stale = [...declared].filter((key) => !schemaReferences.has(key));
    expect(stale).toEqual([]);
  });

  it("finds a floor of references, so a broken parser cannot pass vacuously", () => {
    expect(schemaReferences.size).toBeGreaterThan(60);
  });

  it("leaves only users, currencies and declared catalog references outside the restored graph", () => {
    // A foreign key from a restored table to a table the restore does not
    // write would need its own rule for which rows the user may reference. The
    // catalog columns have one (CATALOG_REFERENCE_COLUMNS: kept only where the
    // deployment's own catalog holds the row, else NULL).
    const outside = foreignKeys
      .filter(
        (fk) =>
          restored.has(fk.table) &&
          !restored.has(fk.referencedTable) &&
          fk.referencedTable !== "users" &&
          fk.referencedTable !== "currencies" &&
          CATALOG_REFERENCE_COLUMNS[fk.table]?.[fk.column] !==
            fk.referencedTable,
      )
      .map((fk) => `${fk.table}.${fk.column} -> ${fk.referencedTable}`);
    expect(outside).toEqual([]);
  });

  it("declares a severed-link effect only for a catalog column it severs", () => {
    for (const key of CATALOG_ON_SEVERED.keys()) {
      const [table, column] = key.split(".");
      expect(CATALOG_REFERENCE_COLUMNS[table]?.[column]).toBeDefined();
    }
  });

  it("declares only catalog references the schema has, to tables the restore does not write, on nullable columns", () => {
    for (const [table, columns] of Object.entries(CATALOG_REFERENCE_COLUMNS)) {
      for (const [column, target] of Object.entries(columns)) {
        expect(restored.has(table)).toBe(true);
        expect(restored.has(target)).toBe(false);
        expect(
          foreignKeys.some(
            (fk) =>
              fk.table === table &&
              fk.column === column &&
              fk.referencedTable === target,
          ),
        ).toBe(true);
        const definition = new RegExp(
          `CREATE TABLE(?: IF NOT EXISTS)?\\s+${table}\\s*\\(([\\s\\S]*?)\\n\\);`,
        ).exec(schema)![1];
        const line = new RegExp(`^\\s*${column}\\s+[^\\n]*$`, "m").exec(
          definition,
        )![0];
        expect(line).not.toMatch(/NOT NULL/);
      }
    }
  });

  it("classifies every scalar UUID column of every restored table", () => {
    // `id` is canonicalised and remapped, `user_id` is forced, a declared
    // reference is resolved inside the file. A UUID column that is none of
    // those would be the one the check skips. (UUID[] columns are nested
    // values: remapped or neutralised by remapRestoreRow.)
    const unclassified: string[] = [];
    for (const table of restored) {
      const columns = parseTableColumns(schema, table);
      expect(columns).not.toBeNull();
      for (const { name, type } of columns!) {
        if (type !== "UUID") continue;
        if (name === "id" || name === "user_id") continue;
        if (
          RESTORE_REFERENCE_COLUMNS[table]?.[name] === undefined &&
          CATALOG_REFERENCE_COLUMNS[table]?.[name] === undefined &&
          RESTORE_PRINCIPAL_COLUMNS[table]?.[name] === undefined &&
          !RESTORE_CLEARED_COLUMNS[table]?.includes(name)
        ) {
          unclassified.push(`${table}.${name}`);
        }
      }
    }
    expect(unclassified).toEqual([]);
  });

  it("classifies cleared fields only when restore writes NULL to nullable schema columns", () => {
    for (const [table, columns] of Object.entries(RESTORE_CLEARED_COLUMNS)) {
      expect(restored.has(table)).toBe(true);
      const source: Record<string, unknown> = {
        id: randomUUID(),
        ...Object.fromEntries(columns.map((column) => [column, randomUUID()])),
      };
      const result = backupTables(
        prepareSharedRestore(backup({ [table]: [source] }), randomUUID()),
      )[table]![0];
      const definition = new RegExp(
        `CREATE TABLE(?: IF NOT EXISTS)?\\s+${table}\\s*\\(([\\s\\S]*?)\\n\\);`,
      ).exec(schema)![1];
      for (const column of columns) {
        expect(
          parseTableColumns(schema, table)?.some(
            (field) => field.name === column,
          ),
        ).toBe(true);
        const line = new RegExp(`^\\s*${column}\\s+[^\\n]*$`, "m").exec(
          definition,
        )![0];
        expect(line).not.toMatch(/NOT NULL/);
        expect(result[column]).toBeNull();
        expect(source[column]).not.toBeNull();
      }
    }
  });

  it("forces only schema-backed user references through the principal policy", () => {
    for (const [table, columns] of Object.entries(RESTORE_PRINCIPAL_COLUMNS)) {
      expect(restored.has(table)).toBe(true);
      for (const [column, policy] of Object.entries(columns)) {
        expect(
          foreignKeys.some(
            (fk) =>
              fk.table === table &&
              fk.column === column &&
              fk.referencedTable === "users",
          ),
        ).toBe(true);
        expect(["owner", "anonymous"]).toContain(policy);
      }
    }
  });

  it("knows which restored tables have a non-UUID id", () => {
    const nonUuid = [...restored].filter((table) => {
      const id = parseTableColumns(schema, table)?.find(
        (column) => column.name === "id",
      );
      return id !== undefined && id.type !== "UUID";
    });
    expect([...NON_UUID_ID_TABLES].sort()).toEqual(nonUuid.sort());
  });

  it("covers every deferred foreign key", () => {
    const uncovered = Object.entries(DEFERRED_FK_COLUMNS).flatMap(
      ([table, columns]) =>
        columns.filter(
          (column) => RESTORE_REFERENCE_COLUMNS[table]?.[column] === undefined,
        ),
    );
    expect(uncovered).toEqual([]);
  });

  it("severs only declared, nullable reference columns, each with a reason", () => {
    for (const [key, reason] of SEVERED_WHEN_UNRESOLVED) {
      const [table, column] = key.split(".");
      expect(RESTORE_REFERENCE_COLUMNS[table]?.[column]).toBeDefined();
      const definition = new RegExp(
        `CREATE TABLE(?: IF NOT EXISTS)?\\s+${table}\\s*\\(([\\s\\S]*?)\\n\\);`,
      ).exec(schema)![1];
      const line = new RegExp(`^\\s*${column}\\s+[^\\n]*$`, "m").exec(
        definition,
      )![0];
      expect(line).not.toMatch(/NOT NULL/);
      expect(reason.trim().length).toBeGreaterThan(40);
    }
  });
});

describe("resolveRestoreReferences", () => {
  it("passes a genuine export through unchanged in substance", () => {
    const data = genuineBackup();
    const { data: resolved, severed } = resolveRestoreReferences(data);
    expect(severed).toEqual([]);
    expect(resolved).toEqual(data);
  });

  it("does not modify the document it was handed", () => {
    const data = backup({
      accounts: [{ id: ACCOUNT.toUpperCase(), user_id: "u" }],
    });
    const before = JSON.stringify(data);
    resolveRestoreReferences(data);
    expect(JSON.stringify(data)).toBe(before);
  });

  it("canonicalises a catalog reference and leaves its existence to the restore", () => {
    const INSTRUMENT = "9f2c7a10-1234-5a6b-8c7d-0e1f2a3b4c5d";
    const data = backup({
      securities: [
        { id: SECURITY, user_id: "u", bond_program_id: INSTRUMENT },
        {
          id: SECURITY.replace(/3/g, "4"),
          user_id: "u",
          bond_program_id: INSTRUMENT.toUpperCase(),
        },
      ],
    });
    const { data: resolved, severed } = resolveRestoreReferences(data);
    expect(severed).toEqual([]);
    expect(
      (resolved.securities as Record<string, unknown>[]).map(
        (r) => r.bond_program_id,
      ),
    ).toEqual([INSTRUMENT, INSTRUMENT]);
  });

  it("refuses a catalog reference that is not a UUID", () => {
    const data = backup({
      securities: [
        { id: SECURITY, user_id: "u", bond_program_id: "not-a-uuid" },
      ],
    });
    expect(refusal(() => resolveRestoreReferences(data))).toContain(
      "securities.bond_program_id",
    );
  });

  it("refuses a transaction on another user's account", () => {
    const data = genuineBackup();
    (data.transactions[0] as Record<string, unknown>).account_id =
      VICTIM_ACCOUNT;
    const message = refusal(() => resolveRestoreReferences(data));
    expect(message).toContain("transactions.account_id");
    expect(message).toContain(VICTIM_ACCOUNT);
  });

  it("refuses an override on another user's schedule", () => {
    const data = genuineBackup();
    (
      data.scheduled_transaction_overrides[0] as Record<string, unknown>
    ).scheduled_transaction_id = VICTIM_SCHEDULE;
    expect(refusal(() => resolveRestoreReferences(data))).toContain(
      "scheduled_transaction_overrides.scheduled_transaction_id",
    );
  });

  it("refuses a price or a holding on another user's security", () => {
    const prices = genuineBackup();
    (prices.security_prices[0] as Record<string, unknown>).security_id =
      VICTIM_SECURITY;
    expect(refusal(() => resolveRestoreReferences(prices))).toContain(
      "security_prices.security_id",
    );

    const holdings = genuineBackup();
    (holdings.holdings[0] as Record<string, unknown>).security_id =
      VICTIM_SECURITY;
    expect(refusal(() => resolveRestoreReferences(holdings))).toContain(
      "holdings.security_id",
    );
  });

  it("refuses a reference to a row of the wrong table", () => {
    // SECURITY is in the file, but not as an account.
    const data = genuineBackup();
    (data.holdings[0] as Record<string, unknown>).account_id = SECURITY;
    expect(refusal(() => resolveRestoreReferences(data))).toContain(
      "holdings.account_id",
    );
  });

  it("refuses a victim id spelled without hyphens", () => {
    // PostgreSQL reads this as VICTIM_ACCOUNT. The remap's regex did not, so
    // the reference passed through unremapped.
    const data = genuineBackup();
    (data.holdings[0] as Record<string, unknown>).account_id =
      VICTIM_ACCOUNT.replace(/-/g, "");
    expect(refusal(() => resolveRestoreReferences(data))).toContain(
      VICTIM_ACCOUNT,
    );
  });

  it("canonicalises a primary key in any spelling, so the remap sees it", () => {
    // A victim's key in upper case without hyphens used to escape the remap,
    // conflict on insert, and be rewritten in place by the Phase-3 UPDATE.
    const spelled = VICTIM_ACCOUNT.replace(/-/g, "").toUpperCase();
    const data = backup({
      accounts: [
        { id: `{${spelled}}`, user_id: "u", linked_account_id: spelled },
      ],
    });
    const { data: resolved } = resolveRestoreReferences(data);
    expect(resolved.accounts[0]).toMatchObject({
      id: VICTIM_ACCOUNT,
      linked_account_id: VICTIM_ACCOUNT,
    });

    const remap = new Map<string, string>();
    collectRowIdRemap(resolved.accounts, remap, randomUUID);
    const remapped = remapRestoreRow(
      resolved.accounts[0],
      remap,
      new Map(),
      randomUUID,
    ) as Record<string, unknown>;
    expect(remapped.id).not.toBe(VICTIM_ACCOUNT);
    expect(remapped.linked_account_id).toBe(remapped.id);
  });

  it("refuses a primary key that is not a UUID", () => {
    const data = backup({ accounts: [{ id: "acc-1", user_id: "u" }] });
    expect(refusal(() => resolveRestoreReferences(data))).toContain(
      "accounts.id",
    );
  });

  it("refuses a reference that is not a UUID", () => {
    const data = genuineBackup();
    (data.holdings[0] as Record<string, unknown>).account_id = 42;
    expect(refusal(() => resolveRestoreReferences(data))).toContain(
      "holdings.account_id",
    );
  });

  it("leaves a sequence-backed id alone", () => {
    const { data } = resolveRestoreReferences(genuineBackup());
    expect(data.security_prices[0]).toMatchObject({ id: "5" });
  });

  it("refuses when the referenced table is absent from the file", () => {
    const data = backup({
      transactions: [{ id: TXN, user_id: "u", account_id: ACCOUNT }],
    });
    expect(refusal(() => resolveRestoreReferences(data))).toContain(
      "transactions.account_id",
    );
  });

  it("severs a cross-owner transfer's counterpart instead of following it", () => {
    const data = genuineBackup();
    (data.transactions[0] as Record<string, unknown>).linked_transaction_id =
      VICTIM_TXN;
    const { data: resolved, severed } = resolveRestoreReferences(data);
    expect(resolved.transactions[0]).toMatchObject({
      id: TXN,
      linked_transaction_id: null,
    });
    expect(resolved.transactions[1]).toMatchObject({
      linked_transaction_id: TXN,
    });
    expect(severed).toEqual([
      { table: "transactions", column: "linked_transaction_id", rows: 1 },
    ]);
  });

  it("severs an institution a legacy backup did not carry", () => {
    const data = genuineBackup();
    const legacy = backup({
      ...(data as unknown as Record<string, unknown[]>),
      institutions: [],
    });
    const { data: resolved, severed } = resolveRestoreReferences(legacy);
    expect(resolved.accounts[0]).toMatchObject({ institution_id: null });
    expect(severed).toEqual([
      { table: "accounts", column: "institution_id", rows: 1 },
    ]);
  });
});

describe("remapRestoreRow", () => {
  it("remaps nested ids of the file in any spelling and neutralises the rest", () => {
    const remap = new Map([[ACCOUNT, "new-account"]]);
    const unresolved = new Map<string, string>();
    let n = 0;
    const fresh = () => `fresh-${++n}`;
    const row = {
      id: SCHEDULE,
      memo: VICTIM_ACCOUNT,
      splits: [
        { transferAccountId: ACCOUNT.toUpperCase() },
        { transferAccountId: VICTIM_ACCOUNT.replace(/-/g, "") },
        { transferAccountId: VICTIM_ACCOUNT },
        { note: "not an id", amount: 5 },
      ],
      account_ids: [VICTIM_ACCOUNT],
    };

    const remapped = remapRestoreRow(row, remap, unresolved, fresh) as Record<
      string,
      unknown
    >;

    expect(remapped.splits).toEqual([
      { transferAccountId: "new-account" },
      { transferAccountId: "fresh-1" },
      { transferAccountId: "fresh-1" },
      { note: "not an id", amount: 5 },
    ]);
    // One replacement per id across the whole document.
    expect(remapped.account_ids).toEqual(["fresh-1"]);
    // A top-level text column is not a reference and is left as written.
    expect(remapped.memo).toBe(VICTIM_ACCOUNT);
    // Not in the remap: the top-level id is left for the caller's remap.
    expect(remapped.id).toBe(SCHEDULE);
    // The input row is not modified.
    expect(row.splits[0]).toEqual({ transferAccountId: ACCOUNT.toUpperCase() });
  });
});
