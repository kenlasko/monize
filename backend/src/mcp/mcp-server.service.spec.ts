import { Test, TestingModule } from "@nestjs/testing";
import {
  CLIENT_CAPABILITIES_META_KEY,
  PROTOCOL_VERSION_META_KEY,
  createMcpHandler,
} from "@modelcontextprotocol/server";
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
import { McpRulesTools } from "./tools/rules.tool";
import { McpAiReviewTools } from "./tools/ai-review.tool";
import { McpEmailReceiptParserTools } from "./tools/email-receipt-parsers.tool";
import { McpBondSeriesTools } from "./tools/bond-series.tool";
import { McpWarrantiesTools } from "./tools/warranties.tool";
import { McpHelpTools } from "./tools/help.tool";
import { McpAccountListResource } from "./resources/account-list.resource";
import { McpCategoryTreeResource } from "./resources/category-tree.resource";
import { McpRecentTransactionsResource } from "./resources/recent-transactions.resource";
import { McpFinancialSummaryResource } from "./resources/financial-summary.resource";
import { McpRelayAttachmentResource } from "./resources/relay-attachment.resource";
import { McpFinancialReviewPrompt } from "./prompts/financial-review.prompt";
import { McpBudgetCheckPrompt } from "./prompts/budget-check.prompt";
import { McpTransactionLookupPrompt } from "./prompts/transaction-lookup.prompt";
import { McpSpendingAnalysisPrompt } from "./prompts/spending-analysis.prompt";
import { AiRelayService } from "../ai/relay/ai-relay.service";
import { McpRequestStateCodec } from "./mcp-request-state";

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
        { provide: McpRulesTools, useValue: mockToolProvider },
        { provide: McpAiReviewTools, useValue: mockToolProvider },
        { provide: McpEmailReceiptParserTools, useValue: mockToolProvider },
        { provide: McpBondSeriesTools, useValue: mockToolProvider },
        { provide: McpWarrantiesTools, useValue: mockToolProvider },
        { provide: McpHelpTools, useValue: mockToolProvider },
        { provide: McpRelayTools, useValue: mockToolProvider },
        {
          provide: AiRelayService,
          useValue: { reportToolActivity: jest.fn() },
        },
        {
          provide: McpRequestStateCodec,
          useValue: new McpRequestStateCodec({
            get: () => "test-secret",
          } as any),
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
        {
          provide: McpRelayAttachmentResource,
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
    const server = service.createServer();
    expect(server).toBeDefined();
  });

  it("advertises the backend package.json version (auto-updates with releases)", () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { version } = require("../../package.json") as { version: string };
    const server = service.createServer();
    const serverInfo = (server.server as any)._serverInfo as {
      name: string;
      version: string;
    };
    expect(serverInfo.name).toBe("monize");
    expect(serverInfo.version).toBe(version);
    expect(serverInfo.version).not.toBe("1.0.0");
  });

  it("should register all tools", () => {
    service.createServer();
    expect(mockToolProvider.register).toHaveBeenCalledTimes(16);
  });

  it("should register all resources", () => {
    service.createServer();
    expect(mockResourceProvider.register).toHaveBeenCalledTimes(5);
  });

  it("should register all prompts", () => {
    service.createServer();
    expect(mockPromptProvider.register).toHaveBeenCalledTimes(4);
  });

  it("should create independent server instances", () => {
    const server1 = service.createServer();
    const server2 = service.createServer();
    expect(server1).not.toBe(server2);
  });

  // The 2026-07-28 revision requires every cacheable result to say how long it
  // may be kept and by whom (SEP-2549). Asserted on the wire, because the
  // typed result strips fields the client does not model, and against the real
  // factory, because the values are its decision.
  describe("cacheable results", () => {
    async function listToolsRaw() {
      const handler = createMcpHandler(() => service.createServer(), {
        legacy: "reject",
      });
      try {
        const response = await handler.fetch(
          new Request("http://mcp.test/mcp", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              accept: "application/json, text/event-stream",
              "mcp-method": "tools/list",
              "MCP-Protocol-Version": "2026-07-28",
            },
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              method: "tools/list",
              params: {
                _meta: {
                  [PROTOCOL_VERSION_META_KEY]: "2026-07-28",
                  [CLIENT_CAPABILITIES_META_KEY]: {},
                },
              },
            }),
          }),
        );
        return (await response.json()) as {
          result?: { ttlMs?: number; cacheScope?: string };
        };
      } finally {
        await handler.close();
      }
    }

    it("tells a client how long a listing may be cached, and privately", async () => {
      const body = await listToolsRaw();
      // The listing changes only when the image does; the response is
      // bearer-scoped, so no shared cache may hold it.
      expect(body.result?.ttlMs).toBeGreaterThan(0);
      expect(body.result?.cacheScope).toBe("private");
    });
  });

  // logging/setLevel is gone in 2026-07-28 and the feature is deprecated
  // (SEP-2577); advertising a capability obliges the server to answer its
  // requests, and this one never had anything to answer.
  it("advertises no logging capability", () => {
    const server = service.createServer();
    const capabilities =
      (server.server as any).getCapabilities?.() ??
      (server.server as any)._capabilities;
    expect(capabilities).not.toHaveProperty("logging");
    expect(capabilities).toMatchObject({
      tools: {},
      resources: {},
      prompts: {},
    });
  });
});
