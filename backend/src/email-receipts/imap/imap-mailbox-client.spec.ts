import { BadRequestException } from "@nestjs/common";
import type { ImapFlowOptions } from "imapflow";
import { publicOnlyLookup } from "../../ai/providers/provider-egress";
import {
  buildImapFlowOptions,
  IMAP_CONNECTION_TIMEOUT_MS,
  IMAP_GREETING_TIMEOUT_MS,
  IMAP_SOCKET_TIMEOUT_MS,
  ImapFlowLike,
  ImapFlowMailboxClient,
  MailboxConnection,
} from "./imap-mailbox-client";

const conn = (over: Partial<MailboxConnection> = {}): MailboxConnection => ({
  host: "imap.example.com",
  port: 993,
  security: "tls",
  username: "receipts@example.com",
  auth: { kind: "password", password: "s3cret-password" },
  folder: "INBOX",
  allowPrivateHost: false,
  ...over,
});

describe("buildImapFlowOptions credentials (design 3a)", () => {
  it("logs in with the password for a password mailbox", () => {
    expect(buildImapFlowOptions(conn()).auth).toEqual({
      user: "receipts@example.com",
      pass: "s3cret-password",
    });
  });

  it("logs in with the access token (XOAUTH2) for an OAuth2 mailbox, and no password", () => {
    const options = buildImapFlowOptions(
      conn({ auth: { kind: "oauth2", accessToken: "access-token-abc" } }),
    );
    expect(options.auth).toEqual({
      user: "receipts@example.com",
      accessToken: "access-token-abc",
    });
    expect(options.auth).not.toHaveProperty("pass");
  });

  it("keeps TLS verification and the public-only lookup for an OAuth2 mailbox", () => {
    const options = buildImapFlowOptions(
      conn({ auth: { kind: "oauth2", accessToken: "t" } }),
    );
    expect(options.secure).toBe(true);
    expect(options.tls).toMatchObject({
      rejectUnauthorized: true,
      minVersion: "TLSv1.2",
      lookup: publicOnlyLookup,
    });
  });
});

describe("buildImapFlowOptions (INV-RECEIPT-001, INV-RECEIPT-004)", () => {
  it("uses implicit TLS for security=tls and never asks for a plaintext upgrade path", () => {
    const options = buildImapFlowOptions(conn());
    expect(options.secure).toBe(true);
    expect(options.doSTARTTLS).toBeUndefined();
  });

  it("requires the STARTTLS upgrade for security=starttls, so plaintext is never allowed", () => {
    const options = buildImapFlowOptions(
      conn({ security: "starttls", port: 143 }),
    );
    expect(options.secure).toBe(false);
    // `true` is "required": unset would let imapflow continue in cleartext when
    // the server does not offer STARTTLS, and `false` would disable it.
    expect(options.doSTARTTLS).toBe(true);
  });

  it("verifies the certificate and refuses TLS older than 1.2", () => {
    const { tls } = buildImapFlowOptions(conn());
    expect(tls).toMatchObject({
      rejectUnauthorized: true,
      minVersion: "TLSv1.2",
    });
  });

  it("passes the public-only lookup as the socket lookup unless the policy allows private", () => {
    expect(buildImapFlowOptions(conn()).tls?.lookup).toBe(publicOnlyLookup);
    expect(
      buildImapFlowOptions(conn({ allowPrivateHost: true })).tls?.lookup,
    ).toBeUndefined();
  });

  it("bounds the connection, the greeting and socket inactivity", () => {
    const options = buildImapFlowOptions(conn());
    expect(options.connectionTimeout).toBe(IMAP_CONNECTION_TIMEOUT_MS);
    expect(options.greetingTimeout).toBe(IMAP_GREETING_TIMEOUT_MS);
    expect(options.socketTimeout).toBe(IMAP_SOCKET_TIMEOUT_MS);
    expect(IMAP_CONNECTION_TIMEOUT_MS).toBe(30_000);
    expect(IMAP_GREETING_TIMEOUT_MS).toBe(15_000);
    expect(IMAP_SOCKET_TIMEOUT_MS).toBe(60_000);
  });

  it("turns the library's logging off, sets no proxy and starts no IDLE", () => {
    const options = buildImapFlowOptions(conn());
    expect(options.logger).toBe(false);
    expect(options.proxy).toBeUndefined();
    expect(options.disableAutoIdle).toBe(true);
    expect(options.logRaw).toBeUndefined();
  });

  it("bounds one literal by the message cap, so a server cannot exceed the size it reported", () => {
    const options = buildImapFlowOptions(conn(), {
      maxLiteralBytes: 5_000_000,
    });
    expect(options.maxLiteralSize).toBe(5_000_000);
    expect(options.maxResponseSize).toBeGreaterThan(5_000_000);
  });
});

/** A client whose connection is a fake, recording every call made on it. */
class FakeImap implements ImapFlowLike {
  calls: string[] = [];
  opened: { path: string; options?: { readOnly?: boolean } } | null = null;
  searches: Array<{ query: unknown; options: unknown }> = [];
  searchResult: number[] | false | undefined = [];
  messages = new Map<
    number,
    { size: number; source: Buffer; internalDate: Date }
  >();
  uidValidity = BigInt(77);
  exists = 12;
  connectError: Error | null = null;
  logoutError: Error | null = null;
  closed = false;
  errorListeners = 0;

  on(): this {
    this.errorListeners += 1;
    return this;
  }
  async connect(): Promise<void> {
    this.calls.push("connect");
    if (this.connectError) throw this.connectError;
  }
  async logout(): Promise<void> {
    this.calls.push("logout");
    if (this.logoutError) throw this.logoutError;
  }
  close(): void {
    this.calls.push("close");
    this.closed = true;
  }
  async mailboxOpen(path: string, options?: { readOnly?: boolean }) {
    this.calls.push("mailboxOpen");
    this.opened = { path, options };
    return { uidValidity: this.uidValidity, exists: this.exists };
  }
  async search(query: unknown, options: unknown) {
    this.calls.push("search");
    this.searches.push({ query, options });
    return this.searchResult;
  }
  async fetchAll(range: string) {
    this.calls.push(`fetchAll:${range}`);
    const uids = range.split(",").map(Number);
    return uids.flatMap((uid) => {
      const m = this.messages.get(uid);
      return m ? [{ uid, size: m.size, internalDate: m.internalDate }] : [];
    });
  }
  async fetchOne(range: string, query: { source?: boolean }) {
    this.calls.push(`fetchOne:${range}:${query.source ? "source" : "meta"}`);
    const m = this.messages.get(Number(range));
    return m
      ? {
          uid: Number(range),
          size: m.size,
          internalDate: m.internalDate,
          source: m.source,
        }
      : false;
  }
}

class TestableClient extends ImapFlowMailboxClient {
  lastOptions: ImapFlowOptions | null = null;
  constructor(private readonly fake: FakeImap) {
    super();
  }
  protected override createClient(options: ImapFlowOptions): ImapFlowLike {
    this.lastOptions = options;
    return this.fake;
  }
}

function setup() {
  const fake = new FakeImap();
  const client = new TestableClient(fake);
  return { fake, client };
}

const since = new Date("2026-09-01T00:00:00Z");
const limits = { sinceDate: since, maxMessages: 50, maxBytes: 1000 };
const msg = (size: number, body = "hello") => ({
  size,
  source: Buffer.from(body),
  internalDate: new Date("2026-09-20T10:00:00Z"),
});

describe("ImapFlowMailboxClient.testConnection", () => {
  it("opens the folder read-only and reports the message count and UIDVALIDITY", async () => {
    const { fake, client } = setup();
    fake.exists = 42;
    fake.uidValidity = BigInt("4294967295");

    const result = await client.testConnection(conn({ folder: "Receipts" }));

    expect(result).toEqual({ messages: 42, uidValidity: "4294967295" });
    expect(fake.opened).toEqual({
      path: "Receipts",
      options: { readOnly: true },
    });
    expect(fake.calls).toEqual(["connect", "mailboxOpen", "logout"]);
    expect(fake.errorListeners).toBe(1);
  });

  it("refuses a private IP literal before connecting, unless the policy allows private", async () => {
    const { fake, client } = setup();

    await expect(
      client.testConnection(conn({ host: "127.0.0.1" })),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      client.testConnection(conn({ host: "10.1.2.3" })),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      client.testConnection(conn({ host: "[::1]" })),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      client.testConnection(conn({ host: "2130706433" })),
    ).rejects.toBeInstanceOf(BadRequestException);
    // Nothing was connected to for any of them.
    expect(fake.calls).toEqual([]);

    await expect(
      client.testConnection(conn({ host: "10.1.2.3", allowPrivateHost: true })),
    ).resolves.toMatchObject({ uidValidity: "77" });
  });

  it("logs out after a failure, and closes the socket when even the logout fails", async () => {
    const { fake, client } = setup();
    fake.connectError = new Error("connect failed");
    fake.logoutError = new Error("not connected");

    await expect(client.testConnection(conn())).rejects.toThrow(
      "connect failed",
    );

    expect(fake.calls).toEqual(["connect", "logout", "close"]);
    expect(fake.closed).toBe(true);
  });
});

describe("ImapFlowMailboxClient.fetchSince", () => {
  it("reads from the date on a first sync, and fetches the body of each message", async () => {
    const { fake, client } = setup();
    fake.searchResult = [9, 3, 5];
    fake.messages.set(3, msg(100, "three"));
    fake.messages.set(5, msg(100, "five"));
    fake.messages.set(9, msg(100, "nine"));

    const result = await client.fetchSince(
      conn(),
      { uidValidity: null, lastUid: null },
      limits,
    );

    expect(fake.searches).toEqual([
      { query: { since }, options: { uid: true } },
    ]);
    expect(result.uidValidity).toBe("77");
    expect(result.messages.map((m) => [m.uid, m.source.toString()])).toEqual([
      ["3", "three"],
      ["5", "five"],
      ["9", "nine"],
    ]);
    expect(result.skipped).toEqual([]);
    expect(result.highestUid).toBe("9");
    expect(fake.opened?.options).toEqual({ readOnly: true });
  });

  it("reads above the stored UID and drops the last-message answer `n:*` gives when nothing is newer", async () => {
    const { fake, client } = setup();
    // Nothing newer than 40: IMAP answers `41:*` with the last message, UID 40.
    fake.searchResult = [40];
    fake.messages.set(40, msg(100));

    const result = await client.fetchSince(
      conn(),
      { uidValidity: "77", lastUid: "40" },
      limits,
    );

    expect(fake.searches[0].query).toEqual({ uid: "41:*" });
    expect(result.messages).toEqual([]);
    expect(result.highestUid).toBeNull();
    expect(fake.calls.some((c) => c.startsWith("fetchOne"))).toBe(false);
  });

  it("keeps UIDs above the cursor when the answer mixes old and new", async () => {
    const { fake, client } = setup();
    fake.searchResult = [40, 41, 44];
    fake.messages.set(41, msg(10));
    fake.messages.set(44, msg(10));

    const result = await client.fetchSince(
      conn(),
      { uidValidity: "77", lastUid: "40" },
      limits,
    );

    expect(result.messages.map((m) => m.uid)).toEqual(["41", "44"]);
    expect(result.highestUid).toBe("44");
  });

  it("does the UID arithmetic as a bigint, past 2^53", async () => {
    const { fake, client } = setup();
    fake.searchResult = [];

    await client.fetchSince(
      conn(),
      { uidValidity: "77", lastUid: "9007199254740993" },
      limits,
    );

    expect(fake.searches[0].query).toEqual({ uid: "9007199254740994:*" });
  });

  it("treats a changed UIDVALIDITY as a first sync, since every stored UID is void", async () => {
    const { fake, client } = setup();
    fake.searchResult = [1];
    fake.messages.set(1, msg(10));

    const result = await client.fetchSince(
      conn(),
      { uidValidity: "12", lastUid: "500" },
      limits,
    );

    expect(fake.searches[0].query).toEqual({ since });
    expect(result.uidValidity).toBe("77");
    expect(result.messages.map((m) => m.uid)).toEqual(["1"]);
  });

  it("treats an unreadable stored UID as a first sync", async () => {
    const { fake, client } = setup();
    fake.searchResult = [];

    await client.fetchSince(
      conn(),
      { uidValidity: "77", lastUid: "not-a-number" },
      limits,
    );

    expect(fake.searches[0].query).toEqual({ since });
  });

  it("skips a message above the size cap without downloading it, and still advances past it", async () => {
    const { fake, client } = setup();
    fake.searchResult = [1, 2];
    fake.messages.set(1, msg(5000, "huge"));
    fake.messages.set(2, msg(900, "small"));

    const result = await client.fetchSince(
      conn(),
      { uidValidity: null, lastUid: null },
      limits,
    );

    expect(result.skipped).toEqual([{ uid: "1", reason: "too_large" }]);
    expect(result.messages.map((m) => m.uid)).toEqual(["2"]);
    expect(result.highestUid).toBe("2");
    // The big one's body was never requested.
    expect(fake.calls).not.toContain("fetchOne:1:source");
    expect(fake.calls).toContain("fetchOne:2:source");
  });

  it("takes at most maxMessages of the lowest UIDs and leaves the rest for the next call", async () => {
    const { fake, client } = setup();
    fake.searchResult = [8, 2, 6, 4, 10];
    for (const uid of [2, 4, 6, 8, 10]) fake.messages.set(uid, msg(10));

    const result = await client.fetchSince(
      conn(),
      { uidValidity: null, lastUid: null },
      { ...limits, maxMessages: 3 },
    );

    expect(result.messages.map((m) => m.uid)).toEqual(["2", "4", "6"]);
    expect(result.highestUid).toBe("6");
  });

  it("moves the cursor past a message deleted between the search and the fetch", async () => {
    const { fake, client } = setup();
    fake.searchResult = [1, 2];
    fake.messages.set(1, msg(10));

    const result = await client.fetchSince(
      conn(),
      { uidValidity: null, lastUid: null },
      limits,
    );

    expect(result.messages.map((m) => m.uid)).toEqual(["1"]);
    expect(result.highestUid).toBe("2");
  });

  it("answers an empty result for a search that finds nothing or returns false", async () => {
    const { fake, client } = setup();
    fake.searchResult = false;

    const result = await client.fetchSince(
      conn(),
      { uidValidity: null, lastUid: null },
      limits,
    );

    expect(result).toEqual({
      uidValidity: "77",
      messages: [],
      skipped: [],
      highestUid: null,
    });
    expect(fake.calls).toEqual(["connect", "mailboxOpen", "search", "logout"]);
  });

  it("takes the size budget into the connection's literal bound", async () => {
    const { client } = setup();

    await client.fetchSince(
      conn(),
      { uidValidity: null, lastUid: null },
      { ...limits, maxBytes: 3_000_000 },
    );

    expect(client.lastOptions?.maxLiteralSize).toBeGreaterThanOrEqual(
      3_000_000,
    );
  });

  it("logs out after a failure in the middle of a fetch", async () => {
    const { fake, client } = setup();
    fake.searchResult = [1];
    fake.messages.set(1, msg(10));
    fake.fetchOne = async () => {
      throw new Error("server hung up");
    };

    await expect(
      client.fetchSince(conn(), { uidValidity: null, lastUid: null }, limits),
    ).rejects.toThrow("server hung up");

    expect(fake.calls[fake.calls.length - 1]).toBe("logout");
  });
});
