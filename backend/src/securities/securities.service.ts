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

  async create(createSecurityDto: CreateSecurityDto): Promise<Security> {
    // Check if symbol already exists
    const existing = await this.securitiesRepository.findOne({
      where: { symbol: createSecurityDto.symbol },
    });

    if (existing) {
      throw new ConflictException(`Security with symbol ${createSecurityDto.symbol} already exists`);
    }

    const security = this.securitiesRepository.create(createSecurityDto);
    return this.securitiesRepository.save(security);
  }

  async findAll(includeInactive: boolean = false): Promise<Security[]> {
    const where = includeInactive ? {} : { isActive: true };
    return this.securitiesRepository.find({ where, order: { symbol: 'ASC' } });
  }

  async findOne(id: string): Promise<Security> {
    const security = await this.securitiesRepository.findOne({ where: { id } });
    if (!security) {
      throw new NotFoundException(`Security with ID ${id} not found`);
    }
    return security;
  }

  async findBySymbol(symbol: string): Promise<Security> {
    const security = await this.securitiesRepository.findOne({ where: { symbol } });
    if (!security) {
      throw new NotFoundException(`Security with symbol ${symbol} not found`);
    }
    return security;
  }

  async update(id: string, updateSecurityDto: UpdateSecurityDto): Promise<Security> {
    const security = await this.findOne(id);

    // Check for symbol conflicts if updating symbol
    if (updateSecurityDto.symbol && updateSecurityDto.symbol !== security.symbol) {
      const existing = await this.securitiesRepository.findOne({
        where: { symbol: updateSecurityDto.symbol },
      });
      if (existing) {
        throw new ConflictException(`Security with symbol ${updateSecurityDto.symbol} already exists`);
      }
    }

    Object.assign(security, updateSecurityDto);
    return this.securitiesRepository.save(security);
  }

  async deactivate(id: string): Promise<Security> {
    const security = await this.findOne(id);
    security.isActive = false;
    return this.securitiesRepository.save(security);
  }

  async activate(id: string): Promise<Security> {
    const security = await this.findOne(id);
    security.isActive = true;
    return this.securitiesRepository.save(security);
  }

  async search(query: string): Promise<Security[]> {
    return this.securitiesRepository
      .createQueryBuilder('security')
      .where('security.isActive = :isActive', { isActive: true })
      .andWhere(
        '(LOWER(security.symbol) LIKE LOWER(:query) OR LOWER(security.name) LIKE LOWER(:query))',
        { query: `%${query}%` },
      )
      .orderBy('security.symbol', 'ASC')
      .take(20)
      .getMany();
  }
}
