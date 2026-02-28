import {
  generateCsrfToken,
  verifyCsrfToken,
  getCsrfCookieOptions,
} from "./csrf.util";

describe("csrf.util", () => {
  describe("generateCsrfToken", () => {
    it("returns a 64-character hex string without session binding", () => {
      const token = generateCsrfToken();
      expect(token).toHaveLength(64);
      expect(token).toMatch(/^[0-9a-f]{64}$/);
    });

    it("generates unique tokens on each call", () => {
      const token1 = generateCsrfToken();
      const token2 = generateCsrfToken();
      expect(token1).not.toBe(token2);
    });

    it("returns session-bound token with nonce:hmac format", () => {
      const token = generateCsrfToken(
        "user-123",
        "secret-key-32chars-minimum!!",
      );
      expect(token).toContain(":");
      const parts = token.split(":");
      expect(parts).toHaveLength(2);
      expect(parts[0]).toHaveLength(64); // 32-byte nonce in hex
      expect(parts[1]).toHaveLength(64); // SHA-256 HMAC in hex
    });

    it("generates unique session-bound tokens", () => {
      const secret = "secret-key-32chars-minimum!!";
      const t1 = generateCsrfToken("user-1", secret);
      const t2 = generateCsrfToken("user-1", secret);
      expect(t1).not.toBe(t2);
    });
  });

  describe("verifyCsrfToken", () => {
    it("verifies a valid session-bound token", () => {
      const secret = "secret-key-32chars-minimum!!";
      const sessionId = "user-123";
      const token = generateCsrfToken(sessionId, secret);
      expect(verifyCsrfToken(token, sessionId, secret)).toBe(true);
    });

    it("rejects a token with wrong session", () => {
      const secret = "secret-key-32chars-minimum!!";
      const token = generateCsrfToken("user-123", secret);
      expect(verifyCsrfToken(token, "user-456", secret)).toBe(false);
    });

    it("rejects a token with wrong secret", () => {
      const token = generateCsrfToken("user-123", "secret-1");
      expect(verifyCsrfToken(token, "user-123", "secret-2")).toBe(false);
    });

    it("rejects a malformed token", () => {
      expect(verifyCsrfToken("no-colon-token", "user-1", "secret")).toBe(false);
    });

    it("returns true without session binding (fallback)", () => {
      expect(verifyCsrfToken("any-token")).toBe(true);
    });
  });

  describe("getCsrfCookieOptions", () => {
    it("returns httpOnly as false (readable by JavaScript for double-submit)", () => {
      const options = getCsrfCookieOptions(true);
      expect(options.httpOnly).toBe(false);
    });

    it("returns secure as true in production", () => {
      const options = getCsrfCookieOptions(true);
      expect(options.secure).toBe(true);
    });

    it("returns secure as false in non-production", () => {
      const options = getCsrfCookieOptions(false);
      expect(options.secure).toBe(false);
    });

    it("returns sameSite as lax", () => {
      const options = getCsrfCookieOptions(true);
      expect(options.sameSite).toBe("lax");
    });

    it("returns maxAge of 7 days in milliseconds", () => {
      const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
      const options = getCsrfCookieOptions(true);
      expect(options.maxAge).toBe(sevenDaysMs);
    });

    it("returns path as /", () => {
      const options = getCsrfCookieOptions(true);
      expect(options.path).toBe("/");
    });

    it("httpOnly is false for both production and non-production", () => {
      expect(getCsrfCookieOptions(true).httpOnly).toBe(false);
      expect(getCsrfCookieOptions(false).httpOnly).toBe(false);
    });
  });
});
