import { McpServer } from "@modelcontextprotocol/server";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { ServiceUnavailableException } from "@nestjs/common";
import { McpReportsTools } from "./tools/reports.tool";
import { mcpTestCtx } from "./testing/mcp-test-context";
import type { BuiltInReportsService } from "../built-in-reports/built-in-reports.service";

describe("Reporting basis and repair metadata through the real MCP SDK", () => {
  it("lists the schema, round-trips the selected basis and preserves approved errors without leaking internals", async () => {
    const server = new McpServer(
      { name: "reporting-test", version: "0.0.0" },
      { capabilities: { tools: {} } },
    );
    const getLlmReport = jest
      .fn()
      .mockImplementation(async (_user: string, input: { basis: string }) => ({
        type: "net_worth_history",
        basis: input.basis,
        currency: "EUR",
        fxComplete: true,
        result: [{ month: "2026-06-01", netWorth: 100 }],
      }));
    const tools = new McpReportsTools({
      getLlmReport,
    } as unknown as BuiltInReportsService);
    tools.register({
      registerTool: (name: string, config: any, handler: any) =>
        server.registerTool(name, config, (args: any) =>
          handler(args, mcpTestCtx({ userId: "owner", scopes: "read" })),
        ),
    } as unknown as McpServer);
    const client = new Client(
      { name: "test-client", version: "0.0.0" },
      { capabilities: {} },
    );
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const listed = await client.listTools();
      expect(
        (listed.tools[0].inputSchema.properties as Record<string, unknown>)
          .basis,
      ).toBeDefined();
      const result = await client.callTool({
        name: "generate_report",
        arguments: { type: "net_worth_history", basis: "cash" },
      });
      expect(result.structuredContent).toMatchObject({
        basis: "cash",
        currency: "EUR",
        result: [{ month: "2026-06-01", netWorth: 100 }],
      });
      expect(getLlmReport).toHaveBeenCalledWith("owner", {
        type: "net_worth_history",
        basis: "cash",
      });
      getLlmReport.mockRejectedValueOnce(
        new ServiceUnavailableException({
          code: "REPORTING_FX_INCOMPLETE",
          missingRatePairs: [{ from: "USD", to: "EUR", date: "2026-06-30" }],
          stack: "secret internal",
        }),
      );
      const error = await client.callTool({
        name: "generate_report",
        arguments: { type: "net_worth_history", basis: "accrual" },
      });
      expect(error.isError).toBe(true);
      expect(error.structuredContent).toMatchObject({
        error: {
          code: "REPORTING_FX_INCOMPLETE",
          repair: "currency_rate_history",
          missingRatePairs: [{ from: "USD", to: "EUR", date: "2026-06-30" }],
        },
      });
      expect(JSON.stringify(error)).not.toContain("secret internal");
    } finally {
      await client.close();
      await server.close();
    }
  });
});
