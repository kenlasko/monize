import { Injectable } from "@nestjs/common";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

@Injectable()
export class McpSpendingAnalysisPrompt {
  register(server: McpServer) {
    server.registerPrompt(
      "spending-analysis",
      {
        description: "Analyze spending patterns in a category or overall",
        argsSchema: {
          category: z
            .string()
            .optional()
            .describe("Category to analyze (e.g., 'Food', 'Entertainment')"),
          period: z
            .string()
            .optional()
            .describe("Time period (e.g., 'last 3 months', '2025')"),
        },
      },
      async (args) => {
        const category = args.category || "all categories";
        const period = args.period || "the last 3 months";
        return {
          messages: [
            {
              role: "user" as const,
              content: {
                type: "text" as const,
                text: [
                  `Analyze my spending patterns for ${category} over ${period}. Use the available tools to:`,
                  "",
                  "1. Get spending breakdown for the period",
                  "2. Look at monthly trends",
                  "3. Search for relevant transactions",
                  "4. Compare with a previous equivalent period if possible",
                  "",
                  "Provide insights on:",
                  "- Total spending and average per month",
                  "- Trends (increasing, decreasing, stable)",
                  "- Top payees in this category",
                  "- Any unusual spikes or patterns",
                  "- Suggestions for optimization",
                ].join("\n"),
              },
            },
          ],
        };
      },
    );
  }
}
