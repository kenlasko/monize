import {
  Injectable,
  Logger,
  NotFoundException,
  ConflictException,
  ForbiddenException,
} from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { Security } from "./entities/security.entity";
import { Holding } from "./entities/holding.entity";
import { InvestmentTransaction } from "./entities/investment-transaction.entity";
import { CreateSecurityDto } from "./dto/create-security.dto";
import { UpdateSecurityDto } from "./dto/update-security.dto";
import { SecurityPriceService } from "./security-price.service";

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
        `Security with symbol ${createSecurityDto.symbol} already exists`,
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

    return saved;
  }

  async findAll(
    userId: string,
    includeInactive: boolean = false,
  ): Promise<Security[]> {
    const where: Record<string, unknown> = { userId };
    if (!includeInactive) {
      where.isActive = true;
    }
    return this.securitiesRepository.find({ where, order: { symbol: "ASC" } });
  }

  async findOne(userId: string, id: string): Promise<Security> {
    const security = await this.securitiesRepository.findOne({
      where: { id, userId },
    });
    if (!security) {
      throw new NotFoundException(`Security with ID ${id} not found`);
    }
    return security;
  }

  async findBySymbol(userId: string, symbol: string): Promise<Security> {
    const security = await this.securitiesRepository.findOne({
      where: { symbol, userId },
    });
    if (!security) {
      throw new NotFoundException(`Security with symbol ${symbol} not found`);
    }
    return security;
  }

  async update(
    userId: string,
    id: string,
    updateSecurityDto: UpdateSecurityDto,
  ): Promise<Security> {
    const security = await this.findOne(userId, id);

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
          `Security with symbol ${updateSecurityDto.symbol} already exists`,
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

    return this.securitiesRepository.save(security);
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
        "Cannot deactivate security with active holdings. Please sell all shares first.",
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

    // Check for any holdings (including zero-quantity ones from closed accounts)
    const holdingsCount = await this.holdingsRepository
      .createQueryBuilder("holding")
      .leftJoin("holding.account", "account")
      .where("holding.securityId = :securityId", { securityId: id })
      .andWhere("account.userId = :userId", { userId })
      .getCount();

    if (holdingsCount > 0) {
      throw new ForbiddenException(
        "Cannot delete security that has holdings. Remove all holdings first.",
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
        "Cannot delete security that has investment transactions. Delete all related transactions first.",
      );
    }

    // Security prices cascade-delete via FK constraint
    await this.securitiesRepository.remove(security);
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
