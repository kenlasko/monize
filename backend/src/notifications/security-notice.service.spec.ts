import { Logger } from "@nestjs/common";
import { NotificationType } from "../notification-center/entities/notification.entity";
import { NotificationDispatchService } from "./notification-dispatch.service";
import { SecurityNoticeService } from "./security-notice.service";

describe("SecurityNoticeService", () => {
  let notify: jest.Mock;
  let service: SecurityNoticeService;

  beforeEach(() => {
    notify = jest.fn().mockResolvedValue(null);
    service = new SecurityNoticeService({
      notify,
    } as unknown as NotificationDispatchService);
  });

  it("keys an OAuth notice on the grant and stores trimmed client facts", async () => {
    await service.oauthClientAuthorized("u1", {
      grantId: "g1",
      clientId: "c1",
      clientName: "  Claude Desktop  ",
    });
    expect(notify).toHaveBeenCalledWith(
      "u1",
      expect.objectContaining({
        type: NotificationType.OAUTH_CLIENT_AUTHORIZED,
        dedupeKey: "oauth:grant:g1",
        data: { clientId: "c1", clientName: "Claude Desktop" },
        target: "/settings",
      }),
      { fanOut: "detached" },
    );
  });

  it("bounds the client name and falls back to the client id when empty", async () => {
    await service.oauthClientAuthorized("u1", {
      grantId: "g1",
      clientId: "c1",
      clientName: "x".repeat(300),
    });
    await service.oauthClientAuthorized("u1", {
      grantId: "g2",
      clientId: "c2",
      clientName: "   ",
    });
    expect(notify.mock.calls[0][1].data.clientName).toHaveLength(100);
    expect(notify.mock.calls[1][1].data.clientName).toBe("c2");
    expect(notify.mock.calls[1][1].title).toContain("c2");
  });

  it("strips control and bidi characters from the client name", async () => {
    await service.oauthClientAuthorized("u1", {
      grantId: "g1",
      clientId: "c1",
      clientName: "Good\u202Etpircs\nApp\u2066x\u200F",
    });
    await service.oauthClientAuthorized("u1", {
      grantId: "g2",
      clientId: "c2",
      clientName: "\u202E\u2069\n",
    });
    const first = notify.mock.calls[0][1];
    expect(first.data.clientName).toBe("Good tpircs App x");
    expect(first.title).not.toMatch(
      /[\u202A-\u202E\u2066-\u2069\u200E\u200F\n]/,
    );
    expect(notify.mock.calls[1][1].data.clientName).toBe("c2");
  });

  it("does not split a surrogate pair at the length bound", async () => {
    await service.oauthClientAuthorized("u1", {
      grantId: "g1",
      clientId: "c1",
      clientName: `${"a".repeat(99)}\u{1F600}tail`,
    });
    const name: string = notify.mock.calls[0][1].data.clientName;
    expect(name).toBe(`${"a".repeat(99)}\u{1F600}`);
    expect(JSON.stringify(name)).not.toMatch(/\\ud83d"/);
  });

  it("strips line and paragraph separators from the client name", async () => {
    await service.oauthClientAuthorized("u1", {
      grantId: "g1",
      clientId: "c1",
      clientName: "Claude\u2028(official)\u2029x",
    });
    expect(notify.mock.calls[0][1].data.clientName).toBe("Claude (official) x");
  });

  it("keys a relay notice on the credential without storing its id", async () => {
    await service.relayCredentialFirstUse("u1", "pat:secret-id-123");
    const [, input, options] = notify.mock.calls[0];
    expect(input.type).toBe(NotificationType.RELAY_CREDENTIAL_FIRST_USE);
    expect(input.dedupeKey).toBe("relay:cred:pat:secret-id-123");
    expect(input.data).toEqual({ credentialKind: "pat" });
    expect(
      JSON.stringify([input.data, input.title, input.message]),
    ).not.toContain("secret-id-123");
    expect(options).toEqual({ fanOut: "detached" });
  });

  it("swallows a rejected notify and logs it", async () => {
    const error = jest
      .spyOn(Logger.prototype, "error")
      .mockImplementation(() => undefined);
    notify.mockRejectedValue(new Error("db down"));
    await expect(
      service.relayCredentialFirstUse("u1", "oauth:c1"),
    ).resolves.toBeUndefined();
    await expect(
      service.oauthClientAuthorized("u1", {
        grantId: "g",
        clientId: "c",
        clientName: "n",
      }),
    ).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledTimes(2);
    error.mockRestore();
  });
});
