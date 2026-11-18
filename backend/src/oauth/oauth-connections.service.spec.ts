import { Logger, NotFoundException } from "@nestjs/common";
import type { DataSource } from "typeorm";
import { OAuthConnectionsService } from "./oauth-connections.service";
import type { OAuthProviderService } from "./oauth-provider.service";
import {
  findGrantsForAccount,
  revokeGrantForAccount,
  type AccountGrantRow,
} from "./postgres.adapter";

jest.mock("./postgres.adapter", () => ({
  findGrantsForAccount: jest.fn(),
  revokeGrantForAccount: jest.fn(),
}));

const USER = "11111111-1111-1111-1111-111111111111";
const RESOURCE = "https://monize.test/api/v1/mcp";
const findGrants = findGrantsForAccount as jest.MockedFunction<
  typeof findGrantsForAccount
>;
const revokeGrant = revokeGrantForAccount as jest.MockedFunction<
  typeof revokeGrantForAccount
>;

function grant(overrides: Partial<AccountGrantRow> = {}): AccountGrantRow {
  return {
    id: "grant-1",
    payload: {
      accountId: USER,
      clientId: "client-1",
      iat: 1_800_000_000,
      resources: { [RESOURCE]: "monize:read monize:write" },
    },
    expiresAt: new Date("2027-01-15T00:00:00.000Z"),
    lastUsedAt: new Date("2027-01-02T03:04:05.000Z"),
    ...overrides,
  };
}

function makeService(clientFind: jest.Mock) {
  const providerService = {
    getMcpResourceUrl: () => RESOURCE,
    getProvider: () => ({ Client: { find: clientFind } }),
  } as unknown as OAuthProviderService;
  const dataSource = {} as DataSource;
  return {
    service: new OAuthConnectionsService(dataSource, providerService),
    dataSource,
  };
}

describe("OAuthConnectionsService", () => {
  beforeEach(() => jest.clearAllMocks());

  it("lists each grant with its client's destinations, scopes and dates", async () => {
    findGrants.mockResolvedValue([grant()]);
    const clientFind = jest.fn().mockResolvedValue({
      clientName: "Claude",
      redirectUris: [
        "https://claude.test/api/mcp/auth_callback",
        "https://claude.test/other",
        "http://127.0.0.1:3000/cb",
        42,
        "not a url",
      ],
    });
    const { service, dataSource } = makeService(clientFind);

    await expect(service.list(USER)).resolves.toEqual([
      {
        id: "grant-1",
        clientId: "client-1",
        clientName: "Claude",
        clientKnown: true,
        destinations: ["https://claude.test", "http://127.0.0.1:3000"],
        scopes: ["read", "write"],
        grantedAt: new Date(1_800_000_000 * 1000).toISOString(),
        expiresAt: "2027-01-15T00:00:00.000Z",
        lastUsedAt: "2027-01-02T03:04:05.000Z",
      },
    ]);
    expect(findGrants).toHaveBeenCalledWith(dataSource, USER);
    expect(clientFind).toHaveBeenCalledWith("client-1");
  });

  it("looks each client up once, however many grants name it", async () => {
    findGrants.mockResolvedValue([grant(), grant({ id: "grant-2" })]);
    const clientFind = jest.fn().mockResolvedValue({ clientName: "Claude" });
    const { service } = makeService(clientFind);

    const apps = await service.list(USER);

    expect(apps.map((a) => a.id)).toEqual(["grant-1", "grant-2"]);
    expect(clientFind).toHaveBeenCalledTimes(1);
    expect(apps[0].destinations).toEqual([]);
  });

  it("cleans a stored name and falls back to the client id", async () => {
    findGrants.mockResolvedValue([
      grant(),
      grant({
        id: "grant-2",
        payload: { ...grant().payload, clientId: "client-2" },
      }),
    ]);
    const clientFind = jest
      .fn()
      .mockResolvedValueOnce({ clientName: "Google‮SignIn" })
      .mockResolvedValueOnce({ clientName: 7 });
    const { service } = makeService(clientFind);

    const apps = await service.list(USER);

    expect(apps[0].clientName).toBe("Google SignIn");
    expect(apps[1].clientName).toBe("client-2");
  });

  it("marks a client whose registration has expired or cannot be read as unknown", async () => {
    findGrants.mockResolvedValue([
      grant(),
      grant({
        id: "grant-2",
        payload: { ...grant().payload, clientId: "client-2" },
      }),
      grant({ id: "grant-3", payload: { accountId: USER } }),
    ]);
    const warn = jest
      .spyOn(Logger.prototype, "warn")
      .mockImplementation(() => undefined);
    const clientFind = jest
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("db down"));
    const { service } = makeService(clientFind);

    const apps = await service.list(USER);

    expect(apps.map((a) => [a.clientKnown, a.clientName])).toEqual([
      [false, "client-1"],
      [false, "client-2"],
      [false, "grant-3"],
    ]);
    expect(apps[2].scopes).toEqual([]);
    expect(apps[2].grantedAt).toBeNull();
    expect(clientFind).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("db down"));
    warn.mockRestore();
  });

  it("reports only the MCP resource's scopes, and unknown dates as null", async () => {
    findGrants.mockResolvedValue([
      grant({
        payload: {
          clientId: "client-1",
          iat: "soon",
          resources: {
            [RESOURCE]: "openid monize:read",
            "https://other.test": "monize:write",
          },
        },
        expiresAt: null,
        lastUsedAt: null,
      }),
    ]);
    const { service } = makeService(jest.fn().mockResolvedValue(undefined));

    const [app] = await service.list(USER);

    expect(app.scopes).toEqual(["read"]);
    expect(app.grantedAt).toBeNull();
    expect(app.expiresAt).toBeNull();
    expect(app.lastUsedAt).toBeNull();
  });

  it("revokes the session user's own grant", async () => {
    revokeGrant.mockResolvedValue(true);
    const { service, dataSource } = makeService(jest.fn());

    await expect(service.revoke(USER, "grant-1")).resolves.toBeUndefined();
    expect(revokeGrant).toHaveBeenCalledWith(dataSource, USER, "grant-1");
  });

  it("answers 404 when the account holds no such grant", async () => {
    revokeGrant.mockResolvedValue(false);
    const { service } = makeService(jest.fn());

    await expect(service.revoke(USER, "someone-elses")).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
