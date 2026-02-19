import { McpCategoriesTools } from "./categories.tool";
import { UserContextResolver } from "../mcp-context";

describe("McpCategoriesTools", () => {
  let tool: McpCategoriesTools;
  let categoriesService: Record<string, jest.Mock>;
  let server: { registerTool: jest.Mock };
  let resolve: jest.MockedFunction<UserContextResolver>;
  const handlers: Record<string, (...args: any[]) => any> = {};

  beforeEach(() => {
    categoriesService = {
      getTree: jest.fn(),
      findByType: jest.fn(),
    };

    tool = new McpCategoriesTools(categoriesService as any);

    server = {
      registerTool: jest.fn((name, _opts, handler) => {
        handlers[name] = handler;
      }),
    };

    resolve = jest.fn();
    tool.register(server as any, resolve);
  });

  it("should register 1 tool", () => {
    expect(server.registerTool).toHaveBeenCalledTimes(1);
  });

  describe("get_categories", () => {
    it("should return error when no user context", async () => {
      resolve.mockReturnValue(undefined);
      const result = await handlers["get_categories"]({}, { sessionId: "s1" });
      expect(result.isError).toBe(true);
    });

    it("should return full tree when no type filter", async () => {
      resolve.mockReturnValue({ userId: "u1", scopes: "read" });
      categoriesService.getTree.mockResolvedValue([{ id: "c1", name: "Food" }]);

      const result = await handlers["get_categories"]({}, { sessionId: "s1" });
      expect(categoriesService.getTree).toHaveBeenCalledWith("u1");
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed[0].name).toBe("Food");
    });

    it("should filter by income type", async () => {
      resolve.mockReturnValue({ userId: "u1", scopes: "read" });
      categoriesService.findByType.mockResolvedValue([
        { id: "c2", name: "Salary" },
      ]);

      const result = await handlers["get_categories"](
        { type: "income" },
        { sessionId: "s1" },
      );
      expect(categoriesService.findByType).toHaveBeenCalledWith("u1", true);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed[0].name).toBe("Salary");
    });

    it("should filter by expense type", async () => {
      resolve.mockReturnValue({ userId: "u1", scopes: "read" });
      categoriesService.findByType.mockResolvedValue([
        { id: "c3", name: "Rent" },
      ]);

      await handlers["get_categories"](
        { type: "expense" },
        { sessionId: "s1" },
      );
      expect(categoriesService.findByType).toHaveBeenCalledWith("u1", false);
    });

    it("should handle service errors", async () => {
      resolve.mockReturnValue({ userId: "u1", scopes: "read" });
      categoriesService.getTree.mockRejectedValue(new Error("DB fail"));

      const result = await handlers["get_categories"]({}, { sessionId: "s1" });
      expect(result.isError).toBe(true);
    });
  });
});
