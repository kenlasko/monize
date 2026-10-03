import type {
  EmailReceiptAiMode,
  EmailReceiptAuthMethod,
  EmailReceiptMailbox,
  EmailReceiptMailboxSecurity,
  EmailReceiptOAuthProvider,
} from "../entities/email-receipt-mailbox.entity";

/**
 * What a client sees of a mailbox: every setting and the last poll's outcome,
 * and never the password or the OAuth refresh token (INV-RECEIPT-005) --
 * `passwordSet` says whether a password is stored and `oauthConnected` whether a
 * refresh token is (an OAuth2 mailbox without one was disconnected or revoked
 * and needs connecting again). `authMethod` and `oauthProvider` say how the
 * mailbox logs in; its host, port and security are the provider's own when it is
 * `oauth2`, and its `username` is the account's address. The poll cursor is the server's own bookkeeping and is not shown.
 * `encryptionConfigured` says whether this server can encrypt a password at all,
 * so the settings screen can explain a refused save.
 */
export interface EmailReceiptMailboxView {
  id: string;
  host: string;
  port: number;
  security: EmailReceiptMailboxSecurity;
  username: string;
  folder: string;
  enabled: boolean;
  aiMode: EmailReceiptAiMode;
  autoApply: boolean;
  authMethod: EmailReceiptAuthMethod;
  oauthProvider: EmailReceiptOAuthProvider | null;
  passwordSet: boolean;
  oauthConnected: boolean;
  encryptionConfigured: boolean;
  lastPolledAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** The outcome of a connection test. A failure carries a bounded, secret-free line. */
export type EmailReceiptMailboxTestResult =
  | { ok: true; messages: number }
  | { ok: false; error: string };

const iso = (value: Date | null): string | null =>
  value ? value.toISOString() : null;

/** The view of a stored row. Built field by field so a new column is not shown by accident. */
export function toMailboxView(
  row: EmailReceiptMailbox,
  flags: {
    passwordSet: boolean;
    oauthConnected: boolean;
    encryptionConfigured: boolean;
  },
): EmailReceiptMailboxView {
  return {
    id: row.id,
    host: row.host,
    port: row.port,
    security: row.security,
    username: row.username,
    folder: row.folder,
    enabled: row.enabled,
    aiMode: row.aiMode,
    autoApply: row.autoApply,
    authMethod: row.authMethod,
    oauthProvider: row.oauthProvider ?? null,
    passwordSet: flags.passwordSet,
    oauthConnected: flags.oauthConnected,
    encryptionConfigured: flags.encryptionConfigured,
    lastPolledAt: iso(row.lastPolledAt),
    lastSuccessAt: iso(row.lastSuccessAt),
    lastError: row.lastError,
    lastErrorAt: iso(row.lastErrorAt),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
