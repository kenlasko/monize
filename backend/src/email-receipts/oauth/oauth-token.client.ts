import { Injectable } from "@nestjs/common";
import { z } from "zod";
import { describeFetchFailure } from "../../common/http/fetch-failure.util";
import type { EmailReceiptOAuthProvider } from "../entities/email-receipt-mailbox.entity";
import { OAuthTokenError, type OAuthTokenErrorCode } from "./oauth-errors";
import { EmailReceiptOAuthConfig } from "./oauth-config.service";

/** Each token request is given this long, end to end. */
export const OAUTH_TOKEN_TIMEOUT_MS = 15_000;

/** A token endpoint answers with a few hundred bytes; more is not one. */
const MAX_RESPONSE_CHARS = 64 * 1024;

/** What a successful token request gives back. Every field is a secret: never log it. */
export interface OAuthTokenGrant {
  readonly accessToken: string;
  /** Present on a code exchange, and on a refresh only when the provider rotates it. */
  readonly refreshToken: string | null;
  /** The OpenID Connect ID token, when the `openid` scope was granted. */
  readonly idToken: string | null;
}

const grantSchema = z.object({
  access_token: z.string().min(1).max(16_384),
  refresh_token: z.string().min(1).max(16_384).optional(),
  id_token: z.string().min(1).max(32_768).optional(),
  token_type: z
    .string()
    .refine((type) => type.toLowerCase() === "bearer")
    .optional(),
});

/** An OAuth error code is a short lower-case token (RFC 6749 section 5.2). */
const errorSchema = z.object({
  error: z
    .string()
    .regex(/^[a-z_]{1,64}$/)
    .optional(),
});

/**
 * THE only code that calls a provider's token endpoint (design section 3a and
 * INV-RECEIPT-005): the code exchange that connects a mailbox, and the refresh
 * that obtains an access token for each connection.
 *
 * A request is `application/x-www-form-urlencoded` over TLS to a constant URL,
 * with a 15 second budget and no redirects (`redirect: "error"`, so the client
 * secret is never replayed to a host the provider's answer names). The secrets
 * travel in the BODY only: there is no header carrying one, so the platform
 * never quotes a secret in a `TypeError` for an unsendable header value (the
 * failure `isSendableApiKey` exists for).
 *
 * Nothing a provider says is repeated. The response is parsed with a schema, a
 * failure is classified by the standard `error` code and the HTTP status, and
 * the `OAuthTokenError` built from it holds those two and nothing else: not the
 * authorization code, a token, the client secret, `error_description` or any
 * part of the body. A transport failure is described by
 * `describeFetchFailure`, the cause chain and socket fields.
 */
@Injectable()
export class OAuthTokenClient {
  constructor(private readonly config: EmailReceiptOAuthConfig) {}

  /** Trade an authorization code (and its PKCE verifier) for tokens. */
  exchangeCode(
    provider: EmailReceiptOAuthProvider,
    code: string,
    verifier: string,
    redirectUri: string,
  ): Promise<OAuthTokenGrant> {
    return this.request(provider, (body) => {
      body.set("grant_type", "authorization_code");
      body.set("code", code);
      body.set("code_verifier", verifier);
      body.set("redirect_uri", redirectUri);
    });
  }

  /** Trade a refresh token for an access token (and possibly a rotated refresh token). */
  refresh(
    provider: EmailReceiptOAuthProvider,
    refreshToken: string,
  ): Promise<OAuthTokenGrant> {
    const spec = this.config.spec(provider);
    return this.request(provider, (body) => {
      body.set("grant_type", "refresh_token");
      body.set("refresh_token", refreshToken);
      if (spec?.scopeOnRefresh) body.set("scope", spec.scopes.join(" "));
    });
  }

  private async request(
    provider: EmailReceiptOAuthProvider,
    fill: (body: URLSearchParams) => void,
  ): Promise<OAuthTokenGrant> {
    const spec = this.config.spec(provider);
    const client = this.config.client(provider);
    // The operator removed the client (or broke the tenant) since the flow began.
    if (!spec || !client) throw new OAuthTokenError("invalid_client", null);

    const body = new URLSearchParams();
    fill(body);
    body.set("client_id", client.clientId);
    body.set("client_secret", client.clientSecret);

    let response: Response;
    let text: string;
    try {
      response = await fetch(spec.tokenUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body: body.toString(),
        redirect: "error",
        signal: AbortSignal.timeout(OAUTH_TOKEN_TIMEOUT_MS),
      });
      text = await response.text();
    } catch (error) {
      // The platform could quote part of the request in a transport error;
      // nothing sent (the code, the verifier, a token, the secret) may survive.
      throw new OAuthTokenError(
        "unavailable",
        null,
        redact(describeFetchFailure(error), body),
      );
    }

    const json = parseJson(text);
    if (!response.ok) {
      throw new OAuthTokenError(
        classify(response.status, json),
        response.status,
      );
    }
    const grant = grantSchema.safeParse(json);
    if (!grant.success) {
      throw new OAuthTokenError("invalid_response", response.status);
    }
    return {
      accessToken: grant.data.access_token,
      refreshToken: grant.data.refresh_token ?? null,
      idToken: grant.data.id_token ?? null,
    };
  }
}

/** `text` with every value of the request body replaced by `***`, longest first. */
function redact(text: string, body: URLSearchParams): string {
  const values = [...new Set([...body.values()].filter((v) => v.length > 0))];
  values.sort((a, b) => b.length - a.length);
  let out = text;
  for (const value of values) out = out.split(value).join("***");
  return out;
}

function parseJson(text: string): unknown {
  if (text.length === 0 || text.length > MAX_RESPONSE_CHARS) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** The code of a refused request: from the standard `error` field, else the status. */
function classify(status: number, json: unknown): OAuthTokenErrorCode {
  const parsed = errorSchema.safeParse(json);
  const error = parsed.success ? parsed.data.error : undefined;
  // `interaction_required` and its siblings are Microsoft saying the user must
  // sign in again (a conditional-access policy, a withdrawn consent): the same
  // repair as a revoked grant.
  if (
    error === "invalid_grant" ||
    error === "interaction_required" ||
    error === "consent_required" ||
    error === "login_required"
  ) {
    return "invalid_grant";
  }
  if (error === "invalid_client" || error === "unauthorized_client") {
    return "invalid_client";
  }
  if (status >= 500 || status === 429 || error === "temporarily_unavailable") {
    return "unavailable";
  }
  return "rejected";
}
