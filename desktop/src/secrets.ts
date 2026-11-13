import { randomBytes } from "crypto";

/**
 * The three secrets the app generates once (plan D7) and how they are kept.
 *
 * Generation: 48 random bytes, base64url-encoded to 64 characters. base64url
 * has no `+`, `/` or `=`, so the value is safe unquoted in an environment
 * variable, inside a URL and on the single line of a PostgreSQL `--pwfile`.
 * It also clears every rule the backend applies before it starts
 * (`backend/src/common/jwt-secret-policy.ts` and
 * `backend/src/common/encryption/encryption-key.ts`): 64 characters against a
 * 32-character floor, and a 64-symbol alphabet against the 8-distinct-symbol
 * and repeated-unit checks, which a uniform draw of 64 symbols fails with
 * negligible probability. A placeholder phrase the policy looks for
 * ("changeme" and its kin) appearing by chance is below one in a billion per
 * secret, and would only earn a boot warning, never a refusal.
 *
 * Storage: wrapped with Electron `safeStorage` (DPAPI on Windows), injected as
 * `SafeStorageLike` so this module runs under plain Node. Without OS
 * encryption, and whenever a stored secret is `plain`, it proceeds only when
 * `MONIZE_INSECURE_SECRETS=1` (development and the CI smoke run).
 *
 * No message raised here contains a secret value or any part of it.
 */

export const SECRET_BYTES = 48;
export const INSECURE_SECRETS_ENV = "MONIZE_INSECURE_SECRETS";

/** Shortest value accepted back from storage: the backend's own floor. */
export const MIN_SECRET_LENGTH = 32;

/** The slice of Electron's `safeStorage` this module uses. */
export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

export interface SecretPolicy {
  readonly safeStorage: SafeStorageLike;
  /** True only when `MONIZE_INSECURE_SECRETS=1`. */
  readonly allowInsecure: boolean;
}

export type SecretEncoding = "safeStorage" | "plain";

/** One secret as it sits in `config.json`. `value` is base64. */
export interface StoredSecret {
  readonly enc: SecretEncoding;
  readonly value: string;
}

export type SecretErrorCode =
  | "encryption-unavailable"
  | "insecure-not-allowed"
  | "undecodable"
  | "decrypt-failed"
  | "invalid-secret";

export class SecretError extends Error {
  constructor(
    readonly code: SecretErrorCode,
    readonly secretName: string,
    message: string,
  ) {
    super(message);
    this.name = "SecretError";
  }
}

export function insecureSecretsAllowed(
  env: Readonly<Record<string, string | undefined>>,
): boolean {
  return env[INSECURE_SECRETS_ENV] === "1";
}

export function secretPolicyFrom(
  safeStorage: SafeStorageLike,
  env: Readonly<Record<string, string | undefined>>,
): SecretPolicy {
  return { safeStorage, allowInsecure: insecureSecretsAllowed(env) };
}

export function generateSecret(
  random: (size: number) => Buffer = randomBytes,
): string {
  const bytes = random(SECRET_BYTES);
  if (bytes.length !== SECRET_BYTES) {
    throw new Error(
      `Random source returned ${bytes.length} bytes, expected ${SECRET_BYTES}.`,
    );
  }
  return bytes.toString("base64url");
}

const BASE64_RE =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/** Strict base64: Node's decoder skips junk silently, this does not. */
function decodeBase64(value: string, name: string): Buffer {
  if (value.length === 0 || !BASE64_RE.test(value)) {
    throw new SecretError(
      "undecodable",
      name,
      `The stored ${name} is not valid base64.`,
    );
  }
  return Buffer.from(value, "base64");
}

function assertUsable(secret: string, name: string): string {
  if (secret.length < MIN_SECRET_LENGTH || secret.trim() !== secret) {
    throw new SecretError(
      "invalid-secret",
      name,
      `The stored ${name} is shorter than ${MIN_SECRET_LENGTH} characters ` +
        "or carries surrounding whitespace, so it cannot be the value this " +
        "install generated.",
    );
  }
  return secret;
}

function refuseInsecure(name: string, why: string): never {
  throw new SecretError(
    "insecure-not-allowed",
    name,
    `${why} Refusing to keep ${name} unencrypted. Set ` +
      `${INSECURE_SECRETS_ENV}=1 only for development or a CI smoke run.`,
  );
}

/** Wrap a plaintext secret for `config.json`. */
export function wrapSecret(
  secret: string,
  name: string,
  policy: SecretPolicy,
): StoredSecret {
  assertUsable(secret, name);
  if (policy.safeStorage.isEncryptionAvailable()) {
    return {
      enc: "safeStorage",
      value: policy.safeStorage.encryptString(secret).toString("base64"),
    };
  }
  if (!policy.allowInsecure) {
    refuseInsecure(name, "Operating-system encryption is not available.");
  }
  return {
    enc: "plain",
    value: Buffer.from(secret, "utf8").toString("base64"),
  };
}

/** Recover a plaintext secret from `config.json`, or throw naming which one. */
export function unwrapSecret(
  stored: StoredSecret,
  name: string,
  policy: SecretPolicy,
): string {
  const bytes = decodeBase64(stored.value, name);
  if (stored.enc === "plain") {
    if (!policy.allowInsecure) {
      refuseInsecure(name, `The stored ${name} is not encrypted.`);
    }
    return assertUsable(bytes.toString("utf8"), name);
  }
  if (!policy.safeStorage.isEncryptionAvailable()) {
    throw new SecretError(
      "encryption-unavailable",
      name,
      `The stored ${name} is encrypted, but operating-system encryption is ` +
        "not available, so it cannot be read.",
    );
  }
  let secret: string;
  try {
    secret = policy.safeStorage.decryptString(bytes);
  } catch {
    // The underlying error is dropped on purpose: what matters is which
    // secret, and nothing from the decryptor is allowed into the message.
    throw new SecretError(
      "decrypt-failed",
      name,
      `The stored ${name} could not be decrypted. It was encrypted for a ` +
        "different Windows account or machine, or the file is damaged.",
    );
  }
  return assertUsable(secret, name);
}
