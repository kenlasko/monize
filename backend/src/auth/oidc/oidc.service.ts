import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import * as client from "openid-client";

export interface OidcTokenResult {
  access_token: string;
  sub: string;
}

@Injectable()
export class OidcService implements OnModuleInit {
  private config: client.Configuration | null = null;
  private readonly logger = new Logger(OidcService.name);
  private _enabled = false;
  private callbackUrl: string;

  constructor(private configService: ConfigService) {
    this.callbackUrl =
      this.configService.get<string>("OIDC_CALLBACK_URL") ||
      "http://localhost:3001/api/v1/auth/oidc/callback";
  }

  async onModuleInit() {
    await this.initialize();
  }

  get enabled(): boolean {
    return this._enabled;
  }

  async initialize(): Promise<boolean> {
    const issuerUrl = this.configService.get<string>("OIDC_ISSUER_URL");
    const clientId = this.configService.get<string>("OIDC_CLIENT_ID");
    const clientSecret = this.configService.get<string>("OIDC_CLIENT_SECRET");

    if (!issuerUrl || !clientId || !clientSecret) {
      this.logger.log("OIDC not configured - OIDC login disabled");
      return false;
    }

    try {
      this.config = await client.discovery(
        new URL(issuerUrl),
        clientId,
        clientSecret,
      );
      this.logger.log(
        `Discovered OIDC issuer: ${this.config.serverMetadata().issuer}`,
      );

      this._enabled = true;
      this.logger.log("OIDC initialized successfully");
      return true;
    } catch (error) {
      this.logger.error(`Failed to initialize OIDC: ${error.message}`);
      return false;
    }
  }

  /**
   * Generate authorization URL for OIDC login
   */
  getAuthorizationUrl(state: string, nonce: string): string {
    if (!this.config) {
      throw new Error("OIDC client not initialized");
    }

    const url = client.buildAuthorizationUrl(this.config, {
      redirect_uri: this.callbackUrl,
      scope: "openid profile email",
      state,
      nonce,
    });

    return url.href;
  }

  /**
   * Handle the callback from the OIDC provider
   */
  async handleCallback(
    params: Record<string, string>,
    state: string,
    nonce: string,
  ): Promise<OidcTokenResult> {
    if (!this.config) {
      throw new Error("OIDC client not initialized");
    }

    // Build the full callback URL with query params for v6's authorizationCodeGrant
    const callbackUrl = new URL(this.callbackUrl);
    for (const [key, value] of Object.entries(params)) {
      callbackUrl.searchParams.set(key, value);
    }

    const tokens = await client.authorizationCodeGrant(
      this.config,
      callbackUrl,
      {
        expectedState: state,
        expectedNonce: nonce,
      },
    );

    if (!tokens.access_token) {
      throw new Error("No access token received from OIDC provider");
    }

    const claims = tokens.claims();
    if (!claims?.sub) {
      throw new Error("No subject claim in ID token");
    }

    return {
      access_token: tokens.access_token,
      sub: claims.sub,
    };
  }

  /**
   * Get user info from the OIDC provider
   */
  async getUserInfo(
    accessToken: string,
    expectedSubject: string,
  ): Promise<Record<string, unknown>> {
    if (!this.config) {
      throw new Error("OIDC client not initialized");
    }

    const userInfo = await client.fetchUserInfo(
      this.config,
      accessToken,
      expectedSubject,
    );

    return userInfo as unknown as Record<string, unknown>;
  }

  /**
   * Generate a random state value for CSRF protection
   */
  generateState(): string {
    return client.randomState();
  }

  /**
   * Generate a random nonce value for replay protection
   */
  generateNonce(): string {
    return client.randomNonce();
  }
}
