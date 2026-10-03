import { Injectable } from "@nestjs/common";
import { ImapFlow } from "imapflow";
import type { ImapFlowOptions } from "imapflow";
import {
  assertMailboxHostLiteralAllowed,
  mailboxEgressLookup,
} from "./mailbox-host-policy";

/**
 * The IMAP side of email receipts (docs/future-plans/email-receipts.md sections
 * 3 and 7). This is the ONLY file that imports `imapflow`
 * (`imap-source-scan.spec.ts` holds that), and it exposes exactly two calls:
 * test a connection, and read what arrived since a cursor.
 *
 * INV-RECEIPT-001, the mailbox is read and never written:
 * - the folder is opened with `readOnly: true` (EXAMINE), so the server itself
 *   refuses any change to it;
 * - a message is fetched with `source: true`, which imapflow sends as
 *   `BODY.PEEK[]` (dist/cjs/commands/fetch.js), so nothing is marked \Seen;
 * - this module calls no method of the client that changes a flag, a folder or a
 *   message, and `imap-source-scan.spec.ts` fails if one is ever written here.
 *
 * INV-RECEIPT-004, the connection reaches a public address unless the policy
 * says otherwise: the socket's DNS `lookup` is the public-only one (refusing a
 * private answer where the connection is made, so there is no rebinding
 * window), and an IP literal, which skips the lookup, is refused first.
 *
 * TLS is required: `tls` is implicit TLS, `starttls` is an upgrade that is
 * REQUIRED (`doSTARTTLS: true`, so a server that does not offer it fails the
 * connection rather than continuing in plaintext) and runs before the login.
 * The certificate is verified; there is no switch to accept any certificate.
 */

/**
 * How the login is made: the mailbox's password (SASL PLAIN or LOGIN), or an
 * OAuth2 access token (SASL XOAUTH2 or OAUTHBEARER, chosen by imapflow from what
 * the server offers). Either is a live secret here: never log this.
 */
export type MailboxAuth =
  | { readonly kind: "password"; readonly password: string }
  | { readonly kind: "oauth2"; readonly accessToken: string };

/** Where and how to connect. The credential is plaintext here: never log this. */
export interface MailboxConnection {
  readonly host: string;
  readonly port: number;
  readonly security: "tls" | "starttls";
  readonly username: string;
  readonly auth: MailboxAuth;
  readonly folder: string;
  /**
   * Whether a private, loopback or link-local address may be connected to: true
   * for an admin's mailbox or an operator-allowlisted host
   * (`resolveMailboxHostPolicy`). False makes the connection public-only, which
   * is always the case for an OAuth2 mailbox (its host is the provider's own).
   */
  readonly allowPrivateHost: boolean;
}

/** The poll's cursor as stored: bigint columns, carried as decimal strings. */
export interface MailboxCursor {
  readonly uidValidity: string | null;
  readonly lastUid: string | null;
}

export interface FetchSinceOptions {
  /** A first sync (no cursor, or a changed UIDVALIDITY) reads from this date. */
  readonly sinceDate: Date;
  /** At most this many messages, lowest UIDs first, per call. */
  readonly maxMessages: number;
  /** A message larger than this is skipped, never downloaded. */
  readonly maxBytes: number;
}

export interface FetchedMessage {
  readonly uid: string;
  readonly source: Buffer;
  readonly internalDate: Date;
  readonly size: number;
}

export interface SkippedMessage {
  readonly uid: string;
  readonly reason: "too_large";
}

export interface FetchSinceResult {
  /** The folder's current UIDVALIDITY, to store with the cursor. */
  readonly uidValidity: string;
  readonly messages: FetchedMessage[];
  readonly skipped: SkippedMessage[];
  /**
   * The highest UID this call examined (fetched, skipped or found gone), which
   * is where the cursor may advance to once the messages are stored; null when
   * nothing new was found and the cursor stays where it is.
   */
  readonly highestUid: string | null;
}

export interface TestConnectionResult {
  readonly messages: number;
  readonly uidValidity: string;
}

/**
 * The port services depend on, an abstract class so it is also the injection
 * token. A unit test supplies a fake that implements it.
 */
export abstract class ImapMailboxClient {
  abstract testConnection(
    conn: MailboxConnection,
  ): Promise<TestConnectionResult>;

  abstract fetchSince(
    conn: MailboxConnection,
    cursor: MailboxCursor,
    opts: FetchSinceOptions,
  ): Promise<FetchSinceResult>;
}

/** Time budgets (ms): connect, greeting, and socket inactivity. */
export const IMAP_CONNECTION_TIMEOUT_MS = 30_000;
export const IMAP_GREETING_TIMEOUT_MS = 15_000;
export const IMAP_SOCKET_TIMEOUT_MS = 60_000;

/** Headroom over the per-message cap for protocol framing around a literal. */
const LITERAL_SLACK_BYTES = 64 * 1024;
/** What a test connection and a size probe may receive in one literal. */
const SMALL_LITERAL_BYTES = 1024 * 1024;
/** The longest response line accepted (a SEARCH answer lists every UID). */
const MAX_LINE_BYTES = 16 * 1024 * 1024;
/** UIDs per `FETCH` command, so one command line never grows with the batch. */
const UID_SET_CHUNK = 200;

/**
 * The imapflow options for a connection. Pure, so a test asserts what is sent
 * without a socket. `maxLiteralSize` bounds memory against a server that
 * announces more than the size it reported.
 */
export function buildImapFlowOptions(
  conn: MailboxConnection,
  limits: { maxLiteralBytes: number } = {
    maxLiteralBytes: SMALL_LITERAL_BYTES,
  },
): ImapFlowOptions {
  const lookup = mailboxEgressLookup({ allowPrivate: conn.allowPrivateHost });
  const maxLiteralSize = Math.max(
    Math.trunc(limits.maxLiteralBytes),
    SMALL_LITERAL_BYTES,
  );
  return {
    host: conn.host,
    port: conn.port,
    // `tls`: implicit TLS. `starttls`: a plain connect that MUST upgrade before
    // the login (`doSTARTTLS: true` makes a server without STARTTLS a failure;
    // left unset imapflow would continue in cleartext).
    secure: conn.security === "tls",
    ...(conn.security === "starttls" ? { doSTARTTLS: true } : {}),
    auth:
      conn.auth.kind === "oauth2"
        ? { user: conn.username, accessToken: conn.auth.accessToken }
        : { user: conn.username, pass: conn.auth.password },
    // Merged into the net/tls connect options by imapflow, for the first
    // connection and for the STARTTLS upgrade alike.
    tls: {
      ...(lookup ? { lookup } : {}),
      rejectUnauthorized: true,
      minVersion: "TLSv1.2",
    },
    // No IDLE: a poll is one short session, never a long-lived one.
    disableAutoIdle: true,
    // Off: the library's log lines are not ours to carry, and a login frame is
    // the one thing a log must never hold.
    logger: false,
    connectionTimeout: IMAP_CONNECTION_TIMEOUT_MS,
    greetingTimeout: IMAP_GREETING_TIMEOUT_MS,
    socketTimeout: IMAP_SOCKET_TIMEOUT_MS,
    maxLiteralSize,
    maxResponseSize: maxLiteralSize + SMALL_LITERAL_BYTES,
    maxLineLength: MAX_LINE_BYTES,
  };
}

/** The decimal string of a bigint-ish UID, or null when it is not one. */
function parseUid(value: string | null): bigint | null {
  if (value === null || !/^\d{1,20}$/.test(value)) return null;
  return BigInt(value);
}

/** The parts of an imapflow client this module uses, so a test can stand in. */
export interface ImapFlowLike {
  connect(): Promise<void>;
  logout(): Promise<void>;
  close(): void;
  on(event: "error", listener: (error: Error) => void): unknown;
  mailboxOpen(
    path: string,
    options?: { readOnly?: boolean },
  ): Promise<{ uidValidity: bigint; exists: number }>;
  search(
    query: { since?: Date; uid?: string },
    options?: { uid?: boolean },
  ): Promise<number[] | false | undefined>;
  fetchAll(
    range: string,
    query: { uid?: boolean; size?: boolean; internalDate?: boolean },
    options?: { uid?: boolean },
  ): Promise<ReadFetchedMessage[]>;
  fetchOne(
    range: string,
    query: {
      uid?: boolean;
      size?: boolean;
      internalDate?: boolean;
      source?: boolean;
    },
    options?: { uid?: boolean },
  ): Promise<ReadFetchedMessage | false | undefined>;
}

interface ReadFetchedMessage {
  uid: number;
  size?: number | undefined;
  source?: Buffer | undefined;
  internalDate?: Date | string | undefined;
}

@Injectable()
export class ImapFlowMailboxClient extends ImapMailboxClient {
  /** Overridden by a spec to hand back a fake instead of a live connection. */
  protected createClient(options: ImapFlowOptions): ImapFlowLike {
    return new ImapFlow(options) as unknown as ImapFlowLike;
  }

  async testConnection(conn: MailboxConnection): Promise<TestConnectionResult> {
    return this.withSession(conn, SMALL_LITERAL_BYTES, async (client) => {
      const mailbox = await client.mailboxOpen(conn.folder, { readOnly: true });
      return {
        messages: mailbox.exists,
        uidValidity: String(mailbox.uidValidity),
      };
    });
  }

  async fetchSince(
    conn: MailboxConnection,
    cursor: MailboxCursor,
    opts: FetchSinceOptions,
  ): Promise<FetchSinceResult> {
    const maxMessages = Math.max(Math.trunc(opts.maxMessages), 0);
    const maxBytes = Math.max(Math.trunc(opts.maxBytes), 0);
    return this.withSession(
      conn,
      maxBytes + LITERAL_SLACK_BYTES,
      async (client) => {
        const mailbox = await client.mailboxOpen(conn.folder, {
          readOnly: true,
        });
        const uidValidity = String(mailbox.uidValidity);
        const uids = await this.newUids(client, cursor, uidValidity, opts);
        const batch = uids.slice(0, maxMessages);
        if (batch.length === 0) {
          return { uidValidity, messages: [], skipped: [], highestUid: null };
        }

        const sizes = await this.readSizes(client, batch);
        const messages: FetchedMessage[] = [];
        const skipped: SkippedMessage[] = [];
        for (const uid of batch) {
          const info = sizes.get(uid);
          // Gone between the search and now (deleted by the user): nothing to read.
          if (!info) continue;
          if (info.size > maxBytes) {
            skipped.push({ uid: String(uid), reason: "too_large" });
            continue;
          }
          // `source: true` is BODY.PEEK[]: reading it sets no flag.
          const fetched = await client.fetchOne(
            String(uid),
            { uid: true, size: true, internalDate: true, source: true },
            { uid: true },
          );
          if (!fetched || !fetched.source) continue;
          messages.push({
            uid: String(uid),
            source: fetched.source,
            internalDate: toDate(fetched.internalDate) ?? info.internalDate,
            size: fetched.size ?? info.size,
          });
        }
        return {
          uidValidity,
          messages,
          skipped,
          highestUid: String(batch[batch.length - 1]),
        };
      },
    );
  }

  /**
   * The UIDs to read, ascending. A first sync (no cursor, a cursor with no UID,
   * or a UIDVALIDITY that changed, which voids every stored UID) reads what
   * arrived since `sinceDate`. Otherwise it reads above the stored UID. `n:*`
   * is answered with the LAST message when nothing is newer than n, so the
   * answer is filtered to UIDs strictly above the cursor.
   */
  private async newUids(
    client: ImapFlowLike,
    cursor: MailboxCursor,
    uidValidity: string,
    opts: FetchSinceOptions,
  ): Promise<number[]> {
    const lastUid = parseUid(cursor.lastUid);
    const fresh =
      cursor.uidValidity === null ||
      cursor.uidValidity !== uidValidity ||
      lastUid === null;
    const found = fresh
      ? await client.search({ since: opts.sinceDate }, { uid: true })
      : await client.search(
          { uid: `${(lastUid as bigint) + BigInt(1)}:*` },
          { uid: true },
        );
    const list = Array.isArray(found) ? found : [];
    const above = fresh
      ? list
      : list.filter((uid) => BigInt(uid) > (lastUid as bigint));
    return [...new Set(above)].sort((a, b) => a - b);
  }

  /** Each UID's size and date, without downloading a body. */
  private async readSizes(
    client: ImapFlowLike,
    uids: readonly number[],
  ): Promise<Map<number, { size: number; internalDate: Date }>> {
    const out = new Map<number, { size: number; internalDate: Date }>();
    for (let i = 0; i < uids.length; i += UID_SET_CHUNK) {
      const set = uids.slice(i, i + UID_SET_CHUNK).join(",");
      const rows = await client.fetchAll(
        set,
        { uid: true, size: true, internalDate: true },
        { uid: true },
      );
      for (const row of rows) {
        out.set(row.uid, {
          size: row.size ?? Number.POSITIVE_INFINITY,
          internalDate: toDate(row.internalDate) ?? new Date(0),
        });
      }
    }
    return out;
  }

  /**
   * Connect, run, and always leave: `logout()` in the `finally`, and a hard
   * `close()` when even that fails, so a failed poll never leaves a socket open.
   * The client's `error` event has a listener, since an unhandled one would take
   * the process down.
   */
  private async withSession<T>(
    conn: MailboxConnection,
    maxLiteralBytes: number,
    run: (client: ImapFlowLike) => Promise<T>,
  ): Promise<T> {
    // Before any socket: a private IP literal never reaches the DNS lookup.
    assertMailboxHostLiteralAllowed(conn.host, {
      allowPrivate: conn.allowPrivateHost,
    });
    const client = this.createClient(
      buildImapFlowOptions(conn, { maxLiteralBytes }),
    );
    client.on("error", () => {
      // Surfaced by the command that was running, which rejects. Listening is
      // what stops an unhandled 'error' event from ending the process.
    });
    try {
      await client.connect();
      return await run(client);
    } finally {
      try {
        await client.logout();
      } catch {
        client.close();
      }
    }
  }
}

function toDate(value: Date | string | undefined): Date | null {
  if (value === undefined) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}
