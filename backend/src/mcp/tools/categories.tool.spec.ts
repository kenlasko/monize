import { McpCategoriesTools } from "./categories.tool";
import { mcpTestCtx, McpTestContext } from "../testing/mcp-test-context";

describe("McpCategoriesTools", () => {
  let tool: McpCategoriesTools;
  let categoriesService: Record<string, jest.Mock>;
  let server: { registerTool: jest.Mock };
  let ctx: McpTestContext;
  const handlers: Record<string, (...args: any[]) => any> = {};

  beforeEach(() => {
    categoriesService = {
      getLlmCategories: jest.fn(),
    };

    tool = new McpCategoriesTools(categoriesService as any);

    server = {
      registerTool: jest.fn((name, _opts, handler) => {
        handlers[name] = handler;
      }),
    };

    ctx = mcpTestCtx();
    tool.register(server as any);
  });

  it("should register 1 tool", () => {
    expect(server.registerTool).toHaveBeenCalledTimes(1);
  });

  describe("list_categories", () => {
    it("returns error when no user context", async () => {
      ctx.setUser(undefined);
      const result = await handlers["list_categories"]({}, ctx);
      expect(result.isError).toBe(true);
    });

    it("delegates to categoriesService.getLlmCategories with no filters", async () => {
      ctx.setUser({ userId: "u1", scopes: "read" });
      categoriesService.getLlmCategories.mockResolvedValue({
        categories: [
          {
            id: "c1",
            name: "Food",
            parentName: null,
            type: "expense",
            transactionCount: 0,
          },
        ],
        totalCount: 1,
      });

      const result = await handlers["list_categories"]({}, ctx);
      expect(categoriesService.getLlmCategories).toHaveBeenCalledWith("u1", {
        type: undefined,
        search: undefined,
      });
      const parsed = result.structuredContent as any;
      expect(parsed.totalCount).toBe(1);
      expect(parsed.categories[0].name).toBe("Food");
    });

    it("passes type and search filters through", async () => {
      ctx.setUser({ userId: "u1", scopes: "read" });
      categoriesService.getLlmCategories.mockResolvedValue({
        categories: [],
        totalCount: 0,
      });

      await handlers["list_categories"](
        { type: "income", search: "salary" },
        ctx,
      );

      expect(categoriesService.getLlmCategories).toHaveBeenCalledWith("u1", {
        type: "income",
        search: "salary",
      });
    });

    it("handles service errors", async () => {
      ctx.setUser({ userId: "u1", scopes: "read" });
      categoriesService.getLlmCategories.mockRejectedValue(
        new Error("DB fail"),
      );

      const result = await handlers["list_categories"]({}, ctx);
      expect(result.isError).toBe(true);
    });

    it("returns error when scope is insufficient", async () => {
      ctx.setUser({ userId: "u1", scopes: "write_only" } as any);
      const result = await handlers["list_categories"]({}, ctx);
      expect(result.isError).toBe(true);
    });
  });
});
