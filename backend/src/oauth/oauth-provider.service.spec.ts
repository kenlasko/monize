import { readFileSync } from "fs";
import { dirname, join } from "path";
import { InternalServerErrorException } from "@nestjs/common";
import {
  OAuthProviderService,
  MAX_DCR_REDIRECT_URIS,
  MCP_RESOURCE_SCOPES,
} from "./oauth-provider.service";
import { OAUTH_CLIENT_IDLE_TTL_SECONDS } from "./postgres.adapter";
import { getRequestContext } from "../common/request-context";
import {
  OauthSigningKeysService,
  type InstanceJwks,
} from "./oauth-signing-keys.service";

// A real OAuth subject/accountId is a user UUID. findAccount and
// validateAccessToken now read the auth-state row under withUserContext(sub),
// which validates the id is a UUID, so the account fixtures use a real UUID.
const ACCOUNT_ID = "11111111-1111-1111-1111-111111111111";

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

const eventListeners: Record<
  string,
  Array<(...args: unknown[]) => unknown>
> = {};

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
        .mockImplementation(
          (issuer: string, config: Record<string, unknown>) => {
            providerConstructorCalls.push({ issuer, config });
            lastMockProvider = createMockProvider();
            return lastMockProvider;
          },
        ),
      errors: {
        InvalidClientMetadata: class InvalidClientMetadata extends Error {},
      },
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

/**
 * An `OauthSigningKeysService` double.
 *
 * Defaults to a stored JWKS, because that is the configured deployment and the
 * assertion worth making is that it reaches the provider. `null` is the
 * unkeyed case, where the provider is expected to mint its own exactly as it
 * did before this existed.
 */
function makeSigningKeys(jwks: InstanceJwks | null = SPEC_JWKS) {
  return {
    ensureJwks: jest.fn().mockResolvedValue(jwks),
    readJwks: jest.fn().mockResolvedValue(jwks),
  } as unknown as OauthSigningKeysService;
}

const SPEC_JWKS: InstanceJwks = {
  keys: [{ kty: "RSA", kid: "spec-rsa", use: "sig", n: "n", e: "AQAB" }],
};

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

  describe("signing keys", () => {
    const initWith = async (jwks: InstanceJwks | null) => {
      const svc = new OAuthProviderService(
        makeConfigService({
          PUBLIC_APP_URL: "https://app.test",
          JWT_SECRET: VALID_JWT,
        }),
        makeDataSource().dataSource,
        makeAuthService(null),
        makeSigningKeys(jwks),
      );
      await svc.ensureInitialized();
      return providerConstructorCalls[0].config;
    };

    // Without this the provider mints a development key pair per process, so
    // two replicas serve two /oauth/jwks documents and a token signed by one
    // cannot be verified against the other.
    it("hands the stored JWKS to the provider", async () => {
      const config = await initWith(SPEC_JWKS);

      expect(config.jwks).toEqual(SPEC_JWKS);
    });

    // A deployment with no ENCRYPTION_KEY has nowhere to put private signing
    // keys, and plaintext would be worse than per-process keys -- so the
    // option is omitted entirely rather than passed as null, which the
    // provider would reject.
    it("omits the option entirely when there are no stored keys", async () => {
      const config = await initWith(null);

      expect(config).not.toHaveProperty("jwks");
    });
  });

  describe("requirePublicUrl / URL helpers (uninitialized)", () => {
    it("throws if PUBLIC_APP_URL is missing during initialize()", async () => {
      const svc = new OAuthProviderService(
        makeConfigService({}),
        makeDataSource().dataSource,
        makeAuthService(null),
        makeSigningKeys(),
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
        makeSigningKeys(),
      );
      await expect(svc.ensureInitialized()).rejects.toThrow(/JWT_SECRET/);
    });

    it("getProvider() throws when not initialized", () => {
      const svc = new OAuthProviderService(
        makeConfigService({}),
        makeDataSource().dataSource,
        makeAuthService(null),
        makeSigningKeys(),
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
          id: ACCOUNT_ID,
          isActive: true,
          mustChangePassword: false,
        }),
        makeSigningKeys(),
      );
      // The public-URL helpers do not require initialization.
      expect(svc.getMcpResourceUrl()).toBe("https://app.test/api/v1/mcp");
      // Issuer is the bare origin so discovery is published at the root.
      expect(svc.getIssuerUrl()).toBe("https://app.test");
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
        makeSigningKeys(),
      );

      const p1 = await svc.ensureInitialized();
      const p2 = await svc.ensureInitialized();

      expect(p1).toBe(p2);
      expect(providerConstructorCalls).toHaveLength(1);
      // Issuer is the bare origin (discovery served at the root well-known
      // URLs); endpoints are pinned under /oauth/* via the routes map.
      expect(providerConstructorCalls[0].issuer).toBe("https://app.test");
      expect(providerConstructorCalls[0].config.routes).toEqual({
        authorization: "/oauth/auth",
        token: "/oauth/token",
        jwks: "/oauth/jwks",
        registration: "/oauth/reg",
        revocation: "/oauth/token/revocation",
        userinfo: "/oauth/me",
        end_session: "/oauth/session/end",
        // PAR pinned under /oauth/* so the proxy/root-mount gates forward it
        // (its oidc-provider default `/request` is unreachable).
        pushed_authorization_request: "/oauth/request",
      });
      expect(providerConstructorCalls[0].config.scopes).toEqual([
        ...MCP_RESOURCE_SCOPES,
      ]);
      expect(svc.getProvider()).toBe(p1);
    });

    // Guard: any artifact the provider can issue whose ttl is left unset makes
    // node-oidc-provider fall back to its built-in TTL function, which prints a
    // raw "oidc-provider NOTICE: default ttl.<Model> function called ..." line
    // via console.info — outside the Nest Logger, so it lands in the backend
    // logs unformatted. ttl.IdToken was the one that slipped through.
    it("sets an explicit numeric TTL for every artifact the provider issues", async () => {
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
        makeSigningKeys(),
      );
      await svc.ensureInitialized();

      // Artifacts reachable with the features enabled above. ClientCredentials,
      // DeviceCode and BackchannelAuthenticationRequest are omitted because the
      // grants/features that mint them are not enabled.
      const issuableArtifacts = [
        "AccessToken",
        "AuthorizationCode",
        "Grant",
        "IdToken",
        "Interaction",
        "RefreshToken",
        "Session",
      ];
      const ttl = providerConstructorCalls[0].config.ttl as Record<
        string,
        unknown
      >;
      for (const artifact of issuableArtifacts) {
        expect(typeof ttl[artifact]).toBe("number");
        expect(ttl[artifact] as number).toBeGreaterThan(0);
      }
    });

    it("keeps a registered client alive longer than any refresh token minted for it", async () => {
      // An idle client expires (#2177); it must never expire while a refresh
      // token minted for it can still be redeemed, or a client that refreshes
      // within its token's life would be refused as unknown.
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
        makeSigningKeys(),
      );
      await svc.ensureInitialized();

      const ttl = providerConstructorCalls[0].config.ttl as Record<
        string,
        number
      >;
      expect(OAUTH_CLIENT_IDLE_TTL_SECONDS).toBeGreaterThan(ttl.RefreshToken);
      expect(OAUTH_CLIENT_IDLE_TTL_SECONDS).toBeGreaterThan(ttl.Grant);
    });

    // RFC 9207, which the 2026-07-28 revision asks authorization servers to
    // support (SEP-2468): the authorization response names the issuer that
    // produced it, so a client can tell one authorization server's code from
    // another's before redeeming it. node-oidc-provider does this itself; the
    // check is here because it is a property MCP clients rely on, and a
    // provider upgrade that dropped it would otherwise be invisible.
    it("names the issuer on its authorization responses (RFC 9207)", async () => {
      const providerLib = join(
        dirname(require.resolve("oidc-provider/package.json")),
        "lib",
      );
      expect(
        readFileSync(
          join(providerLib, "actions/authorization/respond.js"),
          "utf8",
        ),
      ).toContain("out.iss = ctx.oidc.provider.issuer");
      expect(
        readFileSync(join(providerLib, "actions/discovery.js"), "utf8"),
      ).toContain("authorization_response_iss_parameter_supported: true");
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
        makeSigningKeys(),
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
        makeSigningKeys(),
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
        makeSigningKeys(),
      );
      await svc.ensureInitialized();
      return {
        svc,
        auth,
        config: providerConstructorCalls[0].config as Record<string, any>,
      };
    }

    describe("dynamic client registration metadata (#2177)", () => {
      // The provider passes its request context only while registering; a
      // stored client rebuilt on lookup gets none.
      const REGISTRATION_CTX = { method: "POST" };

      it("never refuses a stored client after the fact", async () => {
        const { config } = await init({
          id: ACCOUNT_ID,
          isActive: true,
          mustChangePassword: false,
        });
        const many = Array.from(
          { length: MAX_DCR_REDIRECT_URIS + 5 },
          (_, i) => `https://client.test/cb${i}`,
        );

        expect(() =>
          config.extraClientMetadata.validator(
            undefined,
            "redirect_uris",
            many,
          ),
        ).not.toThrow();
      });

      it("refuses more redirect URIs than the cap", async () => {
        const { config } = await init({
          id: ACCOUNT_ID,
          isActive: true,
          mustChangePassword: false,
        });
        const { properties, validator } = config.extraClientMetadata;
        const uris = (n: number) =>
          Array.from({ length: n }, (_, i) => `https://client.test/cb${i}`);

        expect(properties).toEqual(["redirect_uris"]);
        expect(() =>
          validator(
            REGISTRATION_CTX,
            "redirect_uris",
            uris(MAX_DCR_REDIRECT_URIS),
          ),
        ).not.toThrow();
        expect(() =>
          validator(
            REGISTRATION_CTX,
            "redirect_uris",
            uris(MAX_DCR_REDIRECT_URIS + 1),
          ),
        ).toThrow(/redirect_uris/);
        expect(MAX_DCR_REDIRECT_URIS).toBeLessThan(50);
      });

      it("leaves a malformed value to the provider's own checks", async () => {
        const { config } = await init({
          id: ACCOUNT_ID,
          isActive: true,
          mustChangePassword: false,
        });
        const { validator } = config.extraClientMetadata;

        expect(() =>
          validator(
            REGISTRATION_CTX,
            "redirect_uris",
            "https://client.test/cb",
          ),
        ).not.toThrow();
        expect(() =>
          validator(REGISTRATION_CTX, "redirect_uris", undefined),
        ).not.toThrow();
      });
    });

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
      await expect(config.issueRefreshToken({}, client, {})).resolves.toBe(
        true,
      );
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
        id: ACCOUNT_ID,
        isActive: true,
        mustChangePassword: false,
      });
      const account = await config.findAccount({}, ACCOUNT_ID);
      expect(account.accountId).toBe(ACCOUNT_ID);
      expect(account.claims()).toEqual({ sub: ACCOUNT_ID });
    });

    it("findAccount returns undefined for an inactive user", async () => {
      const { config } = await init({
        id: ACCOUNT_ID,
        isActive: false,
        mustChangePassword: false,
      });
      const account = await config.findAccount({}, ACCOUNT_ID);
      expect(account).toBeUndefined();
    });

    it("findAccount returns undefined when user must change password", async () => {
      const { config } = await init({
        id: ACCOUNT_ID,
        isActive: true,
        mustChangePassword: true,
      });
      const account = await config.findAccount({}, ACCOUNT_ID);
      expect(account).toBeUndefined();
    });

    it("findAccount returns undefined when the user is not found", async () => {
      const { config } = await init(null);
      const account = await config.findAccount({}, ACCOUNT_ID);
      expect(account).toBeUndefined();
    });

    // RLS (task C1): the grant's subject is the user, so the auth-state read
    // runs under that user's own context -- never a system bypass.
    it("reads the auth-state row under a user context (no bypass)", async () => {
      const { config, auth } = await init({
        id: ACCOUNT_ID,
        isActive: true,
        mustChangePassword: false,
      });
      let ctx: ReturnType<typeof getRequestContext>;
      (auth.getUserStateById as jest.Mock).mockImplementation(() => {
        ctx = getRequestContext();
        return Promise.resolve({
          id: ACCOUNT_ID,
          isActive: true,
          mustChangePassword: false,
        });
      });

      await config.findAccount({}, ACCOUNT_ID);

      expect(ctx).toEqual({ userId: ACCOUNT_ID });
      expect(ctx?.system).toBeUndefined();
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
        makeSigningKeys(),
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
        makeSigningKeys(),
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
    async function setup(
      authUser: {
        id: string;
        isActive: boolean;
        mustChangePassword: boolean;
      } | null,
    ) {
      const svc = new OAuthProviderService(
        makeConfigService({
          PUBLIC_APP_URL: "https://app.test",
          JWT_SECRET: VALID_JWT,
        }),
        makeDataSource().dataSource,
        makeAuthService(authUser),
        makeSigningKeys(),
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
        id: ACCOUNT_ID,
        isActive: true,
        mustChangePassword: false,
      });
      find.mockResolvedValue({
        isExpired: false,
        accountId: ACCOUNT_ID,
        aud: "https://app.test/api/v1/mcp",
        scope: "monize:read monize:write",
      });
      expect(await svc.validateAccessToken("t")).toEqual({
        userId: ACCOUNT_ID,
        scopes: "read,write",
      });
    });

    it("accepts aud as an array containing the expected audience", async () => {
      const { svc, find } = await setup({
        id: ACCOUNT_ID,
        isActive: true,
        mustChangePassword: false,
      });
      find.mockResolvedValue({
        isExpired: false,
        accountId: ACCOUNT_ID,
        aud: ["https://app.test/api/v1/mcp", "extra"],
        scope: "monize:read",
      });
      expect(await svc.validateAccessToken("t")).toEqual({
        userId: ACCOUNT_ID,
        scopes: "read",
      });
    });

    it("falls back to provider-specific resource property when aud is missing", async () => {
      const { svc, find } = await setup({
        id: ACCOUNT_ID,
        isActive: true,
        mustChangePassword: false,
      });
      find.mockResolvedValue({
        isExpired: false,
        accountId: ACCOUNT_ID,
        resource: "https://app.test/api/v1/mcp",
        scope: "monize:read",
      });
      expect(await svc.validateAccessToken("t")).toEqual({
        userId: ACCOUNT_ID,
        scopes: "read",
      });
    });

    it("returns null when the user is denied (inactive)", async () => {
      const { svc, find } = await setup({
        id: ACCOUNT_ID,
        isActive: false,
        mustChangePassword: false,
      });
      find.mockResolvedValue({
        isExpired: false,
        accountId: ACCOUNT_ID,
        aud: "https://app.test/api/v1/mcp",
        scope: "monize:read",
      });
      expect(await svc.validateAccessToken("t")).toBeNull();
    });

    it("treats a non-monize: scope as a bare scope", async () => {
      const { svc, find } = await setup({
        id: ACCOUNT_ID,
        isActive: true,
        mustChangePassword: false,
      });
      find.mockResolvedValue({
        isExpired: false,
        accountId: ACCOUNT_ID,
        aud: "https://app.test/api/v1/mcp",
        scope: "openid foo",
      });
      expect(await svc.validateAccessToken("t")).toEqual({
        userId: ACCOUNT_ID,
        scopes: "openid,foo",
      });
    });

    it("uses an empty scope when token.scope is missing", async () => {
      const { svc, find } = await setup({
        id: ACCOUNT_ID,
        isActive: true,
        mustChangePassword: false,
      });
      find.mockResolvedValue({
        isExpired: false,
        accountId: ACCOUNT_ID,
        aud: "https://app.test/api/v1/mcp",
      });
      expect(await svc.validateAccessToken("t")).toEqual({
        userId: ACCOUNT_ID,
        scopes: "",
      });
    });

    it("returns null when AccessToken.find throws", async () => {
      const { svc, find } = await setup({
        id: ACCOUNT_ID,
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
        makeSigningKeys(),
      );
      await expect(svc.revokeAllForUser(ACCOUNT_ID)).resolves.toBe(3);
      expect(ds.where).toHaveBeenCalledWith(
        "payload ->> 'accountId' = :userId",
        { userId: ACCOUNT_ID },
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
        makeSigningKeys(),
      );
      await expect(svc.revokeAllForUser(ACCOUNT_ID)).resolves.toBe(0);
    });

    it("binds the subject as a parameter, never into the SQL", async () => {
      // This is the one direct-DataSource query on oauth_payloads keyed by an
      // application user id (docs/row-level-security-contract.md section 3).
      // The table is RLS-exempt, so there is no policy underneath to contain a
      // predicate that got away -- the binding is the whole control. A subject
      // full of SQL metacharacters must reach the driver as a bound value and
      // leave the clause text untouched.
      const hostile = "' OR 1=1 --";
      const ds = makeDataSource(0);
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
        makeSigningKeys(),
      );

      await svc.revokeAllForUser(hostile);

      const [clause, params] = ds.where.mock.calls[0];
      expect(clause).toBe("payload ->> 'accountId' = :userId");
      expect(clause).not.toContain(hostile);
      expect(params).toEqual({ userId: hostile });
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
        makeSigningKeys(),
      );
      await expect(svc.revokeAllForUser(ACCOUNT_ID)).resolves.toBe(0);
    });
  });

  describe("sweepExpiredPayloads (#2177)", () => {
    function makeService(dataSource: import("typeorm").DataSource) {
      return new OAuthProviderService(
        makeConfigService({
          PUBLIC_APP_URL: "https://app.test",
          JWT_SECRET: VALID_JWT,
        }),
        dataSource,
        makeAuthService({
          id: "u",
          isActive: true,
          mustChangePassword: false,
        }),
        makeSigningKeys(),
      );
    }

    function makeSweepSource(execute: jest.Mock) {
      const where = jest.fn().mockReturnValue({
        execute,
        returning: () => ({ execute }),
      });
      const builder = {
        update: () => ({ set: () => ({ where }) }),
        delete: () => ({ where }),
      };
      return {
        dataSource: {
          getRepository: () => ({ createQueryBuilder: () => builder }),
        } as unknown as import("typeorm").DataSource,
        where,
      };
    }

    it("adopts clients without an expiry, deletes expired rows, and reports both", async () => {
      const execute = jest
        .fn()
        .mockResolvedValueOnce({ raw: [{ id: "c1" }, { id: "c2" }] })
        .mockResolvedValueOnce({ affected: 42 });
      const { dataSource, where } = makeSweepSource(execute);

      await expect(
        makeService(dataSource).sweepExpiredPayloads(),
      ).resolves.toEqual({ adopted: 2, deleted: 42 });
      expect(where).toHaveBeenCalledTimes(2);
    });

    it("swallows a failed run: the next one takes what this one left", async () => {
      const { dataSource } = makeSweepSource(
        jest.fn().mockRejectedValue(new Error("connection lost")),
      );

      await expect(
        makeService(dataSource).sweepExpiredPayloads(),
      ).resolves.toEqual({ adopted: 0, deleted: 0 });
    });
  });
});
