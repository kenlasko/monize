import { Test, TestingModule } from "@nestjs/testing";
import { TypeOrmModule } from "@nestjs/typeorm";
import { ConfigModule } from "@nestjs/config";
import { DataSource } from "typeorm";
import { randomUUID } from "crypto";
import { BackupService } from "@/backup/backup.service";
import { SupportBackupService } from "@/backup/support-backup/support-backup.service";
import {
  ALWAYS_EXCLUDED_TABLES,
  RULES,
} from "@/backup/support-backup/support-backup-rules";
import {
  REFS_FOR_TEST,
  UNIQUE_MASKED_TEXT_FOR_TEST,
} from "@/backup/support-backup/support-backup-integrity";
import { User } from "@/users/entities/user.entity";
import { OidcService } from "@/auth/oidc/oidc.service";
import { AiEncryptionService } from "@/ai/ai-encryption.service";
import {
  createTestUserDirect,
  INTEGRATION_TYPEORM_OPTIONS,
} from "../helpers/integration-setup";

/**
 * Support (de-identified) backup against a real database. Covers the two
 * safety-critical properties mocks cannot: the golden allowlist (every exported
 * column is classified, so a migration can't silently start leaking a field)
 * and a full generate -> restore round-trip proving the trimmed, scaled, masked
 * file still imports cleanly.
 */
describe("Support backup (integration)", () => {
  let module: TestingModule;
  let backupService: BackupService;
  let supportService: SupportBackupService;
  let dataSource: DataSource;
  const PASSWORD = "TestPassword123!";

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        TypeOrmModule.forRoot(INTEGRATION_TYPEORM_OPTIONS),
        TypeOrmModule.forFeature([User]),
      ],
      providers: [
        BackupService,
        SupportBackupService,
        { provide: OidcService, useValue: { enabled: false } },
        { provide: AiEncryptionService, useValue: { decrypt: () => "" } },
      ],
    }).compile();

    backupService = module.get(BackupService);
    supportService = module.get(SupportBackupService);
    dataSource = module.get(DataSource);
  });

  afterAll(async () => {
    await module?.close();
  });

  // Columns that exist in the production schema (database/schema.sql) but not
  // in the TypeORM entities. This suite's database is synchronized from the
  // entities, so these legacy columns are absent HERE -- yet a real export
  // (SELECT * against a schema.sql-provisioned database) still carries them,
  // so the rules registry must keep classifying them.
  const LEGACY_SCHEMA_ONLY_COLUMNS: Record<string, string[]> = {
    transactions: ["is_cleared", "is_reconciled"],
  };

  it("classifies every exported column (golden allowlist)", async () => {
    const exported = backupService.getBackedUpTableNames();
    for (const table of exported) {
      if (ALWAYS_EXCLUDED_TABLES.has(table)) {
        expect(RULES[table]).toBeUndefined();
        continue;
      }
      const rows: Array<{ column_name: string }> = await dataSource.query(
        `SELECT column_name FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = $1`,
        [table],
      );
      const schemaColumns = rows.map((r) => r.column_name).sort();
      const ruleColumns = Object.keys(RULES[table] ?? {}).sort();
      const legacyOnly = LEGACY_SCHEMA_ONLY_COLUMNS[table] ?? [];

      const unclassified = schemaColumns.filter(
        (c) => !ruleColumns.includes(c),
      );
      const stale = ruleColumns.filter(
        (c) => !schemaColumns.includes(c) && !legacyOnly.includes(c),
      );
      // Keep the exception list honest: if an entity gains one of these
      // columns back, the entry must be removed.
      const obsoleteExceptions = legacyOnly.filter((c) =>
        schemaColumns.includes(c),
      );

      expect({ table, unclassified }).toEqual({ table, unclassified: [] });
      expect({ table, stale }).toEqual({ table, stale: [] });
      expect({ table, obsoleteExceptions }).toEqual({
        table,
        obsoleteExceptions: [],
      });
    }
  });

  it("covers every foreign key between exported tables (REFS allowlist)", async () => {
    const exported = new Set(backupService.getBackedUpTableNames());
    // FKs to these targets are intentionally outside the scrub: users is never
    // exported (restore rescopes user_id) and currencies are restored by code,
    // keyed by code rather than id.
    const IGNORED_REF_TABLES = new Set(["users", "currencies"]);

    const fks: Array<{
      table: string;
      column: string;
      refTable: string;
    }> = await dataSource.query(
      `SELECT tc.table_name AS table, kcu.column_name AS column,
              ccu.table_name AS "refTable"
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON tc.constraint_name = kcu.constraint_name
        AND tc.table_schema = kcu.table_schema
       JOIN information_schema.constraint_column_usage ccu
         ON tc.constraint_name = ccu.constraint_name
        AND tc.table_schema = ccu.table_schema
       WHERE tc.constraint_type = 'FOREIGN KEY'
         AND tc.table_schema = 'public'`,
    );

    const covered = (table: string, column: string): boolean =>
      (REFS_FOR_TEST.get(table) ?? []).some((r) => r.column === column);

    const uncoveredFks = fks
      .filter(
        (fk) =>
          exported.has(fk.table) &&
          exported.has(fk.refTable) &&
          !IGNORED_REF_TABLES.has(fk.refTable),
      )
      .filter((fk) => !covered(fk.table, fk.column))
      .map((fk) => `${fk.table}.${fk.column} -> ${fk.refTable}`);

    // FKs declared in database/schema.sql (production truth) that the TypeORM
    // entities do NOT model as relations, so `synchronize` never creates the
    // constraint in this entity-derived test DB -- yet they exist in prod, and
    // a real export carries these columns, so REFS must keep covering them.
    // (Both are self-referential columns stored as plain UUIDs on the entity.)
    const SCHEMA_ONLY_FKS = new Set([
      "transactions.parent_transaction_id->transactions",
      "investment_transactions.linked_transaction_id->investment_transactions",
    ]);

    // Reverse guard: a REFS entry that matches neither a real FK nor a known
    // schema-only FK is stale.
    const realFkKeys = new Set(
      fks.map((fk) => `${fk.table}.${fk.column}->${fk.refTable}`),
    );
    const staleRefs: string[] = [];
    for (const [table, rules] of REFS_FOR_TEST) {
      for (const r of rules) {
        const key = `${table}.${r.column}->${r.refTable}`;
        if (!realFkKeys.has(key) && !SCHEMA_ONLY_FKS.has(key)) {
          staleRefs.push(`${table}.${r.column} -> ${r.refTable}`);
        }
      }
    }
    // Keep the exception list honest: if an entity gains the relation back, the
    // constraint appears in the test DB and the exception becomes obsolete.
    const obsoleteExceptions = [...SCHEMA_ONLY_FKS].filter((key) =>
      realFkKeys.has(key),
    );

    expect({ uncoveredFks }).toEqual({ uncoveredFks: [] });
    expect({ staleRefs }).toEqual({ staleRefs: [] });
    expect({ obsoleteExceptions }).toEqual({ obsoleteExceptions: [] });
  });

  it("generates a de-identified backup that restores into another user", async () => {
    const userA = await createTestUserDirect(dataSource);
    const userB = await createTestUserDirect(dataSource);

    const accountId = randomUUID();
    const payeeId = randomUUID();
    const categoryId = randomUUID();
    const txId = randomUUID();

    await dataSource.query(
      `INSERT INTO categories (id, user_id, name, description)
       VALUES ($1, $2, 'Groceries', 'food shopping')`,
      [categoryId, userA.id],
    );
    await dataSource.query(
      `INSERT INTO payees (id, user_id, name, notes)
       VALUES ($1, $2, 'Biedronka', 'local grocery')`,
      [payeeId, userA.id],
    );
    await dataSource.query(
      `INSERT INTO accounts (id, user_id, account_type, name, description, account_number, currency_code, opening_balance, current_balance)
       VALUES ($1, $2, 'CHEQUING', 'Everyday Chequing', 'my main account', 'PL60102010260000042270201111', 'USD', 100, 200)`,
      [accountId, userA.id],
    );
    await dataSource.query(
      `INSERT INTO transactions (id, user_id, account_id, transaction_date, payee_id, payee_name, category_id, amount, currency_code, description, reference_number)
       VALUES ($1, $2, $3, '2026-01-01', $4, 'Biedronka', $5, 100, 'USD', 'ODSETKI: 388,14', 'REF-000123')`,
      [txId, userA.id, accountId, payeeId, categoryId],
    );

    const { buffer } = await supportService.generate(userA.id, {
      multiplier: 2.5,
    });

    const result = await backupService.restoreData(userB.id, {
      compressedData: buffer,
      password: PASSWORD,
    });
    expect(result.restored.accounts).toBe(1);

    const [account] = await dataSource.query(
      `SELECT name, description, account_number, opening_balance, current_balance
       FROM accounts WHERE user_id = $1`,
      [userB.id],
    );
    expect(account.name).toBe("Ev*************ng");
    expect(account.description).toBeNull();
    expect(account.account_number).toBeNull();
    expect(Number(account.opening_balance)).toBe(250);
    // balance recomputed from scaled opening (250) + scaled tx (250)
    expect(Number(account.current_balance)).toBe(500);

    const [tx] = await dataSource.query(
      `SELECT payee_name, amount, description, reference_number
       FROM transactions WHERE user_id = $1`,
      [userB.id],
    );
    expect(tx.payee_name).toBe("Bi*****ka");
    expect(Number(tx.amount)).toBe(250);
    expect(tx.description).toBeNull();
    expect(tx.reference_number).toBeNull();

    const [payee] = await dataSource.query(
      `SELECT name, notes FROM payees WHERE user_id = $1`,
      [userB.id],
    );
    expect(payee.name).toBe("Bi*****ka");
    expect(payee.notes).toBeNull();
  });

  it("keeps colliding masked names distinct so every row still restores", async () => {
    const userA = await createTestUserDirect(dataSource);
    const userB = await createTestUserDirect(dataSource);

    // Two payees whose masked names collide ("Visa"/"Amex" -> "****", four
    // characters or fewer are fully masked), each with an alias. Before the
    // dedup fix the second payee was dropped by ON CONFLICT DO NOTHING on
    // UNIQUE(user_id, name) and its NOT NULL alias then failed the FK.
    const visaId = randomUUID();
    const amexId = randomUUID();
    await dataSource.query(
      `INSERT INTO payees (id, user_id, name) VALUES ($1, $2, 'Visa'), ($3, $2, 'Amex')`,
      [visaId, userA.id, amexId],
    );
    await dataSource.query(
      `INSERT INTO payee_aliases (id, payee_id, user_id, alias)
       VALUES ($1, $2, $3, 'VisaAlias'), ($4, $5, $3, 'AmexAlias')`,
      [randomUUID(), visaId, userA.id, randomUUID(), amexId],
    );

    const { buffer } = await supportService.generate(userA.id, {
      multiplier: 2.5,
    });
    const result = await backupService.restoreData(userB.id, {
      compressedData: buffer,
      password: PASSWORD,
    });

    // Both payees and both aliases survive the round trip.
    expect(result.restored.payees).toBe(2);
    expect(result.restored.payeeAliases).toBe(2);
    const [{ count: payeeCount }] = await dataSource.query(
      `SELECT COUNT(*)::int AS count FROM payees WHERE user_id = $1`,
      [userB.id],
    );
    expect(payeeCount).toBe(2);
    const names: Array<{ name: string }> = await dataSource.query(
      `SELECT name FROM payees WHERE user_id = $1`,
      [userB.id],
    );
    expect(new Set(names.map((r) => r.name)).size).toBe(2);
  });

  it("dedupes every masked text column carried by a UNIQUE index", async () => {
    const exported = new Set(backupService.getBackedUpTableNames());
    const indexes: Array<{ table: string; def: string }> =
      await dataSource.query(
        `SELECT t.relname AS table, pg_get_indexdef(x.indexrelid) AS def
         FROM pg_index x
         JOIN pg_class i ON i.oid = x.indexrelid
         JOIN pg_class t ON t.oid = x.indrelid
         JOIN pg_namespace n ON n.oid = t.relnamespace
         WHERE x.indisunique AND n.nspname = 'public'`,
      );

    const covered = (table: string, column: string): boolean =>
      (UNIQUE_MASKED_TEXT_FOR_TEST.get(table) ?? []).some(
        (k) => k.column === column,
      );

    // Any masked column that participates in a unique index (plain or a
    // LOWER()-style expression index) will be hit by ON CONFLICT DO NOTHING on
    // restore, so the dedup map must cover it.
    const uncovered: string[] = [];
    for (const { table, def } of indexes) {
      if (!exported.has(table)) continue;
      const rules = RULES[table] ?? {};
      const spanned = def.slice(def.indexOf("(") + 1, def.lastIndexOf(")"));
      for (const [column, rule] of Object.entries(rules)) {
        if (rule.t !== "mask") continue;
        const inIndex = new RegExp(`\\b${column}\\b`).test(spanned);
        if (inIndex && !covered(table, column)) {
          uncovered.push(`${table}.${column}`);
        }
      }
    }

    // Reverse guard: every declared entry must still name a masked column.
    const stale: string[] = [];
    for (const [table, keys] of UNIQUE_MASKED_TEXT_FOR_TEST) {
      for (const { column } of keys) {
        if (RULES[table]?.[column]?.t !== "mask") {
          stale.push(`${table}.${column}`);
        }
      }
    }

    expect({ uncovered }).toEqual({ uncovered: [] });
    expect({ stale }).toEqual({ stale: [] });
  });
});
