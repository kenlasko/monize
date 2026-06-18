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
import { CreateTransactionDto } from "../../transactions/dto/create-transaction.dto";
import { UpdateTransactionDto } from "../../transactions/dto/update-transaction.dto";
import { CreatePayeeDto } from "../../payees/dto/create-payee.dto";
import { CreateInvestmentTransactionDto } from "../../securities/dto/create-investment-transaction.dto";
import { tr } from "../../i18n/translate";
import { AiActionSigningService } from "./ai-action-signing.service";
import { AiWriteLimiter } from "./ai-write-limiter";
import {
  AI_ACTION_TYPES,
  AiActionDescriptor,
  CategorizeTransactionDescriptor,
  CreatePayeeDescriptor,
  CreateTransactionDescriptor,
  CreateInvestmentTransactionDescriptor,
} from "./ai-action.types";
import { ConfirmAiActionDto } from "./dto/confirm-ai-action.dto";

export interface ConfirmActionResult {
  type: AiActionDescriptor["type"];
  id: string;
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

    const limit = this.writeLimiter.checkLimit(userId);
    if (!limit.allowed) {
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
      this.writeLimiter.record(userId, descriptor.type);
      return result;
    } catch (err) {
      this.consumed.delete(descriptor.actionId);
      throw err;
    }
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
      case "create_investment_transaction":
        return this.executeCreateInvestmentTransaction(userId, descriptor);
    }
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
      categoryId: descriptor.categoryId ?? undefined,
      description: descriptor.description ?? undefined,
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
