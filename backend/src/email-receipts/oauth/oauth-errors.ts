/**
 * Why a call to a provider's token endpoint failed, as a code and nothing the
 * provider said. `invalid_grant` is the one the rest of the system acts on: the
 * grant is revoked, expired or no longer valid, so only the user can repair it
 * by connecting again. The others are this deployment's (`invalid_client`: the
 * operator's client id or secret), the provider's (`unavailable`), or a shape we
 * did not expect (`invalid_response`).
 */
export type OAuthTokenErrorCode =
  | "invalid_grant"
  | "invalid_client"
  | "rejected"
  | "unavailable"
  | "invalid_response";

/**
 * A failed token request. The message is built from the code and the HTTP
 * status only (and, for a transport failure, `describeFetchFailure`'s socket
 * line): never the authorization code, a token, the client secret or any part
 * of the response body, so it is safe to log and to store as `last_error`
 * (INV-RECEIPT-005).
 */
export class OAuthTokenError extends Error {
  constructor(
    readonly code: OAuthTokenErrorCode,
    readonly status: number | null,
    detail?: string,
  ) {
    super(
      `OAuth token request failed (${code}${status === null ? "" : `, HTTP ${status}`})${detail ? `: ${detail}` : ""}`,
    );
    this.name = "OAuthTokenError";
  }
}

/**
 * The stored authorization can no longer be used and the user has to connect the
 * mailbox again. `message` is a translated, secret-free sentence written for the
 * person, so it is what the mailbox's `last_error` holds
 * (`describeMailboxFailure` passes it through as it is).
 */
export class OAuthReconnectRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OAuthReconnectRequiredError";
  }
}
