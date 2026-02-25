import { McpAccountListResource } from "./account-list.resource";
import { UserContextResolver } from "../mcp-context";

describe("McpAccountListResource", () => {
  let resource: McpAccountListResource;
  let accountsService: Record<string, jest.Mock>;
  let server: { registerResource: jest.Mock };
  let resolve: jest.MockedFunction<UserContextResolver>;
  let handler: (...args: any[]) => any;

  beforeEach(() => {
    accountsService = {
      findAll: jest.fn(),
      getSummary: jest.fn(),
    };

    resource = new McpAccountListResource(accountsService as any);

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
      "accounts",
      "monize://accounts",
      expect.any(Object),
      expect.any(Function),
    );
  });

  it("should return error when no user context", async () => {
    resolve.mockReturnValue(undefined);
    const result = await handler("monize://accounts", { sessionId: "s1" });
    expect(result.contents[0].text).toContain("Error");
  });

  it("should return error when scope check fails", async () => {
    resolve.mockReturnValue({ userId: "u1", scopes: "write" });
    const result = await handler("monize://accounts", { sessionId: "s1" });
    expect(result.contents[0].text).toContain("Insufficient scope");
  });

  it("should return accounts and summary", async () => {
    resolve.mockReturnValue({ userId: "u1", scopes: "read" });
    accountsService.findAll.mockResolvedValue([{ id: "a1", name: "Checking" }]);
    accountsService.getSummary.mockResolvedValue({ netWorth: 5000 });

    const result = await handler("monize://accounts", { sessionId: "s1" });
    expect(result.contents[0].mimeType).toBe("application/json");
    const parsed = JSON.parse(result.contents[0].text);
    expect(parsed.accounts).toHaveLength(1);
    expect(parsed.summary.netWorth).toBe(5000);
  });
});
