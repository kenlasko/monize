import {
  Injectable,
  InternalServerErrorException,
  Logger,
  OnModuleInit,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Cron } from "@nestjs/schedule";
import { tr } from "../i18n/translate";
import { InjectDataSource } from "@nestjs/typeorm";
import { DataSource } from "typeorm";
import type { default as ProviderType } from "oidc-provider";
import { makeAdapterFactory, sweepOAuthPayloads } from "./postgres.adapter";
import { derivePurposeKey } from "../auth/crypto.util";
import { AuthService } from "../auth/auth.service";
import { checkUserAuthState } from "../auth/user-state.util";
import { API_SCOPES, ApiScope, MCP_SCOPE_PREFIX } from "../auth/scopes";
import { withUserContext } from "../common/db/with-context";
import { OAuthPayload } from "./entities/oauth-payload.entity";
import { OauthSigningKeysService } from "./oauth-signing-keys.service";
import { OIDC_PROVIDER_ROUTES } from "./oidc-provider-paths";

/**
 * The scopes an OAuth client may request, derived from the single vocabulary in
 * `auth/scopes.ts` rather than restated. `resolveBearer` strips the prefix, so a
 * PAT and an OAuth token both reach the guards as `read`/`write`.
 */
export const MCP_RESOURCE_SCOPES = API_SCOPES.map(
  (scope) => `${MCP_SCOPE_PREFIX}${scope}` as const,
);
export type McpScope = `${typeof MCP_SCOPE_PREFIX}${ApiScope}`;

/**
 * Most redirect URIs one dynamically registered client may carry. A real MCP
 * client registers one or two; the provider's own default is unbounded, which
 * let one unauthenticated request store fifty (#2177).
 */
export const MAX_DCR_REDIRECT_URIS = 10;

@Injectable()
export class OAuthProviderService implements OnModuleInit {
  private readonly logger = new Logger(OAuthProviderService.name);
  private provider: ProviderType | null = null;
  private initPromise: Promise<ProviderType> | null = null;

  constructor(
    private readonly configService: ConfigService,
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly authService: AuthService,
    private readonly signingKeys: OauthSigningKeysService,
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
    const { default: Provider, errors } = await import("oidc-provider");

    const adapterFactory = makeAdapterFactory(this.dataSource);

    // The deployment's signing identity, or null when it has none to store.
    // rotation: see design doc WP4. Null keeps the previous behaviour exactly:
    // oidc-provider mints a development key pair for this process, which is
    // fine for one replica that never restarts and wrong for anything else.
    const jwks = await this.signingKeys.ensureJwks();

    const provider = new Provider(issuer, {
      adapter: adapterFactory,
      ...(jwks ? { jwks } : {}),
      // Pin every provider endpoint under /oauth/* (see issuer comment above).
      // Discovery (`/.well-known/openid-configuration` and
      // `/.well-known/oauth-authorization-server`) is NOT in this map — it is
      // served by the provider at the root because the issuer has no path.
      routes: {
        ...OIDC_PROVIDER_ROUTES,
        // PAR is enabled by default in oidc-provider v9. Its default route is
        // the bare `/request`, which sits outside the `/oauth/*` namespace that
        // both the root-mount gate (`isOidcProviderPath`) and the frontend
        // proxy (`isOAuthPath`) forward — so an advertised PAR endpoint at
        // `/request` is unreachable and 307s to /login, stalling clients that
        // push their authorization request. OIDC_PROVIDER_ROUTES pins it under
        // /oauth/* like the rest.
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
      // Every artifact this provider can issue needs an explicit TTL. Leaving
      // one out does not just inherit a default silently — node-oidc-provider
      // calls its built-in TTL function and emits an
      // "oidc-provider NOTICE: default ttl.<Model> function called ..." line.
      // oidc-provider-log-bridge.ts normalizes how such a line is printed, but
      // the notice itself still means a default was left in place: fix the
      // config, not the log line.
      // The remaining defaults (ClientCredentials, DeviceCode,
      // BackchannelAuthenticationRequest) belong to grants/features this
      // provider does not enable, so they are never reached.
      ttl: {
        AccessToken: 60 * 60, // 1 hour
        AuthorizationCode: 60, // 60 seconds
        IdToken: 60 * 60, // 1 hour (matches AccessToken; consumed at issue)
        RefreshToken: 60 * 60 * 24 * 14, // 14 days
        Grant: 60 * 60 * 24 * 14,
        Interaction: 60 * 10, // 10 minutes
        Session: 60 * 60 * 24, // 1 day
      },
      // Listing a recognized property here is how the provider lets a validator
      // see it: the validator runs for each listed property before the
      // built-in checks. Language-tagged names (`client_name#fr`) need no rule:
      // the provider drops metadata it does not recognize before storing it.
      // The message is an OAuth error_description, ASCII for the client
      // developer (RFC 7591 section 3.2.2), so it is not translated.
      extraClientMetadata: {
        properties: ["redirect_uris"],
        validator: (ctx: unknown, key: string, value: unknown) => {
          // Only a registration has a request context. A stored client is
          // rebuilt through the same schema on every lookup, with none, and is
          // never refused here after the fact.
          if (
            ctx !== undefined &&
            key === "redirect_uris" &&
            Array.isArray(value) &&
            value.length > MAX_DCR_REDIRECT_URIS
          ) {
            throw new errors.InvalidClientMetadata(
              `redirect_uris must not contain more than ${MAX_DCR_REDIRECT_URIS} entries`,
            );
          }
        },
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
  ): Promise<{ userId: string; scopes: string; grantId?: string } | null> {
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
      // The grant, not the individual access token: an MCP client refreshes
      // access tokens routinely, and a session must survive that while still
      // being bound to the authorization the resource owner actually consented
      // to. Revoking the grant (or issuing a different one) breaks the binding.
      const grantId = token.grantId ?? token.jti;
      return { userId: token.accountId, scopes, grantId };
    } catch (err) {
      this.logger.warn(
        `Access token validation failed: ${(err as Error).message}`,
      );
      return null;
    }
  }

  /**
   * Revoke every OIDC artifact bound to a user — access tokens, refresh
   * tokens, authorization codes, grants, sessions. Called wherever the
   * account's credentials are replaced (admin deactivate/delete/password reset,
   * and via `revokeOAuthGrantsAfterCommit` in `auth/credential-revocation.ts`
   * the emailed reset, a password change, a delegate reset, an emergency-access
   * claim and an OIDC link confirmation) so revocation takes effect immediately
   * instead of waiting for the access-token TTL to expire.
   *
   * Implementation: a single SQL DELETE on the payload store, keyed on the
   * subject embedded in the JSON payload. Covers every grantable model
   * because oidc-provider stores `accountId` in the payload of each.
   *
   * This is the **second** sanctioned direct-`DataSource` path to
   * `oauth_payloads`, and the only one keyed by an application user id -- the
   * exemption's original rationale claimed the table was "never queried per
   * end-user", which was untrue from the moment this method was written. It is
   * a bounded exception, not a defect: every caller derives `userId` on the
   * server from something already verified (the admin's target, the session's
   * subject, the row a single-use token matched) and never from the request,
   * and the predicate deletes only rows whose own payload already names that
   * subject.
   *
   * Deliberately not wrapped in `withSystemContext`: the table is RLS-exempt,
   * so a bypass GUC would change nothing about what this query can reach. It
   * would buy the appearance of a control rather than a control. See
   * `docs/row-level-security-contract.md` section 3, which also lists the
   * triggers that would invalidate the exception -- a query keyed by
   * *request-supplied* user input being the first of them.
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

  /**
   * Daily removal of expired provider artifacts: interactions, sessions, codes,
   * tokens, grants and idle dynamically registered clients (#2177). Without it
   * `oauth_payloads` only grew, at whatever rate unauthenticated callers chose.
   *
   * Clients stored before #2177 with no expiry are first given one, so the
   * clients a flood already left are swept too.
   *
   * A third direct-`DataSource` path to the table, keyed by nothing but the
   * stored expiry (`docs/row-level-security-contract.md` section 3), and not
   * wrapped in `withSystemContext` for the reason `revokeAllForUser` is not.
   * Idempotent by predicate: every replica fires it and the later ones delete
   * nothing. Failure is logged and swallowed: rows a failed run left are
   * already invisible to the provider and the next run takes them.
   */
  @Cron("30 4 * * *")
  async sweepExpiredPayloads(): Promise<{ adopted: number; deleted: number }> {
    try {
      const result = await sweepOAuthPayloads(this.dataSource);
      if (result.adopted > 0 || result.deleted > 0) {
        this.logger.log(
          `Swept ${result.deleted} expired OIDC payload(s); gave ` +
            `${result.adopted} client(s) without an expiry the idle TTL`,
        );
      }
      return result;
    } catch (error) {
      this.logger.warn(
        `OIDC payload sweep failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return { adopted: 0, deleted: 0 };
    }
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
