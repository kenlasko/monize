import {
  Injectable,
  InternalServerErrorException,
  Logger,
  OnModuleInit,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { tr } from "../i18n/translate";
import { InjectDataSource } from "@nestjs/typeorm";
import { DataSource } from "typeorm";
import type { default as ProviderType } from "oidc-provider";
import { makeAdapterFactory } from "./postgres.adapter";
import { derivePurposeKey } from "../auth/crypto.util";
import { AuthService } from "../auth/auth.service";
import { checkUserAuthState } from "../auth/user-state.util";
import { withUserContext } from "../common/db/with-context";
import { OAuthPayload } from "./entities/oauth-payload.entity";

export const MCP_RESOURCE_SCOPES = ["monize:read", "monize:write"] as const;
export type McpScope = (typeof MCP_RESOURCE_SCOPES)[number];

@Injectable()
export class OAuthProviderService implements OnModuleInit {
  private readonly logger = new Logger(OAuthProviderService.name);
  private provider: ProviderType | null = null;
  private initPromise: Promise<ProviderType> | null = null;

  constructor(
    private readonly configService: ConfigService,
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly authService: AuthService,
  ) {}

  async onModuleInit() {
    await this.ensureInitialized();
  }

  /**
   * Lazily initializes the OIDC provider. Idempotent and safe to call from
   * either the NestJS lifecycle hook or main.ts before app.listen() — the
   * provider must exist before we mount its callback as Express middleware,
   * but Nest's onModuleInit doesn't necessarily run before main.ts touches
   * the service via `app.get(...)`. Returns the live provider so callers
   * never have to deal with `null`.
   */
  async ensureInitialized(): Promise<ProviderType> {
    if (this.provider) return this.provider;
    if (this.initPromise) return this.initPromise;
    this.initPromise = this.initialize();
    try {
      this.provider = await this.initPromise;
      return this.provider;
    } finally {
      this.initPromise = null;
    }
  }

  private async initialize(): Promise<ProviderType> {
    const publicUrl = this.requirePublicUrl();
    // The OAuth issuer is the bare application origin so the RFC 8414 / OIDC
    // discovery documents are published at the conventional root well-known
    // URLs (`/.well-known/oauth-authorization-server` and
    // `/.well-known/openid-configuration`). The provider's actual endpoints are
    // kept under `/oauth/*` via the `routes` map below — node-oidc-provider
    // builds endpoint URLs as issuer + routePath, so a root issuer plus a
    // `/oauth/...` routePath still yields `https://<host>/oauth/<route>`. This
    // keeps the existing frontend proxy (which forwards `/oauth/*`) working and
    // avoids colliding with frontend routes such as `/auth/callback`.
    const issuer = publicUrl;
    const mcpResource = `${publicUrl}/api/v1/mcp`;
    const jwtSecret = this.configService.get<string>("JWT_SECRET");
    if (!jwtSecret || jwtSecret.length < 32) {
      throw new Error(
        "JWT_SECRET must be set (>=32 chars) for OAuth provider cookies",
      );
    }
    const cookieKey = derivePurposeKey(jwtSecret, "oauth-provider-cookies");

    // Dynamic import — oidc-provider is ESM-only and must be loaded at runtime.
    const { default: Provider } = await import("oidc-provider");

    const adapterFactory = makeAdapterFactory(this.dataSource);

    const provider = new Provider(issuer, {
      adapter: adapterFactory,
      // Pin every provider endpoint under /oauth/* (see issuer comment above).
      // Discovery (`/.well-known/openid-configuration` and
      // `/.well-known/oauth-authorization-server`) is NOT in this map — it is
      // served by the provider at the root because the issuer has no path.
      routes: {
        authorization: "/oauth/auth",
        token: "/oauth/token",
        jwks: "/oauth/jwks",
        registration: "/oauth/reg",
        revocation: "/oauth/token/revocation",
        userinfo: "/oauth/me",
        end_session: "/oauth/session/end",
        // PAR is enabled by default in oidc-provider v9. Its default route is
        // the bare `/request`, which sits outside the `/oauth/*` namespace that
        // both the root-mount gate (`isOidcProviderPath`) and the frontend
        // proxy (`isOAuthPath`) forward — so an advertised PAR endpoint at
        // `/request` is unreachable and 307s to /login, stalling clients that
        // push their authorization request. Pin it under /oauth/* like the rest.
        pushed_authorization_request: "/oauth/request",
      },
      cookies: {
        keys: [cookieKey],
        // Pin path: '/' so the interaction/session cookies follow the
        // browser across the issuer mount (/oauth/) and the interaction
        // routes (/api/v1/oauth-consent/...). Without this, cookies set
        // during /oauth/auth default to path=/oauth/ and the browser
        // drops them on the redirect to /api/v1/oauth-consent/<uid>,
        // causing interactionDetails() to throw SessionNotFound.
        long: { sameSite: "lax", signed: true, path: "/" },
        short: { sameSite: "lax", signed: true, path: "/" },
      },
      scopes: [...MCP_RESOURCE_SCOPES],
      claims: {
        openid: ["sub"],
        profile: ["name", "email"],
      },
      pkce: {
        required: () => true,
        methods: ["S256"],
      },
      responseTypes: ["code"],
      // node-oidc-provider derives the supported `grantTypes` set from
      // responseTypes + scopes + features + the `issueRefreshToken` policy
      // (see configuration.collectGrantTypes). Setting `grantTypes` directly
      // is silently ignored. To allow `refresh_token` for clients that
      // don't request the OIDC `offline_access` scope (which is the OAuth
      // 2.1 norm — and what Claude Desktop does), we provide a custom
      // issueRefreshToken policy: refresh tokens are issued whenever the
      // client registered with the refresh_token grant type. Providing any
      // non-default function for this option is also what causes
      // configuration.collectGrantTypes() to add 'refresh_token' to the
      // allowed enum used during DCR validation.
      issueRefreshToken: async (_ctx, client, _code) => {
        return client.grantTypeAllowed("refresh_token");
      },
      features: {
        devInteractions: { enabled: false },
        registration: {
          enabled: true,
          initialAccessToken: false,
          issueRegistrationAccessToken: false,
        },
        registrationManagement: { enabled: false },
        revocation: { enabled: true },
        introspection: { enabled: false },
        resourceIndicators: {
          enabled: true,
          defaultResource: () => mcpResource,
          getResourceServerInfo: (ctx, resourceIndicator) => {
            if (resourceIndicator !== mcpResource) {
              throw new Error(`Unknown resource: ${resourceIndicator}`);
            }
            return {
              scope: MCP_RESOURCE_SCOPES.join(" "),
              audience: mcpResource,
              accessTokenTTL: 60 * 60,
              accessTokenFormat: "opaque",
            };
          },
          useGrantedResource: () => true,
        },
        userinfo: { enabled: false },
        backchannelLogout: { enabled: false },
      },
      interactions: {
        // Absolute URL (not a relative path) because some reverse-proxy
        // setups (Envoy in particular) rewrite or drop relative
        // redirects, especially across path namespaces — leaving the
        // browser stuck on /oauth/auth instead of following the 303 to
        // the consent page.
        // Mounted under /api/v1 so it traverses the existing frontend
        // proxy without needing global-prefix exclusion gymnastics.
        url: (_ctx, interaction) =>
          `${publicUrl}/api/v1/oauth-consent/${interaction.uid}`,
      },
      ttl: {
        AccessToken: 60 * 60, // 1 hour
        AuthorizationCode: 60, // 60 seconds
        RefreshToken: 60 * 60 * 24 * 14, // 14 days
        Grant: 60 * 60 * 24 * 14,
        Interaction: 60 * 10, // 10 minutes
        Session: 60 * 60 * 24, // 1 day
      },
      clientDefaults: {
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none", // public client (Claude Desktop)
      },
      // Disable unsupported claim sources; MCP clients only need access tokens.
      conformIdTokenClaims: true,
      enabledJWA: {
        idTokenSigningAlgValues: ["HS256", "RS256"],
        requestObjectSigningAlgValues: [],
      },
      findAccount: async (_ctx, sub: string) => {
        // Block refresh-token rotations and any other grant lookups for users
        // who have been deactivated, deleted, or flagged for password reset.
        // Without this gate, a disabled user keeps minting fresh access
        // tokens for up to the refresh-token TTL.
        //
        // RLS: this runs outside any HTTP request (node-oidc-provider calls it
        // during token flows), but the grant's subject IS the user -- read the
        // auth-state row under that user's own context (self-policy), not a
        // system bypass.
        const user = await withUserContext(sub, () =>
          this.authService.getUserStateById(sub),
        );
        const denial = checkUserAuthState(user, {
          enforceMustChangePassword: true,
        });
        if (denial) {
          this.logger.warn(
            `OAuth findAccount denied for sub=${sub} reason=${denial}`,
          );
          return undefined;
        }
        return {
          accountId: sub,
          claims: () => ({ sub }),
        };
      },
    } as ConstructorParameters<typeof Provider>[1]);

    // Trust the same proxy level as the rest of the app (Docker/nginx).
    provider.proxy = true;

    const errorDetail = (err: unknown): string => {
      const e = err as {
        message?: string;
        error?: string;
        error_description?: string;
        stack?: string;
      };
      const parts = [e.message, e.error, e.error_description].filter(Boolean);
      const msg = parts.join(" — ");
      return e.stack ? `${msg}\n${e.stack}` : msg;
    };

    provider.on("server_error", (ctx, err) => {
      this.logger.error(
        `OAuth server error on ${ctx?.method} ${ctx?.path}: ${errorDetail(err)}`,
      );
    });
    provider.on("authorization.error", (ctx, err) => {
      this.logger.warn(
        `OAuth authorization.error on ${ctx?.method} ${ctx?.path}: ${errorDetail(err)}`,
      );
    });
    provider.on("grant.error", (ctx, err) => {
      this.logger.warn(
        `OAuth grant.error on ${ctx?.method} ${ctx?.path}: ${errorDetail(err)}`,
      );
    });
    provider.on("introspection.error", (ctx, err) => {
      this.logger.warn(`OAuth introspection.error: ${errorDetail(err)}`);
    });
    provider.on("revocation.error", (ctx, err) => {
      this.logger.warn(`OAuth revocation.error: ${errorDetail(err)}`);
    });
    provider.on("registration_create.error", (ctx, err) => {
      this.logger.warn(`OAuth DCR registration error: ${errorDetail(err)}`);
    });
    provider.on("registration_update.error", (ctx, err) => {
      this.logger.warn(`OAuth DCR update error: ${errorDetail(err)}`);
    });
    provider.on("interaction.started", (ctx, prompt) => {
      this.logger.log(
        `OAuth interaction.started uid=${ctx.oidc?.entities?.Interaction?.uid} prompt=${prompt?.name} client=${ctx.oidc?.client?.clientId}`,
      );
    });
    provider.on("interaction.ended", (ctx) => {
      this.logger.log(
        `OAuth interaction.ended uid=${ctx.oidc?.entities?.Interaction?.uid}`,
      );
    });
    provider.on("authorization.success", (ctx) => {
      this.logger.log(
        `OAuth authorization.success client=${ctx.oidc?.client?.clientId} account=${ctx.oidc?.session?.accountId}`,
      );
    });
    provider.on("grant.success", (ctx) => {
      this.logger.log(
        `OAuth grant.success client=${ctx.oidc?.client?.clientId} grant_type=${ctx.oidc?.params?.grant_type}`,
      );
    });
    provider.on("registration_create.success", (ctx, client) => {
      this.logger.log(
        `OAuth DCR success client_id=${client.clientId} redirect_uris=${JSON.stringify(client.redirectUris)}`,
      );
    });

    this.logger.log(`OAuth provider initialized — issuer ${issuer}`);
    this.logger.log(`MCP protected resource: ${mcpResource}`);
    return provider;
  }

  getProvider(): ProviderType {
    if (!this.provider) {
      throw new InternalServerErrorException(
        tr(
          "errors.common.oauthProviderNotInitialized",
          "OAuth provider not initialized",
        ),
      );
    }
    return this.provider;
  }

  getMcpResourceUrl(): string {
    return `${this.requirePublicUrl()}/api/v1/mcp`;
  }

  getIssuerUrl(): string {
    // Bare origin: the OAuth issuer identifier (see initialize()). Advertised
    // to MCP clients in the protected-resource metadata as the authorization
    // server, so clients fetch discovery from the root well-known URLs.
    return this.requirePublicUrl();
  }

  /**
   * Validate an opaque OAuth access token. Returns the bound user and granted
   * scopes when valid, or null when invalid/expired/wrong-audience.
   */
  async validateAccessToken(
    rawToken: string,
  ): Promise<{ userId: string; scopes: string } | null> {
    const provider = this.getProvider();
    try {
      const token = await provider.AccessToken.find(rawToken);
      if (!token) return null;
      if (token.isExpired) return null;
      if (!token.accountId) return null;

      // Audience binding: the token must be issued for the MCP resource.
      // node-oidc-provider stores the granted resource on the access token
      // via the resourceIndicators feature; we accept matches on either the
      // standard `aud` claim or the (provider-specific) resource property.
      const expectedAudience = this.getMcpResourceUrl();
      const tokenWithResource = token as unknown as { resource?: string };
      const aud = token.aud ?? tokenWithResource.resource;
      const audMatches = Array.isArray(aud)
        ? aud.includes(expectedAudience)
        : aud === expectedAudience;
      if (!audMatches) return null;

      // Mirror the PAT and cookie auth paths: an OAuth access token must not
      // outlive the user's account-state gate. Reject tokens whose subject
      // has been deactivated, deleted, or flagged for password reset.
      // RLS: the token's accountId IS the user -- read under its own context.
      const user = await withUserContext(token.accountId, () =>
        this.authService.getUserStateById(token.accountId),
      );
      const denial = checkUserAuthState(user, {
        enforceMustChangePassword: true,
      });
      if (denial) {
        this.logger.warn(
          `OAuth access token rejected sub=${token.accountId} reason=${denial}`,
        );
        return null;
      }

      const rawScopes = token.scope ?? "";
      // Translate the OAuth-issued scope set ("monize:read monize:write")
      // into the comma-separated bare-name format the existing MCP tool
      // layer expects ("read,write"). The PAT path already supplies
      // scopes in that shape, so this normalisation lets every tool's
      // requireScope() / hasScope() check work transparently for both
      // PAT and OAuth callers without touching the tool implementations.
      const scopes = rawScopes
        .split(/\s+/)
        .filter(Boolean)
        .map((s) => (s.startsWith("monize:") ? s.slice("monize:".length) : s))
        .join(",");
      return { userId: token.accountId, scopes };
    } catch (err) {
      this.logger.warn(
        `Access token validation failed: ${(err as Error).message}`,
      );
      return null;
    }
  }

  /**
   * Revoke every OIDC artifact bound to a user — access tokens, refresh
   * tokens, authorization codes, grants, sessions. Called from admin flows
   * (deactivate, password reset) so revocation takes effect immediately
   * instead of waiting for the access-token TTL to expire.
   *
   * Implementation: a single SQL DELETE on the payload store, keyed on the
   * subject embedded in the JSON payload. Covers every grantable model
   * because oidc-provider stores `accountId` in the payload of each.
   */
  async revokeAllForUser(userId: string): Promise<number> {
    const result = await this.dataSource
      .getRepository(OAuthPayload)
      .createQueryBuilder()
      .delete()
      .where("payload ->> 'accountId' = :userId", { userId })
      .execute();
    const affected = result.affected ?? 0;
    if (affected > 0) {
      this.logger.log(`Revoked ${affected} OIDC payload(s) for user=${userId}`);
    }
    return affected;
  }

  private requirePublicUrl(): string {
    const url = this.configService.get<string>("PUBLIC_APP_URL");
    if (!url) {
      throw new Error(
        "PUBLIC_APP_URL must be set; required for OAuth issuer/audience",
      );
    }
    return url.replace(/\/$/, "");
  }
}
