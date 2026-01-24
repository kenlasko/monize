import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, LessThanOrEqual } from 'typeorm';
import { ScheduledTransaction, FrequencyType } from './entities/scheduled-transaction.entity';
import { ScheduledTransactionSplit } from './entities/scheduled-transaction-split.entity';
import { CreateScheduledTransactionDto } from './dto/create-scheduled-transaction.dto';
import { UpdateScheduledTransactionDto } from './dto/update-scheduled-transaction.dto';
import { CreateScheduledTransactionSplitDto } from './dto/create-scheduled-transaction-split.dto';
import { AccountsService } from '../accounts/accounts.service';
import { TransactionsService } from '../transactions/transactions.service';

@Injectable()
export class ScheduledTransactionsService {
  constructor(
    @InjectRepository(ScheduledTransaction)
    private scheduledTransactionsRepository: Repository<ScheduledTransaction>,
    @InjectRepository(ScheduledTransactionSplit)
    private splitsRepository: Repository<ScheduledTransactionSplit>,
    private accountsService: AccountsService,
    private transactionsService: TransactionsService,
  ) {}

  async create(
    userId: string,
    createDto: CreateScheduledTransactionDto,
  ): Promise<ScheduledTransaction> {
    // Verify account belongs to user
    await this.accountsService.findOne(userId, createDto.accountId);

    const { splits, ...transactionData } = createDto;
    const hasSplits = splits && splits.length > 0;

    // Validate splits if provided
    if (hasSplits) {
      this.validateSplits(splits, createDto.amount);
    }

    const scheduledTransaction = this.scheduledTransactionsRepository.create({
      ...transactionData,
      userId,
      startDate: transactionData.startDate || transactionData.nextDueDate,
      totalOccurrences: transactionData.occurrencesRemaining,
      categoryId: hasSplits ? null : transactionData.categoryId,
      isSplit: hasSplits,
    });

    const saved = await this.scheduledTransactionsRepository.save(scheduledTransaction);

    // Create splits if provided
    if (hasSplits) {
      await this.createSplits(saved.id, splits);
    }

    return this.findOne(userId, saved.id);
  }

  private validateSplits(splits: CreateScheduledTransactionSplitDto[], transactionAmount: number): void {
    if (splits.length < 2) {
      throw new BadRequestException('Split transactions must have at least 2 splits');
    }

    const splitsSum = splits.reduce((sum, split) => sum + Number(split.amount), 0);
    const roundedSum = Math.round(splitsSum * 10000) / 10000;
    const roundedAmount = Math.round(Number(transactionAmount) * 10000) / 10000;

    if (roundedSum !== roundedAmount) {
      throw new BadRequestException(
        `Split amounts (${roundedSum}) must equal transaction amount (${roundedAmount})`,
      );
    }

    for (const split of splits) {
      if (split.amount === 0) {
        throw new BadRequestException('Split amounts cannot be zero');
      }
    }
  }

  private async createSplits(
    scheduledTransactionId: string,
    splits: CreateScheduledTransactionSplitDto[],
  ): Promise<ScheduledTransactionSplit[]> {
    const splitEntities = splits.map((split) =>
      this.splitsRepository.create({
        scheduledTransactionId,
        categoryId: split.categoryId || null,
        amount: split.amount,
        memo: split.memo || null,
      }),
    );

    return this.splitsRepository.save(splitEntities);
  }

  async findAll(userId: string): Promise<ScheduledTransaction[]> {
    return this.scheduledTransactionsRepository.find({
      where: { userId },
      relations: ['account', 'payee', 'category', 'splits', 'splits.category'],
      order: { nextDueDate: 'ASC' },
    });
  }

  async findOne(userId: string, id: string): Promise<ScheduledTransaction> {
    const scheduled = await this.scheduledTransactionsRepository.findOne({
      where: { id },
      relations: ['account', 'payee', 'category', 'splits', 'splits.category'],
    });

    if (!scheduled) {
      throw new NotFoundException(`Scheduled transaction with ID ${id} not found`);
    }

    if (scheduled.userId !== userId) {
      throw new ForbiddenException('You do not have access to this scheduled transaction');
    }

    return scheduled;
  }

  async findDue(userId: string): Promise<ScheduledTransaction[]> {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    return this.scheduledTransactionsRepository.find({
      where: {
        userId,
        isActive: true,
        nextDueDate: LessThanOrEqual(today),
      },
      relations: ['account', 'payee', 'category', 'splits', 'splits.category'],
      order: { nextDueDate: 'ASC' },
    });
  }

  async findUpcoming(userId: string, days: number = 30): Promise<ScheduledTransaction[]> {
    const today = new Date();
    const futureDate = new Date();
    futureDate.setDate(futureDate.getDate() + days);

    return this.scheduledTransactionsRepository
      .createQueryBuilder('st')
      .leftJoinAndSelect('st.account', 'account')
      .leftJoinAndSelect('st.payee', 'payee')
      .leftJoinAndSelect('st.category', 'category')
      .leftJoinAndSelect('st.splits', 'splits')
      .leftJoinAndSelect('splits.category', 'splitCategory')
      .where('st.userId = :userId', { userId })
      .andWhere('st.isActive = :isActive', { isActive: true })
      .andWhere('st.nextDueDate <= :futureDate', { futureDate })
      .orderBy('st.nextDueDate', 'ASC')
      .getMany();
  }

  async update(
    userId: string,
    id: string,
    updateDto: UpdateScheduledTransactionDto,
  ): Promise<ScheduledTransaction> {
    const scheduled = await this.findOne(userId, id);

    // If account is being changed, verify new account belongs to user
    if (updateDto.accountId && updateDto.accountId !== scheduled.accountId) {
      await this.accountsService.findOne(userId, updateDto.accountId);
    }

    const { splits, ...updateData } = updateDto;

    // Handle splits if provided
    if (splits !== undefined) {
      if (Array.isArray(splits) && splits.length > 0) {
        const amount = updateData.amount ?? scheduled.amount;
        this.validateSplits(splits, amount);

        // Delete existing splits and create new ones
        await this.splitsRepository.delete({ scheduledTransactionId: id });
        await this.createSplits(id, splits);

        // Update to split mode
        await this.scheduledTransactionsRepository.update(id, {
          isSplit: true,
          categoryId: null,
        });
      } else if (Array.isArray(splits) && splits.length === 0) {
        // Convert back to simple transaction
        await this.splitsRepository.delete({ scheduledTransactionId: id });
        await this.scheduledTransactionsRepository.update(id, { isSplit: false });
      }
    }

    // Build update object - only include defined fields, convert empty strings to null for nullable fields
    const fieldsToUpdate: Record<string, any> = {};

    if (updateData.accountId !== undefined) fieldsToUpdate.accountId = updateData.accountId;
    if (updateData.name !== undefined) fieldsToUpdate.name = updateData.name;
    if (updateData.payeeId !== undefined) fieldsToUpdate.payeeId = updateData.payeeId || null;
    if (updateData.payeeName !== undefined) fieldsToUpdate.payeeName = updateData.payeeName || null;
    if (updateData.categoryId !== undefined) fieldsToUpdate.categoryId = updateData.categoryId || null;
    if (updateData.amount !== undefined) fieldsToUpdate.amount = updateData.amount;
    if (updateData.currencyCode !== undefined) fieldsToUpdate.currencyCode = updateData.currencyCode;
    if (updateData.description !== undefined) fieldsToUpdate.description = updateData.description || null;
    if (updateData.frequency !== undefined) fieldsToUpdate.frequency = updateData.frequency;
    if (updateData.nextDueDate !== undefined) fieldsToUpdate.nextDueDate = updateData.nextDueDate;
    if (updateData.startDate !== undefined) fieldsToUpdate.startDate = updateData.startDate;
    if (updateData.endDate !== undefined) fieldsToUpdate.endDate = updateData.endDate || null;
    if (updateData.occurrencesRemaining !== undefined) fieldsToUpdate.occurrencesRemaining = updateData.occurrencesRemaining ?? null;
    if (updateData.isActive !== undefined) fieldsToUpdate.isActive = updateData.isActive;
    if (updateData.autoPost !== undefined) fieldsToUpdate.autoPost = updateData.autoPost;
    if (updateData.reminderDaysBefore !== undefined) fieldsToUpdate.reminderDaysBefore = updateData.reminderDaysBefore;

    // Update using repository.update() to avoid issues with loaded relations
    if (Object.keys(fieldsToUpdate).length > 0) {
      await this.scheduledTransactionsRepository.update(id, fieldsToUpdate);
    }

    return this.findOne(userId, id);
  }

  async remove(userId: string, id: string): Promise<void> {
    const scheduled = await this.findOne(userId, id);
    await this.scheduledTransactionsRepository.remove(scheduled);
  }

  async skip(userId: string, id: string): Promise<ScheduledTransaction> {
    const scheduled = await this.findOne(userId, id);

    // Advance to next occurrence without posting
    const nextDate = this.calculateNextDueDate(new Date(scheduled.nextDueDate), scheduled.frequency);

    // Build update object
    const updateFields: Record<string, any> = {
      nextDueDate: nextDate,
    };

    if (scheduled.occurrencesRemaining !== null && scheduled.occurrencesRemaining > 0) {
      const newRemaining = scheduled.occurrencesRemaining - 1;
      updateFields.occurrencesRemaining = newRemaining;
      if (newRemaining === 0) {
        updateFields.isActive = false;
      }
    }

    if (scheduled.endDate && nextDate > new Date(scheduled.endDate)) {
      updateFields.isActive = false;
    }

    // Use repository.update() to avoid issues with loaded relations
    await this.scheduledTransactionsRepository.update(id, updateFields);
    return this.findOne(userId, id);
  }

  async post(userId: string, id: string, transactionDate?: string): Promise<ScheduledTransaction> {
    const scheduled = await this.findOne(userId, id);

    // Convert nextDueDate to string format for transaction
    const nextDueDateStr = scheduled.nextDueDate instanceof Date
      ? scheduled.nextDueDate.toISOString().split('T')[0]
      : String(scheduled.nextDueDate).split('T')[0];

    // Build transaction payload
    const transactionPayload: any = {
      accountId: scheduled.accountId,
      transactionDate: transactionDate || nextDueDateStr,
      payeeId: scheduled.payeeId || undefined,
      payeeName: scheduled.payeeName || undefined,
      amount: Number(scheduled.amount),
      currencyCode: scheduled.currencyCode,
      description: scheduled.description || undefined,
      isCleared: false,
    };

    // If split transaction, include splits
    if (scheduled.isSplit && scheduled.splits && scheduled.splits.length > 0) {
      transactionPayload.splits = scheduled.splits.map((split) => ({
        categoryId: split.categoryId || undefined,
        amount: Number(split.amount),
        memo: split.memo || undefined,
      }));
    } else {
      transactionPayload.categoryId = scheduled.categoryId || undefined;
    }

    // Create the actual transaction
    await this.transactionsService.create(userId, transactionPayload);

    // Build update object for scheduled transaction
    const updateFields: Record<string, any> = {
      lastPostedDate: new Date(),
    };

    if (scheduled.frequency === 'ONCE') {
      updateFields.isActive = false;
    } else {
      const nextDate = this.calculateNextDueDate(new Date(scheduled.nextDueDate), scheduled.frequency);
      updateFields.nextDueDate = nextDate;

      if (scheduled.occurrencesRemaining !== null && scheduled.occurrencesRemaining > 0) {
        const newRemaining = scheduled.occurrencesRemaining - 1;
        updateFields.occurrencesRemaining = newRemaining;
        if (newRemaining === 0) {
          updateFields.isActive = false;
        }
      }

      if (scheduled.endDate && nextDate > new Date(scheduled.endDate)) {
        updateFields.isActive = false;
      }
    }

    // Use repository.update() to avoid issues with loaded relations
    await this.scheduledTransactionsRepository.update(id, updateFields);
    return this.findOne(userId, id);
  }

  private calculateNextDueDate(currentDate: Date, frequency: FrequencyType): Date {
    const date = new Date(currentDate);

    switch (frequency) {
      case 'DAILY':
        date.setDate(date.getDate() + 1);
        break;
      case 'WEEKLY':
        date.setDate(date.getDate() + 7);
        break;
      case 'BIWEEKLY':
        date.setDate(date.getDate() + 14);
        break;
      case 'MONTHLY':
        date.setMonth(date.getMonth() + 1);
        break;
      case 'QUARTERLY':
        date.setMonth(date.getMonth() + 3);
        break;
      case 'YEARLY':
        date.setFullYear(date.getFullYear() + 1);
        break;
      case 'ONCE':
      default:
        // No change for one-time transactions
        break;
    }

    return date;
  }
}
