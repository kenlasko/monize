import { Injectable } from "@nestjs/common";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { AccountsService } from "../../accounts/accounts.service";
import { UserContextResolver, hasScope } from "../mcp-context";

@Injectable()
export class McpAccountListResource {
  constructor(private readonly accountsService: AccountsService) {}

  register(server: McpServer, resolve: UserContextResolver) {
    server.registerResource(
      "accounts",
      "monize://accounts",
      {
        description: "Current account list with types and balances",
      },
      async (_uri, extra) => {
        const ctx = resolve(extra.sessionId);
        if (!ctx) {
          return {
            contents: [
              { uri: "monize://accounts", text: "Error: No user context" },
            ],
          };
        }
        if (!hasScope(ctx.scopes, "read")) {
          return {
            contents: [
              {
                uri: "monize://accounts",
                text: 'Error: Insufficient scope. Requires "read" scope.',
              },
            ],
          };
        }

        try {
          const [accounts, summary] = await Promise.all([
            this.accountsService.findAll(ctx.userId, false),
            this.accountsService.getSummary(ctx.userId),
          ]);

          return {
            contents: [
              {
                uri: "monize://accounts",
                mimeType: "application/json",
                text: JSON.stringify({ accounts, summary }, null, 2),
              },
            ],
          };
        } catch {
          return {
            contents: [
              {
                uri: "monize://accounts",
                text: "Error: An error occurred while loading accounts",
              },
            ],
          };
        }
      },
    );
  }
}
