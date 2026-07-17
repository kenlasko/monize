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
import { User } from "@/users/entities/user.entity";
import { OidcService } from "@/auth/oidc/oidc.service";
import { AiEncryptionService } from "@/ai/ai-encryption.service";
import { createTestUserDirect } from "../helpers/integration-setup";

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
        TypeOrmModule.forRoot({
          type: "postgres",
          host: process.env.DATABASE_HOST || "localhost",
          port: parseInt(process.env.DATABASE_PORT || "5432"),
          username: process.env.DATABASE_USER || "monize_user",
          password: process.env.DATABASE_PASSWORD || "monize_password",
          database: process.env.DATABASE_NAME || "monize_test",
          entities: [__dirname + "/../../src/**/*.entity{.ts,.js}"],
          synchronize: true,
          dropSchema: true,
        }),
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

      const unclassified = schemaColumns.filter(
        (c) => !ruleColumns.includes(c),
      );
      const stale = ruleColumns.filter((c) => !schemaColumns.includes(c));

      expect({ table, unclassified }).toEqual({ table, unclassified: [] });
      expect({ table, stale }).toEqual({ table, stale: [] });
    }
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
});
