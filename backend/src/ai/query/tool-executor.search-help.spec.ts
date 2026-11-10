import { sharedReviewProvider } from "../../shared-expenses/__fixtures__/shared-review";
import { Test } from "@nestjs/testing";
import { ToolExecutorService } from "./tool-executor.service";
import { HelpService } from "../../help/help.service";
import { TagsService } from "../../tags/tags.service";
import { TagToolPrepService } from "../../tags/tag-tool-prep.service";
import type { LlmHelpAnswer } from "../../help/help-llm-shape";
import { AiReviewWorkService } from "../../ai-review/ai-review-work.service";
import { EmailReceiptParserToolsService } from "../../email-receipts/parsers/email-receipt-parser-tools.service";
import { BondSeriesService } from "../../bonds/bond-series.service";
import { WarrantiesService } from "../../warranties/warranties.service";
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

/** What `HelpService.getLlmHelp` answers for two matched sections. */
const ANSWER: LlmHelpAnswer = {
  available: true,
  guideVersion: "1.2.3",
  language: "en",
  sections: [
    {
      pageTitle: "Transactions",
      heading: "Creating a Split",
      url: "https://www.monize.net/docs/transactions#creating-a-split",
      text: "Removing the second-to-last row turns the transaction back into a regular one.",
    },
    {
      pageTitle: "Transactions",
      heading: "",
      url: "https://www.monize.net/docs/transactions",
      text: "The register.",
    },
  ],
};

describe("ToolExecutorService search_help", () => {
  let service: ToolExecutorService;
  let help: { getLlmHelp: jest.MockedFunction<HelpService["getLlmHelp"]> };

  beforeEach(async () => {
    help = { getLlmHelp: jest.fn().mockReturnValue(ANSWER) };
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
      EmailReceiptParserToolsService,
      BondSeriesService,
      WarrantiesService,
      TagsService,
      TagToolPrepService,
    ].map((provide) => ({ provide, useValue: {} }));
    const module = await Test.createTestingModule({
      providers: [
        sharedReviewProvider(),
        ToolExecutorService,
        { provide: HelpService, useValue: help },
        ...unused,
      ],
    }).compile();
    service = module.get(ToolExecutorService);
  });

  it("passes the question and the limit to getLlmHelp, and nothing of the user", async () => {
    await service.execute(USER, "search_help", {
      query: "how do I undo a split?",
      limit: "3",
    });

    expect(help.getLlmHelp).toHaveBeenCalledWith("how do I undo a split?", {
      limit: 3,
    });
  });

  it("hands getLlmHelp the question without its surrounding whitespace", async () => {
    await service.execute(USER, "search_help", { query: "  budgets \n" });

    expect(help.getLlmHelp).toHaveBeenCalledWith("budgets", {
      limit: undefined,
    });
  });

  it("leaves an unasked limit to the domain method's default", async () => {
    await service.execute(USER, "search_help", { query: "budgets" });

    expect(help.getLlmHelp).toHaveBeenCalledWith("budgets", {
      limit: undefined,
    });
  });

  it("answers the domain shape with a summary naming each section found", async () => {
    const result = await service.execute(USER, "search_help", {
      query: "undo a split",
    });

    expect(result.isError).toBeUndefined();
    expect(result.data).toEqual(ANSWER);
    expect(result.summary).toBe(
      "2 guide sections: Transactions: Creating a Split; Transactions.",
    );
    expect(result.sources).toEqual([
      { type: "help", description: 'User guide: "undo a split"' },
    ]);
  });

  it("says no section covers the question when nothing matched", async () => {
    help.getLlmHelp.mockReturnValueOnce({ ...ANSWER, sections: [] });

    const result = await service.execute(USER, "search_help", {
      query: "fly to the moon",
    });

    expect(result.isError).toBeUndefined();
    expect(result.summary).toBe(
      'No section of the guide covers "fly to the moon".',
    );
  });

  it("says the guide is unavailable rather than that it has no answer", async () => {
    help.getLlmHelp.mockReturnValueOnce({
      ...ANSWER,
      available: false,
      sections: [],
    });

    const result = await service.execute(USER, "search_help", {
      query: "budgets",
    });

    expect(result.summary).toContain("not available on this server");
    expect(result.summary).not.toContain("No section");
  });

  it.each([
    [{}],
    [{ query: "" }],
    [{ query: "   " }],
    [{ query: "x".repeat(201) }],
    [{ query: "budgets", limit: 9 }],
    [{ query: "budgets", limit: 0 }],
  ])("refuses %j before reading the guide", async (input) => {
    const result = await service.execute(USER, "search_help", input);

    expect(result.isError).toBe(true);
    expect(help.getLlmHelp).not.toHaveBeenCalled();
  });
});
