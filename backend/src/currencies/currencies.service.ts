import {
  Injectable,
  Logger,
  ConflictException,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
  OnApplicationBootstrap,
  Optional,
} from "@nestjs/common";
import { tr } from "../i18n/translate";
import { DataSource, EntityManager } from "typeorm";
import { withScopedDb } from "../common/db/scoped-db";
import { withSystemContext } from "../common/db/with-context";
import {
  Currency,
  CurrencyKind,
  DEFAULT_CURRENCY_KIND,
} from "./entities/currency.entity";
import { UserCurrencyPreference } from "./entities/user-currency-preference.entity";
import { CreateCurrencyDto } from "./dto/create-currency.dto";
import { UpdateCurrencyDto } from "./dto/update-currency.dto";
import {
  CURRENCY_METADATA,
  resolveCurrencyMetadata,
  getCurrencyCatalog,
  isKnownIsoCurrency,
  type CurrencyMetadata,
} from "./currency-metadata";
import { FALLBACK_DEFAULT_CURRENCY } from "../common/default-currency.util";
import { MONEY_SCALE, moneyDecimalsFor } from "../common/round.util";
import { FxProviderChain } from "./providers/fx-provider-chain";
import { CryptoFxProvider } from "./providers/crypto-fx.provider";
import { ExchangeRateHistoryService } from "./exchange-rate-history.service";
import {
  QuoteSymbolRefusal,
  quoteSymbolCoinTicker,
  quoteSymbolRefusal,
} from "./currency-kind.util";

export interface CurrencyLookupResult {
  code: string;
  name: string;
  symbol: string;
  decimalPlaces: number;
}

/**
 * One entry of the onboarding catalog. Always FIAT: the catalog is ISO 4217
 * metadata, and nothing infers a coin from a code (decision 1).
 */
export interface CurrencyCatalogEntry extends CurrencyLookupResult {
  kind: CurrencyKind;
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
  kind: CurrencyKind;
  quoteSymbol: string | null;
}

/**
 * The places a coin defaults to: the most money holds, eight
 * (`docs/specs/money-precision.md` decision 2, superseding decision 4 of
 * `docs/specs/crypto-accounts.md`).
 */
const CRYPTO_DEFAULT_DECIMAL_PLACES = 8;

// The currency every new user's preferences default to (see
// buildDefaultPreferences), and the one every reporting surface falls back to
// when a preference row is missing -- so it is the SAME constant, derived rather
// than restated. It must exist because user_preferences.default_currency has a
// foreign key to currencies(code), and because a fallback to a currency with no
// row resolves no rate at all: every converted total would be withheld.
const DEFAULT_CURRENCY_CODE = FALLBACK_DEFAULT_CURRENCY;

/** The translated message for each price-symbol refusal. */
const QUOTE_SYMBOL_REFUSAL_MESSAGES: Record<
  QuoteSymbolRefusal,
  (code: string, quoteSymbol: string) => string
> = {
  quoteSymbolRequiresCrypto: (code, quoteSymbol) =>
    tr(
      "errors.currencies.quoteSymbolRequiresCrypto",
      `A price symbol (${quoteSymbol}) can only be set on a cryptocurrency; "${code}" is a fiat currency`,
      { code, quoteSymbol },
    ),
  quoteSymbolNotAPair: (code, quoteSymbol) =>
    tr(
      "errors.currencies.quoteSymbolNotAPair",
      `The price symbol "${quoteSymbol}" for "${code}" is not a coin and fiat pair such as BTC-EUR`,
      { code, quoteSymbol },
    ),
};

@Injectable()
export class CurrenciesService implements OnApplicationBootstrap {
  private readonly logger = new Logger(CurrenciesService.name);

  constructor(
    private dataSource: DataSource,
    private readonly fxProviders: FxProviderChain,
    /**
     * Told when a currency row changes, so the codes it prices are re-read
     * on its next question instead of after its cache expires. Optional: a
     * caller that builds this service without the chain's crypto adapter
     * loses nothing but the early refresh.
     */
    @Optional() private readonly cryptoFx?: CryptoFxProvider,
    /**
     * Told when a coin's price symbol is first set or re-pointed, so the
     * windows this process remembers as empty for the code are asked again.
     * Optional for the same reason as `cryptoFx`.
     */
    @Optional() private readonly rateHistory?: ExchangeRateHistoryService,
  ) {}

  /**
   * Currencies are created on demand rather than pre-seeded, but a brand-new
   * instance still needs the default-preference currency to exist: registration
   * writes user_preferences.default_currency = 'USD', which has a foreign key to
   * currencies(code). Guarantee that single currency on startup so the first
   * user can register before anyone picks a currency at onboarding. Idempotent.
   *
   * RLS: this is a bootstrap hook, so there is no request/user context for
   * `withScopedDb` to spend -- and the row it writes is a system currency owned
   * by nobody. It runs under `withSystemContext`, like the seeders (C3).
   */
  async onApplicationBootstrap(): Promise<void> {
    try {
      await withSystemContext(() =>
        this.ensureBootstrapCurrency(DEFAULT_CURRENCY_CODE),
      );
    } catch (err) {
      this.logger.warn(
        `Could not ensure default currency ${DEFAULT_CURRENCY_CODE} on startup: ${err?.message ?? err}`,
      );
    }
  }

  async create(
    userId: string,
    dto: CreateCurrencyDto,
  ): Promise<UserCurrencyView> {
    const code = dto.code.toUpperCase();

    // One transaction: every branch below is "look, then insert", so splitting
    // the read from the write would let a concurrent request slip between them.
    const view = await withScopedDb(this.dataSource, async (manager) =>
      this.createWithin(manager, userId, dto, code),
    );
    this.cryptoFx?.forgetCurrencies();
    return view;
  }

  private async createWithin(
    manager: EntityManager,
    userId: string,
    dto: CreateCurrencyDto,
    code: string,
  ): Promise<UserCurrencyView> {
    const currencyRepo = manager.getRepository(Currency);

    const existing = await currencyRepo.findOne({
      where: { code },
    });

    if (existing) {
      // A request that states a kind is a statement about the currency, not a
      // preference: a code that already exists in the other kind is refused
      // rather than handed back silently (a CRYPTO request answered with a
      // FIAT row, INV-CRYPTO-001). A request without a kind adopts the row.
      const existingKind = existing.kind ?? DEFAULT_CURRENCY_KIND;
      if (dto.kind !== undefined && dto.kind !== existingKind) {
        throw new ConflictException(
          tr(
            "errors.currencies.kindConflict",
            `Currency "${code}" already exists as a ${existingKind} currency and cannot be added as ${dto.kind}`,
            { code, kind: existingKind, requestedKind: dto.kind },
          ),
        );
      }

      // Check if this user already has this currency in their list
      const existingPref = await manager
        .getRepository(UserCurrencyPreference)
        .findOne({
          where: { userId, currencyCode: code },
        });
      if (existingPref) {
        // Distinguish an already-active currency from one the user previously
        // deactivated: the inactive case ships a machine-readable `errorCode`
        // so the UI can offer to reactivate it instead of leaving the user
        // stuck (the currency is hidden from their active list).
        if (!existingPref.isActive) {
          throw new ConflictException({
            message: tr(
              "errors.currencies.alreadyInListInactive",
              `Currency "${code}" is already in your list but currently inactive. Reactivate it to use it.`,
              { code },
            ),
            errorCode: "CURRENCY_INACTIVE",
            currencyCode: code,
          });
        }
        throw new ConflictException(
          tr(
            "errors.currencies.alreadyInList",
            `Currency "${code}" is already in your list`,
            { code },
          ),
        );
      }

      // Add preference row so user can see/use the existing currency
      await manager.query(
        `INSERT INTO user_currency_preferences (user_id, currency_code, is_active)
         VALUES ($1, $2, true)
         ON CONFLICT (user_id, currency_code) DO NOTHING`,
        [userId, code],
      );

      return this.buildUserCurrencyView(existing, true);
    }

    // Currency doesn't exist — create it as a user-created currency. Its kind
    // is the reader's statement, FIAT unless they said CRYPTO; a price symbol
    // is held to the kind before anything is written.
    const kind = dto.kind ?? DEFAULT_CURRENCY_KIND;
    const quoteSymbol = dto.quoteSymbol ?? null;
    this.assertQuoteSymbol(kind, quoteSymbol, code);
    const currency = currencyRepo.create({
      ...dto,
      code,
      kind,
      quoteSymbol,
      decimalPlaces:
        dto.decimalPlaces ??
        (kind === "CRYPTO" ? CRYPTO_DEFAULT_DECIMAL_PLACES : 2),
      isActive: true,
      createdByUserId: userId,
    });
    await currencyRepo.save(currency);

    // Add preference row for the creator
    await manager.query(
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
             c.created_at AS "createdAt",
             c.kind,
             c.quote_symbol AS "quoteSymbol"
      FROM currencies c
      LEFT JOIN user_currency_preferences ucp
        ON ucp.currency_code = c.code AND ucp.user_id = $1
      WHERE (c.created_by_user_id IS NULL OR ucp.user_id IS NOT NULL)`;

    if (!includeInactive) {
      query += ` AND COALESCE(ucp.is_active, c.is_active) = true`;
    }

    query += ` ORDER BY c.code ASC`;

    // One transaction around the whole block: the lazy-create fallback re-runs
    // the same query and must see the row it just wrote. The nested
    // `ensureCurrencyForUser` joins this transaction (scoped-db re-entrancy).
    return withScopedDb(this.dataSource, async (manager) => {
      const rows: UserCurrencyView[] = await manager.query(query, [userId]);

      // A fresh instance no longer pre-seeds a list of currencies; the user's
      // chosen currency is created when they pick it at onboarding. If they
      // skipped onboarding this list is empty on first use, so lazily create
      // their default-preference currency (with a proper symbol) here.
      if (rows.length === 0) {
        const prefRows: Array<{ default_currency: string | null }> =
          await manager.query(
            `SELECT default_currency FROM user_preferences WHERE user_id = $1`,
            [userId],
          );
        const defaultCurrency = prefRows[0]?.default_currency;
        if (defaultCurrency) {
          await this.ensureCurrencyForUser(userId, defaultCurrency);
          return manager.query(query, [userId]);
        }
      }

      return rows;
    });
  }

  /**
   * The catalog of known currencies (curated metadata) used to populate the
   * onboarding picker without pre-seeding every currency into the database.
   */
  getCatalog(): CurrencyCatalogEntry[] {
    return getCurrencyCatalog().map((entry) => ({
      ...entry,
      kind: DEFAULT_CURRENCY_KIND,
    }));
  }

  /**
   * Ensure the bootstrap system currency row exists, creating it from the
   * curated/derived metadata (name, symbol, decimal places) when missing. It is
   * ACTIVE and owned by nobody, so every user is offered it: that is right for
   * the one default-preference currency and wrong for anything else. Called only
   * from `onApplicationBootstrap`, never from a user's request -- a request
   * goes through `ensureCurrencyForUser`.
   */
  private async ensureBootstrapCurrency(code: string): Promise<void> {
    await this.insertSystemCurrencyIfMissing(code, true);
  }

  /**
   * Make `code` usable by `userId` -- as the default-currency preference, or as
   * the currency an imported account, security or rate is priced in -- without
   * offering it to anybody else. A user's action never creates a currency every
   * other user is shown: a known ISO 4217 code becomes an inactive reference row
   * (as the bond catalog's does, and owned by nobody), and anything else is the
   * user's own custom currency. Either way only this user's preference row is
   * activated.
   *
   * One `withScopedDb`: it joins the caller's transaction, so a preference
   * written after this call in the same transaction finds its foreign key. The
   * insert is `ON CONFLICT DO NOTHING`, so an existing row (active, inactive,
   * system or somebody's own) is left as it is.
   */
  async ensureCurrencyForUser(userId: string, code: string): Promise<void> {
    const upper = code.toUpperCase();
    if (!/^[A-Z]{3}$/.test(upper)) {
      throw new BadRequestException(
        tr(
          "errors.common.currencyCodeInvalid",
          "Currency code must be exactly 3 letters (e.g., USD, CAD)",
        ),
      );
    }

    await withScopedDb(this.dataSource, async (manager) => {
      const existing = await manager.getRepository(Currency).findOne({
        where: { code: upper },
      });
      if (!existing) {
        const meta = resolveCurrencyMetadata(upper);
        const isReference = isKnownIsoCurrency(upper);
        // FIAT, always, a non-ISO code included: a code is never evidence of a
        // coin (decision 1), and a reader who means one says so on the
        // Currencies page.
        await manager.query(
          `INSERT INTO currencies (code, name, symbol, decimal_places, is_active, created_by_user_id, kind)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (code) DO NOTHING`,
          [
            upper,
            meta.name,
            meta.symbol,
            meta.decimalPlaces,
            !isReference,
            isReference ? null : userId,
            DEFAULT_CURRENCY_KIND,
          ],
        );
        this.cryptoFx?.forgetCurrencies();
      }

      await manager.query(
        `INSERT INTO user_currency_preferences (user_id, currency_code, is_active)
         VALUES ($1, $2, true)
         ON CONFLICT (user_id, currency_code) DO UPDATE SET is_active = true`,
        [userId, upper],
      );
    });
  }

  /**
   * Ensure the currency a reference catalog row is priced in exists, without
   * offering it to anyone: a deployment's users did not choose it, so it is
   * created inactive (`findAll` lists only what a user has activated or what is
   * active globally) and stays selectable by code through `create`. Used only
   * by the bond catalog (its seed and a series fetch); an existing row, active or not, is left as is.
   */
  async ensureCatalogCurrency(code: string): Promise<void> {
    await this.insertSystemCurrencyIfMissing(code, false);
  }

  private async insertSystemCurrencyIfMissing(
    code: string,
    active: boolean,
  ): Promise<void> {
    const upper = code.toUpperCase();
    // A fixed fragment, never caller text.
    const isActive = active ? "true" : "false";
    await withScopedDb(this.dataSource, async (manager) => {
      const existing = await manager.getRepository(Currency).findOne({
        where: { code: upper },
      });
      if (existing) return;

      const meta = resolveCurrencyMetadata(upper);
      await manager.query(
        `INSERT INTO currencies (code, name, symbol, decimal_places, is_active, created_by_user_id, kind)
       VALUES ($1, $2, $3, $4, ${isActive}, NULL, $5)
       ON CONFLICT (code) DO NOTHING`,
        [
          upper,
          meta.name,
          meta.symbol,
          meta.decimalPlaces,
          DEFAULT_CURRENCY_KIND,
        ],
      );
    });
    this.cryptoFx?.forgetCurrencies();
  }

  /**
   * Lock the custom currencies `userId` created and return their codes, in code
   * order. Called in the transaction that deletes the user, before the user row
   * goes: the lock keeps a concurrent activation from committing a reference
   * between this decision and `removeUnreferencedCurrencies`.
   */
  async lockCurrenciesCreatedBy(
    manager: EntityManager,
    userId: string,
  ): Promise<string[]> {
    const rows: Array<{ code: string }> = await manager.query(
      `SELECT code FROM currencies WHERE created_by_user_id = $1 ORDER BY code FOR UPDATE`,
      [userId],
    );
    return rows.map((row) => row.code);
  }

  /**
   * After a user is deleted, remove the currencies they created that nothing
   * references any more. The foreign key's ON DELETE SET NULL has by then turned
   * each into a system row (a trigger deactivated it), so only a row with no
   * creator is deleted, and only when `currency_code_in_use_globally` says
   * nobody -- including rows this scope cannot see -- still points at it.
   *
   * Lock the candidates (`lockCurrenciesCreatedBy`), then decide here, one code
   * at a time on the transaction's single connection: the CONC-008 rule.
   */
  async removeUnreferencedCurrencies(
    manager: EntityManager,
    codes: string[],
  ): Promise<void> {
    for (const code of codes) {
      if (await this.isInUseGlobally(manager, code)) continue;
      await manager.query(
        `DELETE FROM currencies WHERE code = $1 AND created_by_user_id IS NULL`,
        [code],
      );
    }
  }

  async findOne(code: string): Promise<Currency> {
    const currency = await withScopedDb(this.dataSource, (manager) =>
      manager.getRepository(Currency).findOne({
        where: { code: code.toUpperCase() },
      }),
    );
    if (!currency) {
      throw new NotFoundException(
        tr("errors.currencies.notFound", `Currency "${code}" not found`, {
          code,
        }),
      );
    }
    return currency;
  }

  async update(
    userId: string,
    code: string,
    dto: UpdateCurrencyDto,
  ): Promise<UserCurrencyView> {
    // Read-modify-write: the ownership check, the metadata save and the
    // preference upsert are one unit. Nested calls join this transaction.
    const { view, repriced } = await withScopedDb(this.dataSource, (manager) =>
      this.updateWithin(manager, userId, code, dto),
    );
    this.cryptoFx?.forgetCurrencies();
    // After the commit, beside the coverage rows the transaction deleted: a
    // fill between the two finds no coverage and asks the provider, which is
    // the point. Only this process's memory; see `forgetEmptyWindowsFor`.
    if (repriced) this.rateHistory?.forgetEmptyWindowsFor(view.code);
    return view;
  }

  private async updateWithin(
    manager: EntityManager,
    userId: string,
    code: string,
    dto: UpdateCurrencyDto,
  ): Promise<{ view: UserCurrencyView; repriced: boolean }> {
    const currency = await this.findOne(code);

    // System currencies: cannot modify metadata
    if (currency.createdByUserId === null) {
      throw new ForbiddenException(
        tr(
          "errors.currencies.cannotModifySystem",
          "Cannot modify system currency metadata",
        ),
      );
    }

    // Non-system currencies: only the creator can modify metadata
    if (currency.createdByUserId !== userId) {
      throw new ForbiddenException(
        tr(
          "errors.currencies.cannotModifyOther",
          "Cannot modify another user's currency",
        ),
      );
    }

    // Handle isActive separately via preference row
    const { isActive, kind, quoteSymbol, ...rest } = dto;
    if (rest.decimalPlaces !== undefined) {
      await this.assertDecimalPlacesFit(
        manager,
        currency.code,
        currency.decimalPlaces,
        rest.decimalPlaces,
      );
    }
    const { updates: kindUpdates, repriced } = await this.kindUpdates(
      manager,
      currency,
      kind,
      quoteSymbol,
    );
    const metadataUpdates: Partial<Currency> = { ...rest, ...kindUpdates };

    if (Object.keys(metadataUpdates).length > 0) {
      Object.assign(currency, metadataUpdates);
      await manager.getRepository(Currency).save(currency);
    }

    if (isActive !== undefined) {
      await this.upsertPreference(userId, currency.code, isActive);
    }

    const pref = await manager.getRepository(UserCurrencyPreference).findOne({
      where: { userId, currencyCode: currency.code },
    });

    return {
      view: this.buildUserCurrencyView(
        currency,
        pref ? pref.isActive : currency.isActive,
      ),
      repriced,
    };
  }

  /**
   * Refuse lowering `decimal_places` below what stored amounts already carry
   * (`docs/specs/money-precision.md`, INV-MONEY-001). Every amount in the
   * currency is held at `moneyDecimalsFor(decimal_places)` places; a smaller
   * precision would leave rows the write paths then refuse (`amountPrecisionExceeded`)
   * on an unchanged edit. Raising is free. The row is locked first, as
   * `kindUpdates` does, and the current value is read under that lock, so a
   * concurrent update cannot slip a lower value past the check; the lock is
   * taken only for a request that lowers the value as last read.
   *
   * The scan is `currency_min_decimal_places_in_use`, SECURITY DEFINER, so it
   * covers every user's amounts in the currency rather than the editing user's
   * RLS view: transactions, their splits, account balances and thresholds,
   * scheduled transactions, their splits and overrides. It answers the smallest
   * `decimalPlaces` every stored amount fits; the refusal names it.
   */
  private async assertDecimalPlacesFit(
    manager: EntityManager,
    code: string,
    readPlaces: number,
    requestedPlaces: number,
  ): Promise<void> {
    if (requestedPlaces >= readPlaces) return;
    const locked: Array<{ decimal_places: number | string | null }> =
      await manager.query(
        "SELECT decimal_places FROM currencies WHERE code = $1 FOR UPDATE",
        [code],
      );
    const lockedValue = locked[0]?.decimal_places;
    const currentPlaces =
      lockedValue == null ? readPlaces : Number(lockedValue);
    if (requestedPlaces >= currentPlaces) return;

    const allowed = moneyDecimalsFor(requestedPlaces);
    if (allowed >= MONEY_SCALE) return;
    const rows: Array<{ fitting: number | string | null }> =
      await manager.query(
        `SELECT currency_min_decimal_places_in_use($1) AS "fitting"`,
        [code],
      );
    const fitting = Number(rows[0]?.fitting ?? 0);
    if (fitting <= allowed) return;
    throw new ConflictException(
      tr(
        "errors.currencies.decimalPlacesInUse",
        `The decimal places of "${code}" cannot be lowered below ${fitting} while accounts, transactions or other records hold amounts with that many places`,
        { code, places: fitting },
      ),
    );
  }

  /**
   * The `kind` and `quote_symbol` an update writes, refused before anything is
   * written (`docs/specs/crypto-accounts.md`, section 5). A field the request
   * resent unchanged is not a change. A new kind is refused on a code any row
   * anywhere uses (`currency_code_referenced_by_data`: every column
   * `currency-reference-columns.ts` names except activations): a CRYPTO
   * account's currency turning FIAT under it would break INV-CRYPTO-001. An
   * activation is not a use -- every creator holds one -- so a kind stays
   * changeable until something financial references the code. The row is locked first,
   * as `removeWithin` does, so a reference committed while this decides waits
   * for it. A currency turning FIAT drops a symbol the request did not restate;
   * one the request names on a FIAT row is refused.
   *
   * A new coin ticker on a CRYPTO row (`quoteSymbolCoinTicker` of the new
   * symbol differs from the old one's, including removing the symbol) is held
   * like a kind change: `currencies` is shared, so re-pointing `BTC` from
   * `BTC-EUR` to `ETH-EUR` would revalue every other user's wallet in it at
   * another coin's price. Refused `quoteSymbolInUse` once data references the
   * code. A new fiat leg alone (`BTC-EUR` to `BTC-CAD`) is allowed on a
   * referenced coin, because the provider prices against whichever fiat the
   * pair names, not the one in the symbol; so is a first symbol on a coin that
   * had none.
   *
   * `repriced` is whether the coin the code is priced through changed: a
   * CRYPTO row's coin ticker first set or changed, including a first symbol
   * and a kind change to CRYPTO with one. Its `exchange_rate_coverage` rows
   * (either code order) are deleted here, in the update's transaction: a fill
   * under the old ticker, or under none, recorded where the provider's
   * history starts for a symbol that no longer prices the code, and the
   * provider fingerprint those rows are scoped to does not change with a
   * symbol (INV-FX-005). The caller forgets the process's empty windows after
   * the commit.
   */
  private async kindUpdates(
    manager: EntityManager,
    currency: Currency,
    requestedKind: CurrencyKind | undefined,
    requestedQuoteSymbol: string | null | undefined,
  ): Promise<{
    updates: Partial<Pick<Currency, "kind" | "quoteSymbol">>;
    repriced: boolean;
  }> {
    const currentKind = currency.kind ?? DEFAULT_CURRENCY_KIND;
    const kind = requestedKind ?? currentKind;
    const kindChanged = kind !== currentKind;
    const quoteSymbol =
      requestedQuoteSymbol !== undefined
        ? requestedQuoteSymbol
        : kind === "CRYPTO"
          ? (currency.quoteSymbol ?? null)
          : null;
    this.assertQuoteSymbol(kind, quoteSymbol, currency.code);

    const currentSymbol = currency.quoteSymbol ?? null;
    const tickerOf = (symbol: string | null) =>
      symbol === null ? null : quoteSymbolCoinTicker(symbol);
    const coinTickerChanged =
      kind === "CRYPTO" && tickerOf(quoteSymbol) !== tickerOf(currentSymbol);
    // Held like a kind change only when a ticker was there to change: a first
    // symbol on a coin that had none is allowed on a referenced coin.
    const tickerChanged =
      !kindChanged && currentSymbol !== null && coinTickerChanged;

    if (kindChanged || tickerChanged) {
      await manager.query(
        "SELECT 1 FROM currencies WHERE code = $1 FOR UPDATE",
        [currency.code],
      );
      if (await this.isReferencedByData(manager, currency.code)) {
        throw new ConflictException(
          kindChanged
            ? tr(
                "errors.currencies.kindInUse",
                `The kind of "${currency.code}" cannot change while accounts, transactions, securities or other records use it`,
                { code: currency.code },
              )
            : tr(
                "errors.currencies.quoteSymbolInUse",
                `The coin in the price symbol of "${currency.code}" cannot change while accounts, transactions, securities or other records use it; only its fiat side can`,
                { code: currency.code },
              ),
        );
      }
    }

    if (coinTickerChanged) {
      await manager.query(
        `DELETE FROM exchange_rate_coverage
          WHERE from_currency = $1 OR to_currency = $1`,
        [currency.code],
      );
    }

    const updates: Partial<Pick<Currency, "kind" | "quoteSymbol">> = {};
    if (kindChanged) updates.kind = kind;
    if (quoteSymbol !== (currency.quoteSymbol ?? null)) {
      updates.quoteSymbol = quoteSymbol;
    }
    return { updates, repriced: coinTickerChanged };
  }

  /** Refuse a price symbol the kind does not admit, by the section 5 table. */
  private assertQuoteSymbol(
    kind: CurrencyKind,
    quoteSymbol: string | null,
    code: string,
  ): void {
    const refusal = quoteSymbolRefusal(kind, quoteSymbol);
    if (refusal === null) return;
    throw new BadRequestException(
      QUOTE_SYMBOL_REFUSAL_MESSAGES[refusal](code, quoteSymbol ?? ""),
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
    // The in-use checks and the two deletes are one read-modify-write: a
    // concurrent account referencing the currency between them would strand a
    // foreign key. Nested calls join this transaction.
    await withScopedDb(this.dataSource, (manager) =>
      this.removeWithin(manager, userId, code),
    );
  }

  private async removeWithin(
    manager: EntityManager,
    userId: string,
    code: string,
  ): Promise<void> {
    const upperCode = code.toUpperCase();
    const currency = await this.findOne(upperCode);

    // Lock the parent row before anything that depends on its liveness.
    //
    // Without this, the transaction boundary alone is not enough. A concurrent
    // activation is an INSERT into `user_currency_preferences`, whose FK to
    // `currencies(code)` is `ON DELETE CASCADE`: another user could insert and
    // commit a preference after the global liveness check said the code was free
    // and before the DELETE ran, and the cascade then removed the row they had
    // just been told was saved. They got a success response and lost the setting.
    //
    // `FOR UPDATE` on the parent is what serialises this, and it does so through
    // the FK machinery rather than in spite of it: an FK check takes `FOR KEY
    // SHARE` on the parent row, which conflicts with `FOR UPDATE`. So B's insert
    // waits, and once this transaction commits the delete, B's FK check fails
    // with a plain violation -- a clear error instead of a silent removal.
    //
    // `findOne` above is a plain read and cannot carry the lock, so this is a
    // separate statement rather than a locked variant of it: the row identity is
    // already known, and what is needed here is the lock, not the columns.
    await manager.query("SELECT 1 FROM currencies WHERE code = $1 FOR UPDATE", [
      upperCode,
    ]);

    // Check if in use by this user
    const inUse = await this.isInUse(userId, upperCode);
    if (inUse) {
      throw new ConflictException(
        tr(
          "errors.currencies.inUse",
          `Currency "${code}" is in use by your accounts, securities, or other records. Deactivate it instead.`,
          { code },
        ),
      );
    }

    const prefRepo = manager.getRepository(UserCurrencyPreference);

    // Remove this user's preference row
    await prefRepo.delete({
      userId,
      currencyCode: upperCode,
    });

    // The currency row itself is cleaned up only by its **creator**, and only
    // when nothing anywhere still points at it (INV-CURRENCY-001). Deactivation
    // above is every activator's own action, so a non-creator reaches here too
    // -- but `createdByUserId !== null` ("is this a custom currency") was the
    // wrong gate: it let user B, who had merely activated user A's custom
    // currency, delete A's shared row out from under them once the global count
    // hit zero. The row belongs to A; B removing their activation leaves it for
    // A to keep or clean up. `=== userId` is the creator check, and because
    // `userId` is never null it still skips system currencies exactly as before.
    //
    // The preference row above is deleted as of this transaction, so a remaining
    // reference is somebody else's -- and the check has to be able to see
    // somebody else's rows, which is what makes it a SECURITY DEFINER function
    // rather than a query here.
    //
    // The counting query this replaced (`prefRepo.count({ currencyCode })`) ran
    // under the caller's RLS scope, so it only ever counted the row just
    // deleted: it reported zero for a code another user had activated, and the
    // ON DELETE CASCADE on `user_currency_preferences.currency_code` then took
    // that user's activation with it.
    if (currency.createdByUserId === userId) {
      if (!(await this.isInUseGlobally(manager, upperCode))) {
        await manager.getRepository(Currency).remove(currency);
      }
    }
  }

  /**
   * Does this user's own data still depend on `code`?
   *
   * The referencing columns are not spelled out here. They were, and the list
   * was missing `budgets.currency_code`: a user with a budget denominated in a
   * custom currency was told the code was not "in use by your accounts,
   * securities, or other records", had their activation row deleted, and was
   * left holding a budget in a currency that no longer appeared anywhere in
   * their settings -- so they could neither see it nor reactivate it. That is
   * the third time this list has been written out and been wrong, which is why
   * it now lives in `currency_codes_referenced_by_user_data` (migration 137)
   * where `currency-references.spec.ts` can check it against the schema.
   *
   * The `_data` variant, not the composite: this runs *before* the caller's own
   * `user_currency_preferences` row is deleted, and the composite counts that
   * row -- so it would report every visible currency as in use and no currency
   * could ever be deleted.
   */
  async isInUse(userId: string, code: string): Promise<boolean> {
    const result = await withScopedDb(this.dataSource, (manager) =>
      manager.query(
        `SELECT EXISTS (
           SELECT 1 FROM currency_codes_referenced_by_user_data($2) AS referenced(code)
            WHERE referenced.code = $1
         ) AS "inUse"`,
        [code.toUpperCase(), userId],
      ),
    );
    return result[0]?.inUse === true;
  }

  async getUsage(userId: string): Promise<CurrencyUsageMap> {
    const rows: Array<{
      code: string;
      accounts: string;
      securities: string;
    }> = await withScopedDb(this.dataSource, (manager) =>
      manager.query(
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
      ),
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

      // 3. Fall back to the providers' free-text search for unknown currencies
      const resultCode = await this.fxProviders.searchCurrency(trimmed);
      if (resultCode === null) {
        return null;
      }

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
    await withScopedDb(this.dataSource, (manager) =>
      manager.query(
        `INSERT INTO user_currency_preferences (user_id, currency_code, is_active)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id, currency_code)
       DO UPDATE SET is_active = $3`,
        [userId, code.toUpperCase(), isActive],
      ),
    );
  }

  /**
   * Whether any row anywhere still references the code -- including rows this
   * tenant cannot see.
   *
   * Written out here, this query answered a different question than its name
   * claimed. It listed only some of the columns that reference
   * `currencies(code)` (missing `budgets.currency_code` and both
   * `exchange_rates` columns), and it ran inside the caller's scoped
   * transaction, where RLS filters every table to the current user. So
   * "referenced by anybody" was really "referenced by me" -- and the caller had
   * already established that it was not, which made the check a no-op that
   * cleared the way for the `user_currency_preferences` cascade to delete
   * another user's activation.
   *
   * `currency_code_in_use_globally` (migration 136) is SECURITY DEFINER, so it
   * sees every row, and it runs inside this transaction, so the answer cannot
   * go stale between the check and the delete it guards.
   */
  private async isInUseGlobally(
    manager: EntityManager,
    code: string,
  ): Promise<boolean> {
    const result = await manager.query(
      `SELECT currency_code_in_use_globally($1) AS "inUse"`,
      [code.toUpperCase()],
    );
    return result[0]?.inUse === true;
  }

  /**
   * Whether any row anywhere other than a `user_currency_preferences`
   * activation references the code, including rows this tenant cannot see:
   * `currency_code_referenced_by_data`, the sibling of
   * `currency_code_in_use_globally` with activations left out, SECURITY
   * DEFINER and run in this transaction after the caller's row lock.
   */
  private async isReferencedByData(
    manager: EntityManager,
    code: string,
  ): Promise<boolean> {
    const result = await manager.query(
      `SELECT currency_code_referenced_by_data($1) AS "inUse"`,
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
      kind: currency.kind ?? DEFAULT_CURRENCY_KIND,
      quoteSymbol: currency.quoteSymbol ?? null,
    };
  }

  /**
   * Search CURRENCY_METADATA entries by name text (case-insensitive substring match).
   * Supports queries like "Malaysia", "Ringgit", "Canadian Dollar", "Japan", etc.
   */
  private searchMetadataByText(
    query: string,
  ): { code: string; metadata: CurrencyMetadata } | null {
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
      metadata: CurrencyMetadata;
    }> = [];
    for (const [code, meta] of Object.entries(CURRENCY_METADATA)) {
      if (meta.name.toLowerCase().includes(lowerQuery)) {
        matches.push({ code, metadata: meta });
      }
    }

    return matches.length === 1 ? matches[0] : null;
  }

  /**
   * Verify a currency through the configured exchange rate providers and
   * return our metadata. A code some provider carries is verified without a
   * call; otherwise each provider that can verify one is asked. The local
   * metadata is the name and symbol source either way, and an unverified code
   * is still returned: verification is a lookup aid, not a gate.
   */
  private async verifyAndReturnCurrency(
    code: string,
    metadata: CurrencyMetadata,
  ): Promise<CurrencyLookupResult> {
    try {
      if (!(await this.fxProviders.carriesAny(code))) {
        const known = await this.fxProviders.verifyCurrency(code);
        if (known !== true) {
          this.logger.debug(
            known === false
              ? `No configured exchange rate provider knows ${code}; returning local metadata`
              : `No configured exchange rate provider could verify ${code}; returning local metadata`,
          );
        }
      }
    } catch (err) {
      this.logger.debug(
        `Provider verification failed for ${code}, falling back to local metadata: ${err instanceof Error ? err.message : err}`,
      );
    }

    return {
      code,
      name: metadata.name,
      symbol: metadata.symbol,
      decimalPlaces: metadata.decimalPlaces,
    };
  }
}
