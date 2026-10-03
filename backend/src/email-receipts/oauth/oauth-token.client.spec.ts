import { ConfigService } from "@nestjs/config";
import { OAuthTokenError } from "./oauth-errors";
import { EmailReceiptOAuthConfig } from "./oauth-config.service";
import { OAUTH_TOKEN_TIMEOUT_MS, OAuthTokenClient } from "./oauth-token.client";

const CLIENT_ID = "client-id-123";
const CLIENT_SECRET = "client-secret-SECRET";
const CODE = "auth-code-SECRET";
const VERIFIER = "verifier-SECRET-verifier-SECRET-verifier-SECRET";
const REFRESH = "refresh-token-SECRET";
const ACCESS = "access-token-SECRET";
const REDIRECT =
  "https://monize.example.com/settings/email-receipts/oauth-callback";

const ALL_SECRETS = [CLIENT_SECRET, CODE, VERIFIER, REFRESH, ACCESS];

function makeClient(env: Record<string, string> = {}) {
  const config = new EmailReceiptOAuthConfig(
    new ConfigService({
      PUBLIC_APP_URL: "https://monize.example.com",
      EMAIL_RECEIPTS_GOOGLE_CLIENT_ID: CLIENT_ID,
      EMAIL_RECEIPTS_GOOGLE_CLIENT_SECRET: CLIENT_SECRET,
      EMAIL_RECEIPTS_MICROSOFT_CLIENT_ID: CLIENT_ID,
      EMAIL_RECEIPTS_MICROSOFT_CLIENT_SECRET: CLIENT_SECRET,
      ...env,
    }),
  );
  return new OAuthTokenClient(config);
}

function respond(status: number, body: unknown) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return jest.spyOn(global, "fetch").mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    text: async () => text,
  } as Response);
}

const initOf = (fetchMock: jest.SpyInstance) =>
  fetchMock.mock.calls[0][1] as RequestInit & {
    headers: Record<string, string>;
  };

const sentBody = (fetchMock: jest.SpyInstance) =>
  new URLSearchParams(initOf(fetchMock).body as string);

async function failureOf(promise: Promise<unknown>): Promise<OAuthTokenError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(OAuthTokenError);
    return error as OAuthTokenError;
  }
  throw new Error("expected the request to fail");
}

describe("OAuthTokenClient", () => {
  afterEach(() => jest.restoreAllMocks());

  describe("exchangeCode", () => {
    it("posts the authorization-code grant as a form to the provider's token URL", async () => {
      const fetchMock = respond(200, {
        access_token: ACCESS,
        refresh_token: REFRESH,
        id_token: "a.b.c",
        token_type: "Bearer",
        expires_in: 3599,
      });

      const grant = await makeClient().exchangeCode(
        "google",
        CODE,
        VERIFIER,
        REDIRECT,
      );

      expect(grant).toEqual({
        accessToken: ACCESS,
        refreshToken: REFRESH,
        idToken: "a.b.c",
      });
      const url = fetchMock.mock.calls[0][0];
      const init = initOf(fetchMock);
      expect(url).toBe("https://oauth2.googleapis.com/token");
      expect(init.method).toBe("POST");
      expect(init.headers["Content-Type"]).toBe(
        "application/x-www-form-urlencoded",
      );
      expect(Object.fromEntries(sentBody(fetchMock))).toEqual({
        grant_type: "authorization_code",
        code: CODE,
        code_verifier: VERIFIER,
        redirect_uri: REDIRECT,
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
      });
    });

    it("never follows a redirect, carries no secret in a header, and is bounded by a timeout", async () => {
      const fetchMock = respond(200, { access_token: ACCESS });
      const timeout = jest.spyOn(AbortSignal, "timeout");

      await makeClient().exchangeCode("google", CODE, VERIFIER, REDIRECT);

      const init = initOf(fetchMock);
      expect(init.redirect).toBe("error");
      expect(timeout).toHaveBeenCalledWith(OAUTH_TOKEN_TIMEOUT_MS);
      expect(OAUTH_TOKEN_TIMEOUT_MS).toBe(15_000);
      expect(init.signal).toBeInstanceOf(AbortSignal);
      expect(JSON.stringify(init.headers)).not.toMatch(/SECRET/);
    });

    it("uses the Microsoft tenant's token URL", async () => {
      const fetchMock = respond(200, { access_token: ACCESS });
      await makeClient({
        EMAIL_RECEIPTS_MICROSOFT_TENANT: "organizations",
      }).exchangeCode("microsoft", CODE, VERIFIER, REDIRECT);
      expect(fetchMock.mock.calls[0][0]).toBe(
        "https://login.microsoftonline.com/organizations/oauth2/v2.0/token",
      );
    });

    it("has no refresh token or ID token when the response has none", async () => {
      respond(200, { access_token: ACCESS, token_type: "bearer" });
      await expect(
        makeClient().exchangeCode("google", CODE, VERIFIER, REDIRECT),
      ).resolves.toEqual({
        accessToken: ACCESS,
        refreshToken: null,
        idToken: null,
      });
    });
  });

  describe("refresh", () => {
    it("posts the refresh grant, without a scope for Google", async () => {
      const fetchMock = respond(200, { access_token: ACCESS });

      const grant = await makeClient().refresh("google", REFRESH);

      expect(grant).toEqual({
        accessToken: ACCESS,
        refreshToken: null,
        idToken: null,
      });
      expect(Object.fromEntries(sentBody(fetchMock))).toEqual({
        grant_type: "refresh_token",
        refresh_token: REFRESH,
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
      });
    });

    it("names the scope for Microsoft, which picks the resource by it", async () => {
      const fetchMock = respond(200, {
        access_token: ACCESS,
        refresh_token: "rotated-SECRET",
      });

      const grant = await makeClient().refresh("microsoft", REFRESH);

      expect(grant.refreshToken).toBe("rotated-SECRET");
      expect(sentBody(fetchMock).get("scope")).toBe(
        "https://outlook.office.com/IMAP.AccessAsUser.All offline_access openid email",
      );
    });
  });

  describe("failures", () => {
    it.each([
      [400, { error: "invalid_grant" }, "invalid_grant"],
      [400, { error: "interaction_required" }, "invalid_grant"],
      [400, { error: "consent_required" }, "invalid_grant"],
      [400, { error: "login_required" }, "invalid_grant"],
      [401, { error: "invalid_client" }, "invalid_client"],
      [400, { error: "unauthorized_client" }, "invalid_client"],
      [503, { error: "temporarily_unavailable" }, "unavailable"],
      [500, "<html>oops</html>", "unavailable"],
      [429, {}, "unavailable"],
      [400, { error: "invalid_request" }, "rejected"],
      [400, "not json", "rejected"],
      [400, { error: "Not A Code!" }, "rejected"],
    ])("maps HTTP %s %j to %s", async (status, body, code) => {
      respond(status, body);
      const error = await failureOf(makeClient().refresh("google", REFRESH));
      expect(error.code).toBe(code);
      expect(error.status).toBe(status);
    });

    it("rejects a success that is not a token response", async () => {
      for (const body of [
        {},
        { access_token: "" },
        "[]",
        "",
        { access_token: 5 },
      ]) {
        respond(200, body);
        const error = await failureOf(makeClient().refresh("google", REFRESH));
        expect(error.code).toBe("invalid_response");
      }
      respond(200, { access_token: ACCESS, token_type: "mac" });
      expect(
        (await failureOf(makeClient().refresh("google", REFRESH))).code,
      ).toBe("invalid_response");
    });

    it("reports a transport failure as unavailable, described without the request", async () => {
      jest.spyOn(global, "fetch").mockRejectedValue(
        Object.assign(new TypeError("fetch failed"), {
          cause: Object.assign(new Error("connect ECONNREFUSED 1.2.3.4:443"), {
            code: "ECONNREFUSED",
          }),
        }),
      );
      const error = await failureOf(
        makeClient().exchangeCode("google", CODE, VERIFIER, REDIRECT),
      );
      expect(error.code).toBe("unavailable");
      expect(error.status).toBeNull();
      expect(error.message).toContain("ECONNREFUSED");
    });

    it("reports a timeout as unavailable", async () => {
      jest.spyOn(global, "fetch").mockRejectedValue(
        Object.assign(new Error("The operation was aborted"), {
          name: "TimeoutError",
        }),
      );
      expect(
        (await failureOf(makeClient().refresh("google", REFRESH))).code,
      ).toBe("unavailable");
    });

    it("is invalid_client, without a request, when the operator removed the client", async () => {
      const fetchMock = jest.spyOn(global, "fetch");
      const client = new OAuthTokenClient(
        new EmailReceiptOAuthConfig(new ConfigService({})),
      );
      const error = await failureOf(client.refresh("google", REFRESH));
      expect(error.code).toBe("invalid_client");
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("never puts a code, token, secret or response body in an error message", async () => {
      const hostile = {
        error: "invalid_grant",
        error_description: `bad ${CODE} ${REFRESH} ${CLIENT_SECRET} ${VERIFIER}`,
        access_token: ACCESS,
      };
      // What a platform error could quote is what the request carried.
      const transport = (...quoted: string[]) =>
        Object.assign(new TypeError(`fetch failed for ${quoted.join(" ")}`), {
          cause: new Error(`inner ${quoted.join(" ")}`),
        });
      const errors: OAuthTokenError[] = [];

      for (const status of [400, 401, 500]) {
        respond(status, hostile);
        errors.push(
          await failureOf(
            makeClient().exchangeCode("google", CODE, VERIFIER, REDIRECT),
          ),
        );
        errors.push(await failureOf(makeClient().refresh("google", REFRESH)));
      }
      respond(200, { access_token: ACCESS, token_type: "mac" });
      errors.push(await failureOf(makeClient().refresh("google", REFRESH)));
      jest
        .spyOn(global, "fetch")
        .mockRejectedValue(transport(CLIENT_SECRET, REFRESH));
      errors.push(await failureOf(makeClient().refresh("google", REFRESH)));
      jest
        .spyOn(global, "fetch")
        .mockRejectedValue(transport(CLIENT_SECRET, CODE, VERIFIER));
      errors.push(
        await failureOf(
          makeClient().exchangeCode("google", CODE, VERIFIER, REDIRECT),
        ),
      );

      for (const error of errors) {
        for (const secret of ALL_SECRETS) {
          expect(error.message).not.toContain(secret);
          expect(String(error.stack)).not.toContain(secret);
        }
        expect(error.message).toMatch(/^OAuth token request failed \(/);
      }
    });
  });
});
