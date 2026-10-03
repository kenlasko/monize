import { BadRequestException } from "@nestjs/common";
import { publicOnlyLookup } from "../../ai/providers/provider-egress";
import { parsePrivateHostAllowlist } from "../../ai/validators/private-base-url-allowlist";
import * as safeUrl from "../../ai/validators/safe-url.validator";
import {
  assertMailboxHostAllowed,
  assertMailboxHostLiteralAllowed,
  emailReceiptsPrivateHostAllowlist,
  isPrivateIpLiteral,
  mailboxEgressLookup,
  resolveMailboxHostPolicy,
} from "./mailbox-host-policy";

const allowlist = parsePrivateHostAllowlist("mail.lan:993,10.0.0.5,[fd00::5]");

describe("resolveMailboxHostPolicy", () => {
  it("lets an admin reach any address", () => {
    expect(
      resolveMailboxHostPolicy({
        host: "10.1.1.1",
        port: 993,
        ownerIsAdmin: true,
        allowlist: { entries: [], invalid: [] },
      }),
    ).toEqual({ allowPrivate: true, reason: "admin" });
  });

  it("lets anyone else reach a host the operator allowlisted, on the listed port only", () => {
    const ok = resolveMailboxHostPolicy({
      host: "MAIL.LAN",
      port: 993,
      ownerIsAdmin: false,
      allowlist,
    });
    const wrongPort = resolveMailboxHostPolicy({
      host: "mail.lan",
      port: 143,
      ownerIsAdmin: false,
      allowlist,
    });
    const anyPort = resolveMailboxHostPolicy({
      host: "10.0.0.5",
      port: 143,
      ownerIsAdmin: false,
      allowlist,
    });
    const v6 = resolveMailboxHostPolicy({
      host: "fd00::5",
      port: 993,
      ownerIsAdmin: false,
      allowlist,
    });

    expect(ok).toEqual({ allowPrivate: true, reason: "allowlisted" });
    expect(wrongPort).toEqual({ allowPrivate: false, reason: "public-only" });
    expect(anyPort.allowPrivate).toBe(true);
    expect(v6.allowPrivate).toBe(true);
  });

  it("is public-only for everyone else", () => {
    expect(
      resolveMailboxHostPolicy({
        host: "imap.example.com",
        port: 993,
        ownerIsAdmin: false,
        allowlist,
      }),
    ).toEqual({ allowPrivate: false, reason: "public-only" });
  });

  it("reads its own variable, never the AI one", () => {
    const before = {
      ai: process.env.AI_PRIVATE_BASE_URL_ALLOWLIST,
      mail: process.env.EMAIL_RECEIPTS_PRIVATE_HOST_ALLOWLIST,
    };
    try {
      process.env.AI_PRIVATE_BASE_URL_ALLOWLIST = "ollama.lan";
      delete process.env.EMAIL_RECEIPTS_PRIVATE_HOST_ALLOWLIST;
      expect(emailReceiptsPrivateHostAllowlist().entries).toEqual([]);

      process.env.EMAIL_RECEIPTS_PRIVATE_HOST_ALLOWLIST = "mail.lan:993";
      expect(emailReceiptsPrivateHostAllowlist().entries).toEqual([
        { host: "mail.lan", port: 993 },
      ]);
    } finally {
      if (before.ai === undefined)
        delete process.env.AI_PRIVATE_BASE_URL_ALLOWLIST;
      else process.env.AI_PRIVATE_BASE_URL_ALLOWLIST = before.ai;
      if (before.mail === undefined)
        delete process.env.EMAIL_RECEIPTS_PRIVATE_HOST_ALLOWLIST;
      else process.env.EMAIL_RECEIPTS_PRIVATE_HOST_ALLOWLIST = before.mail;
    }
  });
});

describe("isPrivateIpLiteral", () => {
  it.each([
    "127.0.0.1",
    "10.0.0.1",
    "192.168.1.5",
    "172.16.0.1",
    "169.254.169.254",
    "0.0.0.0",
    "::1",
    "[::1]",
    "fd00::1",
    "fe80::1",
    "::ffff:127.0.0.1",
    "2130706433",
    "0x7f000001",
    "0177.0.0.1",
  ])("reads %s as a private address", (host) => {
    expect(isPrivateIpLiteral(host)).toBe(true);
  });

  it.each(["8.8.8.8", "imap.example.com", "2001:4860:4860::8888", "localhost"])(
    "does not call %s a private IP literal",
    (host) => {
      expect(isPrivateIpLiteral(host)).toBe(false);
    },
  );
});

describe("assertMailboxHostAllowed (save time)", () => {
  let safe: jest.SpyInstance;
  beforeEach(() => {
    safe = jest.spyOn(safeUrl, "validateUrlIsSafe");
  });
  afterEach(() => jest.restoreAllMocks());

  it("refuses a private IP literal for a non-admin without asking DNS", async () => {
    await expect(
      assertMailboxHostAllowed({
        host: "192.168.1.10",
        port: 993,
        ownerIsAdmin: false,
        allowlist,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(safe).not.toHaveBeenCalled();
  });

  it.each(["localhost", "metadata.google.internal", "printer.local"])(
    "refuses the blocked name %s for a non-admin",
    async (host) => {
      safe.mockResolvedValue(false);
      await expect(
        assertMailboxHostAllowed({
          host,
          port: 993,
          ownerIsAdmin: false,
          allowlist,
        }),
      ).rejects.toThrow(/private or local network address/);
    },
  );

  it("refuses a name that resolves to a private address", async () => {
    safe.mockResolvedValue(false);
    await expect(
      assertMailboxHostAllowed({
        host: "rebind.example.com",
        port: 993,
        ownerIsAdmin: false,
        allowlist,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(safe).toHaveBeenCalledWith("https://rebind.example.com:993/");
  });

  it("accepts a public name and answers the public-only policy", async () => {
    safe.mockResolvedValue(true);
    await expect(
      assertMailboxHostAllowed({
        host: "imap.example.com",
        port: 993,
        ownerIsAdmin: false,
        allowlist,
      }),
    ).resolves.toEqual({ allowPrivate: false, reason: "public-only" });
  });

  it("accepts any address for an admin, and an allowlisted host, without a DNS check", async () => {
    await expect(
      assertMailboxHostAllowed({
        host: "127.0.0.1",
        port: 143,
        ownerIsAdmin: true,
        allowlist,
      }),
    ).resolves.toMatchObject({ reason: "admin" });
    await expect(
      assertMailboxHostAllowed({
        host: "mail.lan",
        port: 993,
        ownerIsAdmin: false,
        allowlist,
      }),
    ).resolves.toMatchObject({ reason: "allowlisted" });
    expect(safe).not.toHaveBeenCalled();
  });
});

describe("connect-time helpers", () => {
  it("refuses a private IP literal unless the policy allows private", () => {
    expect(() =>
      assertMailboxHostLiteralAllowed("10.0.0.1", { allowPrivate: false }),
    ).toThrow(BadRequestException);
    expect(() =>
      assertMailboxHostLiteralAllowed("10.0.0.1", { allowPrivate: true }),
    ).not.toThrow();
    expect(() =>
      assertMailboxHostLiteralAllowed("imap.example.com", {
        allowPrivate: false,
      }),
    ).not.toThrow();
  });

  it("hands the socket the public-only lookup unless the policy allows private", () => {
    expect(mailboxEgressLookup({ allowPrivate: false })).toBe(publicOnlyLookup);
    expect(mailboxEgressLookup({ allowPrivate: true })).toBeUndefined();
  });
});
