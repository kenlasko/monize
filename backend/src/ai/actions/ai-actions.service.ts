import {
  BadRequestException,
  ForbiddenException,
  forwardRef,
  Inject,
  Injectable,
  Logger,
} from "@nestjs/common";
import { createHash, timingSafeEqual } from "crypto";
import { plainToInstance } from "class-transformer";
import { validateOrReject } from "class-validator";
import { TransactionsService } from "../../transactions/transactions.service";
import {
  AttachmentsService,
  UploadedAttachmentFile,
} from "../../attachments/attachments.service";
import { RelayAttachmentStore } from "../relay/relay-attachment.store";
import { PayeesService, CreatePayeeOptions } from "../../payees/payees.service";
import { InvestmentTransactionsService } from "../../securities/investment-transactions.service";
import { SecuritiesService } from "../../securities/securities.service";
import { CreateTransactionDto } from "../../transactions/dto/create-transaction.dto";
import { UpdateTransactionDto } from "../../transactions/dto/update-transaction.dto";
import { CreatePayeeDto } from "../../payees/dto/create-payee.dto";
import { UpdatePayeeDto } from "../../payees/dto/update-payee.dto";
import { CreateInvestmentTransactionDto } from "../../securities/dto/create-investment-transaction.dto";
import { UpdateInvestmentTransactionDto } from "../../securities/dto/update-investment-transaction.dto";
import { CreateSecurityDto } from "../../securities/dto/create-security.dto";
import { CreateTransactionRuleDto } from "../../transaction-rules/dto/create-transaction-rule.dto";
import { UpdateTransactionRuleDto } from "../../transaction-rules/dto/update-transaction-rule.dto";
import { RunTransactionRuleDto } from "../../transaction-rules/dto/rule-run.dto";
import type { RuleRunResult } from "../../transaction-rules/rule-run.types";
import { TransactionRulesService } from "../../transaction-rules/transaction-rules.service";
import { TransactionRulesRunService } from "../../transaction-rules/transaction-rules-run.service";
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
  CreateTransactionRuleDescriptor,
  UpdateTransactionRuleDescriptor,
  DeleteTransactionRuleDescriptor,
  RunTransactionRuleDescriptor,
  TransactionRowDescriptor,
  MAX_BULK_ACTION_ROWS,
  AttachmentRefDescriptor,
  toSplitDtoRows,
} from "./ai-action.types";
import { CreateTransferDto } from "../../transactions/dto/create-transfer.dto";
import { UpdateTransferDto } from "../../transactions/dto/update-transfer.dto";
import { BulkCreateSkip } from "../../common/bulk-create.types";
import { ConfirmAiActionDto } from "./dto/confirm-ai-action.dto";
import { SingleUseTokenService } from "../../auth/single-use-token.service";
import { AiReviewRequestsService } from "../../ai-review/ai-review-requests.service";

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
  /** run_transaction_rule: rows changed, rows left alone and why, and the undo entry. */
  ruleRun?: RuleRunResult;
}

/**
 * `single_use_tokens.purpose` for a confirmed action descriptor.
 *
 * The web chat and the MCP relay both commit through `confirm`, so one purpose
 * and one `actionId` are all it takes for the two surfaces to share a claim.
 */
export const AI_ACTION_CLAIM_PURPOSE = "ai-action";

@Injectable()
export class AiActionsService {
  private readonly logger = new Logger(AiActionsService.name);

  constructor(
    @Inject(forwardRef(() => TransactionsService))
    private readonly transactionsService: TransactionsService,
    @Inject(forwardRef(() => PayeesService))
    private readonly payeesService: PayeesService,
    private readonly investmentTransactionsService: InvestmentTransactionsService,
    private readonly securitiesService: SecuritiesService,
    private readonly signingService: AiActionSigningService,
    private readonly writeLimiter: AiWriteLimiter,
    private readonly attachmentsService: AttachmentsService,
    private readonly relayAttachmentStore: RelayAttachmentStore,
    private readonly singleUseTokens: SingleUseTokenService,
    private readonly transactionRulesService: TransactionRulesService,
    private readonly transactionRulesRunService: TransactionRulesRunService,
    private readonly aiReviewRequests: AiReviewRequestsService,
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

    // A bulk action counts as one write per row it would create, so a large
    // batch cannot slip past the daily cap. The pre-check uses the proposed row
    // count; the actual recorded writes (below) reflect only rows created.
    const writeCount = this.proposedWriteCount(
      descriptor as AiActionDescriptor,
    );
    const limit = await this.writeLimiter.checkLimit(userId);
    if (limit.currentCount + writeCount > limit.limit) {
      throw new BadRequestException(
        tr(
          "errors.ai.actionWriteLimit",
          "Daily AI write limit reached. Please try again tomorrow.",
          { limit: limit.limit },
        ),
      );
    }

    // Anti-replay. The claim IS the insert, so the deployment picks one winner
    // on the primary key rather than each replica consulting its own memory --
    // which is what the `Map` this replaces amounted to, and what a restart
    // wiped. The row expires with the descriptor, so the sweep never has to run
    // for the guard to be right.
    //
    // Reserved before executing, so concurrent double-submits cannot both pass,
    // and released when the write throws, so a transient failure leaves the
    // descriptor confirmable. It is not taken inside the write's transaction:
    // `execute` fans out to services that each open their own, dispatch cache
    // invalidation after their commit (INV-CACHE-001) and record action history
    // outside it, and one enclosing transaction would silently move all of that
    // inside itself.
    const claimed = await this.singleUseTokens.claim(
      AI_ACTION_CLAIM_PURPOSE,
      descriptor.actionId,
      descriptor.expiresAt - Date.now(),
    );
    if (!claimed) {
      throw new BadRequestException(
        tr(
          "errors.ai.actionConfirmFailed",
          "This action could not be confirmed.",
        ),
      );
    }
    try {
      const result = await this.execute(
        userId,
        descriptor as AiActionDescriptor,
      );
      // Record one write per entity actually created (bulk actions create
      // best-effort, so this may be fewer than the proposed count). `record`
      // never rejects, so a counter failure cannot reach the `catch` below and
      // release the claim on a write that has already committed.
      await this.writeLimiter.record(
        userId,
        descriptor.type,
        result.count ?? 1,
      );
      return result;
    } catch (err) {
      // Best-effort, and it must never replace the error it is cleaning up
      // after. The `Map` this claim replaced could not fail; a row can, and the
      // most likely reason `execute` threw -- an unreachable database, an
      // exhausted pool -- is the same reason the release would. Letting that
      // rejection propagate would swap the refusal the user needed to read for
      // a driver error, AND leave the claim in place, so the descriptor the
      // release exists to keep confirmable would be spent for work that never
      // happened.
      //
      // A claim left behind expires with the descriptor and is swept
      // (`AuthStateSweeperService`), so the cost of failing here is one
      // re-ask, never a permanent loss.
      try {
        await this.singleUseTokens.release(
          AI_ACTION_CLAIM_PURPOSE,
          descriptor.actionId,
        );
      } catch (releaseError) {
        this.logger.warn(
          `Could not release the claim on AI action ${descriptor.actionId}; ` +
            "it stays spent until it expires: " +
            `${releaseError instanceof Error ? releaseError.message : String(releaseError)}`,
        );
      }
      throw err;
    }
  }

  /**
   * Commit a descriptor the caller built in this process and a person approved
   * outside the confirm endpoint: an MCP client's own dialog. It skips what
   * `confirm` does for a descriptor that ARRIVED from a client (signature,
   * expiry, the anti-replay claim, the AI write cap) because none of that
   * applies to one that never left the server; the caller owns the MCP write
   * cap. Never pass it anything read from a request.
   */
  async commitApproved(
    userId: string,
    descriptor: AiActionDescriptor,
  ): Promise<ConfirmActionResult> {
    return this.execute(userId, descriptor);
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
      case "create_transaction_rule":
        return this.executeCreateTransactionRule(userId, descriptor);
      case "update_transaction_rule":
        return this.executeUpdateTransactionRule(userId, descriptor);
      case "delete_transaction_rule":
        return this.executeDeleteTransactionRule(userId, descriptor);
      case "run_transaction_rule":
        return this.executeRunTransactionRule(userId, descriptor);
    }
  }

  // The rule executors commit through TransactionRulesService and
  // TransactionRulesRunService, which validate the definition and check that
  // every referenced id and the rule itself belong to `userId` inside the
  // write's own transaction -- the descriptor's signature is not the check.

  private async executeCreateTransactionRule(
    userId: string,
    descriptor: CreateTransactionRuleDescriptor,
  ): Promise<ConfirmActionResult> {
    const dto = await this.toValidatedDto(CreateTransactionRuleDto, {
      name: descriptor.rule.name,
      enabled: descriptor.rule.enabled,
      triggers: descriptor.rule.triggers,
      condition: descriptor.rule.condition,
      actions: descriptor.rule.actions,
      stopProcessing: descriptor.rule.stopProcessing,
      activeFrom: descriptor.rule.activeFrom,
      activeTo: descriptor.rule.activeTo,
    });
    const rule = await this.transactionRulesService.create(userId, dto);
    return { type: "create_transaction_rule", id: rule.id };
  }

  private async executeUpdateTransactionRule(
    userId: string,
    descriptor: UpdateTransactionRuleDescriptor,
  ): Promise<ConfirmActionResult> {
    const dto = await this.toValidatedDto(UpdateTransactionRuleDto, {
      name: descriptor.rule.name,
      enabled: descriptor.rule.enabled,
      triggers: descriptor.rule.triggers,
      condition: descriptor.rule.condition,
      actions: descriptor.rule.actions,
      stopProcessing: descriptor.rule.stopProcessing,
      activeFrom: descriptor.rule.activeFrom,
      activeTo: descriptor.rule.activeTo,
      revision: descriptor.expectedRevision,
    });
    const rule = await this.transactionRulesService.update(
      userId,
      descriptor.ruleId,
      dto,
    );
    return { type: "update_transaction_rule", id: rule.id };
  }

  private async executeDeleteTransactionRule(
    userId: string,
    descriptor: DeleteTransactionRuleDescriptor,
  ): Promise<ConfirmActionResult> {
    await this.transactionRulesService.remove(
      userId,
      descriptor.ruleId,
      descriptor.expectedRevision,
    );
    return { type: "delete_transaction_rule", id: descriptor.ruleId };
  }

  /**
   * A 409 PREVIEW_CHANGED from the run (the transactions or the rule moved
   * since the card was built) propagates as it is: the user reads the refusal,
   * nothing was written, and the claim on the descriptor is released.
   */
  private async executeRunTransactionRule(
    userId: string,
    descriptor: RunTransactionRuleDescriptor,
  ): Promise<ConfirmActionResult> {
    const dto = await this.toValidatedDto(RunTransactionRuleDto, {
      ...descriptor.filters,
      fingerprint: descriptor.fingerprint,
    });
    const ruleRun = await this.transactionRulesRunService.run(
      userId,
      descriptor.ruleId,
      dto,
    );
    return { type: "run_transaction_rule", id: descriptor.ruleId, ruleRun };
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
          // A row replacing a split set carries its categories in `splits`;
          // the parent holds none. Same rule as the singular descriptor, and
          // the splits ride in the SAME dto so the row commits once.
          categoryId: r.splits ? undefined : (r.categoryId ?? undefined),
          description: r.description ?? undefined,
          splits: r.splits ? toSplitDtoRows(r.splits) : undefined,
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
          accruedInterest: r.accruedInterest,
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
          website: r.website,
          address: r.address,
          email: r.email,
          phone: r.phone,
        });
        const payee = await this.payeesService.create(userId, dto);
        return payee.id;
      }
      case "update_payee": {
        const r = row as BatchUpdatePayeeRow;
        const dto = await this.toValidatedDto(UpdatePayeeDto, {
          name: r.name,
          defaultCategoryId: r.defaultCategoryId,
          website: r.website,
          address: r.address,
          email: r.email,
          phone: r.phone,
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
          ...(r.assetWeightings !== undefined
            ? { assetWeightings: r.assetWeightings ?? [] }
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
    const { files, refIds } = await this.resolveAttachmentFiles(
      userId,
      descriptor.attachments,
    );
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
      // Splits ride inside the same DTO so update() rebuilds the set in the
      // same transaction, under the same row lock, as the scalar fields
      // (invariant I1) -- never as a separate follow-up write.
      splits: descriptor.splits ? toSplitDtoRows(descriptor.splits) : undefined,
    });
    // An edit that answers an AI review request marks it applied in the write's
    // own transaction, under the row lock and before anything is written: a
    // request that was dismissed or expired since the card was built refuses the
    // edit (409) with nothing changed, and the two commit or roll back together.
    const reviewRequestId = descriptor.aiReviewRequestId;
    const transaction = await this.transactionsService.update(
      userId,
      descriptor.transactionId,
      dto,
      {
        createPayeeIfMissing: descriptor.createPayee === true,
        ...(typeof reviewRequestId === "string"
          ? {
              beforeWrite: (m) =>
                this.aiReviewRequests.markApplied(
                  m,
                  userId,
                  reviewRequestId,
                  descriptor.transactionId,
                ),
            }
          : {}),
      },
    );
    await this.persistAttachments(userId, transaction.id, files, refIds);
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

  /**
   * Resolve the parked bytes for a descriptor's attachment refs BEFORE any
   * write happens, so an expired ref or tampered payload fails the whole
   * confirmation cleanly instead of leaving a transaction without its files.
   * The sha256 in the signed descriptor is re-checked against the parked bytes.
   */
  private async resolveAttachmentFiles(
    userId: string,
    refs: AttachmentRefDescriptor[] | undefined,
  ): Promise<{ files: UploadedAttachmentFile[]; refIds: string[] }> {
    if (!refs || refs.length === 0) {
      return { files: [], refIds: [] };
    }
    const files: UploadedAttachmentFile[] = [];
    for (const ref of refs) {
      const stored = await this.relayAttachmentStore.get(
        userId,
        ref.attachmentRefId,
      );
      if (!stored) {
        throw new BadRequestException(
          tr(
            "errors.ai.attachmentRefExpired",
            "The attached file is no longer available. Please re-upload it and ask again.",
          ),
        );
      }
      // Constant-time comparison, matching the signing service's convention.
      const sha256 = createHash("sha256").update(stored.data).digest();
      const expected = Buffer.from(ref.sha256, "hex");
      if (
        sha256.length !== expected.length ||
        !timingSafeEqual(sha256, expected)
      ) {
        throw new BadRequestException(this.invalidSignatureMessage());
      }
      files.push({
        originalname: ref.filename,
        buffer: stored.data,
        size: stored.data.length,
      });
    }
    return { files, refIds: refs.map((r) => r.attachmentRefId) };
  }

  /** Persist resolved files against the written transaction, then free the refs. */
  private async persistAttachments(
    userId: string,
    transactionId: string,
    files: UploadedAttachmentFile[],
    refIds: string[],
  ): Promise<void> {
    for (const file of files) {
      await this.attachmentsService.create(userId, transactionId, file);
    }
    await this.relayAttachmentStore.releaseForPrompt(userId, refIds);
  }

  private async executeCreateTransaction(
    userId: string,
    descriptor: CreateTransactionDescriptor,
  ): Promise<ConfirmActionResult> {
    const { files, refIds } = await this.resolveAttachmentFiles(
      userId,
      descriptor.attachments,
    );
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
      splits: descriptor.splits ? toSplitDtoRows(descriptor.splits) : undefined,
    });
    const transaction = await this.transactionsService.create(userId, dto, {
      createPayeeIfMissing: descriptor.createPayee === true,
    });
    await this.persistAttachments(userId, transaction.id, files, refIds);
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
      website: descriptor.website,
      address: descriptor.address,
      email: descriptor.email,
      phone: descriptor.phone,
    });
    const payee = await this.payeesService.create(
      userId,
      dto,
      contactLookupOptions(descriptor),
    );
    return { type: "create_payee", id: payee.id };
  }

  private async executeUpdatePayee(
    userId: string,
    descriptor: UpdatePayeeDescriptor,
  ): Promise<ConfirmActionResult> {
    const dto = await this.toValidatedDto(UpdatePayeeDto, {
      name: descriptor.name,
      defaultCategoryId: descriptor.defaultCategoryId,
      // Raw: undefined leaves the stored address alone, null clears it.
      website: descriptor.website,
      address: descriptor.address,
      email: descriptor.email,
      phone: descriptor.phone,
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
      assetWeightings: descriptor.assetWeightings ?? [],
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
}

/**
 * The provenance a preview's contact lookup left on the descriptor, in the
 * shape `PayeesService.create` stores. Absent when the preview did not look
 * up, in which case the create decides about a background lookup itself.
 */
export function contactLookupOptions(
  descriptor: CreatePayeeDescriptor,
): CreatePayeeOptions {
  return descriptor.contactLookup
    ? {
        contactLookup: {
          source: descriptor.contactLookup.source,
          attemptedAt: new Date(descriptor.contactLookup.attemptedAt),
        },
      }
    : {};
}
