import { Injectable } from "@nestjs/common";
import { MsnFinanceService } from "../msn-finance.service";
import { YahooFinanceService } from "../yahoo-finance.service";
import { MfApiService } from "../mfapi.service";
import { Security } from "../entities/security.entity";
import { QuoteProvider, QuoteProviderName } from "./quote-provider.interface";

export const DEFAULT_QUOTE_PROVIDER: QuoteProviderName = "yahoo";

@Injectable()
export class QuoteProviderRegistry {
  constructor(
    private readonly yahoo: YahooFinanceService,
    private readonly msn: MsnFinanceService,
    private readonly mfapi: MfApiService,
  ) {}

  getByName(name: QuoteProviderName): QuoteProvider {
    if (name === "msn") return this.msn;
    if (name === "mfapi") return this.mfapi;
    return this.yahoo;
  }

  listAll(): QuoteProvider[] {
    return [this.yahoo, this.msn, this.mfapi];
  }

  /**
   * Return providers in order [primary, fallback] for a security.
   * Primary = security override, else user default, else "yahoo".
   * Fallback = the other provider (if any).
   */
  resolveForSecurity(
    security: Pick<Security, "quoteProvider">,
    userDefault: QuoteProviderName | null | undefined,
  ): QuoteProvider[] {
    const primary: QuoteProviderName =
      (security.quoteProvider as QuoteProviderName | null) ??
      userDefault ??
      DEFAULT_QUOTE_PROVIDER;

    const providers: QuoteProvider[] = [this.getByName(primary)];
    for (const p of this.listAll()) {
      if (p.name !== primary) providers.push(p);
    }
    return providers;
  }
}
