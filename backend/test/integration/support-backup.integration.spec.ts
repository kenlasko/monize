import { Test, TestingModule } from "@nestjs/testing";
import { TypeOrmModule } from "@nestjs/typeorm";
import { ConfigModule } from "@nestjs/config";
import { DataSource } from "typeorm";
import { randomUUID } from "crypto";
import { BondPriceService } from "@/bonds/bond-price.service";
import { BackupService } from "@/backup/backup.service";
import { BackupExportService } from "@/backup/backup-export.service";
import { BackupRestoreService } from "@/backup/backup-restore.service";
import { BackupAttachmentTransferService } from "@/backup/backup-attachment-transfer.service";
import { BackupRestoreDatabaseService } from "@/backup/backup-restore-database.service";
import { BackupBondSeriesRecoveryService } from "@/backup/backup-bond-series-recovery.service";
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
import { OidcReauthService } from "@/auth/oidc/oidc-reauth.service";
import { EncryptionService } from "../../src/common/encryption/encryption.service";
import { JobClaimService } from "@/common/jobs/job-claim.service";
import { UserMaintenanceService } from "@/common/jobs/user-maintenance.service";
import {
  attachmentStorageProviders,
  createTestUserDirect,
  INTEGRATION_TYPEORM_OPTIONS,
} from "../helpers/integration-setup";
import { withUserContext } from "@/common/db/with-context";
import { withScopedDb } from "@/common/db/scoped-db";
import { applyRlsPolicies } from "../helpers/rls-setup";

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
        // The four components issue #1092 split BackupService into. Real, like
        // everything else here: the point of an integration suite is that the
        // wiring is the thing under test.
        BackupExportService,
        BackupRestoreService,
        // The restore's bond price recompute is not under test here.
        {
          provide: BondPriceService,
          useValue: {
            recomputeSecurity: async () => ({}),
            recomputeLinkedSecurities: async () => undefined,
          },
        },
        // The restore's bond series recovery finds nothing to recover here.
        {
          provide: BackupBondSeriesRecoveryService,
          useValue: {
            recover: async (_userId: string, data: unknown) => ({
              data,
              unrecovered: [],
            }),
          },
        },
        BackupAttachmentTransferService,
        BackupRestoreDatabaseService,
        // Real, not doubles: the restore takes a maintenance lease against the
        // real `job_claims` table, so a broken lease shows up here rather than
        // only in production.
        JobClaimService,
        UserMaintenanceService,
        SupportBackupService,
        // Real, for the reason the sibling suite gives: a mocked step-up would
        // keep this suite green through the removal of the check it gates.
        OidcReauthService,
        { provide: EncryptionService, useValue: { decrypt: () => "" } },
        // The real database-backed provider: BackupService's constructor
        // requires the token to be resolvable regardless of whether a given
        // test seeds an attachment, and this needs no extra config.
        ...attachmentStorageProviders(),
      ],
    }).compile();

    backupService = module.get(BackupService);
    supportService = module.get(SupportBackupService);
    dataSource = module.get(DataSource);
    // Shared journal tables and attachment constraints are SQL-owned, just as
    // the restore suite's runtime functions are; entity sync cannot build them.
    await applyRlsPolicies(dataSource);
  });

  afterAll(async () => {
    await module?.close();
  });

  it("classifies every exported column (golden allowlist)", async () => {
    const exported = backupService.getBackedUpTableNames();
    // A real shared export adds its participant claim to the physical columns.
    // Seed a group so the guard observes the exporter, not an exception list.
    const owner = await createTestUserDirect(dataSource);
    const groupId = randomUUID();
    const participantId = randomUUID();
    await withUserContext(owner.id, () =>
      withScopedDb(dataSource, async (m) => {
        await m.query(
          `INSERT INTO currencies (code, name, symbol) VALUES ($1, $2, $3)
           ON CONFLICT (code) DO NOTHING`,
          ["USD", "US Dollar", "$"],
        );
        await m.query(
          `INSERT INTO shared_groups (id, owner_user_id, name, currency_code)
           VALUES ($1, $2, $3, $4)`,
          [groupId, owner.id, "Export fixture", "USD"],
        );
        await m.query(
          `INSERT INTO shared_participants (id, group_id, name) VALUES ($1, $2, $3)`,
          [participantId, groupId, "Export participant"],
        );
        await m.query(
          `INSERT INTO shared_memberships (id, group_id, participant_id, user_id, role)
           VALUES ($1, $2, $3, $4, 'OWNER')`,
          [randomUUID(), groupId, participantId, owner.id],
        );
      }),
    );
    const raw = await withUserContext(owner.id, () =>
      backupService.collectRawExport(owner.id, {
        skipTables: ALWAYS_EXCLUDED_TABLES,
      }),
    );
    expect(raw.tables.shared_groups).toEqual([
      expect.objectContaining({
        id: groupId,
        _snapshot_participant_id: participantId,
      }),
    ]);
    // Collected across every table and asserted once at the end, rather than
    // expect()-ing inside the loop. A throw on the first offender hides the
    // rest, and one migration usually adds columns to several tables -- so a
    // per-table assertion turns one fix into one red CI run per table.
    const unclassifiedByTable: Record<string, string[]> = {};
    const staleByTable: Record<string, string[]> = {};

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
      const schemaColumns = [
        ...new Set([
          ...rows.map((r) => r.column_name),
          ...(raw.tables[table] ?? []).flatMap((row) => Object.keys(row)),
        ]),
      ].sort();
      const ruleColumns = Object.keys(RULES[table] ?? {}).sort();

      const unclassified = schemaColumns.filter(
        (c) => !ruleColumns.includes(c),
      );
      const stale = ruleColumns.filter((c) => !schemaColumns.includes(c));

      if (unclassified.length > 0) unclassifiedByTable[table] = unclassified;
      if (stale.length > 0) staleByTable[table] = stale;
    }

    expect({
      unclassified: unclassifiedByTable,
      stale: staleByTable,
    }).toEqual({ unclassified: {}, stale: {} });
  });

  it("covers every foreign key between exported tables (REFS allowlist)", async () => {
    const exported = new Set(backupService.getBackedUpTableNames());
    // FKs to these targets are intentionally outside the scrub: users is never
    // exported (restore rescopes user_id) and currencies are restored by code,
    // keyed by code rather than id.
    const IGNORED_REF_TABLES = new Set(["users", "currencies"]);

    const fks: Array<{
      table: string;
      columns: string[];
      refTable: string;
      refColumns: string[];
    }> = await dataSource.query(
      `SELECT src.relname AS table, dst.relname AS "refTable",
              array_agg(local_col.attname::text ORDER BY pair.position) AS columns,
              array_agg(target_col.attname::text ORDER BY pair.position) AS "refColumns"
       FROM pg_constraint fk
       JOIN pg_class src ON src.oid = fk.conrelid
       JOIN pg_class dst ON dst.oid = fk.confrelid
       JOIN pg_namespace ns ON ns.oid = src.relnamespace
       CROSS JOIN LATERAL unnest(fk.conkey, fk.confkey) WITH ORDINALITY
         AS pair(local_number, target_number, position)
       JOIN pg_attribute local_col ON local_col.attrelid = src.oid
         AND local_col.attnum = pair.local_number
       JOIN pg_attribute target_col ON target_col.attrelid = dst.oid
         AND target_col.attnum = pair.target_number
       WHERE fk.contype = 'f' AND ns.nspname = 'public'
       GROUP BY fk.oid, src.relname, dst.relname`,
    );

    const key = (
      table: string,
      columns: string[],
      refTable: string,
      refColumns: string[],
    ) =>
      `${table}.(${columns
        .map((column, i) => `${column}->${refColumns[i]}`)
        .sort()
        .join(",")})->${refTable}`;
    const ruleKey = (
      table: string,
      rule: { column: string; refTable: string; scope?: readonly string[] },
    ) =>
      key(table, [rule.column, ...(rule.scope ?? [])], rule.refTable, [
        "id",
        ...(rule.scope ?? []),
      ]);
    const realFkKeys = new Set(
      fks.map((fk) => key(fk.table, fk.columns, fk.refTable, fk.refColumns)),
    );
    const scalarFkKeys = new Set(
      fks
        .filter((fk) => fk.columns.length === 1 && fk.refColumns[0] === "id")
        .map((fk) => `${fk.table}.${fk.columns[0]}->${fk.refTable}`),
    );
    const uncoveredFks = fks
      .filter(
        (fk) =>
          exported.has(fk.table) &&
          exported.has(fk.refTable) &&
          !IGNORED_REF_TABLES.has(fk.refTable),
      )
      .filter(
        (fk) =>
          !(REFS_FOR_TEST.get(fk.table) ?? []).some(
            (rule) =>
              ruleKey(fk.table, rule) ===
              key(fk.table, fk.columns, fk.refTable, fk.refColumns),
          ),
      )
      .map((fk) => key(fk.table, fk.columns, fk.refTable, fk.refColumns));

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
    const staleRefs: string[] = [];
    for (const [table, rules] of REFS_FOR_TEST) {
      for (const r of rules) {
        const key = `${table}.${r.column}->${r.refTable}`;
        if (
          !realFkKeys.has(ruleKey(table, r)) &&
          !(!r.scope?.length && SCHEMA_ONLY_FKS.has(key))
        ) {
          staleRefs.push(`${table}.${r.column} -> ${r.refTable}`);
        }
      }
    }
    // Keep the exception list honest: if an entity gains the relation back, the
    // constraint appears in the test DB and the exception becomes obsolete.
    const obsoleteExceptions = [...SCHEMA_ONLY_FKS].filter((key) =>
      scalarFkKeys.has(key),
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

    const { buffer } = await withUserContext(userA.id, () =>
      supportService.generate(userA.id, {
        multiplier: 2.5,
        password: PASSWORD,
      }),
    );

    const result = await withUserContext(userB.id, () =>
      backupService.restoreData(userB.id, {
        compressedData: buffer,
        password: PASSWORD,
      }),
    );
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

    const { buffer } = await withUserContext(userA.id, () =>
      supportService.generate(userA.id, {
        multiplier: 2.5,
        password: PASSWORD,
      }),
    );
    const result = await withUserContext(userB.id, () =>
      backupService.restoreData(userB.id, {
        compressedData: buffer,
        password: PASSWORD,
      }),
    );

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
