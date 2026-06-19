import { Injectable } from "@nestjs/common";
import { randomUUID } from "crypto";
import {
  AiActionSigningService,
  AI_ACTION_TTL_MS,
} from "./ai-action-signing.service";
import {
  CategorizeTransactionDescriptor,
  CreateInvestmentTransactionDescriptor,
  CreatePayeeDescriptor,
  CreateTransactionDescriptor,
  PendingAiAction,
} from "./ai-action.types";
import {
  CategorizeTransactionPreview,
  CreateTransactionPreview,
} from "../../transactions/transactions.service";
import { CreatePayeePreview } from "../../payees/payees.service";
import { CreateInvestmentTransactionPreview } from "../../securities/investment-transactions.service";

/**
 * Builds the signed `PendingAiAction` envelopes for human-in-the-loop write
 * actions from an already-resolved preview.
 *
 * Both surfaces that propose writes share this single source of truth: the AI
 * Assistant tool executor (`ToolExecutorService`) and the MCP write tools
 * (which, when serving a relayed browser prompt, emit the same card to the web
 * chat). Keeping the descriptor/signature/preview construction here guarantees
 * the two surfaces produce byte-identical actions that the confirm endpoint
 * (`/ai/actions/confirm`) can verify and commit the same way.
 */
@Injectable()
export class AiActionBuilderService {
  constructor(private readonly signingService: AiActionSigningService) {}

  private newEnvelope(): { actionId: string; expiresAt: number } {
    return {
      actionId: randomUUID(),
      expiresAt: Date.now() + AI_ACTION_TTL_MS,
    };
  }

  buildCreateTransaction(
    userId: string,
    preview: CreateTransactionPreview,
  ): PendingAiAction {
    const { actionId, expiresAt } = this.newEnvelope();
    const descriptor: CreateTransactionDescriptor = {
      type: "create_transaction",
      userId,
      actionId,
      expiresAt,
      accountId: preview.accountId,
      amount: preview.amount,
      transactionDate: preview.transactionDate,
      payeeId: preview.payeeId,
      payeeName: preview.payeeName,
      createPayee: preview.payeeWillBeCreated,
      categoryId: preview.categoryId,
      description: preview.description,
      currencyCode: preview.currencyCode,
    };
    return {
      actionId,
      type: "create_transaction",
      expiresAt,
      descriptor,
      signature: this.signingService.sign(descriptor),
      preview: {
        accountName: preview.accountName,
        amount: preview.amount,
        currencyCode: preview.currencyCode,
        transactionDate: preview.transactionDate,
        payeeName: preview.payeeName,
        payeeWillBeCreated: preview.payeeWillBeCreated,
        categoryName: preview.categoryName,
        description: preview.description,
      },
    };
  }

  buildCategorizeTransaction(
    userId: string,
    preview: CategorizeTransactionPreview,
  ): PendingAiAction {
    const { actionId, expiresAt } = this.newEnvelope();
    const descriptor: CategorizeTransactionDescriptor = {
      type: "categorize_transaction",
      userId,
      actionId,
      expiresAt,
      transactionId: preview.transactionId,
      categoryId: preview.categoryId,
    };
    return {
      actionId,
      type: "categorize_transaction",
      expiresAt,
      descriptor,
      signature: this.signingService.sign(descriptor),
      preview: {
        payeeName: preview.payeeName,
        amount: preview.amount,
        transactionDate: preview.transactionDate,
        // AiActionPreview.accountName is non-nullable display text; a
        // transaction without a resolvable account name omits it.
        accountName: preview.accountName ?? undefined,
        currentCategoryName: preview.currentCategoryName,
        newCategoryName: preview.newCategoryName,
      },
    };
  }

  buildCreatePayee(
    userId: string,
    preview: CreatePayeePreview,
  ): PendingAiAction {
    const { actionId, expiresAt } = this.newEnvelope();
    const descriptor: CreatePayeeDescriptor = {
      type: "create_payee",
      userId,
      actionId,
      expiresAt,
      name: preview.name,
      defaultCategoryId: preview.defaultCategoryId,
    };
    return {
      actionId,
      type: "create_payee",
      expiresAt,
      descriptor,
      signature: this.signingService.sign(descriptor),
      preview: {
        name: preview.name,
        categoryName: preview.defaultCategoryName,
      },
    };
  }

  buildCreateInvestmentTransaction(
    userId: string,
    preview: CreateInvestmentTransactionPreview,
  ): PendingAiAction {
    const { actionId, expiresAt } = this.newEnvelope();
    const descriptor: CreateInvestmentTransactionDescriptor = {
      type: "create_investment_transaction",
      userId,
      actionId,
      expiresAt,
      accountId: preview.accountId,
      action: preview.action,
      transactionDate: preview.transactionDate,
      securityId: preview.securityId,
      fundingAccountId: preview.fundingAccountId,
      quantity: preview.quantity,
      price: preview.price,
      commission: preview.commission,
      exchangeRate: preview.exchangeRate,
      description: preview.description,
    };
    return {
      actionId,
      type: "create_investment_transaction",
      expiresAt,
      descriptor,
      signature: this.signingService.sign(descriptor),
      preview: {
        accountName: preview.accountName,
        transactionDate: preview.transactionDate,
        investmentAction: preview.action,
        symbol: preview.symbol,
        securityName: preview.securityName,
        securityCurrency: preview.securityCurrency,
        quantity: preview.quantity,
        price: preview.price,
        commission: preview.commission,
        totalAmount: preview.totalAmount,
        cashAccountName: preview.cashAccountName,
        cashCurrency: preview.cashCurrency,
        cashAmount: preview.cashAmount,
        description: preview.description,
      },
    };
  }
}
