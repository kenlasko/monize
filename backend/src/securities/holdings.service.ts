import { Injectable, NotFoundException, ForbiddenException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Holding } from './entities/holding.entity';
import { AccountsService } from '../accounts/accounts.service';
import { SecuritiesService } from './securities.service';

@Injectable()
export class HoldingsService {
  constructor(
    @InjectRepository(Holding)
    private holdingsRepository: Repository<Holding>,
    private accountsService: AccountsService,
    private securitiesService: SecuritiesService,
  ) {}

  async findAll(userId: string, accountId?: string): Promise<Holding[]> {
    const query = this.holdingsRepository
      .createQueryBuilder('holding')
      .leftJoinAndSelect('holding.account', 'account')
      .leftJoinAndSelect('holding.security', 'security')
      .where('account.userId = :userId', { userId });

    if (accountId) {
      query.andWhere('holding.accountId = :accountId', { accountId });
    }

    return query.getMany();
  }

  async findOne(userId: string, id: string): Promise<Holding> {
    const holding = await this.holdingsRepository
      .createQueryBuilder('holding')
      .leftJoinAndSelect('holding.account', 'account')
      .leftJoinAndSelect('holding.security', 'security')
      .where('holding.id = :id', { id })
      .andWhere('account.userId = :userId', { userId })
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
      relations: ['account', 'security'],
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

    // Verify security exists
    await this.securitiesService.findOne(securityId);

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
    return this.createOrUpdate(userId, accountId, securityId, quantityDelta, price);
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
      throw new ForbiddenException('Cannot delete holding with non-zero quantity');
    }

    await this.holdingsRepository.remove(holding);
  }
}
