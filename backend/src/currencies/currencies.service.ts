import {
  Injectable,
  Logger,
  ConflictException,
  NotFoundException,
  ForbiddenException,
} from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository, DataSource } from "typeorm";
import { Currency } from "./entities/currency.entity";
import { UserCurrencyPreference } from "./entities/user-currency-preference.entity";
import { CreateCurrencyDto } from "./dto/create-currency.dto";
import { UpdateCurrencyDto } from "./dto/update-currency.dto";

export interface CurrencyLookupResult {
  code: string;
  name: string;
  symbol: string;
  decimalPlaces: number;
}

export interface CurrencyUsageMap {
  [code: string]: { accounts: number; securities: number };
}

export interface UserCurrencyView {
  code: string;
  name: string;
  symbol: string;
  decimalPlaces: number;
  isActive: boolean;
  isSystem: boolean;
  createdAt: Date;
}

// Known currency metadata for lookup (Yahoo Finance doesn't return symbol/name directly)
const CURRENCY_METADATA: Record<
  string,
  { name: string; symbol: string; decimalPlaces: number }
> = {
  USD: { name: "US Dollar", symbol: "$", decimalPlaces: 2 },
  EUR: { name: "Euro", symbol: "\u20AC", decimalPlaces: 2 },
  JPY: { name: "Japanese Yen", symbol: "\u00A5", decimalPlaces: 0 },
  GBP: { name: "British Pound", symbol: "\u00A3", decimalPlaces: 2 },
  AUD: { name: "Australian Dollar", symbol: "A$", decimalPlaces: 2 },
  CAD: { name: "Canadian Dollar", symbol: "CA$", decimalPlaces: 2 },
  CHF: { name: "Swiss Franc", symbol: "CHF", decimalPlaces: 2 },
  CNY: { name: "Chinese Yuan", symbol: "\u00A5", decimalPlaces: 2 },
  HKD: { name: "Hong Kong Dollar", symbol: "HK$", decimalPlaces: 2 },
  NZD: { name: "New Zealand Dollar", symbol: "NZ$", decimalPlaces: 2 },
  SEK: { name: "Swedish Krona", symbol: "kr", decimalPlaces: 2 },
  KRW: { name: "South Korean Won", symbol: "\u20A9", decimalPlaces: 0 },
  SGD: { name: "Singapore Dollar", symbol: "S$", decimalPlaces: 2 },
  NOK: { name: "Norwegian Krone", symbol: "kr", decimalPlaces: 2 },
  MXN: { name: "Mexican Peso", symbol: "MX$", decimalPlaces: 2 },
  INR: { name: "Indian Rupee", symbol: "\u20B9", decimalPlaces: 2 },
  RUB: { name: "Russian Ruble", symbol: "\u20BD", decimalPlaces: 2 },
  ZAR: { name: "South African Rand", symbol: "R", decimalPlaces: 2 },
  TRY: { name: "Turkish Lira", symbol: "\u20BA", decimalPlaces: 2 },
  BRL: { name: "Brazilian Real", symbol: "R$", decimalPlaces: 2 },
  TWD: { name: "New Taiwan Dollar", symbol: "NT$", decimalPlaces: 2 },
  DKK: { name: "Danish Krone", symbol: "kr", decimalPlaces: 2 },
  PLN: { name: "Polish Zloty", symbol: "z\u0142", decimalPlaces: 2 },
  THB: { name: "Thai Baht", symbol: "\u0E3F", decimalPlaces: 2 },
  IDR: { name: "Indonesian Rupiah", symbol: "Rp", decimalPlaces: 0 },
  HUF: { name: "Hungarian Forint", symbol: "Ft", decimalPlaces: 2 },
  CZK: { name: "Czech Koruna", symbol: "K\u010D", decimalPlaces: 2 },
  ILS: { name: "Israeli Shekel", symbol: "\u20AA", decimalPlaces: 2 },
  CLP: { name: "Chilean Peso", symbol: "CL$", decimalPlaces: 0 },
  PHP: { name: "Philippine Peso", symbol: "\u20B1", decimalPlaces: 2 },
  SAR: { name: "Saudi Riyal", symbol: "\uFDFC", decimalPlaces: 2 },
  AED: { name: "UAE Dirham", symbol: "AED", decimalPlaces: 2 },
  COP: { name: "Colombian Peso", symbol: "COL$", decimalPlaces: 2 },
  MYR: { name: "Malaysian Ringgit", symbol: "RM", decimalPlaces: 2 },
  PEN: { name: "Peruvian Sol", symbol: "S/", decimalPlaces: 2 },
  ARS: { name: "Argentine Peso", symbol: "AR$", decimalPlaces: 2 },
  NGN: { name: "Nigerian Naira", symbol: "\u20A6", decimalPlaces: 2 },
  EGP: { name: "Egyptian Pound", symbol: "E\u00A3", decimalPlaces: 2 },
  VND: { name: "Vietnamese Dong", symbol: "\u20AB", decimalPlaces: 0 },
  PKR: { name: "Pakistani Rupee", symbol: "\u20A8", decimalPlaces: 2 },
  BDT: { name: "Bangladeshi Taka", symbol: "\u09F3", decimalPlaces: 2 },
  KWD: { name: "Kuwaiti Dinar", symbol: "KWD", decimalPlaces: 3 },
  BHD: { name: "Bahraini Dinar", symbol: "BHD", decimalPlaces: 3 },
  OMR: { name: "Omani Rial", symbol: "OMR", decimalPlaces: 3 },
};

@Injectable()
export class CurrenciesService {
  private readonly logger = new Logger(CurrenciesService.name);

  constructor(
    @InjectRepository(Currency)
    private currencyRepository: Repository<Currency>,
    @InjectRepository(UserCurrencyPreference)
    private userCurrencyPrefRepository: Repository<UserCurrencyPreference>,
    private dataSource: DataSource,
  ) {}

  async create(
    userId: string,
    dto: CreateCurrencyDto,
  ): Promise<UserCurrencyView> {
    const code = dto.code.toUpperCase();

    const existing = await this.currencyRepository.findOne({
      where: { code },
    });

    if (existing) {
      // Check if this user already has this currency in their list
      const existingPref = await this.userCurrencyPrefRepository.findOne({
        where: { userId, currencyCode: code },
      });
      if (existingPref) {
        throw new ConflictException(
          `Currency "${code}" is already in your list`,
        );
      }

      // Add preference row so user can see/use the existing currency
      await this.dataSource.query(
        `INSERT INTO user_currency_preferences (user_id, currency_code, is_active)
         VALUES ($1, $2, true)
         ON CONFLICT (user_id, currency_code) DO NOTHING`,
        [userId, code],
      );

      return this.buildUserCurrencyView(existing, true);
    }

    // Currency doesn't exist — create it as a user-created currency
    const currency = this.currencyRepository.create({
      ...dto,
      code,
      decimalPlaces: dto.decimalPlaces ?? 2,
      isActive: true,
      createdByUserId: userId,
    });
    await this.currencyRepository.save(currency);

    // Add preference row for the creator
    await this.dataSource.query(
      `INSERT INTO user_currency_preferences (user_id, currency_code, is_active)
       VALUES ($1, $2, true)
       ON CONFLICT (user_id, currency_code) DO NOTHING`,
      [userId, code],
    );

    return this.buildUserCurrencyView(currency, true);
  }

  async findAll(
    userId: string,
    includeInactive = false,
  ): Promise<UserCurrencyView[]> {
    let query = `
      SELECT c.code, c.name, c.symbol,
             c.decimal_places AS "decimalPlaces",
             COALESCE(ucp.is_active, c.is_active) AS "isActive",
             (c.created_by_user_id IS NULL) AS "isSystem",
             c.created_at AS "createdAt"
      FROM currencies c
      LEFT JOIN user_currency_preferences ucp
        ON ucp.currency_code = c.code AND ucp.user_id = $1
      WHERE (c.created_by_user_id IS NULL OR ucp.user_id IS NOT NULL)`;

    if (!includeInactive) {
      query += ` AND COALESCE(ucp.is_active, c.is_active) = true`;
    }

    query += ` ORDER BY c.code ASC`;

    return this.dataSource.query(query, [userId]);
  }

  async findOne(code: string): Promise<Currency> {
    const currency = await this.currencyRepository.findOne({
      where: { code: code.toUpperCase() },
    });
    if (!currency) {
      throw new NotFoundException(`Currency "${code}" not found`);
    }
    return currency;
  }

  async update(
    userId: string,
    code: string,
    dto: UpdateCurrencyDto,
  ): Promise<UserCurrencyView> {
    const currency = await this.findOne(code);

    // System currencies: cannot modify metadata
    if (currency.createdByUserId === null) {
      throw new ForbiddenException("Cannot modify system currency metadata");
    }

    // Non-system currencies: only the creator can modify metadata
    if (currency.createdByUserId !== userId) {
      throw new ForbiddenException("Cannot modify another user's currency");
    }

    // Handle isActive separately via preference row
    const { isActive, ...metadataUpdates } = dto;

    if (Object.keys(metadataUpdates).length > 0) {
      Object.assign(currency, metadataUpdates);
      await this.currencyRepository.save(currency);
    }

    if (isActive !== undefined) {
      await this.upsertPreference(userId, currency.code, isActive);
    }

    const pref = await this.userCurrencyPrefRepository.findOne({
      where: { userId, currencyCode: currency.code },
    });

    return this.buildUserCurrencyView(
      currency,
      pref ? pref.isActive : currency.isActive,
    );
  }

  async deactivate(userId: string, code: string): Promise<UserCurrencyView> {
    const currency = await this.findOne(code);
    await this.upsertPreference(userId, currency.code, false);
    return this.buildUserCurrencyView(currency, false);
  }

  async activate(userId: string, code: string): Promise<UserCurrencyView> {
    const currency = await this.findOne(code);
    await this.upsertPreference(userId, currency.code, true);
    return this.buildUserCurrencyView(currency, true);
  }

  async remove(userId: string, code: string): Promise<void> {
    const upperCode = code.toUpperCase();
    const currency = await this.findOne(upperCode);

    // Check if in use by this user
    const inUse = await this.isInUse(userId, upperCode);
    if (inUse) {
      throw new ConflictException(
        `Currency "${code}" is in use by your accounts, securities, or other records. Deactivate it instead.`,
      );
    }

    // Remove this user's preference row
    await this.userCurrencyPrefRepository.delete({
      userId,
      currencyCode: upperCode,
    });

    // If non-system currency and no other users reference it, clean up the currency row
    if (currency.createdByUserId !== null) {
      const remainingPrefs = await this.userCurrencyPrefRepository.count({
        where: { currencyCode: upperCode },
      });

      if (remainingPrefs === 0) {
        // Also check no global references (accounts, securities, transactions from any user)
        const globallyInUse = await this.isInUseGlobally(upperCode);
        if (!globallyInUse) {
          await this.currencyRepository.remove(currency);
        }
      }
    }
  }

  async isInUse(userId: string, code: string): Promise<boolean> {
    const result = await this.dataSource.query(
      `SELECT EXISTS (
        SELECT 1 FROM accounts WHERE currency_code = $1 AND user_id = $2
        UNION ALL SELECT 1 FROM securities WHERE currency_code = $1 AND user_id = $2
        UNION ALL SELECT 1 FROM transactions t
          JOIN accounts a ON a.id = t.account_id
          WHERE t.currency_code = $1 AND a.user_id = $2
        UNION ALL SELECT 1 FROM user_preferences WHERE default_currency = $1 AND user_id = $2
      ) AS "inUse"`,
      [code.toUpperCase(), userId],
    );
    return result[0]?.inUse === true;
  }

  async getUsage(userId: string): Promise<CurrencyUsageMap> {
    const rows: Array<{
      code: string;
      accounts: string;
      securities: string;
    }> = await this.dataSource.query(
      `SELECT c.code,
        COALESCE(a.cnt, 0)::text AS accounts,
        COALESCE(s.cnt, 0)::text AS securities
      FROM currencies c
      LEFT JOIN user_currency_preferences ucp
        ON ucp.currency_code = c.code AND ucp.user_id = $1
      LEFT JOIN (
        SELECT currency_code, COUNT(*) AS cnt
        FROM accounts WHERE is_closed = false AND user_id = $1
        GROUP BY currency_code
      ) a ON a.currency_code = c.code
      LEFT JOIN (
        SELECT currency_code, COUNT(*) AS cnt
        FROM securities WHERE is_active = true AND user_id = $1
        GROUP BY currency_code
      ) s ON s.currency_code = c.code
      WHERE c.created_by_user_id IS NULL OR ucp.user_id IS NOT NULL`,
      [userId],
    );

    const usage: CurrencyUsageMap = {};
    for (const row of rows) {
      usage[row.code] = {
        accounts: parseInt(row.accounts, 10),
        securities: parseInt(row.securities, 10),
      };
    }
    return usage;
  }

  async lookupCurrency(query: string): Promise<CurrencyLookupResult | null> {
    const trimmed = query.trim();
    if (trimmed.length < 2) return null;

    try {
      // 1. Check if query matches a currency code directly
      const upperQuery = trimmed.toUpperCase();
      const directMetadata = CURRENCY_METADATA[upperQuery];
      if (directMetadata) {
        return this.verifyAndReturnCurrency(upperQuery, directMetadata);
      }

      // 2. Search our metadata by name (handles country names, currency names, etc.)
      const metadataMatch = this.searchMetadataByText(trimmed);
      if (metadataMatch) {
        return this.verifyAndReturnCurrency(
          metadataMatch.code,
          metadataMatch.metadata,
        );
      }

      // 3. Fall back to Yahoo Finance search API for unknown currencies
      const searchUrl = `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(trimmed)}&quotesCount=20&newsCount=0`;
      const searchResponse = await fetch(searchUrl, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        },
      });

      if (!searchResponse.ok) {
        this.logger.warn(
          `Yahoo Finance search returned ${searchResponse.status} for currency query: ${query}`,
        );
        return null;
      }

      const searchData = await searchResponse.json();
      const quotes = searchData.quotes || [];

      // Find currency-type results (forex pairs like EURUSD=X)
      const currencyQuotes = quotes.filter(
        (q: any) =>
          q.quoteType === "CURRENCY" || (q.symbol && q.symbol.includes("=X")),
      );

      if (currencyQuotes.length === 0) {
        return null;
      }

      // Extract the currency code from the first forex pair result
      const firstResult = currencyQuotes[0];
      const resultCode = this.extractCurrencyCode(
        firstResult.symbol,
        upperQuery,
      );

      const resultMetadata = CURRENCY_METADATA[resultCode];

      return {
        code: resultCode,
        name: resultMetadata?.name || resultCode,
        symbol: resultMetadata?.symbol || resultCode,
        decimalPlaces: resultMetadata?.decimalPlaces ?? 2,
      };
    } catch (error) {
      this.logger.error(`Failed to lookup currency: ${error.message}`);
      return null;
    }
  }

  // ── Private helpers ─────────────────────────────────────────────

  private async upsertPreference(
    userId: string,
    code: string,
    isActive: boolean,
  ): Promise<void> {
    await this.dataSource.query(
      `INSERT INTO user_currency_preferences (user_id, currency_code, is_active)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id, currency_code)
       DO UPDATE SET is_active = $3`,
      [userId, code.toUpperCase(), isActive],
    );
  }

  private async isInUseGlobally(code: string): Promise<boolean> {
    const result = await this.dataSource.query(
      `SELECT EXISTS (
        SELECT 1 FROM accounts WHERE currency_code = $1
        UNION ALL SELECT 1 FROM securities WHERE currency_code = $1
        UNION ALL SELECT 1 FROM transactions WHERE currency_code = $1
        UNION ALL SELECT 1 FROM user_preferences WHERE default_currency = $1
      ) AS "inUse"`,
      [code.toUpperCase()],
    );
    return result[0]?.inUse === true;
  }

  private buildUserCurrencyView(
    currency: Currency,
    isActive: boolean,
  ): UserCurrencyView {
    return {
      code: currency.code,
      name: currency.name,
      symbol: currency.symbol,
      decimalPlaces: currency.decimalPlaces,
      isActive,
      isSystem: currency.createdByUserId === null,
      createdAt: currency.createdAt,
    };
  }

  /**
   * Search CURRENCY_METADATA entries by name text (case-insensitive substring match).
   * Supports queries like "Malaysia", "Ringgit", "Canadian Dollar", "Japan", etc.
   */
  private searchMetadataByText(
    query: string,
  ): { code: string; metadata: (typeof CURRENCY_METADATA)[string] } | null {
    const lowerQuery = query.toLowerCase();

    // Exact name match first
    for (const [code, meta] of Object.entries(CURRENCY_METADATA)) {
      if (meta.name.toLowerCase() === lowerQuery) {
        return { code, metadata: meta };
      }
    }

    // Substring match (e.g., "Ringgit" matches "Malaysian Ringgit")
    const matches: Array<{
      code: string;
      metadata: (typeof CURRENCY_METADATA)[string];
    }> = [];
    for (const [code, meta] of Object.entries(CURRENCY_METADATA)) {
      if (meta.name.toLowerCase().includes(lowerQuery)) {
        matches.push({ code, metadata: meta });
      }
    }

    return matches.length === 1 ? matches[0] : null;
  }

  /**
   * Verify a currency exists on Yahoo Finance and return our metadata name.
   */
  private async verifyAndReturnCurrency(
    code: string,
    metadata: (typeof CURRENCY_METADATA)[string],
  ): Promise<CurrencyLookupResult> {
    try {
      const yahooSymbol = `${code}USD=X`;
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol)}?interval=1d&range=1d`;
      const response = await fetch(url, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        },
      });

      if (response.ok) {
        // Verified on Yahoo - use our metadata name (not Yahoo's forex pair name)
        return {
          code,
          name: metadata.name,
          symbol: metadata.symbol,
          decimalPlaces: metadata.decimalPlaces,
        };
      }
    } catch {
      // Yahoo verification failed, still return our metadata
    }

    return {
      code,
      name: metadata.name,
      symbol: metadata.symbol,
      decimalPlaces: metadata.decimalPlaces,
    };
  }

  /**
   * Extract a currency code from a Yahoo Finance forex symbol like "EURUSD=X"
   */
  private extractCurrencyCode(symbol: string, originalQuery: string): string {
    // Remove =X suffix
    const pair = symbol.replace("=X", "");
    // Forex pairs are 6 chars: EURUSD -> EUR + USD
    if (pair.length === 6) {
      const base = pair.substring(0, 3);
      const quote = pair.substring(3, 6);
      // Return whichever part matches the query
      const upperQuery = originalQuery.toUpperCase();
      if (base === upperQuery) return base;
      if (quote === upperQuery) return quote;
      return base; // Default to base currency
    }
    return originalQuery.toUpperCase();
  }
}
