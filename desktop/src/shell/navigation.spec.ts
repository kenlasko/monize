import {
  ALLOWED_PERMISSIONS,
  decideNavigation,
  isPermissionAllowed,
  MAX_URL_LENGTH,
} from "./navigation";

const ORIGIN = "http://127.0.0.1:3380";

describe("decideNavigation", () => {
  it.each([
    `${ORIGIN}/`,
    `${ORIGIN}/login`,
    `${ORIGIN}/accounts?id=1#x`,
    "http://127.0.0.1:3380",
  ])("keeps %s in the window", (url) => {
    expect(decideNavigation(url, ORIGIN)).toEqual({ action: "allow" });
  });

  it.each([
    [
      "https://github.com/kenlasko/monize",
      "https://github.com/kenlasko/monize",
    ],
    ["http://example.com", "http://example.com/"],
    ["mailto:someone@example.com", "mailto:someone@example.com"],
    // Same host, other port: the backend, or anything else, is not the app.
    ["http://127.0.0.1:3381/api", "http://127.0.0.1:3381/api"],
    ["http://localhost:3380/", "http://localhost:3380/"],
    ["https://127.0.0.1:3380/", "https://127.0.0.1:3380/"],
  ])("sends %s to the system browser", (url, expected) => {
    expect(decideNavigation(url, ORIGIN)).toEqual({
      action: "external",
      url: expected,
    });
  });

  it.each([
    ["file:", "file:///C:/Windows/System32/calc.exe"],
    ["javascript:", "javascript:alert(document.cookie)"],
    ["data:", "data:text/html,<script>alert(1)</script>"],
    ["blob: on the origin", `blob:${ORIGIN}/7d2a`],
    ["a custom scheme", "ms-settings:privacy"],
    ["another custom scheme", "monize://open/accounts"],
    ["about:", "about:blank"],
    ["vbscript:", "vbscript:msgbox(1)"],
    ["credentials on the origin", "http://user:pw@127.0.0.1:3380/"],
    ["credentials elsewhere", "https://user@example.com/"],
    ["an unparsable URL", "not a url"],
    ["an empty URL", ""],
    ["an over-long URL", `https://example.com/${"a".repeat(MAX_URL_LENGTH)}`],
  ])("denies %s", (_name, url) => {
    expect(decideNavigation(url, ORIGIN).action).toBe("deny");
  });
});

describe("isPermissionAllowed", () => {
  it("allows only the clipboard write, and only on the app origin", () => {
    expect([...ALLOWED_PERMISSIONS]).toEqual(["clipboard-sanitized-write"]);
    expect(
      isPermissionAllowed("clipboard-sanitized-write", `${ORIGIN}/a`, ORIGIN),
    ).toBe(true);
    expect(
      isPermissionAllowed("clipboard-sanitized-write", ORIGIN, ORIGIN),
    ).toBe(true);
  });

  it.each([
    ["notifications", `${ORIGIN}/`],
    ["clipboard-read", `${ORIGIN}/`],
    ["media", `${ORIGIN}/`],
    ["geolocation", `${ORIGIN}/`],
    ["openExternal", `${ORIGIN}/`],
    ["clipboard-sanitized-write", "https://evil.example/"],
    ["clipboard-sanitized-write", "file:///C:/x.html"],
    ["clipboard-sanitized-write", ""],
  ])("denies %s for %s", (permission, url) => {
    expect(isPermissionAllowed(permission, url, ORIGIN)).toBe(false);
  });
});
