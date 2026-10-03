import { loginNameFromIdToken } from "./id-token-email";

const token = (claims: unknown): string =>
  [
    Buffer.from('{"alg":"RS256"}').toString("base64url"),
    Buffer.from(JSON.stringify(claims)).toString("base64url"),
    "signature",
  ].join(".");

describe("loginNameFromIdToken", () => {
  it("reads the email claim, lower-cased and trimmed", () => {
    expect(
      loginNameFromIdToken(token({ email: "  Receipts@Example.COM " })),
    ).toBe("receipts@example.com");
  });

  it("falls back to preferred_username when there is no usable email", () => {
    expect(
      loginNameFromIdToken(
        token({ preferred_username: "Ann@Contoso.example" }),
      ),
    ).toBe("ann@contoso.example");
    expect(
      loginNameFromIdToken(
        token({ email: "not-an-address", preferred_username: "a@b.example" }),
      ),
    ).toBe("a@b.example");
  });

  it("prefers the email claim when both are usable", () => {
    expect(
      loginNameFromIdToken(
        token({ email: "a@one.example", preferred_username: "b@two.example" }),
      ),
    ).toBe("a@one.example");
  });

  it("is null when no claim is an address", () => {
    for (const claims of [
      {},
      { email: "" },
      { email: 42 },
      { email: "no-at-sign" },
      { email: "two@@signs.example" },
      { email: "a@b@c.example" },
      { email: "with space@example.com" },
      { email: "ctl\u0001char@example.com" },
      { email: `${"a".repeat(320)}@example.com` },
      "a string",
      null,
      [],
    ]) {
      expect(loginNameFromIdToken(token(claims))).toBeNull();
    }
  });

  it("holds the longest name the column takes", () => {
    const name = `${"a".repeat(310)}@b.co`;
    expect(name).toHaveLength(315);
    expect(loginNameFromIdToken(token({ email: name }))).toBe(name);
  });

  it("is null for something that is not a three-part JWT or not JSON", () => {
    for (const bad of [
      "",
      "abc",
      "a.b",
      "a.b.c.d",
      "a..c",
      `a.${Buffer.from("not json").toString("base64url")}.c`,
    ]) {
      expect(loginNameFromIdToken(bad)).toBeNull();
    }
  });
});
