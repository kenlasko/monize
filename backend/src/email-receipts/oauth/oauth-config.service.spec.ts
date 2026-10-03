import { Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  EmailReceiptOAuthConfig,
  OAUTH_CALLBACK_PATH,
} from "./oauth-config.service";

const config = (env: Record<string, string>) =>
  new EmailReceiptOAuthConfig(new ConfigService(env));

describe("EmailReceiptOAuthConfig", () => {
  afterEach(() => jest.restoreAllMocks());

  it("offers no provider when nothing is configured", () => {
    expect(config({}).providers()).toEqual({
      google: false,
      microsoft: false,
      redirectUri: `http://localhost:3000${OAUTH_CALLBACK_PATH}`,
    });
  });

  it("offers a provider only when BOTH its client id and secret are set", () => {
    expect(
      config({ EMAIL_RECEIPTS_GOOGLE_CLIENT_ID: "id" }).providers(),
    ).toMatchObject({ google: false });
    expect(
      config({ EMAIL_RECEIPTS_GOOGLE_CLIENT_SECRET: "s" }).providers(),
    ).toMatchObject({ google: false });
    expect(
      config({
        EMAIL_RECEIPTS_GOOGLE_CLIENT_ID: "id",
        EMAIL_RECEIPTS_GOOGLE_CLIENT_SECRET: "  ",
      }).providers(),
    ).toMatchObject({ google: false });
    expect(
      config({
        EMAIL_RECEIPTS_GOOGLE_CLIENT_ID: "id",
        EMAIL_RECEIPTS_GOOGLE_CLIENT_SECRET: "s",
        EMAIL_RECEIPTS_MICROSOFT_CLIENT_ID: "mid",
        EMAIL_RECEIPTS_MICROSOFT_CLIENT_SECRET: "ms",
      }).providers(),
    ).toMatchObject({ google: true, microsoft: true });
  });

  it("builds the redirect URI from PUBLIC_APP_URL without a trailing slash", () => {
    expect(
      config({ PUBLIC_APP_URL: "https://monize.example.com///" }).redirectUri(),
    ).toBe("https://monize.example.com/settings/email-receipts/oauth-callback");
    expect(OAUTH_CALLBACK_PATH).toBe("/settings/email-receipts/oauth-callback");
  });

  it("returns the trimmed client credentials", () => {
    const c = config({
      EMAIL_RECEIPTS_MICROSOFT_CLIENT_ID: " mid ",
      EMAIL_RECEIPTS_MICROSOFT_CLIENT_SECRET: " msecret ",
    });
    expect(c.client("microsoft")).toEqual({
      clientId: "mid",
      clientSecret: "msecret",
    });
    expect(c.client("google")).toBeNull();
  });

  it("uses the configured Microsoft tenant in the endpoints", () => {
    const c = config({ EMAIL_RECEIPTS_MICROSOFT_TENANT: "organizations" });
    expect(c.spec("microsoft")?.tokenUrl).toContain("/organizations/");
    expect(config({}).spec("microsoft")?.tokenUrl).toContain("/common/");
  });

  it("makes Microsoft unavailable for an invalid tenant, and says so once", () => {
    const warn = jest.spyOn(Logger.prototype, "warn").mockImplementation();
    const c = config({
      EMAIL_RECEIPTS_MICROSOFT_CLIENT_ID: "mid",
      EMAIL_RECEIPTS_MICROSOFT_CLIENT_SECRET: "ms",
      EMAIL_RECEIPTS_MICROSOFT_TENANT: "../evil",
    });

    expect(c.spec("microsoft")).toBeNull();
    expect(c.client("microsoft")).toBeNull();
    expect(c.providers().microsoft).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).not.toContain("evil");
  });

  it("always has a Google spec", () => {
    expect(config({}).spec("google")?.id).toBe("google");
  });
});
