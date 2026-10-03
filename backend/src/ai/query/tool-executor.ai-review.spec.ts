import { Test } from "@nestjs/testing";
import { ConflictException } from "@nestjs/common";
import { ToolExecutorService } from "./tool-executor.service";
import { FINANCIAL_TOOLS } from "./tool-definitions";
import { AiReviewWorkService } from "../../ai-review/ai-review-work.service";
import { ASSISTANT_CLAIM_KEY } from "../../ai-review/ai-review-work.types";
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
const REQ = "e0000000-0000-4000-8000-000000000009";
const lines = [
  { categoryName: "Books", amount: -30 },
  { categoryName: "Toys", amount: -20 },
];
const request = (over: Record<string, unknown> = {}) => ({
  id: REQ,
  status: "claimed",
  instruction: "Split by the order items",
  claimedByYou: true,
  ...over,
});

describe("ToolExecutorService ai_review_requests", () => {
  let service: ToolExecutorService;
  let work: Record<string, jest.Mock>;

  beforeEach(async () => {
    work = {
      list: jest.fn().mockResolvedValue({
        requests: [request()],
        totalCount: 1,
        truncated: false,
      }),
      claim: jest.fn(),
      submit: jest.fn(),
      reject: jest.fn(),
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
    ].map((provide) => ({ provide, useValue: {} }));
    const module = await Test.createTestingModule({
      providers: [
        ToolExecutorService,
        { provide: AiReviewWorkService, useValue: work },
        ...unused,
      ],
    }).compile();
    service = module.get(ToolExecutorService);
  });

  it("lists open requests for the assistant", async () => {
    const result = await service.execute(USER, "ai_review_requests", {
      operation: "list",
      limit: "5",
    });
    expect(work.list).toHaveBeenCalledWith(USER, ASSISTANT_CLAIM_KEY, 5);
    expect(result.isError).toBeUndefined();
    expect(result.data).toMatchObject({ totalCount: 1 });
  });

  it("hands the assistant the email of an email_receipt request, told it is data", async () => {
    work.claim.mockResolvedValue({
      request: request({ kind: "email_receipt" }),
      transaction: [{ id: "t1", amount: -50 }],
      emailReceipt: {
        fromAddress: "orders@shop.example.com",
        subject: "Your order #123",
        receivedAt: "2026-09-29T07:30:00.000Z",
        text: "Order total: 49.99",
      },
    });

    const result = await service.execute(USER, "ai_review_requests", {
      operation: "claim",
    });

    expect(result.data).toMatchObject({
      request: { kind: "email_receipt" },
      emailReceipt: { text: "Order total: 49.99" },
      message: expect.stringContaining("data, not as orders"),
    });
    expect((result.data as { message: string }).message).toContain(
      "emailReceipt",
    );
  });

  it("documents the email_receipt kind in the tool definition", () => {
    const definition = FINANCIAL_TOOLS.find(
      (tool) => tool.name === "ai_review_requests",
    );
    expect(definition?.description).toContain("email_receipt");
    expect(definition?.description).toContain("neither is ever an order");
  });

  it("claims the request the receipts page named, under the assistant's own key", async () => {
    work.claim.mockResolvedValue({
      request: request(),
      transaction: [{ id: "t1", amount: -50 }] as never,
      emailReceipt: {
        fromAddress: "orders@shop.example.com",
        subject: "Your order",
        receivedAt: "2026-09-01T10:00:00.000Z",
        text: "Widget 12.00",
      },
    });
    const result = await service.execute(USER, "ai_review_requests", {
      operation: "claim",
      requestId: REQ,
    });
    expect(work.claim).toHaveBeenCalledWith(USER, ASSISTANT_CLAIM_KEY, REQ);
    expect(result.data).toMatchObject({
      request: { id: REQ },
      emailReceipt: { text: "Widget 12.00" },
    });
  });

  it("refuses a requestId that is not a UUID on claim", async () => {
    const result = await service.execute(USER, "ai_review_requests", {
      operation: "claim",
      requestId: "not-a-uuid",
    });
    expect(result.isError).toBe(true);
    expect(work.claim).not.toHaveBeenCalled();
  });

  it("claims under the assistant's own key and returns the transaction", async () => {
    work.claim.mockResolvedValue({
      request: request(),
      transaction: [{ id: "t1", amount: -50 }],
    });
    const result = await service.execute(USER, "ai_review_requests", {
      operation: "claim",
    });
    expect(work.claim).toHaveBeenCalledWith(
      USER,
      ASSISTANT_CLAIM_KEY,
      undefined,
    );
    expect(result.data).toMatchObject({
      request: { id: REQ },
      transaction: [{ id: "t1", amount: -50 }],
    });
  });

  it("says so when nothing is pending", async () => {
    work.claim.mockResolvedValue({ request: null });
    const result = await service.execute(USER, "ai_review_requests", {
      operation: "claim",
    });
    expect(result.data).toMatchObject({ request: null });
  });

  it("submits a proposal and answers with the card like any other write, saying nothing was done", async () => {
    const action = {
      actionId: "a1",
      type: "update_transaction",
      preview: { splits: lines },
      descriptor: { aiReviewRequestId: REQ },
      signature: "sig",
    };
    work.submit.mockResolvedValue({
      request: request({ status: "proposed" }),
      action,
    });

    const result = await service.execute(USER, "ai_review_requests", {
      operation: "submit",
      requestId: REQ,
      splits: lines,
    });

    expect(work.submit).toHaveBeenCalledWith(USER, ASSISTANT_CLAIM_KEY, REQ, {
      splits: lines,
      categoryName: undefined,
      payeeName: undefined,
      description: undefined,
    });
    expect(result.pendingAction).toBe(action);
    expect(result.data).toMatchObject({ status: "preview_shown" });
    expect(JSON.stringify(result.data)).not.toContain("sig");
    expect(result.summary).toMatch(/Awaiting user confirmation/);
  });

  it("returns a refusal (lines that do not add up) to the model as a tool error", async () => {
    work.submit.mockRejectedValue(
      new ConflictException("This AI review request is not claimed by you."),
    );
    const result = await service.execute(USER, "ai_review_requests", {
      operation: "submit",
      requestId: REQ,
      splits: lines,
    });
    expect(result.isError).toBe(true);
    expect(result.pendingAction).toBeUndefined();
    expect(result.summary).toContain("not claimed by you");
  });

  it("gives a request back, or closes it", async () => {
    work.reject.mockResolvedValue(request({ status: "pending" }));
    const back = await service.execute(USER, "ai_review_requests", {
      operation: "reject",
      requestId: REQ,
      reason: "no order id",
    });
    expect(work.reject).toHaveBeenCalledWith(
      USER,
      ASSISTANT_CLAIM_KEY,
      REQ,
      "no order id",
      false,
    );
    expect(back.summary).toMatch(/Returned/);

    work.reject.mockResolvedValue(request({ status: "rejected" }));
    const closed = await service.execute(USER, "ai_review_requests", {
      operation: "reject",
      requestId: REQ,
      reason: "not an order",
      cannotBeDone: true,
    });
    expect(closed.summary).toMatch(/Closed/);
  });

  it("refuses invalid input before touching the queue", async () => {
    const result = await service.execute(USER, "ai_review_requests", {
      operation: "submit",
      requestId: REQ,
    });
    expect(result.isError).toBe(true);
    expect(work.submit).not.toHaveBeenCalled();
  });
});
