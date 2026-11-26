import { DataSource } from "typeorm";
import { Client } from "pg";
import * as fs from "fs";
import * as path from "path";

import {
  INTEGRATION_TYPEORM_OPTIONS,
  cleanTables,
  createTestUserDirect,
} from "../helpers/integration-setup";
import { applyRlsPolicies } from "../helpers/rls-setup";
import { createTestAccount } from "../helpers/test-factories";

/**
 * The issue #2445 repair of the cash legs the QIF/OFX/CSV importer wrote for a
 * brokerage with a linked cash account before issue #2436: the investment row
 * named a brokerage-side transfer counterpart instead of the cash row. The
 * migration points the investment row at the cash row, clears the cash row's
 * transfer link, gives it the trade's side of the VOID boundary, deletes the
 * counterpart and reverses what it contributed to the brokerage's balance
 * (nothing for a VOID or future-dated one, by the owner's own day), moves its
 * tags and drops the derived monthly balances of every account it moved. It
 * skips and reports a counterpart something is attached to and a trade whose
 * VOID the cash row contradicts in a way it cannot settle, reports the cash
 * rows the #2436 edit defect already orphaned, leaves every other shape alone,
 * and changes nothing on a second run.
 *
 * A real database and the migration read from disk, since the assertion is
 * about what its SQL does to the rows.
 */
describe("migration 20261126140130_heal_imported_investment_cash_leg_shape.sql", () => {
  let dataSource: DataSource;
  let userId: string;
  let cashAccountId: string;
  let brokerageId: string;

  const MIGRATION = path.join(
    __dirname,
    "../../../database/migrations",
    "20261126140130_heal_imported_investment_cash_leg_shape.sql",
  );

  const applyMigration = () =>
    dataSource.query(fs.readFileSync(MIGRATION, "utf8"));

  /** Apply it on a connection of its own and return the NOTICEs it raised. */
  const applyMigrationCollectingNotices = async (): Promise<string[]> => {
    const client = new Client({
      host: process.env.DATABASE_HOST || "localhost",
      port: parseInt(process.env.DATABASE_PORT || "5432", 10),
      user: process.env.DATABASE_USER || "monize_user",
      password: process.env.DATABASE_PASSWORD || "monize_password",
      database: process.env.DATABASE_NAME || "monize_test",
    });
    const notices: string[] = [];
    client.on("notice", (notice) => notices.push(notice.message ?? ""));
    await client.connect();
    try {
      await client.query(fs.readFileSync(MIGRATION, "utf8"));
    } finally {
      await client.end();
    }
    return notices;
  };

  const insertTransaction = async (row: {
    accountId: string;
    amount: number;
    date: string;
    status: string;
    isTransfer: boolean;
  }): Promise<string> => {
    const [{ id }] = (await dataSource.query(
      `INSERT INTO transactions
         (user_id, account_id, transaction_date, amount, currency_code,
          status, is_transfer)
       VALUES ($1, $2, $3, $4, 'CAD', $5, $6)
       RETURNING id`,
      [userId, row.accountId, row.date, row.amount, row.status, row.isTransfer],
    )) as { id: string }[];
    return id;
  };

  const insertInvestment = async (
    transactionId: string,
    date: string,
    amount: number,
    status = "UNRECONCILED",
  ): Promise<string> => {
    const [{ id }] = (await dataSource.query(
      `INSERT INTO investment_transactions
         (user_id, account_id, transaction_id, action, transaction_date,
          total_amount, status)
       VALUES ($1, $2, $3, 'DIVIDEND', $4, $5, $6)
       RETURNING id`,
      [userId, brokerageId, transactionId, date, amount, status],
    )) as { id: string }[];
    return id;
  };

  const linkPair = (a: string, b: string) =>
    dataSource.query(
      `UPDATE transactions SET linked_transaction_id = CASE id
         WHEN $1::uuid THEN $2::uuid WHEN $2::uuid THEN $1::uuid END
       WHERE id IN ($1, $2)`,
      [a, b],
    );

  /**
   * An imported dividend as the importer wrote it before #2436: the cash row
   * in the linked cash account, a counterpart in the brokerage, mutually
   * linked, and the investment row naming the counterpart. `status` sets all
   * three rows; `trade`, `cash` and `counterpart` override one each.
   */
  const seedOldShape = async ({
    amount = 100,
    date = "2026-08-14",
    status = "UNRECONCILED",
    trade,
    cash,
    counterpart,
  }: {
    amount?: number;
    date?: string;
    status?: string;
    trade?: string;
    cash?: string;
    counterpart?: string;
  } = {}) => {
    const cashId = await insertTransaction({
      accountId: cashAccountId,
      amount,
      date,
      status: cash ?? status,
      isTransfer: true,
    });
    const counterpartId = await insertTransaction({
      accountId: brokerageId,
      amount: -amount,
      date,
      status: counterpart ?? status,
      isTransfer: true,
    });
    await linkPair(cashId, counterpartId);
    const investmentId = await insertInvestment(
      counterpartId,
      date,
      amount,
      trade ?? status,
    );
    return { cashId, counterpartId, investmentId };
  };

  const setBalance = (accountId: string, balance: number) =>
    dataSource.query("UPDATE accounts SET current_balance = $2 WHERE id = $1", [
      accountId,
      balance,
    ]);

  const balanceOf = async (accountId: string): Promise<number> => {
    const [row] = (await dataSource.query(
      "SELECT current_balance FROM accounts WHERE id = $1",
      [accountId],
    )) as { current_balance: string }[];
    return Number(row.current_balance);
  };

  const transactionOf = async (id: string) => {
    const [row] = (await dataSource.query(
      `SELECT is_transfer, linked_transaction_id, amount, status, updated_at
         FROM transactions WHERE id = $1`,
      [id],
    )) as {
      is_transfer: boolean;
      linked_transaction_id: string | null;
      amount: string;
      status: string;
      updated_at: Date;
    }[];
    return row;
  };

  const cashLegOf = async (investmentId: string): Promise<string | null> => {
    const [row] = (await dataSource.query(
      "SELECT transaction_id FROM investment_transactions WHERE id = $1",
      [investmentId],
    )) as { transaction_id: string | null }[];
    return row.transaction_id;
  };

  const snapshotAccounts = async (): Promise<string[]> =>
    (
      (await dataSource.query(
        "SELECT account_id FROM monthly_account_balances ORDER BY account_id",
      )) as { account_id: string }[]
    ).map((s) => s.account_id);

  const seedSnapshots = () =>
    dataSource.query(
      `INSERT INTO monthly_account_balances (user_id, account_id, month, balance)
       VALUES ($1, $2, '2026-08-01', -100), ($1, $3, '2026-08-01', 100)`,
      [userId, brokerageId, cashAccountId],
    );

  /** The owner's today in `zone`, as the database reads it. */
  const todayIn = async (zone: string): Promise<string> => {
    const [{ d }] = (await dataSource.query(
      `SELECT to_char((now() AT TIME ZONE $1)::date, 'YYYY-MM-DD') AS d`,
      [zone],
    )) as { d: string }[];
    return d;
  };

  const setPreferences = (
    timezone: string,
    lastClientTimezone: string | null,
  ) =>
    dataSource.query(
      `INSERT INTO user_preferences (user_id, timezone, last_client_timezone)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id) DO UPDATE
         SET timezone = EXCLUDED.timezone,
             last_client_timezone = EXCLUDED.last_client_timezone`,
      [userId, timezone, lastClientTimezone],
    );

  beforeAll(async () => {
    if (!fs.existsSync(MIGRATION)) {
      throw new Error(`Migration not found at ${MIGRATION}`);
    }
    dataSource = new DataSource(INTEGRATION_TYPEORM_OPTIONS as never);
    await dataSource.initialize();
    await applyRlsPolicies(dataSource);
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      await dataSource.destroy();
    }
  });

  beforeEach(async () => {
    await cleanTables(dataSource, [
      "monthly_account_balances",
      "transaction_attachments",
      "transaction_tags",
      "tags",
      "investment_transactions",
      "transaction_splits",
      "transactions",
      "accounts",
      "users",
    ]);
    await dataSource.query(
      `INSERT INTO currencies (code, name, symbol, decimal_places) VALUES
         ('CAD', 'Canadian Dollar', '$', 2)
       ON CONFLICT DO NOTHING`,
    );
    userId = (await createTestUserDirect(dataSource)).id;
    cashAccountId = (
      await createTestAccount(dataSource, userId, {
        name: "Brokerage - Cash",
        accountType: "INVESTMENT",
        currencyCode: "CAD",
      })
    ).id;
    brokerageId = (
      await createTestAccount(dataSource, userId, {
        name: "Brokerage",
        accountType: "INVESTMENT",
        currencyCode: "CAD",
      })
    ).id;
    await dataSource.query(
      `UPDATE accounts SET account_sub_type = CASE id
           WHEN $1::uuid THEN 'INVESTMENT_CASH'
           WHEN $2::uuid THEN 'INVESTMENT_BROKERAGE' END,
         linked_account_id = CASE id
           WHEN $1::uuid THEN $2::uuid WHEN $2::uuid THEN $1::uuid END
       WHERE id IN ($1, $2)`,
      [cashAccountId, brokerageId],
    );
  });

  it("points the investment row at the cash row, unlinks it, deletes the counterpart and reverses its balance, twice", async () => {
    const { cashId, counterpartId, investmentId } = await seedOldShape();
    // What the post-import recalculation left: the cash account holds the
    // dividend and the brokerage the phantom counterpart.
    await setBalance(cashAccountId, 100);
    await setBalance(brokerageId, -100);
    const [{ id: tagId }] = (await dataSource.query(
      "INSERT INTO tags (user_id, name) VALUES ($1, 'Taxable') RETURNING id",
      [userId],
    )) as { id: string }[];
    await dataSource.query(
      "INSERT INTO transaction_tags (transaction_id, tag_id) VALUES ($1, $2)",
      [counterpartId, tagId],
    );
    await seedSnapshots();

    const notices = await applyMigrationCollectingNotices();

    expect(notices).toEqual([
      expect.stringContaining(
        "pointed 1 imported investment row(s) at their cash row",
      ),
    ]);
    expect(await cashLegOf(investmentId)).toBe(cashId);
    const cash = await transactionOf(cashId);
    expect(cash.is_transfer).toBe(false);
    expect(cash.linked_transaction_id).toBeNull();
    expect(cash.status).toBe("UNRECONCILED");
    expect(Number(cash.amount)).toBe(100);
    expect(await transactionOf(counterpartId)).toBeUndefined();
    expect(await balanceOf(brokerageId)).toBe(0);
    expect(await balanceOf(cashAccountId)).toBe(100);
    expect(
      await dataSource.query(
        "SELECT tag_id FROM transaction_tags WHERE transaction_id = $1",
        [cashId],
      ),
    ).toEqual([{ tag_id: tagId }]);
    // Only the brokerage's balance moved, so only its snapshots go.
    expect(await snapshotAccounts()).toEqual([cashAccountId]);

    expect(await applyMigrationCollectingNotices()).toEqual([]);

    expect(await cashLegOf(investmentId)).toBe(cashId);
    // Never touched again, so not even its updated_at moved.
    expect(await transactionOf(cashId)).toEqual(cash);
    expect(await balanceOf(brokerageId)).toBe(0);
    expect(await balanceOf(cashAccountId)).toBe(100);
  });

  it("deletes a VOID and a future-dated counterpart without moving the balance either never entered", async () => {
    const voided = await seedOldShape({ status: "VOID" });
    const future = await seedOldShape({ date: "2999-01-01", amount: 40 });
    const counted = await seedOldShape({ amount: 25 });
    await setBalance(brokerageId, -25);
    await setBalance(cashAccountId, 25);

    await applyMigration();

    for (const row of [voided, future, counted]) {
      expect(await cashLegOf(row.investmentId)).toBe(row.cashId);
      expect(await transactionOf(row.counterpartId)).toBeUndefined();
    }
    // A VOID trade over a VOID cash row agrees: the cash row stays VOID and
    // moves no balance (INV-TRANSFER-001).
    expect((await transactionOf(voided.cashId)).status).toBe("VOID");
    expect(await balanceOf(brokerageId)).toBe(0);
    expect(await balanceOf(cashAccountId)).toBe(25);
  });

  it("voids the active cash row of a VOID trade, whose void reached only the counterpart, and gives back its amount", async () => {
    // updateStatus voided the row transaction_id named -- the counterpart --
    // and left the real cash row counting a dividend that did not happen.
    const { cashId, counterpartId, investmentId } = await seedOldShape({
      trade: "VOID",
      counterpart: "VOID",
      cash: "CLEARED",
    });
    const future = await seedOldShape({
      date: "2999-01-01",
      amount: 40,
      trade: "VOID",
      counterpart: "VOID",
      cash: "UNRECONCILED",
    });
    await setBalance(cashAccountId, 100);
    await setBalance(brokerageId, 0);
    await seedSnapshots();

    const notices = await applyMigrationCollectingNotices();

    expect(notices).toEqual([
      expect.stringContaining("voiding 2 cash row(s) whose trade was VOID"),
    ]);
    expect(await cashLegOf(investmentId)).toBe(cashId);
    const cash = await transactionOf(cashId);
    expect(cash.status).toBe("VOID");
    expect(cash.is_transfer).toBe(false);
    expect(await transactionOf(counterpartId)).toBeUndefined();
    expect((await transactionOf(future.cashId)).status).toBe("VOID");
    // The future-dated cash row was never in the balance, so only the
    // dated one gives its 100 back; the VOID counterpart gave nothing.
    expect(await balanceOf(cashAccountId)).toBe(0);
    expect(await balanceOf(brokerageId)).toBe(0);
    // Both balances' histories changed (the cash account's through the void),
    // so both accounts' snapshots go.
    expect(await snapshotAccounts()).toEqual([]);
  });

  it.each([
    [
      "an active trade over a VOID cash row",
      { trade: "UNRECONCILED", cash: "VOID", counterpart: "VOID" },
    ],
    [
      "a VOID trade over a RECONCILED cash row",
      { trade: "VOID", cash: "RECONCILED", counterpart: "VOID" },
    ],
  ])("leaves %s unrepaired and names it", async (_label, statuses) => {
    const { cashId, counterpartId, investmentId } =
      await seedOldShape(statuses);
    await setBalance(cashAccountId, 100);
    const before = await transactionOf(cashId);

    const notices = await applyMigrationCollectingNotices();

    expect(notices).toEqual([
      expect.stringMatching(new RegExp(`disagree about VOID.*${investmentId}`)),
    ]);
    expect(await cashLegOf(investmentId)).toBe(counterpartId);
    expect(await transactionOf(cashId)).toEqual(before);
    expect(await transactionOf(counterpartId)).toBeDefined();
    expect(await balanceOf(cashAccountId)).toBe(100);
  });

  /** One way each of the dependents the migration refuses to orphan. */
  const DEPENDENTS: [string, (counterpartId: string) => Promise<unknown>][] = [
    [
      "an attachment",
      (id) =>
        dataSource.query(
          `INSERT INTO transaction_attachments
               (user_id, transaction_id, filename, content_type, byte_size,
                sha256, storage_key)
             VALUES ($1, $2, 'slip.pdf', 'application/pdf', 1,
                     repeat('0', 64), 'k')`,
          [userId, id],
        ),
    ],
    [
      "a warranty",
      (id) =>
        dataSource.query(
          `INSERT INTO warranties
               (user_id, name, purchase_date, is_lifetime, transaction_id)
             VALUES ($1, 'Kettle', '2026-08-14', true, $2)`,
          [userId, id],
        ),
    ],
    [
      "an email receipt",
      async (id) => {
        const [{ id: mailboxId }] = (await dataSource.query(
          `INSERT INTO email_receipt_mailboxes
               (user_id, host, username, password_enc)
             VALUES ($1, 'imap.example.test', 'me', 'ciphertext')
             RETURNING id`,
          [userId],
        )) as { id: string }[];
        return dataSource.query(
          `INSERT INTO email_receipts
               (user_id, mailbox_id, uid, uid_validity, from_address,
                from_domain, subject, body_text, received_at, transaction_id)
             VALUES ($1, $2, 1, 1, 'shop@example.test', 'example.test',
                     'Receipt', 'Thanks', now(), $3)`,
          [userId, mailboxId, id],
        );
      },
    ],
    [
      "a scheduled occurrence it settled",
      async (id) => {
        const [{ id: scheduleId }] = (await dataSource.query(
          `INSERT INTO scheduled_transactions
               (user_id, account_id, name, amount, currency_code,
                next_due_date, start_date)
             VALUES ($1, $2, 'Dividend', -100, 'CAD', '2026-09-14',
                     '2026-08-14')
             RETURNING id`,
          [userId, brokerageId],
        )) as { id: string }[];
        return dataSource.query(
          `INSERT INTO scheduled_transaction_postings
               (scheduled_transaction_id, original_due_date, posted_date,
                transaction_id)
             VALUES ($1, '2026-08-14', '2026-08-14', $2)`,
          [scheduleId, id],
        );
      },
    ],
    [
      "a bank-sync match",
      (id) =>
        dataSource.query(
          `INSERT INTO bank_sync_imported_transactions
               (user_id, account_id, booking_date, external_key,
                transaction_id)
             VALUES ($1, $2, '2026-08-14', 'ext-1', $3)`,
          [userId, brokerageId, id],
        ),
    ],
    [
      "a split line of its own",
      (id) =>
        dataSource.query(
          `INSERT INTO transaction_splits (transaction_id, amount)
             VALUES ($1, -100)`,
          [id],
        ),
    ],
    [
      "a split line linking it",
      async (id) => {
        const parentId = await insertTransaction({
          accountId: cashAccountId,
          amount: 100,
          date: "2026-08-14",
          status: "UNRECONCILED",
          isTransfer: false,
        });
        return dataSource.query(
          `INSERT INTO transaction_splits
               (transaction_id, kind, transfer_account_id,
                linked_transaction_id, amount)
             VALUES ($1, 'transfer', $2, $3, 100)`,
          [parentId, brokerageId, id],
        );
      },
    ],
    [
      "a shared-expense ledger link",
      async (id) => {
        // Seeded the way a restore writes them, in one implicit
        // transaction so SET LOCAL holds for every statement.
        const group = "70000000-0000-4000-8000-000000000001";
        const payer = "70000000-0000-4000-8000-000000000002";
        const payee = "70000000-0000-4000-8000-000000000003";
        const entry = "70000000-0000-4000-8000-000000000004";
        const integration = "70000000-0000-4000-8000-000000000005";
        const posting = "70000000-0000-4000-8000-000000000006";
        return dataSource.query(`
            SET LOCAL app.preserve_timestamps = 'on';
            INSERT INTO shared_groups (id, owner_user_id, name, currency_code)
              VALUES ('${group}', '${userId}', 'Trip', 'CAD');
            INSERT INTO shared_participants (id, group_id, name)
              VALUES ('${payer}', '${group}', 'Me'),
                     ('${payee}', '${group}', 'Friend');
            INSERT INTO shared_entries
                (id, group_id, type, title, entry_date, original_amount,
                 original_currency_code, group_amount, fx_rate, rounding_seed,
                 from_participant_id, to_participant_id)
              VALUES ('${entry}', '${group}', 'REPAYMENT', 'Settle up',
                      '2026-08-14', 100, 'CAD', 100, 1, 'seed', '${payer}',
                      '${payee}');
            INSERT INTO shared_integrations
                (id, user_id, group_id, participant_id, account_id)
              VALUES ('${integration}', '${userId}', '${group}', '${payer}',
                      '${cashAccountId}');
            INSERT INTO shared_postings
                (id, user_id, group_id, entry_id, integration_id,
                 accepted_revision, input_fingerprint, accepted_snapshot)
              VALUES ('${posting}', '${userId}', '${group}', '${entry}',
                      '${integration}', 1, 'fp', '{}');
            INSERT INTO shared_ledger_links
                (user_id, posting_id, transaction_id, kind, allocated_amount)
              VALUES ('${userId}', '${posting}', '${id}', 'BANK', 100);
          `);
      },
    ],
  ];

  it.each(DEPENDENTS)(
    "leaves a counterpart with %s in place and names it",
    async (_label, attach) => {
      const { cashId, counterpartId, investmentId } = await seedOldShape();
      await setBalance(brokerageId, -100);
      await attach(counterpartId);

      const notices = await applyMigrationCollectingNotices();

      expect(notices).toEqual([
        expect.stringMatching(
          new RegExp(`something is attached.*${investmentId}`),
        ),
      ]);
      expect(await cashLegOf(investmentId)).toBe(counterpartId);
      expect((await transactionOf(cashId)).linked_transaction_id).toBe(
        counterpartId,
      );
      expect(await transactionOf(counterpartId)).toBeDefined();
      expect(await balanceOf(brokerageId)).toBe(-100);
    },
  );

  describe("the owner's today", () => {
    // UTC+14 and UTC-12 are 26 hours apart, so their dates always differ: a
    // row dated today in Kiritimati is still in the future at UTC-12.
    const AHEAD = "Pacific/Kiritimati";
    const BEHIND = "Etc/GMT+12";

    it.each([
      ["the stored preference", AHEAD, null, AHEAD, 0],
      ["the stored preference, behind", BEHIND, null, AHEAD, -100],
      ["the last client zone under 'browser'", "browser", AHEAD, AHEAD, 0],
      ["UTC when the zone is unknown", "Not/AZone", null, "UTC", 0],
    ])(
      "reads %s",
      async (_label, timezone, lastClient, datedIn, expectedBalance) => {
        await setPreferences(timezone, lastClient);
        const date = await todayIn(datedIn);
        await seedOldShape({ date });
        await setBalance(brokerageId, -100);

        await applyMigration();

        // A counted counterpart gives its -100 back; a future one gave
        // nothing, so the balance stays where it was.
        expect(await balanceOf(brokerageId)).toBe(expectedBalance);
      },
    );

    it("treats a row dated after an unknown zone's UTC today as future", async () => {
      await setPreferences("Not/AZone", null);
      const tomorrow = await dataSource.query(
        `SELECT to_char((now() AT TIME ZONE 'UTC')::date + 1, 'YYYY-MM-DD') AS d`,
      );
      await seedOldShape({ date: (tomorrow as { d: string }[])[0].d });
      await setBalance(brokerageId, -100);

      await applyMigration();

      expect(await balanceOf(brokerageId)).toBe(-100);
    });
  });

  it("names, and never changes, a cash row the #2436 edit defect orphaned", async () => {
    // The edit deleted the counterpart (ON DELETE SET NULL cleared the cash
    // row's link) and wrote a second cash row the investment row names.
    const orphanId = await insertTransaction({
      accountId: cashAccountId,
      amount: 100,
      date: "2026-08-14",
      status: "UNRECONCILED",
      isTransfer: true,
    });
    const newLegId = await insertTransaction({
      accountId: cashAccountId,
      amount: 100,
      date: "2026-08-14",
      status: "UNRECONCILED",
      isTransfer: false,
    });
    const investmentId = await insertInvestment(newLegId, "2026-08-14", 100);
    // A person's own unlinked transfer row on another day is not reported.
    await insertTransaction({
      accountId: cashAccountId,
      amount: 100,
      date: "2026-08-15",
      status: "UNRECONCILED",
      isTransfer: true,
    });
    await setBalance(cashAccountId, 300);
    const before = await transactionOf(orphanId);

    const notices = await applyMigrationCollectingNotices();

    expect(notices).toEqual([
      expect.stringMatching(new RegExp(`^.*1 unlinked transfer.*${orphanId}`)),
    ]);
    expect(await transactionOf(orphanId)).toEqual(before);
    expect(await cashLegOf(investmentId)).toBe(newLegId);
    expect(await balanceOf(cashAccountId)).toBe(300);
  });

  it("leaves the shape the native writer produces alone", async () => {
    const cashId = await insertTransaction({
      accountId: cashAccountId,
      amount: 100,
      date: "2026-08-14",
      status: "UNRECONCILED",
      isTransfer: false,
    });
    const investmentId = await insertInvestment(cashId, "2026-08-14", 100);
    const before = await transactionOf(cashId);

    expect(await applyMigrationCollectingNotices()).toEqual([]);

    expect(await cashLegOf(investmentId)).toBe(cashId);
    expect(await transactionOf(cashId)).toEqual(before);
  });

  it("leaves a pair whose cash half is outside the brokerage's linked cash account alone", async () => {
    // A transfer between the brokerage and some other account is a real
    // transfer, not the importer's cash leg, whatever names it.
    const otherId = (
      await createTestAccount(dataSource, userId, {
        name: "Chequing",
        currencyCode: "CAD",
      })
    ).id;
    const otherLeg = await insertTransaction({
      accountId: otherId,
      amount: 100,
      date: "2026-08-14",
      status: "UNRECONCILED",
      isTransfer: true,
    });
    const brokerageLeg = await insertTransaction({
      accountId: brokerageId,
      amount: -100,
      date: "2026-08-14",
      status: "UNRECONCILED",
      isTransfer: true,
    });
    await linkPair(otherLeg, brokerageLeg);
    const investmentId = await insertInvestment(
      brokerageLeg,
      "2026-08-14",
      100,
    );
    await setBalance(brokerageId, -100);

    await applyMigration();

    expect(await cashLegOf(investmentId)).toBe(brokerageLeg);
    expect((await transactionOf(otherLeg)).is_transfer).toBe(true);
    expect(await balanceOf(brokerageId)).toBe(-100);
  });
});
