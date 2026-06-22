import {
  BadRequestException,
  ForbiddenException,
  forwardRef,
  Inject,
  Injectable,
} from "@nestjs/common";
import { plainToInstance } from "class-transformer";
import { validateOrReject } from "class-validator";
import { TransactionsService } from "../../transactions/transactions.service";
import { PayeesService } from "../../payees/payees.service";
import { InvestmentTransactionsService } from "../../securities/investment-transactions.service";
import { SecuritiesService } from "../../securities/securities.service";
import { CreateTransactionDto } from "../../transactions/dto/create-transaction.dto";
import { UpdateTransactionDto } from "../../transactions/dto/update-transaction.dto";
import { CreatePayeeDto } from "../../payees/dto/create-payee.dto";
import { UpdatePayeeDto } from "../../payees/dto/update-payee.dto";
import { CreateInvestmentTransactionDto } from "../../securities/dto/create-investment-transaction.dto";
import { UpdateInvestmentTransactionDto } from "../../securities/dto/update-investment-transaction.dto";
import { CreateSecurityDto } from "../../securities/dto/create-security.dto";
import { UpdateSecurityDto } from "../../securities/dto/update-security.dto";
import { tr } from "../../i18n/translate";
import { AiActionSigningService } from "./ai-action-signing.service";
import { AiWriteLimiter } from "./ai-write-limiter";
import {
  AI_ACTION_TYPES,
  AiActionDescriptor,
  CategorizeTransactionDescriptor,
  CreatePayeeDescriptor,
  UpdatePayeeDescriptor,
  DeletePayeeDescriptor,
  CreateSecurityDescriptor,
  UpdateSecurityDescriptor,
  DeleteSecurityDescriptor,
  CreateTransactionDescriptor,
  CreateInvestmentTransactionDescriptor,
  CreateTransactionsDescriptor,
  CreateInvestmentTransactionsDescriptor,
  UpdateTransactionDescriptor,
  DeleteTransactionDescriptor,
  UpdateInvestmentTransactionDescriptor,
  DeleteInvestmentTransactionDescriptor,
  CreateTransferDescriptor,
  UpdateTransferDescriptor,
  BatchActionsDescriptor,
  BatchUpdateTransactionRow,
  BatchDeleteTransactionRow,
  BatchCreateTransferRow,
  BatchUpdateInvestmentTransactionRow,
  BatchDeleteInvestmentTransactionRow,
  BatchCreatePayeeRow,
  BatchUpdatePayeeRow,
  BatchDeletePayeeRow,
  BatchCreateSecurityRow,
  BatchUpdateSecurityRow,
  BatchDeleteSecurityRow,
  TransactionRowDescriptor,
  MAX_BULK_ACTION_ROWS,
} from "./ai-action.types";
import { CreateTransferDto } from "../../transactions/dto/create-transfer.dto";
import { UpdateTransferDto } from "../../transactions/dto/update-transfer.dto";
import { BulkCreateSkip } from "../../common/bulk-create.types";
import { ConfirmAiActionDto } from "./dto/confirm-ai-action.dto";

export interface ConfirmActionResult {
  type: AiActionDescriptor["type"];
  /** First created id; empty when a bulk batch created nothing. */
  id: string;
  /** Ids of every created entity (bulk actions); omitted for singular actions. */
  ids?: string[];
  /** Number of entities actually created (bulk actions). */
  count?: number;
  /** Rows that were skipped best-effort (bulk actions), by input index. */
  skipped?: BulkCreateSkip[];
}

@Injectable()
export class AiActionsService {
  // Anti-replay: action ids that have been confirmed, with their expiry so the
  // set self-prunes. A confirmed descriptor cannot be submitted twice.
  private readonly consumed = new Map<string, number>();

  constructor(
    @Inject(forwardRef(() => TransactionsService))
    private readonly transactionsService: TransactionsService,
    @Inject(forwardRef(() => PayeesService))
    private readonly payeesService: PayeesService,
    private readonly investmentTransactionsService: InvestmentTransactionsService,
    private readonly securitiesService: SecuritiesService,
    private readonly signingService: AiActionSigningService,
    private readonly writeLimiter: AiWriteLimiter,
  ) {}

  async confirm(
    userId: string,
    dto: ConfirmAiActionDto,
  ): Promise<ConfirmActionResult> {
    const descriptor = dto.descriptor as Partial<AiActionDescriptor>;

    // Shape + binding checks before trusting anything in the descriptor.
    if (
      !descriptor ||
      typeof descriptor !== "object" ||
      typeof descriptor.type !== "string" ||
      !AI_ACTION_TYPES.includes(descriptor.type) ||
      descriptor.actionId !== dto.actionId ||
      typeof descriptor.expiresAt !== "number" ||
      typeof descriptor.userId !== "string"
    ) {
      throw new BadRequestException(this.invalidSignatureMessage());
    }

    if (
      !this.signingService.verify(
        descriptor as AiActionDescriptor,
        dto.signature,
      )
    ) {
      throw new BadRequestException(this.invalidSignatureMessage());
    }

    if (descriptor.expiresAt < Date.now()) {
      throw new BadRequestException(
        tr(
          "errors.ai.actionExpired",
          "This confirmation has expired. Please ask again.",
        ),
      );
    }

    // The signature already binds userId, but check explicitly so a descriptor
    // minted for another user is rejected with no ambiguity.
    if (descriptor.userId !== userId) {
      throw new ForbiddenException(this.invalidSignatureMessage());
    }

    this.pruneConsumed();
    if (this.consumed.has(descriptor.actionId)) {
      throw new BadRequestException(
        tr(
          "errors.ai.actionConfirmFailed",
          "This action could not be confirmed.",
        ),
      );
    }

    // A bulk action counts as one write per row it would create, so a large
    // batch cannot slip past the daily cap. The pre-check uses the proposed row
    // count; the actual recorded writes (below) reflect only rows created.
    const writeCount = this.proposedWriteCount(
      descriptor as AiActionDescriptor,
    );
    const limit = this.writeLimiter.checkLimit(userId);
    if (limit.currentCount + writeCount > limit.limit) {
      throw new BadRequestException(
        tr(
          "errors.ai.actionWriteLimit",
          "Daily AI write limit reached. Please try again tomorrow.",
          { limit: limit.limit },
        ),
      );
    }

    // Reserve the action id before executing so concurrent double-submits can't
    // both pass; release it if the write fails so the user can retry.
    this.consumed.set(descriptor.actionId, descriptor.expiresAt);
    try {
      const result = await this.execute(
        userId,
        descriptor as AiActionDescriptor,
      );
      // Record one write per entity actually created (bulk actions create
      // best-effort, so this may be fewer than the proposed count).
      const recorded = result.count ?? 1;
      for (let i = 0; i < recorded; i++) {
        this.writeLimiter.record(userId, descriptor.type);
      }
      return result;
    } catch (err) {
      this.consumed.delete(descriptor.actionId);
      throw err;
    }
  }

  /**
   * How many writes a descriptor proposes: the row count for bulk actions, one
   * for singular actions. Used to pre-check the daily write cap.
   */
  private proposedWriteCount(descriptor: AiActionDescriptor): number {
    if (
      descriptor.type === "create_transactions" ||
      descriptor.type === "create_investment_transactions" ||
      descriptor.type === "batch_actions"
    ) {
      return descriptor.rows.length;
    }
    return 1;
  }

  private async execute(
    userId: string,
    descriptor: AiActionDescriptor,
  ): Promise<ConfirmActionResult> {
    switch (descriptor.type) {
      case "create_transaction":
        return this.executeCreateTransaction(userId, descriptor);
      case "categorize_transaction":
        return this.executeCategorize(userId, descriptor);
      case "create_payee":
        return this.executeCreatePayee(userId, descriptor);
      case "update_payee":
        return this.executeUpdatePayee(userId, descriptor);
      case "delete_payee":
        return this.executeDeletePayee(userId, descriptor);
      case "create_security":
        return this.executeCreateSecurity(userId, descriptor);
      case "update_security":
        return this.executeUpdateSecurity(userId, descriptor);
      case "delete_security":
        return this.executeDeleteSecurity(userId, descriptor);
      case "create_investment_transaction":
        return this.executeCreateInvestmentTransaction(userId, descriptor);
      case "create_transactions":
        return this.executeCreateTransactions(userId, descriptor);
      case "create_investment_transactions":
        return this.executeCreateInvestmentTransactions(userId, descriptor);
      case "update_transaction":
        return this.executeUpdateTransaction(userId, descriptor);
      case "delete_transaction":
        return this.executeDeleteTransaction(userId, descriptor);
      case "update_investment_transaction":
        return this.executeUpdateInvestmentTransaction(userId, descriptor);
      case "delete_investment_transaction":
        return this.executeDeleteInvestmentTransaction(userId, descriptor);
      case "create_transfer":
        return this.executeCreateTransfer(userId, descriptor);
      case "update_transfer":
        return this.executeUpdateTransfer(userId, descriptor);
      case "batch_actions":
        return this.executeBatchActions(userId, descriptor);
    }
  }

  private async executeCreateTransfer(
    userId: string,
    descriptor: CreateTransferDescriptor,
  ): Promise<ConfirmActionResult> {
    const payeeId = await this.resolveTransferPayeeId(userId, descriptor);
    const dto = await this.toValidatedDto(CreateTransferDto, {
      fromAccountId: descriptor.fromAccountId,
      toAccountId: descriptor.toAccountId,
      transactionDate: descriptor.transactionDate,
      amount: descriptor.amount,
      fromCurrencyCode: descriptor.fromCurrencyCode,
      toCurrencyCode: descriptor.toCurrencyCode,
      exchangeRate: descriptor.exchangeRate,
      toAmount: descriptor.toAmount,
      description: descriptor.description ?? undefined,
      payeeId,
      payeeName: descriptor.payeeName ?? undefined,
      categoryId: descriptor.categoryId,
    });
    const result = await this.transactionsService.createTransfer(userId, dto);
    return { type: "create_transfer", id: result.fromTransaction.id };
  }

  private async executeUpdateTransfer(
    userId: string,
    descriptor: UpdateTransferDescriptor,
  ): Promise<ConfirmActionResult> {
    const payeeId = await this.resolveTransferPayeeId(userId, descriptor);
    const dto = await this.toValidatedDto(UpdateTransferDto, {
      amount: descriptor.amount,
      transactionDate: descriptor.transactionDate,
      exchangeRate: descriptor.exchangeRate,
      toAmount: descriptor.toAmount,
      description: descriptor.description ?? undefined,
      payeeId,
      payeeName: descriptor.payeeName ?? undefined,
      categoryId: descriptor.categoryId,
    });
    const result = await this.transactionsService.updateTransfer(
      userId,
      descriptor.transactionId,
      dto,
    );
    return { type: "update_transfer", id: result.fromTransaction.id };
  }

  /**
   * Resolve the final payee id for a transfer descriptor/row, mirroring the
   * normal cash-transaction flow: use the matched id, otherwise find-or-create
   * from the custom label when the descriptor opted in. Returns undefined when
   * no payee should be linked (free text or no label).
   */
  private async resolveTransferPayeeId(
    userId: string,
    descriptor: {
      payeeId: string | null;
      createPayee: boolean;
      payeeName: string | null;
    },
  ): Promise<string | undefined> {
    let payeeId = descriptor.payeeId ?? undefined;
    if (!payeeId && descriptor.createPayee && descriptor.payeeName) {
      payeeId = (
        await this.payeesService.findOrCreate(userId, descriptor.payeeName)
      ).id;
    }
    return payeeId;
  }

  /**
   * Execute a generic bulk envelope best-effort: each row is attempted in
   * isolation (a failing row is skipped by index, not aborting the batch),
   * reusing the SAME domain calls the single executors use.
   */
  private async executeBatchActions(
    userId: string,
    descriptor: BatchActionsDescriptor,
  ): Promise<ConfirmActionResult> {
    this.assertBulkRowCount(descriptor.rows.length);

    const ids: string[] = [];
    const skipped: BulkCreateSkip[] = [];

    // Bound the iteration count by the batch cap (a constant) so the loop can
    // never run unbounded on a tampered descriptor, even though the descriptor
    // is signature-verified and assertBulkRowCount already rejects oversize
    // input. Defense-in-depth; also clears CodeQL's loop-bound-injection flag.
    const rowCount = Math.min(descriptor.rows.length, MAX_BULK_ACTION_ROWS);
    for (let i = 0; i < rowCount; i++) {
      try {
        const id = await this.executeBatchRow(
          userId,
          descriptor.operation,
          descriptor.rows[i],
        );
        ids.push(id);
      } catch {
        skipped.push({ index: i, reason: this.bulkRowInvalidReason() });
      }
    }

    return this.toBulkResult("batch_actions", ids, skipped);
  }

  private async executeBatchRow(
    userId: string,
    operation: BatchActionsDescriptor["operation"],
    row: BatchActionsDescriptor["rows"][number],
  ): Promise<string> {
    switch (operation) {
      case "update": {
        const r = row as BatchUpdateTransactionRow;
        const dto = await this.toValidatedDto(UpdateTransactionDto, {
          accountId: r.accountId,
          transactionDate: r.transactionDate,
          amount: r.amount,
          currencyCode: r.currencyCode,
          payeeId: r.payeeId ?? undefined,
          payeeName: r.payeeName ?? undefined,
          categoryId: r.categoryId ?? undefined,
          description: r.description ?? undefined,
        });
        const transaction = await this.transactionsService.update(
          userId,
          r.transactionId,
          dto,
          { createPayeeIfMissing: r.createPayee === true },
        );
        return transaction.id;
      }
      case "delete": {
        const r = row as BatchDeleteTransactionRow;
        await this.transactionsService.removeAny(userId, r.transactionId);
        return r.transactionId;
      }
      case "create_transfer": {
        const r = row as BatchCreateTransferRow;
        const payeeId = await this.resolveTransferPayeeId(userId, r);
        const dto = await this.toValidatedDto(CreateTransferDto, {
          fromAccountId: r.fromAccountId,
          toAccountId: r.toAccountId,
          transactionDate: r.transactionDate,
          amount: r.amount,
          fromCurrencyCode: r.fromCurrencyCode,
          toCurrencyCode: r.toCurrencyCode,
          exchangeRate: r.exchangeRate,
          toAmount: r.toAmount,
          description: r.description ?? undefined,
          payeeId,
          payeeName: r.payeeName ?? undefined,
          categoryId: r.categoryId,
        });
        const result = await this.transactionsService.createTransfer(
          userId,
          dto,
        );
        return result.fromTransaction.id;
      }
      case "create": {
        const r = row as TransactionRowDescriptor;
        const dto = await this.toValidatedDto(CreateTransactionDto, {
          accountId: r.accountId,
          transactionDate: r.transactionDate,
          amount: r.amount,
          currencyCode: r.currencyCode,
          payeeId: r.payeeId ?? undefined,
          payeeName: r.payeeName ?? undefined,
          categoryId: r.categoryId ?? undefined,
          description: r.description ?? undefined,
        });
        const transaction = await this.transactionsService.create(userId, dto, {
          createPayeeIfMissing: r.createPayee === true,
        });
        return transaction.id;
      }
      case "update_investment": {
        const r = row as BatchUpdateInvestmentTransactionRow;
        // accountId is omitted: the edit keeps the transaction on its account
        // (matching the singular executor), so update() never takes the move
        // path.
        const dto = await this.toValidatedDto(UpdateInvestmentTransactionDto, {
          action: r.action,
          transactionDate: r.transactionDate,
          securityId: r.securityId ?? undefined,
          fundingAccountId: r.fundingAccountId ?? undefined,
          quantity: r.quantity ?? undefined,
          price: r.price ?? undefined,
          commission: r.commission,
          exchangeRate: r.exchangeRate,
          description: r.description ?? undefined,
        });
        const transaction = await this.investmentTransactionsService.update(
          userId,
          r.transactionId,
          dto,
        );
        return transaction.id;
      }
      case "delete_investment": {
        const r = row as BatchDeleteInvestmentTransactionRow;
        await this.investmentTransactionsService.remove(
          userId,
          r.transactionId,
        );
        return r.transactionId;
      }
      case "create_payee": {
        const r = row as BatchCreatePayeeRow;
        const dto = await this.toValidatedDto(CreatePayeeDto, {
          name: r.name,
          defaultCategoryId: r.defaultCategoryId ?? undefined,
        });
        const payee = await this.payeesService.create(userId, dto);
        return payee.id;
      }
      case "update_payee": {
        const r = row as BatchUpdatePayeeRow;
        const dto = await this.toValidatedDto(UpdatePayeeDto, {
          name: r.name,
          defaultCategoryId: r.defaultCategoryId,
        });
        const payee = await this.payeesService.update(userId, r.payeeId, dto);
        return payee.id;
      }
      case "delete_payee": {
        const r = row as BatchDeletePayeeRow;
        await this.payeesService.remove(userId, r.payeeId);
        return r.payeeId;
      }
      case "create_security": {
        const r = row as BatchCreateSecurityRow;
        const dto = await this.toValidatedDto(CreateSecurityDto, {
          symbol: r.symbol,
          name: r.name,
          securityType: r.securityType ?? undefined,
          exchange: r.exchange ?? undefined,
          currencyCode: r.currencyCode,
          isFavourite: r.isFavourite,
          quoteProvider: r.quoteProvider ?? undefined,
          msnInstrumentId: r.msnInstrumentId ?? undefined,
        });
        const security = await this.securitiesService.create(userId, dto);
        return security.id;
      }
      case "update_security": {
        const r = row as BatchUpdateSecurityRow;
        const dto = await this.toValidatedDto(UpdateSecurityDto, {
          securityType: r.securityType ?? undefined,
          exchange: r.exchange ?? undefined,
          currencyCode: r.currencyCode,
          isFavourite: r.isFavourite,
          ...(r.countryWeightings !== undefined
            ? { countryWeightings: r.countryWeightings ?? [] }
            : {}),
        });
        const security = await this.securitiesService.update(
          userId,
          r.securityId,
          dto,
        );
        return security.id;
      }
      case "delete_security": {
        const r = row as BatchDeleteSecurityRow;
        await this.securitiesService.remove(userId, r.securityId);
        return r.securityId;
      }
    }
  }

  private async executeUpdateTransaction(
    userId: string,
    descriptor: UpdateTransactionDescriptor,
  ): Promise<ConfirmActionResult> {
    const dto = await this.toValidatedDto(UpdateTransactionDto, {
      accountId: descriptor.accountId,
      transactionDate: descriptor.transactionDate,
      amount: descriptor.amount,
      currencyCode: descriptor.currencyCode,
      payeeId: descriptor.payeeId ?? undefined,
      payeeName: descriptor.payeeName ?? undefined,
      // When replacing the split set the parent keeps no single category.
      categoryId: descriptor.splits
        ? undefined
        : (descriptor.categoryId ?? undefined),
      description: descriptor.description ?? undefined,
    });
    const transaction = await this.transactionsService.update(
      userId,
      descriptor.transactionId,
      dto,
      { createPayeeIfMissing: descriptor.createPayee === true },
    );
    // Replace the split set after the scalar fields are applied (each call is
    // internally transactional). updateSplits re-validates the sum/sign rules.
    if (descriptor.splits) {
      await this.transactionsService.updateSplits(
        userId,
        descriptor.transactionId,
        descriptor.splits.map((s) => ({
          categoryId: s.categoryId,
          amount: s.amount,
          memo: s.memo ?? undefined,
        })),
      );
    }
    return { type: "update_transaction", id: transaction.id };
  }

  private async executeDeleteTransaction(
    userId: string,
    descriptor: DeleteTransactionDescriptor,
  ): Promise<ConfirmActionResult> {
    await this.transactionsService.removeAny(userId, descriptor.transactionId);
    return { type: "delete_transaction", id: descriptor.transactionId };
  }

  private async executeUpdateInvestmentTransaction(
    userId: string,
    descriptor: UpdateInvestmentTransactionDescriptor,
  ): Promise<ConfirmActionResult> {
    // accountId is omitted: the edit keeps the transaction on its account, and
    // passing it could trigger the account-move path in update().
    const dto = await this.toValidatedDto(UpdateInvestmentTransactionDto, {
      action: descriptor.action,
      transactionDate: descriptor.transactionDate,
      securityId: descriptor.securityId ?? undefined,
      fundingAccountId: descriptor.fundingAccountId ?? undefined,
      quantity: descriptor.quantity ?? undefined,
      price: descriptor.price ?? undefined,
      commission: descriptor.commission,
      exchangeRate: descriptor.exchangeRate,
      description: descriptor.description ?? undefined,
    });
    const transaction = await this.investmentTransactionsService.update(
      userId,
      descriptor.transactionId,
      dto,
    );
    return { type: "update_investment_transaction", id: transaction.id };
  }

  private async executeDeleteInvestmentTransaction(
    userId: string,
    descriptor: DeleteInvestmentTransactionDescriptor,
  ): Promise<ConfirmActionResult> {
    await this.investmentTransactionsService.remove(
      userId,
      descriptor.transactionId,
    );
    return {
      type: "delete_investment_transaction",
      id: descriptor.transactionId,
    };
  }

  private async executeCreateTransaction(
    userId: string,
    descriptor: CreateTransactionDescriptor,
  ): Promise<ConfirmActionResult> {
    const dto = await this.toValidatedDto(CreateTransactionDto, {
      accountId: descriptor.accountId,
      transactionDate: descriptor.transactionDate,
      amount: descriptor.amount,
      currencyCode: descriptor.currencyCode,
      payeeId: descriptor.payeeId ?? undefined,
      payeeName: descriptor.payeeName ?? undefined,
      // A split transaction carries its categories in `splits`; the parent has
      // no single category.
      categoryId: descriptor.splits
        ? undefined
        : (descriptor.categoryId ?? undefined),
      description: descriptor.description ?? undefined,
      splits: descriptor.splits
        ? descriptor.splits.map((s) => ({
            categoryId: s.categoryId,
            amount: s.amount,
            memo: s.memo ?? undefined,
          }))
        : undefined,
    });
    const transaction = await this.transactionsService.create(userId, dto, {
      createPayeeIfMissing: descriptor.createPayee === true,
    });
    return { type: "create_transaction", id: transaction.id };
  }

  private async executeCategorize(
    userId: string,
    descriptor: CategorizeTransactionDescriptor,
  ): Promise<ConfirmActionResult> {
    const dto = await this.toValidatedDto(UpdateTransactionDto, {
      categoryId: descriptor.categoryId,
    });
    const transaction = await this.transactionsService.update(
      userId,
      descriptor.transactionId,
      dto,
    );
    return { type: "categorize_transaction", id: transaction.id };
  }

  private async executeCreatePayee(
    userId: string,
    descriptor: CreatePayeeDescriptor,
  ): Promise<ConfirmActionResult> {
    const dto = await this.toValidatedDto(CreatePayeeDto, {
      name: descriptor.name,
      defaultCategoryId: descriptor.defaultCategoryId ?? undefined,
    });
    const payee = await this.payeesService.create(userId, dto);
    return { type: "create_payee", id: payee.id };
  }

  private async executeUpdatePayee(
    userId: string,
    descriptor: UpdatePayeeDescriptor,
  ): Promise<ConfirmActionResult> {
    const dto = await this.toValidatedDto(UpdatePayeeDto, {
      name: descriptor.name,
      defaultCategoryId: descriptor.defaultCategoryId,
    });
    const payee = await this.payeesService.update(
      userId,
      descriptor.payeeId,
      dto,
    );
    return { type: "update_payee", id: payee.id };
  }

  private async executeDeletePayee(
    userId: string,
    descriptor: DeletePayeeDescriptor,
  ): Promise<ConfirmActionResult> {
    await this.payeesService.remove(userId, descriptor.payeeId);
    return { type: "delete_payee", id: descriptor.payeeId };
  }

  private async executeCreateSecurity(
    userId: string,
    descriptor: CreateSecurityDescriptor,
  ): Promise<ConfirmActionResult> {
    const dto = await this.toValidatedDto(CreateSecurityDto, {
      symbol: descriptor.symbol,
      name: descriptor.name,
      securityType: descriptor.securityType ?? undefined,
      exchange: descriptor.exchange ?? undefined,
      currencyCode: descriptor.currencyCode,
      isFavourite: descriptor.isFavourite,
      quoteProvider: descriptor.quoteProvider ?? undefined,
      msnInstrumentId: descriptor.msnInstrumentId ?? undefined,
    });
    const security = await this.securitiesService.create(userId, dto);
    return { type: "create_security", id: security.id };
  }

  private async executeUpdateSecurity(
    userId: string,
    descriptor: UpdateSecurityDescriptor,
  ): Promise<ConfirmActionResult> {
    const dto = await this.toValidatedDto(UpdateSecurityDto, {
      securityType: descriptor.securityType ?? undefined,
      exchange: descriptor.exchange ?? undefined,
      currencyCode: descriptor.currencyCode,
      isFavourite: descriptor.isFavourite,
      countryWeightings: descriptor.countryWeightings ?? [],
    });
    const security = await this.securitiesService.update(
      userId,
      descriptor.securityId,
      dto,
    );
    return { type: "update_security", id: security.id };
  }

  private async executeDeleteSecurity(
    userId: string,
    descriptor: DeleteSecurityDescriptor,
  ): Promise<ConfirmActionResult> {
    await this.securitiesService.remove(userId, descriptor.securityId);
    return { type: "delete_security", id: descriptor.securityId };
  }

  private async executeCreateInvestmentTransaction(
    userId: string,
    descriptor: CreateInvestmentTransactionDescriptor,
  ): Promise<ConfirmActionResult> {
    const dto = await this.toValidatedDto(CreateInvestmentTransactionDto, {
      accountId: descriptor.accountId,
      action: descriptor.action,
      transactionDate: descriptor.transactionDate,
      securityId: descriptor.securityId ?? undefined,
      fundingAccountId: descriptor.fundingAccountId ?? undefined,
      quantity: descriptor.quantity ?? undefined,
      price: descriptor.price ?? undefined,
      commission: descriptor.commission,
      exchangeRate: descriptor.exchangeRate,
      description: descriptor.description ?? undefined,
    });
    const transaction = await this.investmentTransactionsService.create(
      userId,
      dto,
    );
    return { type: "create_investment_transaction", id: transaction.id };
  }

  private async executeCreateTransactions(
    userId: string,
    descriptor: CreateTransactionsDescriptor,
  ): Promise<ConfirmActionResult> {
    this.assertBulkRowCount(descriptor.rows.length);

    // Re-validate every row best-effort; a row that fails re-validation is
    // skipped (recorded by its original index) rather than failing the batch.
    const toCreate: Array<{
      dto: CreateTransactionDto;
      createPayeeIfMissing: boolean;
    }> = [];
    const originalIndex: number[] = [];
    const skipped: BulkCreateSkip[] = [];
    const rowCount = Math.min(descriptor.rows.length, MAX_BULK_ACTION_ROWS);
    for (let i = 0; i < rowCount; i++) {
      const row = descriptor.rows[i];
      const validated = await this.tryValidatedDto(CreateTransactionDto, {
        accountId: row.accountId,
        transactionDate: row.transactionDate,
        amount: row.amount,
        currencyCode: row.currencyCode,
        payeeId: row.payeeId ?? undefined,
        payeeName: row.payeeName ?? undefined,
        categoryId: row.categoryId ?? undefined,
        description: row.description ?? undefined,
      });
      if (validated) {
        toCreate.push({
          dto: validated,
          createPayeeIfMissing: row.createPayee,
        });
        originalIndex.push(i);
      } else {
        skipped.push({ index: i, reason: this.bulkRowInvalidReason() });
      }
    }

    const result = await this.transactionsService.createBulk(userId, toCreate);
    for (const s of result.skipped) {
      skipped.push({ index: originalIndex[s.index], reason: s.reason });
    }

    return this.toBulkResult(
      "create_transactions",
      result.created.map((t) => t.id),
      skipped,
    );
  }

  private async executeCreateInvestmentTransactions(
    userId: string,
    descriptor: CreateInvestmentTransactionsDescriptor,
  ): Promise<ConfirmActionResult> {
    this.assertBulkRowCount(descriptor.rows.length);

    const toCreate: CreateInvestmentTransactionDto[] = [];
    const originalIndex: number[] = [];
    const skipped: BulkCreateSkip[] = [];
    const rowCount = Math.min(descriptor.rows.length, MAX_BULK_ACTION_ROWS);
    for (let i = 0; i < rowCount; i++) {
      const row = descriptor.rows[i];
      const validated = await this.tryValidatedDto(
        CreateInvestmentTransactionDto,
        {
          accountId: row.accountId,
          action: row.action,
          transactionDate: row.transactionDate,
          securityId: row.securityId ?? undefined,
          fundingAccountId: row.fundingAccountId ?? undefined,
          quantity: row.quantity ?? undefined,
          price: row.price ?? undefined,
          commission: row.commission,
          exchangeRate: row.exchangeRate,
          description: row.description ?? undefined,
        },
      );
      if (validated) {
        toCreate.push(validated);
        originalIndex.push(i);
      } else {
        skipped.push({ index: i, reason: this.bulkRowInvalidReason() });
      }
    }

    const result = await this.investmentTransactionsService.createBulk(
      userId,
      toCreate,
    );
    for (const s of result.skipped) {
      skipped.push({ index: originalIndex[s.index], reason: s.reason });
    }

    return this.toBulkResult(
      "create_investment_transactions",
      result.created.map((t) => t.id),
      skipped,
    );
  }

  /**
   * Defensive guard: the bulk row count is bounded at the tool schema and the
   * builder, so a descriptor outside the range means tampering or a stale
   * client -- reject it the same way an invalid signature is rejected.
   */
  private assertBulkRowCount(count: number): void {
    if (count < 1 || count > MAX_BULK_ACTION_ROWS) {
      throw new BadRequestException(this.invalidSignatureMessage());
    }
  }

  private toBulkResult(
    type: AiActionDescriptor["type"],
    ids: string[],
    skipped: BulkCreateSkip[],
  ): ConfirmActionResult {
    return { type, id: ids[0] ?? "", ids, count: ids.length, skipped };
  }

  private bulkRowInvalidReason(): string {
    return tr(
      "errors.ai.actionConfirmFailed",
      "This action could not be confirmed.",
    );
  }

  /**
   * Best-effort variant of {@link toValidatedDto}: returns the validated DTO or
   * undefined when validation fails, so a single bad row in a bulk batch can be
   * skipped instead of aborting the whole confirmation.
   */
  private async tryValidatedDto<T extends object>(
    cls: new () => T,
    plain: Record<string, unknown>,
  ): Promise<T | undefined> {
    try {
      return await this.toValidatedDto(cls, plain);
    } catch {
      return undefined;
    }
  }

  /**
   * Build a DTO instance and re-run class-validator over it so the same
   * constraints the REST endpoints enforce (@SanitizeHtml, @IsCurrencyCode,
   * @IsUUID, bounds) apply to the descriptor before the write.
   */
  private async toValidatedDto<T extends object>(
    cls: new () => T,
    plain: Record<string, unknown>,
  ): Promise<T> {
    const instance = plainToInstance(cls, plain);
    try {
      await validateOrReject(instance as object, {
        whitelist: true,
        forbidNonWhitelisted: true,
      });
    } catch {
      throw new BadRequestException(
        tr(
          "errors.ai.actionConfirmFailed",
          "This action could not be confirmed.",
        ),
      );
    }
    return instance;
  }

  private invalidSignatureMessage(): string {
    return tr(
      "errors.ai.actionSignatureInvalid",
      "This action could not be verified.",
    );
  }

  private pruneConsumed(): void {
    const now = Date.now();
    for (const [id, expiresAt] of this.consumed) {
      if (expiresAt < now) {
        this.consumed.delete(id);
      }
    }
  }
}
