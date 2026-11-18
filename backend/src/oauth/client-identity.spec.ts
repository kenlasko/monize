import {
  CLIENT_NAME_MAX,
  boundCodePoints,
  claimsToBeMonize,
  clientNameProblem,
  displayClientName,
  isLoopbackRedirect,
  redirectUriProblem,
} from "./client-identity";

describe("client identity rules (GHSA-vmgq-326p-fprx)", () => {
  describe("redirectUriProblem", () => {
    it.each([
      "https://claude.test/api/mcp/auth_callback",
      "https://127.0.0.1/cb",
      "http://127.0.0.1:33418/callback",
      "http://localhost:3000/cb",
      "http://[::1]:9000/cb",
      "vscode://publisher.extension/cb",
      "com.example.app:/oauth",
    ])("accepts %s", (uri) => {
      expect(redirectUriProblem(uri)).toBeNull();
    });

    it.each([
      "http://attacker.test/cb",
      "http://127.0.0.1.attacker.test/cb",
      "http://localhost.attacker.test/cb",
      "HTTP://ATTACKER.TEST/cb",
    ])("refuses plain http off a loopback address: %s", (uri) => {
      expect(redirectUriProblem(uri)).toMatch(/https/);
    });

    it("leaves what it cannot parse, or a non-string, to the provider", () => {
      expect(redirectUriProblem("not a url")).toBeNull();
      expect(redirectUriProblem(42)).toBeNull();
      expect(redirectUriProblem(undefined)).toBeNull();
    });
  });

  describe("clientNameProblem", () => {
    it("accepts an ordinary name, and leaves a non-string to the provider", () => {
      expect(clientNameProblem("Claude")).toBeNull();
      expect(clientNameProblem("Cursor (work laptop)")).toBeNull();
      expect(clientNameProblem(undefined)).toBeNull();
      expect(clientNameProblem(7)).toBeNull();
    });

    it.each([
      ["a bidi override", "Google‮SignIn"],
      ["a zero-width joiner", "Cla‍ude"],
      ["a line break", "Claude\nAllow this"],
      ["a line separator", "Claude Allow"],
    ])("refuses %s", (_label, name) => {
      expect(clientNameProblem(name)).toMatch(/control/);
    });

    it("refuses a blank name", () => {
      expect(clientNameProblem("   ")).toMatch(/blank/);
    });

    it("counts code points, not UTF-16 units, against the cap", () => {
      const emoji = "\u{1F600}";
      expect(clientNameProblem(emoji.repeat(CLIENT_NAME_MAX))).toBeNull();
      expect(clientNameProblem(emoji.repeat(CLIENT_NAME_MAX + 1))).toMatch(
        /longer/,
      );
    });

    it.each([
      "Monize",
      "Monize Support",
      "m o n i z e",
      "MONIZE-sync",
      "Ｍｏｎｉｚｅ",
    ])("refuses a name presenting itself as Monize: %s", (name) => {
      expect(claimsToBeMonize(name)).toBe(true);
      expect(clientNameProblem(name)).toMatch(/Monize/);
    });
  });

  describe("displayClientName", () => {
    it("replaces unsafe characters, trims and bounds a stored name", () => {
      expect(displayClientName("  Google‮SignIn ", "cid")).toBe(
        "Google SignIn",
      );
      expect(
        Array.from(displayClientName("x".repeat(500), "cid")),
      ).toHaveLength(CLIENT_NAME_MAX);
    });

    it("falls back to the client id when nothing is left", () => {
      expect(displayClientName("‮‍", "client-1")).toBe("client-1");
      expect(displayClientName(null, "client-1")).toBe("client-1");
      expect(displayClientName(undefined, "client-1")).toBe("client-1");
    });
  });

  it("boundCodePoints never splits a surrogate pair", () => {
    expect(boundCodePoints("a\u{1F600}b", 2)).toBe("a\u{1F600}");
  });

  it("isLoopbackRedirect recognises only the device's own addresses", () => {
    expect(isLoopbackRedirect(new URL("http://127.0.0.1:8/cb"))).toBe(true);
    expect(isLoopbackRedirect(new URL("http://[::1]/cb"))).toBe(true);
    expect(isLoopbackRedirect(new URL("https://localhost/cb"))).toBe(true);
    expect(isLoopbackRedirect(new URL("https://claude.test/cb"))).toBe(false);
    expect(isLoopbackRedirect(new URL("vscode://localhost/cb"))).toBe(false);
  });
});
