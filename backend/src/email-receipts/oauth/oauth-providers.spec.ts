import {
  DEFAULT_MICROSOFT_TENANT,
  isEmailReceiptOAuthProvider,
  isValidMicrosoftTenant,
  oauthProviderSpec,
} from "./oauth-providers";

describe("oauthProviderSpec (design 3a)", () => {
  it("is Google with its fixed endpoints, scopes, IMAP host and offline parameters", () => {
    const spec = oauthProviderSpec("google");
    expect(spec).toMatchObject({
      id: "google",
      authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenUrl: "https://oauth2.googleapis.com/token",
      scopes: ["https://mail.google.com/", "openid", "email"],
      authorizeParams: { access_type: "offline", prompt: "consent" },
      scopeOnRefresh: false,
      imap: { host: "imap.gmail.com", port: 993, security: "tls" },
    });
  });

  it("is Microsoft with the common tenant by default", () => {
    const spec = oauthProviderSpec("microsoft");
    expect(DEFAULT_MICROSOFT_TENANT).toBe("common");
    expect(spec).toMatchObject({
      id: "microsoft",
      authorizeUrl:
        "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
      tokenUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
      scopes: [
        "https://outlook.office.com/IMAP.AccessAsUser.All",
        "offline_access",
        "openid",
        "email",
      ],
      authorizeParams: { prompt: "select_account" },
      scopeOnRefresh: true,
      imap: { host: "outlook.office365.com", port: 993, security: "tls" },
    });
  });

  it("puts a valid tenant in both Microsoft URLs", () => {
    const spec = oauthProviderSpec("microsoft", "contoso.example-corp.com");
    expect(spec.authorizeUrl).toContain("/contoso.example-corp.com/oauth2");
    expect(spec.tokenUrl).toContain("/contoso.example-corp.com/oauth2");
  });

  it("refuses a tenant that could rewrite the URL path", () => {
    for (const tenant of [
      "",
      ".",
      "..",
      "../evil",
      "a/b",
      "a?b=c",
      "a#b",
      "a b",
      "-lead",
      "a".repeat(101),
      "tenant@host",
      "ten\u0000ant",
    ]) {
      expect(isValidMicrosoftTenant(tenant)).toBe(false);
      expect(() => oauthProviderSpec("microsoft", tenant)).toThrow(/tenant/);
    }
  });

  it("accepts the documented tenant forms", () => {
    for (const tenant of [
      "common",
      "organizations",
      "consumers",
      "0a1b2c3d-1111-2222-3333-444455556666",
      "a".repeat(100),
    ]) {
      expect(isValidMicrosoftTenant(tenant)).toBe(true);
    }
  });

  it("uses HTTPS endpoints and a TLS IMAP host for every provider", () => {
    for (const id of ["google", "microsoft"] as const) {
      const spec = oauthProviderSpec(id);
      expect(spec.authorizeUrl.startsWith("https://")).toBe(true);
      expect(spec.tokenUrl.startsWith("https://")).toBe(true);
      expect(spec.imap.security).toBe("tls");
    }
  });

  it("recognises exactly the two providers", () => {
    expect(isEmailReceiptOAuthProvider("google")).toBe(true);
    expect(isEmailReceiptOAuthProvider("microsoft")).toBe(true);
    for (const value of ["GOOGLE", "yahoo", "", null, undefined, 1, {}]) {
      expect(isEmailReceiptOAuthProvider(value)).toBe(false);
    }
  });
});
