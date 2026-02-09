import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Issuer, Client, generators, TokenSet } from "openid-client";

@Injectable()
export class OidcService implements OnModuleInit {
  private client: Client | null = null;
  private issuer: Issuer | null = null;
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
      // Auto-discover OIDC configuration from issuer
      this.issuer = await Issuer.discover(issuerUrl);
      this.logger.log(`Discovered OIDC issuer: ${this.issuer.metadata.issuer}`);

      this.client = new this.issuer.Client({
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uris: [this.callbackUrl],
        response_types: ["code"],
      });

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
    if (!this.client) {
      throw new Error("OIDC client not initialized");
    }

    return this.client.authorizationUrl({
      scope: "openid profile email",
      state,
      nonce,
    });
  }

  /**
   * Handle the callback from the OIDC provider
   */
  async handleCallback(
    params: Record<string, string>,
    state: string,
    nonce: string,
  ): Promise<TokenSet> {
    if (!this.client) {
      throw new Error("OIDC client not initialized");
    }

    const tokenSet = await this.client.callback(this.callbackUrl, params, {
      state,
      nonce,
    });

    return tokenSet;
  }

  /**
   * Get user info from the OIDC provider
   */
  async getUserInfo(accessToken: string): Promise<Record<string, unknown>> {
    if (!this.client) {
      throw new Error("OIDC client not initialized");
    }

    return this.client.userinfo(accessToken);
  }

  /**
   * Generate a random state value for CSRF protection
   */
  generateState(): string {
    return generators.state();
  }

  /**
   * Generate a random nonce value for replay protection
   */
  generateNonce(): string {
    return generators.nonce();
  }
}
