import { McpCategoryTreeResource } from "./category-tree.resource";
import { UserContextResolver } from "../mcp-context";

describe("McpCategoryTreeResource", () => {
  let resource: McpCategoryTreeResource;
  let categoriesService: Record<string, jest.Mock>;
  let server: { registerResource: jest.Mock };
  let resolve: jest.MockedFunction<UserContextResolver>;
  let handler: (...args: any[]) => any;

  beforeEach(() => {
    categoriesService = {
      getTree: jest.fn(),
    };

    resource = new McpCategoryTreeResource(categoriesService as any);

    server = {
      registerResource: jest.fn((_name, _uri, _opts, h) => {
        handler = h;
      }),
    };

    resolve = jest.fn();
    resource.register(server as any, resolve);
  });

  it("should register the resource", () => {
    expect(server.registerResource).toHaveBeenCalledWith(
      "categories",
      "monize://categories",
      expect.any(Object),
      expect.any(Function),
    );
  });

  it("should return error when no user context", async () => {
    resolve.mockReturnValue(undefined);
    const result = await handler("monize://categories", { sessionId: "s1" });
    expect(result.contents[0].text).toContain("Error");
  });

  it("should return category tree", async () => {
    resolve.mockReturnValue({ userId: "u1", scopes: "read" });
    categoriesService.getTree.mockResolvedValue([
      { id: "c1", name: "Food", children: [{ id: "c2", name: "Groceries" }] },
    ]);

    const result = await handler("monize://categories", { sessionId: "s1" });
    const parsed = JSON.parse(result.contents[0].text);
    expect(parsed[0].name).toBe("Food");
    expect(parsed[0].children).toHaveLength(1);
  });
});
