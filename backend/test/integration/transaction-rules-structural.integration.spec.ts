import { TestingModule } from "@nestjs/testing";
import { DataSource } from "typeorm";

import {
  ActionHistoryService,
  settlePendingHistoryWrites,
} from "@/action-history/action-history.service";
import { withUserContext } from "@/common/db/with-context";
import { CreateTransactionRuleDto } from "@/transaction-rules/dto/create-transaction-rule.dto";
import { TransactionRulesModule } from "@/transaction-rules/transaction-rules.module";
import { TransactionRulesService } from "@/transaction-rules/transaction-rules.service";
import { TransactionRulesRunService } from "@/transaction-rules/transaction-rules-run.service";
import { TransactionsModule } from "@/transactions/transactions.module";
import { TransactionsService } from "@/transactions/transactions.service";

import {
  cleanTables,
  createEnforcedIntegrationModule,
  createTestUserDirect,
  EnforcedIntegrationHarness,
} from "../helpers/integration-setup";
import {
  createTestAccount,
  createTestCategory,
  createTestPayee,
} from "../helpers/test-factories";

/**
 * The acceptance case of docs/specs/transaction-rules-structural-actions.md
 * section 7 against a real PostgreSQL enforcing RLS, on anonymized data: a
 * loan instalment whose statement line carries the principal and the interest
 * in one text. Three rules, all with an active window, each ending the pass.
 *
 * The dates are 2025-10-xx where the spec says 2026-10-xx: the suite must give
 * the same answer on any day, and a row dated after today is not in
 * `current_balance` (a future-dated row is folded in by the nightly job), which
 * would make the balance assertions depend on the clock. The window arithmetic
 * is the same.
 */
describe("Transaction rules structural actions (integration)", () => {
  jest.setTimeout(240000);

  const REFERENCE = "LOAN-0000-EXAMPLE";
  const FROM = "2025-10-01";
  const IN_WINDOW = "2025-10-05";
  const BEFORE_WINDOW = "2025-09-07";

  let harness: EnforcedIntegrationHarness;
  let module: TestingModule;
  let db: DataSource;
  let transactions: TransactionsService;
  let rules: TransactionRulesService;
  let run: TransactionRulesRunService;
  let history: ActionHistoryService;

  let aliceId: string;
  let checkingId: string;
  let loanId: string;
  let interestId: string;
  let repaymentId: string;
  let overpaymentId: string;

  const asAlice = <T>(fn: () => Promise<T>) => withUserContext(aliceId, fn);

  const text = (principal: string, interest: string) =>
    `PRINCIPAL: ${principal} INTEREST: ${interest}PENALTY: 0,00${REFERENCE}`;

  const loanCondition = (pattern: string) => ({
    all: [
      {
        any: [
          { field: "payeeText", op: "contains", value: REFERENCE },
          { field: "description", op: "contains", value: REFERENCE },
        ],
      },
      { field: "payeeText", op: "matches", value: pattern },
    ],
  });

  const ruleDto = (
    name: string,
    pattern: string,
    actions: unknown[],
    over: Partial<CreateTransactionRuleDto> = {},
  ) =>
    ({
      name,
      triggers: ["create"],
      condition: loanCondition(pattern),
      actions,
      stopProcessing: true,
      activeFrom: FROM,
      ...over,
    }) as unknown as CreateTransactionRuleDto;

  const createThreeRules = async (
    over: Partial<CreateTransactionRuleDto> = {},
  ) => {
    await asAlice(async () => {
      await rules.create(
        aliceId,
        ruleDto(
          "Interest only",
          "PRINCIPAL: 0,00 INTEREST: *",
          [
            { type: "set_category", categoryId: interestId },
            { type: "set_payee", payeeId: repaymentId },
          ],
          over,
        ),
      );
      await rules.create(
        aliceId,
        ruleDto(
          "Principal only",
          "PRINCIPAL: * INTEREST: 0,00PENALTY*",
          [
            {
              type: "convert_to_transfer",
              toAccountId: loanId,
              clearCategory: true,
              payeeId: repaymentId,
            },
          ],
          over,
        ),
      );
      await rules.create(
        aliceId,
        ruleDto(
          "Principal and interest",
          "PRINCIPAL: {principal} INTEREST: {interest}PENALTY*",
          [
            {
              type: "split",
              payeeId: repaymentId,
              parts: [
                {
                  amount: "{principal}",
                  transferAccountId: loanId,
                  payeeId: overpaymentId,
                },
                { amount: "{interest}", categoryId: interestId },
              ],
            },
          ],
          over,
        ),
      );
    });
  };

  const create = (transactionDate: string, amount: number, payee: string) =>
    asAlice(() =>
      transactions.create(aliceId, {
        accountId: checkingId,
        transactionDate,
        amount,
        currencyCode: "PLN",
        payeeName: payee,
      } as never),
    );

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
        `SELECT id, account_id, TO_CHAR(transaction_date, 'YYYY-MM-DD') AS date,
                amount, category_id, payee_id, payee_name, is_transfer,
                is_split, linked_transaction_id, status
           FROM transactions WHERE id = $1`,
        [id],
      )
    )[0];

  const splitsOf = async (id: string) =>
    (
      await db.query(
        `SELECT kind, amount, category_id, transfer_account_id,
                linked_transaction_id
           FROM transaction_splits WHERE transaction_id = $1
          ORDER BY amount`,
        [id],
      )
    ).map((s: Record<string, string | null>) => ({
      ...s,
      amount: Number(s.amount),
    }));

  const countRows = async (): Promise<number> =>
    Number((await db.query(`SELECT COUNT(*) AS n FROM transactions`))[0].n);

  beforeAll(async () => {
    harness = await createEnforcedIntegrationModule([
      TransactionsModule,
      TransactionRulesModule,
    ]);
    module = harness.module;
    db = harness.owner;
    transactions = module.get(TransactionsService);
    rules = module.get(TransactionRulesService);
    run = module.get(TransactionRulesRunService);
    history = module.get(ActionHistoryService, { strict: false });
  });

  afterAll(async () => {
    await settlePendingHistoryWrites();
    await harness.close();
  });

  beforeEach(async () => {
    await settlePendingHistoryWrites();
    await cleanTables(db, [
      "transaction_rule_applications",
      "transaction_rules",
      "action_history",
      "user_preferences",
      "transaction_splits",
      "transactions",
      "monthly_account_balances",
      "payees",
      "accounts",
      "categories",
      "users",
    ]);
    await db.query(
      `INSERT INTO currencies (code, name, symbol, decimal_places) VALUES ('PLN', 'Zloty', 'zl', 2) ON CONFLICT DO NOTHING`,
    );
    aliceId = (await createTestUserDirect(db, { firstName: "Alice" })).id;
    checkingId = (
      await createTestAccount(db, aliceId, {
        name: "Checking",
        currencyCode: "PLN",
        openingBalance: 5000,
        currentBalance: 5000,
      })
    ).id;
    loanId = (
      await createTestAccount(db, aliceId, {
        name: "Loan account",
        accountType: "LOAN",
        currencyCode: "PLN",
        openingBalance: -20000,
        currentBalance: -20000,
      })
    ).id;
    const loans = await createTestCategory(db, aliceId, { name: "Loans" });
    interestId = (
      await createTestCategory(db, aliceId, {
        name: "Interest",
        parentId: loans.id,
      })
    ).id;
    repaymentId = (
      await createTestPayee(db, aliceId, { name: "Loan repayment" })
    ).id;
    overpaymentId = (
      await createTestPayee(db, aliceId, { name: "Loan overpayment" })
    ).id;
  });

  describe("on create (the acceptance case)", () => {
    it("books each instalment as the rules say, and moves the loan balance by the principal only", async () => {
      await createThreeRules();

      const interestOnly = await create(
        IN_WINDOW,
        -85.4,
        text("0,00", "85,40"),
      );
      const principalOnly = await create(
        IN_WINDOW,
        -640.15,
        text("640,15", "0,00"),
      );
      const both = await create(IN_WINDOW, -1500.75, text("1200,50", "300,25"));
      const mismatch = await create(
        IN_WINDOW,
        -1510.75,
        text("1200,50", "300,25"),
      );

      // Rule 1: an expense with the interest category and the repayment payee.
      expect(await rowOf(interestOnly.id)).toMatchObject({
        category_id: interestId,
        payee_id: repaymentId,
        payee_name: "Loan repayment",
        is_transfer: false,
        is_split: false,
        linked_transaction_id: null,
      });

      // Rule 2: one leg of a transfer; the other leg is in the loan account.
      const converted = await rowOf(principalOnly.id);
      expect(converted).toMatchObject({
        category_id: null,
        payee_id: repaymentId,
        payee_name: "Loan repayment",
        is_transfer: true,
        account_id: checkingId,
        date: IN_WINDOW,
      });
      expect(Number(converted.amount)).toBe(-640.15);
      const counterpart = await rowOf(converted.linked_transaction_id);
      expect(counterpart).toMatchObject({
        account_id: loanId,
        date: IN_WINDOW,
        is_transfer: true,
        linked_transaction_id: principalOnly.id,
        payee_id: repaymentId,
        category_id: null,
        status: converted.status,
      });
      expect(Number(counterpart.amount)).toBe(640.15);

      // Rule 3: a split, the principal a transfer part and the interest a category.
      const split = await rowOf(both.id);
      expect(split).toMatchObject({
        is_split: true,
        category_id: null,
        payee_id: repaymentId,
        payee_name: "Loan repayment",
        is_transfer: false,
      });
      const lines = await splitsOf(both.id);
      expect(lines).toHaveLength(2);
      expect(lines[0]).toMatchObject({
        amount: -1200.5,
        kind: "transfer",
        transfer_account_id: loanId,
        category_id: null,
      });
      expect(lines[1]).toMatchObject({
        amount: -300.25,
        kind: "category",
        category_id: interestId,
        transfer_account_id: null,
      });
      const leg = await rowOf(lines[0].linked_transaction_id as string);
      expect(leg).toMatchObject({
        account_id: loanId,
        date: IN_WINDOW,
        linked_transaction_id: both.id,
        payee_id: overpaymentId,
        payee_name: "Loan overpayment",
      });
      expect(Number(leg.amount)).toBe(1200.5);

      // The sum does not match: rule 3 is skipped, the row stays a plain expense.
      const untouched = await rowOf(mismatch.id);
      expect(untouched).toMatchObject({
        category_id: null,
        is_split: false,
        is_transfer: false,
        linked_transaction_id: null,
      });
      expect(await splitsOf(mismatch.id)).toEqual([]);

      // Rows: four instalments, one counterpart, one split leg.
      expect(await countRows()).toBe(6);
      // Principal only reaches the loan account: 640.15 + 1200.50.
      expect(await balanceOf(loanId)).toBe(-20000 + 1840.65);
      // The checking account moved by the four amounts and nothing else.
      expect(await balanceOf(checkingId)).toBe(
        Math.round((5000 - 85.4 - 640.15 - 1500.75 - 1510.75) * 100) / 100,
      );
      // The trace names the counterpart legs the rules created.
      const traced = await db.query(
        `SELECT changes FROM transaction_rule_applications WHERE transaction_id = ANY($1)`,
        [[principalOnly.id, both.id]],
      );
      expect(
        traced
          .map(
            (r: {
              changes: { structure: { after: { counterpartIds: string[] } } };
            }) => r.changes.structure.after.counterpartIds.length,
          )
          .sort(),
      ).toEqual([1, 1]);
    });

    it("leaves a row dated before the window alone: no structure, no loan movement", async () => {
      await createThreeRules();
      const before = await create(
        BEFORE_WINDOW,
        -1500.75,
        text("1200,50", "300,25"),
      );
      expect(await rowOf(before.id)).toMatchObject({
        category_id: null,
        is_split: false,
        is_transfer: false,
        payee_name: text("1200,50", "300,25"),
      });
      expect(await countRows()).toBe(1);
      expect(await balanceOf(loanId)).toBe(-20000);
      expect(
        await db.query(`SELECT 1 FROM transaction_rule_applications`),
      ).toEqual([]);
    });

    it("a rolled-back create leaves no counterpart and no balance movement", async () => {
      await createThreeRules();
      await expect(
        asAlice(() =>
          transactions.create(aliceId, {
            accountId: checkingId,
            transactionDate: IN_WINDOW,
            amount: -640.15,
            currencyCode: "EUR",
            payeeName: text("640,15", "0,00"),
          } as never),
        ),
      ).rejects.toThrow();
      expect(await countRows()).toBe(0);
      expect(await balanceOf(loanId)).toBe(-20000);
    });

    it("a future-dated conversion creates the counterpart but the loan's current balance waits for the date", async () => {
      await createThreeRules();
      const future = await create(
        "2999-01-01",
        -640.15,
        text("640,15", "0,00"),
      );
      const converted = await rowOf(future.id);
      expect(converted.is_transfer).toBe(true);
      expect(await rowOf(converted.linked_transaction_id)).toMatchObject({
        account_id: loanId,
      });
      expect(await balanceOf(loanId)).toBe(-20000);
    });
  });

  describe("on a manual run", () => {
    it("previews and writes the split over an existing row, and the undo puts everything back", async () => {
      // The row exists before any rule does, so only the run can structure it.
      const existing = await create(
        IN_WINDOW,
        -1500.75,
        text("1200,50", "300,25"),
      );
      const original = await rowOf(existing.id);
      await createThreeRules({ triggers: ["import"] } as never);
      const [, , splitRule] = await asAlice(() => rules.list(aliceId));
      expect(await balanceOf(loanId)).toBe(-20000);

      const preview = await asAlice(() =>
        run.previewRun(aliceId, splitRule.id, {}),
      );
      expect(preview.matched).toHaveLength(1);
      expect(preview.matched[0].changes.structure?.after).toMatchObject({
        kind: "split",
        parts: [
          { amount: -1200.5, transferAccountId: loanId },
          { amount: -300.25, categoryId: interestId },
        ],
      });
      // Nothing is written by a preview.
      expect(await countRows()).toBe(1);
      expect(await balanceOf(loanId)).toBe(-20000);

      const result = await asAlice(() =>
        run.run(aliceId, splitRule.id, { fingerprint: preview.fingerprint }),
      );
      expect(result.changed).toBe(1);
      expect(await rowOf(existing.id)).toMatchObject({
        is_split: true,
        category_id: null,
        payee_id: repaymentId,
      });
      expect(await splitsOf(existing.id)).toHaveLength(2);
      expect(await countRows()).toBe(2);
      expect(await balanceOf(loanId)).toBe(-20000 + 1200.5);

      // Undo: the counterpart goes, the loan balance is reversed by exactly
      // what it contributed, the split lines go, the row is as it was.
      const undone = await asAlice(() => history.undo(aliceId));
      expect(undone.description).toContain("Undone");
      expect(await countRows()).toBe(1);
      expect(await splitsOf(existing.id)).toEqual([]);
      expect(await balanceOf(loanId)).toBe(-20000);
      expect(await rowOf(existing.id)).toMatchObject({
        is_split: false,
        is_transfer: false,
        linked_transaction_id: null,
        category_id: original.category_id,
        payee_id: original.payee_id,
        payee_name: original.payee_name,
      });

      // Redo of a run that restructured a row is refused, and changes nothing.
      await expect(asAlice(() => history.redo(aliceId))).rejects.toMatchObject({
        response: expect.objectContaining({
          errorCode: "RULE_RUN_REDO_STRUCTURAL",
        }),
      });
      expect(await countRows()).toBe(1);
      expect(await balanceOf(loanId)).toBe(-20000);
    });

    it("converts an existing row, and the undo removes the counterpart and restores the category", async () => {
      const existing = await create(IN_WINDOW, -640.15, text("640,15", "0,00"));
      await db.query(`UPDATE transactions SET category_id = $2 WHERE id = $1`, [
        existing.id,
        interestId,
      ]);
      await createThreeRules({ triggers: ["import"] } as never);
      const [, convertRule] = await asAlice(() => rules.list(aliceId));

      const preview = await asAlice(() =>
        run.previewRun(aliceId, convertRule.id, {}),
      );
      await asAlice(() =>
        run.run(aliceId, convertRule.id, {
          fingerprint: preview.fingerprint,
        }),
      );
      expect(await rowOf(existing.id)).toMatchObject({
        is_transfer: true,
        category_id: null,
      });
      expect(await balanceOf(loanId)).toBe(-20000 + 640.15);
      // The row's own account is untouched by the conversion.
      expect(await balanceOf(checkingId)).toBe(5000 - 640.15);

      await asAlice(() => history.undo(aliceId));
      expect(await countRows()).toBe(1);
      expect(await rowOf(existing.id)).toMatchObject({
        is_transfer: false,
        linked_transaction_id: null,
        category_id: interestId,
      });
      expect(await balanceOf(loanId)).toBe(-20000);
      expect(await balanceOf(checkingId)).toBe(5000 - 640.15);
    });
  });

  describe("undo of the create that a rule restructured", () => {
    it("removes the conversion's counterpart and puts the loan balance back", async () => {
      await createThreeRules();
      const created = await create(IN_WINDOW, -640.15, text("640,15", "0,00"));
      expect(await balanceOf(loanId)).toBe(-20000 + 640.15);
      expect(await countRows()).toBe(2);
      await settlePendingHistoryWrites();

      const undone = await asAlice(() => history.undo(aliceId));
      expect(undone.description).toContain("Undone");

      // The row and its counterpart are gone; neither account keeps a trace.
      expect(await countRows()).toBe(0);
      expect(await balanceOf(loanId)).toBe(-20000);
      expect(await balanceOf(checkingId)).toBe(5000);
      expect(await rowOf(created.id)).toBeUndefined();

      // Redo of a create that wrote a leg elsewhere is refused, nothing written.
      await expect(asAlice(() => history.redo(aliceId))).rejects.toMatchObject({
        response: expect.objectContaining({
          errorCode: "REDO_CREATE_WITH_LEGS",
        }),
      });
      expect(await countRows()).toBe(0);
      expect(await balanceOf(loanId)).toBe(-20000);
    });

    it("removes the legs of a split's transfer parts and reverses each", async () => {
      await createThreeRules();
      await create(IN_WINDOW, -1500.75, text("1200,50", "300,25"));
      expect(await balanceOf(loanId)).toBe(-20000 + 1200.5);
      expect(await countRows()).toBe(2);
      await settlePendingHistoryWrites();

      await asAlice(() => history.undo(aliceId));

      expect(await countRows()).toBe(0);
      expect(
        Number(
          (await db.query(`SELECT COUNT(*) AS n FROM transaction_splits`))[0].n,
        ),
      ).toBe(0);
      expect(await balanceOf(loanId)).toBe(-20000);
      expect(await balanceOf(checkingId)).toBe(5000);
    });
  });

  describe("a split run undone after the lines were replaced", () => {
    it("refuses with RULE_RUN_UNDO_STRUCTURE_CHANGED and changes nothing", async () => {
      const existing = await create(
        IN_WINDOW,
        -1500.75,
        text("1200,50", "300,25"),
      );
      await createThreeRules({ triggers: ["import"] } as never);
      const [, , splitRule] = await asAlice(() => rules.list(aliceId));
      const preview = await asAlice(() =>
        run.previewRun(aliceId, splitRule.id, {}),
      );
      await asAlice(() =>
        run.run(aliceId, splitRule.id, { fingerprint: preview.fingerprint }),
      );
      expect(await balanceOf(loanId)).toBe(-20000 + 1200.5);

      // A person replaces the split (PUT /transactions/:id/splits records no
      // history, so the run stays the head of the undo stack): the old
      // counterpart goes, a new one for 1000.00 is created.
      await asAlice(() =>
        transactions.updateSplits(aliceId, existing.id, [
          { amount: -1000, transferAccountId: loanId },
          { amount: -500.75, categoryId: interestId },
        ] as never),
      );
      expect(await balanceOf(loanId)).toBe(-20000 + 1000);
      const rowsBefore = await countRows();
      await settlePendingHistoryWrites();

      await expect(asAlice(() => history.undo(aliceId))).rejects.toMatchObject({
        response: expect.objectContaining({
          errorCode: "RULE_RUN_UNDO_STRUCTURE_CHANGED",
        }),
      });

      // Refused before any write: the person's lines, their counterpart and
      // both balances are exactly as they were.
      expect(await countRows()).toBe(rowsBefore);
      expect(await splitsOf(existing.id)).toHaveLength(2);
      expect(await rowOf(existing.id)).toMatchObject({ is_split: true });
      expect(await balanceOf(loanId)).toBe(-20000 + 1000);
      expect(
        await db.query(`SELECT 1 FROM action_history WHERE is_undone = true`),
      ).toEqual([]);
    });
  });

  describe("the conversion's amount is part of the run fingerprint", () => {
    it("refuses a commit when the row's amount changed since the preview", async () => {
      const existing = await create(IN_WINDOW, -640.15, text("640,15", "0,00"));
      await createThreeRules({ triggers: ["import"] } as never);
      const [, convertRule] = await asAlice(() => rules.list(aliceId));
      const preview = await asAlice(() =>
        run.previewRun(aliceId, convertRule.id, {}),
      );
      expect(preview.matched[0].changes.structure?.after).toMatchObject({
        kind: "transfer",
        accountId: loanId,
        amount: 640.15,
      });

      // Another tab edits the amount between the preview and the commit.
      await db.query(`UPDATE transactions SET amount = -650 WHERE id = $1`, [
        existing.id,
      ]);

      await expect(
        asAlice(() =>
          run.run(aliceId, convertRule.id, {
            fingerprint: preview.fingerprint,
          }),
        ),
      ).rejects.toMatchObject({
        response: expect.objectContaining({ errorCode: "PREVIEW_CHANGED" }),
      });
      expect(await countRows()).toBe(1);
      expect(await balanceOf(loanId)).toBe(-20000);
    });
  });
});
