import { sharedReviewProvider } from "../../shared-expenses/__fixtures__/shared-review";
import { Test } from "@nestjs/testing";
import { ConflictException } from "@nestjs/common";
import { ToolExecutorService } from "./tool-executor.service";
import { FINANCIAL_TOOLS } from "./tool-definitions";
import { AiReviewWorkService } from "../../ai-review/ai-review-work.service";
import { ASSISTANT_CLAIM_KEY } from "../../ai-review/ai-review-work.types";
import { EmailReceiptParserToolsService } from "../../email-receipts/parsers/email-receipt-parser-tools.service";
import { BondSeriesService } from "../../bonds/bond-series.service";
import { WarrantiesService } from "../../warranties/warranties.service";
import { EMAIL_RECEIPT_PARSER_TOOL_DESCRIPTION } from "../../email-receipts/parsers/parser-tool.guide";
import { AiActionBuilderService } from "../actions/ai-action-builder.service";
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
import { TransactionRuleToolPrepService } from "../../transaction-rules/rule-tool-prep.service";

const USER = "user-1";
const R1 = "e0000000-0000-4000-8000-000000000001";
const R2 = "e0000000-0000-4000-8000-000000000002";
const REQ = "e0000000-0000-4000-8000-000000000009";
const DEFINITION = { version: 2, total: ["Order total: {amount}"] };

describe("ToolExecutorService email_receipt_parsers", () => {
  let service: ToolExecutorService;
  let tools: Record<string, jest.Mock>;

  beforeEach(async () => {
    tools = {
      listCategories: jest.fn().mockResolvedValue({
        categories: [{ id: "c1", name: "Books" }],
        totalCount: 1,
        truncated: false,
      }),
      testDefinition: jest.fn(),
      saveDraft: jest.fn(),
      listParsers: jest.fn().mockResolvedValue([{ id: R1, name: "Shop" }]),
      getParser: jest.fn().mockResolvedValue({
        id: R1,
        name: "Shop",
        status: "approved",
        revision: 4,
      }),
    };
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
      TransactionRuleToolPrepService,
      AiActionBuilderService,
      AiReviewWorkService,
    ].map((provide) => ({ provide, useValue: {} }));
    const module = await Test.createTestingModule({
      providers: [
        sharedReviewProvider(),
        ToolExecutorService,
        { provide: EmailReceiptParserToolsService, useValue: tools },
        { provide: BondSeriesService, useValue: {} },
        { provide: WarrantiesService, useValue: {} },
        ...unused,
      ],
    }).compile();
    service = module.get(ToolExecutorService);
  });

  it("is defined once, with the shared description", () => {
    const definitions = FINANCIAL_TOOLS.filter(
      (tool) => tool.name === "email_receipt_parsers",
    );
    expect(definitions).toHaveLength(1);
    expect(definitions[0].description).toBe(
      EMAIL_RECEIPT_PARSER_TOOL_DESCRIPTION,
    );
    expect(definitions[0].inputSchema.required).toEqual(["operation"]);
  });

  it("lists the categories for the user", async () => {
    const result = await service.execute(USER, "email_receipt_parsers", {
      operation: "categories",
    });

    expect(tools.listCategories).toHaveBeenCalledWith(USER);
    expect(result.isError).toBeUndefined();
    expect(result.data).toMatchObject({ totalCount: 1 });
  });

  it("lists the saved parsers", async () => {
    const result = await service.execute(USER, "email_receipt_parsers", {
      operation: "get",
    });

    expect(tools.listParsers).toHaveBeenCalledWith(USER);
    expect(tools.getParser).not.toHaveBeenCalled();
    expect(result.data).toEqual({ parsers: [{ id: R1, name: "Shop" }] });
    expect(result.summary).toBe("Found 1 parser.");
  });

  it("reads one parser in full", async () => {
    const result = await service.execute(USER, "email_receipt_parsers", {
      operation: "get",
      parserId: R1,
    });

    expect(tools.getParser).toHaveBeenCalledWith(USER, R1);
    expect(tools.saveDraft).not.toHaveBeenCalled();
    expect(result.data).toMatchObject({ id: R1, revision: 4 });
    expect(result.summary).toContain('approved parser "Shop"');
  });

  it("tests a definition on the named emails and writes nothing", async () => {
    tools.testDefinition.mockResolvedValue({
      valid: true,
      errors: [],
      unknownCategoryIds: [],
      emails: [{ receiptId: R1 }, { receiptId: R2 }],
      allComplete: true,
    });

    const result = await service.execute(USER, "email_receipt_parsers", {
      operation: "test",
      definition: DEFINITION,
      receiptIds: [R1, R2],
      payeeName: "Shop",
    });

    expect(tools.testDefinition).toHaveBeenCalledWith(USER, {
      definition: DEFINITION,
      receiptIds: [R1, R2],
      payeeName: "Shop",
    });
    expect(tools.saveDraft).not.toHaveBeenCalled();
    expect(result.summary).toContain("Nothing was saved");
    expect(result.summary).toContain("every one reads complete");
    expect(result.pendingAction).toBeUndefined();
  });

  it("tests samples that carry the expected transaction and reports whether they agree", async () => {
    tools.testDefinition.mockResolvedValue({
      valid: true,
      errors: [],
      unknownCategoryIds: [],
      emails: [{ receiptId: R1 }],
      allComplete: true,
      allAgree: false,
    });
    const T1 = "e0000000-0000-4000-8000-0000000000a1";

    const result = await service.execute(USER, "email_receipt_parsers", {
      operation: "test",
      definition: DEFINITION,
      samples: [{ receiptId: R1, transactionId: T1 }],
    });

    expect(tools.testDefinition).toHaveBeenCalledWith(USER, {
      definition: DEFINITION,
      samples: [{ receiptId: R1, transactionId: T1 }],
    });
    expect(result.summary).toContain("not every one agrees");
  });

  it("updates a named draft: parserId and expectedRevision reach saveDraft", async () => {
    tools.saveDraft.mockResolvedValue({
      parserId: "p1",
      name: "Shop",
      status: "draft",
      revision: 5,
      fromDomains: ["shop.example.com"],
      payee: null,
      requestProposed: false,
    });
    const P1 = "e0000000-0000-4000-8000-0000000000b1";

    await service.execute(USER, "email_receipt_parsers", {
      operation: "save_draft",
      parserId: P1,
      expectedRevision: 4,
      name: "Shop",
      fromDomains: ["shop.example.com"],
      definition: DEFINITION,
    });

    expect(tools.saveDraft).toHaveBeenCalledWith(
      USER,
      ASSISTANT_CLAIM_KEY,
      expect.objectContaining({ parserId: P1, expectedRevision: 4 }),
    );
  });

  it("refuses parserId without expectedRevision before reaching the service", async () => {
    const result = await service.execute(USER, "email_receipt_parsers", {
      operation: "save_draft",
      parserId: "e0000000-0000-4000-8000-0000000000b1",
      name: "Shop",
      fromDomains: ["shop.example.com"],
      definition: DEFINITION,
    });
    expect(result.isError).toBe(true);
    expect(tools.saveDraft).not.toHaveBeenCalled();
  });

  it("says an invalid definition is invalid, as a result the model can fix", async () => {
    tools.testDefinition.mockResolvedValue({
      valid: false,
      errors: [{ path: "total[0]", code: "capture_missing" }],
      unknownCategoryIds: [],
      emails: [],
      allComplete: false,
    });

    const result = await service.execute(USER, "email_receipt_parsers", {
      operation: "test",
      definition: { total: ["x"] },
      receiptIds: [R1],
    });

    expect(result.isError).toBeUndefined();
    expect(result.summary).toContain("not valid");
    expect(result.data).toMatchObject({ valid: false });
  });

  it("saves a draft under the assistant's own claim key and tells the model it is not applied", async () => {
    tools.saveDraft.mockResolvedValue({
      parserId: "p1",
      name: "Shop",
      status: "draft",
      fromDomains: ["shop.example.com"],
      payee: null,
      requestProposed: true,
    });

    const result = await service.execute(USER, "email_receipt_parsers", {
      operation: "save_draft",
      requestId: REQ,
      name: "Shop",
      fromDomains: ["shop.example.com"],
      subjectContains: ["order"],
      definition: DEFINITION,
    });

    expect(tools.saveDraft).toHaveBeenCalledWith(USER, ASSISTANT_CLAIM_KEY, {
      requestId: REQ,
      name: "Shop",
      fromDomains: ["shop.example.com"],
      subjectContains: ["order"],
      payeeName: undefined,
      definition: DEFINITION,
    });
    expect(result.data).toMatchObject({
      parserId: "p1",
      requestProposed: true,
      message: expect.stringContaining("Do not say it was applied"),
    });
    expect(result.pendingAction).toBeUndefined();
  });

  it("returns a refusal (a request the assistant did not claim) to the model as a tool error", async () => {
    tools.saveDraft.mockRejectedValue(new ConflictException("not claimed"));

    const result = await service.execute(USER, "email_receipt_parsers", {
      operation: "save_draft",
      requestId: REQ,
      name: "Shop",
      fromDomains: ["shop.example.com"],
      definition: DEFINITION,
    });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.data)).toContain("not claimed");
  });

  it.each([
    ["test without a definition", { operation: "test", receiptIds: [R1] }],
    ["test without emails", { operation: "test", definition: DEFINITION }],
    [
      "test with 26 emails",
      {
        operation: "test",
        definition: DEFINITION,
        receiptIds: Array.from({ length: 26 }, () => R1),
      },
    ],
    [
      "test with a non-uuid email",
      { operation: "test", definition: DEFINITION, receiptIds: ["x"] },
    ],
    [
      "save_draft without a name",
      {
        operation: "save_draft",
        definition: DEFINITION,
        fromDomains: ["a.example.com"],
      },
    ],
    [
      "save_draft without domains",
      { operation: "save_draft", definition: DEFINITION, name: "x" },
    ],
    [
      "save_draft without a definition",
      { operation: "save_draft", name: "x", fromDomains: ["a.example.com"] },
    ],
    ["an unknown operation", { operation: "approve" }],
    [
      "a non-uuid requestId",
      {
        operation: "save_draft",
        requestId: "x",
        name: "x",
        definition: DEFINITION,
        fromDomains: ["a.example.com"],
      },
    ],
  ])("refuses %s before touching anything", async (_name, input) => {
    const result = await service.execute(USER, "email_receipt_parsers", input);

    expect(result.isError).toBe(true);
    expect(tools.testDefinition).not.toHaveBeenCalled();
    expect(tools.saveDraft).not.toHaveBeenCalled();
  });
});
