import { Injectable } from "@nestjs/common";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

@Injectable()
export class McpFinancialReviewPrompt {
  register(server: McpServer) {
    server.registerPrompt(
      "financial-review",
      {
        description: "Review finances for a period and provide insights",
        argsSchema: {
          period: z
            .string()
            .optional()
            .describe(
              "Time period to review (e.g., 'last month', 'Q1 2025', 'January 2025')",
            ),
        },
      },
      async (args) => {
        const period = args.period || "the current month";
        return {
          messages: [
            {
              role: "user" as const,
              content: {
                type: "text" as const,
                text: [
                  `Please review my finances for ${period}. Use the available tools to:`,
                  "",
                  "1. Get my account summary and net worth",
                  "2. Look at spending by category for the period",
                  "3. Compare income vs expenses",
                  "4. Check for any unusual transactions or anomalies",
                  "5. Review upcoming bills",
                  "",
                  "Provide a clear summary with actionable insights about my financial health,",
                  "spending trends, and any areas where I might want to adjust my habits.",
                ].join("\n"),
              },
            },
          ],
        };
      },
    );
  }
}
