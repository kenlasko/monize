import { OAuthReconnectRequiredError } from "../oauth/oauth-errors";
import {
  describeMailboxFailure,
  mailboxSecrets,
  oauthMailboxSecrets,
} from "./mailbox-failure.util";

describe("describeMailboxFailure (INV-RECEIPT-005)", () => {
  const PASSWORD = "hunter2-very-secret";

  it("never contains the password, however the error quotes it", () => {
    const error = Object.assign(
      new Error(`Command failed: LOGIN user ${PASSWORD}`),
      {
        authenticationFailed: true,
        responseText: `A1 NO invalid credentials for ${PASSWORD}`,
        cause: new Error(`inner ${PASSWORD}`),
      },
    );

    const line = describeMailboxFailure(
      error,
      mailboxSecrets("user", PASSWORD),
    );

    expect(line).not.toContain(PASSWORD);
    expect(line).toContain("authentication failed");
    expect(line).toContain("***");
  });

  it("removes the SASL PLAIN blob a server might echo", () => {
    const blob = Buffer.from(`\u0000user\u0000${PASSWORD}`).toString("base64");
    const line = describeMailboxFailure(
      new Error(`AUTHENTICATE PLAIN ${blob}`),
      mailboxSecrets("user", PASSWORD),
    );

    expect(line).not.toContain(blob);
    expect(line).not.toContain(PASSWORD);
  });

  it("is at most 300 characters and one line", () => {
    const line = describeMailboxFailure(
      new Error(`first line\n${"very long ".repeat(200)}\u0000end`),
    );

    expect(line.length).toBeLessThanOrEqual(300);
    for (const dropped of ["\n", "\r", "\u0000"]) {
      expect(line.includes(dropped)).toBe(false);
    }
  });

  it("names the socket-level cause and bounds the server's own text", () => {
    const error = Object.assign(new Error("Command failed"), {
      code: "ECONNREFUSED",
      serverResponseCode: "AUTHENTICATIONFAILED",
      responseText: "x".repeat(500),
    });

    const line = describeMailboxFailure(error);

    expect(line).toContain("code=ECONNREFUSED");
    expect(line).toContain("server code AUTHENTICATIONFAILED");
    expect(line.length).toBeLessThanOrEqual(300);
  });

  it("explains a refused private address in words", () => {
    const refused = Object.assign(new Error("Refusing a connection"), {
      code: "AI_EGRESS_REFUSED",
    });

    expect(describeMailboxFailure(refused)).toContain(
      "the host resolves to a private address",
    );
  });

  it("answers for a thrown non-error", () => {
    expect(describeMailboxFailure("boom")).toContain("boom");
    expect(describeMailboxFailure(undefined)).toBe("unknown error");
  });

  it("does not mask text when there is no secret, and ignores an empty one", () => {
    const line = describeMailboxFailure(new Error("plain failure"), [""]);
    expect(line).toBe("plain failure");
    expect(mailboxSecrets("user", "")).toEqual([
      Buffer.from("\u0000user\u0000").toString("base64"),
    ]);
  });
});

describe("describeMailboxFailure for an OAuth2 mailbox (INV-RECEIPT-005)", () => {
  const USER = "receipts@example.com";
  const ACCESS = "ya29.access-token-SECRET";
  const REFRESH = "1//refresh-token-SECRET";
  const ENDPOINT = { host: "imap.gmail.com", port: 993 };
  const xoauth2 = (token: string) =>
    Buffer.from(
      `user=${USER}\u0001auth=Bearer ${token}\u0001\u0001`,
      "utf8",
    ).toString("base64");
  const oauthbearer = (token: string) =>
    Buffer.from(
      `n,a=${USER},\u0001host=${ENDPOINT.host}\u0001port=${ENDPOINT.port}\u0001auth=Bearer ${token}\u0001\u0001`,
      "utf8",
    ).toString("base64");

  it("lists every token and the SASL strings built from each", () => {
    const secrets = oauthMailboxSecrets(USER, [REFRESH, ACCESS], ENDPOINT);
    for (const token of [REFRESH, ACCESS]) {
      expect(secrets).toEqual(
        expect.arrayContaining([token, xoauth2(token), oauthbearer(token)]),
      );
    }
  });

  it("skips an empty token", () => {
    expect(oauthMailboxSecrets(USER, ["", ACCESS], ENDPOINT)).toHaveLength(3);
  });

  it("never contains a token or an XOAUTH2 or OAUTHBEARER string, however the error quotes them", () => {
    const error = Object.assign(
      new Error(
        `AUTHENTICATE XOAUTH2 ${xoauth2(ACCESS)} / ${oauthbearer(ACCESS)} / ${ACCESS} / ${REFRESH}`,
      ),
      {
        authenticationFailed: true,
        responseText: `NO ${ACCESS}`,
        cause: new Error(`inner ${xoauth2(REFRESH)}`),
      },
    );

    const line = describeMailboxFailure(
      error,
      oauthMailboxSecrets(USER, [REFRESH, ACCESS], ENDPOINT),
    );

    for (const secret of [
      ACCESS,
      REFRESH,
      xoauth2(ACCESS),
      oauthbearer(ACCESS),
      xoauth2(REFRESH),
    ]) {
      expect(line).not.toContain(secret);
    }
    expect(line).toContain("***");
  });

  it("passes the reconnect sentence through as it is, without a class name", () => {
    const line = describeMailboxFailure(
      new OAuthReconnectRequiredError("Connect the mailbox again."),
    );
    expect(line).toBe("Connect the mailbox again.");
  });
});
