import { Injectable } from "@nestjs/common";
import { MsnFinanceService } from "../msn-finance.service";
import { YahooFinanceService } from "../yahoo-finance.service";
import { LseFinanceService } from "../lse-finance.service";
import { DeutscheBoerseFinanceService } from "../deutsche-boerse-finance.service";
import { HtmlTableFinanceService } from "../html-table-finance.service";
import { Security } from "../entities/security.entity";
import {
  PER_SECURITY_ONLY_PROVIDERS,
  QuoteProvider,
  QuoteProviderName,
} from "./quote-provider.interface";

export const DEFAULT_QUOTE_PROVIDER: QuoteProviderName = "yahoo";

/**
 * Providers that price a security from its bare ticker and so may back up any
 * security's primary provider. The exchange-specific providers (`lse`,
 * `deutsche_boerse`) are addressed by a venue identifier (a London TIDM, a
 * Börse Frankfurt ISIN), not a generic ticker, so a symbol that merely collides
 * with a listing on those venues must never be repriced from them: they take
 * part only when a security explicitly names one as its provider, never as a
 * blanket fallback (which would let a US ticker be priced from a same-symbol
 * London line in the same currency). `html_table` is never a fallback either:
 * it reads the page one security names, and no other security has that page.
 */
const GENERAL_FALLBACK_PROVIDERS: ReadonlySet<QuoteProviderName> = new Set([
  "yahoo",
  "msn",
]);

@Injectable()
export class QuoteProviderRegistry {
  constructor(
    private readonly yahoo: YahooFinanceService,
    private readonly msn: MsnFinanceService,
    private readonly lse: LseFinanceService,
    private readonly deutscheBoerse: DeutscheBoerseFinanceService,
    private readonly htmlTable: HtmlTableFinanceService,
  ) {}

  getByName(name: QuoteProviderName): QuoteProvider {
    switch (name) {
      case "msn":
        return this.msn;
      case "lse":
        return this.lse;
      case "deutsche_boerse":
        return this.deutscheBoerse;
      case "html_table":
        return this.htmlTable;
      default:
        return this.yahoo;
    }
  }

  listAll(): QuoteProvider[] {
    return [
      this.yahoo,
      this.msn,
      this.lse,
      this.deutscheBoerse,
      this.htmlTable,
    ];
  }

  /**
   * Return the providers to try in order for a security: the primary first, then
   * the general (ticker-based) providers as fallback.
   *
   * Primary = security override, else user default, else "yahoo". The fallback is
   * only `GENERAL_FALLBACK_PROVIDERS` (never an exchange-specific provider the
   * security did not opt into), so a Yahoo/MSN security is never silently
   * repriced from a same-symbol LSE or Börse Frankfurt listing. An
   * exchange-specific primary still keeps the general providers behind it.
   */
  resolveForSecurity(
    security: Pick<Security, "quoteProvider">,
    userDefault: QuoteProviderName | null | undefined,
  ): QuoteProvider[] {
    // A default that needs a page the security names (html_table) cannot
    // serve a security that names none; the DTO and the CHECK refuse it, and a
    // value that arrived some other way falls back to the instance default
    // rather than silently pricing nothing.
    const usableDefault =
      userDefault &&
      !(PER_SECURITY_ONLY_PROVIDERS as readonly string[]).includes(userDefault)
        ? userDefault
        : null;
    const primary: QuoteProviderName =
      (security.quoteProvider as QuoteProviderName | null) ??
      usableDefault ??
      DEFAULT_QUOTE_PROVIDER;

    const providers: QuoteProvider[] = [this.getByName(primary)];
    // A security priced from a web page usually carries a symbol the user made
    // up; asking Yahoo or MSN for it could price it from an unrelated listing.
    if (primary === "html_table") return providers;
    for (const p of this.listAll()) {
      if (p.name === primary) continue;
      if (!GENERAL_FALLBACK_PROVIDERS.has(p.name)) continue;
      providers.push(p);
    }
    return providers;
  }
}
