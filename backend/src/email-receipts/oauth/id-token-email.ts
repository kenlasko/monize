/** The longest mailbox login name the schema holds (`username VARCHAR(320)`). */
const MAX_LOGIN_NAME_LENGTH = 320;

/** One `@`, something either side, no whitespace and no control character (`\p{Cc}`). */
const LOGIN_NAME_PATTERN = /^[^\s@\p{Cc}]+@[^\s@\p{Cc}]+$/u;

/**
 * The mailbox login name carried by an ID token: its `email` claim, or
 * `preferred_username` where the provider gives that instead (Microsoft, for an
 * account with no email attribute). Lower-cased. Null when neither is a usable
 * address: the caller refuses the connection rather than guessing one.
 *
 * The signature is NOT verified, and that is deliberate and allowed: this token
 * was returned by the provider's token endpoint in answer to OUR request, over
 * TLS to a fixed host, which OpenID Connect Core section 3.1.3.7 (item 6) says
 * a client may take as the validation of the token's signature. Nothing here
 * takes an ID token from the browser. The name only has to name the mailbox to
 * log in to; the provider's IMAP server decides whether the access token is that
 * user's, so a wrong name fails the login and grants nothing.
 *
 * It reaches the IMAP SASL string (`user=<name>\x01auth=Bearer ...`), which
 * `\x01` delimits, so whitespace and control characters are refused.
 */
export function loginNameFromIdToken(idToken: string): string | null {
  const parts = idToken.split(".");
  if (parts.length !== 3 || parts[1] === "") return null;
  let claims: unknown;
  try {
    claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (typeof claims !== "object" || claims === null) return null;
  const record = claims as Record<string, unknown>;
  for (const claim of [record.email, record.preferred_username]) {
    if (typeof claim !== "string") continue;
    const name = claim.trim().toLowerCase();
    if (
      name.length > 0 &&
      name.length <= MAX_LOGIN_NAME_LENGTH &&
      LOGIN_NAME_PATTERN.test(name)
    ) {
      return name;
    }
  }
  return null;
}
