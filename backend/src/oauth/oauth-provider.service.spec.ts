import { InternalServerErrorException } from "@nestjs/common";
import {
  OAuthProviderService,
  MCP_RESOURCE_SCOPES,
} from "./oauth-provider.service";

// Capture constructor calls so tests can inspect the configuration handed to
// node-oidc-provider's Provider constructor without instantiating the real
// (ESM) library.
const providerConstructorCalls: Array<{
  issuer: string;
  config: Record<string, unknown>;
}> = [];

interface MockProvider {
  proxy?: boolean;
  on: jest.Mock;
  AccessToken: { find: jest.Mock };
}

const eventListeners: Record<string, Array<(...args: unknown[]) => unknown>> =
  {};

function createMockProvider(): MockProvider {
  return {
    on: jest.fn((evt: string, cb: (...args: unknown[]) => unknown) => {
      const list = eventListeners[evt] || (eventListeners[evt] = []);
      list.push(cb);
    }),
    AccessToken: { find: jest.fn() },
  };
}

let lastMockProvider: MockProvider;

jest.mock(
  "oidc-provider",
  () => {
    return {
      __esModule: true,
      default: jest
        .fn()
        .mockImplementation((issuer: string, config: Record<string, unknown>) => {
          providerConstructorCalls.push({ issuer, config });
          lastMockProvider = createMockProvider();
          return lastMockProvider;
        }),
    };
  },
  { virtual: true },
);

function makeConfigService(values: Record<string, string | undefined>) {
  return {
    get: jest.fn((key: string) => values[key]),
  } as unknown as import("@nestjs/config").ConfigService;
}

function makeAuthService(
  user: {
    id: string;
    isActive: boolean;
    mustChangePassword: boolean;
  } | null,
) {
  return {
    getUserStateById: jest.fn().mockResolvedValue(user),
  } as unknown as import("../auth/auth.service").AuthService;
}

function makeDataSource(deleteAffected = 1) {
  const execute = jest.fn().mockResolvedValue({ affected: deleteAffected });
  const where = jest.fn().mockReturnValue({ execute });
  const del = jest.fn().mockReturnValue({ where });
  const createQueryBuilder = jest.fn().mockReturnValue({ delete: del });
  const repo = { createQueryBuilder };
  const getRepository = jest.fn().mockReturnValue(repo);
  return {
    dataSource: { getRepository } as unknown as import("typeorm").DataSource,
    execute,
    where,
    del,
    getRepository,
  };
}

const VALID_JWT = "a".repeat(32);

describe("OAuthProviderService", () => {
  beforeEach(() => {
    providerConstructorCalls.length = 0;
    for (const k of Object.keys(eventListeners)) delete eventListeners[k];
  });

  describe("requirePublicUrl / URL helpers (uninitialized)", () => {
    it("throws if PUBLIC_APP_URL is missing during initialize()", async () => {
      const svc = new OAuthProviderService(
        makeConfigService({}),
        makeDataSource().dataSource,
        makeAuthService(null),
      );
      await expect(svc.ensureInitialized()).rejects.toThrow(/PUBLIC_APP_URL/);
    });

    it("throws if JWT_SECRET is missing or too short", async () => {
      const svc = new OAuthProviderService(
        makeConfigService({
          PUBLIC_APP_URL: "https://app.test/",
          JWT_SECRET: "short",
        }),
        makeDataSource().dataSource,
        makeAuthService(null),
      );
      await expect(svc.ensureInitialized()).rejects.toThrow(/JWT_SECRET/);
    });

    it("getProvider() throws when not initialized", () => {
      const svc = new OAuthProviderService(
        makeConfigService({}),
        makeDataSource().dataSource,
        makeAuthService(null),
      );
      expect(() => svc.getProvider()).toThrow(InternalServerErrorException);
    });

    it("getMcpResourceUrl/getIssuerUrl strip a trailing slash from the public URL", async () => {
      const svc = new OAuthProviderService(
        makeConfigService({
          PUBLIC_APP_URL: "https://app.test/",
          JWT_SECRET: VALID_JWT,
        }),
        makeDataSource().dataSource,
        makeAuthService({
          id: "u1",
          isActive: true,
          mustChangePassword: false,
        }),
      );
      // The public-URL helpers do not require initialization.
      expect(svc.getMcpResourceUrl()).toBe("https://app.test/api/v1/mcp");
      expect(svc.getIssuerUrl()).toBe("https://app.test/oauth");
    });
  });

  describe("ensureInitialized()", () => {
    it("constructs the OIDC provider once and is idempotent on repeated calls", async () => {
      const svc = new OAuthProviderService(
        makeConfigService({
          PUBLIC_APP_URL: "https://app.test",
          JWT_SECRET: VALID_JWT,
        }),
        makeDataSource().dataSource,
        makeAuthService({
          id: "u",
          isActive: true,
          mustChangePassword: false,
        }),
      );

      const p1 = await svc.ensureInitialized();
      const p2 = await svc.ensureInitialized();

      expect(p1).toBe(p2);
      expect(providerConstructorCalls).toHaveLength(1);
      expect(providerConstructorCalls[0].issuer).toBe(
        "https://app.test/oauth",
      );
      expect(providerConstructorCalls[0].config.scopes).toEqual([
        ...MCP_RESOURCE_SCOPES,
      ]);
      expect(svc.getProvider()).toBe(p1);
    });

    it("returns the same in-flight initPromise when called concurrently", async () => {
      const svc = new OAuthProviderService(
        makeConfigService({
          PUBLIC_APP_URL: "https://app.test",
          JWT_SECRET: VALID_JWT,
        }),
        makeDataSource().dataSource,
        makeAuthService({
          id: "u",
          isActive: true,
          mustChangePassword: false,
        }),
      );

      const [a, b] = await Promise.all([
        svc.ensureInitialized(),
        svc.ensureInitialized(),
      ]);

      expect(a).toBe(b);
      expect(providerConstructorCalls).toHaveLength(1);
    });

    it("onModuleInit triggers initialization", async () => {
      const svc = new OAuthProviderService(
        makeConfigService({
          PUBLIC_APP_URL: "https://app.test",
          JWT_SECRET: VALID_JWT,
        }),
        makeDataSource().dataSource,
        makeAuthService({
          id: "u",
          isActive: true,
          mustChangePassword: false,
        }),
      );
      await svc.onModuleInit();
      expect(providerConstructorCalls).toHaveLength(1);
    });
  });

  describe("provider configuration callbacks", () => {
    async function init(
      authUser: {
        id: string;
        isActive: boolean;
        mustChangePassword: boolean;
      } | null,
    ) {
      const auth = makeAuthService(authUser);
      const svc = new OAuthProviderService(
        makeConfigService({
          PUBLIC_APP_URL: "https://app.test",
          JWT_SECRET: VALID_JWT,
        }),
        makeDataSource().dataSource,
        auth,
      );
      await svc.ensureInitialized();
      return {
        svc,
        auth,
        config: providerConstructorCalls[0].config as Record<string, any>,
      };
    }

    it("pkce.required always returns true", async () => {
      const { config } = await init({
        id: "u",
        isActive: true,
        mustChangePassword: false,
      });
      expect(config.pkce.required()).toBe(true);
    });

    it("issueRefreshToken delegates to client.grantTypeAllowed", async () => {
      const { config } = await init({
        id: "u",
        isActive: true,
        mustChangePassword: false,
      });
      const client = { grantTypeAllowed: jest.fn().mockReturnValue(true) };
      await expect(
        config.issueRefreshToken({}, client, {}),
      ).resolves.toBe(true);
      expect(client.grantTypeAllowed).toHaveBeenCalledWith("refresh_token");
    });

    it("resourceIndicators returns expected metadata for the matching resource", async () => {
      const { config } = await init({
        id: "u",
        isActive: true,
        mustChangePassword: false,
      });
      const ri = config.features.resourceIndicators;
      const mcpResource = "https://app.test/api/v1/mcp";
      expect(ri.defaultResource()).toBe(mcpResource);
      expect(ri.useGrantedResource()).toBe(true);
      const info = ri.getResourceServerInfo({}, mcpResource);
      expect(info.audience).toBe(mcpResource);
      expect(info.scope).toBe(MCP_RESOURCE_SCOPES.join(" "));
      expect(info.accessTokenTTL).toBe(3600);
      expect(info.accessTokenFormat).toBe("opaque");
    });

    it("resourceIndicators throws for an unknown resource", async () => {
      const { config } = await init({
        id: "u",
        isActive: true,
        mustChangePassword: false,
      });
      expect(() =>
        config.features.resourceIndicators.getResourceServerInfo(
          {},
          "https://other/",
        ),
      ).toThrow(/Unknown resource/);
    });

    it("interactions.url returns the absolute consent URL", async () => {
      const { config } = await init({
        id: "u",
        isActive: true,
        mustChangePassword: false,
      });
      expect(config.interactions.url({}, { uid: "abc" })).toBe(
        "https://app.test/api/v1/oauth-consent/abc",
      );
    });

    it("findAccount returns the account for an active user", async () => {
      const { config } = await init({
        id: "u1",
        isActive: true,
        mustChangePassword: false,
      });
      const account = await config.findAccount({}, "u1");
      expect(account.accountId).toBe("u1");
      expect(account.claims()).toEqual({ sub: "u1" });
    });

    it("findAccount returns undefined for an inactive user", async () => {
      const { config } = await init({
        id: "u1",
        isActive: false,
        mustChangePassword: false,
      });
      const account = await config.findAccount({}, "u1");
      expect(account).toBeUndefined();
    });

    it("findAccount returns undefined when user must change password", async () => {
      const { config } = await init({
        id: "u1",
        isActive: true,
        mustChangePassword: true,
      });
      const account = await config.findAccount({}, "u1");
      expect(account).toBeUndefined();
    });

    it("findAccount returns undefined when the user is not found", async () => {
      const { config } = await init(null);
      const account = await config.findAccount({}, "u1");
      expect(account).toBeUndefined();
    });
  });

  describe("provider event listeners", () => {
    it("registers all expected event listeners during initialize", async () => {
      const svc = new OAuthProviderService(
        makeConfigService({
          PUBLIC_APP_URL: "https://app.test",
          JWT_SECRET: VALID_JWT,
        }),
        makeDataSource().dataSource,
        makeAuthService({
          id: "u",
          isActive: true,
          mustChangePassword: false,
        }),
      );
      await svc.ensureInitialized();

      const expected = [
        "server_error",
        "authorization.error",
        "grant.error",
        "introspection.error",
        "revocation.error",
        "registration_create.error",
        "registration_update.error",
        "interaction.started",
        "interaction.ended",
        "authorization.success",
        "grant.success",
        "registration_create.success",
      ];
      for (const evt of expected) {
        expect(eventListeners[evt]).toBeDefined();
        expect(eventListeners[evt].length).toBeGreaterThan(0);
      }
    });

    it("event listeners do not throw when invoked with various payloads (errorDetail branches)", async () => {
      const svc = new OAuthProviderService(
        makeConfigService({
          PUBLIC_APP_URL: "https://app.test",
          JWT_SECRET: VALID_JWT,
        }),
        makeDataSource().dataSource,
        makeAuthService({
          id: "u",
          isActive: true,
          mustChangePassword: false,
        }),
      );
      await svc.ensureInitialized();

      const ctx = {
        method: "GET",
        path: "/oauth/auth",
        oidc: {
          entities: { Interaction: { uid: "iu" } },
          client: { clientId: "c1" },
          session: { accountId: "a1" },
          params: { grant_type: "authorization_code" },
        },
      };

      // Error events with various error shapes — exercises errorDetail branches.
      const errVariants = [
        { message: "msg", error: "e1", error_description: "d1", stack: "s" },
        { message: "msg only" },
        { error: "only-err" },
        new Error("plain"),
        {},
      ];
      for (const e of errVariants) {
        for (const evt of [
          "server_error",
          "authorization.error",
          "grant.error",
          "introspection.error",
          "revocation.error",
          "registration_create.error",
          "registration_update.error",
        ]) {
          for (const cb of eventListeners[evt]) {
            expect(() => cb(ctx, e)).not.toThrow();
          }
        }
      }

      // Success / lifecycle events
      for (const cb of eventListeners["interaction.started"]) {
        expect(() => cb(ctx, { name: "consent" })).not.toThrow();
      }
      for (const cb of eventListeners["interaction.ended"]) {
        expect(() => cb(ctx)).not.toThrow();
      }
      for (const cb of eventListeners["authorization.success"]) {
        expect(() => cb(ctx)).not.toThrow();
      }
      for (const cb of eventListeners["grant.success"]) {
        expect(() => cb(ctx)).not.toThrow();
      }
      for (const cb of eventListeners["registration_create.success"]) {
        expect(() =>
          cb(ctx, {
            clientId: "c1",
            redirectUris: ["https://x/y"],
          }),
        ).not.toThrow();
      }

      // Also exercise listeners with sparse ctx (optional chaining branches)
      for (const cb of eventListeners["server_error"]) {
        expect(() => cb({}, new Error("x"))).not.toThrow();
      }
      for (const cb of eventListeners["interaction.started"]) {
        expect(() => cb({ oidc: {} }, { name: "x" })).not.toThrow();
      }
    });
  });

  describe("validateAccessToken", () => {
    async function setup(authUser: {
      id: string;
      isActive: boolean;
      mustChangePassword: boolean;
    } | null) {
      const svc = new OAuthProviderService(
        makeConfigService({
          PUBLIC_APP_URL: "https://app.test",
          JWT_SECRET: VALID_JWT,
        }),
        makeDataSource().dataSource,
        makeAuthService(authUser),
      );
      await svc.ensureInitialized();
      return { svc, find: lastMockProvider.AccessToken.find };
    }

    it("returns null when the token does not exist", async () => {
      const { svc, find } = await setup({
        id: "u",
        isActive: true,
        mustChangePassword: false,
      });
      find.mockResolvedValue(null);
      expect(await svc.validateAccessToken("nope")).toBeNull();
    });

    it("returns null for an expired token", async () => {
      const { svc, find } = await setup({
        id: "u",
        isActive: true,
        mustChangePassword: false,
      });
      find.mockResolvedValue({ isExpired: true });
      expect(await svc.validateAccessToken("t")).toBeNull();
    });

    it("returns null when accountId is missing", async () => {
      const { svc, find } = await setup({
        id: "u",
        isActive: true,
        mustChangePassword: false,
      });
      find.mockResolvedValue({
        isExpired: false,
        accountId: undefined,
      });
      expect(await svc.validateAccessToken("t")).toBeNull();
    });

    it("returns null when audience does not match (string aud)", async () => {
      const { svc, find } = await setup({
        id: "u",
        isActive: true,
        mustChangePassword: false,
      });
      find.mockResolvedValue({
        isExpired: false,
        accountId: "u",
        aud: "https://other/mcp",
        scope: "monize:read",
      });
      expect(await svc.validateAccessToken("t")).toBeNull();
    });

    it("returns null when audience does not match (array aud)", async () => {
      const { svc, find } = await setup({
        id: "u",
        isActive: true,
        mustChangePassword: false,
      });
      find.mockResolvedValue({
        isExpired: false,
        accountId: "u",
        aud: ["https://x/y", "https://z/w"],
        scope: "monize:read",
      });
      expect(await svc.validateAccessToken("t")).toBeNull();
    });

    it("returns the user/scopes when aud is a string match and user is active", async () => {
      const { svc, find } = await setup({
        id: "u1",
        isActive: true,
        mustChangePassword: false,
      });
      find.mockResolvedValue({
        isExpired: false,
        accountId: "u1",
        aud: "https://app.test/api/v1/mcp",
        scope: "monize:read monize:write",
      });
      expect(await svc.validateAccessToken("t")).toEqual({
        userId: "u1",
        scopes: "read,write",
      });
    });

    it("accepts aud as an array containing the expected audience", async () => {
      const { svc, find } = await setup({
        id: "u1",
        isActive: true,
        mustChangePassword: false,
      });
      find.mockResolvedValue({
        isExpired: false,
        accountId: "u1",
        aud: ["https://app.test/api/v1/mcp", "extra"],
        scope: "monize:read",
      });
      expect(await svc.validateAccessToken("t")).toEqual({
        userId: "u1",
        scopes: "read",
      });
    });

    it("falls back to provider-specific resource property when aud is missing", async () => {
      const { svc, find } = await setup({
        id: "u1",
        isActive: true,
        mustChangePassword: false,
      });
      find.mockResolvedValue({
        isExpired: false,
        accountId: "u1",
        resource: "https://app.test/api/v1/mcp",
        scope: "monize:read",
      });
      expect(await svc.validateAccessToken("t")).toEqual({
        userId: "u1",
        scopes: "read",
      });
    });

    it("returns null when the user is denied (inactive)", async () => {
      const { svc, find } = await setup({
        id: "u1",
        isActive: false,
        mustChangePassword: false,
      });
      find.mockResolvedValue({
        isExpired: false,
        accountId: "u1",
        aud: "https://app.test/api/v1/mcp",
        scope: "monize:read",
      });
      expect(await svc.validateAccessToken("t")).toBeNull();
    });

    it("treats a non-monize: scope as a bare scope", async () => {
      const { svc, find } = await setup({
        id: "u1",
        isActive: true,
        mustChangePassword: false,
      });
      find.mockResolvedValue({
        isExpired: false,
        accountId: "u1",
        aud: "https://app.test/api/v1/mcp",
        scope: "openid foo",
      });
      expect(await svc.validateAccessToken("t")).toEqual({
        userId: "u1",
        scopes: "openid,foo",
      });
    });

    it("uses an empty scope when token.scope is missing", async () => {
      const { svc, find } = await setup({
        id: "u1",
        isActive: true,
        mustChangePassword: false,
      });
      find.mockResolvedValue({
        isExpired: false,
        accountId: "u1",
        aud: "https://app.test/api/v1/mcp",
      });
      expect(await svc.validateAccessToken("t")).toEqual({
        userId: "u1",
        scopes: "",
      });
    });

    it("returns null when AccessToken.find throws", async () => {
      const { svc, find } = await setup({
        id: "u1",
        isActive: true,
        mustChangePassword: false,
      });
      find.mockRejectedValue(new Error("boom"));
      expect(await svc.validateAccessToken("t")).toBeNull();
    });
  });

  describe("revokeAllForUser", () => {
    it("returns the number of affected payload rows", async () => {
      const ds = makeDataSource(3);
      const svc = new OAuthProviderService(
        makeConfigService({
          PUBLIC_APP_URL: "https://app.test",
          JWT_SECRET: VALID_JWT,
        }),
        ds.dataSource,
        makeAuthService({
          id: "u",
          isActive: true,
          mustChangePassword: false,
        }),
      );
      await expect(svc.revokeAllForUser("u1")).resolves.toBe(3);
      expect(ds.where).toHaveBeenCalledWith(
        "payload ->> 'accountId' = :userId",
        { userId: "u1" },
      );
    });

    it("returns 0 when no rows are deleted", async () => {
      const ds = makeDataSource(0);
      ds.execute.mockResolvedValue({ affected: 0 });
      const svc = new OAuthProviderService(
        makeConfigService({
          PUBLIC_APP_URL: "https://app.test",
          JWT_SECRET: VALID_JWT,
        }),
        ds.dataSource,
        makeAuthService({
          id: "u",
          isActive: true,
          mustChangePassword: false,
        }),
      );
      await expect(svc.revokeAllForUser("u1")).resolves.toBe(0);
    });

    it("treats null/undefined affected as zero", async () => {
      const ds = makeDataSource();
      ds.execute.mockResolvedValue({ affected: undefined });
      const svc = new OAuthProviderService(
        makeConfigService({
          PUBLIC_APP_URL: "https://app.test",
          JWT_SECRET: VALID_JWT,
        }),
        ds.dataSource,
        makeAuthService({
          id: "u",
          isActive: true,
          mustChangePassword: false,
        }),
      );
      await expect(svc.revokeAllForUser("u1")).resolves.toBe(0);
    });
  });
});
