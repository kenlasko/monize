import { Test, TestingModule } from "@nestjs/testing";
import { McpServerService } from "./mcp-server.service";
import { McpAccountsTools } from "./tools/accounts.tool";
import { McpTransactionsTools } from "./tools/transactions.tool";
import { McpCategoriesTools } from "./tools/categories.tool";
import { McpPayeesTools } from "./tools/payees.tool";
import { McpReportsTools } from "./tools/reports.tool";
import { McpInvestmentsTools } from "./tools/investments.tool";
import { McpScheduledTools } from "./tools/scheduled.tool";
import { McpCalculateTools } from "./tools/calculate.tool";
import { McpBudgetsTools } from "./tools/budgets.tool";
import { McpRelayTools } from "./tools/relay.tool";
import { McpAccountListResource } from "./resources/account-list.resource";
import { McpCategoryTreeResource } from "./resources/category-tree.resource";
import { McpRecentTransactionsResource } from "./resources/recent-transactions.resource";
import { McpFinancialSummaryResource } from "./resources/financial-summary.resource";
import { McpFinancialReviewPrompt } from "./prompts/financial-review.prompt";
import { McpBudgetCheckPrompt } from "./prompts/budget-check.prompt";
import { McpTransactionLookupPrompt } from "./prompts/transaction-lookup.prompt";
import { McpSpendingAnalysisPrompt } from "./prompts/spending-analysis.prompt";
import { AiRelayService } from "../ai/relay/ai-relay.service";

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
        { provide: McpScheduledTools, useValue: mockToolProvider },
        { provide: McpCalculateTools, useValue: mockToolProvider },
        { provide: McpBudgetsTools, useValue: mockToolProvider },
        { provide: McpRelayTools, useValue: mockToolProvider },
        {
          provide: AiRelayService,
          useValue: { reportToolActivity: jest.fn() },
        },
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

  it("should create a new McpServer instance", () => {
    const resolver = jest.fn();
    const server = service.createServer(resolver);
    expect(server).toBeDefined();
  });

  it("advertises the backend package.json version (auto-updates with releases)", () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { version } = require("../../package.json") as { version: string };
    const resolver = jest.fn();
    const server = service.createServer(resolver);
    const serverInfo = (server.server as any)._serverInfo as {
      name: string;
      version: string;
    };
    expect(serverInfo.name).toBe("monize");
    expect(serverInfo.version).toBe(version);
    expect(serverInfo.version).not.toBe("1.0.0");
  });

  it("should register all tools", () => {
    const resolver = jest.fn();
    service.createServer(resolver);
    expect(mockToolProvider.register).toHaveBeenCalledTimes(10);
  });

  it("should register all resources", () => {
    const resolver = jest.fn();
    service.createServer(resolver);
    expect(mockResourceProvider.register).toHaveBeenCalledTimes(4);
  });

  it("should register all prompts", () => {
    const resolver = jest.fn();
    service.createServer(resolver);
    expect(mockPromptProvider.register).toHaveBeenCalledTimes(4);
  });

  it("should create independent server instances", () => {
    const resolver = jest.fn();
    const server1 = service.createServer(resolver);
    const server2 = service.createServer(resolver);
    expect(server1).not.toBe(server2);
  });
});
