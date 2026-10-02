import { generateKeyPairSync } from "node:crypto";
import { TestingModule } from "@nestjs/testing";
import { DataSource } from "typeorm";

import { withUserContext } from "@/common/db/with-context";
import { JobClaimService, JobClaimType } from "@/common/jobs/job-claim.service";
import { BankSyncConnectionsService } from "@/bank-sync/bank-sync-connections.service";
import { BankSyncConsentReminderService } from "@/bank-sync/bank-sync-consent-reminder.service";
import { BankSyncCredentialsService } from "@/bank-sync/bank-sync-credentials.service";
import { BankSyncCronService } from "@/bank-sync/bank-sync-cron.service";
import { BankSyncModule } from "@/bank-sync/bank-sync.module";
import { BankSyncOutcomeNotifier } from "@/bank-sync/bank-sync-outcome-notifier.service";
import { BankSyncService } from "@/bank-sync/bank-sync.service";
import { BankSyncProviderError } from "@/bank-sync/providers/bank-sync-provider.errors";
import type { BankTransaction } from "@/bank-sync/providers/bank-sync-provider.interface";
import { EnableBankingProvider } from "@/bank-sync/providers/enable-banking/enable-banking.client";

import {
  cleanTables,
  createEnforcedIntegrationModule,
  createTestUserDirect,
  EnforcedIntegrationHarness,
} from "../helpers/integration-setup";
import { createTestAccount } from "../helpers/test-factories";

/**
 * Bank sync notifications against a real PostgreSQL enforcing RLS
 * (docs/specs/bank-sync-notifications.md section 8), with the provider stubbed.
 *
 * What a mock cannot show and these do: that the consent reminders are written
 * once per threshold even when two replicas evaluate at the same instant (the
 * `idx_notifications_dedupe` unique index is the arbiter, so two real
 * evaluations race for real); that a renewal starts new keys; that an ended
 * consent marks the connection `expired` and is told once, whichever of the
 * reminder service and the daily sync saw it first; and that the daily sync
 * does not import a bank account whose first import nobody has confirmed.
 *
 * `synchronize` builds the schema from entities and creates no partial indexes;
 * the enforcement harness brings the database up to the shipped shape through
 * `applyRlsPolicies`, which applies the migrations that create
 * `idx_notifications_dedupe`.
 */
describe("Bank sync notifications (integration)", () => {
  jest.setTimeout(240000);

  let harness: EnforcedIntegrationHarness;
  let module: TestingModule;
  let db: DataSource;
  let reminders: BankSyncConsentReminderService;
  let cron: BankSyncCronService;
  let notifier: BankSyncOutcomeNotifier;
  let bankSync: BankSyncService;
  let connectionsService: BankSyncConnectionsService;
  let credentials: BankSyncCredentialsService;
  let provider: EnableBankingProvider;

  let aliceId: string;
  let bobId: string;

  const PEM = generateKeyPairSync("rsa", { modulusLength: 2048 })
    .privateKey.export({ type: "pkcs8", format: "pem" })
    .toString();
  const END = "2027-03-30T10:00:00.000Z";
  const runAt = (day: string) => new Date(`${day}T06:23:00.000Z`);
  const utcDay = () => new Date().toISOString().slice(0, 10);
  const daysAgo = (days: number) =>
    new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);

  interface NotificationRow {
    user_id: string;
    alert_type: string;
    severity: string;
    dedupe_key: string;
    target: string;
    period_start: string;
    data: Record<string, unknown>;
  }

  const query = <T = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ) => db.query(sql, params) as Promise<T[]>;

  const notifications = (type?: string): Promise<NotificationRow[]> =>
    query<NotificationRow>(
      `SELECT user_id, alert_type, severity, dedupe_key, target,
              TO_CHAR(period_start, 'YYYY-MM-DD') AS period_start, data
         FROM notifications
        WHERE ($1::text IS NULL OR alert_type = $1)
        ORDER BY dedupe_key, user_id`,
      [type ?? null],
    );

  const count = async (table: string): Promise<number> =>
    Number(
      (await query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM ${table}`))[0]
        .n,
    );

  async function seedConnection(
    userId: string,
    over: {
      validUntil?: Date | string | null;
      status?: string;
      notifySuccess?: string;
    } = {},
  ): Promise<string> {
    const [row] = await query<{ id: string }>(
      `INSERT INTO bank_sync_connections
         (user_id, provider, institution_name, institution_country, psu_type,
          status, external_session_id, valid_until, notify_success)
       VALUES ($1, 'enable_banking', 'Test Bank', 'PL', 'personal', $2,
               'session-1', $3, $4)
       RETURNING id`,
      [
        userId,
        over.status ?? "active",
        over.validUntil === undefined ? END : over.validUntil,
        over.notifySuccess ?? "when_imported",
      ],
    );
    return row.id;
  }

  /** Both replicas evaluating at the same instant. */
  const twice = (now: Date) =>
    Promise.all([reminders.evaluate(now), reminders.evaluate(now)]);

  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = "integration-test-encryption-key-0123456789";
    harness = await createEnforcedIntegrationModule([BankSyncModule]);
    module = harness.module;
    db = harness.owner;
    reminders = module.get(BankSyncConsentReminderService);
    cron = module.get(BankSyncCronService);
    notifier = module.get(BankSyncOutcomeNotifier);
    bankSync = module.get(BankSyncService);
    connectionsService = module.get(BankSyncConnectionsService);
    credentials = module.get(BankSyncCredentialsService);
    provider = module.get(EnableBankingProvider);
  });

  afterAll(async () => {
    await harness.close();
    delete process.env.ENCRYPTION_KEY;
  });

  beforeEach(async () => {
    jest.restoreAllMocks();
    await cleanTables(db, [
      "notifications",
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
         ('PLN', 'Zloty', 'zl', 2)
       ON CONFLICT DO NOTHING`,
    );
    aliceId = (await createTestUserDirect(db, { firstName: "Alice" })).id;
    bobId = (await createTestUserDirect(db, { firstName: "Bob" })).id;
  });

  describe("the harness", () => {
    it("is enforcing row-level security and has the dedupe index the producers rely on", async () => {
      const [index] = await query<{ indexdef: string }>(
        `SELECT indexdef FROM pg_indexes WHERE indexname = 'idx_notifications_dedupe'`,
      );
      expect(index?.indexdef).toMatch(/UNIQUE/i);
    });
  });

  describe("consent reminders: one row per threshold", () => {
    it("writes each mark once across two concurrent evaluations on every day, and nothing on the days between", async () => {
      const connectionId = await seedConnection(aliceId);
      const days: string[] = [];
      for (
        let d = new Date("2027-02-27T00:00:00Z");
        d <= new Date("2027-03-30T00:00:00Z");
        d = new Date(d.getTime() + 86_400_000)
      ) {
        days.push(d.toISOString().slice(0, 10));
      }
      expect(days).toHaveLength(32);

      for (const day of days) await twice(runAt(day));

      const rows = await notifications("BANK_SYNC_CONSENT_EXPIRING");
      const marks = [30, 14, 7, 3, 2, 1, 0];
      expect(rows.map((r) => r.dedupe_key).sort()).toEqual(
        marks.map((m) => `bsc:exp:${connectionId}:2027-03-30:${m}`).sort(),
      );
      // Spec section 2: info at 30 and 14, warning from 7 to 1, critical on the last day.
      const severityOf = (mark: number) =>
        rows.find((r) => r.dedupe_key.endsWith(`:${mark}`))?.severity;
      expect(marks.map(severityOf)).toEqual([
        "info",
        "info",
        "warning",
        "warning",
        "warning",
        "warning",
        "critical",
      ]);
      for (const row of rows) {
        expect(row).toMatchObject({
          user_id: aliceId,
          target: "/settings/bank-sync",
        });
        expect(row.data).toMatchObject({
          connectionId,
          institutionName: "Test Bank",
          validUntil: "2027-03-30",
        });
      }
      // Facts only: no "in N days" text in the stored data.
      expect(JSON.stringify(rows.map((r) => r.data))).not.toMatch(
        /days? left|in \d+ days/,
      );
    });

    it("fires one reminder for the latest mark after missed days, never the skipped ones", async () => {
      const connectionId = await seedConnection(aliceId);
      await twice(runAt("2027-03-16")); // 14 days left: the 14-day mark
      // An outage: 7, 3 and 2 days are never evaluated. Next run: 1 day left.
      await twice(runAt("2027-03-29"));

      const keys = (await notifications()).map((r) => r.dedupe_key);
      expect(keys.sort()).toEqual(
        [14, 1].map((m) => `bsc:exp:${connectionId}:2027-03-30:${m}`).sort(),
      );
    });

    it("writes one row per connection and per user, each under its owner", async () => {
      const aliceA = await seedConnection(aliceId);
      const aliceB = await seedConnection(aliceId);
      const bob = await seedConnection(bobId);
      await db.query(
        `INSERT INTO user_preferences (user_id, timezone) VALUES ($1, 'Europe/Warsaw')
           ON CONFLICT (user_id) DO UPDATE SET timezone = 'Europe/Warsaw'`,
        [bobId],
      );

      await twice(runAt("2027-03-23")); // 7 days left

      const rows = await notifications();
      expect(rows.map((r) => [r.user_id, r.dedupe_key]).sort()).toEqual(
        [
          [aliceId, `bsc:exp:${aliceA}:2027-03-30:7`],
          [aliceId, `bsc:exp:${aliceB}:2027-03-30:7`],
          [bobId, `bsc:exp:${bob}:2027-03-30:7`],
        ].sort(),
      );
    });

    it("counts the days in the user's timezone", async () => {
      // Ends 23:30 UTC on the 30th, already the 31st in Warsaw.
      const connectionId = await seedConnection(aliceId, {
        validUntil: "2027-03-30T23:30:00.000Z",
      });
      await db.query(
        `INSERT INTO user_preferences (user_id, timezone) VALUES ($1, 'Europe/Warsaw')
           ON CONFLICT (user_id) DO UPDATE SET timezone = 'Europe/Warsaw'`,
        [aliceId],
      );

      // 8 days left in Warsaw (the 14 mark), 7 in UTC (the 7 mark).
      await twice(runAt("2027-03-23"));

      const [row] = await notifications();
      expect(row.dedupe_key).toBe(`bsc:exp:${connectionId}:2027-03-30:14`);
      expect(row.data).toMatchObject({
        validUntil: "2027-03-31",
        threshold: 14,
      });
    });

    it("does not remind about a connection that is not active or has no end", async () => {
      await seedConnection(aliceId, { status: "revoked" });
      await seedConnection(aliceId, { status: "pending" });
      await seedConnection(aliceId, { validUntil: null });
      await twice(runAt("2027-03-23"));
      expect(await count("notifications")).toBe(0);
    });
  });

  describe("renewal", () => {
    it("starts new keys: the old period fires nothing more and the next period reminds at its own marks", async () => {
      const connectionId = await seedConnection(aliceId);
      await twice(runAt("2027-03-25")); // 5 days left: the 7 mark
      expect((await notifications()).map((r) => r.dedupe_key)).toEqual([
        `bsc:exp:${connectionId}:2027-03-30:7`,
      ]);

      // Renewed on 03-25 to 2027-09-21 (a reauthorization sets both).
      await db.query(
        `UPDATE bank_sync_connections
            SET valid_until = '2027-09-21T10:00:00Z', status = 'active'
          WHERE id = $1`,
        [connectionId],
      );

      for (const day of [
        "2027-03-26",
        "2027-03-27",
        "2027-03-30",
        "2027-03-31",
      ]) {
        await twice(runAt(day));
      }
      // The old period fires nothing more, not even its expiry notice.
      expect(await count("notifications")).toBe(1);

      await twice(runAt("2027-08-22")); // 30 days before the new end
      expect((await notifications()).map((r) => r.dedupe_key).sort()).toEqual(
        [
          `bsc:exp:${connectionId}:2027-03-30:7`,
          `bsc:exp:${connectionId}:2027-09-21:30`,
        ].sort(),
      );
    });
  });

  describe("an ended consent", () => {
    it("marks the connection expired and tells the user once, across concurrent evaluations and later days", async () => {
      const ended = new Date(Date.now() - 86_400_000);
      const connectionId = await seedConnection(aliceId, { validUntil: ended });

      await twice(new Date());
      await twice(new Date());
      await reminders.evaluate(new Date(Date.now() + 86_400_000));

      const [connection] = await query<{ status: string }>(
        `SELECT status FROM bank_sync_connections WHERE id = $1`,
        [connectionId],
      );
      expect(connection.status).toBe("expired");
      const rows = await notifications();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        user_id: aliceId,
        alert_type: "BANK_SYNC_CONSENT_EXPIRED",
        severity: "critical",
        dedupe_key: `bsc:expd:${connectionId}:${ended.toISOString().slice(0, 10)}`,
        target: "/settings/bank-sync",
      });
    });

    it("moves the row exactly once between two replicas racing for it", async () => {
      await seedConnection(aliceId, {
        validUntil: new Date(Date.now() - 3_600_000),
      });
      const tallies = await twice(new Date());
      expect(tallies.reduce((sum, t) => sum + t.expired, 0)).toBe(1);
      expect(await count("notifications")).toBe(1);
    });

    it("does not look back past a week, so a purged notice is not raised again", async () => {
      const connectionId = await seedConnection(aliceId, {
        validUntil: new Date(Date.now() - 8 * 86_400_000),
      });
      await twice(new Date());
      expect(await count("notifications")).toBe(0);
      const [connection] = await query<{ status: string }>(
        `SELECT status FROM bank_sync_connections WHERE id = $1`,
        [connectionId],
      );
      expect(connection.status).toBe("active");
    });

    it("leaves a connection renewed while the evaluation ran alone", async () => {
      const connectionId = await seedConnection(aliceId, {
        validUntil: new Date(Date.now() + 100 * 86_400_000),
      });
      await twice(new Date());
      const [connection] = await query<{ status: string }>(
        `SELECT status FROM bank_sync_connections WHERE id = $1`,
        [connectionId],
      );
      expect(connection.status).toBe("active");
      expect(await count("notifications")).toBe(0);
    });

    it("tells a consent the bank ended early once, whichever of the reminder and the daily sync sees it first", async () => {
      const validUntil = new Date(Date.now() + 20 * 86_400_000);
      const sessionGone = {
        bankAccountId: "00000000-0000-4000-8000-000000000001",
        label: "Main account",
        code: "session_expired",
      };

      // The daily sync first ...
      const first = await seedConnection(aliceId, {
        validUntil,
        status: "expired",
      });
      await withUserContext(aliceId, () =>
        notifier.report(
          aliceId,
          {
            connectionId: first,
            institutionName: "Test Bank",
            notifySuccess: "when_imported",
            validUntil,
            synced: [],
            failures: [sessionGone],
          },
          utcDay(),
        ),
      );
      await twice(new Date());
      expect(
        (await notifications("BANK_SYNC_CONSENT_EXPIRED")).map(
          (r) => r.dedupe_key,
        ),
      ).toEqual([`bsc:expd:${first}:${validUntil.toISOString().slice(0, 10)}`]);

      // ... and the reminder service first.
      await cleanTables(db, ["notifications"]);
      await twice(new Date());
      expect(await count("notifications")).toBe(1);
      await withUserContext(aliceId, () =>
        notifier.report(
          aliceId,
          {
            connectionId: first,
            institutionName: "Test Bank",
            notifySuccess: "when_imported",
            validUntil,
            synced: [],
            failures: [sessionGone],
          },
          utcDay(),
        ),
      );
      expect(await count("notifications")).toBe(1);
    });
  });

  describe("the daily sync", () => {
    const NO_OPERATION_FIELDS = {
      operation: {
        code: null,
        subCode: null,
        description: null,
        remittanceCode: null,
      },
    };
    const BANK_ROWS: BankTransaction[] = [
      {
        entryReference: "r1",
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
        ...NO_OPERATION_FIELDS,
      },
      {
        entryReference: "r2",
        transactionId: null,
        bankReference: null,
        amount: "20.00",
        currencyCode: "PLN",
        direction: "debit",
        booked: true,
        bookingDate: daysAgo(2),
        valueDate: null,
        transactionDate: null,
        counterpartyName: "Kiosk",
        remittance: ["Paper"],
        ...NO_OPERATION_FIELDS,
      },
    ];
    const NEW_ROW: BankTransaction = {
      ...BANK_ROWS[0],
      entryReference: "r3",
      amount: "5.00",
      bookingDate: daysAgo(1),
    };

    let connectionId: string;
    let bankAccountId: string;
    let monizeAccountId: string;

    const claimAgain = () => db.query(`DELETE FROM job_claims`);
    const bankReturns = (rows: BankTransaction[]) =>
      jest.spyOn(provider, "fetchTransactions").mockResolvedValue(rows);

    beforeEach(async () => {
      monizeAccountId = (
        await createTestAccount(db, aliceId, {
          name: "Checking",
          currencyCode: "PLN",
          openingBalance: 1000,
          currentBalance: 1000,
        })
      ).id;
      connectionId = await seedConnection(aliceId, {
        validUntil: new Date(Date.now() + 60 * 86_400_000),
        notifySuccess: "always",
      });
      const [bank] = await query<{ id: string }>(
        `INSERT INTO bank_sync_accounts
           (user_id, connection_id, external_account_id, identification_hash,
            display_name, currency_code)
         VALUES ($1, $2, 'ext-1', 'hash-1', 'Main account', 'PLN')
         RETURNING id`,
        [aliceId, connectionId],
      );
      bankAccountId = bank.id;
      await withUserContext(aliceId, () =>
        bankSync.linkAccount(aliceId, bankAccountId, {
          accountId: monizeAccountId,
          syncFromDate: daysAgo(30),
        }),
      );
      await withUserContext(aliceId, () =>
        credentials.save(aliceId, { applicationId: "app-1", privateKey: PEM }),
      );
      jest.spyOn(provider, "fetchBalance").mockResolvedValue({
        amount: "1000.00",
        currencyCode: "PLN",
        referenceDate: daysAgo(0),
        balanceType: "CLBD",
      });
      bankReturns(BANK_ROWS);
    });

    describe("a bank account that needs its preview (spec section 7a)", () => {
      it("is not imported by the daily cron: nothing is read from the bank and nothing is written", async () => {
        const fetch = bankReturns(BANK_ROWS);

        await cron.handleDailySync();

        expect(fetch).not.toHaveBeenCalled();
        expect(await count("transactions")).toBe(0);
        expect(await count("bank_sync_imported_transactions")).toBe(0);
        expect(await count("notifications")).toBe(0);
        const [bank] = await query<{
          last_sync_status: string | null;
          last_success_at: Date | null;
        }>(`SELECT last_sync_status, last_success_at FROM bank_sync_accounts`);
        expect(bank).toEqual({ last_sync_status: null, last_success_at: null });
      });

      it("is not imported by the connection-wide sync either, which answers needs_preview for it", async () => {
        const fetch = bankReturns(BANK_ROWS);

        const entries = await withUserContext(aliceId, () =>
          bankSync.syncConnection(aliceId, connectionId, null),
        );

        expect(entries).toEqual([
          {
            bankAccountId,
            error: { code: "needs_preview", message: expect.any(String) },
          },
        ]);
        expect(fetch).not.toHaveBeenCalled();
        expect(await count("transactions")).toBe(0);
        const [bank] = await query<{ last_sync_status: string | null }>(
          `SELECT last_sync_status FROM bank_sync_accounts`,
        );
        expect(bank.last_sync_status).toBeNull();
      });

      it("is imported by the daily cron once the person has confirmed the first import", async () => {
        // The confirmation is the single-account sync the preview leads to.
        const confirmed = await withUserContext(aliceId, () =>
          bankSync.syncAccount(aliceId, bankAccountId, null),
        );
        expect(confirmed).toMatchObject({ imported: 2 });

        bankReturns([...BANK_ROWS, NEW_ROW]);
        await claimAgain();
        await cron.handleDailySync();

        expect(await count("transactions")).toBe(3);
      });

      it("is imported again only by a new confirmation after the cut-off changes", async () => {
        await withUserContext(aliceId, () =>
          bankSync.syncAccount(aliceId, bankAccountId, null),
        );
        // Changing the cut-off date forgets the last success: the link needs its
        // preview again, and the cron leaves it alone until it is confirmed.
        await withUserContext(aliceId, () =>
          bankSync.linkAccount(aliceId, bankAccountId, {
            accountId: monizeAccountId,
            syncFromDate: daysAgo(20),
          }),
        );
        const fetch = bankReturns([...BANK_ROWS, NEW_ROW]);
        fetch.mockClear();
        await claimAgain();

        await cron.handleDailySync();

        expect(fetch).not.toHaveBeenCalled();
        expect(await count("transactions")).toBe(2);
      });
    });

    describe("outcomes", () => {
      /** Confirm the first import the way the person does, then start a clean day. */
      async function confirmed() {
        await withUserContext(aliceId, () =>
          bankSync.syncAccount(aliceId, bankAccountId, null),
        );
        await claimAgain();
        await cleanTables(db, ["notifications"]);
      }

      it("reports an import per the connection's success mode, once a day", async () => {
        await confirmed();
        bankReturns([...BANK_ROWS, NEW_ROW]);

        await cron.handleDailySync();

        const rows = await notifications("BANK_SYNC_IMPORTED");
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
          user_id: aliceId,
          severity: "success",
          dedupe_key: `bsc:imp:${connectionId}:${utcDay()}`,
          target: "/settings/bank-sync",
        });
        expect(rows[0].data).toMatchObject({
          connectionId,
          institutionName: "Test Bank",
          imported: 1,
          skipped: 2,
          accounts: 1,
        });

        // The claim lost (or taken again) the same UTC day: the index keeps one row.
        await claimAgain();
        await cron.handleDailySync();
        expect(await count("notifications")).toBe(1);
      });

      it.each([
        ["always", true, true],
        ["when_imported", true, false],
        ["never", false, false],
      ] as const)(
        "in %s mode a run that imported %s rows and one that imported nothing write %s / %s",
        async (mode, importedWrites, emptyWrites) => {
          await confirmed();
          await db.query(
            `UPDATE bank_sync_connections SET notify_success = $2 WHERE id = $1`,
            [connectionId, mode],
          );
          // A run that imported a row ...
          bankReturns([...BANK_ROWS, NEW_ROW]);
          await cron.handleDailySync();
          expect(await count("notifications")).toBe(
            mode === "never" ? 0 : importedWrites ? 1 : 0,
          );
          // ... and, on a clean day, one that found nothing new.
          await claimAgain();
          await cleanTables(db, ["notifications"]);
          await cron.handleDailySync();
          expect(await count("notifications")).toBe(emptyWrites ? 1 : 0);
        },
      );

      it("reports a failed account by its label and code, and the failure stays on the account", async () => {
        await confirmed();
        jest
          .spyOn(provider, "fetchTransactions")
          .mockRejectedValue(
            new BankSyncProviderError("rate_limited", "429", 429),
          );

        await cron.handleDailySync();

        const rows = await notifications("BANK_SYNC_FAILED");
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
          severity: "warning",
          dedupe_key: `bsc:fail:${connectionId}:${utcDay()}`,
        });
        expect(rows[0].data).toMatchObject({
          failures: [
            { bankAccountId, label: "Main account", code: "rate_limited" },
          ],
        });
        // Never a success notice for a run in which nothing synced.
        expect(await notifications("BANK_SYNC_IMPORTED")).toHaveLength(0);
      });

      it("says nothing about an account a manual sync is running, and records no failure on it", async () => {
        await confirmed();
        const jobClaims = module.get(JobClaimService);
        // The person's own sync holds the account's lease while the cron runs.
        const lease = await withUserContext(aliceId, () =>
          jobClaims.claimLease(
            JobClaimType.BankSyncAccount,
            aliceId,
            bankAccountId,
            60_000,
          ),
        );
        expect(lease).not.toBeNull();
        const fetch = bankReturns([...BANK_ROWS, NEW_ROW]);
        fetch.mockClear();

        await cron.handleDailySync();

        expect(fetch).not.toHaveBeenCalled();
        expect(await count("notifications")).toBe(0);
        const [bank] = await query<{ last_sync_status: string }>(
          `SELECT last_sync_status FROM bank_sync_accounts`,
        );
        expect(bank.last_sync_status).toBe("succeeded");
      });

      it("reports unusable credentials once a day with the credentials code", async () => {
        await confirmed();
        await db.query(`DELETE FROM bank_sync_credentials`);

        await cron.handleDailySync();

        const rows = await notifications("BANK_SYNC_FAILED");
        expect(rows).toHaveLength(1);
        expect(rows[0].data).toMatchObject({
          failures: [{ bankAccountId, code: "credentials" }],
        });
      });

      it("turns a session the bank ended into the one expiry notice, not into a failure", async () => {
        await confirmed();
        jest
          .spyOn(provider, "fetchTransactions")
          .mockRejectedValue(
            new BankSyncProviderError("session_expired", "gone", 401),
          );

        await cron.handleDailySync();

        const [connection] = await query<{ status: string; valid_until: Date }>(
          `SELECT status, valid_until FROM bank_sync_connections WHERE id = $1`,
          [connectionId],
        );
        expect(connection.status).toBe("expired");
        expect(await notifications("BANK_SYNC_FAILED")).toHaveLength(0);
        const expired = await notifications("BANK_SYNC_CONSENT_EXPIRED");
        expect(expired.map((r) => r.dedupe_key)).toEqual([
          `bsc:expd:${connectionId}:${connection.valid_until.toISOString().slice(0, 10)}`,
        ]);

        // The reminder service finds the same period already told.
        await twice(new Date());
        expect(await notifications("BANK_SYNC_CONSENT_EXPIRED")).toHaveLength(
          1,
        );
      });
    });

    describe("a sync the person starts", () => {
      it("writes no notification, whatever it finds", async () => {
        await withUserContext(aliceId, () =>
          bankSync.syncAccount(aliceId, bankAccountId, null),
        );
        bankReturns([...BANK_ROWS, NEW_ROW]);
        await withUserContext(aliceId, () =>
          bankSync.syncConnection(aliceId, connectionId, null),
        );
        jest
          .spyOn(provider, "fetchTransactions")
          .mockRejectedValue(
            new BankSyncProviderError("unavailable", "down", 503),
          );
        await withUserContext(aliceId, () =>
          bankSync.syncConnection(aliceId, connectionId, null),
        );
        jest
          .spyOn(provider, "fetchTransactions")
          .mockRejectedValue(
            new BankSyncProviderError("session_expired", "gone", 401),
          );
        await withUserContext(aliceId, () =>
          bankSync.syncConnection(aliceId, connectionId, null),
        );

        expect(await count("transactions")).toBe(3);
        expect(await count("notifications")).toBe(0);
      });
    });

    it("keeps the connection settings: a PATCH of the mode leaves auto-sync as it was", async () => {
      const view = await withUserContext(aliceId, () =>
        connectionsService.updateConnection(aliceId, connectionId, {
          notifySuccess: "never",
        }),
      );
      expect(view).toMatchObject({ notifySuccess: "never", autoSync: true });
      const again = await withUserContext(aliceId, () =>
        connectionsService.updateConnection(aliceId, connectionId, {
          autoSync: false,
        }),
      );
      expect(again).toMatchObject({ notifySuccess: "never", autoSync: false });
      await expect(
        withUserContext(bobId, () =>
          connectionsService.updateConnection(bobId, connectionId, {
            notifySuccess: "always",
          }),
        ),
      ).rejects.toMatchObject({ status: 404 });
    });
  });
});
