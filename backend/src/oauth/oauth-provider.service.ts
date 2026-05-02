import {
  Injectable,
  InternalServerErrorException,
  Logger,
  OnModuleInit,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectDataSource } from "@nestjs/typeorm";
import { DataSource } from "typeorm";
import type { default as ProviderType } from "oidc-provider";
import { makeAdapterFactory } from "./postgres.adapter";
import { derivePurposeKey } from "../auth/crypto.util";

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
    const issuer = `${publicUrl}/oauth`;
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
      cookies: {
        keys: [cookieKey],
        long: { sameSite: "lax", signed: true },
        short: { sameSite: "lax", signed: true },
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
        // Mount under /api/v1 so it goes through the existing frontend
        // proxy (which only forwards /api/*) without needing a global-
        // prefix exclusion. The provider middleware itself sits at /oauth
        // (which is also forwarded), but the interaction routes can't
        // nest under /oauth because the provider middleware is a Koa app
        // that 404s any path it doesn't own.
        url: (_ctx, interaction) =>
          `/api/v1/oauth-consent/${interaction.uid}`,
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
      this.logger.warn(
        `OAuth DCR registration error: ${errorDetail(err)}`,
      );
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
      throw new InternalServerErrorException("OAuth provider not initialized");
    }
    return this.provider;
  }

  getMcpResourceUrl(): string {
    return `${this.requirePublicUrl()}/api/v1/mcp`;
  }

  getIssuerUrl(): string {
    return `${this.requirePublicUrl()}/oauth`;
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

      const scopes = token.scope ?? "";
      return { userId: token.accountId, scopes };
    } catch (err) {
      this.logger.warn(
        `Access token validation failed: ${(err as Error).message}`,
      );
      return null;
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
