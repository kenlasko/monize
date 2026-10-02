import { BANK_SYNC_PROVIDERS } from "../bank-sync.constants";
import type { BankSyncProviderName } from "../bank-sync.constants";
import { BankSyncProviderRegistry } from "./bank-sync-provider.registry";
import type { EnableBankingProvider } from "./enable-banking/enable-banking.client";

describe("BankSyncProviderRegistry", () => {
  const enableBanking = { name: "enable_banking" } as EnableBankingProvider;
  const registry = new BankSyncProviderRegistry(enableBanking);

  it("resolves every named provider", () => {
    for (const name of BANK_SYNC_PROVIDERS) {
      expect(registry.getByName(name).name).toBe(name);
    }
  });

  it("resolves enable_banking to the Enable Banking adapter", () => {
    expect(registry.getByName("enable_banking")).toBe(enableBanking);
  });

  it("throws for a name no provider answers to", () => {
    expect(() => registry.getByName("nope" as BankSyncProviderName)).toThrow(
      'Unknown bank sync provider "nope"',
    );
  });

  it("lists the provider names", () => {
    expect(registry.listNames()).toEqual(["enable_banking"]);
  });
});
