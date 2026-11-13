import {
  findDeepLinkArgument,
  MAX_DEEP_LINK_LENGTH,
  parseDeepLink,
} from "./deep-link";

const ORIGIN = "http://127.0.0.1:3380";

describe("parseDeepLink", () => {
  it.each([
    ["monize://open/accounts", `${ORIGIN}/accounts`],
    ["monize://open/accounts/", `${ORIGIN}/accounts/`],
    ["monize://open", `${ORIGIN}/`],
    ["monize://open/", `${ORIGIN}/`],
    ["monize://open?tab=1", `${ORIGIN}/?tab=1`],
    [
      "monize://open/reports/net-worth?range=ytd#top",
      `${ORIGIN}/reports/net-worth?range=ytd#top`,
    ],
    ["MONIZE://OPEN/accounts", `${ORIGIN}/accounts`],
    ["monize://open/a%20b", `${ORIGIN}/a%20b`],
  ])("maps %s onto the app origin", (raw, expected) => {
    expect(parseDeepLink(raw, ORIGIN)).toBe(expected);
  });

  it.each([
    // Not the route.
    ["another host", "monize://settings/accounts"],
    ["an empty host", "monize:///accounts"],
    ["no slashes", "monize:open/accounts"],
    ["a host that only starts with open", "monize://opener/accounts"],
    ["a host carrying open as a subdomain", "monize://open.evil.example/x"],
    ["a port", "monize://open:3380/accounts"],
    ["credentials", "monize://user:pw@open/accounts"],
    ["a user only", "monize://user@open/accounts"],
    ["open as the user", "monize://open@evil.example/accounts"],
    ["another scheme", "https://open/accounts"],
    ["a lookalike scheme", "monizex://open/accounts"],
    ["the scheme without the separator", "monize:"],
    // Leaving the origin.
    ["a protocol-relative path", "monize://open//evil.example/x"],
    [
      "a protocol-relative path after the query mark",
      "monize://open//evil.example?x",
    ],
    ["a backslash", "monize://open/\\evil.example"],
    ["a backslash pair", "monize://open\\\\evil.example"],
    ["an encoded slash", "monize://open/%2fevil.example"],
    ["an encoded slash, upper case", "monize://open/%2Fevil.example"],
    ["an encoded backslash", "monize://open/%5cevil.example"],
    ["an encoded dot segment", "monize://open/%2e%2e/x"],
    ["a double-encoded slash", "monize://open/%252fevil.example"],
    ["a dot-dot segment", "monize://open/../../etc/passwd"],
    ["a dot segment", "monize://open/./accounts"],
    ["a tab the parser would drop", "monize://open/\t/evil.example"],
    ["a newline", "monize://open/accounts\n"],
    ["a space", "monize://open/ accounts"],
    ["a leading space", " monize://open/accounts"],
    ["a NUL", "monize://open/accounts\u0000"],
    ["a non-ASCII character", "monize://open/accounts\u2215evil"],
    ["a javascript: URL", "javascript:alert(1)"],
    ["a file: URL", "file:///C:/Windows/System32/calc.exe"],
    // Not input at all.
    ["an empty string", ""],
    ["an over-long link", `monize://open/${"a".repeat(MAX_DEEP_LINK_LENGTH)}`],
  ])("refuses %s", (_name, raw) => {
    expect(parseDeepLink(raw, ORIGIN)).toBeNull();
  });

  it.each([[undefined], [null], [42], [{ href: "monize://open/x" }]])(
    "refuses a non-string (%p)",
    (raw) => {
      expect(parseDeepLink(raw, ORIGIN)).toBeNull();
    },
  );

  it("never yields a URL off the origin, whatever follows the host", () => {
    const tails = ["/", "//", "/@", "/:", "?", "#", "/%40", "/;", "/~", "/.x"];
    for (const tail of tails) {
      const result = parseDeepLink(`monize://open${tail}evil.example`, ORIGIN);
      if (result !== null) {
        expect(new URL(result).origin).toBe(ORIGIN);
      }
    }
  });
});

describe("findDeepLinkArgument", () => {
  it("finds the link among Chromium's switches", () => {
    expect(
      findDeepLinkArgument([
        "C:\\Program Files\\Monize\\Monize.exe",
        "--allow-file-access-from-files",
        "MONIZE://open/accounts",
      ]),
    ).toBe("MONIZE://open/accounts");
  });

  it("answers undefined when there is none", () => {
    expect(findDeepLinkArgument(["Monize.exe", "--quit"])).toBeUndefined();
  });
});
