import { Injectable } from "@nestjs/common";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

@Injectable()
export class McpTransactionLookupPrompt {
  register(server: McpServer) {
    server.registerPrompt(
      "transaction-lookup",
      {
        description: "Help find specific transactions",
        argsSchema: {
          query: z
            .string()
            .describe(
              "What to search for (e.g., 'Amazon purchases last month', 'rent payments')",
            ),
        },
      },
      async (args) => {
        return {
          messages: [
            {
              role: "user" as const,
              content: {
                type: "text" as const,
                text: [
                  `Help me find transactions matching: "${args.query}"`,
                  "",
                  "Use the search_transactions tool with appropriate filters.",
                  "If the query mentions a time period, set the date range accordingly.",
                  "If it mentions a specific payee or category, use those filters too.",
                  "",
                  "Show me the matching transactions in a clear format with dates, amounts,",
                  "payees, and categories. Also provide a total if relevant.",
                ].join("\n"),
              },
            },
          ],
        };
      },
    );
  }
}
