import { generateKeyPairSync } from "node:crypto";
import { BadRequestException } from "@nestjs/common";
import { TestingModule } from "@nestjs/testing";
import { DataSource, EntityManager } from "typeorm";

import { AccountsService } from "@/accounts/accounts.service";
import { withScopedDb } from "@/common/db/scoped-db";
import { withUserContext } from "@/common/db/with-context";
import { addDaysYMD, todayYMD } from "@/common/date-utils";
import { JobClaimService } from "@/common/jobs/job-claim.service";
import { BankSyncConnectionsService } from "@/bank-sync/bank-sync-connections.service";
import { BankSyncCredentialsService } from "@/bank-sync/bank-sync-credentials.service";
import { BankSyncModule } from "@/bank-sync/bank-sync.module";
import { BankSyncService } from "@/bank-sync/bank-sync.service";
import { resolveProfile } from "@/bank-sync/bank-sync-profiles";
import { BankSyncWriterService } from "@/bank-sync/bank-sync-writer.service";
import { planBankImport } from "@/bank-sync/bank-transaction-planner";
import { BankSyncProviderError } from "@/bank-sync/providers/bank-sync-provider.errors";
import type {
  BankTransaction,
  PsuContext,
} from "@/bank-sync/providers/bank-sync-provider.interface";
import { EnableBankingProvider } from "@/bank-sync/providers/enable-banking/enable-banking.client";
import { CreateTransactionRuleDto } from "@/transaction-rules/dto/create-transaction-rule.dto";
import { TransactionRulesService } from "@/transaction-rules/transaction-rules.service";

import {
  cleanTables,
  createEnforcedIntegrationModule,
  createTestUserDirect,
  EnforcedIntegrationHarness,
} from "../helpers/integration-setup";
import {
  createTestAccount,
  createTestCategory,
} from "../helpers/test-factories";

/**
 * Bank sync against a real PostgreSQL enforcing RLS, with the provider stubbed
 * (no network): INV-BANKSYNC-001 (a bank transaction is imported at most once),
 * INV-BANKSYNC-002 (the key never leaves the server), INV-BANKSYNC-003 (a row is
 * written in the account's currency or not at all) and INV-BALANCE-001 (the
 * balance moves by exactly what was written).
 *
 * The provider is the one real `EnableBankingProvider` instance with its methods
 * replaced, so the registry, the services and the writer are all the real ones.
 */
describe("Bank sync (integration)", () => {
  jest.setTimeout(180000);

  let harness: EnforcedIntegrationHarness;
  let module: TestingModule;
  let db: DataSource;
  let app: DataSource;
  let bankSync: BankSyncService;
  let writer: BankSyncWriterService;
  let connections: BankSyncConnectionsService;
  let credentials: BankSyncCredentialsService;
  let rules: TransactionRulesService;
  let provider: EnableBankingProvider;

  let aliceId: string;
  let bobId: string;
  let accountId: string;
  let connectionId: string;
  let bankAccountId: string;

  const OPENING = 1000;
  const PEM = generateKeyPairSync("rsa", { modulusLength: 2048 })
    .privateKey.export({ type: "pkcs8", format: "pem" })
    .toString();
  const today = todayYMD();
  const daysAgo = (days: number) => addDaysYMD(today, -days);

  const asAlice = <T>(fn: () => Promise<T>) => withUserContext(aliceId, fn);
  const asBob = <T>(fn: () => Promise<T>) => withUserContext(bobId, fn);

  const row = (over: Partial<BankTransaction> = {}): BankTransaction => ({
    entryReference: "ref-1",
    transactionId: null,
    bankReference: null,
    amount: "50.00",
    currencyCode: "PLN",
    direction: "debit",
    booked: true,
    bookingDate: daysAgo(3),
    valueDate: null,
    transactionDate: null,
    counterpartyName: "Biedronka",
    remittance: ["Groceries"],
    operation: {
      code: null,
      subCode: null,
      description: null,
      remittanceCode: null,
    },
    ...over,
  });

  /**
   * The seeded connection is PKO BP's: the fixtures carry its operation codes,
   * and the tag a code gets is the profile of the connection's institution.
   */
  const PKO_BANK = "PKO Bank Polski";
  const PKO_BP = resolveProfile("enable_banking", "PL", PKO_BANK);

  /** Debits and credits with amounts a 2dp rounding would have destroyed. */
  const BANK_ROWS: BankTransaction[] = [
    row({ entryReference: "r1", amount: "50.00", direction: "debit" }),
    row({
      entryReference: "r2",
      amount: "1200.1234",
      direction: "credit",
      counterpartyName: "Employer",
      remittance: ["Salary"],
    }),
    row({
      entryReference: "r3",
      amount: "12.3457",
      direction: "debit",
      counterpartyName: "Kiosk",
      bookingDate: daysAgo(2),
    }),
    row({
      entryReference: "r4",
      amount: "0.0025",
      direction: "debit",
      counterpartyName: "Biedronka",
      bookingDate: daysAgo(1),
    }),
  ];
  const BANK_SUM =
    Math.round(
      (-50 + 1200.1234 - 12.3457 - 0.0025) * 10000, // signed, at 4dp
    ) / 10000;

  const query = <T = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ) => db.query(sql, params) as Promise<T[]>;
  const count = async (table: string): Promise<number> =>
    Number((await query(`SELECT COUNT(*)::int AS n FROM ${table}`))[0].n);
  const storedBalance = async (): Promise<number> =>
    Number(
      (
        await query<{ current_balance: string }>(
          `SELECT current_balance FROM accounts WHERE id = $1`,
          [accountId],
        )
      )[0].current_balance,
    );
  const ledgerBalance = async (): Promise<number> =>
    Number(
      (
        await query<{ balance: string }>(
          `SELECT a.opening_balance + COALESCE(SUM(t.amount), 0) AS balance
             FROM accounts a
             LEFT JOIN transactions t ON t.account_id = a.id
              AND (t.status IS NULL OR t.status != 'VOID')
              AND t.parent_transaction_id IS NULL
            WHERE a.id = $1
            GROUP BY a.id`,
          [accountId],
        )
      )[0].balance,
    );

  const bankReturns = (rows: BankTransaction[]) => {
    jest.spyOn(provider, "fetchTransactions").mockResolvedValue(rows);
  };

  async function seedBank(
    userId: string,
    monizeAccountId: string | null,
    over: { hash?: string; external?: string; institution?: string } = {},
  ): Promise<{ connectionId: string; bankAccountId: string }> {
    const [conn] = await query<{ id: string }>(
      `INSERT INTO bank_sync_connections
         (user_id, provider, institution_name, institution_country, psu_type,
          status, external_session_id, valid_until)
       VALUES ($1, 'enable_banking', $2, 'PL', 'personal', 'active',
               'session-1', CURRENT_TIMESTAMP + interval '30 days')
       RETURNING id`,
      [userId, over.institution ?? "Test Bank"],
    );
    const [bank] = await query<{ id: string }>(
      `INSERT INTO bank_sync_accounts
         (user_id, connection_id, external_account_id, identification_hash,
          display_name, currency_code)
       VALUES ($1, $2, $3, $4, 'Main account', 'PLN')
       RETURNING id`,
      [userId, conn.id, over.external ?? "ext-1", over.hash ?? "hash-1"],
    );
    if (monizeAccountId !== null) {
      await asAlice(() =>
        bankSync.linkAccount(userId, bank.id, {
          accountId: monizeAccountId,
          syncFromDate: daysAgo(30),
        }),
      );
    }
    return { connectionId: conn.id, bankAccountId: bank.id };
  }

  const sync = (psu: PsuContext | null = null) =>
    asAlice(() => bankSync.syncAccount(aliceId, bankAccountId, psu));

  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = "integration-test-encryption-key-0123456789";
    harness = await createEnforcedIntegrationModule([BankSyncModule]);
    module = harness.module;
    db = harness.owner;
    app = harness.app;
    bankSync = module.get(BankSyncService);
    writer = module.get(BankSyncWriterService);
    connections = module.get(BankSyncConnectionsService);
    credentials = module.get(BankSyncCredentialsService);
    rules = module.get(TransactionRulesService, { strict: false });
    provider = module.get(EnableBankingProvider);
  });

  afterAll(async () => {
    await harness.close();
    delete process.env.ENCRYPTION_KEY;
  });

  beforeEach(async () => {
    jest.restoreAllMocks();
    await cleanTables(db, [
      "bank_sync_imported_transactions",
      "bank_sync_accounts",
      "bank_sync_connections",
      "bank_sync_credentials",
      "job_claims",
      "transaction_rule_applications",
      "transaction_rules",
      "transaction_tags",
      "tags",
      "action_history",
      "transaction_splits",
      "transactions",
      "monthly_account_balances",
      "accounts",
      "categories",
      "payees",
      "users",
    ]);
    await db.query(
      `INSERT INTO currencies (code, name, symbol, decimal_places) VALUES
         ('PLN', 'Zloty', 'zl', 2), ('EUR', 'Euro', 'E', 2)
       ON CONFLICT DO NOTHING`,
    );
    aliceId = (await createTestUserDirect(db, { firstName: "Alice" })).id;
    bobId = (await createTestUserDirect(db, { firstName: "Bob" })).id;
    accountId = (
      await createTestAccount(db, aliceId, {
        name: "Checking",
        currencyCode: "PLN",
        openingBalance: OPENING,
        currentBalance: OPENING,
      })
    ).id;
    ({ connectionId, bankAccountId } = await seedBank(aliceId, accountId));
    // The credentials every sync resolves: stored through the real service, so
    // they are encrypted under the suite's ENCRYPTION_KEY and decrypted per call.
    await asAlice(() =>
      credentials.save(aliceId, { applicationId: "app-1", privateKey: PEM }),
    );

    jest.spyOn(provider, "fetchBalance").mockResolvedValue({
      amount: "2137.75",
      currencyCode: "PLN",
      referenceDate: daysAgo(0),
      balanceType: "CLBD",
    });
    bankReturns(BANK_ROWS);
  });

  describe("the harness", () => {
    it("is enforcing row-level security, so every assertion below is under the policies", async () => {
      const outside = await app.query(`SELECT id FROM bank_sync_accounts`);
      expect(outside).toEqual([]);
      expect(await count("bank_sync_accounts")).toBe(1);
    });
  });

  describe("the first sync", () => {
    it("imports every row and moves the balance by exactly their sum (INV-BALANCE-001)", async () => {
      const result = await sync();

      expect(result).toMatchObject({
        bankAccountId,
        imported: 4,
        skipped: 0,
        pending: 0,
        beforeCutoff: 0,
      });
      expect(BANK_SUM).toBe(1137.7752);
      expect(await storedBalance()).toBe(OPENING + BANK_SUM);
      // The stored balance is the ledger's, not a figure of its own.
      expect(await storedBalance()).toBe(await ledgerBalance());
      expect(await count("transactions")).toBe(4);
    });

    it("writes each row cleared, in the account's currency, dated and signed as the bank said", async () => {
      await sync();
      const stored = await query<{
        transaction_date: string;
        amount: string;
        currency_code: string;
        status: string;
        payee_name: string;
        description: string;
      }>(
        `SELECT TO_CHAR(transaction_date, 'YYYY-MM-DD') AS transaction_date,
                amount, currency_code, status, payee_name, description
           FROM transactions ORDER BY transaction_date, amount`,
      );
      expect(
        stored.map((t) => [
          t.transaction_date,
          Number(t.amount),
          t.currency_code,
          t.status,
          t.payee_name,
        ]),
      ).toEqual([
        [daysAgo(3), -50, "PLN", "CLEARED", "Biedronka"],
        [daysAgo(3), 1200.1234, "PLN", "CLEARED", "Employer"],
        [daysAgo(2), -12.3457, "PLN", "CLEARED", "Kiosk"],
        [daysAgo(1), -0.0025, "PLN", "CLEARED", "Biedronka"],
      ]);
    });

    it("claims a ledger row per transaction and points it at the transaction", async () => {
      await sync();
      const ledger = await query<{
        external_key: string;
        transaction_id: string | null;
      }>(
        `SELECT external_key, transaction_id
           FROM bank_sync_imported_transactions ORDER BY external_key`,
      );
      expect(ledger.map((l) => l.external_key)).toEqual([
        "ref:r1",
        "ref:r2",
        "ref:r3",
        "ref:r4",
      ]);
      expect(ledger.every((l) => l.transaction_id !== null)).toBe(true);
    });

    it("creates one payee per counterparty and reuses it", async () => {
      await sync();
      const payees = await query<{ name: string }>(
        `SELECT name FROM payees ORDER BY name`,
      );
      expect(payees.map((p) => p.name)).toEqual([
        "Biedronka",
        "Employer",
        "Kiosk",
      ]);
      const linked = await query<{ n: number }>(
        `SELECT COUNT(DISTINCT payee_id)::int AS n FROM transactions`,
      );
      expect(linked[0].n).toBe(3);
    });

    it("records the outcome and the bank's own balance on the bank account, not on the account", async () => {
      await sync();
      const [bank] = await query<{
        last_sync_status: string;
        last_sync_error: string | null;
        last_imported_count: number;
        last_skipped_count: number;
        last_refused_count: number;
        last_success_at: string | null;
        bank_balance: string;
        bank_balance_currency: string;
      }>(`SELECT * FROM bank_sync_accounts WHERE id = $1`, [bankAccountId]);
      expect(bank).toMatchObject({
        last_sync_status: "succeeded",
        last_sync_error: null,
        last_imported_count: 4,
        last_skipped_count: 0,
        last_refused_count: 0,
        bank_balance_currency: "PLN",
      });
      expect(bank.last_success_at).not.toBeNull();
      expect(Number(bank.bank_balance)).toBe(2137.75);
      // The bank's figure is for reconciliation only: it never writes the balance.
      expect(await storedBalance()).toBe(OPENING + BANK_SUM);
    });

    it("forwards the person's address and user agent to the bank on a user-present sync", async () => {
      const psu = { ipAddress: "203.0.113.4", userAgent: "Mozilla/5.0" };
      await sync(psu);
      expect(provider.fetchTransactions).toHaveBeenCalledWith(
        expect.anything(),
        "ext-1",
        expect.objectContaining({ dateTo: today }),
        psu,
      );
    });
  });

  describe("a second sync of the same rows (INV-BANKSYNC-001)", () => {
    it("imports nothing, reports every row as skipped, and moves no balance", async () => {
      await sync();
      const balanceAfterFirst = await storedBalance();

      const second = await sync();

      expect(second).toMatchObject({ imported: 0, skipped: 4 });
      expect(await count("transactions")).toBe(4);
      expect(await count("bank_sync_imported_transactions")).toBe(4);
      expect(await storedBalance()).toBe(balanceAfterFirst);
      const [bank] = await query<{
        last_imported_count: number;
        last_skipped_count: number;
      }>(
        `SELECT last_imported_count, last_skipped_count FROM bank_sync_accounts WHERE id = $1`,
        [bankAccountId],
      );
      expect(bank).toEqual({ last_imported_count: 0, last_skipped_count: 4 });
    });

    it("imports nothing when the bank changes every transaction_id between two fetches (the entry reference is the identity)", async () => {
      bankReturns(
        BANK_ROWS.map((r, i) => ({ ...r, transactionId: `T-a${i}` })),
      );
      await sync();
      bankReturns(
        BANK_ROWS.map((r, i) => ({ ...r, transactionId: `T-b${i}` })),
      );
      const second = await sync();
      expect(second).toMatchObject({ imported: 0, skipped: 4 });
      expect(await count("transactions")).toBe(4);
      expect(await storedBalance()).toBe(OPENING + BANK_SUM);
    });

    it("imports a row without an entry reference once when only its transaction_id changes", async () => {
      const bare = row({ entryReference: null, transactionId: "T-1" });
      bankReturns([bare]);
      await sync();
      bankReturns([{ ...bare, transactionId: "T-2" }]);
      const second = await sync();
      expect(second).toMatchObject({ imported: 0, skipped: 1 });
      expect(await count("transactions")).toBe(1);
    });

    it("plans a row repeated across pagination pages once", async () => {
      bankReturns([...BANK_ROWS, BANK_ROWS[0], BANK_ROWS[1]]);
      const result = await sync();
      expect(result).toMatchObject({ imported: 4, skipped: 0 });
      expect(await count("transactions")).toBe(4);
    });

    it("imports two transactions a bank gave one entry reference, once each, in any order", async () => {
      // Enable Banking's FAQ: some banks repeat an entry reference that should
      // be unique. Dropping the second would lose a real transaction.
      const a = row({ entryReference: "dup-1", amount: "5.00" });
      const b = row({ entryReference: "dup-1", amount: "7.00" });
      bankReturns([a, b]);
      const first = await sync();
      expect(first).toMatchObject({ imported: 2, skipped: 0 });
      expect(await storedBalance()).toBe(OPENING - 12);

      bankReturns([b, a]);
      const second = await sync();
      expect(second).toMatchObject({ imported: 0, skipped: 2 });
      expect(await count("transactions")).toBe(2);
      expect(await storedBalance()).toBe(OPENING - 12);
    });

    it("imports only what is new when the bank adds a row", async () => {
      await sync();
      bankReturns([
        ...BANK_ROWS,
        row({
          entryReference: "r5",
          amount: "5.00",
          counterpartyName: "Bakery",
        }),
      ]);
      const second = await sync();
      expect(second).toMatchObject({ imported: 1, skipped: 4 });
      expect(await count("transactions")).toBe(5);
      expect(await storedBalance()).toBe(
        Math.round((OPENING + BANK_SUM - 5) * 10000) / 10000,
      );
    });

    it("re-reads a week before the last success and still imports each row once", async () => {
      await sync();
      await sync();
      const window = (provider.fetchTransactions as jest.Mock).mock.calls[1][2];
      expect(window.dateFrom).toBe(daysAgo(7));
      expect(await count("transactions")).toBe(4);
    });

    it("does not bring back a transaction the user deleted", async () => {
      await sync();
      const [victim] = await query<{ id: string }>(
        `SELECT t.id FROM transactions t
           JOIN bank_sync_imported_transactions l ON l.transaction_id = t.id
          WHERE l.external_key = 'ref:r3'`,
      );
      await db.query(`DELETE FROM transactions WHERE id = $1`, [victim.id]);
      // The ledger row stays, with its transaction gone.
      const [ledger] = await query<{ transaction_id: string | null }>(
        `SELECT transaction_id FROM bank_sync_imported_transactions WHERE external_key = 'ref:r3'`,
      );
      expect(ledger.transaction_id).toBeNull();

      const second = await sync();

      expect(second).toMatchObject({ imported: 0, skipped: 4 });
      expect(await count("transactions")).toBe(3);
    });

    it("does not re-import after a disconnect and reconnect of the same bank", async () => {
      await sync();
      await asAlice(() => connections.disconnect(aliceId, connectionId));
      expect(await count("bank_sync_accounts")).toBe(0);
      // The ledger is keyed on the Monize account, not the connection.
      expect(await count("bank_sync_imported_transactions")).toBe(4);

      ({ connectionId, bankAccountId } = await seedBank(aliceId, accountId));
      const again = await sync();

      expect(again).toMatchObject({ imported: 0, skipped: 4 });
      expect(await count("transactions")).toBe(4);
    });
  });

  describe("two syncs at once", () => {
    it("through the writer: each row is created once and the balance moves once", async () => {
      const plan = planBankImport(BANK_ROWS, {
        accountCurrencyCode: "PLN",
        syncFromDate: daysAgo(30),
        today,
      });
      const write = () =>
        asAlice(() =>
          writer.write({
            userId: aliceId,
            bankAccountId,
            accountId,
            plannedSyncFromDate: daysAgo(30),
            plannedCurrencyCode: "PLN",
            plan,
            balance: null,
            tagOperationType: true,
            profile: PKO_BP,
          }),
        );

      const [a, b] = await Promise.all([write(), write()]);

      expect([a.imported, b.imported].sort()).toEqual([0, 4]);
      expect(a.imported + a.skipped).toBe(4);
      expect(b.imported + b.skipped).toBe(4);
      expect(await count("transactions")).toBe(4);
      expect(await count("bank_sync_imported_transactions")).toBe(4);
      expect(await storedBalance()).toBe(OPENING + BANK_SUM);
      expect(await storedBalance()).toBe(await ledgerBalance());
    });

    it("through the service with the lease stubbed away: still once", async () => {
      jest
        .spyOn(module.get(JobClaimService, { strict: false }), "claimLease")
        .mockResolvedValue("00000000-0000-4000-8000-000000000001");
      jest
        .spyOn(module.get(JobClaimService, { strict: false }), "releaseLease")
        .mockResolvedValue(undefined);

      const results = await Promise.all([sync(), sync()]);

      expect(results.map((r) => r.imported).sort()).toEqual([0, 4]);
      expect(await count("transactions")).toBe(4);
      expect(await storedBalance()).toBe(OPENING + BANK_SUM);
    });

    it("the real lease turns the second sync away with a 409", async () => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let started!: () => void;
      const fetching = new Promise<void>((resolve) => {
        started = resolve;
      });
      jest.spyOn(provider, "fetchTransactions").mockImplementation(async () => {
        started();
        await gate;
        return BANK_ROWS;
      });

      const first = sync();
      await fetching;
      await expect(sync()).rejects.toMatchObject({ status: 409 });
      release();
      await expect(first).resolves.toMatchObject({ imported: 4 });

      // The lease was given back: a third sync is admitted.
      jest.spyOn(provider, "fetchTransactions").mockResolvedValue(BANK_ROWS);
      await expect(sync()).resolves.toMatchObject({ imported: 0, skipped: 4 });
    });

    it("the ledger's unique key alone arbitrates: the second insert waits, then returns nothing", async () => {
      let releaseFirst!: () => void;
      const firstMayCommit = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      let signalFirstInserted!: () => void;
      const firstInserted = new Promise<void>((resolve) => {
        signalFirstInserted = resolve;
      });
      const claim = (m: EntityManager) =>
        m.query(
          `INSERT INTO bank_sync_imported_transactions
             (user_id, account_id, external_key, booking_date)
           VALUES ($1, $2, 'ref:race', $3)
           ON CONFLICT (account_id, external_key) DO NOTHING
           RETURNING id`,
          [aliceId, accountId, today],
        ) as Promise<{ id: string }[]>;

      const first = asAlice(() =>
        withScopedDb(app, async (m) => {
          const claimed = await claim(m);
          signalFirstInserted();
          await firstMayCommit;
          return claimed;
        }),
      );
      await firstInserted;
      const second = asAlice(() => withScopedDb(app, (m) => claim(m)));

      await waitForBlockedBackends(1);
      releaseFirst();
      const [a, b] = await Promise.all([first, second]);

      expect(a).toHaveLength(1);
      expect(b).toHaveLength(0);
      expect(await count("bank_sync_imported_transactions")).toBe(1);
    });
  });

  describe("a row in another currency (INV-BANKSYNC-003)", () => {
    it("is refused and counted, and writes no transaction and no ledger row", async () => {
      bankReturns([
        row({ entryReference: "eur-1", currencyCode: "EUR", amount: "99.00" }),
      ]);

      const result = await sync();

      expect(result).toMatchObject({
        imported: 0,
        skipped: 0,
        refused: { currency_mismatch: 1 },
      });
      expect(await count("transactions")).toBe(0);
      expect(await count("bank_sync_imported_transactions")).toBe(0);
      expect(await storedBalance()).toBe(OPENING);
      const [bank] = await query<{ last_refused_count: number }>(
        `SELECT last_refused_count FROM bank_sync_accounts WHERE id = $1`,
        [bankAccountId],
      );
      expect(bank.last_refused_count).toBe(1);
    });

    it("refuses a row the provider gave no currency for", async () => {
      bankReturns([row({ entryReference: "none-1", currencyCode: null })]);
      const result = await sync();
      expect(result.refused.currency_mismatch).toBe(1);
      expect(await count("transactions")).toBe(0);
    });

    it("imports the rows in the right currency beside a refused one", async () => {
      bankReturns([
        row({ entryReference: "ok-1", amount: "10.00" }),
        row({ entryReference: "eur-1", currencyCode: "EUR", amount: "99.00" }),
      ]);
      const result = await sync();
      expect(result).toMatchObject({
        imported: 1,
        refused: { currency_mismatch: 1 },
      });
      expect(await storedBalance()).toBe(OPENING - 10);
    });

    it("writes nothing at all when the account's currency changed while the bank was being read", async () => {
      const plan = planBankImport(BANK_ROWS, {
        accountCurrencyCode: "PLN",
        syncFromDate: daysAgo(30),
        today,
      });
      await db.query(
        `UPDATE accounts SET currency_code = 'EUR' WHERE id = $1`,
        [accountId],
      );

      await expect(
        asAlice(() =>
          writer.write({
            userId: aliceId,
            bankAccountId,
            accountId,
            plannedSyncFromDate: daysAgo(30),
            plannedCurrencyCode: "PLN",
            plan,
            balance: null,
            tagOperationType: true,
            profile: PKO_BP,
          }),
        ),
      ).rejects.toMatchObject({ status: 409 });

      expect(await count("transactions")).toBe(0);
      expect(await count("bank_sync_imported_transactions")).toBe(0);
    });
  });

  describe("a write that is refused has not already written", () => {
    it("refuses the whole write when the bank account was re-linked during the fetch", async () => {
      const other = await createTestAccount(db, aliceId, {
        name: "Other",
        currencyCode: "PLN",
      });
      const plan = planBankImport(BANK_ROWS, {
        accountCurrencyCode: "PLN",
        syncFromDate: daysAgo(30),
        today,
      });
      await asAlice(() =>
        bankSync.linkAccount(aliceId, bankAccountId, { accountId: other.id }),
      );

      await expect(
        asAlice(() =>
          writer.write({
            userId: aliceId,
            bankAccountId,
            accountId,
            plannedSyncFromDate: daysAgo(30),
            plannedCurrencyCode: "PLN",
            plan,
            balance: null,
            tagOperationType: true,
            profile: PKO_BP,
          }),
        ),
      ).rejects.toMatchObject({ status: 409 });

      expect(await count("transactions")).toBe(0);
      expect(await count("bank_sync_imported_transactions")).toBe(0);
    });

    it("refuses the whole write when the cut-off changed during the fetch, and last_success_at does not move", async () => {
      // A first sync records a success, so there is a last_success_at to protect.
      bankReturns([]);
      await sync();
      const successAt = async () =>
        (
          await query<{ last_success_at: Date }>(
            `SELECT last_success_at FROM bank_sync_accounts WHERE id = $1`,
            [bankAccountId],
          )
        )[0].last_success_at.getTime();
      const before = await successAt();
      expect(before).toBeGreaterThan(0);

      // The user moves the cut-off while the bank is being read.
      jest.spyOn(provider, "fetchTransactions").mockImplementation(async () => {
        await db.query(
          `UPDATE bank_sync_accounts SET sync_from_date = $2 WHERE id = $1`,
          [bankAccountId, daysAgo(2)],
        );
        return BANK_ROWS;
      });

      await expect(sync()).rejects.toMatchObject({ status: 409 });

      expect(await count("transactions")).toBe(0);
      expect(await count("bank_sync_imported_transactions")).toBe(0);
      expect(await successAt()).toBe(before);
      expect(await storedBalance()).toBe(OPENING);
      const [bank] = await query<{ last_sync_status: string }>(
        `SELECT last_sync_status FROM bank_sync_accounts WHERE id = $1`,
        [bankAccountId],
      );
      expect(bank.last_sync_status).toBe("failed");

      // The next sync plans against the new cut-off and imports what it allows.
      bankReturns(BANK_ROWS);
      await expect(sync()).resolves.toMatchObject({ imported: 2 });
    });

    it("refuses a closed account before any row is written", async () => {
      await db.query(`UPDATE accounts SET is_closed = true WHERE id = $1`, [
        accountId,
      ]);
      await expect(sync()).rejects.toBeInstanceOf(BadRequestException);
      expect(await count("transactions")).toBe(0);
      const [bank] = await query<{ last_sync_status: string }>(
        `SELECT last_sync_status FROM bank_sync_accounts WHERE id = $1`,
        [bankAccountId],
      );
      expect(bank.last_sync_status).toBe("failed");
    });

    it("records a provider failure on the bank account and writes nothing", async () => {
      jest
        .spyOn(provider, "fetchTransactions")
        .mockRejectedValue(
          new BankSyncProviderError("unavailable", "provider down", 503),
        );
      await expect(sync()).rejects.toMatchObject({ status: 503 });
      expect(await count("transactions")).toBe(0);
      const [bank] = await query<{ last_sync_status: string }>(
        `SELECT last_sync_status FROM bank_sync_accounts WHERE id = $1`,
        [bankAccountId],
      );
      expect(bank.last_sync_status).toBe("failed");
      const [failure] = await query<{ last_sync_error: string }>(
        `SELECT last_sync_error FROM bank_sync_accounts WHERE id = $1`,
        [bankAccountId],
      );
      expect(failure.last_sync_error).toBe("provider down");
      // The lease was given back.
      expect(await count("job_claims")).toBe(0);
    });
  });

  describe("import rules (trigger `import`)", () => {
    let groceriesId: string;

    const newRule = (over: Partial<CreateTransactionRuleDto> = {}) =>
      ({
        name: "Biedronka",
        triggers: ["import"],
        condition: { field: "payeeText", op: "contains", value: "biedronka" },
        actions: [{ type: "set_category", categoryId: groceriesId }],
        ...over,
      }) as CreateTransactionRuleDto;

    beforeEach(async () => {
      groceriesId = (
        await createTestCategory(db, aliceId, { name: "Groceries" })
      ).id;
    });

    it("categorises the rows whose raw payee text matches, in the same transaction, and leaves the rest", async () => {
      await asAlice(() => rules.create(aliceId, newRule()));

      await sync();

      const stored = await query<{
        payee_name: string;
        category_id: string | null;
      }>(
        `SELECT payee_name, category_id FROM transactions ORDER BY transaction_date, amount`,
      );
      expect(stored.map((t) => [t.payee_name, t.category_id])).toEqual([
        ["Biedronka", groceriesId],
        ["Employer", null],
        ["Kiosk", null],
        ["Biedronka", groceriesId],
      ]);
      const applications = await query<{ source: string }>(
        `SELECT source FROM transaction_rule_applications`,
      );
      expect(applications).toHaveLength(2);
      expect(applications.every((a) => a.source === "import")).toBe(true);
    });

    it("does not apply a rule that has only the create trigger", async () => {
      await asAlice(() =>
        rules.create(aliceId, newRule({ triggers: ["create"] } as never)),
      );
      await sync();
      const stored = await query<{ category_id: string | null }>(
        `SELECT category_id FROM transactions`,
      );
      expect(stored.every((t) => t.category_id === null)).toBe(true);
      expect(await count("transaction_rule_applications")).toBe(0);
    });

    it("leaves no rule effect behind when the write fails after the rules ran", async () => {
      await asAlice(() => rules.create(aliceId, newRule()));
      const accounts = module.get(AccountsService, { strict: false });
      jest
        .spyOn(accounts, "recalculateCurrentBalance")
        .mockRejectedValue(new Error("late failure"));

      await expect(sync()).rejects.toThrow("late failure");

      expect(await count("transactions")).toBe(0);
      expect(await count("bank_sync_imported_transactions")).toBe(0);
      expect(await count("transaction_rule_applications")).toBe(0);
      expect(await count("payees")).toBe(0);
      expect(await storedBalance()).toBe(OPENING);
    });
  });

  describe("linking", () => {
    it("refuses to link a second bank account to an account that is already linked", async () => {
      const second = await seedBank(aliceId, null, {
        hash: "hash-2",
        external: "ext-2",
      });
      await expect(
        asAlice(() =>
          bankSync.linkAccount(aliceId, second.bankAccountId, { accountId }),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it("lets exactly one of two racing links win, by the partial unique index", async () => {
      const target = await createTestAccount(db, aliceId, {
        name: "Target",
        currencyCode: "PLN",
      });
      const a = await seedBank(aliceId, null, { hash: "h-a", external: "e-a" });
      const b = await seedBank(aliceId, null, { hash: "h-b", external: "e-b" });

      const outcomes = await Promise.allSettled([
        asAlice(() =>
          bankSync.linkAccount(aliceId, a.bankAccountId, {
            accountId: target.id,
          }),
        ),
        asAlice(() =>
          bankSync.linkAccount(aliceId, b.bankAccountId, {
            accountId: target.id,
          }),
        ),
      ]);

      expect(outcomes.map((o) => o.status).sort()).toEqual([
        "fulfilled",
        "rejected",
      ]);
      const rejected = outcomes.find(
        (o): o is PromiseRejectedResult => o.status === "rejected",
      )!;
      expect(rejected.reason).toBeInstanceOf(BadRequestException);
      const linked = await query<{ n: number }>(
        `SELECT COUNT(*)::int AS n FROM bank_sync_accounts WHERE account_id = $1`,
        [target.id],
      );
      expect(linked[0].n).toBe(1);
    });

    it("refuses a currency mismatch, a foreign account and a brokerage account", async () => {
      const eur = await createTestAccount(db, aliceId, {
        name: "Euro",
        currencyCode: "EUR",
      });
      const bobs = await createTestAccount(db, bobId, {
        name: "Bob's",
        currencyCode: "PLN",
      });
      const free = await seedBank(aliceId, null, {
        hash: "h-f",
        external: "e-f",
      });
      for (const accountToLink of [eur.id, bobs.id]) {
        await expect(
          asAlice(() =>
            bankSync.linkAccount(aliceId, free.bankAccountId, {
              accountId: accountToLink,
            }),
          ),
        ).rejects.toBeInstanceOf(BadRequestException);
      }
      const brokerage = await createTestAccount(db, aliceId, {
        name: "Brokerage",
        currencyCode: "PLN",
      });
      await db.query(
        `UPDATE accounts SET account_type = 'INVESTMENT', account_sub_type = 'INVESTMENT_BROKERAGE' WHERE id = $1`,
        [brokerage.id],
      );
      await expect(
        asAlice(() =>
          bankSync.linkAccount(aliceId, free.bankAccountId, {
            accountId: brokerage.id,
          }),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it("defaults the cut-off to the day after the newest transaction", async () => {
      const target = await createTestAccount(db, aliceId, {
        name: "Has history",
        currencyCode: "PLN",
      });
      await db.query(
        `INSERT INTO transactions (user_id, account_id, transaction_date, amount, currency_code, status)
         VALUES ($1, $2, $3, -5, 'PLN', 'CLEARED'),
                ($1, $2, $4, -7, 'PLN', 'VOID')`,
        [aliceId, target.id, daysAgo(10), daysAgo(2)],
      );
      const free = await seedBank(aliceId, null, {
        hash: "h-c",
        external: "e-c",
      });

      const view = await asAlice(() =>
        bankSync.linkAccount(aliceId, free.bankAccountId, {
          accountId: target.id,
        }),
      );

      // The VOID row, newer, is not what the default follows.
      expect(view.syncFromDate).toBe(daysAgo(9));
    });

    it("does not let another user link or sync the bank account", async () => {
      await expect(
        asBob(() =>
          bankSync.linkAccount(bobId, bankAccountId, { accountId: null }),
        ),
      ).rejects.toMatchObject({ status: 404 });
      await expect(
        asBob(() => bankSync.syncAccount(bobId, bankAccountId, null)),
      ).rejects.toMatchObject({ status: 404 });
      await expect(
        asBob(() => bankSync.syncConnection(bobId, connectionId, null)),
      ).rejects.toMatchObject({ status: 404 });
      expect(await asBob(() => connections.list(bobId))).toEqual([]);
    });
  });

  describe("the authorization flow: the state is a claim (integration for the CAS)", () => {
    let state: string;

    const institution = {
      name: "Test Bank",
      country: "PL",
      logoUrl: null,
      psuTypes: ["personal"],
      maximumConsentValiditySeconds: 90 * 24 * 3600,
    };

    beforeEach(async () => {
      await asAlice(() =>
        credentials.save(aliceId, { applicationId: "app-1", privateKey: PEM }),
      );
      jest.spyOn(provider, "listInstitutions").mockResolvedValue([institution]);
      jest.spyOn(provider, "revokeSession").mockResolvedValue(undefined);
      jest
        .spyOn(provider, "startAuthorization")
        .mockImplementation(async (_credentials, input) => {
          state = input.state;
          return { url: "https://bank.example/auth" };
        });
      jest.spyOn(provider, "completeAuthorization").mockResolvedValue({
        sessionId: "session-42",
        validUntil: new Date(Date.now() + 80 * 24 * 3600 * 1000),
        accounts: [
          {
            externalAccountId: "ext-new",
            identificationHash: "hash-1",
            displayName: "Main account",
            identifierMasked: "**** 1234",
            accountIdentifier: null,
            cashAccountType: null,
            currencyCode: "PLN",
          },
          {
            externalAccountId: "ext-savings",
            identificationHash: "hash-9",
            displayName: "Savings",
            identifierMasked: "**** 9999",
            accountIdentifier: null,
            cashAccountType: null,
            currencyCode: "PLN",
          },
        ],
      });
    });

    const start = async () => {
      const started = await asAlice(() =>
        connections.start(aliceId, {
          institutionName: "Test Bank",
          country: "PL",
          psuType: "personal",
        }),
      );
      return started.connectionId;
    };

    it("stores only the hash of the state and marks the row pending", async () => {
      const id = await start();
      const [stored] = await query<{
        status: string;
        auth_state_hash: string;
        valid_until: string | null;
      }>(
        `SELECT status, auth_state_hash, valid_until FROM bank_sync_connections WHERE id = $1`,
        [id],
      );
      expect(stored.status).toBe("pending");
      expect(stored.auth_state_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(stored.auth_state_hash).not.toContain(state);
    });

    it("lets exactly one of two concurrent callbacks with the same state through", async () => {
      const id = await start();

      const outcomes = await Promise.allSettled([
        asAlice(() =>
          connections.completeCallback(aliceId, { state, code: "code-1" }),
        ),
        asAlice(() =>
          connections.completeCallback(aliceId, { state, code: "code-1" }),
        ),
      ]);

      expect(outcomes.map((o) => o.status).sort()).toEqual([
        "fulfilled",
        "rejected",
      ]);
      const rejected = outcomes.find(
        (o): o is PromiseRejectedResult => o.status === "rejected",
      )!;
      expect(rejected.reason).toBeInstanceOf(BadRequestException);
      expect(provider.completeAuthorization).toHaveBeenCalledTimes(1);
      const [conn] = await query<{
        status: string;
        auth_state_hash: string | null;
        external_session_id: string;
      }>(
        `SELECT status, auth_state_hash, external_session_id FROM bank_sync_connections WHERE id = $1`,
        [id],
      );
      expect(conn).toEqual({
        status: "active",
        auth_state_hash: null,
        external_session_id: "session-42",
      });
      expect(
        await count("bank_sync_accounts WHERE connection_id = '" + id + "'"),
      ).toBe(2);
    });

    it("refuses a replay of a state already used", async () => {
      await start();
      await asAlice(() =>
        connections.completeCallback(aliceId, { state, code: "code-1" }),
      );
      await expect(
        asAlice(() =>
          connections.completeCallback(aliceId, { state, code: "code-1" }),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(provider.completeAuthorization).toHaveBeenCalledTimes(1);
    });

    it("refuses another user's state with the same 400, and leaves it claimable by its owner", async () => {
      await start();
      await expect(
        asBob(() =>
          connections.completeCallback(bobId, { state, code: "code-1" }),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(provider.completeAuthorization).not.toHaveBeenCalled();

      await expect(
        asAlice(() =>
          connections.completeCallback(aliceId, { state, code: "code-1" }),
        ),
      ).resolves.toMatchObject({
        connection: { status: "active" },
      });
    });

    it("refuses a state older than 30 minutes", async () => {
      const id = await start();
      await db.query(
        `UPDATE bank_sync_connections
            SET auth_started_at = CURRENT_TIMESTAMP - interval '31 minutes'
          WHERE id = $1`,
        [id],
      );
      await expect(
        asAlice(() =>
          connections.completeCallback(aliceId, { state, code: "code-1" }),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(provider.completeAuthorization).not.toHaveBeenCalled();
    });

    it("records the bank's refusal and spends the state", async () => {
      const id = await start();
      const { connection: view } = await asAlice(() =>
        connections.completeCallback(aliceId, {
          state,
          error: "access_denied",
          errorDescription: "The user cancelled",
        }),
      );
      expect(view).toMatchObject({
        id,
        status: "failed",
        lastError: "The user cancelled",
      });
      await expect(
        asAlice(() =>
          connections.completeCallback(aliceId, { state, code: "code-1" }),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it("keeps every mapping and cut-off across a re-authorization, matching by identification hash", async () => {
      // The seeded connection is active and linked (hash-1 -> Checking).
      await asAlice(() => connections.reauthorize(aliceId, connectionId));
      const [renewing] = await query<{ status: string }>(
        `SELECT status FROM bank_sync_connections WHERE id = $1`,
        [connectionId],
      );
      // The working session keeps its status while the renewal is under way.
      expect(renewing.status).toBe("active");

      const { connection: view } = await asAlice(() =>
        connections.completeCallback(aliceId, { state, code: "code-2" }),
      );

      expect(view.status).toBe("active");
      const bank = view.accounts.find((a) => a.id === bankAccountId)!;
      expect(bank).toMatchObject({
        accountId,
        syncFromDate: daysAgo(30),
      });
      const [renamed] = await query<{ external_account_id: string }>(
        `SELECT external_account_id FROM bank_sync_accounts WHERE id = $1`,
        [bankAccountId],
      );
      expect(renamed.external_account_id).toBe("ext-new");
      // The savings account is new and unmapped.
      const savings = view.accounts.find((a) => a.displayName === "Savings")!;
      expect(savings.accountId).toBeNull();
      expect(view.accounts).toHaveLength(2);
    });
  });

  describe("a renewal never disables a working connection", () => {
    let state: string;

    const institution = {
      name: "Test Bank",
      country: "PL",
      logoUrl: null,
      psuTypes: ["personal"],
      maximumConsentValiditySeconds: 90 * 24 * 3600,
    };
    const renewedSession = {
      sessionId: "session-42",
      validUntil: new Date(Date.now() + 80 * 24 * 3600 * 1000),
      accounts: [
        {
          externalAccountId: "ext-1",
          identificationHash: "hash-1",
          displayName: "Main account",
          identifierMasked: "**** 1234",
          accountIdentifier: null,
          cashAccountType: null,
          currencyCode: "PLN",
        },
      ],
    };

    const connectionState = async () =>
      (
        await query<{
          status: string;
          auth_state_hash: string | null;
          external_session_id: string | null;
          last_error: string | null;
        }>(
          `SELECT status, auth_state_hash, external_session_id, last_error
             FROM bank_sync_connections WHERE id = $1`,
          [connectionId],
        )
      )[0];

    beforeEach(async () => {
      jest.spyOn(provider, "listInstitutions").mockResolvedValue([institution]);
      jest.spyOn(provider, "revokeSession").mockResolvedValue(undefined);
      jest
        .spyOn(provider, "startAuthorization")
        .mockImplementation(async (_credentials, input) => {
          state = input.state;
          return { url: "https://bank.example/auth" };
        });
      jest
        .spyOn(provider, "completeAuthorization")
        .mockResolvedValue(renewedSession);
    });

    it("starting a renewal leaves the status and the session alone", async () => {
      await asAlice(() => connections.reauthorize(aliceId, connectionId));
      const conn = await connectionState();
      expect(conn.status).toBe("active");
      expect(conn.external_session_id).toBe("session-1");
      expect(conn.auth_state_hash).toMatch(/^[0-9a-f]{64}$/);
      // The old session still syncs.
      await expect(sync()).resolves.toMatchObject({ imported: 4 });
    });

    it("a provider failure while starting it leaves an active connection active", async () => {
      jest
        .spyOn(provider, "startAuthorization")
        .mockRejectedValue(
          new BankSyncProviderError("unavailable", "gateway down", 503),
        );
      await expect(
        asAlice(() => connections.reauthorize(aliceId, connectionId)),
      ).rejects.toMatchObject({ status: 503 });
      const conn = await connectionState();
      expect(conn).toMatchObject({
        status: "active",
        auth_state_hash: null,
        external_session_id: "session-1",
        last_error: "gateway down",
      });
      await expect(sync()).resolves.toMatchObject({ imported: 4 });
    });

    it("an error at the bank records last_error and spends the state but keeps the status", async () => {
      await asAlice(() => connections.reauthorize(aliceId, connectionId));
      const { connection: view } = await asAlice(() =>
        connections.completeCallback(aliceId, {
          state,
          error: "access_denied",
          errorDescription: "The user cancelled",
        }),
      );
      expect(view).toMatchObject({
        status: "active",
        lastError: "The user cancelled",
      });
      const conn = await connectionState();
      expect(conn).toMatchObject({
        status: "active",
        auth_state_hash: null,
        external_session_id: "session-1",
      });
      // The state is spent.
      await expect(
        asAlice(() =>
          connections.completeCallback(aliceId, { state, code: "code-1" }),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it("a failed code exchange keeps an active connection active and an expired one expired", async () => {
      jest
        .spyOn(provider, "completeAuthorization")
        .mockRejectedValue(
          new BankSyncProviderError("bad_request", "code already used", 422),
        );
      await asAlice(() => connections.reauthorize(aliceId, connectionId));
      await expect(
        asAlice(() =>
          connections.completeCallback(aliceId, { state, code: "code-1" }),
        ),
      ).rejects.toMatchObject({ status: 400 });
      expect(await connectionState()).toMatchObject({
        status: "active",
        auth_state_hash: null,
        external_session_id: "session-1",
        last_error: "code already used",
      });

      await db.query(
        `UPDATE bank_sync_connections SET status = 'expired' WHERE id = $1`,
        [connectionId],
      );
      await asAlice(() => connections.reauthorize(aliceId, connectionId));
      await expect(
        asAlice(() =>
          connections.completeCallback(aliceId, { state, code: "code-2" }),
        ),
      ).rejects.toMatchObject({ status: 400 });
      expect((await connectionState()).status).toBe("expired");
    });

    it("a first-time connection whose authorization fails does become failed", async () => {
      jest.spyOn(provider, "listInstitutions").mockResolvedValue([institution]);
      const started = await asAlice(() =>
        connections.start(aliceId, {
          institutionName: "Test Bank",
          country: "PL",
          psuType: "personal",
        }),
      );
      const { connection: view } = await asAlice(() =>
        connections.completeCallback(aliceId, {
          state,
          error: "access_denied",
        }),
      );
      expect(view).toMatchObject({
        id: started.connectionId,
        status: "failed",
      });
    });

    it("a successful renewal replaces the session and revokes the previous one", async () => {
      await asAlice(() => connections.reauthorize(aliceId, connectionId));
      const { connection: view } = await asAlice(() =>
        connections.completeCallback(aliceId, { state, code: "code-1" }),
      );
      expect(view.status).toBe("active");
      expect(await connectionState()).toMatchObject({
        status: "active",
        external_session_id: "session-42",
        auth_state_hash: null,
      });
      expect(provider.revokeSession).toHaveBeenCalledTimes(1);
      expect(provider.revokeSession).toHaveBeenCalledWith(
        expect.anything(),
        "session-1",
      );
    });

    it("renews a connection that was expired, keeping its mappings", async () => {
      await db.query(
        `UPDATE bank_sync_connections SET status = 'expired' WHERE id = $1`,
        [connectionId],
      );
      await asAlice(() => connections.reauthorize(aliceId, connectionId));
      expect((await connectionState()).status).toBe("expired");
      const { connection: view } = await asAlice(() =>
        connections.completeCallback(aliceId, { state, code: "code-1" }),
      );
      expect(view.status).toBe("active");
      expect(view.accounts.find((a) => a.id === bankAccountId)).toMatchObject({
        accountId,
      });
    });
  });

  describe("syncing every account of a connection", () => {
    it("answers one entry per linked account, the failed one as an error, and keeps what the others imported", async () => {
      const second = await createTestAccount(db, aliceId, {
        name: "Savings",
        currencyCode: "PLN",
      });
      const [bank2] = await query<{ id: string }>(
        `INSERT INTO bank_sync_accounts
           (user_id, connection_id, external_account_id, identification_hash,
            display_name, currency_code)
         VALUES ($1, $2, 'ext-2', 'hash-2', 'Savings', 'PLN')
         RETURNING id`,
        [aliceId, connectionId],
      );
      await asAlice(() =>
        bankSync.linkAccount(aliceId, bank2.id, {
          accountId: second.id,
          syncFromDate: daysAgo(30),
        }),
      );
      // The connection-wide sync skips an account whose first import nobody has
      // confirmed (spec section 7a, covered by
      // bank-sync-notifications.integration.spec.ts); these two have been.
      await db.query(
        `UPDATE bank_sync_accounts
            SET last_success_at = CURRENT_TIMESTAMP - interval '1 day'
          WHERE connection_id = $1`,
        [connectionId],
      );
      jest
        .spyOn(provider, "fetchTransactions")
        .mockImplementation(async (_credentials, externalAccountId) => {
          if (externalAccountId === "ext-2") {
            throw new BankSyncProviderError("rate_limited", "429", 429);
          }
          return BANK_ROWS;
        });

      const entries = await asAlice(() =>
        bankSync.syncConnection(aliceId, connectionId, null),
      );

      expect(entries).toHaveLength(2);
      expect(entries[0]).toMatchObject({ bankAccountId, imported: 4 });
      expect(entries[1]).toMatchObject({
        bankAccountId: bank2.id,
        error: { code: "rate_limited" },
      });
      expect(await count("transactions")).toBe(4);
      expect(await storedBalance()).toBe(OPENING + BANK_SUM);
      const [failed] = await query<{ last_sync_status: string }>(
        `SELECT last_sync_status FROM bank_sync_accounts WHERE id = $1`,
        [bank2.id],
      );
      expect(failed.last_sync_status).toBe("failed");
    });

    it("throws, attempting nothing, when the connection is not active", async () => {
      await db.query(
        `UPDATE bank_sync_connections SET status = 'failed' WHERE id = $1`,
        [connectionId],
      );
      const fetch = jest.spyOn(provider, "fetchTransactions");
      await expect(
        asAlice(() => bankSync.syncConnection(aliceId, connectionId, null)),
      ).rejects.toMatchObject({ status: 409 });
      expect(fetch).not.toHaveBeenCalled();
    });
  });

  describe("preview before import (spec section 7a)", () => {
    const preview = () =>
      asAlice(() => bankSync.previewAccount(aliceId, bankAccountId, null));
    const syncWith = (planFingerprint?: string) =>
      asAlice(() =>
        bankSync.syncAccount(aliceId, bankAccountId, null, planFingerprint),
      );

    /** Everything a sync would have changed, in one comparable value. */
    const snapshot = async () => ({
      transactions: await count("transactions"),
      ledger: await count("bank_sync_imported_transactions"),
      payees: await count("payees"),
      applications: await count("transaction_rule_applications"),
      balance: await storedBalance(),
      link: await query(
        `SELECT last_synced_at, last_success_at, last_sync_status,
                last_sync_error, last_imported_count, last_skipped_count,
                last_refused_count, bank_balance, bank_balance_currency,
                bank_balance_date, sync_from_date, account_id
           FROM bank_sync_accounts`,
      ),
    });

    const lastSyncStatus = async () =>
      (
        await query<{ last_sync_status: string | null }>(
          `SELECT last_sync_status FROM bank_sync_accounts WHERE id = $1`,
          [bankAccountId],
        )
      )[0].last_sync_status;

    const groceryRule = async () => {
      const groceries = await createTestCategory(db, aliceId, {
        name: "Groceries",
      });
      await asAlice(() =>
        rules.create(aliceId, {
          name: "Biedronka",
          triggers: ["import"],
          condition: {
            field: "payeeText",
            op: "contains",
            value: "biedronka",
          },
          actions: [{ type: "set_category", categoryId: groceries.id }],
        } as CreateTransactionRuleDto),
      );
      return groceries;
    };

    it("writes nothing, for a user with payees and import rules", async () => {
      await groceryRule();
      await db.query(
        `INSERT INTO payees (user_id, name) VALUES ($1, 'Employer')`,
        [aliceId],
      );
      const before = await snapshot();

      const view = await preview();

      expect(view.summary.new).toBe(4);
      expect(await snapshot()).toEqual(before);
      expect(await count("transactions")).toBe(0);
      expect(await count("bank_sync_imported_transactions")).toBe(0);
      expect(await count("payees")).toBe(1);
      expect(await count("transaction_rule_applications")).toBe(0);
      expect(await storedBalance()).toBe(OPENING);
    });

    it("lists every row with its outcome, the balance after the import, and the bank's balance", async () => {
      bankReturns([
        ...BANK_ROWS,
        row({ entryReference: "eur", currencyCode: "EUR" }),
        row({ entryReference: "pending", booked: false }),
        row({ entryReference: "old", bookingDate: daysAgo(60) }),
      ]);

      const view = await preview();

      expect(view.rows.map((r) => r.outcome)).toEqual([
        "new",
        "new",
        "new",
        "new",
        "refused",
        "pending",
        "before_cutoff",
      ]);
      expect(view.rows[4].refusalReason).toBe("currency_mismatch");
      expect(view.summary).toMatchObject({
        new: 4,
        duplicate: 0,
        refused: 1,
        pending: 1,
        beforeCutoff: 1,
      });
      expect(view.currencyCode).toBe("PLN");
      expect(view.monizeBalance).toBe("1000.0000");
      expect(view.balanceAfter).toBe((OPENING + BANK_SUM).toFixed(4));
      expect(view.bankBalance).toMatchObject({
        amount: "2137.7500",
        currencyCode: "PLN",
      });
      expect(view.difference).toBe((2137.75 - (OPENING + BANK_SUM)).toFixed(4));
      expect(view.planFingerprint).toMatch(/^[0-9a-f]{64}$/);
    });

    it("lists a row the ledger already holds as a duplicate", async () => {
      await sync();
      bankReturns([
        ...BANK_ROWS,
        row({
          entryReference: "r5",
          amount: "9.99",
          counterpartyName: "Cafe",
          bookingDate: daysAgo(1),
        }),
      ]);

      const view = await preview();

      expect(view.rows.map((r) => r.outcome)).toEqual([
        "duplicate",
        "duplicate",
        "duplicate",
        "duplicate",
        "new",
      ]);
      expect(view.summary).toMatchObject({ new: 1, duplicate: 4 });
      // The balance moves by the one new row only.
      expect(view.balanceAfter).toBe((OPENING + BANK_SUM - 9.99).toFixed(4));
    });

    it("shows the payee and the category the sync would give, without creating either", async () => {
      await groceryRule();
      await db.query(
        `INSERT INTO payees (user_id, name) VALUES ($1, 'Employer')`,
        [aliceId],
      );

      const view = await preview();

      const byPayee = (text: string) =>
        view.rows.filter((r) => r.payeeText === text);
      expect(byPayee("Biedronka").map((r) => r.categoryName)).toEqual([
        "Groceries",
        "Groceries",
      ]);
      expect(byPayee("Employer")[0]).toMatchObject({
        payeeName: "Employer",
        categoryName: null,
      });
      // Kiosk has no payee yet: the sync would create it under the bank's text.
      expect(byPayee("Kiosk")[0].payeeName).toBe("Kiosk");
      expect(await count("payees")).toBe(1);
      expect(await count("transaction_rule_applications")).toBe(0);
    });

    it("then a sync with its fingerprint imports exactly the rows it listed", async () => {
      const view = await preview();
      const imported = await syncWith(view.planFingerprint);

      expect(imported).toMatchObject({ imported: 4, skipped: 0 });
      expect(await storedBalance()).toBe(Number(view.balanceAfter));
      expect(await ledgerBalance()).toBe(Number(view.balanceAfter));
      expect(await count("transactions")).toBe(view.summary.new);
    });

    it("then a sync with its fingerprint imports only the new rows when some were imported before", async () => {
      await sync();
      bankReturns([
        ...BANK_ROWS,
        row({ entryReference: "r5", amount: "9.99", bookingDate: daysAgo(1) }),
      ]);
      const view = await preview();

      await expect(syncWith(view.planFingerprint)).resolves.toMatchObject({
        imported: 1,
        skipped: 4,
      });
    });

    it("refuses with 409 and writes nothing when the bank's answer changed between the preview and the sync", async () => {
      const view = await preview();
      bankReturns([
        ...BANK_ROWS,
        row({
          entryReference: "late",
          amount: "7.00",
          bookingDate: daysAgo(1),
        }),
      ]);
      const before = await snapshot();

      const error = await syncWith(view.planFingerprint).catch(
        (e: unknown) => e,
      );

      expect(error).toMatchObject({ status: 409 });
      expect((error as Error).message).toMatch(/preview/i);
      expect(await snapshot()).toEqual(before);
      expect(await count("transactions")).toBe(0);
      expect(await count("bank_sync_imported_transactions")).toBe(0);
      expect(await storedBalance()).toBe(OPENING);
      // Nothing was attempted, so no failed sync is recorded.
      expect(await lastSyncStatus()).toBeNull();

      // Previewing again describes the new answer, and confirming it works.
      const again = await preview();
      expect(again.summary.new).toBe(5);
      expect(again.planFingerprint).not.toBe(view.planFingerprint);
      await expect(syncWith(again.planFingerprint)).resolves.toMatchObject({
        imported: 5,
      });
    });

    it("refuses with 409 when an amount changed under the same keys", async () => {
      const view = await preview();
      bankReturns(
        BANK_ROWS.map((r) =>
          r.entryReference === "r1" ? { ...r, amount: "50.01" } : r,
        ),
      );
      await expect(syncWith(view.planFingerprint)).rejects.toMatchObject({
        status: 409,
      });
      expect(await count("transactions")).toBe(0);
    });

    it("refuses with 409 when another sync imported rows after the preview", async () => {
      const view = await preview();
      await sync();
      await expect(syncWith(view.planFingerprint)).rejects.toMatchObject({
        status: 409,
      });
      // The first sync's rows are the only ones written.
      expect(await count("transactions")).toBe(4);
    });

    it("a sync without a fingerprint is unchanged: the daily sync still imports", async () => {
      await preview();
      await expect(syncWith()).resolves.toMatchObject({ imported: 4 });
    });

    it("a preview during a running sync is a 409, and a sync during a preview too", async () => {
      const gated = () => {
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
          release = resolve;
        });
        let started!: () => void;
        const fetching = new Promise<void>((resolve) => {
          started = resolve;
        });
        jest
          .spyOn(provider, "fetchTransactions")
          .mockImplementation(async () => {
            started();
            await gate;
            return BANK_ROWS;
          });
        return { release, fetching };
      };

      const running = gated();
      const first = sync();
      await running.fetching;
      await expect(preview()).rejects.toMatchObject({ status: 409 });
      running.release();
      await first;

      const previewing = gated();
      const second = preview();
      await previewing.fetching;
      await expect(sync()).rejects.toMatchObject({ status: 409 });
      previewing.release();
      await second;

      // ... and the lease was given back.
      jest.spyOn(provider, "fetchTransactions").mockResolvedValue(BANK_ROWS);
      await expect(preview()).resolves.toBeDefined();
    });

    it("records no failed sync when the bank fails during a preview", async () => {
      jest
        .spyOn(provider, "fetchTransactions")
        .mockRejectedValue(new BankSyncProviderError("unavailable", "down"));
      await expect(preview()).rejects.toMatchObject({ status: 503 });
      expect(await lastSyncStatus()).toBeNull();
    });

    it("is the caller's alone", async () => {
      await expect(
        asBob(() => bankSync.previewAccount(bobId, bankAccountId, null)),
      ).rejects.toMatchObject({ status: 404 });
    });

    it("needsPreview is true until a sync succeeds, and again after a new cut-off", async () => {
      const needs = async () =>
        (await asAlice(() => connections.list(aliceId)))[0].accounts[0]
          .needsPreview;

      expect(await needs()).toBe(true);
      await sync();
      expect(await needs()).toBe(false);

      await asAlice(() =>
        bankSync.linkAccount(aliceId, bankAccountId, {
          accountId,
          syncFromDate: daysAgo(10),
        }),
      );
      expect(await needs()).toBe(true);
    });
  });

  describe("preview details: selection, exceptions, operation types, payees and rules (spec section 7b)", () => {
    // The rows of this block carry PKO BP's operation codes, and the tag a code
    // gets is the profile of the connection's institution.
    beforeEach(async () => {
      await query(`UPDATE bank_sync_connections SET institution_name = $1`, [
        PKO_BANK,
      ]);
    });

    const preview = () =>
      asAlice(() => bankSync.previewAccount(aliceId, bankAccountId, null));
    const syncWith = (
      planFingerprint: string | undefined,
      selection?: { importKeys: string[]; excludeKeys: string[] },
    ) =>
      asAlice(() =>
        bankSync.syncAccount(
          aliceId,
          bankAccountId,
          null,
          planFingerprint,
          selection,
        ),
      );
    const removeExceptions = (keys: string[], as = aliceId) =>
      withUserContext(as, () =>
        bankSync.removeExceptions(as, bankAccountId, keys),
      );

    const ledgerRows = () =>
      query<{
        external_key: string;
        transaction_id: string | null;
        excluded: boolean;
      }>(
        `SELECT external_key, transaction_id, (excluded_at IS NOT NULL) AS excluded
           FROM bank_sync_imported_transactions ORDER BY external_key`,
      );
    const storedPayees = async () =>
      (
        await query<{ payee_name: string }>(
          `SELECT payee_name FROM transactions ORDER BY payee_name`,
        )
      ).map((t) => t.payee_name);
    const needsPreview = async () =>
      (await asAlice(() => connections.list(aliceId)))[0].accounts[0]
        .needsPreview;
    const KEYS = ["ref:r1", "ref:r2", "ref:r3", "ref:r4"];

    describe("selection and exceptions", () => {
      it("a partial import imports exactly the selected keys, and moves the balance by exactly their sum", async () => {
        const view = await preview();

        const result = await syncWith(view.planFingerprint, {
          importKeys: ["ref:r2", "ref:r4"],
          excludeKeys: [],
        });

        expect(result).toMatchObject({ imported: 2, excluded: 0 });
        expect(await storedPayees()).toEqual(["Biedronka", "Employer"]);
        expect(await storedBalance()).toBe(OPENING + 1200.1234 - 0.0025);
        expect(await storedBalance()).toBe(await ledgerBalance());
        // Only the imported rows are in the ledger: the rest stay new.
        expect((await ledgerRows()).map((l) => l.external_key)).toEqual([
          "ref:r2",
          "ref:r4",
        ]);
        const next = await preview();
        expect(next.rows.map((r) => r.outcome)).toEqual([
          "new",
          "duplicate",
          "new",
          "duplicate",
        ]);
      });

      it("exceptions are written with excluded_at and no transaction, and imports and exceptions commit together", async () => {
        const view = await preview();

        const result = await syncWith(view.planFingerprint, {
          importKeys: ["ref:r1"],
          excludeKeys: ["ref:r2", "ref:r3"],
        });

        expect(result).toMatchObject({ imported: 1, skipped: 0, excluded: 2 });
        expect(await ledgerRows()).toEqual([
          {
            external_key: "ref:r1",
            transaction_id: expect.any(String),
            excluded: false,
          },
          { external_key: "ref:r2", transaction_id: null, excluded: true },
          { external_key: "ref:r3", transaction_id: null, excluded: true },
        ]);
        expect(await count("transactions")).toBe(1);
        expect(await storedBalance()).toBe(OPENING - 50);
      });

      it("exclude, then sync again: the exception is not imported, in a plain sync or a daily one", async () => {
        const view = await preview();
        await syncWith(view.planFingerprint, {
          importKeys: ["ref:r1", "ref:r2", "ref:r3"],
          excludeKeys: ["ref:r4"],
        });
        expect(await count("transactions")).toBe(3);

        // No selection at all: "import every new row" finds nothing new.
        await expect(sync()).resolves.toMatchObject({
          imported: 0,
          skipped: 4,
        });
        expect(await count("transactions")).toBe(3);
        expect(await storedBalance()).toBe(OPENING - 50 + 1200.1234 - 12.3457);
      });

      it("lists an exception as `excluded`, apart from `duplicate`, and leaves it out of the new rows and the fingerprint", async () => {
        const first = await preview();
        await syncWith(first.planFingerprint, {
          importKeys: ["ref:r1"],
          excludeKeys: ["ref:r2"],
        });

        const view = await preview();

        expect(view.rows.map((r) => [r.externalKey, r.outcome])).toEqual([
          ["ref:r1", "duplicate"],
          ["ref:r2", "excluded"],
          ["ref:r3", "new"],
          ["ref:r4", "new"],
        ]);
        expect(view.summary).toMatchObject({
          new: 2,
          duplicate: 1,
          excluded: 1,
        });
        expect(view.balanceAfter).toBe(
          (OPENING - 50 - 12.3457 - 0.0025).toFixed(4),
        );
      });

      it("remove the exception: the row is new again, and importing it works", async () => {
        const first = await preview();
        await syncWith(first.planFingerprint, {
          importKeys: [],
          excludeKeys: ["ref:r1", "ref:r2"],
        });
        expect(await count("transactions")).toBe(0);
        expect((await ledgerRows()).every((l) => l.excluded)).toBe(true);

        await expect(removeExceptions(["ref:r1"])).resolves.toEqual({
          removed: 1,
        });

        const view = await preview();
        expect(view.rows.map((r) => r.outcome)).toEqual([
          "new",
          "excluded",
          "new",
          "new",
        ]);
        await expect(
          syncWith(view.planFingerprint, {
            importKeys: ["ref:r1"],
            excludeKeys: [],
          }),
        ).resolves.toMatchObject({ imported: 1 });
        expect(await storedPayees()).toEqual(["Biedronka"]);
      });

      it("removing exceptions touches nothing but exceptions: an imported row's ledger entry stays, and so does its transaction", async () => {
        await sync();
        const before = await ledgerRows();

        await expect(removeExceptions(KEYS)).resolves.toEqual({ removed: 0 });

        expect(await ledgerRows()).toEqual(before);
        expect(await count("transactions")).toBe(4);
        // A deleted transaction keeps its ledger row and is still no exception.
        await db.query(`DELETE FROM transactions WHERE amount = -50`);
        await expect(removeExceptions(["ref:r1"])).resolves.toEqual({
          removed: 0,
        });
        expect(await count("bank_sync_imported_transactions")).toBe(4);
        await expect(sync()).resolves.toMatchObject({
          imported: 0,
          skipped: 4,
        });
      });

      it("refuses a key outside the plan with 400, and nothing is written", async () => {
        const view = await preview();
        const before = {
          ledger: await count("bank_sync_imported_transactions"),
          transactions: await count("transactions"),
          balance: await storedBalance(),
        };

        for (const selection of [
          { importKeys: ["ref:r1", "ref:nope"], excludeKeys: [] },
          { importKeys: [], excludeKeys: ["ref:nope"] },
        ]) {
          await expect(
            syncWith(view.planFingerprint, selection),
          ).rejects.toMatchObject({ status: 400 });
        }

        expect(await count("bank_sync_imported_transactions")).toBe(
          before.ledger,
        );
        expect(await count("transactions")).toBe(before.transactions);
        expect(await storedBalance()).toBe(before.balance);
        // Nothing was attempted, so no failed sync is recorded.
        expect(
          (
            await query<{ last_sync_status: string | null }>(
              `SELECT last_sync_status FROM bank_sync_accounts`,
            )
          )[0].last_sync_status,
        ).toBeNull();
      });

      it("refuses a key that is already in the ledger, or in both lists", async () => {
        await sync();
        bankReturns([
          ...BANK_ROWS,
          row({
            entryReference: "r5",
            amount: "9.99",
            bookingDate: daysAgo(1),
          }),
        ]);
        const view = await preview();

        await expect(
          syncWith(view.planFingerprint, {
            importKeys: ["ref:r1"],
            excludeKeys: [],
          }),
        ).rejects.toMatchObject({ status: 400 });
        await expect(
          syncWith(view.planFingerprint, {
            importKeys: ["ref:r5"],
            excludeKeys: ["ref:r5"],
          }),
        ).rejects.toMatchObject({ status: 400 });
        expect(await count("transactions")).toBe(4);
      });

      it("still enforces the fingerprint of the whole plan: a changed bank answer is a 409 and writes nothing", async () => {
        const view = await preview();
        bankReturns([
          ...BANK_ROWS,
          row({
            entryReference: "late",
            amount: "7.00",
            bookingDate: daysAgo(1),
          }),
        ]);

        await expect(
          syncWith(view.planFingerprint, {
            importKeys: ["ref:r1"],
            excludeKeys: ["ref:r2"],
          }),
        ).rejects.toMatchObject({ status: 409 });

        expect(await count("bank_sync_imported_transactions")).toBe(0);
        expect(await count("transactions")).toBe(0);
      });

      it("still enforces the fingerprint when another sync imported rows in between", async () => {
        const view = await preview();
        await sync();
        await expect(
          syncWith(view.planFingerprint, {
            importKeys: ["ref:r1"],
            excludeKeys: [],
          }),
        ).rejects.toMatchObject({ status: 409 });
        expect(await count("transactions")).toBe(4);
      });

      it("without a selection every new row is imported, as before", async () => {
        const view = await preview();
        await expect(syncWith(view.planFingerprint)).resolves.toMatchObject({
          imported: 4,
          excluded: 0,
        });
      });

      it("an empty selection imports nothing and writes nothing", async () => {
        const view = await preview();
        await expect(
          syncWith(view.planFingerprint, { importKeys: [], excludeKeys: [] }),
        ).resolves.toMatchObject({ imported: 0, excluded: 0 });
        expect(await count("transactions")).toBe(0);
        expect(await count("bank_sync_imported_transactions")).toBe(0);
        expect(await storedBalance()).toBe(OPENING);
      });

      it("rows skipped for now stay in the window of the next sync: last_success_at does not move, so they are shown again", async () => {
        expect(await needsPreview()).toBe(true);
        const view = await preview();

        await syncWith(view.planFingerprint, {
          importKeys: ["ref:r1"],
          excludeKeys: [],
        });

        // Still unconfirmed: three rows are neither imported nor excepted.
        expect(await needsPreview()).toBe(true);
        const next = await preview();
        expect(next.summary).toMatchObject({ new: 3, duplicate: 1 });

        // Resolving every row (here: excepting the rest) confirms the account.
        await syncWith(next.planFingerprint, {
          importKeys: [],
          excludeKeys: ["ref:r2", "ref:r3", "ref:r4"],
        });
        expect(await needsPreview()).toBe(false);
      });

      it("removing an exception is the owner's alone and needs a linked bank account", async () => {
        const view = await preview();
        await syncWith(view.planFingerprint, {
          importKeys: [],
          excludeKeys: ["ref:r1"],
        });

        await expect(removeExceptions(["ref:r1"], bobId)).rejects.toMatchObject(
          {
            status: 404,
          },
        );
        expect((await ledgerRows())[0].excluded).toBe(true);

        await asAlice(() =>
          bankSync.linkAccount(aliceId, bankAccountId, { accountId: null }),
        );
        await expect(removeExceptions(["ref:r1"])).rejects.toMatchObject({
          status: 409,
        });
        expect((await ledgerRows())[0].excluded).toBe(true);
      });

      it("two exceptions of the same key written at once converge on one ledger row", async () => {
        const view = await preview();
        const selection = { importKeys: [], excludeKeys: ["ref:r1"] };
        const results = await Promise.allSettled([
          syncWith(view.planFingerprint, selection),
          syncWith(view.planFingerprint, selection),
        ]);
        // One is turned away by the lease or by the fingerprint/keys check; the
        // ledger holds the exception exactly once either way.
        expect(results.some((r) => r.status === "fulfilled")).toBe(true);
        expect(await ledgerRows()).toEqual([
          { external_key: "ref:r1", transaction_id: null, excluded: true },
        ]);
      });
    });

    describe("the operation type as a tag", () => {
      const OP_ROWS: BankTransaction[] = [
        row({
          entryReference: "o1",
          amount: "10.00",
          counterpartyName: "Cafe",
          remittance: ["Latte CARD-PAYMENT"],
          operation: {
            code: null,
            subCode: null,
            description: null,
            remittanceCode: "CARD-PAYMENT",
          },
        }),
        row({
          entryReference: "o2",
          amount: "20.00",
          counterpartyName: "Cinema",
          remittance: ["Tickets CARD-PAYMENT"],
          operation: {
            code: null,
            subCode: null,
            description: null,
            remittanceCode: "CARD-PAYMENT",
          },
        }),
        row({
          entryReference: "o3",
          amount: "300.00",
          direction: "credit",
          counterpartyName: "Employer",
          remittance: ["Salary TRANSFER-IN"],
          operation: {
            code: null,
            subCode: null,
            description: null,
            remittanceCode: "TRANSFER-IN",
          },
        }),
        row({
          entryReference: "o4",
          amount: "5.00",
          counterpartyName: "Bank",
          remittance: ["Fee"],
          operation: {
            code: "DIRECT-DEBIT",
            subCode: null,
            description: null,
            remittanceCode: null,
          },
        }),
        row({
          entryReference: "o5",
          amount: "1.00",
          counterpartyName: "Plain",
        }),
      ];

      const tagsOf = async () =>
        (
          await query<{ payee_name: string; tag: string }>(
            `SELECT t.payee_name, tg.name AS tag
               FROM transactions t
               JOIN transaction_tags tt ON tt.transaction_id = t.id
               JOIN tags tg ON tg.id = tt.tag_id
              ORDER BY t.payee_name, tg.name`,
          )
        ).map((r) => [r.payee_name, r.tag]);

      // The integration schema is synchronized from the entities, which do not
      // declare the case-insensitive unique name that `database/schema.sql` has
      // (`idx_tags_user_name`). It is what makes two creations of one tag
      // converge in production, so the tag tests run with it.
      beforeAll(async () => {
        await db.query(
          `CREATE UNIQUE INDEX IF NOT EXISTS idx_tags_user_name
             ON tags (user_id, LOWER(name))`,
        );
      });
      afterAll(async () => {
        await db.query(`DROP INDEX IF EXISTS idx_tags_user_name`);
      });

      beforeEach(() => bankReturns(OP_ROWS));

      it("creates the missing tags, attaches them in the sync's own transaction, and leaves the description alone", async () => {
        await sync();

        expect(await tagsOf()).toEqual(
          [
            ["Cafe", "Card payment"],
            ["Cinema", "Card payment"],
            ["Bank", "DIRECT-DEBIT"],
            ["Employer", "Incoming transfer"],
          ].sort((a, b) => (a[0] < b[0] ? -1 : 1)),
        );
        // One tag per name, however many rows carry it.
        expect(await count("tags")).toBe(3);
        const descriptions = await query<{ description: string }>(
          `SELECT description FROM transactions WHERE payee_name = 'Cafe'`,
        );
        expect(descriptions[0].description).toBe("Latte CARD-PAYMENT");
      });

      it("names the tags by the institution's profile: a bank with none gets its codes as they are, a known generic code still translated", async () => {
        await query(
          `UPDATE bank_sync_connections SET institution_name = 'Test Bank'`,
        );
        await sync();

        expect(await tagsOf()).toEqual(
          [
            ["Cafe", "CARD-PAYMENT"],
            ["Cinema", "CARD-PAYMENT"],
            ["Bank", "DIRECT-DEBIT"],
            ["Employer", "Incoming transfer"],
          ].sort((a, b) => (a[0] < b[0] ? -1 : 1)),
        );
      });

      it("reuses the user's own tag whatever its case, and adds no second one", async () => {
        const [existing] = await query<{ id: string }>(
          `INSERT INTO tags (user_id, name) VALUES ($1, 'CARD PAYMENT') RETURNING id`,
          [aliceId],
        );
        await sync();
        expect(await count("tags")).toBe(3);
        const tagged = await query<{ tag_id: string }>(
          `SELECT DISTINCT tag_id FROM transaction_tags
             WHERE tag_id = $1`,
          [existing.id],
        );
        expect(tagged).toHaveLength(1);
      });

      it("tags nothing and creates no tag when the connection turns it off", async () => {
        const view = await asAlice(() =>
          connections.updateConnection(aliceId, connectionId, {
            tagOperationType: false,
          }),
        );
        expect(view.tagOperationType).toBe(false);

        await sync();

        expect(await count("tags")).toBe(0);
        expect(await count("transaction_tags")).toBe(0);
        expect(await count("transactions")).toBe(5);
      });

      it("is on by default, and the setting survives an update of another field", async () => {
        const [view] = await asAlice(() => connections.list(aliceId));
        expect(view.tagOperationType).toBe(true);
        const updated = await asAlice(() =>
          connections.updateConnection(aliceId, connectionId, {
            autoSync: false,
          }),
        );
        expect(updated.tagOperationType).toBe(true);
        expect(updated.autoSync).toBe(false);
      });

      it("attaches the tag BEFORE the import rules run, so a rule can use it", async () => {
        const [tag] = await query<{ id: string }>(
          `INSERT INTO tags (user_id, name) VALUES ($1, 'Card payment') RETURNING id`,
          [aliceId],
        );
        const food = await createTestCategory(db, aliceId, { name: "Food" });
        await asAlice(() =>
          rules.create(aliceId, {
            name: "Card payments",
            triggers: ["import"],
            condition: { field: "tagIds", op: "hasAny", value: [tag.id] },
            actions: [{ type: "set_category", categoryId: food.id }],
          } as CreateTransactionRuleDto),
        );

        await sync();

        const stored = await query<{
          payee_name: string;
          category_id: string | null;
        }>(
          `SELECT payee_name, category_id FROM transactions ORDER BY payee_name`,
        );
        expect(stored.map((t) => [t.payee_name, t.category_id])).toEqual([
          ["Bank", null],
          ["Cafe", food.id],
          ["Cinema", food.id],
          ["Employer", null],
          ["Plain", null],
        ]);
      });

      it("rolls the tags back with the rest when the write fails", async () => {
        const failing = jest
          .spyOn(module.get(AccountsService), "recalculateCurrentBalance")
          .mockRejectedValue(new Error("balance failed"));
        await expect(sync()).rejects.toThrow("balance failed");
        failing.mockRestore();

        expect(await count("tags")).toBe(0);
        expect(await count("transaction_tags")).toBe(0);
        expect(await count("transactions")).toBe(0);
        expect(await count("bank_sync_imported_transactions")).toBe(0);
      });

      it("two syncs of two accounts meeting the same new tag converge on one tag", async () => {
        const second = await createTestAccount(db, aliceId, {
          name: "Second",
          currencyCode: "PLN",
          openingBalance: 0,
          currentBalance: 0,
        });
        const other = await seedBank(aliceId, second.id, {
          hash: "h-2",
          external: "e-2",
        });
        const plan = (rows: BankTransaction[]) =>
          planBankImport(rows, {
            accountCurrencyCode: "PLN",
            syncFromDate: daysAgo(30),
            today,
          });
        const write = (
          bank: string,
          account: string,
          rows: BankTransaction[],
        ) =>
          asAlice(() =>
            writer.write({
              userId: aliceId,
              bankAccountId: bank,
              accountId: account,
              plannedSyncFromDate: daysAgo(30),
              plannedCurrencyCode: "PLN",
              plan: plan(rows),
              balance: null,
              tagOperationType: true,
              profile: PKO_BP,
            }),
          );

        const results = await Promise.all([
          write(bankAccountId, accountId, [OP_ROWS[0]]),
          write(other.bankAccountId, second.id, [OP_ROWS[1]]),
        ]);

        expect(results.map((r) => r.imported)).toEqual([1, 1]);
        expect(await count("tags")).toBe(1);
        expect(await count("transaction_tags")).toBe(2);
      });
    });

    describe("the preview's details", () => {
      it("shows the tag it would add, and creates nothing", async () => {
        bankReturns([
          row({
            entryReference: "o1",
            remittance: ["Latte CARD-PAYMENT"],
            operation: {
              code: null,
              subCode: null,
              description: null,
              remittanceCode: "CARD-PAYMENT",
            },
          }),
        ]);
        const view = await preview();
        expect(view.rows[0]).toMatchObject({
          operationTag: "Card payment",
          tagNames: ["Card payment"],
        });
        expect(await count("tags")).toBe(0);
        expect(await count("bank_sync_imported_transactions")).toBe(0);
      });

      it("shows no tag when the connection does not tag", async () => {
        await asAlice(() =>
          connections.updateConnection(aliceId, connectionId, {
            tagOperationType: false,
          }),
        );
        bankReturns([
          row({
            entryReference: "o1",
            operation: {
              code: null,
              subCode: null,
              description: null,
              remittanceCode: "CARD-PAYMENT",
            },
          }),
        ]);
        const view = await preview();
        expect(view.rows[0].operationTag).toBeNull();
        expect(view.rows[0].tagNames).toEqual([]);
      });

      it("says how each payee resolves: name, alias with its pattern, new, and a rule", async () => {
        const [named] = await query<{ id: string }>(
          `INSERT INTO payees (user_id, name) VALUES ($1, 'Biedronka') RETURNING id`,
          [aliceId],
        );
        const [aliased] = await query<{ id: string }>(
          `INSERT INTO payees (user_id, name) VALUES ($1, 'Employer Ltd') RETURNING id`,
          [aliceId],
        );
        await db.query(
          `INSERT INTO payee_aliases (user_id, payee_id, alias) VALUES ($1, $2, 'EMPLOYER*')`,
          [aliceId, aliased.id],
        );
        const ruled = await query<{ id: string }>(
          `INSERT INTO payees (user_id, name) VALUES ($1, 'Kiosk Ruch') RETURNING id`,
          [aliceId],
        );
        await asAlice(() =>
          rules.create(aliceId, {
            name: "Kiosk",
            triggers: ["import"],
            condition: { field: "payeeText", op: "contains", value: "kiosk" },
            actions: [{ type: "set_payee", payeeId: ruled[0].id }],
          } as CreateTransactionRuleDto),
        );
        bankReturns(
          [
            ...BANK_ROWS.slice(0, 3),
            row({
              entryReference: "r9",
              counterpartyName: "Brand New Shop",
              amount: "3.00",
            }),
            row({
              entryReference: "r10",
              counterpartyName: null,
              remittance: [],
              amount: "4.00",
            }),
          ].map((r) =>
            r.entryReference === "r2"
              ? { ...r, counterpartyName: "EMPLOYER 123" }
              : r,
          ),
        );

        const view = await preview();
        const payeeOf = (key: string) =>
          view.rows.find((r) => r.externalKey === key)?.payee;

        expect(payeeOf("ref:r1")).toEqual({
          original: "Biedronka",
          name: "Biedronka",
          via: "name",
          aliasPattern: null,
          payeeId: named.id,
        });
        expect(payeeOf("ref:r2")).toEqual({
          original: "EMPLOYER 123",
          name: "Employer Ltd",
          via: "alias",
          aliasPattern: "EMPLOYER*",
          payeeId: aliased.id,
        });
        expect(payeeOf("ref:r3")).toEqual({
          original: "Kiosk",
          name: "Kiosk Ruch",
          via: "rule",
          aliasPattern: null,
          payeeId: ruled[0].id,
        });
        expect(payeeOf("ref:r9")).toEqual({
          original: "Brand New Shop",
          name: "Brand New Shop",
          via: "new",
          aliasPattern: null,
          payeeId: null,
        });
        expect(payeeOf("ref:r10")).toMatchObject({ via: "none", name: null });
        expect(await count("payees")).toBe(3);
      });

      it("lists the matched rules by name with what they changed, and names the ids", async () => {
        const groceries = await createTestCategory(db, aliceId, {
          name: "Groceries",
        });
        const [tag] = await query<{ id: string }>(
          `INSERT INTO tags (user_id, name) VALUES ($1, 'Weekly') RETURNING id`,
          [aliceId],
        );
        const created = await asAlice(() =>
          rules.create(aliceId, {
            name: "Biedronka groceries",
            triggers: ["import"],
            condition: {
              field: "payeeText",
              op: "contains",
              value: "biedronka",
            },
            actions: [
              { type: "set_category", categoryId: groceries.id },
              { type: "add_tags", tagIds: [tag.id] },
            ],
          } as CreateTransactionRuleDto),
        );
        await asAlice(() =>
          rules.create(aliceId, {
            name: "Never matches",
            triggers: ["import"],
            condition: { field: "payeeText", op: "contains", value: "zzzz" },
            actions: [{ type: "set_category", categoryId: groceries.id }],
          } as CreateTransactionRuleDto),
        );

        const view = await preview();

        const first = view.rows.find((r) => r.externalKey === "ref:r1");
        expect(first?.rules).toHaveLength(1);
        expect(first?.rules[0]).toMatchObject({
          ruleId: created.id,
          ruleName: "Biedronka groceries",
          stopped: false,
          skipped: [],
        });
        expect(first?.rules[0].applied.map((a) => a.type)).toEqual([
          "set_category",
          "add_tags",
        ]);
        expect(first?.rules[0].changes).toMatchObject({
          categoryId: { before: null, after: groceries.id },
          tagIds: { before: [], after: [tag.id] },
        });
        expect(view.labels.categories[groceries.id]).toBe("Groceries");
        expect(view.labels.tags[tag.id]).toBe("Weekly");
        expect(first).toMatchObject({
          categoryName: "Groceries",
          tagNames: ["Weekly"],
        });
        // A row no rule matched has no trace, and nothing was written.
        expect(
          view.rows.find((r) => r.externalKey === "ref:r2")?.rules,
        ).toEqual([]);
        expect(await count("transaction_rule_applications")).toBe(0);
        expect(await count("transaction_tags")).toBe(0);
      });

      it("returns no field of the provider's own besides the operation type", async () => {
        const view = await preview();
        const serialized = JSON.stringify(view);
        expect(serialized).not.toMatch(
          /creditorName|debtorName|merchantCategoryCode|"raw"/,
        );
      });
    });
  });

  describe("the cut-off a link would default to", () => {
    it("is the day after the newest transaction, and is what linking uses", async () => {
      const target = await createTestAccount(db, aliceId, {
        name: "Has history",
        currencyCode: "PLN",
      });
      await db.query(
        `INSERT INTO transactions (user_id, account_id, transaction_date, amount, currency_code, status)
         VALUES ($1, $2, $3, -5, 'PLN', 'CLEARED'),
                ($1, $2, $4, -7, 'PLN', 'VOID')`,
        [aliceId, target.id, daysAgo(10), daysAgo(2)],
      );
      const free = await seedBank(aliceId, null, {
        hash: "h-d",
        external: "e-d",
      });

      const shown = await asAlice(() =>
        bankSync.linkDefaults(aliceId, free.bankAccountId, target.id),
      );
      const linked = await asAlice(() =>
        bankSync.linkAccount(aliceId, free.bankAccountId, {
          accountId: target.id,
        }),
      );

      expect(shown).toEqual({
        newestTransactionDate: daysAgo(10),
        defaultSyncFromDate: daysAgo(9),
      });
      expect(linked.syncFromDate).toBe(shown.defaultSyncFromDate);
    });

    it("is the lookback window with no newest transaction for an empty account", async () => {
      const empty = await createTestAccount(db, aliceId, {
        name: "Empty",
        currencyCode: "PLN",
      });
      const free = await seedBank(aliceId, null, {
        hash: "h-e",
        external: "e-e",
      });
      await expect(
        asAlice(() =>
          bankSync.linkDefaults(aliceId, free.bankAccountId, empty.id),
        ),
      ).resolves.toEqual({
        newestTransactionDate: null,
        defaultSyncFromDate: daysAgo(89),
      });
    });

    it("refuses another user's bank account and another user's account", async () => {
      await expect(
        asBob(() => bankSync.linkDefaults(bobId, bankAccountId, accountId)),
      ).rejects.toMatchObject({ status: 404 });
      const bobAccount = await createTestAccount(db, bobId, {
        name: "Bob",
        currencyCode: "PLN",
      });
      await expect(
        asAlice(() =>
          bankSync.linkDefaults(aliceId, bankAccountId, bobAccount.id),
        ),
      ).rejects.toMatchObject({ status: 400 });
    });
  });

  describe("matching bank accounts to accounts by number (spec section 5a)", () => {
    const IBAN = "PL61109010140000071219812874";
    const NRB = "61 1090 1014 0000 0712 1981 2874";
    let freeConnectionId: string;
    let freeBankId: string;
    let target: { id: string };

    const identify = (
      bankId: string,
      identifier: string | null,
      type: string | null = "CACC",
    ) =>
      db.query(
        `UPDATE bank_sync_accounts
            SET account_identifier = $2, cash_account_type = $3 WHERE id = $1`,
        [bankId, identifier, type],
      );

    const monizeAccount = async (
      name: string,
      number: string | null,
      userId = aliceId,
    ) => {
      const created = await createTestAccount(db, userId, {
        name,
        currencyCode: "PLN",
      });
      await db.query(`UPDATE accounts SET account_number = $2 WHERE id = $1`, [
        created.id,
        number,
      ]);
      return created;
    };

    beforeEach(async () => {
      ({ connectionId: freeConnectionId, bankAccountId: freeBankId } =
        await seedBank(aliceId, null, { hash: "h-m", external: "e-m" }));
      await identify(freeBankId, IBAN);
      target = await monizeAccount("Everyday", NRB);
    });

    const match = () =>
      asAlice(() => connections.matchAccounts(aliceId, freeConnectionId, null));
    const linkOf = async (bankId: string) =>
      (
        await query<{
          account_id: string | null;
          sync_from_date: string | null;
        }>(
          `SELECT account_id, TO_CHAR(sync_from_date, 'YYYY-MM-DD') AS sync_from_date
             FROM bank_sync_accounts WHERE id = $1`,
          [bankId],
        )
      )[0];

    it("auto-links the one account whose NRB is the IBAN without its prefix, with the default cut-off", async () => {
      const answer = await match();

      expect(answer.linked).toEqual([
        { bankAccountId: freeBankId, accountId: target.id },
      ]);
      expect(answer.suggestions).toEqual([]);
      expect(await linkOf(freeBankId)).toEqual({
        account_id: target.id,
        sync_from_date: daysAgo(89),
      });
      expect(
        answer.connection.accounts.find((a) => a.id === freeBankId),
      ).toMatchObject({ accountId: target.id, needsPreview: true });
    });

    it("links across the callback: a session that lists the identifier links the account after the activation", async () => {
      await asAlice(() =>
        credentials.save(aliceId, { applicationId: "app-1", privateKey: PEM }),
      );
      let state = "";
      jest.spyOn(provider, "listInstitutions").mockResolvedValue([
        {
          name: "Test Bank",
          country: "PL",
          logoUrl: null,
          psuTypes: ["personal"],
          maximumConsentValiditySeconds: 90 * 24 * 3600,
        },
      ]);
      jest
        .spyOn(provider, "startAuthorization")
        .mockImplementation(async (_c, input) => {
          state = input.state;
          return { url: "https://bank.example/auth" };
        });
      jest.spyOn(provider, "completeAuthorization").mockResolvedValue({
        sessionId: "session-77",
        validUntil: new Date(Date.now() + 80 * 24 * 3600 * 1000),
        accounts: [
          {
            externalAccountId: "ext-card",
            identificationHash: "hash-card",
            displayName: null,
            identifierMasked: "**** 2743",
            accountIdentifier: "5276000000002743",
            cashAccountType: "CARD",
            currencyCode: "PLN",
          },
          {
            externalAccountId: "ext-main",
            identificationHash: "hash-main",
            displayName: null,
            identifierMasked: "**** 2874",
            accountIdentifier: IBAN,
            cashAccountType: "CACC",
            currencyCode: "PLN",
          },
        ],
      });
      await asAlice(() =>
        connections.start(aliceId, {
          institutionName: "Test Bank",
          country: "PL",
          psuType: "personal",
        }),
      );

      const answer = await asAlice(() =>
        connections.completeCallback(aliceId, { state, code: "code-1" }),
      );

      expect(answer.linked).toHaveLength(1);
      expect(answer.linked[0].accountId).toBe(target.id);
      const accounts = answer.connection.accounts;
      expect(
        accounts.find((a) => a.id === answer.linked[0].bankAccountId),
      ).toMatchObject({
        cashAccountType: "CACC",
        accountId: target.id,
        syncFromDate: daysAgo(89),
      });
      // The card account has no Monize account with its number: it stays unlinked.
      expect(accounts.find((a) => a.cashAccountType === "CARD")).toMatchObject({
        accountId: null,
      });
      expect(answer.suggestions).toEqual([]);
      // The identifier is stored for later matching.
      const [stored] = await query<{ account_identifier: string }>(
        `SELECT account_identifier FROM bank_sync_accounts
          WHERE external_account_id = 'ext-card'`,
      );
      expect(stored.account_identifier).toBe("5276000000002743");
      expect(
        accounts.find((a) => a.cashAccountType === "CARD")?.accountIdentifier,
      ).toBe("5276000000002743");
    });

    it("links nothing and suggests both when two accounts carry the number", async () => {
      const twin = await monizeAccount("Twin", IBAN);

      const answer = await match();

      expect(answer.linked).toEqual([]);
      expect(answer.suggestions).toEqual([
        {
          bankAccountId: freeBankId,
          accountIds: expect.arrayContaining([target.id, twin.id]),
        },
      ]);
      expect((await linkOf(freeBankId)).account_id).toBeNull();
    });

    it("does not offer a closed account, another currency, another user's account or one linked elsewhere", async () => {
      await db.query(`UPDATE accounts SET is_closed = true WHERE id = $1`, [
        target.id,
      ]);
      const euro = await monizeAccount("Euro", NRB);
      await db.query(
        `UPDATE accounts SET currency_code = 'EUR' WHERE id = $1`,
        [euro.id],
      );
      await monizeAccount("Bob", NRB, bobId);

      await expect(match()).resolves.toMatchObject({
        linked: [],
        suggestions: [],
      });

      // Reopen it, but link it to another bank account first.
      await db.query(`UPDATE accounts SET is_closed = false WHERE id = $1`, [
        target.id,
      ]);
      await seedBank(aliceId, target.id, { hash: "h-n", external: "e-n" });
      await expect(match()).resolves.toMatchObject({
        linked: [],
        suggestions: [],
      });
    });

    it("reads a bank account's details from the provider when it has no identifier yet, then links", async () => {
      await asAlice(() =>
        credentials.save(aliceId, { applicationId: "app-1", privateKey: PEM }),
      );
      await identify(freeBankId, null, null);
      const details = jest
        .spyOn(provider, "fetchAccountDetails")
        .mockResolvedValue({
          externalAccountId: "e-m",
          identificationHash: "h-m",
          displayName: null,
          identifierMasked: "**** 2874",
          accountIdentifier: IBAN,
          cashAccountType: "CACC",
          currencyCode: "PLN",
        });

      const answer = await asAlice(() =>
        connections.matchAccounts(aliceId, freeConnectionId, {
          ipAddress: "203.0.113.4",
          userAgent: "UA",
        }),
      );

      expect(details).toHaveBeenCalledWith(
        expect.objectContaining({ applicationId: "app-1" }),
        "e-m",
        { ipAddress: "203.0.113.4", userAgent: "UA" },
      );
      expect(answer.linked).toHaveLength(1);
      const [stored] = await query<{
        account_identifier: string;
        cash_account_type: string;
      }>(
        `SELECT account_identifier, cash_account_type FROM bank_sync_accounts WHERE id = $1`,
        [freeBankId],
      );
      expect(stored).toEqual({
        account_identifier: IBAN,
        cash_account_type: "CACC",
      });
    });

    it("is the caller's alone", async () => {
      await expect(
        asBob(() => connections.matchAccounts(bobId, freeConnectionId, null)),
      ).rejects.toMatchObject({ status: 404 });
    });
  });

  describe("the private key never leaves the server (INV-BANKSYNC-002)", () => {
    it("is stored encrypted and reported only as privateKeySet", async () => {
      const pem = PEM;

      const saved = await asAlice(() =>
        credentials.save(aliceId, { applicationId: "app-1", privateKey: pem }),
      );
      const status = await asAlice(() => credentials.getStatus(aliceId));
      const connectionList = await asAlice(() => connections.list(aliceId));

      for (const response of [saved, status, connectionList]) {
        const text = JSON.stringify(response);
        expect(text).not.toContain("PRIVATE KEY");
        expect(text).not.toMatch(/privateKeyEnc|private_key_enc/);
      }
      expect(saved.credentials).toEqual({
        provider: "enable_banking",
        applicationId: "app-1",
        privateKeySet: true,
      });
      const [stored] = await query<{ private_key_enc: string }>(
        `SELECT private_key_enc FROM bank_sync_credentials WHERE user_id = $1`,
        [aliceId],
      );
      expect(stored.private_key_enc).not.toContain("PRIVATE KEY");
      // And it is a key the server can use.
      await expect(
        asAlice(() =>
          credentials.resolveCredentials(aliceId, "enable_banking"),
        ),
      ).resolves.toEqual({ applicationId: "app-1", privateKeyPem: pem.trim() });
    });

    it("keeps the stored key when a save omits it, and never reads another user's row", async () => {
      const pem = PEM;
      await asAlice(() =>
        credentials.save(aliceId, { applicationId: "app-1", privateKey: pem }),
      );
      await asAlice(() =>
        credentials.save(aliceId, { applicationId: "app-2" }),
      );
      await expect(
        asAlice(() =>
          credentials.resolveCredentials(aliceId, "enable_banking"),
        ),
      ).resolves.toEqual({ applicationId: "app-2", privateKeyPem: pem.trim() });
      await expect(
        asBob(() => credentials.getStatus(bobId)),
      ).resolves.toMatchObject({ credentials: null });
    });
  });

  /**
   * Poll until `expected` backends in this database are parked on a lock. The
   * second insert is guaranteed to park on the first transaction's index entry,
   * so this always resolves; the attempt cap is a safety net against a wiring
   * mistake, never the timing source.
   */
  async function waitForBlockedBackends(expected: number): Promise<void> {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const rows = await query<{ c: number }>(
        `SELECT count(*)::int AS c
           FROM pg_stat_activity
          WHERE datname = current_database()
            AND state = 'active'
            AND wait_event_type = 'Lock'`,
      );
      if (rows[0].c >= expected) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(
      `Timed out waiting for ${expected} lock-blocked backend(s); the race was ` +
        "never set up, so the test would prove nothing.",
    );
  }
});
