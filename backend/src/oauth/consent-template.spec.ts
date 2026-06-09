import { renderConsentPage } from "./consent-template";

describe("renderConsentPage", () => {
  it("renders the requested scopes as a read-only list", () => {
    const html = renderConsentPage({
      uid: "abc-123",
      clientName: "Claude Desktop",
      clientUri: "https://claude.ai",
      userEmail: "user@example.com",
      scopes: ["monize:read", "monize:write"],
      resource: "https://monize.example/api/v1/mcp",
    });

    expect(html).toContain("Authorize");
    expect(html).toContain("Claude Desktop");
    expect(html).toContain("https://claude.ai");
    expect(html).toContain("user@example.com");
    // Human-readable scope labels are shown...
    expect(html).toContain("Read your financial data");
    expect(html).toContain("Modify your financial data");
    // ...but there are no per-scope toggles (granular consent is not offered).
    expect(html).not.toContain("<input");
    expect(html).not.toContain('name="scopes"');
    expect(html).toContain('action="/api/v1/oauth-consent/abc-123/confirm"');
    expect(html).toContain('formaction="/api/v1/oauth-consent/abc-123/abort"');
  });

  it("escapes user-controlled inputs to prevent stored XSS", () => {
    const html = renderConsentPage({
      uid: "uid",
      clientName: "<script>alert(1)</script>",
      clientUri: 'javascript:alert(1)" autofocus="',
      userEmail: '"><img src=x onerror=alert(1)>',
      scopes: [],
      resource: 'res"><img>',
    });

    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).not.toContain('"><img');
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&quot;");
  });

  it("renders an empty scope list when no scopes are granted", () => {
    const html = renderConsentPage({
      uid: "uid",
      clientName: "App",
      clientUri: null,
      userEmail: "u@e",
      scopes: [],
      resource: "r",
    });

    // Form still renders so user can deny; scopes ul is empty.
    expect(html).toContain('class="scopes">');
    expect(html).not.toContain('value="monize:read"');
  });
});
