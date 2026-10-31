import { McpAccountsTools } from "../tools/accounts.tool";
import { McpTransactionsTools } from "../tools/transactions.tool";
import { McpCategoriesTools } from "../tools/categories.tool";
import { McpPayeesTools } from "../tools/payees.tool";
import { McpReportsTools } from "../tools/reports.tool";
import { McpInvestmentsTools } from "../tools/investments.tool";
import { McpScheduledTools } from "../tools/scheduled.tool";
import { McpCalculateTools } from "../tools/calculate.tool";
import { McpBudgetsTools } from "../tools/budgets.tool";
import { McpRelayTools } from "../tools/relay.tool";
import { McpRulesTools } from "../tools/rules.tool";
import { McpAiReviewTools } from "../tools/ai-review.tool";
import { McpEmailReceiptParserTools } from "../tools/email-receipt-parsers.tool";
import { McpBondSeriesTools } from "../tools/bond-series.tool";
import { McpWarrantiesTools } from "../tools/warranties.tool";

/**
 * Test helper: capture every tool's `registerTool` config without booting Nest.
 *
 * Shared by `mcp-annotations.spec.ts` (spec-compliance checks) and
 * `tools-list-budget.spec.ts` (payload size). It lives here rather than in a
 * spec because a spec must not be imported by another spec.
 *
 * The providers only read their service dependencies inside handlers, never
 * during `register()`, so empty mocks are sufficient to capture the configs.
 * The registration ORDER is meaningful: it is the order the SDK lists tools in,
 * which the 2026-07-28 revision asks to be deterministic.
 */

export interface CapturedToolConfig {
  name: string;
  // The SDK's registerTool config: title, description, annotations and the two
  // Zod schemas. Deliberately loose -- callers assert on individual fields.
  config: any;
}

interface ToolProvider {
  register: (server: unknown, resolve?: unknown) => void;
}

export function collectToolConfigs(): CapturedToolConfig[] {
  const providers: ToolProvider[] = [
    new McpAccountsTools({} as any, {} as any) as unknown as ToolProvider,
    new McpTransactionsTools(
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    ) as unknown as ToolProvider,
    new McpCategoriesTools({} as any) as unknown as ToolProvider,
    new McpPayeesTools(
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    ) as unknown as ToolProvider,
    new McpReportsTools(
      {} as any,
      {} as any,
      {} as any,
    ) as unknown as ToolProvider,
    new McpInvestmentsTools(
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    ) as unknown as ToolProvider,
    new McpScheduledTools({} as any) as unknown as ToolProvider,
    new McpCalculateTools({} as any) as unknown as ToolProvider,
    new McpBudgetsTools({} as any, {} as any) as unknown as ToolProvider,
    new McpRulesTools(
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    ) as unknown as ToolProvider,
    new McpAiReviewTools({} as any, {} as any) as unknown as ToolProvider,
    new McpEmailReceiptParserTools({} as any) as unknown as ToolProvider,
    new McpBondSeriesTools({} as any, {} as any) as unknown as ToolProvider,
    new McpWarrantiesTools({} as any) as unknown as ToolProvider,
    new McpRelayTools({} as any) as unknown as ToolProvider,
  ];

  const configs: CapturedToolConfig[] = [];
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
