import {
  generateSecret,
  insecureSecretsAllowed,
  SECRET_BYTES,
  SecretError,
  SecretPolicy,
  secretPolicyFrom,
  unwrapSecret,
  wrapSecret,
} from "./secrets";
import { fakeSafeStorage } from "./test-support/fake-safe-storage";

const SECURE: SecretPolicy = {
  safeStorage: fakeSafeStorage(true),
  allowInsecure: false,
};
const NO_OS_STRICT: SecretPolicy = {
  safeStorage: fakeSafeStorage(false),
  allowInsecure: false,
};
const NO_OS_INSECURE: SecretPolicy = {
  safeStorage: fakeSafeStorage(false),
  allowInsecure: true,
};

function caught(fn: () => unknown): SecretError {
  try {
    fn();
  } catch (error) {
    if (error instanceof SecretError) return error;
    throw error;
  }
  throw new Error("expected a SecretError");
}

describe("generateSecret", () => {
  it("draws 48 bytes and encodes them as 64 base64url characters", () => {
    const secret = generateSecret();
    expect(secret).toMatch(/^[A-Za-z0-9_-]{64}$/);
    expect(Buffer.from(secret, "base64url")).toHaveLength(SECRET_BYTES);
  });

  it("produces a different value each time", () => {
    expect(generateSecret()).not.toBe(generateSecret());
  });

  it("refuses a random source that returns the wrong size", () => {
    expect(() => generateSecret(() => Buffer.alloc(8))).toThrow(/48/);
  });

  it("passes the backend's length and variety floors", () => {
    for (let i = 0; i < 50; i++) {
      const secret = generateSecret();
      expect(secret.length).toBeGreaterThanOrEqual(32);
      expect(new Set(secret).size).toBeGreaterThanOrEqual(8);
    }
  });
});

describe("insecureSecretsAllowed", () => {
  it("is true only for exactly 1", () => {
    expect(insecureSecretsAllowed({ MONIZE_INSECURE_SECRETS: "1" })).toBe(true);
    expect(insecureSecretsAllowed({ MONIZE_INSECURE_SECRETS: "true" })).toBe(
      false,
    );
    expect(insecureSecretsAllowed({})).toBe(false);
  });

  it("builds a policy from an explicit env, never process.env", () => {
    const policy = secretPolicyFrom(fakeSafeStorage(), {});
    expect(policy.allowInsecure).toBe(false);
  });
});

describe("wrapSecret / unwrapSecret", () => {
  const secret = generateSecret();

  it("round-trips through safeStorage when it is available", () => {
    const stored = wrapSecret(secret, "jwtSecret", SECURE);
    expect(stored.enc).toBe("safeStorage");
    expect(stored.value).not.toContain(secret);
    expect(unwrapSecret(stored, "jwtSecret", SECURE)).toBe(secret);
  });

  it("refuses to store plaintext without MONIZE_INSECURE_SECRETS", () => {
    const error = caught(() => wrapSecret(secret, "jwtSecret", NO_OS_STRICT));
    expect(error.code).toBe("insecure-not-allowed");
    expect(error.message).toContain("MONIZE_INSECURE_SECRETS=1");
  });

  it("stores and reads plaintext when insecure secrets are allowed", () => {
    const stored = wrapSecret(secret, "jwtSecret", NO_OS_INSECURE);
    expect(stored.enc).toBe("plain");
    expect(unwrapSecret(stored, "jwtSecret", NO_OS_INSECURE)).toBe(secret);
  });

  it("refuses to read a plain secret without MONIZE_INSECURE_SECRETS", () => {
    const stored = wrapSecret(secret, "jwtSecret", NO_OS_INSECURE);
    expect(caught(() => unwrapSecret(stored, "jwtSecret", SECURE)).code).toBe(
      "insecure-not-allowed",
    );
  });

  it("names the secret when the value is not base64", () => {
    const error = caught(() =>
      unwrapSecret(
        { enc: "safeStorage", value: "%%%" },
        "encryptionKey",
        SECURE,
      ),
    );
    expect(error.code).toBe("undecodable");
    expect(error.secretName).toBe("encryptionKey");
  });

  it("refuses an empty stored value", () => {
    expect(
      caught(() =>
        unwrapSecret({ enc: "plain", value: "" }, "x", NO_OS_INSECURE),
      ).code,
    ).toBe("undecodable");
  });

  it("reports a decrypt failure without the decryptor's text", () => {
    const foreign = Buffer.from(`not-ours-${secret}`).toString("base64");
    const error = caught(() =>
      unwrapSecret(
        { enc: "safeStorage", value: foreign },
        "databasePassword",
        SECURE,
      ),
    );
    expect(error.code).toBe("decrypt-failed");
    expect(error.message).not.toContain(secret);
  });

  it("refuses an encrypted secret when OS encryption has gone away", () => {
    const stored = wrapSecret(secret, "jwtSecret", SECURE);
    expect(
      caught(() => unwrapSecret(stored, "jwtSecret", NO_OS_INSECURE)).code,
    ).toBe("encryption-unavailable");
  });

  it("refuses a decoded secret that is too short to be ours", () => {
    const short = Buffer.from("short").toString("base64");
    const error = caught(() =>
      unwrapSecret({ enc: "plain", value: short }, "jwtSecret", NO_OS_INSECURE),
    );
    expect(error.code).toBe("invalid-secret");
    expect(error.message).not.toContain('short"');
  });

  it("refuses to wrap a value that is too short", () => {
    expect(caught(() => wrapSecret("tiny", "jwtSecret", SECURE)).code).toBe(
      "invalid-secret",
    );
  });

  it("never puts the secret in any error message", () => {
    const messages = [
      caught(() => wrapSecret(secret, "jwtSecret", NO_OS_STRICT)).message,
      caught(() =>
        unwrapSecret(wrapSecret(secret, "j", NO_OS_INSECURE), "j", SECURE),
      ).message,
      caught(() =>
        unwrapSecret(wrapSecret(secret, "j", SECURE), "j", NO_OS_INSECURE),
      ).message,
    ];
    for (const message of messages) {
      expect(message).not.toContain(secret);
      expect(message).not.toContain(secret.slice(0, 12));
    }
  });
});
