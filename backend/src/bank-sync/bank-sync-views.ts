import type { BankSyncAccount } from "./entities/bank-sync-account.entity";
import type { BankSyncConnection } from "./entities/bank-sync-connection.entity";
import type {
  BankSyncAccountView,
  BankSyncConnectionView,
} from "./bank-sync.types";

/**
 * Entity to response, and only the fields a client may see. Written as an
 * allow-list of fields, never a spread of the row: a column added to an entity
 * later (a session id, a state hash) must be named here to reach a response.
 */

/** A `decimal(20,4)` at its column's precision, as the string the API sends. */
function moneyText(value: number | null): string | null {
  return value === null ? null : value.toFixed(4);
}

const iso = (value: Date | null): string | null =>
  value === null ? null : value.toISOString();

/**
 * Whether a bank account still needs its preview confirmed (spec section 7a):
 * it is linked and its link has no successful sync yet. Linking, or changing
 * the account or the cut-off, clears `last_success_at`
 * (`BankSyncService.linkAccount`), so "no success yet" is "not confirmed". The
 * one definition: the view, the daily sync and "sync every account" all ask it,
 * so nothing imports an account the user has not confirmed.
 */
export function bankAccountNeedsPreview(
  row: Pick<BankSyncAccount, "accountId" | "lastSuccessAt">,
): boolean {
  return row.accountId !== null && row.lastSuccessAt === null;
}

export function toBankSyncAccountView(
  row: BankSyncAccount,
): BankSyncAccountView {
  return {
    id: row.id,
    connectionId: row.connectionId,
    displayName: row.displayName,
    identifierMasked: row.identifierMasked,
    accountIdentifier: row.accountIdentifier,
    cashAccountType: row.cashAccountType,
    currencyCode: row.currencyCode,
    accountId: row.accountId,
    syncFromDate: row.syncFromDate,
    lastSyncedAt: iso(row.lastSyncedAt),
    lastSyncStatus: row.lastSyncStatus,
    lastSyncError: row.lastSyncError,
    lastImportedCount: row.lastImportedCount,
    lastSkippedCount: row.lastSkippedCount,
    lastRefusedCount: row.lastRefusedCount,
    bankBalance: moneyText(row.bankBalance),
    bankBalanceCurrency: row.bankBalanceCurrency,
    bankBalanceDate: row.bankBalanceDate,
    needsPreview: bankAccountNeedsPreview(row),
  };
}

export function toBankSyncConnectionView(
  row: BankSyncConnection,
  accounts: readonly BankSyncAccount[],
): BankSyncConnectionView {
  return {
    id: row.id,
    provider: row.provider,
    institutionName: row.institutionName,
    institutionCountry: row.institutionCountry,
    psuType: row.psuType,
    status: row.status,
    validUntil: iso(row.validUntil),
    autoSync: row.autoSync,
    notifySuccess: row.notifySuccess,
    tagOperationType: row.tagOperationType,
    lastError: row.lastError,
    createdAt: row.createdAt.toISOString(),
    accounts: accounts.map(toBankSyncAccountView),
  };
}
