import { Injectable } from "@nestjs/common";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

@Injectable()
export class McpBudgetCheckPrompt {
  register(server: McpServer) {
    server.registerPrompt(
      "budget-check",
      {
        description: "Check spending patterns against typical monthly expenses",
        argsSchema: {
          month: z
            .string()
            .optional()
            .describe("Month to check (e.g., '2025-01' or 'January 2025')"),
        },
      },
      async (args) => {
        const month = args.month || "this month";
        return {
          messages: [
            {
              role: "user" as const,
              content: {
                type: "text" as const,
                text: [
                  `How am I tracking against my typical spending for ${month}? Use the available tools to:`,
                  "",
                  "1. Get spending breakdown by category for the specified month",
                  "2. Compare with the previous month's spending",
                  "3. Look at monthly trends to identify my typical spending patterns",
                  "4. Check upcoming bills that are still due",
                  "",
                  "Tell me which categories I'm spending more or less than usual,",
                  "and whether I'm on track for the month overall.",
                ].join("\n"),
              },
            },
          ],
        };
      },
    );
  }
}
