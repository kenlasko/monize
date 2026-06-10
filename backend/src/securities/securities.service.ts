import {
  Injectable,
  Logger,
  NotFoundException,
  ConflictException,
  ForbiddenException,
} from "@nestjs/common";
import { tr } from "../i18n/translate";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { Security } from "./entities/security.entity";
import { Holding } from "./entities/holding.entity";
import { InvestmentTransaction } from "./entities/investment-transaction.entity";
import { CreateSecurityDto } from "./dto/create-security.dto";
import { UpdateSecurityDto } from "./dto/update-security.dto";
import { SecurityPriceService } from "./security-price.service";
import { ActionHistoryService } from "../action-history/action-history.service";

export interface FavouriteSecurityQuote {
  securityId: string;
  symbol: string;
  name: string;
  currencyCode: string;
  currentPrice: number | null;
  previousPrice: number | null;
  dailyChange: number;
  dailyChangePercent: number;
}

@Injectable()
export class SecuritiesService {
  private readonly logger = new Logger(SecuritiesService.name);

  constructor(
    @InjectRepository(Security)
    private securitiesRepository: Repository<Security>,
    @InjectRepository(Holding)
    private holdingsRepository: Repository<Holding>,
    @InjectRepository(InvestmentTransaction)
    private investmentTransactionsRepository: Repository<InvestmentTransaction>,
    private securityPriceService: SecurityPriceService,
    private actionHistoryService: ActionHistoryService,
  ) {}

  async create(
    userId: string,
    createSecurityDto: CreateSecurityDto,
  ): Promise<Security> {
    // Check if symbol already exists for this user
    const existing = await this.securitiesRepository.findOne({
      where: { symbol: createSecurityDto.symbol, userId },
    });

    if (existing) {
      throw new ConflictException(
        tr(
          "errors.securities.symbolAlreadyExists",
          `Security with symbol ${createSecurityDto.symbol} already exists`,
          { symbol: createSecurityDto.symbol },
        ),
      );
    }

    const security = this.securitiesRepository.create({
      ...createSecurityDto,
      userId,
    });
    const saved = await this.securitiesRepository.save(security);

    // Fire-and-forget: backfill 1Y of daily prices for the new security
    this.securityPriceService.backfillSecurity(saved).catch((err) => {
      this.logger.warn(
        `Background price backfill failed for ${saved.symbol}: ${err.message}`,
      );
    });

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
  ): Promise<Array<Security & { lastPriceSource: string | null }>> {
    const where: Record<string, unknown> = { userId };
    if (!includeInactive) {
      where.isActive = true;
    }
    const securities = await this.securitiesRepository.find({
      where,
      order: { symbol: "ASC" },
    });
    return this.attachLastPriceSource(securities);
  }

  /**
   * Decorate each security with the `source` from its most recent price row
   * (via a single grouped query for efficiency). Returns null when the
   * security has no prices yet.
   */
  private async attachLastPriceSource(
    securities: Security[],
  ): Promise<Array<Security & { lastPriceSource: string | null }>> {
    if (securities.length === 0) return [];
    const ids = securities.map((s) => s.id);
    const rows: Array<{ security_id: string; source: string | null }> =
      await this.securitiesRepository.manager.query(
        `SELECT DISTINCT ON (security_id) security_id, source
         FROM security_prices
         WHERE security_id = ANY($1::uuid[])
         ORDER BY security_id, price_date DESC, created_at DESC`,
        [ids],
      );
    const sourceById = new Map(rows.map((r) => [r.security_id, r.source]));
    return securities.map((s) => ({
      ...s,
      lastPriceSource: sourceById.get(s.id) ?? null,
    }));
  }

  async findOne(userId: string, id: string): Promise<Security> {
    const security = await this.securitiesRepository.findOne({
      where: { id, userId },
    });
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
    const security = await this.securitiesRepository.findOne({
      where: { symbol, userId },
    });
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

    // Check for symbol conflicts if updating symbol
    if (
      updateSecurityDto.symbol &&
      updateSecurityDto.symbol !== security.symbol
    ) {
      const existing = await this.securitiesRepository.findOne({
        where: { symbol: updateSecurityDto.symbol, userId },
      });
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
    if (updateSecurityDto.isActive !== undefined)
      security.isActive = updateSecurityDto.isActive;
    if (updateSecurityDto.isFavourite !== undefined)
      security.isFavourite = updateSecurityDto.isFavourite;
    if (updateSecurityDto.quoteProvider !== undefined)
      security.quoteProvider = updateSecurityDto.quoteProvider ?? null;
    if (updateSecurityDto.msnInstrumentId !== undefined)
      security.msnInstrumentId = updateSecurityDto.msnInstrumentId ?? null;

    // The user explicitly opted into a quote source — auto-clear the
    // skipPriceUpdates flag that QIF/OFX import sets on auto-generated
    // symbols so refresh actually picks them up afterwards.
    if (security.quoteProvider || security.msnInstrumentId) {
      security.skipPriceUpdates = false;
    }

    const saved = await this.securitiesRepository.save(security);

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

    return saved;
  }

  async deactivate(userId: string, id: string): Promise<Security> {
    const security = await this.findOne(userId, id);

    // Check if security has any holdings with non-zero quantity
    // Using ABS() to handle potential small negative values from rounding
    const holdingsCount = await this.holdingsRepository
      .createQueryBuilder("holding")
      .leftJoin("holding.account", "account")
      .where("holding.securityId = :securityId", { securityId: id })
      .andWhere("account.userId = :userId", { userId })
      .andWhere("ABS(holding.quantity) > :threshold", { threshold: 0.00000001 })
      .getCount();

    if (holdingsCount > 0) {
      throw new ForbiddenException(
        tr(
          "errors.securities.cannotDeactivateWithHoldings",
          "Cannot deactivate security with active holdings. Please sell all shares first.",
        ),
      );
    }

    security.isActive = false;
    return this.securitiesRepository.save(security);
  }

  async activate(userId: string, id: string): Promise<Security> {
    const security = await this.findOne(userId, id);
    security.isActive = true;
    return this.securitiesRepository.save(security);
  }

  async remove(userId: string, id: string): Promise<void> {
    const security = await this.findOne(userId, id);

    // Check for any holdings with non-zero quantity
    // Using ABS() to handle potential small negative values from rounding
    const holdingsCount = await this.holdingsRepository
      .createQueryBuilder("holding")
      .leftJoin("holding.account", "account")
      .where("holding.securityId = :securityId", { securityId: id })
      .andWhere("account.userId = :userId", { userId })
      .andWhere("ABS(holding.quantity) > :threshold", { threshold: 0.00000001 })
      .getCount();

    if (holdingsCount > 0) {
      throw new ForbiddenException(
        tr(
          "errors.securities.cannotDeleteWithHoldings",
          "Cannot delete security that has holdings. Remove all holdings first.",
        ),
      );
    }

    // Check for any investment transactions referencing this security
    const transactionsCount = await this.investmentTransactionsRepository
      .createQueryBuilder("tx")
      .where("tx.securityId = :securityId", { securityId: id })
      .andWhere("tx.userId = :userId", { userId })
      .getCount();

    if (transactionsCount > 0) {
      throw new ForbiddenException(
        tr(
          "errors.securities.cannotDeleteWithTransactions",
          "Cannot delete security that has investment transactions. Delete all related transactions first.",
        ),
      );
    }

    // Clean up any zero-quantity holding records before deleting the security
    const zeroHoldings = await this.holdingsRepository
      .createQueryBuilder("holding")
      .leftJoin("holding.account", "account")
      .where("holding.securityId = :securityId", { securityId: id })
      .andWhere("account.userId = :userId", { userId })
      .getMany();
    if (zeroHoldings.length > 0) {
      await this.holdingsRepository.remove(zeroHoldings);
    }

    // Security prices cascade-delete via FK constraint
    const beforeData = { ...security };
    await this.securitiesRepository.remove(security);

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
    const securities = await this.securitiesRepository.find({
      where: { userId, isFavourite: true, isActive: true },
      order: { symbol: "ASC" },
    });
    if (securities.length === 0) return [];

    const ids = securities.map((s) => s.id);
    // Two most recent prices per security in a single pass.
    const priceRows: Array<{
      security_id: string;
      close_price: string;
      rn: string;
    }> = await this.securitiesRepository.manager.query(
      `SELECT security_id, close_price, rn FROM (
         SELECT security_id, close_price,
                ROW_NUMBER() OVER (PARTITION BY security_id ORDER BY price_date DESC) as rn
         FROM security_prices
         WHERE security_id = ANY($1::uuid[])
       ) sub
       WHERE rn <= 2
       ORDER BY security_id, rn`,
      [ids],
    );

    const priceMap = new Map<string, number[]>();
    for (const row of priceRows) {
      const existing = priceMap.get(row.security_id) || [];
      existing.push(Number(row.close_price));
      priceMap.set(row.security_id, existing);
    }

    return securities.map((s) => {
      const prices = priceMap.get(s.id) || [];
      const currentPrice = prices[0] ?? null;
      const previousPrice = prices[1] ?? null;
      let dailyChange = 0;
      let dailyChangePercent = 0;
      if (
        currentPrice != null &&
        previousPrice != null &&
        previousPrice !== 0
      ) {
        dailyChange = currentPrice - previousPrice;
        dailyChangePercent = (dailyChange / previousPrice) * 100;
      }
      return {
        securityId: s.id,
        symbol: s.symbol,
        name: s.name,
        currencyCode: s.currencyCode,
        currentPrice,
        previousPrice,
        dailyChange,
        dailyChangePercent,
      };
    });
  }

  async getSecurityIdsWithTransactions(userId: string): Promise<string[]> {
    const results = await this.investmentTransactionsRepository
      .createQueryBuilder("tx")
      .select("DISTINCT tx.securityId", "securityId")
      .where("tx.userId = :userId", { userId })
      .andWhere("tx.securityId IS NOT NULL")
      .getRawMany();

    return results.map((r) => r.securityId);
  }

  async search(userId: string, query: string): Promise<Security[]> {
    return this.securitiesRepository
      .createQueryBuilder("security")
      .where("security.userId = :userId", { userId })
      .andWhere("security.isActive = :isActive", { isActive: true })
      .andWhere(
        "(LOWER(security.symbol) LIKE LOWER(:query) OR LOWER(security.name) LIKE LOWER(:query))",
        { query: `%${query}%` },
      )
      .orderBy("security.symbol", "ASC")
      .take(20)
      .getMany();
  }
}
