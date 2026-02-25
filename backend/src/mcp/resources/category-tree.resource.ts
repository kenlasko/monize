import { Injectable } from "@nestjs/common";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CategoriesService } from "../../categories/categories.service";
import { UserContextResolver, hasScope } from "../mcp-context";

@Injectable()
export class McpCategoryTreeResource {
  constructor(private readonly categoriesService: CategoriesService) {}

  register(server: McpServer, resolve: UserContextResolver) {
    server.registerResource(
      "categories",
      "monize://categories",
      {
        description: "Full category hierarchy",
      },
      async (_uri, extra) => {
        const ctx = resolve(extra.sessionId);
        if (!ctx) {
          return {
            contents: [
              { uri: "monize://categories", text: "Error: No user context" },
            ],
          };
        }
        if (!hasScope(ctx.scopes, "read")) {
          return {
            contents: [
              {
                uri: "monize://categories",
                text: 'Error: Insufficient scope. Requires "read" scope.',
              },
            ],
          };
        }

        const tree = await this.categoriesService.getTree(ctx.userId);

        return {
          contents: [
            {
              uri: "monize://categories",
              mimeType: "application/json",
              text: JSON.stringify(tree, null, 2),
            },
          ],
        };
      },
    );
  }
}
