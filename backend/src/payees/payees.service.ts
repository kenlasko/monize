import { Injectable, NotFoundException, ConflictException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Like } from 'typeorm';
import { Payee } from './entities/payee.entity';
import { CreatePayeeDto } from './dto/create-payee.dto';
import { UpdatePayeeDto } from './dto/update-payee.dto';

@Injectable()
export class PayeesService {
  constructor(
    @InjectRepository(Payee)
    private payeesRepository: Repository<Payee>,
  ) {}

  async create(userId: string, createPayeeDto: CreatePayeeDto): Promise<Payee> {
    // Check if payee with same name already exists for this user
    const existing = await this.payeesRepository.findOne({
      where: {
        userId,
        name: createPayeeDto.name,
      },
    });

    if (existing) {
      throw new ConflictException(`Payee with name "${createPayeeDto.name}" already exists`);
    }

    const payee = this.payeesRepository.create({
      ...createPayeeDto,
      userId,
    });

    return this.payeesRepository.save(payee);
  }

  async findAll(userId: string): Promise<Payee[]> {
    return this.payeesRepository.find({
      where: { userId },
      relations: ['defaultCategory'],
      order: { name: 'ASC' },
    });
  }

  async findOne(userId: string, id: string): Promise<Payee> {
    const payee = await this.payeesRepository.findOne({
      where: { id, userId },
      relations: ['defaultCategory'],
    });

    if (!payee) {
      throw new NotFoundException(`Payee with ID ${id} not found`);
    }

    return payee;
  }

  async search(userId: string, query: string, limit: number = 10): Promise<Payee[]> {
    return this.payeesRepository.find({
      where: {
        userId,
        name: Like(`%${query}%`),
      },
      relations: ['defaultCategory'],
      order: { name: 'ASC' },
      take: limit,
    });
  }

  async autocomplete(userId: string, query: string): Promise<Payee[]> {
    // Return payees that start with the query (for autocomplete)
    return this.payeesRepository.find({
      where: {
        userId,
        name: Like(`${query}%`),
      },
      relations: ['defaultCategory'],
      order: { name: 'ASC' },
      take: 10,
    });
  }

  async findByName(userId: string, name: string): Promise<Payee | null> {
    return this.payeesRepository.findOne({
      where: { userId, name },
      relations: ['defaultCategory'],
    });
  }

  async findOrCreate(userId: string, name: string, defaultCategoryId?: string): Promise<Payee> {
    // Try to find existing payee by name
    let payee = await this.findByName(userId, name);

    if (!payee) {
      // Create new payee if it doesn't exist
      payee = await this.create(userId, {
        name,
        defaultCategoryId,
      });
    }

    return payee;
  }

  async update(userId: string, id: string, updatePayeeDto: UpdatePayeeDto): Promise<Payee> {
    const payee = await this.findOne(userId, id);

    // Check for name conflicts if name is being updated
    if (updatePayeeDto.name && updatePayeeDto.name !== payee.name) {
      const existing = await this.payeesRepository.findOne({
        where: {
          userId,
          name: updatePayeeDto.name,
        },
      });

      if (existing) {
        throw new ConflictException(`Payee with name "${updatePayeeDto.name}" already exists`);
      }
    }

    Object.assign(payee, updatePayeeDto);
    return this.payeesRepository.save(payee);
  }

  async remove(userId: string, id: string): Promise<void> {
    const payee = await this.findOne(userId, id);
    await this.payeesRepository.remove(payee);
  }

  async getMostUsed(userId: string, limit: number = 10): Promise<Payee[]> {
    // Get payees ordered by usage count (number of transactions)
    const result = await this.payeesRepository
      .createQueryBuilder('payee')
      .leftJoin('transactions', 'transaction', 'transaction.payee_id = payee.id')
      .where('payee.user_id = :userId', { userId })
      .groupBy('payee.id')
      .orderBy('COUNT(transaction.id)', 'DESC')
      .limit(limit)
      .getMany();

    // Load relations for the results
    const ids = result.map(p => p.id);
    if (ids.length === 0) return [];

    return this.payeesRepository.find({
      where: { id: In(ids) },
      relations: ['defaultCategory'],
    });
  }

  async getRecentlyUsed(userId: string, limit: number = 10): Promise<Payee[]> {
    // Get payees ordered by most recent transaction
    const result = await this.payeesRepository
      .createQueryBuilder('payee')
      .leftJoin('transactions', 'transaction', 'transaction.payee_id = payee.id')
      .where('payee.user_id = :userId', { userId })
      .groupBy('payee.id')
      .orderBy('MAX(transaction.transaction_date)', 'DESC')
      .limit(limit)
      .getMany();

    // Load relations for the results
    const ids = result.map(p => p.id);
    if (ids.length === 0) return [];

    return this.payeesRepository.find({
      where: { id: In(ids) },
      relations: ['defaultCategory'],
    });
  }

  async getSummary(userId: string) {
    const totalPayees = await this.payeesRepository.count({
      where: { userId },
    });

    const payeesWithCategory = await this.payeesRepository.count({
      where: {
        userId,
        defaultCategoryId: Not(IsNull()),
      },
    });

    return {
      totalPayees,
      payeesWithCategory,
      payeesWithoutCategory: totalPayees - payeesWithCategory,
    };
  }

  async findByCategory(userId: string, categoryId: string): Promise<Payee[]> {
    return this.payeesRepository.find({
      where: {
        userId,
        defaultCategoryId: categoryId,
      },
      relations: ['defaultCategory'],
      order: { name: 'ASC' },
    });
  }
}

// Import these at the top with other imports
import { In, Not, IsNull } from 'typeorm';
