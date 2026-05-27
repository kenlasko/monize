import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
  Inject,
  forwardRef,
  Logger,
} from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { InjectRepository } from "@nestjs/typeorm";
import { todayInTimezone } from "../common/date-utils";
import {
  Repository,
  In,
  LessThanOrEqual,
  DataSource,
  QueryRunner,
} from "typeorm";
import { Holding } from "./entities/holding.entity";
import {
  InvestmentTransaction,
  InvestmentAction,
} from "./entities/investment-transaction.entity";
import {
  Account,
  AccountType,
  AccountSubType,
} from "../accounts/entities/account.entity";
import { AccountsService } from "../accounts/accounts.service";
import { SecuritiesService } from "./securities.service";

@Injectable()
export class HoldingsService {
  private readonly logger = new Logger(HoldingsService.name);

  constructor(
    @InjectRepository(Holding)
    private holdingsRepository: Repository<Holding>,
    @InjectRepository(InvestmentTransaction)
    private investmentTransactionsRepository: Repository<InvestmentTransaction>,
    @InjectRepository(Account)
    private accountsRepository: Repository<Account>,
    @Inject(forwardRef(() => AccountsService))
    private accountsService: AccountsService,
    private securitiesService: SecuritiesService,
    private dataSource: DataSource,
  ) {}

  async findAll(userId: string, accountId?: string): Promise<Holding[]> {
    const query = this.holdingsRepository
      .createQueryBuilder("holding")
      .leftJoinAndSelect("holding.account", "account")
      .leftJoinAndSelect("holding.security", "security")
      .where("account.userId = :userId", { userId });

    if (accountId) {
      query.andWhere("holding.accountId = :accountId", { accountId });
    }

    return query.getMany();
  }

  async findOne(userId: string, id: string): Promise<Holding> {
    const holding = await this.holdingsRepository
      .createQueryBuilder("holding")
      .leftJoinAndSelect("holding.account", "account")
      .leftJoinAndSelect("holding.security", "security")
      .where("holding.id = :id", { id })
      .andWhere("account.userId = :userId", { userId })
      .getOne();

    if (!holding) {
      throw new NotFoundException(`Holding with ID ${id} not found`);
    }

    return holding;
  }

  async findByAccountAndSecurity(
    accountId: string,
    securityId: string,
    queryRunner?: QueryRunner,
  ): Promise<Holding | null> {
    const repo = queryRunner
      ? queryRunner.manager.getRepository(Holding)
      : this.holdingsRepository;
    return repo.findOne({
      where: { accountId, securityId },
      relations: ["account", "security"],
    });
  }

  /**
   * Compute the holding state for (account, security) as of the start of
   * `asOfDate` -- i.e. after replaying every investment transaction strictly
   * earlier than that date, optionally skipping a single transaction by id
   * (used by the SPLIT form so editing a past split shows holdings as they
   * were just before that split was applied, not the current live state).
   *
   * Returns { quantity, averageCost } even when no holding row exists yet.
   * Mirrors the action handling used by `rebuildFromTransactions` so the two
   * paths stay in sync.
   */
  async getHoldingAt(
    userId: string,
    accountId: string,
    securityId: string,
    asOfDate: string,
    excludeTransactionId?: string,
  ): Promise<{ quantity: number; averageCost: number }> {
    // Verify the user owns the account before exposing transaction history.
    await this.accountsService.findOne(userId, accountId);

    const where: {
      userId: string;
      accountId: string;
      securityId: string;
    } = { userId, accountId, securityId };

    const transactions = await this.investmentTransactionsRepository.find({
      where,
      order: {
        transactionDate: "ASC",
        createdAt: "ASC",
      },
    });

    let qty = 0;
    let totalCost = 0;
    for (const tx of transactions) {
      if (tx.transactionDate >= asOfDate) break;
      if (excludeTransactionId && tx.id === excludeTransactionId) continue;
      const txQty = Number(tx.quantity) || 0;
      const txPrice = Number(tx.price) || 0;
      switch (tx.action) {
        case InvestmentAction.BUY:
        case InvestmentAction.REINVEST:
        case InvestmentAction.TRANSFER_IN:
          totalCost += txQty * txPrice;
          qty += txQty;
          break;
        case InvestmentAction.SELL:
        case InvestmentAction.TRANSFER_OUT: {
          const sellQty = Math.min(txQty, qty);
          if (qty > 0) {
            const avg = totalCost / qty;
            totalCost -= sellQty * avg;
          }
          qty -= txQty;
          break;
        }
        case InvestmentAction.ADD_SHARES:
          qty += txQty;
          break;
        case InvestmentAction.REMOVE_SHARES:
          qty -= txQty;
          break;
        case InvestmentAction.SPLIT:
          if (txQty > 0) {
            qty *= txQty;
          }
          break;
        default:
          // DIVIDEND / INTEREST / CAPITAL_GAIN don't move shares.
          break;
      }
    }

    if (Math.abs(qty) < 1e-8) {
      qty = 0;
      totalCost = 0;
    }
    const averageCost = qty > 0 ? totalCost / qty : 0;
    return { quantity: qty, averageCost };
  }

  async createOrUpdate(
    userId: string,
    accountId: string,
    securityId: string,
    quantityChange: number,
    pricePerShare: number,
    queryRunner?: QueryRunner,
    allowNegative: boolean = false,
  ): Promise<Holding> {
    // Verify account ownership
    await this.accountsService.findOne(userId, accountId);

    // Verify security exists and belongs to user
    await this.securitiesService.findOne(userId, securityId);

    const repo = queryRunner
      ? queryRunner.manager.getRepository(Holding)
      : this.holdingsRepository;

    // Find existing holding
    let holding = await this.findByAccountAndSecurity(
      accountId,
      securityId,
      queryRunner,
    );

    if (!holding) {
      // Create new holding
      holding = repo.create({
        accountId,
        securityId,
        quantity: quantityChange,
        averageCost: pricePerShare,
      });
    } else {
      // Update existing holding
      const currentQuantity = Number(holding.quantity);
      const currentAvgCost = Number(holding.averageCost || 0);
      const newQuantity = currentQuantity + quantityChange;

      if (quantityChange > 0) {
        if (currentQuantity <= 0 && newQuantity > 0) {
          // Coming out of a zero-or-negative balance (e.g. reverse-apply
          // of a past buy): treat this purchase as establishing the new
          // cost basis rather than blending against a phantom negative
          // cost basis.
          holding.averageCost = pricePerShare;
        } else if (currentQuantity > 0 && newQuantity > 0) {
          // Blend the purchase into existing positive holdings.
          const totalCostBefore = currentQuantity * currentAvgCost;
          const totalCostAdded = quantityChange * pricePerShare;
          const newAvgCost = (totalCostBefore + totalCostAdded) / newQuantity;
          holding.averageCost = newAvgCost;
        }
      }

      // Guard against negative holdings from overselling. Skipped when
      // allowNegative is true, which the investment-transaction update and
      // remove flows use to permit intermediate negative states during
      // reverse/re-apply. The caller is responsible for running
      // validateHoldingsHistory afterward so oversells at any historical
      // date are still caught.
      if (!allowNegative && newQuantity < -0.00000001) {
        throw new BadRequestException(
          `Insufficient shares: cannot reduce by ${Math.abs(quantityChange)}, only ${currentQuantity} held`,
        );
      }

      // Snap to zero to avoid floating-point ghost holdings
      holding.quantity = Math.abs(newQuantity) < 0.0001 ? 0 : newQuantity;
    }

    return repo.save(holding);
  }

  async updateHolding(
    userId: string,
    accountId: string,
    securityId: string,
    quantityDelta: number,
    price: number,
    queryRunner?: QueryRunner,
    allowNegative: boolean = false,
  ): Promise<Holding> {
    return this.createOrUpdate(
      userId,
      accountId,
      securityId,
      quantityDelta,
      price,
      queryRunner,
      allowNegative,
    );
  }

  /**
   * Apply a stock split to an existing holding: multiply quantity by the
   * ratio (new shares per old share) and divide averageCost by the same
   * ratio so total cost basis is preserved. A 2-for-1 split (ratio = 2)
   * doubles shares and halves the per-share cost; a 1-for-2 reverse split
   * (ratio = 0.5) halves shares and doubles the per-share cost.
   *
   * No-op when no holding exists for the security in this account.
   */
  async applySplit(
    accountId: string,
    securityId: string,
    ratio: number,
    queryRunner?: QueryRunner,
  ): Promise<Holding | null> {
    if (!ratio || ratio <= 0) {
      throw new BadRequestException("Split ratio must be greater than zero");
    }

    const repo = queryRunner
      ? queryRunner.manager.getRepository(Holding)
      : this.holdingsRepository;

    const holding = await this.findByAccountAndSecurity(
      accountId,
      securityId,
      queryRunner,
    );
    if (!holding) return null;

    const currentQty = Number(holding.quantity);
    const currentAvg = Number(holding.averageCost || 0);
    holding.quantity = currentQty * ratio;
    holding.averageCost = currentAvg / ratio;
    return repo.save(holding);
  }

  /**
   * Reverse a previously applied stock split: divide quantity by the
   * ratio and multiply averageCost by the same ratio. Used by the
   * investment-transaction update/remove flows to undo a SPLIT before
   * re-applying or deleting it.
   */
  async reverseSplit(
    accountId: string,
    securityId: string,
    ratio: number,
    queryRunner?: QueryRunner,
  ): Promise<Holding | null> {
    if (!ratio || ratio <= 0) {
      throw new BadRequestException("Split ratio must be greater than zero");
    }
    return this.applySplit(accountId, securityId, 1 / ratio, queryRunner);
  }

  /**
   * Adjust holding quantity without affecting average cost.
   * Used for ADD_SHARES / REMOVE_SHARES to fix minor discrepancies.
   */
  async adjustQuantity(
    userId: string,
    accountId: string,
    securityId: string,
    quantityChange: number,
    queryRunner?: QueryRunner,
  ): Promise<Holding> {
    await this.accountsService.findOne(userId, accountId);
    await this.securitiesService.findOne(userId, securityId);

    const repo = queryRunner
      ? queryRunner.manager.getRepository(Holding)
      : this.holdingsRepository;

    let holding = await this.findByAccountAndSecurity(
      accountId,
      securityId,
      queryRunner,
    );

    if (!holding) {
      if (quantityChange < 0) {
        throw new NotFoundException(
          "Cannot remove shares from a non-existent holding",
        );
      }
      holding = repo.create({
        accountId,
        securityId,
        quantity: quantityChange,
        averageCost: 0,
      });
    } else {
      holding.quantity = Number(holding.quantity) + quantityChange;
    }

    return repo.save(holding);
  }

  async getHoldingsSummary(userId: string, accountId: string) {
    const holdings = await this.findAll(userId, accountId);

    const summary = {
      totalHoldings: holdings.length,
      totalQuantity: holdings.reduce((sum, h) => sum + Number(h.quantity), 0),
      totalCostBasis: holdings.reduce(
        (sum, h) => sum + Number(h.quantity) * Number(h.averageCost || 0),
        0,
      ),
      holdings: holdings.map((h) => ({
        id: h.id,
        symbol: h.security.symbol,
        name: h.security.name,
        quantity: Number(h.quantity),
        averageCost: Number(h.averageCost || 0),
        costBasis: Number(h.quantity) * Number(h.averageCost || 0),
      })),
    };

    return summary;
  }

  async remove(userId: string, id: string): Promise<void> {
    const holding = await this.findOne(userId, id);

    // Only allow deletion if quantity is zero
    if (Math.abs(Number(holding.quantity)) >= 0.0001) {
      throw new ForbiddenException(
        "Cannot delete holding with non-zero quantity",
      );
    }

    await this.holdingsRepository.remove(holding);
  }

  /**
   * Replay the user's investment transactions in chronological order and
   * throw BadRequestException if any (account, security) pair would have a
   * negative running quantity at any date. Used after editing or deleting a
   * past investment transaction to ensure the change does not retroactively
   * cause an oversell on any historical date.
   */
  /**
   * Replay a user's investment transactions in chronological order and
   * throw BadRequestException if any (account, security) pair would have a
   * negative running quantity at any date. Used after editing or deleting a
   * past investment transaction to ensure the change does not retroactively
   * cause an oversell on any historical date.
   *
   * When `accountIds` is provided, only those accounts are validated. The
   * caller should pass the accounts touched by the edit so pre-existing
   * inconsistencies in unrelated accounts (for example, from historical
   * imports) don't get blamed on this change.
   *
   * When `securityIds` is provided, only those securities are validated
   * within the in-scope accounts. Same rationale: editing a 2026 trade in
   * security A should never surface a 2009 oversell of security B that
   * existed before this edit.
   */
  async validateNoNegativeHoldingsHistory(
    userId: string,
    queryRunner?: QueryRunner,
    accountIds?: string[],
    securityIds?: string[],
  ): Promise<void> {
    const accountsRepo = queryRunner
      ? queryRunner.manager.getRepository(Account)
      : this.accountsRepository;
    const txRepo = queryRunner
      ? queryRunner.manager.getRepository(InvestmentTransaction)
      : this.investmentTransactionsRepository;

    let eligibleAccountIds: string[];
    if (accountIds && accountIds.length > 0) {
      eligibleAccountIds = accountIds;
    } else {
      const investmentAccounts = await accountsRepo.find({
        where: {
          userId,
          accountType: AccountType.INVESTMENT,
        },
      });

      eligibleAccountIds = investmentAccounts
        .filter(
          (a) =>
            a.accountSubType === AccountSubType.INVESTMENT_BROKERAGE ||
            !a.accountSubType,
        )
        .map((a) => a.id);
    }

    if (eligibleAccountIds.length === 0) {
      return;
    }

    const where: Record<string, unknown> = {
      userId,
      accountId: In(eligibleAccountIds),
    };
    if (securityIds && securityIds.length > 0) {
      where.securityId = In(securityIds);
    }
    const transactions = await txRepo.find({
      where,
      relations: ["security"],
      order: {
        transactionDate: "ASC",
        createdAt: "ASC",
      },
    });

    const balances = new Map<string, number>();
    const securityFilter =
      securityIds && securityIds.length > 0 ? new Set(securityIds) : null;

    for (const tx of transactions) {
      if (!tx.securityId) continue;
      if (securityFilter && !securityFilter.has(tx.securityId)) continue;

      const key = `${tx.accountId}:${tx.securityId}`;
      const current = balances.get(key) || 0;
      const quantity = Number(tx.quantity) || 0;

      let next = current;
      switch (tx.action) {
        case InvestmentAction.BUY:
        case InvestmentAction.REINVEST:
        case InvestmentAction.TRANSFER_IN:
        case InvestmentAction.ADD_SHARES:
          next = current + quantity;
          break;
        case InvestmentAction.SELL:
        case InvestmentAction.TRANSFER_OUT:
        case InvestmentAction.REMOVE_SHARES:
          next = current - quantity;
          break;
        case InvestmentAction.SPLIT:
          next = current * quantity;
          break;
        default:
          continue;
      }

      if (next < -0.00000001) {
        const symbol = tx.security?.symbol || "this security";
        throw new BadRequestException(
          `This change would cause holdings of ${symbol} to go negative on ${tx.transactionDate}. ` +
            `A ${tx.action} transaction on that date would reduce the balance below zero.`,
        );
      }

      balances.set(key, next);
    }
  }

  /**
   * Server-local "today" as YYYY-MM-DD. Used as the default holdings cutoff;
   * callers that need a timezone-correct cutoff pass it explicitly.
   */
  private serverToday(): string {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  }

  /**
   * Fold a chronologically-ordered list of investment transactions into a
   * holdings map (accountId -> securityId -> { quantity, totalCost }). Shared by
   * every rebuild path so the share-count and cost-basis math stays identical.
   */
  private computeHoldingsMap(
    transactions: InvestmentTransaction[],
  ): Map<string, Map<string, { quantity: number; totalCost: number }>> {
    // Actions that affect holdings
    const holdingsActions = [
      InvestmentAction.BUY,
      InvestmentAction.SELL,
      InvestmentAction.REINVEST,
      InvestmentAction.TRANSFER_IN,
      InvestmentAction.TRANSFER_OUT,
      InvestmentAction.ADD_SHARES,
      InvestmentAction.REMOVE_SHARES,
      InvestmentAction.SPLIT,
    ];

    // Actions that adjust quantity only (no cost basis change)
    const quantityOnlyActions = [
      InvestmentAction.ADD_SHARES,
      InvestmentAction.REMOVE_SHARES,
    ];

    const holdingsMap = new Map<
      string,
      Map<string, { quantity: number; totalCost: number }>
    >();

    for (const tx of transactions) {
      if (!holdingsActions.includes(tx.action) || !tx.securityId) {
        continue;
      }

      const quantity = Number(tx.quantity) || 0;
      const price = Number(tx.price) || 0;

      // Determine quantity change
      const quantityChange = [
        InvestmentAction.SELL,
        InvestmentAction.TRANSFER_OUT,
        InvestmentAction.REMOVE_SHARES,
      ].includes(tx.action)
        ? -quantity
        : quantity;

      // Get or create account map
      if (!holdingsMap.has(tx.accountId)) {
        holdingsMap.set(tx.accountId, new Map());
      }
      const accountHoldings = holdingsMap.get(tx.accountId)!;

      // Get or create security holding
      if (!accountHoldings.has(tx.securityId)) {
        accountHoldings.set(tx.securityId, { quantity: 0, totalCost: 0 });
      }
      const holding = accountHoldings.get(tx.securityId)!;

      if (tx.action === InvestmentAction.SPLIT) {
        // Stock split: scale quantity by the ratio and preserve total cost
        // basis. totalCost is left untouched because the per-share cost is
        // implicitly recomputed from totalCost / quantity below.
        const ratio = quantity;
        if (ratio > 0) {
          holding.quantity *= ratio;
        }
      } else if (quantityOnlyActions.includes(tx.action)) {
        // ADD_SHARES / REMOVE_SHARES: adjust quantity only, no cost basis change
        holding.quantity += quantityChange;
      } else if (quantityChange > 0) {
        // Buying: add to total cost
        holding.totalCost += quantityChange * price;
        holding.quantity += quantityChange;
      } else {
        // Selling: reduce quantity but keep proportional cost
        const sellQuantity = Math.abs(quantityChange);
        if (holding.quantity > 0) {
          const avgCost = holding.totalCost / holding.quantity;
          holding.totalCost -= sellQuantity * avgCost;
          holding.quantity -= sellQuantity;
        }
      }

      // Snap near-zero to exactly zero to prevent ghost holdings
      if (Math.abs(holding.quantity) < 0.0001) {
        holding.quantity = 0;
        holding.totalCost = 0;
      }
    }

    return holdingsMap;
  }

  /**
   * Rebuild holdings for a specific set of accounts from their transaction
   * history, operating within the caller's open transaction.
   *
   * Unlike `rebuildFromTransactions` (which opens its own transaction and
   * rebuilds every eligible account), this participates in an existing
   * QueryRunner so the rebuild commits or rolls back atomically with the
   * operation that triggered it. Callers that must not silently leave stale or
   * misattributed holdings (e.g. a security-transfer edit, where the
   * incremental reverse/re-apply can misattribute average cost across a zero
   * crossing) use this instead of a best-effort post-commit rebuild.
   */
  async rebuildAccountsFromTransactions(
    userId: string,
    accountIds: string[],
    queryRunner: QueryRunner,
    asOfDate?: string,
  ): Promise<void> {
    if (accountIds.length === 0) return;

    // Only brokerage / standalone investment accounts track holdings; the cash
    // sleeve of an investment account is excluded everywhere else, so it must be
    // excluded here too or its rows would be deleted but never rebuilt.
    const accounts = await queryRunner.manager.find(Account, {
      where: {
        id: In(accountIds),
        userId,
        accountType: AccountType.INVESTMENT,
      },
    });
    const eligibleIds = accounts
      .filter(
        (a) =>
          a.accountSubType === AccountSubType.INVESTMENT_BROKERAGE ||
          !a.accountSubType,
      )
      .map((a) => a.id);
    if (eligibleIds.length === 0) return;

    const cutoff = asOfDate ?? this.serverToday();
    const transactions = await queryRunner.manager.find(InvestmentTransaction, {
      where: {
        userId,
        accountId: In(eligibleIds),
        transactionDate: LessThanOrEqual(cutoff),
      },
      order: {
        transactionDate: "ASC",
        createdAt: "ASC",
      },
    });

    const holdingsMap = this.computeHoldingsMap(transactions);

    // Delete + recreate holdings for these accounts only.
    const existing = await queryRunner.manager.find(Holding, {
      where: { accountId: In(eligibleIds) },
    });
    if (existing.length > 0) {
      await queryRunner.manager.remove(existing);
    }

    const holdingsRepo = queryRunner.manager.getRepository(Holding);
    const holdingsToCreate: Holding[] = [];
    for (const [accountId, securities] of holdingsMap) {
      for (const [securityId, data] of securities) {
        if (Math.abs(data.quantity) > 0.00000001) {
          const avgCost = data.quantity > 0 ? data.totalCost / data.quantity : 0;
          holdingsToCreate.push(
            holdingsRepo.create({
              accountId,
              securityId,
              quantity: data.quantity,
              averageCost: avgCost,
            }),
          );
        }
      }
    }
    if (holdingsToCreate.length > 0) {
      await holdingsRepo.save(holdingsToCreate);
    }
  }

  /**
   * Rebuild all holdings from existing investment transactions.
   * This recalculates all holdings based on transaction history,
   * useful for fixing data after imports that didn't create holdings.
   * Wrapped in a QueryRunner transaction for atomicity.
   */
  async rebuildFromTransactions(
    userId: string,
    asOfDate?: string,
  ): Promise<{
    holdingsCreated: number;
    holdingsUpdated: number;
    holdingsDeleted: number;
  }> {
    // M14: Get all investment accounts (brokerage + standalone) for the user
    const investmentAccounts = await this.accountsRepository.find({
      where: {
        userId,
        accountType: AccountType.INVESTMENT,
      },
    });

    // Include brokerage accounts and standalone investment accounts (null subType)
    const eligibleAccounts = investmentAccounts.filter(
      (a) =>
        a.accountSubType === AccountSubType.INVESTMENT_BROKERAGE ||
        !a.accountSubType,
    );

    if (eligibleAccounts.length === 0) {
      return { holdingsCreated: 0, holdingsUpdated: 0, holdingsDeleted: 0 };
    }

    const brokerageAccountIds = eligibleAccounts.map((a) => a.id);

    // Get all investment transactions for these accounts up to the cutoff date,
    // ordered by date. Future-dated transactions are excluded so they don't
    // affect current holdings. Callers materializing matured transactions (the
    // hourly cron) pass the user's timezone-correct "today" so a transfer dated
    // today in a timezone ahead of the server isn't wrongly treated as future.
    const cutoff = asOfDate ?? this.serverToday();
    const transactions = await this.investmentTransactionsRepository.find({
      where: {
        userId,
        accountId: In(brokerageAccountIds),
        transactionDate: LessThanOrEqual(cutoff),
      },
      order: {
        transactionDate: "ASC",
        createdAt: "ASC",
      },
    });

    // Rebuild holdings from transactions
    // Map: accountId -> securityId -> { quantity, totalCost }
    const holdingsMap = this.computeHoldingsMap(transactions);

    // Wrap delete-all + rebuild in a transaction for atomicity
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    let holdingsDeleted = 0;
    let holdingsCreated = 0;

    try {
      // Delete all existing holdings for these accounts
      const existingHoldings = await queryRunner.manager.find(Holding, {
        where: { accountId: In(brokerageAccountIds) },
      });
      holdingsDeleted = existingHoldings.length;
      if (existingHoldings.length > 0) {
        await queryRunner.manager.remove(existingHoldings);
      }

      // Create new holdings from the calculated values (batched)
      const holdingsRepo = queryRunner.manager.getRepository(Holding);
      const holdingsToCreate: Holding[] = [];
      for (const [accountId, securities] of holdingsMap) {
        for (const [securityId, data] of securities) {
          // Only create holding if there's a non-zero quantity
          if (Math.abs(data.quantity) > 0.00000001) {
            const avgCost =
              data.quantity > 0 ? data.totalCost / data.quantity : 0;
            holdingsToCreate.push(
              holdingsRepo.create({
                accountId,
                securityId,
                quantity: data.quantity,
                averageCost: avgCost,
              }),
            );
          }
        }
      }
      if (holdingsToCreate.length > 0) {
        await holdingsRepo.save(holdingsToCreate);
      }
      holdingsCreated = holdingsToCreate.length;

      await queryRunner.commitTransaction();
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }

    return {
      holdingsCreated,
      holdingsUpdated: 0, // We deleted and recreated, so no updates
      holdingsDeleted,
    };
  }

  /**
   * Apply matured future-dated investment transactions to holdings.
   *
   * Future-dated investment transactions skip the holdings update at creation
   * time. The hourly cash-balance cron rolls cash forward when their date
   * arrives, but it never touches holdings -- and a security transfer has no
   * cash side at all, so without this nothing would ever move the shares.
   * Once per hour we rebuild holdings for any user with an investment
   * transaction dated "today" (per their timezone). The rebuild is idempotent,
   * so re-running it for users who also traded normally today is harmless.
   */
  @Cron("30 * * * *")
  async applyMaturedInvestmentHoldings(): Promise<void> {
    try {
      const userRows: {
        user_id: string;
        timezone: string | null;
        last_client_timezone: string | null;
      }[] = await this.dataSource.query(
        `SELECT u.id as user_id, p.timezone, p.last_client_timezone
           FROM users u
           LEFT JOIN user_preferences p ON p.user_id = u.id`,
      );
      if (userRows.length === 0) return;

      const userIdsByTz = new Map<string, string[]>();
      for (const { user_id, timezone, last_client_timezone } of userRows) {
        const explicit = timezone?.trim();
        const cached = last_client_timezone?.trim();
        const tz =
          explicit && explicit !== "browser"
            ? explicit
            : cached && cached !== "browser"
              ? cached
              : "UTC";
        const list = userIdsByTz.get(tz) ?? [];
        list.push(user_id);
        userIdsByTz.set(tz, list);
      }

      let rebuilt = 0;
      for (const [tz, userIds] of userIdsByTz) {
        const today = todayInTimezone(tz);
        if (!today) continue;

        const maturedRows: { user_id: string }[] = await this.dataSource.query(
          `SELECT DISTINCT user_id
             FROM investment_transactions
             WHERE user_id = ANY($1)
               AND transaction_date = $2`,
          [userIds, today],
        );

        for (const { user_id } of maturedRows) {
          // Pass the user's timezone-correct today as the cutoff so the rebuild
          // includes the transaction that just matured -- without it the rebuild
          // would re-filter against the server's local date and could exclude a
          // transfer dated today in a timezone ahead of the server.
          await this.rebuildFromTransactions(user_id, today);
          rebuilt += 1;
        }
      }

      if (rebuilt > 0) {
        this.logger.log(
          `Rebuilt holdings for ${rebuilt} user(s) with matured investment transactions`,
        );
      }
    } catch (error) {
      this.logger.error(
        `Failed to apply matured investment holdings: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Delete all holdings for a user's brokerage accounts.
   */
  async removeAllForUser(userId: string): Promise<number> {
    // Get all brokerage accounts for the user
    const brokerageAccounts = await this.accountsRepository.find({
      where: {
        userId,
        accountType: AccountType.INVESTMENT,
        accountSubType: AccountSubType.INVESTMENT_BROKERAGE,
      },
    });

    if (brokerageAccounts.length === 0) {
      return 0;
    }

    const brokerageAccountIds = brokerageAccounts.map((a) => a.id);

    // Delete all holdings for these accounts
    const holdings = await this.holdingsRepository.find({
      where: { accountId: In(brokerageAccountIds) },
    });

    const count = holdings.length;
    if (holdings.length > 0) {
      await this.holdingsRepository.remove(holdings);
    }

    return count;
  }
}
