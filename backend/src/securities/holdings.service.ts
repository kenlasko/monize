import {
  Injectable,
  NotFoundException,
  ForbiddenException,
} from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository, In, LessThanOrEqual } from "typeorm";
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
  constructor(
    @InjectRepository(Holding)
    private holdingsRepository: Repository<Holding>,
    @InjectRepository(InvestmentTransaction)
    private investmentTransactionsRepository: Repository<InvestmentTransaction>,
    @InjectRepository(Account)
    private accountsRepository: Repository<Account>,
    private accountsService: AccountsService,
    private securitiesService: SecuritiesService,
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
  ): Promise<Holding | null> {
    return this.holdingsRepository.findOne({
      where: { accountId, securityId },
      relations: ["account", "security"],
    });
  }

  async createOrUpdate(
    userId: string,
    accountId: string,
    securityId: string,
    quantityChange: number,
    pricePerShare: number,
  ): Promise<Holding> {
    // Verify account ownership
    await this.accountsService.findOne(userId, accountId);

    // Verify security exists and belongs to user
    await this.securitiesService.findOne(userId, securityId);

    // Find existing holding
    let holding = await this.findByAccountAndSecurity(accountId, securityId);

    if (!holding) {
      // Create new holding
      holding = this.holdingsRepository.create({
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
        // Buying shares - calculate new average cost
        const totalCostBefore = currentQuantity * currentAvgCost;
        const totalCostAdded = quantityChange * pricePerShare;
        const newAvgCost = (totalCostBefore + totalCostAdded) / newQuantity;
        holding.averageCost = newAvgCost;
      } else {
        // Selling shares - keep same average cost
        // Average cost doesn't change when selling
      }

      holding.quantity = newQuantity;
    }

    return this.holdingsRepository.save(holding);
  }

  async updateHolding(
    userId: string,
    accountId: string,
    securityId: string,
    quantityDelta: number,
    price: number,
  ): Promise<Holding> {
    return this.createOrUpdate(
      userId,
      accountId,
      securityId,
      quantityDelta,
      price,
    );
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
  ): Promise<Holding> {
    await this.accountsService.findOne(userId, accountId);
    await this.securitiesService.findOne(userId, securityId);

    let holding = await this.findByAccountAndSecurity(accountId, securityId);

    if (!holding) {
      if (quantityChange < 0) {
        throw new NotFoundException(
          "Cannot remove shares from a non-existent holding",
        );
      }
      holding = this.holdingsRepository.create({
        accountId,
        securityId,
        quantity: quantityChange,
        averageCost: 0,
      });
    } else {
      holding.quantity = Number(holding.quantity) + quantityChange;
    }

    return this.holdingsRepository.save(holding);
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
    if (Number(holding.quantity) !== 0) {
      throw new ForbiddenException(
        "Cannot delete holding with non-zero quantity",
      );
    }

    await this.holdingsRepository.remove(holding);
  }

  /**
   * Rebuild all holdings from existing investment transactions.
   * This recalculates all holdings based on transaction history,
   * useful for fixing data after imports that didn't create holdings.
   */
  async rebuildFromTransactions(userId: string): Promise<{
    holdingsCreated: number;
    holdingsUpdated: number;
    holdingsDeleted: number;
  }> {
    // Get all brokerage accounts for the user
    const brokerageAccounts = await this.accountsRepository.find({
      where: {
        userId,
        accountType: AccountType.INVESTMENT,
        accountSubType: AccountSubType.INVESTMENT_BROKERAGE,
      },
    });

    if (brokerageAccounts.length === 0) {
      return { holdingsCreated: 0, holdingsUpdated: 0, holdingsDeleted: 0 };
    }

    const brokerageAccountIds = brokerageAccounts.map((a) => a.id);

    // Get all investment transactions for these accounts up to today, ordered by date
    // Future-dated transactions are excluded so they don't affect current holdings
    const now = new Date();
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    const transactions = await this.investmentTransactionsRepository.find({
      where: {
        userId,
        accountId: In(brokerageAccountIds),
        transactionDate: LessThanOrEqual(today),
      },
      order: {
        transactionDate: "ASC",
        createdAt: "ASC",
      },
    });

    // Delete all existing holdings for these accounts
    const existingHoldings = await this.holdingsRepository.find({
      where: { accountId: In(brokerageAccountIds) },
    });
    const holdingsDeleted = existingHoldings.length;
    if (existingHoldings.length > 0) {
      await this.holdingsRepository.remove(existingHoldings);
    }

    // Actions that affect holdings
    const holdingsActions = [
      InvestmentAction.BUY,
      InvestmentAction.SELL,
      InvestmentAction.REINVEST,
      InvestmentAction.TRANSFER_IN,
      InvestmentAction.TRANSFER_OUT,
      InvestmentAction.ADD_SHARES,
      InvestmentAction.REMOVE_SHARES,
    ];

    // Actions that adjust quantity only (no cost basis change)
    const quantityOnlyActions = [
      InvestmentAction.ADD_SHARES,
      InvestmentAction.REMOVE_SHARES,
    ];

    // Rebuild holdings from transactions
    // Map: accountId -> securityId -> { quantity, totalCost }
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

      if (quantityOnlyActions.includes(tx.action)) {
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
    }

    // Create new holdings from the calculated values
    let holdingsCreated = 0;
    for (const [accountId, securities] of holdingsMap) {
      for (const [securityId, data] of securities) {
        // Only create holding if there's a non-zero quantity
        if (Math.abs(data.quantity) > 0.00000001) {
          const avgCost =
            data.quantity > 0 ? data.totalCost / data.quantity : 0;
          const holding = this.holdingsRepository.create({
            accountId,
            securityId,
            quantity: data.quantity,
            averageCost: avgCost,
          });
          await this.holdingsRepository.save(holding);
          holdingsCreated++;
        }
      }
    }

    return {
      holdingsCreated,
      holdingsUpdated: 0, // We deleted and recreated, so no updates
      holdingsDeleted,
    };
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
