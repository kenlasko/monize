import { Injectable } from "@nestjs/common";
import { randomUUID } from "crypto";
import {
  AiActionSigningService,
  AI_ACTION_TTL_MS,
} from "./ai-action-signing.service";
import {
  AiActionPreviewRow,
  BatchActionRow,
  BatchActionsDescriptor,
  BatchUpdateInvestmentTransactionRow,
  BatchDeleteInvestmentTransactionRow,
  CategorizeTransactionDescriptor,
  CreateInvestmentTransactionDescriptor,
  CreateInvestmentTransactionsDescriptor,
  CreatePayeeDescriptor,
  UpdatePayeeDescriptor,
  DeletePayeeDescriptor,
  CreateSecurityDescriptor,
  UpdateSecurityDescriptor,
  DeleteSecurityDescriptor,
  CreateTransactionDescriptor,
  CreateTransactionsDescriptor,
  CreateTransferDescriptor,
  UpdateTransactionDescriptor,
  UpdateTransferDescriptor,
  DeleteTransactionDescriptor,
  UpdateInvestmentTransactionDescriptor,
  DeleteInvestmentTransactionDescriptor,
  PendingAiAction,
} from "./ai-action.types";
import {
  CategorizeTransactionPreview,
  CreateTransactionPreview,
  UpdateTransactionPreview,
  DeleteTransactionPreview,
} from "../../transactions/transactions.service";
import {
  CreateTransferPreview,
  UpdateTransferPreview,
} from "../../transactions/transaction-transfer.service";
import {
  CreatePayeePreview,
  UpdatePayeePreview,
  DeletePayeePreview,
} from "../../payees/payees.service";
import {
  CreateInvestmentTransactionPreview,
  UpdateInvestmentTransactionPreview,
  DeleteInvestmentTransactionPreview,
} from "../../securities/investment-transactions.service";
import {
  CreateSecurityPreview,
  UpdateSecurityPreview,
  DeleteSecurityPreview,
} from "../../securities/securities.service";

/**
 * Map a resolved cash-transaction preview to the display row shown on the bulk
 * confirmation card. Shared by the AI Assistant tool executor and the MCP bulk
 * tool so the two surfaces present identical rows.
 */
export function transactionPreviewRow(
  preview: CreateTransactionPreview,
): AiActionPreviewRow {
  return {
    status: "ok",
    accountName: preview.accountName,
    amount: preview.amount,
    currencyCode: preview.currencyCode,
    transactionDate: preview.transactionDate,
    payeeName: preview.payeeName,
    payeeWillBeCreated: preview.payeeWillBeCreated,
    categoryName: preview.categoryName,
    description: preview.description,
  };
}

/** Map a resolved payee create/edit preview to a bulk-card display row. */
export function payeePreviewRow(
  preview: CreatePayeePreview | UpdatePayeePreview,
): AiActionPreviewRow {
  return {
    status: "ok",
    name: preview.name,
    categoryName: preview.defaultCategoryName,
  };
}

/** Map a resolved security create/edit preview to a bulk-card display row. */
export function securityPreviewRow(
  preview: CreateSecurityPreview | UpdateSecurityPreview,
): AiActionPreviewRow {
  return {
    status: "ok",
    symbol: preview.symbol,
    securityName: preview.name,
    securityCurrency: preview.currencyCode,
  };
}

/** Map a resolved investment-transaction preview to a bulk-card display row. */
export function investmentPreviewRow(
  preview: CreateInvestmentTransactionPreview,
): AiActionPreviewRow {
  return {
    status: "ok",
    accountName: preview.accountName,
    investmentAction: preview.action,
    transactionDate: preview.transactionDate,
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
  };
}

/**
 * Map a resolved transfer preview to a bulk-card display row. The "from" leg
 * reuses accountName/amount/currencyCode; the destination leg is carried in the
 * transfer-specific fields. Shared by both tool surfaces.
 */
export function transferPreviewRow(
  preview: CreateTransferPreview | UpdateTransferPreview,
): AiActionPreviewRow {
  return {
    status: "ok",
    accountName: preview.fromAccountName,
    fromAccountName: preview.fromAccountName,
    amount: preview.amount,
    currencyCode: preview.fromCurrencyCode,
    toAccountName: preview.toAccountName,
    toAmount: preview.toAmount,
    toCurrencyCode: preview.toCurrencyCode,
    transactionDate: preview.transactionDate,
    description: preview.description,
    payeeName: preview.payeeName,
    payeeWillBeCreated: preview.payeeWillBeCreated,
  };
}

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

  buildUpdatePayee(
    userId: string,
    preview: UpdatePayeePreview,
  ): PendingAiAction {
    const { actionId, expiresAt } = this.newEnvelope();
    const descriptor: UpdatePayeeDescriptor = {
      type: "update_payee",
      userId,
      actionId,
      expiresAt,
      payeeId: preview.payeeId,
      name: preview.name,
      defaultCategoryId: preview.defaultCategoryId,
    };
    return {
      actionId,
      type: "update_payee",
      expiresAt,
      descriptor,
      signature: this.signingService.sign(descriptor),
      preview: {
        name: preview.name,
        categoryName: preview.defaultCategoryName,
      },
    };
  }

  buildDeletePayee(
    userId: string,
    preview: DeletePayeePreview,
  ): PendingAiAction {
    const { actionId, expiresAt } = this.newEnvelope();
    const descriptor: DeletePayeeDescriptor = {
      type: "delete_payee",
      userId,
      actionId,
      expiresAt,
      payeeId: preview.payeeId,
    };
    return {
      actionId,
      type: "delete_payee",
      expiresAt,
      descriptor,
      signature: this.signingService.sign(descriptor),
      preview: {
        name: preview.name,
      },
    };
  }

  buildCreateSecurity(
    userId: string,
    preview: CreateSecurityPreview,
  ): PendingAiAction {
    const { actionId, expiresAt } = this.newEnvelope();
    const descriptor: CreateSecurityDescriptor = {
      type: "create_security",
      userId,
      actionId,
      expiresAt,
      symbol: preview.symbol,
      name: preview.name,
      securityType: preview.securityType,
      exchange: preview.exchange,
      currencyCode: preview.currencyCode,
      isFavourite: preview.isFavourite,
      quoteProvider: preview.quoteProvider,
      msnInstrumentId: preview.msnInstrumentId,
    };
    return {
      actionId,
      type: "create_security",
      expiresAt,
      descriptor,
      signature: this.signingService.sign(descriptor),
      preview: {
        symbol: preview.symbol,
        securityName: preview.name,
        securityType: preview.securityType,
        exchange: preview.exchange,
        securityCurrency: preview.currencyCode,
        isFavourite: preview.isFavourite,
      },
    };
  }

  buildUpdateSecurity(
    userId: string,
    preview: UpdateSecurityPreview,
  ): PendingAiAction {
    const { actionId, expiresAt } = this.newEnvelope();
    const descriptor: UpdateSecurityDescriptor = {
      type: "update_security",
      userId,
      actionId,
      expiresAt,
      securityId: preview.securityId,
      securityType: preview.securityType,
      exchange: preview.exchange,
      currencyCode: preview.currencyCode,
      isFavourite: preview.isFavourite,
    };
    return {
      actionId,
      type: "update_security",
      expiresAt,
      descriptor,
      signature: this.signingService.sign(descriptor),
      preview: {
        symbol: preview.symbol,
        securityName: preview.name,
        securityType: preview.securityType,
        exchange: preview.exchange,
        securityCurrency: preview.currencyCode,
        isFavourite: preview.isFavourite,
      },
    };
  }

  buildDeleteSecurity(
    userId: string,
    preview: DeleteSecurityPreview,
  ): PendingAiAction {
    const { actionId, expiresAt } = this.newEnvelope();
    const descriptor: DeleteSecurityDescriptor = {
      type: "delete_security",
      userId,
      actionId,
      expiresAt,
      securityId: preview.securityId,
    };
    return {
      actionId,
      type: "delete_security",
      expiresAt,
      descriptor,
      signature: this.signingService.sign(descriptor),
      preview: {
        symbol: preview.symbol,
        securityName: preview.name,
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

  buildUpdateTransaction(
    userId: string,
    preview: UpdateTransactionPreview,
  ): PendingAiAction {
    const { actionId, expiresAt } = this.newEnvelope();
    const descriptor: UpdateTransactionDescriptor = {
      type: "update_transaction",
      userId,
      actionId,
      expiresAt,
      transactionId: preview.transactionId,
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
      type: "update_transaction",
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

  buildDeleteTransaction(
    userId: string,
    preview: DeleteTransactionPreview,
  ): PendingAiAction {
    const { actionId, expiresAt } = this.newEnvelope();
    const descriptor: DeleteTransactionDescriptor = {
      type: "delete_transaction",
      userId,
      actionId,
      expiresAt,
      transactionId: preview.transactionId,
    };
    return {
      actionId,
      type: "delete_transaction",
      expiresAt,
      descriptor,
      signature: this.signingService.sign(descriptor),
      preview: {
        accountName: preview.accountName,
        amount: preview.amount,
        currencyCode: preview.currencyCode,
        transactionDate: preview.transactionDate,
        payeeName: preview.payeeName,
        categoryName: preview.categoryName,
        description: preview.description,
      },
    };
  }

  buildUpdateInvestmentTransaction(
    userId: string,
    preview: UpdateInvestmentTransactionPreview,
  ): PendingAiAction {
    const { actionId, expiresAt } = this.newEnvelope();
    const descriptor: UpdateInvestmentTransactionDescriptor = {
      type: "update_investment_transaction",
      userId,
      actionId,
      expiresAt,
      transactionId: preview.transactionId,
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
      type: "update_investment_transaction",
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

  buildDeleteInvestmentTransaction(
    userId: string,
    preview: DeleteInvestmentTransactionPreview,
  ): PendingAiAction {
    const { actionId, expiresAt } = this.newEnvelope();
    const descriptor: DeleteInvestmentTransactionDescriptor = {
      type: "delete_investment_transaction",
      userId,
      actionId,
      expiresAt,
      transactionId: preview.transactionId,
    };
    return {
      actionId,
      type: "delete_investment_transaction",
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
        description: preview.description,
      },
    };
  }

  /**
   * Build the signed envelope for a bulk cash-transaction action. `okPreviews`
   * are the resolved rows that will be created (mapped into the signed
   * descriptor in order); `previewRows` is the full display table -- every
   * pasted row, valid and flagged -- shown on the confirmation card.
   */
  buildCreateTransactions(
    userId: string,
    okPreviews: CreateTransactionPreview[],
    previewRows: AiActionPreviewRow[],
  ): PendingAiAction {
    const { actionId, expiresAt } = this.newEnvelope();
    const descriptor: CreateTransactionsDescriptor = {
      type: "create_transactions",
      userId,
      actionId,
      expiresAt,
      rows: okPreviews.map((preview) => ({
        accountId: preview.accountId,
        amount: preview.amount,
        transactionDate: preview.transactionDate,
        payeeId: preview.payeeId,
        payeeName: preview.payeeName,
        createPayee: preview.payeeWillBeCreated,
        categoryId: preview.categoryId,
        description: preview.description,
        currencyCode: preview.currencyCode,
      })),
    };
    return {
      actionId,
      type: "create_transactions",
      expiresAt,
      descriptor,
      signature: this.signingService.sign(descriptor),
      preview: { rows: previewRows },
    };
  }

  /**
   * Build the signed envelope for a bulk investment-transaction action. See
   * `buildCreateTransactions` for the split between the signed `okPreviews` and
   * the display-only `previewRows`.
   */
  buildCreateInvestmentTransactions(
    userId: string,
    okPreviews: CreateInvestmentTransactionPreview[],
    previewRows: AiActionPreviewRow[],
  ): PendingAiAction {
    const { actionId, expiresAt } = this.newEnvelope();
    const descriptor: CreateInvestmentTransactionsDescriptor = {
      type: "create_investment_transactions",
      userId,
      actionId,
      expiresAt,
      rows: okPreviews.map((preview) => ({
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
      })),
    };
    return {
      actionId,
      type: "create_investment_transactions",
      expiresAt,
      descriptor,
      signature: this.signingService.sign(descriptor),
      preview: { rows: previewRows },
    };
  }

  buildCreateTransfer(
    userId: string,
    preview: CreateTransferPreview,
  ): PendingAiAction {
    const { actionId, expiresAt } = this.newEnvelope();
    const descriptor: CreateTransferDescriptor = {
      type: "create_transfer",
      userId,
      actionId,
      expiresAt,
      fromAccountId: preview.fromAccountId,
      toAccountId: preview.toAccountId,
      amount: preview.amount,
      transactionDate: preview.transactionDate,
      fromCurrencyCode: preview.fromCurrencyCode,
      toCurrencyCode: preview.toCurrencyCode,
      exchangeRate: preview.exchangeRate,
      toAmount: preview.toAmount,
      description: preview.description,
      payeeId: preview.payeeId,
      payeeName: preview.payeeName,
      createPayee: preview.payeeWillBeCreated,
    };
    return {
      actionId,
      type: "create_transfer",
      expiresAt,
      descriptor,
      signature: this.signingService.sign(descriptor),
      preview: {
        fromAccountName: preview.fromAccountName,
        accountName: preview.fromAccountName,
        amount: preview.amount,
        currencyCode: preview.fromCurrencyCode,
        toAccountName: preview.toAccountName,
        toAmount: preview.toAmount,
        toCurrencyCode: preview.toCurrencyCode,
        transactionDate: preview.transactionDate,
        description: preview.description,
        payeeName: preview.payeeName,
        payeeWillBeCreated: preview.payeeWillBeCreated,
      },
    };
  }

  buildUpdateTransfer(
    userId: string,
    preview: UpdateTransferPreview,
  ): PendingAiAction {
    const { actionId, expiresAt } = this.newEnvelope();
    const descriptor: UpdateTransferDescriptor = {
      type: "update_transfer",
      userId,
      actionId,
      expiresAt,
      transactionId: preview.transactionId,
      fromAccountId: preview.fromAccountId,
      toAccountId: preview.toAccountId,
      amount: preview.amount,
      transactionDate: preview.transactionDate,
      exchangeRate: preview.exchangeRate,
      toAmount: preview.toAmount,
      description: preview.description,
      payeeId: preview.payeeId,
      payeeName: preview.payeeName,
      createPayee: preview.payeeWillBeCreated,
    };
    return {
      actionId,
      type: "update_transfer",
      expiresAt,
      descriptor,
      signature: this.signingService.sign(descriptor),
      preview: {
        fromAccountName: preview.fromAccountName,
        accountName: preview.fromAccountName,
        amount: preview.amount,
        currencyCode: preview.fromCurrencyCode,
        toAccountName: preview.toAccountName,
        toAmount: preview.toAmount,
        toCurrencyCode: preview.toCurrencyCode,
        transactionDate: preview.transactionDate,
        description: preview.description,
        payeeName: preview.payeeName,
        payeeWillBeCreated: preview.payeeWillBeCreated,
      },
    };
  }

  /**
   * Build the signed envelope for a generic bulk action. Maps already-resolved
   * previews into per-row descriptors (no per-row signature -- the whole
   * envelope is signed once) and carries the display-only `previewRows`.
   *
   * Standard bulk *create* keeps using `buildCreateTransactions` (its dedicated
   * `create_transactions` descriptor/executor are unchanged for backward
   * compatibility); this path serves bulk update, delete, and transfer-create.
   */
  buildBatchActions(
    userId: string,
    operation: BatchActionsDescriptor["operation"],
    rows: BatchActionRow[],
    previewRows: AiActionPreviewRow[],
  ): PendingAiAction {
    const { actionId, expiresAt } = this.newEnvelope();
    const descriptor: BatchActionsDescriptor = {
      type: "batch_actions",
      userId,
      actionId,
      expiresAt,
      operation,
      rows,
    };
    return {
      actionId,
      type: "batch_actions",
      expiresAt,
      descriptor,
      signature: this.signingService.sign(descriptor),
      preview: { rows: previewRows },
    };
  }

  /**
   * Build the one-card bulk envelope for investment edits. Thin wrapper over
   * `buildBatchActions` with the `update_investment` operation -- the
   * confirm-side `executeBatchRow` maps each row through the same
   * `InvestmentTransactionsService.update` the single editor uses.
   */
  buildBatchUpdateInvestmentTransactions(
    userId: string,
    rows: BatchUpdateInvestmentTransactionRow[],
    previewRows: AiActionPreviewRow[],
  ): PendingAiAction {
    return this.buildBatchActions(
      userId,
      "update_investment",
      rows,
      previewRows,
    );
  }

  /** Build the one-card bulk envelope for investment deletions. */
  buildBatchDeleteInvestmentTransactions(
    userId: string,
    rows: BatchDeleteInvestmentTransactionRow[],
    previewRows: AiActionPreviewRow[],
  ): PendingAiAction {
    return this.buildBatchActions(
      userId,
      "delete_investment",
      rows,
      previewRows,
    );
  }
}
