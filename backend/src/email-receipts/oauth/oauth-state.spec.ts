import { createHash } from "node:crypto";
import { EncryptionService } from "../../common/encryption/encryption.service";
import { ConfigService } from "@nestjs/config";
import {
  createPkcePair,
  newOAuthState,
  OAUTH_STATE_TTL_MS,
  OAuthStateError,
  openOAuthState,
  pkceChallenge,
  sealOAuthState,
} from "./oauth-state";

const cipher = new EncryptionService(
  new ConfigService({ ENCRYPTION_KEY: "k".repeat(40) }),
);
const otherCipher = new EncryptionService(
  new ConfigService({ ENCRYPTION_KEY: "z".repeat(40) }),
);
const NOW = Date.UTC(2026, 8, 30, 12, 0, 0);

describe("OAuth state and PKCE (INV-RECEIPT-007)", () => {
  it("round-trips the user, the provider, the verifier and the nonce", () => {
    const { payload } = newOAuthState("user-1", "microsoft", NOW);
    const sealed = sealOAuthState(cipher, payload);

    expect(openOAuthState(cipher, sealed, NOW + 1000)).toEqual(payload);
    expect(payload).toMatchObject({
      v: 1,
      userId: "user-1",
      provider: "microsoft",
      exp: NOW + OAUTH_STATE_TTL_MS,
    });
  });

  it("expires after 10 minutes", () => {
    expect(OAUTH_STATE_TTL_MS).toBe(600_000);
    const { payload } = newOAuthState("user-1", "google", NOW);
    const sealed = sealOAuthState(cipher, payload);

    expect(() => openOAuthState(cipher, sealed, payload.exp - 1)).not.toThrow();
    expect(() => openOAuthState(cipher, sealed, payload.exp)).toThrow(
      OAuthStateError,
    );
    expect(() => openOAuthState(cipher, sealed, payload.exp + 1)).toThrow(
      OAuthStateError,
    );
  });

  it("travels as URL-safe text and never shows the verifier or the user", () => {
    const { payload } = newOAuthState("user-1", "google", NOW);
    const sealed = sealOAuthState(cipher, payload);

    expect(sealed).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(sealed).not.toContain(payload.verifier);
    expect(Buffer.from(sealed, "base64url").toString()).not.toContain("user-1");
  });

  it("refuses a state sealed under another key, a truncated one and junk", () => {
    const { payload } = newOAuthState("user-1", "google", NOW);
    const sealed = sealOAuthState(otherCipher, payload);
    const mine = sealOAuthState(cipher, payload);

    for (const bad of [
      sealed,
      mine.slice(0, mine.length - 4),
      `${mine}AAAA`,
      "",
      "not a state",
      "AAAA",
    ]) {
      expect(() => openOAuthState(cipher, bad, NOW)).toThrow(OAuthStateError);
    }
  });

  it("refuses a state that was altered by one character", () => {
    const { payload } = newOAuthState("user-1", "google", NOW);
    const sealed = sealOAuthState(cipher, payload);
    const middle = Math.floor(sealed.length / 2);
    const flipped =
      sealed.slice(0, middle) +
      (sealed[middle] === "A" ? "B" : "A") +
      sealed.slice(middle + 1);

    expect(() => openOAuthState(cipher, flipped, NOW)).toThrow(OAuthStateError);
  });

  it("refuses an authentic envelope whose content is not a state", () => {
    const seal = (value: unknown) =>
      Buffer.from(cipher.encrypt(JSON.stringify(value)), "utf8").toString(
        "base64url",
      );
    const { payload } = newOAuthState("user-1", "google", NOW);

    for (const bad of [
      { ...payload, provider: "yahoo" },
      { ...payload, v: 2 },
      { ...payload, verifier: "short" },
      { ...payload, nonce: "x" },
      { ...payload, exp: "tomorrow" },
      { ...payload, userId: "" },
      "a string",
      null,
    ]) {
      expect(() => openOAuthState(cipher, seal(bad), NOW)).toThrow(
        OAuthStateError,
      );
    }
  });

  it("gives every flow its own nonce and verifier", () => {
    const a = newOAuthState("user-1", "google", NOW);
    const b = newOAuthState("user-1", "google", NOW);
    expect(a.payload.nonce).not.toBe(b.payload.nonce);
    expect(a.payload.verifier).not.toBe(b.payload.verifier);
    expect(a.challenge).not.toBe(b.challenge);
  });

  it("makes an S256 challenge from a verifier of the RFC 7636 length", () => {
    const { verifier, challenge } = createPkcePair();
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(challenge).toBe(
      createHash("sha256").update(verifier).digest("base64url"),
    );
    // RFC 7636 appendix B.
    expect(pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    );
  });
});
