import { Test, TestingModule } from "@nestjs/testing";
import { McpServerService } from "./mcp-server.service";
import { McpAccountsTools } from "./tools/accounts.tool";
import { McpTransactionsTools } from "./tools/transactions.tool";
import { McpCategoriesTools } from "./tools/categories.tool";
import { McpPayeesTools } from "./tools/payees.tool";
import { McpReportsTools } from "./tools/reports.tool";
import { McpInvestmentsTools } from "./tools/investments.tool";
import { McpNetWorthTools } from "./tools/net-worth.tool";
import { McpScheduledTools } from "./tools/scheduled.tool";
import { McpAccountListResource } from "./resources/account-list.resource";
import { McpCategoryTreeResource } from "./resources/category-tree.resource";
import { McpRecentTransactionsResource } from "./resources/recent-transactions.resource";
import { McpFinancialSummaryResource } from "./resources/financial-summary.resource";
import { McpFinancialReviewPrompt } from "./prompts/financial-review.prompt";
import { McpBudgetCheckPrompt } from "./prompts/budget-check.prompt";
import { McpTransactionLookupPrompt } from "./prompts/transaction-lookup.prompt";
import { McpSpendingAnalysisPrompt } from "./prompts/spending-analysis.prompt";

describe("McpServerService", () => {
  let service: McpServerService;

  const mockToolProvider = { register: jest.fn() };
  const mockResourceProvider = { register: jest.fn() };
  const mockPromptProvider = { register: jest.fn() };

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        McpServerService,
        { provide: McpAccountsTools, useValue: mockToolProvider },
        { provide: McpTransactionsTools, useValue: mockToolProvider },
        { provide: McpCategoriesTools, useValue: mockToolProvider },
        { provide: McpPayeesTools, useValue: mockToolProvider },
        { provide: McpReportsTools, useValue: mockToolProvider },
        { provide: McpInvestmentsTools, useValue: mockToolProvider },
        { provide: McpNetWorthTools, useValue: mockToolProvider },
        { provide: McpScheduledTools, useValue: mockToolProvider },
        { provide: McpAccountListResource, useValue: mockResourceProvider },
        { provide: McpCategoryTreeResource, useValue: mockResourceProvider },
        {
          provide: McpRecentTransactionsResource,
          useValue: mockResourceProvider,
        },
        {
          provide: McpFinancialSummaryResource,
          useValue: mockResourceProvider,
        },
        { provide: McpFinancialReviewPrompt, useValue: mockPromptProvider },
        { provide: McpBudgetCheckPrompt, useValue: mockPromptProvider },
        {
          provide: McpTransactionLookupPrompt,
          useValue: mockPromptProvider,
        },
        { provide: McpSpendingAnalysisPrompt, useValue: mockPromptProvider },
      ],
    }).compile();

    service = module.get<McpServerService>(McpServerService);
  });

  it("should be defined", () => {
    expect(service).toBeDefined();
  });

  it("should create McpServer on init", () => {
    service.onModuleInit();
    expect(service.getServer()).toBeDefined();
  });

  it("should register all tools on init", () => {
    service.onModuleInit();
    expect(mockToolProvider.register).toHaveBeenCalledTimes(8);
  });

  it("should register all resources on init", () => {
    service.onModuleInit();
    expect(mockResourceProvider.register).toHaveBeenCalledTimes(4);
  });

  it("should register all prompts on init", () => {
    service.onModuleInit();
    expect(mockPromptProvider.register).toHaveBeenCalledTimes(4);
  });

  it("should allow setting user context resolver", () => {
    service.onModuleInit();
    const resolver = jest.fn().mockReturnValue({
      userId: "user-1",
      scopes: "read",
    });
    service.setUserContextResolver(resolver);
    expect(service.getServer()).toBeDefined();
  });
});
