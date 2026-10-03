import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { EmailReceiptOAuthProvider } from "../entities/email-receipt-mailbox.entity";
import {
  DEFAULT_MICROSOFT_TENANT,
  isValidMicrosoftTenant,
  oauthProviderSpec,
  type OAuthProviderSpec,
} from "./oauth-providers";

/** The path of the frontend page a provider redirects the browser back to. */
export const OAUTH_CALLBACK_PATH = "/settings/email-receipts/oauth-callback";

/** What `GET /email-receipts/mailbox/oauth/providers` answers. */
export interface EmailReceiptOAuthProviders {
  google: boolean;
  microsoft: boolean;
  redirectUri: string;
}

export interface OAuthClientCredentials {
  readonly clientId: string;
  readonly clientSecret: string;
}

/**
 * The operator's OAuth clients for the receipts mailbox (design section 3a),
 * read from the environment: one client per provider, registered by whoever runs
 * the deployment. A provider is offered only when BOTH its client id and secret
 * are set, so a half-configured provider is never shown. The client secret is
 * read here and handed to `OAuthTokenClient` only; it is not part of anything
 * this class returns to a controller.
 */
@Injectable()
export class EmailReceiptOAuthConfig {
  private readonly logger = new Logger(EmailReceiptOAuthConfig.name);
  private warnedTenant = false;

  constructor(private readonly configService: ConfigService) {}

  /** The redirect URI to register at each provider and to send in the flow. */
  redirectUri(): string {
    const base =
      this.configService.get<string>("PUBLIC_APP_URL")?.trim() ||
      "http://localhost:3000";
    return `${base.replace(/\/+$/, "")}${OAUTH_CALLBACK_PATH}`;
  }

  /** The client of a provider, or null when it is not (fully) configured. */
  client(provider: EmailReceiptOAuthProvider): OAuthClientCredentials | null {
    const clientId =
      provider === "google"
        ? this.configService.get<string>("EMAIL_RECEIPTS_GOOGLE_CLIENT_ID")
        : this.configService.get<string>("EMAIL_RECEIPTS_MICROSOFT_CLIENT_ID");
    const clientSecret =
      provider === "google"
        ? this.configService.get<string>("EMAIL_RECEIPTS_GOOGLE_CLIENT_SECRET")
        : this.configService.get<string>(
            "EMAIL_RECEIPTS_MICROSOFT_CLIENT_SECRET",
          );
    const id = clientId?.trim();
    const secret = clientSecret?.trim();
    if (!id || !secret) return null;
    if (provider === "microsoft" && this.microsoftTenant() === null) {
      return null;
    }
    return { clientId: id, clientSecret: secret };
  }

  isConfigured(provider: EmailReceiptOAuthProvider): boolean {
    return this.client(provider) !== null;
  }

  /**
   * The provider's endpoints, scopes and IMAP host. Null for Microsoft when the
   * configured tenant is not valid: that provider is then unavailable (and said
   * so once in the log) instead of being sent to an endpoint built from
   * something that is not a tenant.
   */
  spec(provider: EmailReceiptOAuthProvider): OAuthProviderSpec | null {
    if (provider === "google") return oauthProviderSpec("google");
    const tenant = this.microsoftTenant();
    return tenant === null ? null : oauthProviderSpec("microsoft", tenant);
  }

  providers(): EmailReceiptOAuthProviders {
    return {
      google: this.isConfigured("google"),
      microsoft: this.isConfigured("microsoft"),
      redirectUri: this.redirectUri(),
    };
  }

  private microsoftTenant(): string | null {
    const raw = this.configService
      .get<string>("EMAIL_RECEIPTS_MICROSOFT_TENANT")
      ?.trim();
    if (!raw) return DEFAULT_MICROSOFT_TENANT;
    if (isValidMicrosoftTenant(raw)) return raw;
    if (!this.warnedTenant) {
      this.warnedTenant = true;
      this.logger.warn(
        "EMAIL_RECEIPTS_MICROSOFT_TENANT is not a valid tenant id or domain; Microsoft sign-in is unavailable",
      );
    }
    return null;
  }
}
