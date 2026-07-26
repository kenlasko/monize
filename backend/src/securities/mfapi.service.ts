import { Injectable, Logger } from "@nestjs/common";
import * as https from "https";
import { getTradingDateFromQuote } from "./providers/trading-date.util";
import {
  QuoteProvider,
  QuoteProviderName,
  QuoteResult,
  SecurityLookupResult,
  HistoricalPrice,
  IntradayPoint,
  StockSectorInfo,
  EtfSectorWeighting,
} from "./providers/quote-provider.interface";

interface MfapiResponse {
  meta?: {
    scheme_code?: number;
    scheme_name?: string;
    fund_house?: string;
    scheme_type?: string;
    scheme_category?: string;
  };
  data?: Array<{ date?: string; nav?: string }>;
  status?: string;
}

interface MfapiSearchItem {
  schemeCode?: number;
  schemeName?: string;
}

@Injectable()
export class MfApiService implements QuoteProvider {
  readonly name: QuoteProviderName = "mfapi";
  private readonly logger = new Logger(MfApiService.name);
  private static readonly MFAPI_BASE = "https://api.mfapi.in";

  private httpGetJson<T>(url: string): Promise<T> {
    return new Promise((resolve, reject) => {
      https
        .get(url, { headers: { Accept: "application/json" } }, (res) => {
          if (
            res.statusCode &&
            (res.statusCode < 200 || res.statusCode >= 300)
          ) {
            return reject(new Error(`MF API returned HTTP ${res.statusCode}`));
          }
          let body = "";
          res.on("data", (chunk) => (body += chunk));
          res.on("end", () => {
            try {
              resolve(JSON.parse(body) as T);
            } catch (err) {
              reject(err);
            }
          });
        })
        .on("error", reject);
    });
  }

  async fetchQuote(symbol: string): Promise<QuoteResult | null> {
    const code = symbol.trim();
    if (!/^\d+$/.test(code)) {
      return null;
    }

    try {
      const data = await this.httpGetJson<MfapiResponse>(
        `${MfApiService.MFAPI_BASE}/mf/${code}`,
      );

      const latest = data.data?.[0];
      if (!latest?.nav) return null;

      const price = Number(latest.nav);
      const dateObj = latest.date
        ? this.parseMfapiDate(latest.date)
        : new Date();

      return {
        symbol: code,
        regularMarketPrice: price,
        regularMarketTime: Math.floor(dateObj.getTime() / 1000),
        currencyCode: "INR",
        provider: "mfapi",
      };
    } catch (err) {
      this.logger.warn(`Failed to fetch MF quote for ${code}: ${err}`);
      return null;
    }
  }

  async lookupSecurity(query: string): Promise<SecurityLookupResult | null> {
    const candidates = await this.lookupSecurityMany(query);
    return candidates[0] ?? null;
  }

  async lookupSecurityMany(query: string): Promise<SecurityLookupResult[]> {
    if (!query || query.trim().length < 2) return [];

    try {
      const data = await this.httpGetJson<MfapiSearchItem[]>(
        `${MfApiService.MFAPI_BASE}/mf/search?q=${encodeURIComponent(query)}`,
      );

      if (!Array.isArray(data)) return [];

      return data.slice(0, 15).map((item) => ({
        symbol: String(item.schemeCode),
        name: item.schemeName || String(item.schemeCode),
        exchange: "NSE",
        securityType: "Mutual Fund",
        currencyCode: "INR",
        provider: "mfapi",
      }));
    } catch (err) {
      this.logger.error(`Failed to search Indian Mutual Funds: ${err}`);
      return [];
    }
  }

  async fetchHistorical(symbol: string): Promise<HistoricalPrice[] | null> {
    const code = symbol.trim();
    if (!/^\d+$/.test(code)) return null;

    try {
      const data = await this.httpGetJson<MfapiResponse>(
        `${MfApiService.MFAPI_BASE}/mf/${code}`,
      );

      if (!Array.isArray(data.data)) return null;

      const results: HistoricalPrice[] = [];
      for (const entry of data.data) {
        if (!entry.date || !entry.nav) continue;
        const date = this.parseMfapiDate(entry.date);
        const nav = Number(entry.nav);
        results.push({
          date,
          open: nav,
          high: nav,
          low: nav,
          close: nav,
          adjClose: nav,
          volume: null,
        });
      }

      return results.sort((a, b) => a.date.getTime() - b.date.getTime());
    } catch (err) {
      this.logger.error(
        `Failed to fetch historical MF data for ${code}: ${err}`,
      );
      return null;
    }
  }

  async fetchIntradaySeries(): Promise<IntradayPoint[] | null> {
    return null;
  }

  async fetchStockSectorInfo(): Promise<StockSectorInfo | null> {
    return { sector: "Financial Services", industry: "Mutual Funds" };
  }

  async fetchEtfSectorWeightings(): Promise<EtfSectorWeighting[] | null> {
    return [];
  }

  getTradingDate(quote: QuoteResult): Date {
    return getTradingDateFromQuote(quote);
  }

  private parseMfapiDate(dateStr: string): Date {
    const m = dateStr.match(/^(\d{2})-(\d{2})-(\d{4})$/);
    if (!m) return new Date();
    const [, dd, mm, yyyy] = m;
    return new Date(
      Date.UTC(Number(yyyy), Number(mm) - 1, Number(dd), 12, 0, 0),
    );
  }
}
