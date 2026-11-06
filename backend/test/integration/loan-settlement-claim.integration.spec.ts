import { TestingModule } from "@nestjs/testing";
import { DataSource } from "typeorm";
import { Account, AccountType } from "@/accounts/entities/account.entity";
import { AccountsService } from "@/accounts/accounts.service";
import { LoanPaymentMatchingService } from "@/accounts/loan-payment-matching.service";
import {
  ActionHistoryService,
  settlePendingHistoryWrites,
} from "@/action-history/action-history.service";
import { ActionHistory } from "@/action-history/entities/action-history.entity";
import { undoRuleRun } from "@/action-history/rule-run-undo";
import { withScopedDb } from "@/common/db/scoped-db";
import { withUserContext } from "@/common/db/with-context";
import { ScheduledTransaction } from "@/scheduled-transactions/entities/scheduled-transaction.entity";
import { ScheduledTransactionOverride } from "@/scheduled-transactions/entities/scheduled-transaction-override.entity";
import { ScheduledTransactionSplit } from "@/scheduled-transactions/entities/scheduled-transaction-split.entity";
import { NotFoundException } from "@nestjs/common";
import { TransactionRule } from "@/transaction-rules/transaction-rule.entity";
import { TransactionRulesModule } from "@/transaction-rules/transaction-rules.module";
import { TransactionRulesRunService } from "@/transaction-rules/transaction-rules-run.service";
import { TransactionRulesService } from "@/transaction-rules/transaction-rules.service";
import { TransactionStatus } from "@/transactions/entities/transaction-status.enum";
import { TransactionsModule } from "@/transactions/transactions.module";
import { TransactionsService } from "@/transactions/transactions.service";
import {
  cleanTables,
  createIntegrationModule,
  createTestUserDirect,
} from "../helpers/integration-setup";
import {
  createTestAccount,
  createTestCategory,
} from "../helpers/test-factories";

/**
 * INV-LOAN-008 against a real PostgreSQL (`docs/specs/loan-installment-settlement.md`
 * section 16, row B5): the settlement of a bank debit through
 * `TransactionsService.create` with a `settle_loan_installment` rule writes
 * the split, the counterpart leg in the loan, the occurrence claim and the
 * cursor advance in one transaction, and a failure after the claim rolls all
 * of it back; a second row for the same slot is refused and writes nothing;
 * deleting the settling transaction releases the claim and voiding keeps it;
 * a bill post and a settlement of one slot on two connections serialise on
 * the schedule row lock and the unique key, and exactly one wins; and the
 * template is repriced after the commit.
 *
 * Fixtures from spec section 9.2: a LOAN of EUR 200,000 at 6 % nominal,
 * monthly, payment 1,500, so slot 1 books 500.00 principal and 1,000.00
 * interest, and the next slot on 199,500 books 502.50 and 997.50.
 *
 * **What this suite reaches, and what it does not.** This suite was written
 * while the integration harness replaced `ScheduledTransactionsModule` with a
 * stub, so it does not call the real `ScheduledTransactionsService.post()`
 * (the harness now builds the real module, and
 * `scheduled-posting.integration.spec.ts` drives `post()` itself). The
 * two-connection case here drives the other side
 * with the two statements `post()` takes before it writes money (the
 * schedule row lock, then its claim `INSERT ... ON CONFLICT DO NOTHING`), as
 * `scheduled-loan-pricing-concurrency.integration.spec.ts` does for the
 * pricing lock; that `post()` takes exactly those statements is held by
 * `scheduled-transactions.service.spec.ts`.
 */
describe("Loan settlement claim (integration)", () => {
  jest.setTimeout(240000);

  let module: TestingModule;
  let db: DataSource;
  let transactions: TransactionsService;
  let accounts: AccountsService;
  let runs: TransactionRulesRunService;
  let history: ActionHistoryService;
  let matching: LoanPaymentMatchingService;
  let rulesService: TransactionRulesService;

  let userId: string;
  let chequingId: string;
  let loanId: string;
  let interestCategoryId: string;
  let scheduleId: string;
  let ruleId: string;

  const asUser = <T>(fn: () => Promise<T>) => withUserContext(userId, fn);

  const create = (
    transactionDate: string,
    amount: number,
    payee = "ING HYPOTHEKEN",
  ) =>
    asUser(() =>
      transactions.create(userId, {
        accountId: chequingId,
        transactionDate,
        amount,
        currencyCode: "EUR",
        payeeName: payee,
      } as never),
    );

  const claims = async () =>
    db.query(
      `SELECT id, scheduled_transaction_id, TO_CHAR(original_due_date, 'YYYY-MM-DD') AS due,
              TO_CHAR(posted_date, 'YYYY-MM-DD') AS posted, transaction_id, source, rule_id, pricing
         FROM scheduled_transaction_postings ORDER BY original_due_date`,
    );
  const schedule = async () =>
    (
      await db.query(
        `SELECT TO_CHAR(next_due_date, 'YYYY-MM-DD') AS next_due_date, is_active,
                TO_CHAR(last_posted_date, 'YYYY-MM-DD') AS last_posted_date
           FROM scheduled_transactions WHERE id = $1`,
        [scheduleId],
      )
    )[0];
  const balanceOf = async (accountId: string): Promise<number> =>
    Number(
      (
        await db.query(`SELECT current_balance FROM accounts WHERE id = $1`, [
          accountId,
        ])
      )[0].current_balance,
    );
  const rowOf = async (id: string) =>
    (
      await db.query(
        `SELECT id, account_id, amount, category_id, is_split, status
           FROM transactions WHERE id = $1`,
        [id],
      )
    )[0];
  const linesOf = async (id: string) =>
    (
      await db.query(
        `SELECT kind, amount, category_id, transfer_account_id, linked_transaction_id, memo
           FROM transaction_splits WHERE transaction_id = $1 ORDER BY amount`,
        [id],
      )
    ).map((s: Record<string, string | null>) => ({
      ...s,
      amount: Number(s.amount),
    }));
  const count = async (table: string): Promise<number> =>
    Number((await db.query(`SELECT COUNT(*)::int AS n FROM ${table}`))[0].n);
  const templateLines = async () =>
    (
      await db.query(
        `SELECT memo, amount FROM scheduled_transaction_splits
          WHERE scheduled_transaction_id = $1 ORDER BY memo`,
        [scheduleId],
      )
    ).map((s: { memo: string; amount: string }) => [s.memo, Number(s.amount)]);

  /**
   * How many backends are parked on a lock: the race is only set up once the
   * competing writer is genuinely blocked (the pricing concurrency suite's
   * helper, for the same reason).
   */
  async function waitForBlockedBackends(expected: number): Promise<void> {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const rows: { c: number }[] = await db.query(
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
      `Timed out waiting for ${expected} lock-blocked backend(s); the race was never set up`,
    );
  }

  /** The statements post() takes before it writes money: the schedule row lock, then its claim. */
  const postClaim = (m: Parameters<Parameters<typeof withScopedDb>[1]>[0]) =>
    m
      .query(
        `SELECT id FROM scheduled_transactions WHERE id = $1 AND user_id = $2 FOR UPDATE`,
        [scheduleId, userId],
      )
      .then(() =>
        m.query(
          `INSERT INTO scheduled_transaction_postings
             (scheduled_transaction_id, original_due_date, posted_date)
           VALUES ($1, $2, $3)
           ON CONFLICT (scheduled_transaction_id, original_due_date) DO NOTHING
           RETURNING id`,
          [scheduleId, "2024-01-01", "2024-01-01"],
        ),
      );

  beforeAll(async () => {
    module = await createIntegrationModule([
      TransactionsModule,
      TransactionRulesModule,
    ]);
    db = module.get(DataSource);
    transactions = module.get(TransactionsService);
    accounts = module.get(AccountsService);
    runs = module.get(TransactionRulesRunService);
    history = module.get(ActionHistoryService, { strict: false });
    matching = module.get(LoanPaymentMatchingService, { strict: false });
    rulesService = module.get(TransactionRulesService);
    // The synchronize-built schema derives `transaction_splits.transaction_id`
    // from the entity, which names no ON DELETE action; `database/schema.sql`
    // cascades it, and `TransactionsService.remove` relies on that cascade to
    // drop a split parent's lines. Bring the one constraint up to the real
    // shape so the delete case exercises the production path.
    const [fk] = await db.query(
      `SELECT c.conname
         FROM pg_constraint c
         JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)
        WHERE c.contype = 'f'
          AND c.conrelid = 'transaction_splits'::regclass
          AND c.confrelid = 'transactions'::regclass
          AND a.attname = 'transaction_id'`,
    );
    await db.query(
      `ALTER TABLE transaction_splits DROP CONSTRAINT "${fk.conname}",
       ADD CONSTRAINT "${fk.conname}" FOREIGN KEY (transaction_id)
         REFERENCES transactions(id) ON DELETE CASCADE`,
    );
  });

  afterAll(async () => {
    await settlePendingHistoryWrites();
    await module.close();
  });

  beforeEach(async () => {
    jest.restoreAllMocks();
    await settlePendingHistoryWrites();
    await cleanTables(db, [
      "transaction_rule_applications",
      "transaction_rules",
      "action_history",
      "scheduled_transaction_postings",
      "scheduled_transaction_splits",
      "scheduled_transaction_overrides",
      "scheduled_transactions",
      "transaction_splits",
      "transactions",
      "monthly_account_balances",
      "accounts",
      "categories",
      "payees",
      "users",
    ]);
    await db.query(
      `INSERT INTO currencies (code, name, symbol, decimal_places)
       VALUES ('EUR', 'Euro', 'E', 2) ON CONFLICT DO NOTHING`,
    );
    userId = (await createTestUserDirect(db)).id;
    chequingId = (
      await createTestAccount(db, userId, {
        name: "Chequing",
        currencyCode: "EUR",
        openingBalance: 50000,
        currentBalance: 50000,
      })
    ).id;
    interestCategoryId = (
      await createTestCategory(db, userId, { name: "Loan Interest" })
    ).id;
    loanId = (
      await createTestAccount(db, userId, {
        name: "Mortgage",
        accountType: AccountType.LOAN,
        currencyCode: "EUR",
        openingBalance: -200000,
        currentBalance: -200000,
      })
    ).id;

    const saved = await db.manager.save(
      db.manager.create(ScheduledTransaction, {
        userId,
        accountId: chequingId,
        name: "Mortgage Payment",
        amount: -1500,
        currencyCode: "EUR",
        frequency: "MONTHLY",
        startDate: "2024-01-01",
        nextDueDate: "2024-01-01",
        isActive: true,
        isSplit: true,
        autoPost: false,
      } as Partial<ScheduledTransaction>),
    );
    scheduleId = saved.id;
    await db.manager.save(
      db.manager.create(ScheduledTransactionSplit, {
        scheduledTransactionId: scheduleId,
        kind: "transfer",
        transferAccountId: loanId,
        amount: -500,
        memo: "Principal",
      } as Partial<ScheduledTransactionSplit>),
    );
    await db.manager.save(
      db.manager.create(ScheduledTransactionSplit, {
        scheduledTransactionId: scheduleId,
        kind: "category",
        categoryId: interestCategoryId,
        amount: -1000,
        memo: "Interest",
      } as Partial<ScheduledTransactionSplit>),
    );
    await db.manager.update(Account, loanId, {
      interestRate: 6,
      paymentFrequency: "MONTHLY",
      paymentAmount: 1500,
      interestCategoryId,
      scheduledTransactionId: scheduleId,
    });

    ruleId = (
      await db.manager.save(
        db.manager.create(TransactionRule, {
          userId,
          name: "Hypotheek",
          enabled: true,
          position: 0,
          triggers: ["create", "import"],
          condition: { field: "payeeText", op: "contains", value: "ING" },
          actions: [
            {
              type: "settle_loan_installment",
              loanAccountId: loanId,
              dueDateWindow: { daysBefore: 3, daysAfter: 7 },
              excess: "extra_principal",
              shortfall: "refuse",
            },
          ],
          stopProcessing: true,
          activeFrom: null,
          activeTo: null,
          revision: 1,
        } as Partial<TransactionRule>),
      )
    ).id;
  });

  it("writes the split, the counterpart in the loan, the claim and the advanced cursor in one transaction", async () => {
    const row = await create("2024-01-03", -1500);

    expect(await rowOf(row.id)).toMatchObject({
      account_id: chequingId,
      is_split: true,
      category_id: null,
    });
    const lines = await linesOf(row.id);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({
      kind: "category",
      amount: -1000,
      category_id: interestCategoryId,
      memo: "Interest",
    });
    expect(lines[1]).toMatchObject({
      kind: "transfer",
      amount: -500,
      transfer_account_id: loanId,
      memo: "Principal",
    });
    const leg = await rowOf(lines[1].linked_transaction_id as string);
    expect(leg).toMatchObject({ account_id: loanId });
    expect(Number(leg.amount)).toBe(500);

    const [claim] = await claims();
    expect(claim).toMatchObject({
      scheduled_transaction_id: scheduleId,
      due: "2024-01-01",
      posted: "2024-01-03",
      transaction_id: row.id,
      source: "rule",
      rule_id: ruleId,
    });
    expect(claim.pricing).toMatchObject({
      version: 1,
      dueDate: "2024-01-01",
      method: "LOAN",
      debtBefore: "200000.0000",
      lines: { principal: "500.00", interest: "1000.00", extra: "0.00" },
      outcome: "exact",
    });
    expect(await schedule()).toMatchObject({
      next_due_date: "2024-02-01",
      is_active: true,
    });
    expect((await schedule()).last_posted_date).not.toBeNull();

    // The loan moved by the principal only; the chequing by the row.
    expect(await balanceOf(loanId)).toBe(-199500);
    expect(await balanceOf(chequingId)).toBe(48500);

    // The stored trace names the claim and the cursor it moved.
    const [traced] = await db.query(
      `SELECT changes FROM transaction_rule_applications WHERE transaction_id = $1`,
      [row.id],
    );
    expect(traced.changes.loanSettlement.after).toMatchObject({
      claimId: claim.id,
      cursorAdvanced: true,
      cursor: {
        before: { nextDueDate: "2024-01-01" },
        after: { nextDueDate: "2024-02-01" },
      },
    });
  });

  it("rolls the split, the counterpart, the claim and the cursor back together when the create fails after the claim", async () => {
    // The source account's balance is written after the rules (and so after
    // the claim) in the same transaction; a failure there must leave nothing.
    const original = accounts.updateBalance.bind(accounts);
    jest
      .spyOn(accounts, "updateBalance")
      .mockImplementation(async (accountId, amount) => {
        if (accountId === chequingId)
          throw new Error("planted after the claim");
        return original(accountId, amount);
      });

    await expect(create("2024-01-03", -1500)).rejects.toThrow(
      "planted after the claim",
    );

    expect(await count("transactions")).toBe(0);
    expect(await count("transaction_splits")).toBe(0);
    expect(await count("scheduled_transaction_postings")).toBe(0);
    expect(await count("transaction_rule_applications")).toBe(0);
    expect(await schedule()).toMatchObject({
      next_due_date: "2024-01-01",
      last_posted_date: null,
    });
    expect(await balanceOf(loanId)).toBe(-200000);
    expect(await balanceOf(chequingId)).toBe(50000);
  });

  it("refuses a second row for the same slot as occurrence_already_posted and writes nothing for it", async () => {
    const first = await create("2024-01-03", -1500);
    const second = await create("2024-01-04", -1500);

    expect(await rowOf(second.id)).toMatchObject({
      is_split: false,
      category_id: null,
    });
    expect(await linesOf(second.id)).toEqual([]);
    const all = await claims();
    expect(all).toHaveLength(1);
    expect(all[0].transaction_id).toBe(first.id);
    // Only the first row's principal reached the loan.
    expect(await balanceOf(loanId)).toBe(-199500);
    // The rule's preview says why: the slot is taken, and the first row is
    // already a split.
    const preview = await asUser(() => runs.previewRun(userId, ruleId, {}));
    expect(preview.skipped).toEqual(
      expect.arrayContaining([
        {
          transactionId: second.id,
          reason: "occurrence_already_posted",
          detail: { dueDates: ["2024-01-01"] },
        },
        { transactionId: first.id, reason: "row_has_splits" },
      ]),
    );
  });

  it("releases the claim when the settling transaction is deleted, and keeps it when the transaction is voided", async () => {
    const row = await create("2024-01-03", -1500);
    expect(await count("scheduled_transaction_postings")).toBe(1);

    await asUser(() =>
      transactions.updateStatus(userId, row.id, TransactionStatus.VOID),
    );
    expect(await count("scheduled_transaction_postings")).toBe(1);
    // VOID moved no balance: the principal is back on the loan.
    expect(await balanceOf(loanId)).toBe(-200000);

    await asUser(() => transactions.remove(userId, row.id));
    expect(await count("scheduled_transaction_postings")).toBe(0);
    // The cursor is not rewound by a deletion (spec section 12.5).
    expect((await schedule()).next_due_date).toBe("2024-02-01");
  });

  describe("a bill post and a settlement of one slot, on two connections", () => {
    it("serialise on the schedule row lock: the post claims first, the settlement reads its claim and refuses", async () => {
      let release!: () => void;
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      let claimed!: (rows: unknown) => void;
      const postClaimed = new Promise<unknown>((resolve) => {
        claimed = resolve;
      });

      // T1: post()'s critical section, held open.
      const post = asUser(() =>
        withScopedDb(db, async (m) => {
          claimed(await postClaim(m));
          await released;
        }),
      );
      expect(await postClaimed).toEqual([{ id: expect.any(String) }]);

      // T2: the bank row's create; its settlement parks on the schedule lock.
      let settled: { id: string } | null = null;
      const settlement = create("2024-01-03", -1500).then((row) => {
        settled = row;
        return row;
      });
      await waitForBlockedBackends(1);
      expect(settled).toBeNull();

      release();
      await Promise.all([post, settlement]);

      // Exactly one claim, the post's; the row stayed a plain expense.
      const all = await claims();
      expect(all).toHaveLength(1);
      expect(all[0]).toMatchObject({ source: "post", transaction_id: null });
      expect(
        await rowOf((settled as unknown as { id: string }).id),
      ).toMatchObject({
        is_split: false,
      });
      expect(await balanceOf(loanId)).toBe(-200000);
    });

    it("the settlement claims first: the post's claim finds the key taken", async () => {
      const row = await create("2024-01-03", -1500);

      const lost = await asUser(() => withScopedDb(db, (m) => postClaim(m)));
      expect(lost).toEqual([]);

      const all = await claims();
      expect(all).toHaveLength(1);
      expect(all[0]).toMatchObject({ source: "rule", transaction_id: row.id });
    });
  });

  describe("the undo of runs that settled, on the database", () => {
    /** Run the rule over the rows in a date window; the create path never saw it (disabled). */
    const runOver = async (filters: {
      startDate?: string;
      endDate?: string;
    }) => {
      const preview = await asUser(() =>
        runs.previewRun(userId, ruleId, filters),
      );
      expect(preview.matched).toHaveLength(1);
      await asUser(() =>
        runs.run(userId, ruleId, {
          ...filters,
          fingerprint: preview.fingerprint,
        }),
      );
      await settlePendingHistoryWrites();
    };
    const overrides = async () =>
      db.query(
        `SELECT TO_CHAR(original_date, 'YYYY-MM-DD') AS original_date, amount, description
           FROM scheduled_transaction_overrides WHERE scheduled_transaction_id = $1`,
        [scheduleId],
      );

    beforeEach(async () => {
      await db.manager.update(TransactionRule, ruleId, { enabled: false });
      // An override on the January occurrence: the first advance prunes it.
      await db.manager.save(
        db.manager.create(ScheduledTransactionOverride, {
          scheduledTransactionId: scheduleId,
          originalDate: "2024-01-01",
          overrideDate: "2024-01-05",
          amount: -1480,
          description: "moved and trimmed",
        } as Partial<ScheduledTransactionOverride>),
      );
    });

    it("rewinds two advances in reverse order, restores the pruned override, and refuses the earlier run while the later stands", async () => {
      await create("2024-01-03", -1500);
      await create("2024-02-02", -1500);
      expect(await count("scheduled_transaction_postings")).toBe(0);

      // Run 1 settles January: X (Jan) to Y (Feb), pruning the override.
      await runOver({ endDate: "2024-01-31" });
      expect((await schedule()).next_due_date).toBe("2024-02-01");
      expect(await overrides()).toEqual([]);
      // Run 2 settles February on the debt January left: Y to Z (Mar).
      await runOver({ startDate: "2024-02-01" });
      expect((await schedule()).next_due_date).toBe("2024-03-01");
      expect(await balanceOf(loanId)).toBe(-200000 + 500 + 502.5);
      const [januaryClaim, februaryClaim] = await claims();
      expect(januaryClaim.pricing.debtBefore).toBe("200000.0000");
      expect(februaryClaim.pricing.debtBefore).toBe("199500.0000");

      // Undoing run 1 underneath run 2 is refused before any write: February
      // was priced on January's principal.
      const firstRun = await db.manager.findOne(ActionHistory, {
        where: { userId, entityType: "transaction_rule_run" },
        order: { createdAt: "ASC" },
      });
      expect(firstRun).not.toBeNull();
      const neverWrites = () => {
        throw new Error("the refusal must precede every write");
      };
      await expect(
        asUser(() =>
          withScopedDb(db, (m) =>
            undoRuleRun(firstRun!, m, {
              updateBalance: neverWrites,
              recalculateCurrentBalance: neverWrites,
            }),
          ),
        ),
      ).rejects.toMatchObject({
        response: expect.objectContaining({
          errorCode: "RULE_RUN_UNDO_LATER_SETTLEMENT",
          dueDate: "2024-02-01",
        }),
      });
      expect(await count("scheduled_transaction_postings")).toBe(2);
      expect((await schedule()).next_due_date).toBe("2024-03-01");

      // Last in, first out: run 2 (Z back to Y), then run 1 (Y back to X).
      await asUser(() => history.undo(userId));
      expect(await claims()).toHaveLength(1);
      expect((await claims())[0].id).toBe(januaryClaim.id);
      expect((await schedule()).next_due_date).toBe("2024-02-01");
      expect(await balanceOf(loanId)).toBe(-199500);
      expect(await overrides()).toEqual([]);

      await asUser(() => history.undo(userId));
      expect(await claims()).toEqual([]);
      expect(await schedule()).toMatchObject({
        next_due_date: "2024-01-01",
        is_active: true,
        last_posted_date: null,
      });
      expect(await balanceOf(loanId)).toBe(-200000);
      expect(await count("transaction_splits")).toBe(0);
      expect(
        (await db.query(`SELECT is_split FROM transactions`)).every(
          (r: { is_split: boolean }) => r.is_split === false,
        ),
      ).toBe(true);
      // The override the first advance pruned is back as it was.
      expect(await overrides()).toEqual([
        {
          original_date: "2024-01-01",
          amount: "-1480.00000000",
          description: "moved and trimmed",
        },
      ]);
      // And the template is priced on the restored debt again.
      expect(await templateLines()).toEqual([
        ["Interest", -1000],
        ["Principal", -500],
      ]);
    });
  });

  it("reprices the template to the next installment on the new debt after the commit", async () => {
    expect(await templateLines()).toEqual([
      ["Interest", -1000],
      ["Principal", -500],
    ]);

    await create("2024-01-03", -1500);

    // Next due date 2024-02-01 on 199,500 at 0.5 % a month: 997.50 interest.
    expect(await templateLines()).toEqual([
      ["Interest", -997.5],
      ["Principal", -502.5],
    ]);
  });

  describe("payment matching on the loan (B7)", () => {
    it("creates exactly one rule, last in the order and listed, with the bill's auto-post off and the loan pointing at it", async () => {
      await db.query(
        `UPDATE scheduled_transactions SET auto_post = true WHERE id = $1`,
        [scheduleId],
      );

      const rule = await asUser(() =>
        matching.createMatchingRule(userId, loanId, {
          payeePattern: "ING HYPOTHEKEN*",
        }),
      );

      const listed = await asUser(() => rulesService.list(userId));
      expect(listed.map((r) => r.id)).toEqual([ruleId, rule.id]);
      expect(listed[1]).toMatchObject({
        name: "Loan payment - Mortgage",
        position: 1,
        triggers: ["create", "import"],
        stopProcessing: true,
        invalid: false,
        condition: {
          all: [
            { field: "accountId", op: "eq", value: chequingId },
            { field: "type", op: "eq", value: "EXPENSE" },
            { field: "payeeText", op: "matches", value: "ING HYPOTHEKEN*" },
          ],
        },
        actions: [
          {
            type: "settle_loan_installment",
            loanAccountId: loanId,
            dueDateWindow: { daysBefore: 3, daysAfter: 7 },
            excess: "extra_principal",
            shortfall: "refuse",
          },
        ],
      });
      const [pointer] = await db.query(
        `SELECT payment_matching_rule_id FROM accounts WHERE id = $1`,
        [loanId],
      );
      expect(pointer.payment_matching_rule_id).toBe(rule.id);
      const [bill] = await db.query(
        `SELECT auto_post FROM scheduled_transactions WHERE id = $1`,
        [scheduleId],
      );
      expect(bill.auto_post).toBe(false);

      // A second request for the loan is refused and writes no second rule.
      await expect(
        asUser(() =>
          matching.createMatchingRule(userId, loanId, {
            payeePattern: "ING*",
          }),
        ),
      ).rejects.toMatchObject({ status: 409 });
      expect(await count("transaction_rules")).toBe(2);
    });

    it("settles the bank debit it matches, and the loan's settled installments name it", async () => {
      await db.query(`DELETE FROM transaction_rules WHERE id = $1`, [ruleId]);
      const rule = await asUser(() =>
        matching.createMatchingRule(userId, loanId, {
          payeePattern: "ING HYPOTHEKEN*",
        }),
      );

      const row = await create("2024-01-03", -1500, "ING HYPOTHEKEN 123");

      const settled = await asUser(() =>
        matching.listSettlements(userId, loanId),
      );
      expect(settled).toEqual([
        {
          claimId: expect.any(String),
          dueDate: "2024-01-01",
          postedDate: "2024-01-03",
          transactionId: row.id,
          transactionStatus: TransactionStatus.UNRECONCILED,
          principal: 500,
          interest: 1000,
          extraPrincipal: 0,
          debtBefore: 200000,
          installmentNumber: 1,
          ruleId: rule.id,
        },
      ]);
    });

    it("lists only the owner's settled installments, and another user's loan is a 404", async () => {
      const mine = await create("2024-01-03", -1500);

      // A second user with a loan, a schedule and a rule claim of their own.
      const otherId = (await createTestUserDirect(db)).id;
      const otherChequing = (
        await createTestAccount(db, otherId, {
          name: "Other chequing",
          currencyCode: "EUR",
          openingBalance: 5000,
          currentBalance: 5000,
        })
      ).id;
      const otherLoan = (
        await createTestAccount(db, otherId, {
          name: "Other loan",
          accountType: AccountType.LOAN,
          currencyCode: "EUR",
          openingBalance: -1000,
          currentBalance: -1000,
        })
      ).id;
      const otherSchedule = (
        await db.manager.save(
          db.manager.create(ScheduledTransaction, {
            userId: otherId,
            accountId: otherChequing,
            name: "Other payment",
            amount: -100,
            currencyCode: "EUR",
            frequency: "MONTHLY",
            startDate: "2024-01-01",
            nextDueDate: "2024-01-01",
            isActive: true,
            autoPost: false,
          } as Partial<ScheduledTransaction>),
        )
      ).id;
      await db.manager.update(Account, otherLoan, {
        scheduledTransactionId: otherSchedule,
      });
      const theirs = await withUserContext(otherId, () =>
        transactions.create(otherId, {
          accountId: otherChequing,
          transactionDate: "2024-01-02",
          amount: -100,
          currencyCode: "EUR",
          payeeName: "Other bank",
        } as never),
      );
      await db.query(
        `INSERT INTO scheduled_transaction_postings
           (scheduled_transaction_id, original_due_date, posted_date,
            transaction_id, source, pricing)
         VALUES ($1, '2024-01-01', '2024-01-02', $2, 'rule', '{"installmentNumber": 1}'::jsonb)`,
        [otherSchedule, theirs.id],
      );

      const own = await asUser(() => matching.listSettlements(userId, loanId));
      expect(own.map((s) => s.transactionId)).toEqual([mine.id]);
      await expect(
        asUser(() => matching.listSettlements(userId, otherLoan)),
      ).rejects.toBeInstanceOf(NotFoundException);
      await expect(
        withUserContext(otherId, () =>
          matching.listSettlements(otherId, loanId),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
      const others = await withUserContext(otherId, () =>
        matching.listSettlements(otherId, otherLoan),
      );
      expect(others.map((s) => s.transactionId)).toEqual([theirs.id]);
    });
  });
});
