import { generateKeyPairSync, verify } from "node:crypto";
import type { KeyObject } from "node:crypto";
import { BankSyncProviderError } from "../bank-sync-provider.errors";
import {
  ENABLE_BANKING_JWT_AUDIENCE,
  ENABLE_BANKING_JWT_ISSUER,
  ENABLE_BANKING_JWT_TTL_SECONDS,
  parseRsaPrivateKey,
  signEnableBankingJwt,
} from "./enable-banking-jwt";

/** Keys are generated here, never read from anywhere: the suite holds no secret. */
describe("Enable Banking JWT", () => {
  let publicKey: KeyObject;
  let pkcs8Pem: string;
  let pkcs1Pem: string;
  let ecPem: string;

  beforeAll(() => {
    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
    publicKey = rsa.publicKey;
    pkcs8Pem = rsa.privateKey.export({
      type: "pkcs8",
      format: "pem",
    }) as string;
    pkcs1Pem = rsa.privateKey.export({
      type: "pkcs1",
      format: "pem",
    }) as string;
    ecPem = generateKeyPairSync("ec", {
      namedCurve: "prime256v1",
    }).privateKey.export({ type: "pkcs8", format: "pem" }) as string;
  });

  const NOW_MS = Date.UTC(2026, 2, 10, 12, 0, 0, 999);
  const APPLICATION_ID = "00000000-0000-4000-8000-000000000001";

  const decode = (part: string): Record<string, unknown> =>
    JSON.parse(Buffer.from(part, "base64url").toString("utf8"));

  describe("signEnableBankingJwt", () => {
    it("has three base64url parts with no padding", () => {
      const token = signEnableBankingJwt(
        { applicationId: APPLICATION_ID, privateKeyPem: pkcs8Pem },
        NOW_MS,
      );
      const parts = token.split(".");
      expect(parts).toHaveLength(3);
      for (const part of parts) {
        expect(part).toMatch(/^[A-Za-z0-9_-]+$/);
      }
    });

    it("carries the header { typ, alg, kid } with the application id as kid", () => {
      const [header] = signEnableBankingJwt(
        { applicationId: APPLICATION_ID, privateKeyPem: pkcs8Pem },
        NOW_MS,
      ).split(".");
      expect(decode(header)).toEqual({
        typ: "JWT",
        alg: "RS256",
        kid: APPLICATION_ID,
      });
    });

    it("carries iss, aud, iat and exp = iat + 3600 from the injected clock", () => {
      const [, claims] = signEnableBankingJwt(
        { applicationId: APPLICATION_ID, privateKeyPem: pkcs8Pem },
        NOW_MS,
      ).split(".");
      const iat = Math.floor(NOW_MS / 1000);
      expect(decode(claims)).toEqual({
        iss: "enablebanking.com",
        aud: "api.enablebanking.com",
        iat,
        exp: iat + 3600,
      });
      expect(ENABLE_BANKING_JWT_ISSUER).toBe("enablebanking.com");
      expect(ENABLE_BANKING_JWT_AUDIENCE).toBe("api.enablebanking.com");
      expect(ENABLE_BANKING_JWT_TTL_SECONDS).toBe(3600);
    });

    it("stays within the provider's one-day limit", () => {
      expect(ENABLE_BANKING_JWT_TTL_SECONDS).toBeLessThanOrEqual(86_400);
    });

    it("verifies as RS256 with the matching public key", () => {
      const token = signEnableBankingJwt(
        { applicationId: APPLICATION_ID, privateKeyPem: pkcs8Pem },
        NOW_MS,
      );
      const [header, claims, signature] = token.split(".");
      expect(
        verify(
          "RSA-SHA256",
          Buffer.from(`${header}.${claims}`),
          publicKey,
          Buffer.from(signature, "base64url"),
        ),
      ).toBe(true);
    });

    it("does not verify against a tampered payload", () => {
      const [header, , signature] = signEnableBankingJwt(
        { applicationId: APPLICATION_ID, privateKeyPem: pkcs8Pem },
        NOW_MS,
      ).split(".");
      const forged = Buffer.from(
        JSON.stringify({ iss: "someone-else" }),
      ).toString("base64url");
      expect(
        verify(
          "RSA-SHA256",
          Buffer.from(`${header}.${forged}`),
          publicKey,
          Buffer.from(signature, "base64url"),
        ),
      ).toBe(false);
    });

    it("signs with a PKCS#1 PEM as well as a PKCS#8 one", () => {
      const token = signEnableBankingJwt(
        { applicationId: APPLICATION_ID, privateKeyPem: pkcs1Pem },
        NOW_MS,
      );
      const [header, claims, signature] = token.split(".");
      expect(
        verify(
          "RSA-SHA256",
          Buffer.from(`${header}.${claims}`),
          publicKey,
          Buffer.from(signature, "base64url"),
        ),
      ).toBe(true);
    });

    it("uses the real clock when none is injected", () => {
      const before = Math.floor(Date.now() / 1000);
      const [, claims] = signEnableBankingJwt({
        applicationId: APPLICATION_ID,
        privateKeyPem: pkcs8Pem,
      }).split(".");
      const iat = decode(claims).iat as number;
      expect(iat).toBeGreaterThanOrEqual(before);
      expect(iat).toBeLessThanOrEqual(before + 5);
    });

    it("refuses an EC key without echoing it", () => {
      let caught: unknown;
      try {
        signEnableBankingJwt(
          { applicationId: APPLICATION_ID, privateKeyPem: ecPem },
          NOW_MS,
        );
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(BankSyncProviderError);
      expect((caught as BankSyncProviderError).kind).toBe("bad_request");
      expect((caught as Error).message).not.toContain("PRIVATE KEY");
    });
  });

  describe("parseRsaPrivateKey", () => {
    it("returns an RSA key object for a PKCS#8 and a PKCS#1 PEM", () => {
      expect(parseRsaPrivateKey(pkcs8Pem).asymmetricKeyType).toBe("rsa");
      expect(parseRsaPrivateKey(pkcs1Pem).asymmetricKeyType).toBe("rsa");
    });

    it("rejects an EC key as not RSA", () => {
      expect(() => parseRsaPrivateKey(ecPem)).toThrow(
        expect.objectContaining({
          kind: "bad_request",
          message: "The private key is not an RSA key.",
        }),
      );
    });

    it.each([
      ["garbage", "this is not a key"],
      ["an empty string", ""],
      [
        "a truncated PEM",
        "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0B\n-----END PRIVATE KEY-----",
      ],
      [
        "a public key",
        "-----BEGIN PUBLIC KEY-----\nMFwwDQYJKoZIhvcNAQEBBQADSwAwSAJBAL\n-----END PUBLIC KEY-----",
      ],
    ])("rejects %s with a typed error that quotes nothing", (_label, pem) => {
      let caught: unknown;
      try {
        parseRsaPrivateKey(pem);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(BankSyncProviderError);
      expect((caught as BankSyncProviderError).kind).toBe("bad_request");
      expect((caught as Error).message).toBe(
        "The private key is not a readable PEM private key.",
      );
    });
  });
});
