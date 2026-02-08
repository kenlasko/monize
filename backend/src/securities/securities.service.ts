import { Injectable, NotFoundException, ConflictException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Security } from './entities/security.entity';
import { CreateSecurityDto } from './dto/create-security.dto';
import { UpdateSecurityDto } from './dto/update-security.dto';

@Injectable()
export class SecuritiesService {
  constructor(
    @InjectRepository(Security)
    private securitiesRepository: Repository<Security>,
  ) {}

  async create(userId: string, createSecurityDto: CreateSecurityDto): Promise<Security> {
    // Check if symbol already exists for this user
    const existing = await this.securitiesRepository.findOne({
      where: { symbol: createSecurityDto.symbol, userId },
    });

    if (existing) {
      throw new ConflictException(`Security with symbol ${createSecurityDto.symbol} already exists`);
    }

    const security = this.securitiesRepository.create({
      ...createSecurityDto,
      userId,
    });
    return this.securitiesRepository.save(security);
  }

  async findAll(userId: string, includeInactive: boolean = false): Promise<Security[]> {
    const where: Record<string, unknown> = { userId };
    if (!includeInactive) {
      where.isActive = true;
    }
    return this.securitiesRepository.find({ where, order: { symbol: 'ASC' } });
  }

  async findOne(userId: string, id: string): Promise<Security> {
    const security = await this.securitiesRepository.findOne({ where: { id, userId } });
    if (!security) {
      throw new NotFoundException(`Security with ID ${id} not found`);
    }
    return security;
  }

  async findBySymbol(userId: string, symbol: string): Promise<Security> {
    const security = await this.securitiesRepository.findOne({ where: { symbol, userId } });
    if (!security) {
      throw new NotFoundException(`Security with symbol ${symbol} not found`);
    }
    return security;
  }

  async update(userId: string, id: string, updateSecurityDto: UpdateSecurityDto): Promise<Security> {
    const security = await this.findOne(userId, id);

    // Check for symbol conflicts if updating symbol
    if (updateSecurityDto.symbol && updateSecurityDto.symbol !== security.symbol) {
      const existing = await this.securitiesRepository.findOne({
        where: { symbol: updateSecurityDto.symbol, userId },
      });
      if (existing) {
        throw new ConflictException(`Security with symbol ${updateSecurityDto.symbol} already exists`);
      }
    }

    // SECURITY: Explicit property mapping instead of Object.assign to prevent mass assignment
    if (updateSecurityDto.symbol !== undefined) security.symbol = updateSecurityDto.symbol;
    if (updateSecurityDto.name !== undefined) security.name = updateSecurityDto.name;
    if (updateSecurityDto.securityType !== undefined) security.securityType = updateSecurityDto.securityType;
    if (updateSecurityDto.exchange !== undefined) security.exchange = updateSecurityDto.exchange;
    if (updateSecurityDto.currencyCode !== undefined) security.currencyCode = updateSecurityDto.currencyCode;
    if (updateSecurityDto.isActive !== undefined) security.isActive = updateSecurityDto.isActive;

    return this.securitiesRepository.save(security);
  }

  async deactivate(userId: string, id: string): Promise<Security> {
    const security = await this.findOne(userId, id);
    security.isActive = false;
    return this.securitiesRepository.save(security);
  }

  async activate(userId: string, id: string): Promise<Security> {
    const security = await this.findOne(userId, id);
    security.isActive = true;
    return this.securitiesRepository.save(security);
  }

  async search(userId: string, query: string): Promise<Security[]> {
    return this.securitiesRepository
      .createQueryBuilder('security')
      .where('security.userId = :userId', { userId })
      .andWhere('security.isActive = :isActive', { isActive: true })
      .andWhere(
        '(LOWER(security.symbol) LIKE LOWER(:query) OR LOWER(security.name) LIKE LOWER(:query))',
        { query: `%${query}%` },
      )
      .orderBy('security.symbol', 'ASC')
      .take(20)
      .getMany();
  }
}
