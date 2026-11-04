import { LoanFee } from "../loan-fees/entities/loan-fee.entity";

import { DataSource } from "typeorm";
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from "@nestjs/common";
import { createScopedDbMocks } from "../test-helpers/scoped-db-testing";

/** The mortgage fees a case configures; none unless it says otherwise. */
const loanFeesMock = { find: jest.fn() };
beforeEach(() => loanFeesMock.find.mockReset().mockResolvedValue([]));

jest.mock("../common/db/scoped-db", () =>
  jest.requireActual("../test-helpers/scoped-db-testing").scopedDbMockModule(),
);
import {
  LoanPaymentMatchingService,
  MAX_LOAN_SETTLEMENTS_LISTED,
  PAYMENT_MATCHING_FAILED,
  paymentMatchingRule,
} from "./loan-payment-matching.service";
import { Account, AccountType } from "./entities/account.entity";
import { ScheduledTransaction } from "../scheduled-transactions/entities/scheduled-transaction.entity";
import { TransactionRulesService } from "../transaction-rules/transaction-rules.service";
import { TransactionRuleResponseDto } from "../transaction-rules/dto/transaction-rule-response.dto";
import { RULE_TRANSACTION_TYPES } from "../transaction-rules/rule-condition.types";
import { validateRuleDefinition } from "../transaction-rules/rule-validation";

/**
 * The "Payment matching" rule of a loan (docs/specs/loan-installment-settlement.md
 * decision 5, section 16 row B7): its exact definition, its creation with the
 * pointer and auto-post off in one transaction, the refusals that write
 * nothing, the reported failure, and the read of the settled installments.
 */
describe("LoanPaymentMatchingService", () => {
  const userId = "user-1";
  const loanId = "6f1d3c2a-8b4e-4f7a-9c1d-2e3f4a5b6c7d";
  const sourceId = "1a2b3c4d-5e6f-4a1b-8c2d-3e4f5a6b7c8d";
  const scheduleId = "sched-1";

  const loan = (overrides: Partial<Account> = {}): Account =>
    ({
      id: loanId,
      userId,
      name: "Hypotheek",
      accountType: AccountType.MORTGAGE,
      scheduledTransactionId: scheduleId,
      paymentMatchingRuleId: null,
      ...overrides,
    }) as Account;

  const schedule = {
    id: scheduleId,
    userId,
    accountId: sourceId,
    autoPost: true,
  } as ScheduledTransaction;

  /** What `TransactionRulesService.create` returns: the saved rule, last in the order. */
  const createdRule = (
    dto: Parameters<TransactionRulesService["create"]>[1],
  ): TransactionRuleResponseDto => ({
    id: "rule-9",
    name: dto.name,
    enabled: dto.enabled ?? true,
    position: 7,
    triggers: dto.triggers,
    condition:
      dto.condition as unknown as TransactionRuleResponseDto["condition"],
    actions: dto.actions as unknown as TransactionRuleResponseDto["actions"],
    stopProcessing: dto.stopProcessing ?? false,
    activeFrom: null,
    activeTo: null,
    revision: 1,
    createdAt: new Date("2026-10-08T00:00:00Z"),
    updatedAt: new Date("2026-10-08T00:00:00Z"),
    invalid: false,
    invalidReasons: [],
  });

  let service: LoanPaymentMatchingService;
  let accounts: Record<string, jest.Mock>;
  let schedules: Record<string, jest.Mock>;
  let manager: ReturnType<typeof createScopedDbMocks>["manager"];
  let rules: jest.Mocked<
    Pick<TransactionRulesService, "create" | "assertDefinitionShape">
  >;
  let calls: string[];

  beforeEach(() => {
    calls = [];
    accounts = {
      findOne: jest.fn(async (options: { lock?: unknown }) => {
        calls.push(options.lock ? "account:lock" : "account:read");
        return loan();
      }),
      update: jest.fn(async () => {
        calls.push("account:update");
      }),
    };
    schedules = {
      findOne: jest.fn(async () => {
        calls.push("schedule:lock");
        return schedule;
      }),
      update: jest.fn(async () => {
        calls.push("schedule:update");
      }),
    };
    rules = {
      create: jest.fn(async (_userId, dto) => {
        calls.push("rule:create");
        return createdRule(dto);
      }),
      assertDefinitionShape: jest.fn(),
    };
    const mocks = createScopedDbMocks([
      [LoanFee, loanFeesMock],
      [Account, accounts],
      [ScheduledTransaction, schedules],
    ]);
    manager = mocks.manager;
    service = new LoanPaymentMatchingService(
      mocks.dataSource as unknown as DataSource,
      rules as unknown as TransactionRulesService,
    );
  });

  describe("paymentMatchingRule", () => {
    it("builds the exact condition tree and settlement action of spec decision 5", () => {
      const rule = paymentMatchingRule(loan(), sourceId, {
        payeePattern: "ING HYPOTHEKEN*",
        descriptionPattern: "*Hypotheek*",
      });

      expect(rule).toEqual({
        name: "Mortgage payment - Hypotheek",
        enabled: true,
        triggers: ["create", "import"],
        stopProcessing: true,
        condition: {
          all: [
            { field: "accountId", op: "eq", value: sourceId },
            { field: "type", op: "eq", value: "EXPENSE" },
            { field: "payeeText", op: "matches", value: "ING HYPOTHEKEN*" },
            { field: "description", op: "matches", value: "*Hypotheek*" },
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
      // The type leaf names the debit value of the engine's own list.
      expect(RULE_TRANSACTION_TYPES).toContain(
        (rule.condition.all as { value: string }[])[1].value,
      );
    });

    it("leaves the description leaf out when no description pattern is given, and carries the policies", () => {
      const rule = paymentMatchingRule(
        loan({ accountType: AccountType.LOAN, name: "Car" }),
        sourceId,
        {
          payeePattern: "TOYOTA*",
          descriptionPattern: "",
          excess: "refuse",
          shortfall: "interest_first",
        },
      );

      expect(rule.name).toBe("Loan payment - Car");
      expect(rule.condition).toEqual({
        all: [
          { field: "accountId", op: "eq", value: sourceId },
          { field: "type", op: "eq", value: "EXPENSE" },
          { field: "payeeText", op: "matches", value: "TOYOTA*" },
        ],
      });
      expect(rule.actions[0]).toMatchObject({
        excess: "refuse",
        shortfall: "interest_first",
      });
    });

    it("is a definition the rule validator accepts as authored", () => {
      const rule = paymentMatchingRule(loan(), sourceId, {
        payeePattern: "ING*",
        descriptionPattern: "*Hypotheek*",
      });

      expect(
        validateRuleDefinition(
          { condition: rule.condition, actions: rule.actions },
          { authoring: true },
        ),
      ).toEqual([]);
    });

    it("bounds the name to the rule name limit and strips angle brackets", () => {
      const rule = paymentMatchingRule(
        loan({ name: `<b>${"x".repeat(120)}` }),
        sourceId,
        { payeePattern: "ING*" },
      );

      expect(rule.name).toHaveLength(100);
      expect(rule.name).not.toMatch(/[<>]/);
    });
  });

  describe("assertDefinable", () => {
    it("checks the rule the request would build, before the loan exists", () => {
      service.assertDefinable(sourceId, { payeePattern: "ING*" });

      const [condition, actions] = rules.assertDefinitionShape.mock.calls[0];
      expect(condition).toEqual(
        paymentMatchingRule(loan(), sourceId, { payeePattern: "ING*" })
          .condition,
      );
      expect(actions).toEqual([
        expect.objectContaining({
          type: "settle_loan_installment",
          loanAccountId: "00000000-0000-0000-0000-000000000000",
        }),
      ]);
    });

    it("refuses a regex-looking pattern with the rule create's own 400", () => {
      const real = new LoanPaymentMatchingService(
        {} as DataSource,
        new TransactionRulesService({} as DataSource),
      );

      let thrown: unknown;
      try {
        real.assertDefinable(sourceId, { payeePattern: "ING|ABN*" });
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(BadRequestException);
      expect((thrown as BadRequestException).getResponse()).toMatchObject({
        errorCode: "INVALID_RULE",
        errors: [{ path: "condition.all[2].value", code: "LOOKS_LIKE_REGEX" }],
      });
      expect(() =>
        real.assertDefinable(sourceId, { payeePattern: "ING*" }),
      ).not.toThrow();
    });
  });

  describe("createMatchingRule", () => {
    it("creates the rule over the schedule's source account, points the loan at it and turns auto-post off", async () => {
      const rule = await service.createMatchingRule(userId, loanId, {
        payeePattern: "ING*",
      });

      expect(rules.create).toHaveBeenCalledTimes(1);
      expect(rules.create).toHaveBeenCalledWith(
        userId,
        paymentMatchingRule(loan(), sourceId, { payeePattern: "ING*" }),
      );
      // The rule the create appended, as it returned it.
      expect(rule).toMatchObject({ id: "rule-9", position: 7 });
      expect(accounts.update).toHaveBeenCalledWith(
        { id: loanId, userId },
        { paymentMatchingRuleId: "rule-9" },
      );
      expect(schedules.update).toHaveBeenCalledWith(
        { id: scheduleId, userId },
        { autoPost: false },
      );
    });

    it("takes the schedule row lock before the account's, and checks both before the create, in one transaction", async () => {
      await service.createMatchingRule(userId, loanId, {
        payeePattern: "ING*",
      });

      expect(calls).toEqual([
        "account:read",
        "schedule:lock",
        "account:lock",
        "rule:create",
        "account:update",
        "schedule:update",
      ]);
      expect(schedules.findOne).toHaveBeenCalledWith({
        where: { id: scheduleId, userId },
        lock: { mode: "pessimistic_write" },
      });
      expect(accounts.findOne).toHaveBeenLastCalledWith({
        where: { id: loanId, userId },
        lock: { mode: "pessimistic_write" },
      });
    });

    const refusals: Array<
      [string, () => void, new (...args: never[]) => Error]
    > = [
      [
        "another user's or a missing loan",
        () => accounts.findOne.mockResolvedValue(null),
        NotFoundException,
      ],
      [
        "a line of credit",
        () =>
          accounts.findOne.mockResolvedValue(
            loan({ accountType: AccountType.LINE_OF_CREDIT }),
          ),
        BadRequestException,
      ],
      [
        "a loan with no scheduled payment",
        () =>
          accounts.findOne.mockResolvedValue(
            loan({ scheduledTransactionId: null }),
          ),
        BadRequestException,
      ],
      [
        "a schedule that is not the user's",
        () => schedules.findOne.mockResolvedValue(null),
        BadRequestException,
      ],
      [
        "a loan that already has its rule",
        () =>
          accounts.findOne.mockResolvedValue(
            loan({ paymentMatchingRuleId: "rule-1" }),
          ),
        ConflictException,
      ],
      [
        // docs/specs/mortgage-fees.md section 8: the settlement does not
        // price fee lines, so a rule would refuse every bank debit.
        "a mortgage whose payment carries fees",
        () => {
          accounts.findOne.mockResolvedValue(
            loan({ accountType: AccountType.MORTGAGE }),
          );
          loanFeesMock.find.mockResolvedValue([{ categoryId: "cat-tax" }]);
        },
        BadRequestException,
      ],
    ];

    it.each(refusals)(
      "refuses %s and writes nothing",
      async (_label, arrange, error) => {
        arrange();

        await expect(
          service.createMatchingRule(userId, loanId, { payeePattern: "ING*" }),
        ).rejects.toBeInstanceOf(error);
        expect(rules.create).not.toHaveBeenCalled();
        expect(accounts.update).not.toHaveBeenCalled();
        expect(schedules.update).not.toHaveBeenCalled();
      },
    );
  });

  describe("createMatchingRuleReported", () => {
    it("answers the created rule's id", async () => {
      await expect(
        service.createMatchingRuleReported(userId, loanId, {
          payeePattern: "ING*",
        }),
      ).resolves.toEqual({ ruleId: "rule-9", error: null });
    });

    it("reports a refusal with its own errorCode and message instead of throwing", async () => {
      rules.create.mockRejectedValue(
        new BadRequestException({
          message: "At most 200 rules can be created",
          errorCode: "RULE_LIMIT_REACHED",
        }),
      );

      await expect(
        service.createMatchingRuleReported(userId, loanId, {
          payeePattern: "ING*",
        }),
      ).resolves.toEqual({
        ruleId: null,
        error: {
          errorCode: "RULE_LIMIT_REACHED",
          message: "At most 200 rules can be created",
        },
      });
    });

    it("reports a refusal without an errorCode, and an unexpected error, as the generic failure", async () => {
      accounts.findOne.mockResolvedValue(
        loan({ accountType: AccountType.LINE_OF_CREDIT }),
      );
      await expect(
        service.createMatchingRuleReported(userId, loanId, {
          payeePattern: "ING*",
        }),
      ).resolves.toEqual({
        ruleId: null,
        error: {
          errorCode: PAYMENT_MATCHING_FAILED,
          message: "Payment matching applies to mortgages and loans only",
        },
      });

      accounts.findOne.mockRejectedValue(new Error("connection reset"));
      const outcome = await service.createMatchingRuleReported(userId, loanId, {
        payeePattern: "ING*",
      });
      expect(outcome).toEqual({
        ruleId: null,
        error: {
          errorCode: PAYMENT_MATCHING_FAILED,
          message: expect.any(String),
        },
      });
      expect(outcome.error?.message).not.toContain("connection reset");
    });
  });

  describe("listSettlements", () => {
    const pricing = {
      version: 1,
      dueDate: "2024-02-01",
      installmentNumber: 2,
      debtBefore: "298966.6700",
      lines: { principal: "833.33", interest: "498.28", extra: "200.00" },
    };

    it("reads the loan's rule claims, owner-scoped, newest first, capped", async () => {
      manager.query.mockResolvedValue([
        {
          claim_id: "claim-2",
          due_date: "2024-02-01",
          posted_date: "2024-02-02",
          transaction_id: "tx-2",
          transaction_status: "UNRECONCILED",
          rule_id: "rule-9",
          pricing,
        },
        {
          claim_id: "claim-1",
          due_date: "2024-01-01",
          posted_date: "2024-01-03",
          transaction_id: "tx-1",
          transaction_status: "VOID",
          rule_id: null,
          pricing: null,
        },
      ]);

      const settled = await service.listSettlements(userId, loanId);

      expect(settled).toEqual([
        {
          claimId: "claim-2",
          dueDate: "2024-02-01",
          postedDate: "2024-02-02",
          transactionId: "tx-2",
          transactionStatus: "UNRECONCILED",
          principal: 833.33,
          interest: 498.28,
          extraPrincipal: 200,
          debtBefore: 298966.67,
          installmentNumber: 2,
          ruleId: "rule-9",
        },
        {
          claimId: "claim-1",
          dueDate: "2024-01-01",
          postedDate: "2024-01-03",
          transactionId: "tx-1",
          transactionStatus: "VOID",
          principal: null,
          interest: null,
          extraPrincipal: null,
          debtBefore: null,
          installmentNumber: null,
          ruleId: null,
        },
      ]);
      const [sql, params] = manager.query.mock.calls[0];
      expect(params).toEqual([loanId, userId, MAX_LOAN_SETTLEMENTS_LISTED]);
      expect(MAX_LOAN_SETTLEMENTS_LISTED).toBe(200);
      expect(sql).toMatch(/stp\.source = 'rule'/);
      expect(sql).toMatch(/st\.user_id = \$2/);
      expect(sql).toMatch(/a\.id = \$1 AND a\.user_id = \$2/);
      expect(sql).toMatch(
        /ORDER BY stp\.original_due_date DESC, stp\.created_at DESC\s+LIMIT \$3/,
      );
    });

    it("answers 404 for a loan the user does not own, without reading claims", async () => {
      accounts.findOne.mockResolvedValue(null);

      await expect(
        service.listSettlements(userId, loanId),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(manager.query).not.toHaveBeenCalled();
    });
  });
});
