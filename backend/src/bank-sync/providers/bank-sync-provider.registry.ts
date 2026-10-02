import { Injectable } from "@nestjs/common";
import { BANK_SYNC_PROVIDERS } from "../bank-sync.constants";
import type { BankSyncProviderName } from "../bank-sync.constants";
import type { BankSyncProvider } from "./bank-sync-provider.interface";
import { EnableBankingProvider } from "./enable-banking/enable-banking.client";

/**
 * The one place a provider name becomes an implementation. A second aggregator
 * is a new directory under `providers/`, an entry in `BANK_SYNC_PROVIDERS` (and
 * the paired CHECK migration), and one case here.
 */
@Injectable()
export class BankSyncProviderRegistry {
  constructor(private readonly enableBanking: EnableBankingProvider) {}

  /** Throws for a name no provider answers to (a value the database should not hold). */
  getByName(name: BankSyncProviderName): BankSyncProvider {
    switch (name) {
      case "enable_banking":
        return this.enableBanking;
      default:
        throw new Error(`Unknown bank sync provider "${String(name)}"`);
    }
  }

  /** Every provider a connection can be made through. */
  listNames(): readonly BankSyncProviderName[] {
    return BANK_SYNC_PROVIDERS;
  }
}
