import { createPrivateKey, createSign } from "node:crypto";
import type { KeyObject } from "node:crypto";
import { BankSyncProviderError } from "../bank-sync-provider.errors";
import type { BankSyncCredentials } from "../bank-sync-provider.interface";

/** The JWT claims Enable Banking checks (`iss`, `aud`); fixed by the provider. */
export const ENABLE_BANKING_JWT_ISSUER = "enablebanking.com";
export const ENABLE_BANKING_JWT_AUDIENCE = "api.enablebanking.com";

/**
 * How long a signed token lives. The provider accepts up to a day; one hour is
 * enough for any single call and a leaked token is worth little.
 */
export const ENABLE_BANKING_JWT_TTL_SECONDS = 3600;

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

/**
 * Parses a PEM as an RSA private key, or throws `bad_request`.
 *
 * The message names what is wrong and never the input: the PEM is a secret and
 * the crypto library's own message is not worth the risk of quoting it.
 */
export function parseRsaPrivateKey(pem: string): KeyObject {
  let key: KeyObject;
  try {
    key = createPrivateKey({ key: pem, format: "pem" });
  } catch {
    throw new BankSyncProviderError(
      "bad_request",
      "The private key is not a readable PEM private key.",
    );
  }
  if (key.asymmetricKeyType !== "rsa") {
    throw new BankSyncProviderError(
      "bad_request",
      "The private key is not an RSA key.",
    );
  }
  return key;
}

/**
 * Signs the RS256 JWT that authenticates one Enable Banking request: header
 * `{ typ: "JWT", alg: "RS256", kid: <application id> }`, claims
 * `{ iss, aud, iat, exp }`, base64url without padding, PKCS#1 v1.5 over SHA-256.
 *
 * @param nowMs injectable clock (epoch milliseconds) so a test can pin `iat`.
 */
export function signEnableBankingJwt(
  credentials: BankSyncCredentials,
  nowMs: number = Date.now(),
): string {
  const key = parseRsaPrivateKey(credentials.privateKeyPem);
  const iat = Math.floor(nowMs / 1000);
  const header = { typ: "JWT", alg: "RS256", kid: credentials.applicationId };
  const claims = {
    iss: ENABLE_BANKING_JWT_ISSUER,
    aud: ENABLE_BANKING_JWT_AUDIENCE,
    iat,
    exp: iat + ENABLE_BANKING_JWT_TTL_SECONDS,
  };
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claims))}`;
  const signer = createSign("RSA-SHA256");
  signer.update(signingInput);
  signer.end();
  return `${signingInput}.${base64url(signer.sign(key))}`;
}
