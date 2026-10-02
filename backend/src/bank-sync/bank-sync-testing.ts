import { generateKeyPairSync } from "node:crypto";
import type { ConfigService } from "@nestjs/config";
import { EncryptionService } from "../common/encryption/encryption.service";
import { NO_BANK_OPERATION } from "./bank-operation";
import type { BankSyncAccount } from "./entities/bank-sync-account.entity";
import type { BankSyncConnection } from "./entities/bank-sync-connection.entity";
import type {
  BankInstitution,
  BankSyncProvider,
  BankTransaction,
} from "./providers/bank-sync-provider.interface";
import type { BankSyncProviderRegistry } from "./providers/bank-sync-provider.registry";

/**
 * Doubles for the bank-sync specs. Every one is typed against the real
 * collaborator (`jest.Mocked<...>`), so `tsc` rejects a return shape the real
 * method cannot produce (docs/backend/testing.md).
 */

export const USER_ID = "3f1f8a52-2f0e-4b6d-9a56-0d6a3f1c2b4e";
export const OTHER_USER_ID = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";
export const CONNECTION_ID = "c0c0c0c0-0000-4000-8000-000000000001";
export const BANK_ACCOUNT_ID = "b0b0b0b0-0000-4000-8000-000000000001";
export const ACCOUNT_ID = "a0a0a0a0-0000-4000-8000-000000000001";

/** A real 2048-bit RSA key, generated once per test process. */
let cachedPem: string | null = null;
export function testRsaPem(): string {
  if (cachedPem === null) {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    cachedPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  }
  return cachedPem;
}

/** The real `EncryptionService` over a fixed key, or with none configured. */
export function testEncryption(configured = true): EncryptionService {
  const config = {
    get: (name: string, fallback?: string) =>
      name === "ENCRYPTION_KEY" && configured ? "k".repeat(40) : fallback,
  } as unknown as ConfigService;
  return new EncryptionService(config);
}

export function fakeProvider(): jest.Mocked<BankSyncProvider> {
  return {
    name: "enable_banking",
    testCredentials: jest.fn(),
    listInstitutions: jest.fn(),
    startAuthorization: jest.fn(),
    completeAuthorization: jest.fn(),
    fetchTransactions: jest.fn(),
    fetchAccountDetails: jest.fn(),
    fetchBalance: jest.fn(),
    revokeSession: jest.fn(),
  };
}

export function fakeRegistry(
  provider: BankSyncProvider,
): jest.Mocked<Pick<BankSyncProviderRegistry, "getByName" | "listNames">> {
  return {
    getByName: jest.fn().mockReturnValue(provider),
    listNames: jest.fn().mockReturnValue(["enable_banking"] as const),
  };
}

export function institution(
  over: Partial<BankInstitution> = {},
): BankInstitution {
  return {
    name: "Test Bank",
    country: "PL",
    logoUrl: null,
    psuTypes: ["personal", "business"],
    maximumConsentValiditySeconds: 90 * 24 * 60 * 60,
    ...over,
  };
}

export function bankTransaction(
  over: Partial<BankTransaction> = {},
): BankTransaction {
  return {
    entryReference: "ref-1",
    transactionId: null,
    bankReference: null,
    amount: "12.34",
    currencyCode: "PLN",
    direction: "debit",
    booked: true,
    bookingDate: "2026-09-10",
    valueDate: null,
    transactionDate: null,
    counterpartyName: "Biedronka",
    remittance: ["Groceries"],
    operation: { ...NO_BANK_OPERATION },
    ...over,
  };
}

export function connectionRow(
  over: Partial<BankSyncConnection> = {},
): BankSyncConnection {
  return {
    id: CONNECTION_ID,
    userId: USER_ID,
    provider: "enable_banking",
    institutionName: "Test Bank",
    institutionCountry: "PL",
    psuType: "personal",
    status: "active",
    authStateHash: null,
    authStartedAt: null,
    externalSessionId: "session-1",
    validUntil: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    autoSync: true,
    notifySuccess: "when_imported",
    tagOperationType: true,
    lastError: null,
    createdAt: new Date("2026-09-01T10:00:00.000Z"),
    updatedAt: new Date("2026-09-01T10:00:00.000Z"),
    ...over,
  };
}

export function bankAccountRow(
  over: Partial<BankSyncAccount> = {},
): BankSyncAccount {
  return {
    id: BANK_ACCOUNT_ID,
    userId: USER_ID,
    connectionId: CONNECTION_ID,
    externalAccountId: "ext-1",
    identificationHash: "hash-1",
    displayName: "Main account",
    identifierMasked: "**** 1234",
    accountIdentifier: null,
    cashAccountType: null,
    currencyCode: "PLN",
    accountId: ACCOUNT_ID,
    syncFromDate: "2026-08-01",
    lastSyncedAt: null,
    lastSuccessAt: null,
    lastSyncStatus: null,
    lastSyncError: null,
    lastImportedCount: 0,
    lastSkippedCount: 0,
    lastRefusedCount: 0,
    bankBalance: null,
    bankBalanceCurrency: null,
    bankBalanceDate: null,
    createdAt: new Date("2026-09-01T10:00:00.000Z"),
    updatedAt: new Date("2026-09-01T10:00:00.000Z"),
    ...over,
  };
}
