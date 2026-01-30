import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
  Inject,
  forwardRef,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, LessThanOrEqual } from 'typeorm';
import { ScheduledTransaction, FrequencyType } from './entities/scheduled-transaction.entity';
import { ScheduledTransactionSplit } from './entities/scheduled-transaction-split.entity';
import { ScheduledTransactionOverride } from './entities/scheduled-transaction-override.entity';
import { CreateScheduledTransactionDto } from './dto/create-scheduled-transaction.dto';
import { UpdateScheduledTransactionDto } from './dto/update-scheduled-transaction.dto';
import { CreateScheduledTransactionSplitDto } from './dto/create-scheduled-transaction-split.dto';
import {
  CreateScheduledTransactionOverrideDto,
  UpdateScheduledTransactionOverrideDto,
} from './dto/scheduled-transaction-override.dto';
import { PostScheduledTransactionDto } from './dto/post-scheduled-transaction.dto';
import { AccountsService } from '../accounts/accounts.service';
import { TransactionsService } from '../transactions/transactions.service';
import { Account } from '../accounts/entities/account.entity';
import {
  calculatePaymentSplit,
  PaymentFrequency,
} from '../accounts/loan-amortization.util';

@Injectable()
export class ScheduledTransactionsService {
  constructor(
    @InjectRepository(ScheduledTransaction)
    private scheduledTransactionsRepository: Repository<ScheduledTransaction>,
    @InjectRepository(ScheduledTransactionSplit)
    private splitsRepository: Repository<ScheduledTransactionSplit>,
    @InjectRepository(ScheduledTransactionOverride)
    private overridesRepository: Repository<ScheduledTransactionOverride>,
    @InjectRepository(Account)
    private accountsRepository: Repository<Account>,
    @Inject(forwardRef(() => AccountsService))
    private accountsService: AccountsService,
    private transactionsService: TransactionsService,
  ) {}

  async create(
    userId: string,
    createDto: CreateScheduledTransactionDto,
  ): Promise<ScheduledTransaction> {
    // Verify account belongs to user
    await this.accountsService.findOne(userId, createDto.accountId);

    // Verify transfer account if this is a transfer
    if (createDto.isTransfer && createDto.transferAccountId) {
      await this.accountsService.findOne(userId, createDto.transferAccountId);
      if (createDto.transferAccountId === createDto.accountId) {
        throw new BadRequestException('Source and destination accounts must be different');
      }
    }

    const { splits, isTransfer, transferAccountId, ...transactionData } = createDto;
    const hasSplits = splits && splits.length > 0;

    // Validate splits if provided (and not a simple transfer)
    if (hasSplits && !isTransfer) {
      this.validateSplits(splits, createDto.amount);
    }

    const scheduledTransaction = this.scheduledTransactionsRepository.create({
      ...transactionData,
      userId,
      startDate: transactionData.startDate || transactionData.nextDueDate,
      totalOccurrences: transactionData.occurrencesRemaining,
      categoryId: (hasSplits || isTransfer) ? null : transactionData.categoryId,
      isSplit: hasSplits && !isTransfer,
      isTransfer: isTransfer || false,
      transferAccountId: isTransfer ? transferAccountId : null,
    });

    const saved = await this.scheduledTransactionsRepository.save(scheduledTransaction);

    // Create splits if provided (and not a simple transfer)
    if (hasSplits && !isTransfer) {
      await this.createSplits(saved.id, splits);
    }

    return this.findOne(userId, saved.id);
  }

  private validateSplits(splits: CreateScheduledTransactionSplitDto[], transactionAmount: number): void {
    // Allow single split for transfers (has transferAccountId)
    const isTransfer = splits.length === 1 && splits[0].transferAccountId;

    if (splits.length < 2 && !isTransfer) {
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
        transferAccountId: split.transferAccountId || null,
        amount: split.amount,
        memo: split.memo || null,
      }),
    );

    return this.splitsRepository.save(splitEntities);
  }

  async findAll(userId: string): Promise<(ScheduledTransaction & { overrideCount?: number; nextOverride?: ScheduledTransactionOverride | null })[]> {
    const transactions = await this.scheduledTransactionsRepository
      .createQueryBuilder('st')
      .leftJoinAndSelect('st.account', 'account')
      .leftJoinAndSelect('st.payee', 'payee')
      .leftJoinAndSelect('st.category', 'category')
      .leftJoinAndSelect('st.transferAccount', 'transferAccount')
      .leftJoinAndSelect('st.splits', 'splits')
      .leftJoinAndSelect('splits.category', 'splitCategory')
      .leftJoinAndSelect('splits.transferAccount', 'splitTransferAccount')
      .loadRelationCountAndMap('st.overrideCount', 'st.overrides')
      .where('st.userId = :userId', { userId })
      .orderBy('st.nextDueDate', 'ASC')
      .getMany();

    // Fetch overrides for each transaction's next due date
    const transactionsWithOverrides = await Promise.all(
      transactions.map(async (transaction) => {
        const nextDueDateStr = transaction.nextDueDate instanceof Date
          ? transaction.nextDueDate.toISOString().split('T')[0]
          : String(transaction.nextDueDate).split('T')[0];

        const nextOverride = await this.overridesRepository.findOne({
          where: {
            scheduledTransactionId: transaction.id,
            overrideDate: nextDueDateStr,
          },
          relations: ['category'],
        });

        return {
          ...transaction,
          nextOverride: nextOverride || null,
        };
      }),
    );

    return transactionsWithOverrides;
  }

  async findOne(userId: string, id: string): Promise<ScheduledTransaction> {
    const scheduled = await this.scheduledTransactionsRepository.findOne({
      where: { id },
      relations: ['account', 'payee', 'category', 'transferAccount', 'splits', 'splits.category', 'splits.transferAccount'],
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
      relations: ['account', 'payee', 'category', 'transferAccount', 'splits', 'splits.category', 'splits.transferAccount'],
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
      .leftJoinAndSelect('st.transferAccount', 'transferAccount')
      .leftJoinAndSelect('st.splits', 'splits')
      .leftJoinAndSelect('splits.category', 'splitCategory')
      .leftJoinAndSelect('splits.transferAccount', 'splitTransferAccount')
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

    // Verify transfer account if this is being changed to a transfer
    if (updateDto.isTransfer && updateDto.transferAccountId) {
      await this.accountsService.findOne(userId, updateDto.transferAccountId);
      const accountId = updateDto.accountId || scheduled.accountId;
      if (updateDto.transferAccountId === accountId) {
        throw new BadRequestException('Source and destination accounts must be different');
      }
    }

    const { splits, isTransfer, transferAccountId, ...updateData } = updateDto;

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

    // Handle transfer fields
    if (isTransfer !== undefined) {
      fieldsToUpdate.isTransfer = isTransfer;
      if (isTransfer) {
        // When switching to transfer mode, clear splits and category
        fieldsToUpdate.isSplit = false;
        fieldsToUpdate.categoryId = null;
        await this.splitsRepository.delete({ scheduledTransactionId: id });
      }
    }
    if (transferAccountId !== undefined) {
      fieldsToUpdate.transferAccountId = transferAccountId || null;
    }

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

    // Convert nextDueDate to string format
    const nextDueDateStr = scheduled.nextDueDate instanceof Date
      ? scheduled.nextDueDate.toISOString().split('T')[0]
      : String(scheduled.nextDueDate).split('T')[0];

    // Delete any override for the skipped date
    await this.overridesRepository.delete({
      scheduledTransactionId: id,
      overrideDate: nextDueDateStr,
    });

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

  async post(userId: string, id: string, postDto?: PostScheduledTransactionDto): Promise<ScheduledTransaction> {
    const scheduled = await this.findOne(userId, id);

    // Convert nextDueDate to string format for transaction
    const nextDueDateStr = scheduled.nextDueDate instanceof Date
      ? scheduled.nextDueDate.toISOString().split('T')[0]
      : String(scheduled.nextDueDate).split('T')[0];

    const postDate = postDto?.transactionDate || nextDueDateStr;

    // Check for stored override for this specific date
    const storedOverride = await this.overridesRepository.findOne({
      where: {
        scheduledTransactionId: id,
        overrideDate: postDate,
      },
    });

    // Priority: inline values > stored override > base scheduled transaction
    // Determine final values to use
    const hasInlineAmount = postDto?.amount !== undefined && postDto?.amount !== null;
    const hasInlineCategoryId = postDto?.categoryId !== undefined;
    const hasInlineDescription = postDto?.description !== undefined;
    const hasInlineIsSplit = postDto?.isSplit !== undefined && postDto?.isSplit !== null;
    const hasInlineSplits = postDto?.splits && postDto.splits.length > 0;

    const finalAmount = hasInlineAmount
      ? Number(postDto.amount)
      : (storedOverride?.amount !== null && storedOverride?.amount !== undefined)
        ? Number(storedOverride.amount)
        : Number(scheduled.amount);

    const finalDescription = hasInlineDescription
      ? postDto.description
      : (storedOverride?.description !== null && storedOverride?.description !== undefined)
        ? storedOverride.description
        : (scheduled.description || undefined);

    // Build transaction payload
    const transactionPayload: any = {
      accountId: scheduled.accountId,
      transactionDate: postDate,
      payeeId: scheduled.payeeId || undefined,
      payeeName: scheduled.payeeName || undefined,
      amount: finalAmount,
      currencyCode: scheduled.currencyCode,
      description: finalDescription,
      isCleared: false,
    };

    // Determine if this should be a split transaction
    const useSplits = hasInlineIsSplit
      ? postDto.isSplit
      : (storedOverride?.isSplit !== null && storedOverride?.isSplit !== undefined)
        ? storedOverride.isSplit
        : scheduled.isSplit;

    if (useSplits) {
      // Use inline splits > stored override splits > base splits
      if (hasInlineSplits && postDto?.splits) {
        transactionPayload.splits = postDto.splits.map((split) => ({
          categoryId: split.categoryId || undefined,
          transferAccountId: split.transferAccountId || undefined,
          amount: Number(split.amount),
          memo: split.memo || undefined,
        }));
      } else if (storedOverride?.splits && storedOverride.splits.length > 0) {
        transactionPayload.splits = storedOverride.splits.map((split: any) => ({
          categoryId: split.categoryId || undefined,
          transferAccountId: split.transferAccountId || undefined,
          amount: Number(split.amount),
          memo: split.memo || undefined,
        }));
      } else if (scheduled.splits && scheduled.splits.length > 0) {
        transactionPayload.splits = scheduled.splits.map((split) => ({
          categoryId: split.categoryId || undefined,
          transferAccountId: split.transferAccountId || undefined,
          amount: Number(split.amount),
          memo: split.memo || undefined,
        }));
      }
    } else {
      // Use inline category > stored override category > base category
      const finalCategoryId = hasInlineCategoryId
        ? postDto.categoryId
        : (storedOverride?.categoryId !== null && storedOverride?.categoryId !== undefined)
          ? storedOverride.categoryId
          : (scheduled.categoryId || undefined);
      transactionPayload.categoryId = finalCategoryId || undefined;
    }

    // Create the actual transaction(s)
    if (scheduled.isTransfer && scheduled.transferAccountId) {
      // For direct transfers, use createTransfer to create linked transactions
      await this.transactionsService.createTransfer(userId, {
        fromAccountId: scheduled.accountId,
        toAccountId: scheduled.transferAccountId,
        amount: Math.abs(finalAmount), // createTransfer expects positive amount
        transactionDate: postDate,
        fromCurrencyCode: scheduled.currencyCode,
        description: finalDescription || undefined,
      });
    } else {
      // For regular transactions or split transactions
      await this.transactionsService.create(userId, transactionPayload);
    }

    // Delete the stored override if it was used (it's now been posted)
    if (storedOverride) {
      await this.overridesRepository.remove(storedOverride);
    }

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

    // If this was a loan payment, recalculate the splits for the next payment
    if (scheduled.splits && scheduled.splits.length > 0) {
      const loanAccountId = await this.findLoanAccountFromSplits(scheduled.splits);
      if (loanAccountId) {
        await this.recalculateLoanPaymentSplits(id, loanAccountId);
      }
    }

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

  // ==================== Override Methods ====================

  /**
   * Create an override for a specific occurrence of a scheduled transaction
   */
  async createOverride(
    userId: string,
    scheduledTransactionId: string,
    createDto: CreateScheduledTransactionOverrideDto,
  ): Promise<ScheduledTransactionOverride> {
    // Verify user has access to the scheduled transaction
    await this.findOne(userId, scheduledTransactionId);

    // Check if override already exists for this date
    const existing = await this.overridesRepository.findOne({
      where: {
        scheduledTransactionId,
        overrideDate: createDto.overrideDate,
      },
    });

    if (existing) {
      throw new BadRequestException(
        `An override already exists for ${createDto.overrideDate}. Use update instead.`,
      );
    }

    // Validate splits if provided
    if (createDto.isSplit && createDto.splits && createDto.splits.length > 0) {
      if (createDto.amount === undefined || createDto.amount === null) {
        throw new BadRequestException('Amount is required when creating split override');
      }
      this.validateOverrideSplits(createDto.splits, createDto.amount);
    }

    const override = this.overridesRepository.create({
      scheduledTransactionId,
      overrideDate: createDto.overrideDate,
      amount: createDto.amount ?? null,
      categoryId: createDto.categoryId ?? null,
      description: createDto.description ?? null,
      isSplit: createDto.isSplit ?? null,
      splits: createDto.splits?.map(s => ({
        categoryId: s.categoryId ?? null,
        amount: s.amount,
        memo: s.memo ?? null,
      })) ?? null,
    });

    return this.overridesRepository.save(override);
  }

  /**
   * Get all overrides for a scheduled transaction
   */
  async findOverrides(
    userId: string,
    scheduledTransactionId: string,
  ): Promise<ScheduledTransactionOverride[]> {
    // Verify user has access
    await this.findOne(userId, scheduledTransactionId);

    return this.overridesRepository.find({
      where: { scheduledTransactionId },
      relations: ['category'],
      order: { overrideDate: 'ASC' },
    });
  }

  /**
   * Get a specific override by ID
   */
  async findOverride(
    userId: string,
    scheduledTransactionId: string,
    overrideId: string,
  ): Promise<ScheduledTransactionOverride> {
    // Verify user has access
    await this.findOne(userId, scheduledTransactionId);

    const override = await this.overridesRepository.findOne({
      where: { id: overrideId, scheduledTransactionId },
      relations: ['category'],
    });

    if (!override) {
      throw new NotFoundException(`Override with ID ${overrideId} not found`);
    }

    return override;
  }

  /**
   * Get override for a specific date (if exists)
   */
  async findOverrideByDate(
    userId: string,
    scheduledTransactionId: string,
    date: string,
  ): Promise<ScheduledTransactionOverride | null> {
    // Verify user has access
    await this.findOne(userId, scheduledTransactionId);

    return this.overridesRepository.findOne({
      where: { scheduledTransactionId, overrideDate: date },
      relations: ['category'],
    });
  }

  /**
   * Update an override
   */
  async updateOverride(
    userId: string,
    scheduledTransactionId: string,
    overrideId: string,
    updateDto: UpdateScheduledTransactionOverrideDto,
  ): Promise<ScheduledTransactionOverride> {
    const override = await this.findOverride(userId, scheduledTransactionId, overrideId);

    // Validate splits if provided
    if (updateDto.isSplit && updateDto.splits && updateDto.splits.length > 0) {
      const amount = updateDto.amount ?? override.amount;
      if (amount === null) {
        throw new BadRequestException('Amount is required for split override');
      }
      this.validateOverrideSplits(updateDto.splits, amount);
    }

    // Update fields
    if (updateDto.amount !== undefined) override.amount = updateDto.amount;
    if (updateDto.categoryId !== undefined) override.categoryId = updateDto.categoryId ?? null;
    if (updateDto.description !== undefined) override.description = updateDto.description;
    if (updateDto.isSplit !== undefined) override.isSplit = updateDto.isSplit;
    if (updateDto.splits !== undefined) {
      override.splits = updateDto.splits?.map(s => ({
        categoryId: s.categoryId ?? null,
        amount: s.amount,
        memo: s.memo ?? null,
      })) ?? null;
    }

    return this.overridesRepository.save(override);
  }

  /**
   * Delete an override
   */
  async removeOverride(
    userId: string,
    scheduledTransactionId: string,
    overrideId: string,
  ): Promise<void> {
    const override = await this.findOverride(userId, scheduledTransactionId, overrideId);
    await this.overridesRepository.remove(override);
  }

  /**
   * Delete all overrides for a scheduled transaction
   */
  async removeAllOverrides(
    userId: string,
    scheduledTransactionId: string,
  ): Promise<number> {
    // Verify user has access
    await this.findOne(userId, scheduledTransactionId);

    const result = await this.overridesRepository.delete({ scheduledTransactionId });
    return result.affected || 0;
  }

  /**
   * Check if a scheduled transaction has any overrides
   */
  async hasOverrides(
    userId: string,
    scheduledTransactionId: string,
  ): Promise<{ hasOverrides: boolean; count: number }> {
    // Verify user has access
    await this.findOne(userId, scheduledTransactionId);

    const count = await this.overridesRepository.count({
      where: { scheduledTransactionId },
    });

    return { hasOverrides: count > 0, count };
  }

  /**
   * Validate override splits
   */
  private validateOverrideSplits(
    splits: { categoryId?: string | null; amount: number; memo?: string | null }[],
    transactionAmount: number,
  ): void {
    if (splits.length < 2) {
      throw new BadRequestException('Split overrides must have at least 2 splits');
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

  // ==================== Loan Payment Recalculation ====================

  /**
   * Recalculate the principal/interest split for a loan payment scheduled transaction
   * based on the current loan balance. Called after posting a loan payment.
   *
   * @param scheduledTransactionId - The scheduled transaction ID
   * @param loanAccountId - The loan account ID
   */
  async recalculateLoanPaymentSplits(
    scheduledTransactionId: string,
    loanAccountId: string,
  ): Promise<void> {
    // Get the loan account to check current balance and interest rate
    const loanAccount = await this.accountsRepository.findOne({
      where: { id: loanAccountId },
    });

    if (!loanAccount) {
      return; // Loan account not found, nothing to do
    }

    // Get the scheduled transaction
    const scheduledTransaction = await this.scheduledTransactionsRepository.findOne({
      where: { id: scheduledTransactionId },
      relations: ['splits'],
    });

    if (!scheduledTransaction || !scheduledTransaction.isActive) {
      return; // Scheduled transaction not found or inactive
    }

    // Get current loan balance (stored as negative for liability)
    const currentBalance = Math.abs(Number(loanAccount.currentBalance));

    // If loan is paid off (balance is 0 or positive), deactivate the scheduled transaction
    if (currentBalance <= 0.01) {
      await this.scheduledTransactionsRepository.update(scheduledTransactionId, {
        isActive: false,
      });
      return;
    }

    // Calculate new payment split based on remaining balance
    const paymentAmount = Math.abs(Number(scheduledTransaction.amount));
    const interestRate = Number(loanAccount.interestRate) || 0;
    const frequency = (loanAccount.paymentFrequency || scheduledTransaction.frequency) as PaymentFrequency;

    const newSplit = calculatePaymentSplit(
      currentBalance,
      interestRate,
      paymentAmount,
      frequency,
    );

    // Find the principal and interest splits
    const splits = scheduledTransaction.splits || [];
    const principalSplit = splits.find((s) => s.transferAccountId === loanAccountId);
    const interestSplit = splits.find((s) => s.categoryId && !s.transferAccountId);

    // Update the splits with new amounts
    if (principalSplit) {
      // Principal amount is negative (part of outflow)
      principalSplit.amount = -newSplit.principal;
      await this.splitsRepository.save(principalSplit);
    }

    if (interestSplit) {
      // Interest amount is negative (part of outflow)
      interestSplit.amount = -newSplit.interest;
      await this.splitsRepository.save(interestSplit);
    }
  }

  /**
   * Check if a scheduled transaction is a loan payment
   * (has a split with transferAccountId pointing to a loan account)
   */
  private async findLoanAccountFromSplits(
    splits: ScheduledTransactionSplit[],
  ): Promise<string | null> {
    for (const split of splits) {
      if (split.transferAccountId) {
        const account = await this.accountsRepository.findOne({
          where: { id: split.transferAccountId },
        });
        if (account && account.accountType === 'LOAN') {
          return account.id;
        }
      }
    }
    return null;
  }
}
