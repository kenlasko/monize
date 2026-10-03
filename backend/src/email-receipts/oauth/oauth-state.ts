import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { isEmailReceiptOAuthProvider } from "./oauth-providers";
import type { EmailReceiptOAuthProvider } from "../entities/email-receipt-mailbox.entity";

/**
 * The `state` of an OAuth authorization, and its PKCE pair (INV-RECEIPT-007,
 * docs/future-plans/email-receipts.md section 3a).
 *
 * The state is an envelope, not a lookup key: the server keeps nothing between
 * `start` and `complete`. It is the JSON of who started the flow, with which
 * provider, the PKCE verifier and an expiry, encrypted and authenticated with
 * `EncryptionService` (AES-256-GCM), so it can be neither read nor altered by
 * the browser that carries it, and the verifier never reaches the provider's
 * redirect. Three things make it good for one completion by its own user: it
 * expires (10 minutes), it carries the user id that `complete` compares with the
 * JWT's, and its `nonce` is claimed once in `single_use_tokens`.
 */

/** How long a started flow can be completed. */
export const OAUTH_STATE_TTL_MS = 10 * 60_000;

/** `single_use_tokens.purpose` of the nonce claim. A literal, never a request's. */
export const OAUTH_STATE_PURPOSE = "email-receipt-oauth";

export interface OAuthStatePayload {
  readonly v: 1;
  readonly userId: string;
  readonly provider: EmailReceiptOAuthProvider;
  readonly verifier: string;
  readonly nonce: string;
  /** Expiry, milliseconds since the epoch. */
  readonly exp: number;
}

/** The two halves of the envelope `EncryptionService` provides. */
export interface StateCipher {
  encrypt(plaintext: string): string;
  decrypt(ciphertext: string): string;
}

/**
 * A state that is not a valid, unexpired envelope. Deliberately carries no
 * reason: a caller cannot tell a forged state from an expired one, and neither
 * can the browser.
 */
export class OAuthStateError extends Error {
  constructor() {
    super("The OAuth state is not valid");
    this.name = "OAuthStateError";
  }
}

const payloadSchema = z.object({
  v: z.literal(1),
  userId: z.string().min(1).max(64),
  provider: z.string().refine(isEmailReceiptOAuthProvider),
  verifier: z.string().min(43).max(128),
  nonce: z.string().min(16).max(64),
  exp: z.number().int().positive(),
});

const base64url = (bytes: Buffer): string => bytes.toString("base64url");

/** A PKCE pair (RFC 7636): a 256-bit verifier and its S256 challenge. */
export function createPkcePair(): { verifier: string; challenge: string } {
  const verifier = base64url(randomBytes(32));
  return { verifier, challenge: pkceChallenge(verifier) };
}

export function pkceChallenge(verifier: string): string {
  return base64url(createHash("sha256").update(verifier, "ascii").digest());
}

/** A fresh flow: the PKCE pair, the nonce and the expiry, for this user and provider. */
export function newOAuthState(
  userId: string,
  provider: EmailReceiptOAuthProvider,
  now: number = Date.now(),
): { payload: OAuthStatePayload; challenge: string } {
  const { verifier, challenge } = createPkcePair();
  return {
    payload: {
      v: 1,
      userId,
      provider,
      verifier,
      nonce: base64url(randomBytes(16)),
      exp: now + OAUTH_STATE_TTL_MS,
    },
    challenge,
  };
}

/** The state as it travels in a URL: the ciphertext, base64url-encoded. */
export function sealOAuthState(
  cipher: Pick<StateCipher, "encrypt">,
  payload: OAuthStatePayload,
): string {
  return Buffer.from(cipher.encrypt(JSON.stringify(payload)), "utf8").toString(
    "base64url",
  );
}

/**
 * Open a state. Throws `OAuthStateError` for anything that is not a state this
 * server sealed and that has not expired: a value that does not decrypt (wrong
 * key, altered, not ours), does not parse, or whose expiry has passed. It does
 * not compare the user and does not claim the nonce; `complete` does both, in
 * that order, so another user's attempt never spends a state that is not theirs.
 */
export function openOAuthState(
  cipher: Pick<StateCipher, "decrypt">,
  state: string,
  now: number = Date.now(),
): OAuthStatePayload {
  let parsed: z.infer<typeof payloadSchema>;
  try {
    const json = cipher.decrypt(
      Buffer.from(state, "base64url").toString("utf8"),
    );
    parsed = payloadSchema.parse(JSON.parse(json));
  } catch {
    throw new OAuthStateError();
  }
  if (parsed.exp <= now) throw new OAuthStateError();
  return {
    v: 1,
    userId: parsed.userId,
    provider: parsed.provider as EmailReceiptOAuthProvider,
    verifier: parsed.verifier,
    nonce: parsed.nonce,
    exp: parsed.exp,
  };
}
