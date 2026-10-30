import {
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ConflictException,
  ForbiddenException,
  BadRequestException,
  forwardRef,
} from "@nestjs/common";
import { tr } from "../i18n/translate";
import { DataSource, EntityManager, In } from "typeorm";
import { acquireAdvisoryLock, LockScope } from "../common/db/locks";
import { withScopedDb } from "../common/db/scoped-db";
import { returnedRows } from "../common/db/query-result";
import { findTradeListings } from "./trade-listings";
import { Security } from "./entities/security.entity";
import { SecurityTag } from "./entities/security-tag.entity";
import { Holding } from "./entities/holding.entity";
import { InvestmentTransaction } from "./entities/investment-transaction.entity";
import { Tag } from "../tags/entities/tag.entity";
import { CreateSecurityDto } from "./dto/create-security.dto";
import { UpdateSecurityDto } from "./dto/update-security.dto";
import {
  PriceUpdateResult,
  SecurityPriceService,
} from "./security-price.service";
import { BondPriceService } from "../bonds/bond-price.service";
import { BondSeriesService } from "../bonds/bond-series.service";
import { SeriesFetchError } from "../bonds/bond-adapter";
import { clearForeignSeries } from "../bonds/bond-series-resolver";
import {
  BondLinkProblem,
  findBondLinkProblem,
  hasQuantitiesThatAreNotBonds,
} from "./bond-link.util";
import { YahooFinanceService } from "./yahoo-finance.service";
import { ActionHistoryService } from "../action-history/action-history.service";
import { SecurityLookupResult } from "./providers/quote-provider.interface";
import { UserPreference } from "../users/entities/user-preference.entity";
import { normalizeWebsite } from "../common/normalize-website";
import {
  normalizeCountryName,
  normalizeAssetName,
  isOtherAllocationName,
  countryForCurrency,
  COUNTRY_OPTIONS,
} from "./security-enums";
import { todayYMD } from "../common/date-utils";
import {
  DailyPriceChange,
  PricePoint,
  resolveDailyPriceChange,
} from "./daily-change.util";

/**
 * A security decorated with what its most recent price row says.
 *
 * Both fields are null when the security has no prices at all. `lastPrice` is
 * the quoted close in the security's **own** currency -- nothing here converts,
 * so the securities list can multiply it by the shares held without a rate, and
 * a null is "no price", never a zero to multiply through.
 */
export type SecurityWithLatestPrice = Security & {
  lastPriceSource: string | null;
  lastPrice: number | null;
};

/** A single {name, weight} allocation slice; weight is a decimal 0-1. */
export interface AllocationWeight {
  name: string;
  weight: number;
}

export interface FavouriteSecurityQuote {
  securityId: string;
  symbol: string;
  name: string;
  currencyCode: string;
  currentPrice: number | null;
  previousPrice: number | null;
  /**
   * The day-over-day move, or `null` when the stored prices describe no daily
   * move: fewer than two closes, a zero base, two closes that are not adjacent
   * sessions, or a newest close that is no longer the current session.
   * `daily-change.util.ts` decides which. Never 0 for those cases -- a zero
   * change is a security that held its price, which is a different fact.
   */
  dailyChange: number | null;
  dailyChangePercent: number | null;
  /** The session the change is for, or `null` when there is no change to date. */
  priceDate: string | null;
}

/**
 * Outcome of resolving a free-text security reference (symbol or name).
 * `match` is the single resolved security; when the reference is ambiguous,
 * `match` is null and `candidates` lists the securities it could mean so the
 * caller can ask the user to disambiguate.
 */
export interface SecurityMatchResult {
  match: Security | null;
  candidates: Security[];
}

/**
 * Resolved, validated security a `create_security` proposal will persist. The
 * symbol/name/exchange/securityType/currency are filled from the user's
 * configured quote provider (Yahoo/MSN) so the AI does not invent them; an
 * AI-supplied `exchange`/`securityType` (constrained to the known lists)
 * overrides the looked-up value when given. Display-only on the confirmation
 * card and turned into a signed descriptor by the action builder.
 */
export interface CreateSecurityPreview {
  symbol: string;
  name: string;
  securityType: string | null;
  exchange: string | null;
  currencyCode: string;
  isFavourite: boolean;
  quoteProvider: "yahoo" | "msn" | "lse" | "deutsche_boerse" | null;
  msnInstrumentId: string | null;
}

/**
 * Resolved preview of a proposed security edit. Carries the resulting
 * classification/display fields so the confirmation card shows what the edit
 * will do and confirm applies an idempotent overwrite of the identified
 * security.
 */
export interface UpdateSecurityPreview {
  securityId: string;
  symbol: string;
  name: string;
  securityType: string | null;
  exchange: string | null;
  currencyCode: string;
  isFavourite: boolean;
  /** Manual country allocation (decimal 0-1 weights), when the edit sets it. */
  countryWeightings: { name: string; weight: number }[] | null;
  /** Manual asset-class allocation (decimal 0-1 weights), when the edit sets it. */
  assetWeightings: { name: string; weight: number }[] | null;
}

/** Resolved preview of a proposed security deletion. */
export interface DeleteSecurityPreview {
  securityId: string;
  symbol: string;
  name: string;
}

/** One candidate returned by the LLM/MCP security lookup tool. */
export interface LlmSecurityLookupCandidate {
  symbol: string;
  name: string;
  exchange: string | null;
  securityType: string | null;
  currencyCode: string | null;
  /** Quote provider that produced this match (yahoo/msn), when known. */
  provider: string | null;
  /** True when a security with this symbol is already in the user's list. */
  alreadyAdded: boolean;
}

/** Compact, LLM-friendly result of a Yahoo/MSN security lookup. */
export interface LlmSecurityLookup {
  query: string;
  count: number;
  candidates: LlmSecurityLookupCandidate[];
}

/** One security held in an account, as listed by `manage_securities`. */
export interface LlmAccountSecurity {
  symbol: string;
  name: string;
  securityType: string | null;
  exchange: string | null;
  currencyCode: string;
  isFavourite: boolean;
  quantity: number;
  averageCost: number | null;
}

@Injectable()
export class SecuritiesService {
  private readonly logger = new Logger(SecuritiesService.name);

  constructor(
    private securityPriceService: SecurityPriceService,
    private yahooFinanceService: YahooFinanceService,
    private actionHistoryService: ActionHistoryService,
    private dataSource: DataSource,
    // forwardRef: BondsModule reaches NetWorthModule, which lies on a cycle with
    // this module (see bonds.module.ts).
    @Inject(forwardRef(() => BondPriceService))
    private bondPriceService: BondPriceService,
    @Inject(forwardRef(() => BondSeriesService))
    private bondSeriesService: BondSeriesService,
  ) {}

  /**
   * Refuse a bond link that is not valid, inside the write's own transaction and
   * before the write: the instrument must exist, the security must be of type
   * BOND, and it must be priced in the security's resulting currency
   * (`findBondLinkProblem`, the one definition the AI/MCP preview and the undo of
   * a security edit share). `currencyChanged` picks the message for a currency
   * change of a security that stays linked. `legacyQuantities`, given for a link
   * that is being set, also refuses a security whose trades price a unit far
   * from the face value per bond: its quantities are not numbers of bonds.
   */
  private async assertBondLink(
    m: EntityManager,
    link: {
      bondProgramId: string;
      currencyCode: string;
      securityType: string | null | undefined;
    },
    currencyChanged: boolean,
    legacyQuantities?: { userId: string; securityId: string },
  ): Promise<void> {
    const problem = await findBondLinkProblem(m, link);
    if (problem) this.throwBondLinkProblem(problem, link, currencyChanged);
    if (
      legacyQuantities &&
      (await hasQuantitiesThatAreNotBonds(
        m,
        legacyQuantities.userId,
        legacyQuantities.securityId,
        link.bondProgramId,
      ))
    ) {
      throw new BadRequestException(
        tr(
          "errors.bonds.LINK_QUANTITY_NOT_BONDS",
          "The quantities of this security are not numbers of bonds (a price is far from the face value per bond), so it cannot be linked to a bond instrument",
        ),
      );
    }
  }

  private throwBondLinkProblem(
    problem: BondLinkProblem,
    link: { bondProgramId: string; currencyCode: string },
    currencyChanged: boolean,
  ): never {
    switch (problem.code) {
      case "PROGRAM_NOT_FOUND":
        throw new BadRequestException(
          tr(
            "errors.securities.bondProgramNotFound",
            `Bond program ${link.bondProgramId} does not exist`,
            { id: link.bondProgramId },
          ),
        );
      case "NOT_BOND_TYPE":
        throw new BadRequestException(
          tr(
            "errors.bonds.LINK_REQUIRES_BOND_TYPE",
            "Only a security of type Bond can be linked to a bond instrument",
          ),
        );
      case "CURRENCY_MISMATCH": {
        const { instrumentCurrency } = problem;
        throw new BadRequestException(
          currencyChanged
            ? tr(
                "errors.securities.bondCurrencyLocked",
                `A security linked to a bond instrument stays in the instrument's currency (${instrumentCurrency}). Unlink it from the bond before changing its currency.`,
                { instrumentCurrency },
              )
            : tr(
                "errors.securities.bondCurrencyMismatch",
                `The security is recorded in ${link.currencyCode} but the bond instrument is priced in ${instrumentCurrency}. Use the instrument's currency.`,
                { currency: link.currencyCode, instrumentCurrency },
              ),
        );
      }
    }
  }

  /**
   * After a commit that set or changed a link or the lots: price the security
   * from the engine (spec 12.4). The write is already committed, so a failure
   * here is logged, not thrown -- the daily job and `POST /bonds/securities/:id/recompute`
   * repair it, and a 500 would tell the caller the link was not made.
   */
  private async recomputeBondPrices(
    userId: string,
    securityId: string,
  ): Promise<void> {
    try {
      await this.bondPriceService.recomputeSecurity(userId, securityId);
    } catch (error) {
      this.logger.warn(
        `Bond price recompute of security ${securityId} failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /**
   * After the commit of an investment transaction write (create, edit, void,
   * delete, transfer, bulk, an import, an undo): recompute the engine prices of
   * those of the securities that are linked to a bond instrument -- the lots
   * changed, so the rows the engine wrote are stale (INV-BOND-005). Every entry
   * point (the UI, bulk, the AI assistant, MCP, import) reaches the write through
   * `InvestmentTransactionsService`, which calls this. The write is already
   * committed, so a failure is logged by `BondPriceService`, not thrown: the
   * daily job and `POST /bonds/securities/:id/recompute` repair it.
   */
  async recomputeBondPricesAfterWrite(
    userId: string,
    securityIds: ReadonlyArray<string | null | undefined>,
  ): Promise<void> {
    await this.bondPriceService.recomputeLinkedSecurities(userId, securityIds);
  }

  /**
   * `recomputeBondPricesAfterWrite` for every bond-linked security with a trade in
   * one of these accounts (an import touches securities by account, not by id).
   */
  async recomputeBondPricesOfAccounts(
    userId: string,
    accountIds: readonly string[],
  ): Promise<void> {
    if (accountIds.length === 0) return;
    const rows: Array<{ id: string }> = await withScopedDb(
      this.dataSource,
      (m) =>
        m.query(
          `SELECT DISTINCT s.id
             FROM securities s
             JOIN investment_transactions t ON t.security_id = s.id
            WHERE s.user_id = $1 AND s.bond_program_id IS NOT NULL
              AND t.account_id = ANY($2::uuid[])`,
          [userId, accountIds],
        ),
    );
    await this.recomputeBondPricesAfterWrite(
      userId,
      rows.map((row) => row.id),
    );
  }

  /**
   * "Refresh price" of securities linked to a bond program: no quote provider
   * prices them, so the refresh first fetches the current offer of each distinct
   * program (a person's action, INV-BOND-008; a country with no fetch is skipped
   * silently), then runs the engine's recompute (the same one
   * `POST /bonds/securities/:id/recompute` runs), reported in the refresh
   * summary's own shape instead of as "0 updated". A failure of either step is a
   * failed row with its message, not a thrown error: the recompute and the rest
   * of the selection still run. A row counts once, as updated only when both
   * steps succeeded.
   */
  async recomputeLinkedPrices(
    userId: string,
    securities: ReadonlyArray<{ id: string; symbol: string }>,
  ): Promise<{
    results: PriceUpdateResult[];
    updated: number;
    failed: number;
  }> {
    const fetchErrors = await this.fetchOffersOfPrograms(userId, securities);
    const results: PriceUpdateResult[] = [];
    let updated = 0;
    let failed = 0;
    for (const security of securities) {
      const fetchError = fetchErrors.get(security.id);
      try {
        await this.bondPriceService.recomputeSecurity(userId, security.id);
        if (fetchError === undefined) {
          results.push({ symbol: security.symbol, success: true });
          updated += 1;
        } else {
          failed += 1;
          results.push({
            symbol: security.symbol,
            success: false,
            error: fetchError,
          });
        }
      } catch (error) {
        failed += 1;
        results.push({
          symbol: security.symbol,
          success: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return { results, updated, failed };
  }

  /**
   * The current offer of each distinct (country, program) of these securities,
   * fetched once. Returns the message of a failed fetch by security id; a
   * program whose country has no fetch (`SERIES_FETCH_UNSUPPORTED`) is a bond
   * kept the old way and is skipped without a word. Never throws.
   */
  private async fetchOffersOfPrograms(
    userId: string,
    securities: ReadonlyArray<{ id: string }>,
  ): Promise<Map<string, string>> {
    const errors = new Map<string, string>();
    if (securities.length === 0) return errors;
    const rows: Array<{
      id: string;
      issuer_country_code: string;
      program_code: string;
    }> = await withScopedDb(this.dataSource, (m) =>
      m.query(
        `SELECT s.id, p.issuer_country_code, p.program_code
           FROM securities s
           JOIN bond_programs p ON p.id = s.bond_program_id
          WHERE s.user_id = $1 AND s.id = ANY($2::uuid[])`,
        [userId, securities.map((s) => s.id)],
      ),
    );
    const byProgram = new Map<
      string,
      { country: string; program: string; ids: string[] }
    >();
    for (const row of rows) {
      const key = `${row.issuer_country_code}|${row.program_code}`;
      const entry = byProgram.get(key) ?? {
        country: row.issuer_country_code,
        program: row.program_code,
        ids: [],
      };
      entry.ids.push(row.id);
      byProgram.set(key, entry);
    }
    for (const { country, program, ids } of byProgram.values()) {
      let message: string | null = null;
      try {
        const run = await this.bondSeriesService.fetchProgramOffer(
          country,
          program,
        );
        // A failure only when nothing of the pass succeeded: a listing that
        // failed while the history stored series (or the offer stored or
        // already held some) is a refresh that did work.
        const failures = run.failed + (run.history?.failed ?? 0);
        const succeeded =
          run.stored + run.alreadyStored + (run.history?.stored ?? 0);
        if (failures > 0 && succeeded === 0) {
          message = `The current ${program} offer could not be fetched`;
        } else if (failures > 0) {
          this.logger.warn(
            `The ${program} refresh was partial: ${failures} series could not be fetched, ${succeeded} stored or already held`,
          );
        }
      } catch (error) {
        if (
          error instanceof SeriesFetchError &&
          error.code === "SERIES_FETCH_UNSUPPORTED"
        ) {
          continue;
        }
        message = `The current ${program} offer could not be fetched: ${
          error instanceof Error ? error.message : String(error)
        }`;
      }
      if (message === null) continue;
      this.logger.warn(message);
      for (const id of ids) errors.set(id, message);
    }
    return errors;
  }

  /**
   * Best-effort suggested description for a security from the Yahoo provider's
   * profile data, for the "Fetch from Yahoo" pre-fill button. Read-only and
   * advisory: it persists nothing and the user always reviews/edits the result
   * before saving. Returns `description: null` when Yahoo has nothing usable.
   */
  async getSuggestedDescription(
    symbol: string,
    exchange?: string | null,
  ): Promise<{
    symbol: string;
    description: string | null;
    website: string | null;
  }> {
    // One call gives both: the website rides along in the `summaryProfile` this
    // already requested. Advisory like the description -- the user reviews the
    // pre-fill before saving. Null for a fund, where Yahoo publishes no URL.
    const { description, website } =
      await this.yahooFinanceService.fetchSecurityProfile(
        symbol,
        exchange ?? null,
      );
    return { symbol, description, website };
  }

  /**
   * Clean a manual country (or similar) allocation breakdown before persisting:
   * snaps names to canonical countries, trims blanks, sums duplicate names,
   * clamps each weight into [0,1], drops zero-weight slices, and rejects a set
   * whose weights total more than 1.0 (with a small rounding tolerance). The
   * slices need not sum to 1.0 -- the shortfall is "Other" and is not stored.
   * Returns null when nothing meaningful remains so the column clears cleanly.
   */
  normalizeAllocationWeightings(
    input: AllocationWeight[] | null | undefined,
  ): AllocationWeight[] | null {
    return this.normalizeWeightings(input, normalizeCountryName);
  }

  /**
   * Same cleaning as `normalizeAllocationWeightings`, for the manual asset-class
   * breakdown. Asset classes have no canonical vocabulary, so names are only
   * trimmed/whitespace-collapsed (never snapped to a list); duplicates that
   * differ only by case are summed under the first spelling seen.
   */
  normalizeAssetWeightings(
    input: AllocationWeight[] | null | undefined,
  ): AllocationWeight[] | null {
    return this.normalizeWeightings(input, normalizeAssetName);
  }

  /**
   * Shared cleaning for a manual {name, weight} breakdown. `normalizeName`
   * decides how far a raw name is tidied (canonical country vs free-text asset
   * class); everything else -- de-duping, clamping, dropping the "Other"
   * bucket, the over-100% guard and the weight-descending sort -- is common.
   */
  private normalizeWeightings(
    input: AllocationWeight[] | null | undefined,
    normalizeName: (name: string) => string,
  ): AllocationWeight[] | null {
    if (!input || input.length === 0) return null;

    // Keyed case-insensitively so "equity" and "Equity" are one slice; the
    // first spelling seen is the one stored.
    const byKey = new Map<string, { name: string; weight: number }>();
    for (const slice of input) {
      const name = normalizeName(slice?.name ?? "");
      // A provider-supplied "Other" bucket is not a real slice: drop it so its
      // weight falls into the computed (100 - sum) remainder instead.
      if (!name || isOtherAllocationName(name)) continue;
      const weight = Number(slice?.weight);
      if (!Number.isFinite(weight) || weight <= 0) continue;
      const clamped = Math.min(weight, 1);
      const key = name.toLowerCase();
      const existing = byKey.get(key);
      byKey.set(key, {
        name: existing?.name ?? name,
        weight: (existing?.weight ?? 0) + clamped,
      });
    }

    if (byKey.size === 0) return null;

    const total = [...byKey.values()].reduce((sum, s) => sum + s.weight, 0);
    if (total > 1.0001) {
      throw new BadRequestException(
        tr(
          "errors.securities.allocationExceedsTotal",
          "Allocation percentages add up to more than 100%.",
        ),
      );
    }

    return [...byKey.values()]
      .map(({ name, weight }) => ({
        name,
        weight: Math.round(weight * 10000) / 10000,
      }))
      .sort((a, b) => b.weight - a.weight);
  }

  /**
   * The country names offered by the manual ETF/fund allocation picker for this
   * user: the canonical `COUNTRY_OPTIONS` list plus any custom countries the
   * user has already saved on a security (so a country added once is available
   * for every other security). Sorted alphabetically, with the user's
   * base-currency country floated to the top when it maps to a known country.
   */
  async getCountryOptions(userId: string): Promise<string[]> {
    const pref = await withScopedDb(this.dataSource, (m) =>
      m.getRepository(UserPreference).findOne({
        where: { userId },
      }),
    );
    const baseCountry = countryForCurrency(pref?.defaultCurrency);

    // Distinct country names already stored in this user's manual breakdowns.
    const rows: { name: string | null }[] = await withScopedDb(
      this.dataSource,
      (m) =>
        m
          .getRepository(Security)
          .createQueryBuilder("s")
          .select(
            "DISTINCT jsonb_array_elements(s.country_weightings)->>'name'",
            "name",
          )
          .where("s.user_id = :userId", { userId })
          .andWhere("s.country_weightings IS NOT NULL")
          .getRawMany(),
    );

    const seen = new Set<string>(COUNTRY_OPTIONS.map((c) => c.toLowerCase()));
    const custom: string[] = [];
    for (const row of rows) {
      const name = normalizeCountryName(row.name ?? "");
      if (!name || isOtherAllocationName(name)) continue;
      const key = name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      custom.push(name);
    }

    const sorted = [...COUNTRY_OPTIONS, ...custom].sort((a, b) =>
      a.localeCompare(b),
    );

    // Float the base-currency country to the top, keeping the rest alphabetical.
    if (
      baseCountry &&
      sorted.some((c) => c.toLowerCase() === baseCountry.toLowerCase())
    ) {
      return [
        baseCountry,
        ...sorted.filter((c) => c.toLowerCase() !== baseCountry.toLowerCase()),
      ];
    }
    return sorted;
  }

  /**
   * The asset-class names offered by the manual ETF/fund allocation picker for
   * this user. Unlike countries there is no canonical vocabulary: the list is
   * exactly what the user has already saved on their own securities, so a class
   * entered once is available for every other security. Sorted alphabetically.
   */
  async getAssetOptions(userId: string): Promise<string[]> {
    const rows: { name: string | null }[] = await withScopedDb(
      this.dataSource,
      (m) =>
        m
          .getRepository(Security)
          .createQueryBuilder("s")
          .select(
            "DISTINCT jsonb_array_elements(s.asset_weightings)->>'name'",
            "name",
          )
          .where("s.user_id = :userId", { userId })
          .andWhere("s.asset_weightings IS NOT NULL")
          .getRawMany(),
    );

    const seen = new Set<string>();
    const names: string[] = [];
    for (const row of rows) {
      const name = normalizeAssetName(row.name ?? "");
      if (!name || isOtherAllocationName(name)) continue;
      const key = name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      names.push(name);
    }

    return names.sort((a, b) => a.localeCompare(b));
  }

  /**
   * Drop an asset class from the user's picker list by removing its slice from
   * every security that uses it. Nothing is re-apportioned: the freed weight
   * simply becomes part of each security's computed (100 - sum) "Other"
   * remainder, which is how a sub-100% breakdown already renders. Returns how
   * many securities were touched.
   */
  async deleteAssetOption(
    userId: string,
    rawName: string,
  ): Promise<{ name: string; removedFrom: number }> {
    const name = normalizeAssetName(rawName);
    if (!name) {
      throw new BadRequestException(
        tr(
          "errors.securities.assetOptionNameRequired",
          "An asset class name is required.",
        ),
      );
    }
    const key = name.toLowerCase();

    const removedFrom = await withScopedDb(this.dataSource, async (m) => {
      const repo = m.getRepository(Security);
      const securities = await repo
        .createQueryBuilder("s")
        .where("s.user_id = :userId", { userId })
        .andWhere("s.asset_weightings IS NOT NULL")
        .getMany();

      let touched = 0;
      for (const security of securities) {
        const remaining = (security.assetWeightings ?? []).filter(
          (slice) =>
            normalizeAssetName(slice?.name ?? "").toLowerCase() !== key,
        );
        if (remaining.length === (security.assetWeightings ?? []).length) {
          continue;
        }
        await repo.update(
          { id: security.id, userId },
          { assetWeightings: remaining.length > 0 ? remaining : null },
        );
        touched += 1;
      }
      return touched;
    });

    return { name, removedFrom };
  }

  /** Shared with institutions and payees; see `common/normalize-website`. */
  private normalizeWebsite(
    value: string | null | undefined,
  ): string | null | undefined {
    return normalizeWebsite(value);
  }

  async create(
    userId: string,
    createSecurityDto: CreateSecurityDto,
  ): Promise<Security> {
    // tagIds is a relation, not a column on securities -- pull it out so the
    // spread that builds the entity never tries to persist it as a field.
    const { tagIds, countryWeightings, assetWeightings, ...securityData } =
      createSecurityDto;

    // Both address fields are rendered as links, so they are stored absolute.
    if ("website" in securityData) {
      securityData.website = this.normalizeWebsite(securityData.website);
    }
    if ("irWebsite" in securityData) {
      securityData.irWebsite = this.normalizeWebsite(securityData.irWebsite);
    }

    const saved = await withScopedDb(this.dataSource, async (m) => {
      // Check if symbol already exists for this user
      const existing = await m.findOne(Security, {
        where: { symbol: securityData.symbol, userId },
      });

      if (existing) {
        throw new ConflictException(
          tr(
            "errors.securities.symbolAlreadyExists",
            `Security with symbol ${securityData.symbol} already exists`,
            { symbol: securityData.symbol },
          ),
        );
      }

      if (!securityData.bondProgramId) securityData.bondAutoFetch = false;
      if (securityData.bondProgramId) {
        securityData.bondProgramId = securityData.bondProgramId.toLowerCase();
        await this.assertBondLink(
          m,
          {
            bondProgramId: securityData.bondProgramId,
            currencyCode: securityData.currencyCode,
            securityType: securityData.securityType,
          },
          false,
        );
      }

      const security = m.create(Security, {
        ...securityData,
        countryWeightings:
          this.normalizeAllocationWeightings(countryWeightings),
        assetWeightings: this.normalizeAssetWeightings(assetWeightings),
        userId,
      });
      const persisted = await m.save(security);

      if (tagIds && tagIds.length > 0) {
        await this.setSecurityTags(persisted.id, tagIds, userId, m);
      }

      return persisted;
    });

    // Fire-and-forget: backfill 1Y of daily prices for the new security
    this.securityPriceService.backfillSecurity(saved).catch((err) => {
      this.logger.warn(
        `Background price backfill failed for ${saved.symbol}: ${err.message}`,
      );
    });

    if (saved.bondProgramId) {
      await this.recomputeBondPrices(userId, saved.id);
    }

    this.actionHistoryService.record(userId, {
      entityType: "security",
      entityId: saved.id,
      action: "create",
      afterData: { ...saved },
      description: `Created security "${saved.symbol}"`,
      descriptionKey: "createdSecurity",
      descriptionParams: { symbol: saved.symbol },
    });

    return saved;
  }

  async findAll(
    userId: string,
    includeInactive: boolean = false,
  ): Promise<SecurityWithLatestPrice[]> {
    const where: Record<string, unknown> = { userId };
    if (!includeInactive) {
      where.isActive = true;
    }
    const securities = await withScopedDb(this.dataSource, (m) =>
      m.getRepository(Security).find({
        where,
        relations: ["tags"],
        order: { symbol: "ASC" },
      }),
    );
    return this.attachLatestPrice(securities);
  }

  /**
   * Decorate each security with its most recent price row -- the `source` that
   * wrote it and the close itself (via a single grouped query for efficiency).
   * Both are null when the security has no prices yet, which is what lets the
   * list say "no price" rather than show a value nobody measured.
   */
  private async attachLatestPrice(
    securities: Security[],
  ): Promise<SecurityWithLatestPrice[]> {
    if (securities.length === 0) return [];
    const ids = securities.map((s) => s.id);
    const rows: Array<{
      security_id: string;
      source: string | null;
      close_price: string | number | null;
    }> = await withScopedDb(this.dataSource, (m) =>
      m.query(
        `SELECT DISTINCT ON (security_id) security_id, source, close_price
         FROM security_prices
         WHERE security_id = ANY($1::uuid[])
         ORDER BY security_id, price_date DESC, created_at DESC`,
        [ids],
      ),
    );
    const latestById = new Map(rows.map((r) => [r.security_id, r]));
    return securities.map((s) => {
      const latest = latestById.get(s.id);
      // `pg` hands a NUMERIC back as a string, so the close is parsed here
      // rather than shipped as one and coerced by every reader. A row that
      // cannot be read as a finite number is no price at all -- null, never 0,
      // which a client would render as a security worth nothing. The empty and
      // null cases are tested before `Number`, not after: `Number(null)` and
      // `Number("")` are both a perfectly finite 0.
      const raw = latest?.close_price;
      const close =
        raw === null || raw === undefined || raw === ""
          ? Number.NaN
          : Number(raw);
      return {
        ...s,
        lastPriceSource: latest?.source ?? null,
        lastPrice: Number.isFinite(close) ? close : null,
      };
    });
  }

  async findOne(userId: string, id: string): Promise<Security> {
    const security = await withScopedDb(this.dataSource, (m) =>
      m.getRepository(Security).findOne({
        where: { id, userId },
        relations: ["tags"],
      }),
    );
    if (!security) {
      throw new NotFoundException(
        tr(
          "errors.securities.notFoundById",
          `Security with ID ${id} not found`,
          { id },
        ),
      );
    }
    return security;
  }

  async findBySymbol(userId: string, symbol: string): Promise<Security> {
    const security = await withScopedDb(this.dataSource, (m) =>
      m.getRepository(Security).findOne({
        where: { symbol, userId },
      }),
    );
    if (!security) {
      throw new NotFoundException(
        tr(
          "errors.securities.notFoundBySymbol",
          `Security with symbol ${symbol} not found`,
          { symbol },
        ),
      );
    }
    return security;
  }

  async update(
    userId: string,
    id: string,
    updateSecurityDto: UpdateSecurityDto,
  ): Promise<Security> {
    const security = await this.findOne(userId, id);
    const beforeData = { ...security };

    // Same normalisation as on create, and `""` clears the field.
    if ("website" in updateSecurityDto) {
      updateSecurityDto.website = this.normalizeWebsite(
        updateSecurityDto.website,
      );
    }
    if ("irWebsite" in updateSecurityDto) {
      updateSecurityDto.irWebsite = this.normalizeWebsite(
        updateSecurityDto.irWebsite,
      );
    }

    // Check for symbol conflicts if updating symbol
    if (
      updateSecurityDto.symbol &&
      updateSecurityDto.symbol !== security.symbol
    ) {
      const existing = await withScopedDb(this.dataSource, (m) =>
        m.getRepository(Security).findOne({
          where: { symbol: updateSecurityDto.symbol, userId },
        }),
      );
      if (existing) {
        throw new ConflictException(
          tr(
            "errors.securities.symbolAlreadyExists",
            `Security with symbol ${updateSecurityDto.symbol} already exists`,
            { symbol: updateSecurityDto.symbol },
          ),
        );
      }
    }

    // SECURITY: Explicit property mapping instead of Object.assign to prevent mass assignment
    if (updateSecurityDto.symbol !== undefined)
      security.symbol = updateSecurityDto.symbol;
    if (updateSecurityDto.name !== undefined)
      security.name = updateSecurityDto.name;
    if (updateSecurityDto.securityType !== undefined)
      security.securityType = updateSecurityDto.securityType;
    if (updateSecurityDto.exchange !== undefined)
      security.exchange = updateSecurityDto.exchange;
    if (updateSecurityDto.currencyCode !== undefined)
      security.currencyCode = updateSecurityDto.currencyCode;
    if (updateSecurityDto.description !== undefined)
      security.description = updateSecurityDto.description ?? null;
    // Both addresses were normalised above ("" -> null, bare domain -> https).
    // They must be copied onto the entity here like every other scalar: this
    // block replaces Object.assign, so a field it omits is silently dropped and
    // the edit never persists -- which is exactly what happened to these two.
    if (updateSecurityDto.website !== undefined)
      security.website = updateSecurityDto.website ?? null;
    if (updateSecurityDto.irWebsite !== undefined)
      security.irWebsite = updateSecurityDto.irWebsite ?? null;
    if (updateSecurityDto.isActive !== undefined)
      security.isActive = updateSecurityDto.isActive;
    if (updateSecurityDto.priceChartEnabled !== undefined)
      security.priceChartEnabled = updateSecurityDto.priceChartEnabled;
    if (updateSecurityDto.priceAlertPercent !== undefined)
      security.priceAlertPercent = updateSecurityDto.priceAlertPercent;
    if (updateSecurityDto.isFavourite !== undefined)
      security.isFavourite = updateSecurityDto.isFavourite;
    if (updateSecurityDto.quoteProvider !== undefined)
      security.quoteProvider = updateSecurityDto.quoteProvider ?? null;
    if (updateSecurityDto.msnInstrumentId !== undefined)
      security.msnInstrumentId = updateSecurityDto.msnInstrumentId ?? null;
    // One canonical spelling: the same instrument in capitals is not a change.
    if (updateSecurityDto.bondProgramId !== undefined)
      security.bondProgramId =
        updateSecurityDto.bondProgramId?.toLowerCase() ?? null;
    if (updateSecurityDto.bondAutoFetch !== undefined)
      security.bondAutoFetch = updateSecurityDto.bondAutoFetch;
    if (updateSecurityDto.countryWeightings !== undefined)
      security.countryWeightings = this.normalizeAllocationWeightings(
        updateSecurityDto.countryWeightings,
      );
    if (updateSecurityDto.assetWeightings !== undefined)
      security.assetWeightings = this.normalizeAssetWeightings(
        updateSecurityDto.assetWeightings,
      );

    // An explicit choice of the "disable price updates" switch wins. Otherwise
    // a quote source the user has just picked -- a provider override or MSN
    // Instrument ID that differs from the stored one -- turns updates back on,
    // so a symbol an import invented and flagged is fetched once corrected.
    // Compared against the row, not the field's presence: the form resends
    // every field, and an unchanged override must not undo the switch.
    if (updateSecurityDto.skipPriceUpdates !== undefined) {
      security.skipPriceUpdates = updateSecurityDto.skipPriceUpdates;
    } else if (
      (security.quoteProvider &&
        security.quoteProvider !== beforeData.quoteProvider) ||
      (security.msnInstrumentId &&
        security.msnInstrumentId !== beforeData.msnInstrumentId)
    ) {
      security.skipPriceUpdates = false;
    }

    // Accounts whose derived state must be refreshed after the commit because the
    // engine's price rows were deleted by an unlink (INV-CACHE-001).
    let clearedEngineAccounts: string[] = [];
    // Decided inside the transaction, from the row as locked there.
    let linkChanged = false;

    // Persist the scalar fields and the tag set together so a security and its
    // classification never drift apart on a partial failure.
    await withScopedDb(this.dataSource, async (m) => {
      // A request that names a link may change it, and a change deletes the
      // engine's rows under the recompute lock (`clearEnginePrices`): that
      // advisory lock is taken first, before the row lock below, the order every
      // writer uses (`common/db/locks.ts`); it is re-entrant for the cleanup.
      if (updateSecurityDto.bondProgramId !== undefined) {
        await acquireAdvisoryLock(m, LockScope.BondPriceRecompute, id);
      }
      // The link is read from the row under a lock, not from the read above: a
      // concurrent link or unlink commits before this one proceeds, so whether
      // the link changes (and whether engine rows must go) is decided on the
      // truth, and this write cannot put a stale link back.
      const locked: Array<{
        bond_program_id: string | null;
        bond_auto_fetch: boolean;
        security_type: string | null;
        currency_code: string;
      }> = await m.query(
        `SELECT bond_program_id, bond_auto_fetch, security_type, currency_code
           FROM securities
          WHERE id = $1 AND user_id = $2
          FOR UPDATE`,
        [id, userId],
      );
      if (locked.length === 0) {
        throw new NotFoundException(
          tr(
            "errors.securities.notFoundBySecurityId",
            `Security ${id} not found`,
            { securityId: id },
          ),
        );
      }
      const current = locked[0];
      if (updateSecurityDto.bondProgramId === undefined) {
        security.bondProgramId = current.bond_program_id;
      }
      if (updateSecurityDto.bondAutoFetch === undefined) {
        security.bondAutoFetch = current.bond_auto_fetch;
      }
      // The switch only means something on a linked security.
      if (!security.bondProgramId) security.bondAutoFetch = false;
      if (updateSecurityDto.securityType === undefined) {
        security.securityType = current.security_type;
      }
      if (updateSecurityDto.currencyCode === undefined) {
        security.currencyCode = current.currency_code;
      }
      beforeData.bondProgramId = current.bond_program_id;
      beforeData.bondAutoFetch = current.bond_auto_fetch;

      linkChanged = security.bondProgramId !== current.bond_program_id;
      const currencyChanged = security.currencyCode !== current.currency_code;
      const typeChanged = security.securityType !== current.security_type;

      // A link the instrument cannot honour is refused here, in the write's own
      // transaction and before it. Also on a currency or type change of a
      // security that stays linked: the engine prices in the instrument's
      // currency, and only a BOND is linked.
      if (
        security.bondProgramId &&
        (linkChanged || currencyChanged || typeChanged)
      ) {
        await this.assertBondLink(
          m,
          {
            bondProgramId: security.bondProgramId,
            currencyCode: security.currencyCode,
            securityType: security.securityType,
          },
          !linkChanged,
          linkChanged ? { userId, securityId: id } : undefined,
        );
      }

      // A security no longer linked to the instrument its engine prices came
      // from (unlinked, or moved to another instrument) loses those rows in the
      // same transaction; a new link is priced after the commit. Manual,
      // transaction and provider rows are not the engine's and stay.
      if (linkChanged) {
        ({ accountIds: clearedEngineAccounts } =
          await this.bondPriceService.clearEnginePrices(m, userId, id));
        // INV-BOND-007: a row names a series of the security's own program, and
        // an unlinked security's rows name none.
        await clearForeignSeries(m, userId, id, security.bondProgramId);
      }

      // The relation is loaded onto `security`; strip it before save so
      // TypeORM does not try to cascade-write the join table itself.
      const { tags: _tags, ...scalars } = security;
      await m.save(Security, scalars);
      if (updateSecurityDto.tagIds !== undefined) {
        await this.setSecurityTags(id, updateSecurityDto.tagIds, userId, m);
      }
    });

    const saved = await this.findOne(userId, id);

    // After the commit, never inside it (INV-CACHE-001): the engine's rows an
    // unlink deleted change what the portfolio is worth, and a link set or
    // changed is priced from the engine now rather than at the next daily run.
    if (clearedEngineAccounts.length > 0) {
      this.bondPriceService.publishClearedPrices(userId, clearedEngineAccounts);
    }
    if (linkChanged && saved.bondProgramId) {
      await this.recomputeBondPrices(userId, id);
    }

    this.actionHistoryService.record(userId, {
      entityType: "security",
      entityId: id,
      action: "update",
      beforeData,
      afterData: { ...saved },
      description: `Updated security "${saved.symbol}"`,
      descriptionKey: "updatedSecurity",
      descriptionParams: { symbol: saved.symbol },
    });

    // Updates were just turned back on: fetch history now, as create does,
    // rather than leave the security unpriced until the next scheduled run.
    if (beforeData.skipPriceUpdates && !saved.skipPriceUpdates) {
      this.securityPriceService.backfillSecurity(saved).catch((err) => {
        this.logger.warn(
          `Background price backfill failed for ${saved.symbol}: ${err.message}`,
        );
      });
    }

    return saved;
  }

  async deactivate(userId: string, id: string): Promise<Security> {
    const security = await this.findOne(userId, id);

    // Check if security has any holdings with non-zero quantity
    // Using ABS() to handle potential small negative values from rounding
    const holdingsCount = await withScopedDb(this.dataSource, (m) =>
      m
        .getRepository(Holding)
        .createQueryBuilder("holding")
        .leftJoin("holding.account", "account")
        .where("holding.securityId = :securityId", { securityId: id })
        .andWhere("account.userId = :userId", { userId })
        .andWhere("ABS(holding.quantity) > :threshold", {
          threshold: 0.00000001,
        })
        .getCount(),
    );

    if (holdingsCount > 0) {
      throw new ForbiddenException(
        tr(
          "errors.securities.cannotDeactivateWithHoldings",
          "Cannot deactivate security with active holdings. Please sell all shares first.",
        ),
      );
    }

    // A targeted UPDATE, not a save of the row read above: a full save would
    // write back every column of a stale read, e.g. a bond link changed in
    // between (INV-BOND-005).
    return withScopedDb(this.dataSource, async (m) => {
      const repo = m.getRepository(Security);
      await repo.update({ id: security.id, userId }, { isActive: false });
      return repo.findOneOrFail({ where: { id: security.id, userId } });
    });
  }

  async activate(userId: string, id: string): Promise<Security> {
    const security = await this.findOne(userId, id);
    // A targeted UPDATE, not a save of the row read above: a full save would
    // write back every column of a stale read, e.g. a bond link changed in
    // between (INV-BOND-005).
    return withScopedDb(this.dataSource, async (m) => {
      const repo = m.getRepository(Security);
      await repo.update({ id: security.id, userId }, { isActive: true });
      return repo.findOneOrFail({ where: { id: security.id, userId } });
    });
  }

  async remove(userId: string, id: string): Promise<void> {
    const security = await this.findOne(userId, id);

    // Check for any holdings with non-zero quantity
    // Using ABS() to handle potential small negative values from rounding
    const holdingsCount = await withScopedDb(this.dataSource, (m) =>
      m
        .getRepository(Holding)
        .createQueryBuilder("holding")
        .leftJoin("holding.account", "account")
        .where("holding.securityId = :securityId", { securityId: id })
        .andWhere("account.userId = :userId", { userId })
        .andWhere("ABS(holding.quantity) > :threshold", {
          threshold: 0.00000001,
        })
        .getCount(),
    );

    if (holdingsCount > 0) {
      throw new ForbiddenException(
        tr(
          "errors.securities.cannotDeleteWithHoldings",
          "Cannot delete security that has holdings. Remove all holdings first.",
        ),
      );
    }

    // Check for any investment transactions referencing this security
    // includes VOID rows: records read -- a VOID row still references the
    // security and would be orphaned by the delete.
    const transactionsCount = await withScopedDb(this.dataSource, (m) =>
      m
        .getRepository(InvestmentTransaction)
        .createQueryBuilder("tx")
        .where("tx.securityId = :securityId", { securityId: id })
        .andWhere("tx.userId = :userId", { userId })
        .getCount(),
    );

    if (transactionsCount > 0) {
      throw new ForbiddenException(
        tr(
          "errors.securities.cannotDeleteWithTransactions",
          "Cannot delete security that has investment transactions. Delete all related transactions first.",
        ),
      );
    }

    // Clean up any zero-quantity holding records before deleting the security,
    // then delete the security itself -- one transaction so a failure can never
    // strand the holdings without their security.
    const beforeData = { ...security };
    await withScopedDb(this.dataSource, async (m) => {
      const holdingsRepo = m.getRepository(Holding);
      const zeroHoldings = await holdingsRepo
        .createQueryBuilder("holding")
        .leftJoin("holding.account", "account")
        .where("holding.securityId = :securityId", { securityId: id })
        .andWhere("account.userId = :userId", { userId })
        .getMany();
      if (zeroHoldings.length > 0) {
        await holdingsRepo.remove(zeroHoldings);
      }

      // Security prices cascade-delete via FK constraint
      await m.getRepository(Security).remove(security);
    });

    this.actionHistoryService.record(userId, {
      entityType: "security",
      entityId: beforeData.id,
      action: "delete",
      beforeData,
      description: `Deleted security "${beforeData.symbol}"`,
      descriptionKey: "deletedSecurity",
      descriptionParams: { symbol: beforeData.symbol },
    });
  }

  /**
   * Favourite securities for the dashboard widget, decorated with their latest
   * price and the day-over-day change. Favourites are independent of holdings
   * (a user can pin a security they don't own), so this is keyed off the
   * is_favourite flag rather than the holdings table. Securities with fewer
   * than two price points report a zero daily change.
   */
  async getFavouriteSecurities(
    userId: string,
  ): Promise<FavouriteSecurityQuote[]> {
    const securities = await withScopedDb(this.dataSource, (m) =>
      m.getRepository(Security).find({
        where: { userId, isFavourite: true, isActive: true },
        order: { symbol: "ASC" },
      }),
    );
    if (securities.length === 0) return [];

    const ids = securities.map((s) => s.id);
    // Two most recent prices per security in a single pass. The dates come with
    // them: whether the pair is a daily move at all is a question about when
    // the two closes are, not only what they are.
    const priceRows: Array<{
      security_id: string;
      close_price: string;
      price_date: string | Date;
      rn: string;
    }> = await withScopedDb(this.dataSource, (m) =>
      m.query(
        `SELECT security_id, close_price, price_date, rn FROM (
         SELECT security_id, close_price, price_date,
                ROW_NUMBER() OVER (PARTITION BY security_id ORDER BY price_date DESC) as rn
         FROM security_prices
         WHERE security_id = ANY($1::uuid[])
       ) sub
       WHERE rn <= 2
       ORDER BY security_id, rn`,
        [ids],
      ),
    );

    const priceMap = new Map<string, PricePoint[]>();
    for (const row of priceRows) {
      const existing = priceMap.get(row.security_id) || [];
      existing.push({ price: Number(row.close_price), date: row.price_date });
      priceMap.set(row.security_id, existing);
    }

    const today = todayYMD();
    return securities.map((s) => {
      const prices = priceMap.get(s.id) || [];
      // The price shown is the latest close there is, even when it is too old
      // to yield a daily move -- a watchlist that blanked the price would be
      // hiding the one figure it does know.
      const currentPrice = prices[0]?.price ?? null;
      const previousPrice = prices[1]?.price ?? null;
      const change = resolveDailyPriceChange(prices, today);
      return {
        securityId: s.id,
        symbol: s.symbol,
        name: s.name,
        currencyCode: s.currencyCode,
        currentPrice,
        previousPrice,
        dailyChange: change?.dailyChange ?? null,
        dailyChangePercent: change?.dailyChangePercent ?? null,
        priceDate: change?.priceDate ?? null,
      };
    });
  }

  /**
   * One security's daily move for its detail header, through the same rule as
   * the watchlist and the movers board. Null is a refusal (not adjacent
   * sessions, or the newer close is not current), never a zero move.
   * Ownership is the caller's (`findOne`).
   */
  async getDailyPriceChange(
    securityId: string,
  ): Promise<DailyPriceChange | null> {
    const rows: Array<{ close_price: string; price_date: string }> =
      await withScopedDb(this.dataSource, (m) =>
        m.query(
          `SELECT close_price, TO_CHAR(price_date, 'YYYY-MM-DD') AS price_date
             FROM security_prices
           WHERE security_id = $1
           ORDER BY price_date DESC
           LIMIT 2`,
          [securityId],
        ),
      );
    return resolveDailyPriceChange(
      rows.map((r) => ({ price: Number(r.close_price), date: r.price_date })),
      todayYMD(),
    );
  }

  async getSecurityIdsWithTransactions(userId: string): Promise<string[]> {
    // includes VOID rows: records read -- "referenced anywhere", not an effect.
    const results = await withScopedDb(this.dataSource, (m) =>
      m
        .getRepository(InvestmentTransaction)
        .createQueryBuilder("tx")
        .select("DISTINCT tx.securityId", "securityId")
        .where("tx.userId = :userId", { userId })
        .andWhere("tx.securityId IS NOT NULL")
        .getRawMany(),
    );

    return results.map((r) => r.securityId);
  }

  /**
   * The securities with a non-zero holding in one account, ordered by symbol.
   * Backs the `list` operation of `manage_securities` on both tool surfaces.
   * The caller resolves the account (and so its ownership); the user filter on
   * the security keeps the query tenant-safe regardless.
   */
  async listSecuritiesInAccount(
    userId: string,
    accountId: string,
  ): Promise<LlmAccountSecurity[]> {
    const holdings = await withScopedDb(this.dataSource, (m) =>
      m
        .getRepository(Holding)
        .createQueryBuilder("h")
        .innerJoinAndSelect("h.security", "s")
        .where("h.accountId = :accountId", { accountId })
        .andWhere("s.userId = :userId", { userId })
        .andWhere("h.quantity <> 0")
        .orderBy("s.symbol", "ASC")
        .getMany(),
    );

    return holdings.map((h) => ({
      symbol: h.security.symbol,
      name: h.security.name,
      securityType: h.security.securityType ?? null,
      exchange: h.security.exchange ?? null,
      currencyCode: h.security.currencyCode,
      isFavourite: h.security.isFavourite,
      quantity: Number(h.quantity),
      averageCost: h.averageCost == null ? null : Number(h.averageCost),
    }));
  }

  async search(userId: string, query: string): Promise<Security[]> {
    return withScopedDb(this.dataSource, (m) =>
      m
        .getRepository(Security)
        .createQueryBuilder("security")
        .where("security.userId = :userId", { userId })
        .andWhere("security.isActive = :isActive", { isActive: true })
        .andWhere(
          "(LOWER(security.symbol) LIKE LOWER(:query) OR LOWER(security.name) LIKE LOWER(:query))",
          { query: `%${query}%` },
        )
        .orderBy("security.symbol", "ASC")
        .take(20)
        .getMany(),
    );
  }

  /**
   * Resolve a free-text security reference (a ticker symbol or a security name)
   * to a single owned security. Matching is layered so common references
   * resolve unambiguously while a vague substring that hits several securities
   * is reported back as candidates rather than guessed:
   *   1. Exact symbol (case-insensitive). Symbols are unique per user, so this
   *      yields at most one match.
   *   2. Exact name (case-insensitive). Names are not guaranteed unique;
   *      multiple hits become candidates.
   *   3. Substring on symbol or name among active securities -- a single hit
   *      wins, multiple become candidates, none resolves to no match.
   *
   * Shared by the AI Assistant `create_investment_transaction` tool and the MCP
   * server so both surfaces match securities identically.
   */
  async resolveBySymbolOrName(
    userId: string,
    query: string,
  ): Promise<SecurityMatchResult> {
    const trimmed = (query ?? "").trim();
    if (!trimmed) {
      return { match: null, candidates: [] };
    }

    const bySymbol = await withScopedDb(this.dataSource, (m) =>
      m
        .getRepository(Security)
        .createQueryBuilder("security")
        .where("security.userId = :userId", { userId })
        .andWhere("LOWER(security.symbol) = LOWER(:q)", { q: trimmed })
        .getOne(),
    );
    if (bySymbol) {
      return { match: bySymbol, candidates: [] };
    }

    const byName = await withScopedDb(this.dataSource, (m) =>
      m
        .getRepository(Security)
        .createQueryBuilder("security")
        .where("security.userId = :userId", { userId })
        .andWhere("LOWER(security.name) = LOWER(:q)", { q: trimmed })
        // Prefer an active security when several share a name (e.g. a delisted
        // duplicate); fall back to the symbol for a stable order.
        .orderBy("security.isActive", "DESC")
        .addOrderBy("security.symbol", "ASC")
        .getMany(),
    );
    if (byName.length === 1) {
      return { match: byName[0], candidates: [] };
    }
    if (byName.length > 1) {
      return { match: null, candidates: byName };
    }

    const partial = await withScopedDb(this.dataSource, (m) =>
      m
        .getRepository(Security)
        .createQueryBuilder("security")
        .where("security.userId = :userId", { userId })
        .andWhere("security.isActive = :isActive", { isActive: true })
        .andWhere(
          "(LOWER(security.symbol) LIKE LOWER(:like) OR LOWER(security.name) LIKE LOWER(:like))",
          { like: `%${trimmed}%` },
        )
        .orderBy("security.symbol", "ASC")
        .take(10)
        .getMany(),
    );
    if (partial.length === 1) {
      return { match: partial[0], candidates: [] };
    }
    return { match: null, candidates: partial };
  }

  /**
   * Resolve the ticker a broker's trade confirmation prints to the user's
   * active security, strictly: the symbol itself (any case) or the symbol with
   * an exchange suffix (`XCNS` finds `XCNS.TO`), never a name or a fragment.
   *
   * One candidate is the match. An exact symbol wins over suffixed ones only
   * while they all trade in its currency (the same instrument on several
   * venues); `AAPL` in USD beside `AAPL.TO` in CAD is two instruments the email
   * cannot tell apart, so the one this account already trades decides, and
   * otherwise they are `candidates`, never a guess. A `currency` the email
   * names narrows the listings first (`SHOP` in USD beside `SHOP.TO` in CAD
   * is the USD one for an email in US$). A trade written to the
   * wrong security is a wrong ledger, so the loose matching
   * `resolveBySymbolOrName` does for a person typing in chat is not used here.
   */
  async resolveByTradeSymbol(
    userId: string,
    ticker: string,
    accountId?: string,
    currency?: string | null,
  ): Promise<SecurityMatchResult> {
    const symbol = (ticker ?? "").trim();
    if (!symbol) return { match: null, candidates: [] };
    return withScopedDb(this.dataSource, async (m) => {
      const listed = await findTradeListings(m, userId, symbol);
      const inCurrency = currency
        ? listed.filter(
            (row) => row.currencyCode.toUpperCase() === currency.toUpperCase(),
          )
        : [];
      // A currency no listing trades in narrows nothing: the card then
      // refuses the mismatch by name rather than reporting no security.
      const rows = inCurrency.length > 0 ? inCurrency : listed;
      if (rows.length === 1) return { match: rows[0], candidates: [] };
      const exact = rows.filter(
        (row) => row.symbol.toLowerCase() === symbol.toLowerCase(),
      );
      if (
        exact.length === 1 &&
        rows.every((row) => row.currencyCode === exact[0].currencyCode)
      ) {
        return { match: exact[0], candidates: [] };
      }
      if (accountId && rows.length > 1) {
        const traded = returnedRows<{ security_id: string }>(
          await m.query(
            `SELECT DISTINCT it.security_id
               FROM investment_transactions it
              WHERE it.user_id = $1
                AND it.account_id = $2
                AND it.status != 'VOID'
                AND it.security_id = ANY($3::uuid[])`,
            [userId, accountId, rows.map((row) => row.id)],
          ),
        );
        if (traded.length === 1) {
          const held = rows.find((row) => row.id === traded[0].security_id);
          if (held) return { match: held, candidates: [] };
        }
      }
      return { match: null, candidates: rows };
    });
  }

  /**
   * Resolve an existing security by symbol or name for an edit/delete, throwing
   * a clear error when nothing matches or the reference is ambiguous. Used by
   * the manage_securities confirmation flow.
   */
  private async resolveSecurityForManage(
    userId: string,
    query: string,
  ): Promise<Security> {
    const { match, candidates } = await this.resolveBySymbolOrName(
      userId,
      query,
    );
    if (match) {
      return match;
    }
    if (candidates.length > 1) {
      throw new BadRequestException(
        tr(
          "errors.securities.ambiguousSecurity",
          `"${query}" matches multiple securities: ${candidates
            .map((c) => c.symbol)
            .join(", ")}. Use the exact ticker symbol.`,
          { query, list: candidates.map((c) => c.symbol).join(", ") },
        ),
      );
    }
    throw new NotFoundException(
      tr(
        "errors.securities.securityNotFoundByQuery",
        `No security matches "${query}". Add the security first or check the ticker symbol.`,
        { query },
      ),
    );
  }

  /**
   * Validate + resolve a proposed security edit WITHOUT persisting. Resolves the
   * target security by symbol/name and merges the supplied classification/
   * display fields over its current values.
   */
  async previewUpdateSecurity(
    userId: string,
    input: {
      query: string;
      securityType?: string | null;
      exchange?: string | null;
      currencyCode?: string;
      isFavourite?: boolean;
      countryWeightings?: AllocationWeight[];
      assetWeightings?: AllocationWeight[];
    },
  ): Promise<UpdateSecurityPreview> {
    const security = await this.resolveSecurityForManage(userId, input.query);
    const securityType =
      input.securityType !== undefined
        ? input.securityType
        : (security.securityType ?? null);
    const currencyCode = input.currencyCode ?? security.currencyCode;

    // The commit refuses a currency or type change that breaks a bond link
    // (`update`); the preview runs the same validation so the person is not
    // asked to confirm what cannot be done.
    if (
      security.bondProgramId &&
      (currencyCode !== security.currencyCode ||
        securityType !== (security.securityType ?? null))
    ) {
      const linkedTo = security.bondProgramId;
      await withScopedDb(this.dataSource, (m) =>
        this.assertBondLink(
          m,
          {
            bondProgramId: linkedTo,
            currencyCode,
            securityType,
          },
          currencyCode !== security.currencyCode,
        ),
      );
    }

    return {
      securityId: security.id,
      symbol: security.symbol,
      name: security.name,
      securityType,
      exchange:
        input.exchange !== undefined
          ? input.exchange
          : (security.exchange ?? null),
      currencyCode,
      isFavourite: input.isFavourite ?? security.isFavourite,
      countryWeightings:
        input.countryWeightings !== undefined
          ? this.normalizeAllocationWeightings(input.countryWeightings)
          : (security.countryWeightings ?? null),
      assetWeightings:
        input.assetWeightings !== undefined
          ? this.normalizeAssetWeightings(input.assetWeightings)
          : (security.assetWeightings ?? null),
    };
  }

  /** Validate + resolve a proposed security deletion (by symbol/name). */
  async previewDeleteSecurity(
    userId: string,
    input: { query: string },
  ): Promise<DeleteSecurityPreview> {
    const security = await this.resolveSecurityForManage(userId, input.query);
    return {
      securityId: security.id,
      symbol: security.symbol,
      name: security.name,
    };
  }

  /**
   * Resolve and validate a new security from a free-text reference (ticker
   * symbol or name) via the user's configured quote provider, returning the
   * fully-populated values a confirmation card / signed descriptor needs. Does
   * not persist anything.
   *
   * Shared by the AI Assistant `create_security` tool and the MCP server so both
   * surfaces look securities up, validate, and pre-fill them identically:
   *   - The provider lookup supplies symbol, name, exchange, security type, and
   *     currency so the AI never guesses them. An `exchange` (used to
   *     disambiguate the lookup) or `securityType` the caller passes -- both
   *     constrained to the known lists -- overrides the looked-up value.
   *   - When the reference matches several distinct tickers and no exchange was
   *     given, it throws a 4xx listing the candidates so the caller can re-run
   *     with an exchange rather than picking one blindly.
   *   - The per-user unique `(userId, symbol)` constraint is checked up front so
   *     a duplicate fails at preview with the same message the real write uses.
   */
  async previewCreateSecurity(
    userId: string,
    input: {
      query: string;
      exchange?: string;
      securityType?: string;
      isFavourite?: boolean;
      /**
       * Override the looked-up currency. Takes precedence over the provider's
       * value, and lets creation proceed when the lookup can't determine one.
       */
      currencyCode?: string;
    },
  ): Promise<CreateSecurityPreview> {
    const query = (input.query ?? "").trim();
    if (!query) {
      throw new BadRequestException(
        tr(
          "errors.securities.lookupQueryRequired",
          "Provide a ticker symbol or security name to look up.",
        ),
      );
    }

    const candidates: SecurityLookupResult[] =
      await this.securityPriceService.lookupSecurityCandidates(
        userId,
        query,
        input.exchange ? [input.exchange] : undefined,
      );

    if (candidates.length === 0) {
      throw new BadRequestException(
        tr(
          "errors.securities.lookupNotFound",
          `No security found matching "${query}". Check the symbol or name, or specify an exchange.`,
          { query },
        ),
      );
    }

    // Without an explicit exchange, a reference that resolves to several
    // different tickers is ambiguous -- surface the options instead of guessing.
    const distinctSymbols = new Set(
      candidates.map((c) => c.symbol.toUpperCase()),
    );
    if (!input.exchange && distinctSymbols.size > 1) {
      const list = candidates
        .slice(0, 5)
        .map(
          (c) =>
            `${c.symbol} (${c.name}${c.exchange ? `, ${c.exchange}` : ""})`,
        )
        .join("; ");
      throw new BadRequestException(
        tr(
          "errors.securities.lookupAmbiguous",
          `"${query}" matches multiple securities: ${list}. Re-run specifying an exchange.`,
          { query, list },
        ),
      );
    }

    const lookup = candidates[0];

    // Currency precedence: the instrument's live-quote currency is
    // authoritative (the lookup guesses from the exchange, which is wrong for
    // non-local-currency listings such as a USD/EUR ETF on the LSE); an
    // explicit override is the fallback that also rescues a lookup the provider
    // can't price; the exchange-derived guess is the last resort.
    let currencyCode =
      input.currencyCode?.trim() || lookup.currencyCode?.trim();
    const authoritativeCurrency =
      await this.securityPriceService.fetchAuthoritativeCurrency(
        userId,
        lookup.symbol,
        lookup.exchange,
      );
    if (authoritativeCurrency) {
      currencyCode = authoritativeCurrency;
    }
    if (!currencyCode) {
      throw new BadRequestException(
        tr(
          "errors.securities.lookupNoCurrency",
          `Could not determine the currency for "${lookup.symbol}". Add the security manually instead.`,
          { symbol: lookup.symbol },
        ),
      );
    }

    // Enforce the per-user unique symbol up front so a duplicate is reported at
    // preview time with the same message the REST/confirm write would throw.
    const existing = await withScopedDb(this.dataSource, (m) =>
      m.getRepository(Security).findOne({
        where: { symbol: lookup.symbol, userId },
      }),
    );
    if (existing) {
      throw new ConflictException(
        tr(
          "errors.securities.symbolAlreadyExists",
          `Security with symbol ${lookup.symbol} already exists`,
          { symbol: lookup.symbol },
        ),
      );
    }

    return {
      symbol: lookup.symbol,
      name: lookup.name,
      securityType: input.securityType ?? lookup.securityType ?? null,
      exchange: input.exchange ?? lookup.exchange ?? null,
      currencyCode: currencyCode.toUpperCase(),
      isFavourite: input.isFavourite ?? false,
      quoteProvider: lookup.provider ?? null,
      msnInstrumentId: lookup.msnInstrumentId ?? null,
    };
  }

  /**
   * Look up a ticker symbol or company name against the user's configured quote
   * provider (Yahoo/MSN) and return every plausible match so an AI agent can
   * help the user pick the right one before adding it. Read-only: it neither
   * persists anything nor enforces the unique-symbol rule. Each candidate is
   * flagged when a security with that symbol is already in the user's list.
   * Shared by the AI Assistant `lookup_securities` tool and the MCP tool.
   */
  async lookupSecuritiesForLlm(
    userId: string,
    input: {
      query: string;
      exchange?: string;
      provider?: "yahoo" | "msn" | "lse" | "deutsche_boerse" | "auto";
    },
  ): Promise<LlmSecurityLookup> {
    const query = (input.query ?? "").trim();
    if (!query) {
      throw new BadRequestException(
        tr(
          "errors.securities.lookupQueryRequired",
          "Provide a ticker symbol or security name to look up.",
        ),
      );
    }

    const results = await this.securityPriceService.lookupSecurityCandidates(
      userId,
      query,
      input.exchange ? [input.exchange] : undefined,
      input.provider,
    );

    const owned = await withScopedDb(this.dataSource, (m) =>
      m.getRepository(Security).find({
        where: { userId },
        select: ["symbol"],
      }),
    );
    const ownedSymbols = new Set(owned.map((s) => s.symbol.toUpperCase()));

    const candidates: LlmSecurityLookupCandidate[] = results.map((r) => ({
      symbol: r.symbol,
      name: r.name,
      exchange: r.exchange ?? null,
      securityType: r.securityType ?? null,
      currencyCode: r.currencyCode ?? null,
      provider: r.provider ?? null,
      alreadyAdded: ownedSymbols.has(r.symbol.toUpperCase()),
    }));

    return { query, count: candidates.length, candidates };
  }

  /**
   * Replace the tag set on a security with `tagIds`, mirroring
   * `TagsService.setTransactionTags`. Validates every tag belongs to the user,
   * then clears and re-inserts the join rows. Pass a `queryRunner` to enlist in
   * a caller's transaction (security create/update do this so the security and
   * its tags commit atomically).
   */
  async setSecurityTags(
    securityId: string,
    tagIds: string[],
    userId: string,
    manager?: EntityManager,
  ): Promise<void> {
    const apply = async (m: EntityManager): Promise<void> => {
      if (tagIds.length > 0) {
        const tags = await m.find(Tag, {
          where: { id: In(tagIds), userId },
        });
        if (tags.length !== tagIds.length) {
          throw new NotFoundException(
            tr("errors.tags.oneOrMoreNotFound", "One or more tags not found"),
          );
        }
      }

      await m.delete(SecurityTag, { securityId });

      if (tagIds.length > 0) {
        const newTags = tagIds.map((tagId) =>
          m.create(SecurityTag, { securityId, tagId }),
        );
        await m.save(SecurityTag, newTags);
      }
    };
    return manager ? apply(manager) : withScopedDb(this.dataSource, apply);
  }

  /**
   * All of the user's securities carrying a given tag, ordered by symbol.
   * Mirrors the per-user scoping of the rest of the service.
   */
  async findByTag(userId: string, tagId: string): Promise<Security[]> {
    return withScopedDb(this.dataSource, (m) =>
      m
        .getRepository(Security)
        .createQueryBuilder("security")
        .innerJoin(
          SecurityTag,
          "st",
          "st.security_id = security.id AND st.tag_id = :tagId",
          { tagId },
        )
        .where("security.userId = :userId", { userId })
        .orderBy("security.symbol", "ASC")
        .getMany(),
    );
  }
}
