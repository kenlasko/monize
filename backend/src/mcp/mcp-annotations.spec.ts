import { McpAccountsTools } from "./tools/accounts.tool";
import { McpTransactionsTools } from "./tools/transactions.tool";
import { McpCategoriesTools } from "./tools/categories.tool";
import { McpPayeesTools } from "./tools/payees.tool";
import { McpReportsTools } from "./tools/reports.tool";
import { McpInvestmentsTools } from "./tools/investments.tool";
import { McpNetWorthTools } from "./tools/net-worth.tool";
import { McpScheduledTools } from "./tools/scheduled.tool";
import { McpCalculateTools } from "./tools/calculate.tool";
import { McpBudgetsTools } from "./tools/budgets.tool";

// Tools that mutate state; everything else must be read-only.
const WRITE_TOOLS = new Set([
  "create_transaction",
  "create_payee",
  "categorize_transaction",
]);
// Write tools whose repeated calls converge to the same state.
const IDEMPOTENT_WRITES = new Set(["categorize_transaction"]);

const EXPECTED_TOOL_COUNT = 27;

interface ToolProvider {
  register: (server: unknown, resolve?: unknown) => void;
}

function collectToolConfigs(): Array<{ name: string; config: any }> {
  // Providers only read their service deps inside handlers, never during
  // register(), so empty mocks are sufficient to capture the tool configs.
  const providers: ToolProvider[] = [
    new McpAccountsTools({} as any) as unknown as ToolProvider,
    new McpTransactionsTools(
      {} as any,
      {} as any,
      {} as any,
    ) as unknown as ToolProvider,
    new McpCategoriesTools({} as any) as unknown as ToolProvider,
    new McpPayeesTools({} as any) as unknown as ToolProvider,
    new McpReportsTools({} as any) as unknown as ToolProvider,
    new McpInvestmentsTools(
      {} as any,
      {} as any,
      {} as any,
    ) as unknown as ToolProvider,
    new McpNetWorthTools({} as any, {} as any) as unknown as ToolProvider,
    new McpScheduledTools({} as any) as unknown as ToolProvider,
    new McpCalculateTools() as unknown as ToolProvider,
    new McpBudgetsTools({} as any) as unknown as ToolProvider,
  ];

  const configs: Array<{ name: string; config: any }> = [];
  const fakeServer = {
    registerTool: (name: string, config: any) => {
      configs.push({ name, config });
    },
  };
  const resolve = () => undefined;
  for (const provider of providers) {
    provider.register(fakeServer, resolve);
  }
  return configs;
}

describe("MCP tool spec compliance", () => {
  const configs = collectToolConfigs();

  it("registers the expected number of tools", () => {
    expect(configs).toHaveLength(EXPECTED_TOOL_COUNT);
  });

  it("gives every tool a unique name", () => {
    const names = configs.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
  });

  describe.each(collectToolConfigs())("$name", ({ name, config }) => {
    it("declares a human-readable title", () => {
      expect(typeof config.title).toBe("string");
      expect(config.title.length).toBeGreaterThan(0);
    });

    it("declares both an input and output schema", () => {
      expect(config.inputSchema).toBeDefined();
      expect(config.outputSchema).toBeDefined();
    });

    it("declares annotations over a closed (non-open-world) dataset", () => {
      expect(config.annotations).toBeDefined();
      expect(config.annotations.openWorldHint).toBe(false);
    });

    it("sets read/write hints matching the tool's effect", () => {
      if (WRITE_TOOLS.has(name)) {
        expect(config.annotations.readOnlyHint).toBe(false);
        expect(config.annotations.destructiveHint).toBe(false);
        expect(config.annotations.idempotentHint).toBe(
          IDEMPOTENT_WRITES.has(name),
        );
      } else {
        expect(config.annotations.readOnlyHint).toBe(true);
      }
    });
  });
});
