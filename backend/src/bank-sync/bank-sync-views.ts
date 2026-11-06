import { BANK_SYNC_MONEY_DECIMALS } from "./bank-sync.constants";
import {
  DEFAULT_PROFILE_ID,
  profileNotesView,
  resolveConnectionProfile,
} from "./bank-sync-profiles";
import type { BankSyncAccount } from "./entities/bank-sync-account.entity";
import type { BankSyncConnection } from "./entities/bank-sync-connection.entity";
import type {
  BankInstitutionProfileView,
  BankSyncAccountView,
  BankSyncConnectionProfileView,
  BankSyncConnectionView,
} from "./bank-sync.types";

/**
 * Entity to response, and only the fields a client may see. Written as an
 * allow-list of fields, never a spread of the row: a column added to an entity
 * later (a session id, a state hash) must be named here to reach a response.
 */

/** A money figure at the bank-sync precision, as the string the API sends. */
function moneyText(value: number | null): string | null {
  return value === null ? null : value.toFixed(BANK_SYNC_MONEY_DECIMALS);
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
  row: Pick<BankSyncAccount, "accountId" | "lastSuccessAt" | "backfillThrough">,
): boolean {
  return (
    row.accountId !== null &&
    (row.lastSuccessAt === null || !!row.backfillThrough)
  );
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
    ...(row.bankBalanceAt !== undefined
      ? { bankBalanceAt: row.bankBalanceAt?.toISOString() ?? null }
      : {}),
    needsPreview: bankAccountNeedsPreview(row),
  };
}

/**
 * The profile a connection's rows are read by, with its notes in `readerLang`
 * (English where a note has no text in it). Always present: a bank with no
 * profile of its own has the source default, or the global default.
 */
export function toBankSyncConnectionProfileView(
  row: Pick<
    BankSyncConnection,
    "provider" | "institutionCountry" | "institutionName"
  >,
  readerLang: string,
): BankSyncConnectionProfileView {
  const profile = resolveConnectionProfile(row);
  return {
    id: profile.id,
    version: profile.version,
    notes: profileNotesView(profile, readerLang),
  };
}

/**
 * The built-in profile of a bank the provider lists, or null when it has none
 * (the default applies, and there is nothing to tell the reader before they
 * connect). A Map lookup per bank, so a list of several hundred banks is cheap.
 */
export function toBankInstitutionProfileView(
  provider: string,
  institution: { readonly country: string; readonly name: string },
  readerLang: string,
): BankInstitutionProfileView | null {
  const profile = resolveConnectionProfile({
    provider,
    institutionCountry: institution.country,
    institutionName: institution.name,
  });
  return profile.id === DEFAULT_PROFILE_ID
    ? null
    : { id: profile.id, notes: profileNotesView(profile, readerLang) };
}

export function toBankSyncConnectionView(
  row: BankSyncConnection,
  accounts: readonly BankSyncAccount[],
  readerLang: string,
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
    profile: toBankSyncConnectionProfileView(row, readerLang),
    accounts: accounts.map(toBankSyncAccountView),
  };
}
