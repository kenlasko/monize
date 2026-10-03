import { Test } from "@nestjs/testing";
import { BadRequestException } from "@nestjs/common";
import { ToolExecutorService } from "./tool-executor.service";
import { AiActionBuilderService } from "../actions/ai-action-builder.service";
import { AiActionSigningService } from "../actions/ai-action-signing.service";
import { AccountsService } from "../../accounts/accounts.service";
import { CategoriesService } from "../../categories/categories.service";
import { TransactionAnalyticsService } from "../../transactions/transaction-analytics.service";
import { NetWorthService } from "../../net-worth/net-worth.service";
import { BudgetReportsService } from "../../budgets/budget-reports.service";
import { PortfolioService } from "../../securities/portfolio.service";
import { SecuritiesService } from "../../securities/securities.service";
import { SecurityToolPrepService } from "../../securities/security-tool-prep.service";
import { InvestmentTransactionsService } from "../../securities/investment-transactions.service";
import { ScheduledTransactionsService } from "../../scheduled-transactions/scheduled-transactions.service";
import { TransactionsService } from "../../transactions/transactions.service";
import { PayeesService } from "../../payees/payees.service";
import { PayeeToolPrepService } from "../../payees/payee-tool-prep.service";
import { TransactionToolPrepService } from "../../transactions/transaction-tool-prep.service";
import { BuiltInReportsService } from "../../built-in-reports/built-in-reports.service";
import { AttachmentToolPrepService } from "../../attachments/attachment-tool-prep.service";
import { RelayAttachmentStore } from "../relay/relay-attachment.store";
import { ExchangeRateService } from "../../currencies/exchange-rate.service";
import { AiReviewWorkService } from "../../ai-review/ai-review-work.service";
import { TransactionRuleToolPrepService } from "../../transaction-rules/rule-tool-prep.service";

const USER = "user-1";
const RULE = "e0000000-0000-4000-8000-000000000005";
const CAT = "c0000000-0000-4000-8000-000000000003";
const FINGERPRINT = "f".repeat(64);

const labels = {
  accounts: {},
  payees: {},
  categories: { [CAT]: "Bills: Streaming" },
  tags: {},
};
const rule = {
  name: "Streaming",
  enabled: true,
  triggers: ["create", "import"] as ("create" | "import")[],
  stopProcessing: false,
  activeFrom: null,
  activeTo: null,
  condition: { field: "payeeId", op: "eq", value: "p1" } as const,
  actions: [{ type: "set_category", categoryId: CAT, onlyIfEmpty: true }],
};
const test = {
  matchedCount: 2,
  conditionMatchedCount: 2,
  scanned: 30,
  truncated: false,
  rows: [],
  skipped: [],
  skippedCount: 0,
  aiReviewRequests: 0,
  labels: { categories: {}, payees: {}, tags: {}, rules: {} },
};

describe("ToolExecutorService transaction rule tools", () => {
  let service: ToolExecutorService;
  let prep: Record<string, jest.Mock>;
  let signing: { sign: jest.Mock };

  beforeEach(async () => {
    prep = {
      list: jest.fn().mockResolvedValue({
        rules: [{ id: RULE, name: "Streaming", revision: 3 }],
        totalCount: 1,
        truncated: false,
      }),
      prepareCreate: jest
        .fn()
        .mockResolvedValue({ ok: true, preview: { rule, labels, test } }),
      prepareUpdate: jest.fn().mockResolvedValue({
        ok: true,
        preview: {
          ruleId: RULE,
          expectedRevision: 3,
          rule,
          current: rule,
          labels,
          test,
        },
      }),
      prepareDelete: jest.fn().mockResolvedValue({
        ok: true,
        preview: { ruleId: RULE, expectedRevision: 3, rule, labels },
      }),
      prepareRun: jest.fn().mockResolvedValue({
        ok: true,
        preview: {
          ruleId: RULE,
          rule,
          labels,
          filters: {},
          fingerprint: FINGERPRINT,
          test,
        },
      }),
      prepareTest: jest
        .fn()
        .mockResolvedValue({ ok: true, preview: { rule, labels, test } }),
      toLlmTest: jest.fn().mockReturnValue({
        matchedCount: 2,
        scanned: 30,
        truncated: false,
        rows: [],
        skippedCount: 0,
        skipped: [],
      }),
    };
    signing = { sign: jest.fn().mockReturnValue("sig") };

    const unused = [
      AccountsService,
      CategoriesService,
      TransactionAnalyticsService,
      NetWorthService,
      BudgetReportsService,
      PortfolioService,
      SecuritiesService,
      SecurityToolPrepService,
      InvestmentTransactionsService,
      ScheduledTransactionsService,
      TransactionsService,
      PayeesService,
      PayeeToolPrepService,
      TransactionToolPrepService,
      BuiltInReportsService,
      AttachmentToolPrepService,
      RelayAttachmentStore,
      ExchangeRateService,
    ].map((provide) => ({ provide, useValue: {} }));
    const module = await Test.createTestingModule({
      providers: [
        ToolExecutorService,
        AiActionBuilderService,
        { provide: AiActionSigningService, useValue: signing },
        { provide: AiReviewWorkService, useValue: {} },
        { provide: TransactionRuleToolPrepService, useValue: prep },
        ...unused,
      ],
    }).compile();
    service = module.get(ToolExecutorService);
  });

  describe("list_transaction_rules", () => {
    it("returns the rules from the shared prep service and passes the filters", async () => {
      const result = await service.execute(USER, "list_transaction_rules", {
        search: "stream",
        limit: "5",
      });

      expect(prep.list).toHaveBeenCalledWith(USER, {
        ruleId: undefined,
        search: "stream",
        limit: 5,
      });
      expect(result.isError).toBeUndefined();
      expect(result.pendingAction).toBeUndefined();
      expect(result.data).toMatchObject({ totalCount: 1, truncated: false });
    });

    it("rejects a ruleId that is not a UUID", async () => {
      const result = await service.execute(USER, "list_transaction_rules", {
        ruleId: "nope",
      });
      expect(result.isError).toBe(true);
      expect(prep.list).not.toHaveBeenCalled();
    });
  });

  describe("manage_transaction_rules", () => {
    const draft = {
      condition: { field: "payeeId", op: "eq", value: "Netflix" },
      actions: [{ type: "set_category", categoryName: "Bills: Streaming" }],
    };

    it.each([
      [
        "create",
        { operation: "create", name: "Streaming", ...draft },
        "prepareCreate",
        "create_transaction_rule",
      ],
      [
        "update",
        { operation: "update", ruleId: RULE, name: "New" },
        "prepareUpdate",
        "update_transaction_rule",
      ],
      [
        "delete",
        { operation: "delete", ruleId: RULE },
        "prepareDelete",
        "delete_transaction_rule",
      ],
      [
        "run",
        { operation: "run", ruleId: RULE, accountNames: ["Checking"] },
        "prepareRun",
        "run_transaction_rule",
      ],
    ])(
      "%s proposes one signed card and tells the model nothing was done",
      async (_op, input, method, type) => {
        const result = await service.execute(
          USER,
          "manage_transaction_rules",
          input,
        );

        expect(prep[method]).toHaveBeenCalledTimes(1);
        expect(result.isError).toBeUndefined();
        expect(result.pendingAction).toMatchObject({
          type,
          signature: "sig",
          descriptor: { type, userId: USER },
        });
        expect(result.pendingActions).toBeUndefined();
        expect(result.data).toMatchObject({ status: "preview_shown" });
        expect(JSON.stringify(result.data)).not.toContain("sig");
        expect(signing.sign).toHaveBeenCalledTimes(1);
      },
    );

    it("passes the model's fields and run filters through as given", async () => {
      await service.execute(USER, "manage_transaction_rules", {
        operation: "run",
        ruleId: RULE,
        accountNames: ["Checking"],
        startDate: "2026-01-01",
        endDate: "2026-02-01",
        limit: "20",
      });
      expect(prep.prepareRun).toHaveBeenCalledWith(
        USER,
        expect.objectContaining({ ruleId: RULE }),
        {
          accountNames: ["Checking"],
          startDate: "2026-01-01",
          endDate: "2026-02-01",
          limit: 20,
        },
      );
    });

    it("hands the active window to the preparation, for a draft test as for a write", async () => {
      await service.execute(USER, "manage_transaction_rules", {
        operation: "create",
        name: "Mortgage",
        activeFrom: "2026-10-01",
        activeTo: "",
        ...draft,
      });
      expect(prep.prepareCreate).toHaveBeenCalledWith(
        USER,
        expect.objectContaining({ activeFrom: "2026-10-01", activeTo: "" }),
      );
      await service.execute(USER, "manage_transaction_rules", {
        operation: "test",
        activeFrom: "2026-10-01",
        ...draft,
      });
      expect(prep.prepareTest).toHaveBeenCalledWith(
        USER,
        expect.objectContaining({ activeFrom: "2026-10-01" }),
        expect.anything(),
      );
    });

    it("test answers with the test result and neither a card nor a signature", async () => {
      const result = await service.execute(USER, "manage_transaction_rules", {
        operation: "test",
        ...draft,
      });

      expect(prep.prepareTest).toHaveBeenCalledTimes(1);
      expect(result.pendingAction).toBeUndefined();
      expect(result.pendingActions).toBeUndefined();
      expect(signing.sign).not.toHaveBeenCalled();
      expect(prep.prepareCreate).not.toHaveBeenCalled();
      expect(result.data).toMatchObject({ matchedCount: 2, scanned: 30 });
      expect(result.summary).toContain("Nothing was saved");
    });

    it("returns a validation refusal as a tool error with the structured entries and no card", async () => {
      const errors = [
        { path: "condition.all[0].op", code: "OPERATOR_NOT_ALLOWED" },
      ];
      prep.prepareCreate.mockResolvedValue({
        ok: false,
        message: "The rule definition is not valid",
        errors,
      });
      const result = await service.execute(USER, "manage_transaction_rules", {
        operation: "create",
        name: "x",
        ...draft,
      });

      expect(result.isError).toBe(true);
      expect(result.data).toEqual({
        error: "The rule definition is not valid",
        errors,
      });
      expect(result.pendingAction).toBeUndefined();
      expect(signing.sign).not.toHaveBeenCalled();
    });

    it("sends the hints beside the entries in the data and the summary", async () => {
      prep.prepareCreate.mockResolvedValue({
        ok: false,
        message: "The rule definition is not valid",
        errors: [{ path: "condition.value", code: "PATTERN_WITHOUT_WILDCARD" }],
        hints: ["Use eq for the whole text."],
      });
      const result = await service.execute(USER, "manage_transaction_rules", {
        operation: "create",
        name: "x",
        ...draft,
      });
      expect(result.isError).toBe(true);
      expect(result.data).toMatchObject({
        hints: ["Use eq for the whole text."],
      });
      expect(result.summary).toContain("Fix: Use eq for the whole text.");
    });

    it("accepts condition and actions sent as JSON strings", async () => {
      await service.execute(USER, "manage_transaction_rules", {
        operation: "create",
        name: "x",
        condition: JSON.stringify(draft.condition),
        actions: JSON.stringify(draft.actions),
      });
      expect(prep.prepareCreate).toHaveBeenCalledWith(
        USER,
        expect.objectContaining({
          condition: draft.condition,
          actions: draft.actions,
        }),
      );
    });

    it("tells the model plainly when a create matches none of the transactions", async () => {
      prep.prepareCreate.mockResolvedValue({
        ok: true,
        preview: {
          rule,
          labels,
          test: {
            ...test,
            matchedCount: 0,
            conditionMatchedCount: 0,
          },
        },
      });
      const result = await service.execute(USER, "manage_transaction_rules", {
        operation: "create",
        name: "x",
        ...draft,
      });
      expect(result.summary).toContain(
        `matches none of the ${test.scanned} latest transactions`,
      );
      expect(result.summary).toContain("usually wrong");
    });

    it("does not call a create wrong when the condition matches but everything already has the value (the NETFLIX case)", async () => {
      prep.prepareCreate.mockResolvedValue({
        ok: true,
        preview: {
          rule,
          labels,
          test: { ...test, matchedCount: 0, conditionMatchedCount: 9 },
        },
      });
      const result = await service.execute(USER, "manage_transaction_rules", {
        operation: "create",
        name: "NETFLIX",
        ...draft,
      });
      expect(result.summary).not.toContain("matches none");
      expect(result.summary).not.toContain("usually wrong");
      expect(result.summary).toContain(
        `The condition matches 9 of the ${test.scanned} latest transactions, but nothing would change`,
      );
      expect(result.summary).toContain("not an error");
    });

    it("says nothing about a rule that matches and changes rows", async () => {
      const result = await service.execute(USER, "manage_transaction_rules", {
        operation: "create",
        name: "x",
        ...draft,
      });
      expect(result.summary).not.toContain("matches none");
      expect(result.summary).not.toContain("nothing would change");
    });

    it("tells the model plainly when a test matched none", async () => {
      prep.toLlmTest.mockReturnValue({
        message:
          "This rule matches none of the 30 latest transactions. Re-check.",
        matchedCount: 0,
        scanned: 30,
        truncated: false,
        rows: [],
        skippedCount: 0,
        skipped: [],
      });
      const result = await service.execute(USER, "manage_transaction_rules", {
        operation: "test",
        ...draft,
      });
      expect(result.summary).toContain("matches none of the 30 latest");
      expect(result.data).toMatchObject({ matchedCount: 0 });
    });

    it("passes a 4xx from the prep service on to the model and hides anything else", async () => {
      prep.prepareDelete.mockRejectedValueOnce(
        new BadRequestException("Bad rule"),
      );
      const refused = await service.execute(USER, "manage_transaction_rules", {
        operation: "delete",
        ruleId: RULE,
      });
      expect(refused).toMatchObject({
        isError: true,
        data: { error: "Bad rule" },
      });

      prep.prepareDelete.mockRejectedValueOnce(new Error("db exploded"));
      const failed = await service.execute(USER, "manage_transaction_rules", {
        operation: "delete",
        ruleId: RULE,
      });
      expect(failed.isError).toBe(true);
      expect(JSON.stringify(failed.data)).not.toContain("db exploded");
    });

    it.each([
      [{ operation: "create", name: "x" }],
      [{ operation: "update", ruleId: RULE }],
      [{ operation: "delete" }],
      [{ operation: "run" }],
      [{ operation: "test" }],
      [{ operation: "merge", ruleId: RULE }],
      [{ operation: "delete", ruleId: "not-a-uuid" }],
    ])("rejects %j before any preview is prepared", async (input) => {
      const result = await service.execute(
        USER,
        "manage_transaction_rules",
        input,
      );
      expect(result.isError).toBe(true);
      for (const fn of Object.values(prep)) expect(fn).not.toHaveBeenCalled();
    });
  });
});
