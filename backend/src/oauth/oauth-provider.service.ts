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

  constructor(
    private readonly configService: ConfigService,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  async onModuleInit() {
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

    this.provider = new Provider(issuer, {
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
      grantTypes: ["authorization_code", "refresh_token"],
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
        // Routes live outside the /oauth mount because the provider
        // middleware 404s any path it doesn't own (it runs as a Koa app
        // and never calls next()), so unrelated routes can't be nested
        // under it.
        url: (_ctx, interaction) => `/oauth-consent/${interaction.uid}`,
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
    this.provider.proxy = true;

    this.provider.on("server_error", (_ctx, err) => {
      this.logger.error("OAuth provider server error", err.stack ?? err);
    });
    this.provider.on("authorization.error", (_ctx, err) => {
      this.logger.warn(`OAuth authorization error: ${err.message}`);
    });
    this.provider.on("grant.error", (_ctx, err) => {
      this.logger.warn(`OAuth grant error: ${err.message}`);
    });

    this.logger.log(`OAuth provider initialized — issuer ${issuer}`);
    this.logger.log(`MCP protected resource: ${mcpResource}`);
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
