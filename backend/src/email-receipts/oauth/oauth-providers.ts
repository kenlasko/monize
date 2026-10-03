import type { EmailReceiptOAuthProvider } from "../entities/email-receipt-mailbox.entity";

/**
 * The OAuth2 providers a receipts mailbox can be connected with, as a closed
 * table (docs/future-plans/email-receipts.md section 3a). Nothing here comes
 * from a request: a provider is one of two ids, its endpoints and IMAP host are
 * constants (the Microsoft tenant is the one operator-set part, and is
 * validated), and so the access token a connection obtains is only ever sent to
 * the provider's own IMAP host, never to a host a user typed (INV-RECEIPT-004).
 *
 * The scope is what the provider offers for IMAP, not what Monize does with it:
 * `https://mail.google.com/` and `IMAP.AccessAsUser.All` both allow writing, and
 * the mailbox is still only read because the IMAP client opens the folder
 * read-only and exposes no write call (INV-RECEIPT-001 holds by the client, not
 * by the grant).
 */
export interface OAuthProviderSpec {
  readonly id: EmailReceiptOAuthProvider;
  readonly authorizeUrl: string;
  readonly tokenUrl: string;
  readonly scopes: readonly string[];
  /** Added to the authorization URL, beyond the standard code + PKCE parameters. */
  readonly authorizeParams: Readonly<Record<string, string>>;
  /** Whether a refresh request names the scope (Microsoft picks the resource by it). */
  readonly scopeOnRefresh: boolean;
  readonly imap: {
    readonly host: string;
    readonly port: number;
    readonly security: "tls";
  };
}

/** The default Microsoft tenant: work, school and personal accounts. */
export const DEFAULT_MICROSOFT_TENANT = "common";

/**
 * A Microsoft tenant is a path segment of the endpoint URL: `common`,
 * `organizations`, `consumers`, a tenant GUID or a verified domain. It starts
 * with a letter or digit, so `.` and `..` can never rewrite the path.
 */
const MICROSOFT_TENANT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9.-]{0,99}$/;

export function isValidMicrosoftTenant(tenant: string): boolean {
  return MICROSOFT_TENANT_PATTERN.test(tenant);
}

export function isEmailReceiptOAuthProvider(
  value: unknown,
): value is EmailReceiptOAuthProvider {
  return value === "google" || value === "microsoft";
}

/**
 * The spec of a provider. `tenant` only matters for Microsoft and is refused
 * when it is not a valid path segment, rather than trimmed into one.
 */
export function oauthProviderSpec(
  provider: EmailReceiptOAuthProvider,
  tenant: string = DEFAULT_MICROSOFT_TENANT,
): OAuthProviderSpec {
  if (provider === "google") {
    return {
      id: "google",
      authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenUrl: "https://oauth2.googleapis.com/token",
      scopes: ["https://mail.google.com/", "openid", "email"],
      // `offline` and `consent` are what make Google return a refresh token
      // every time, not only on the account's first grant.
      authorizeParams: { access_type: "offline", prompt: "consent" },
      scopeOnRefresh: false,
      imap: { host: "imap.gmail.com", port: 993, security: "tls" },
    };
  }
  if (!isValidMicrosoftTenant(tenant)) {
    throw new Error("The Microsoft tenant is not a valid tenant id or domain");
  }
  const base = `https://login.microsoftonline.com/${tenant}/oauth2/v2.0`;
  return {
    id: "microsoft",
    authorizeUrl: `${base}/authorize`,
    tokenUrl: `${base}/token`,
    scopes: [
      "https://outlook.office.com/IMAP.AccessAsUser.All",
      "offline_access",
      "openid",
      "email",
    ],
    authorizeParams: { prompt: "select_account" },
    scopeOnRefresh: true,
    imap: { host: "outlook.office365.com", port: 993, security: "tls" },
  };
}
