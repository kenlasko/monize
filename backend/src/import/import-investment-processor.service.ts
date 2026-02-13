import { Injectable, Logger } from "@nestjs/common";
import { Account, AccountSubType } from "../accounts/entities/account.entity";
import { Security } from "../securities/entities/security.entity";
import {
  InvestmentTransaction,
  InvestmentAction,
} from "../securities/entities/investment-transaction.entity";
import { Holding } from "../securities/entities/holding.entity";
import {
  Transaction,
  TransactionStatus,
} from "../transactions/entities/transaction.entity";
import { ImportContext, updateAccountBalance } from "./import-context";

@Injectable()
export class ImportInvestmentProcessorService {
  private readonly logger = new Logger(ImportInvestmentProcessorService.name);

  async processTransaction(ctx: ImportContext, qifTx: any): Promise<void> {
    const actionMap: Record<string, InvestmentAction> = {
      buy: InvestmentAction.BUY,
      sell: InvestmentAction.SELL,
      div: InvestmentAction.DIVIDEND,
      intinc: InvestmentAction.INTEREST,
      cglong: InvestmentAction.CAPITAL_GAIN,
      cgshort: InvestmentAction.CAPITAL_GAIN,
      stksplit: InvestmentAction.SPLIT,
      shrsin: InvestmentAction.TRANSFER_IN,
      shrsout: InvestmentAction.TRANSFER_OUT,
      reinvdiv: InvestmentAction.REINVEST,
      reinvint: InvestmentAction.REINVEST,
      reinvlg: InvestmentAction.REINVEST,
      reinvsh: InvestmentAction.REINVEST,
    };

    const qifAction = (qifTx.action || "").toLowerCase();
    const baseAction = qifAction.replace(/x$/, "");
    const action =
      actionMap[baseAction] || actionMap[qifAction] || InvestmentAction.BUY;

    // Resolve security
    let securityId = qifTx.security
      ? ctx.securityMap.get(qifTx.security) || null
      : null;

    if (!securityId && qifTx.security) {
      securityId = await this.autoCreateSecurity(ctx, qifTx.security);
    }

    // Calculate amounts
    const quantity = qifTx.quantity || 0;
    const price = qifTx.price || 0;
    const commission = qifTx.commission || 0;
    let totalAmount = qifTx.amount
      ? Math.round(qifTx.amount * 100) / 100
      : Math.round((quantity * price + commission) * 100) / 100;

    if (action === InvestmentAction.BUY) {
      totalAmount = Math.round((quantity * price + commission) * 100) / 100;
    } else if (action === InvestmentAction.SELL) {
      totalAmount = Math.round((quantity * price - commission) * 100) / 100;
    }

    // Create investment transaction
    const investmentTx = new InvestmentTransaction();
    investmentTx.userId = ctx.userId;
    investmentTx.accountId = ctx.accountId;
    investmentTx.securityId = securityId;
    investmentTx.action = action;
    investmentTx.transactionDate = qifTx.date;
    investmentTx.quantity = quantity || null;
    investmentTx.price = price || null;
    investmentTx.commission = commission;
    investmentTx.totalAmount = totalAmount;
    investmentTx.description = qifTx.memo || qifTx.payee || null;

    await ctx.queryRunner.manager.save(investmentTx);

    // Handle cash transaction
    await this.processCashTransaction(
      ctx,
      investmentTx,
      action,
      quantity,
      price,
      totalAmount,
      securityId,
    );

    // Update holdings
    await this.processHoldings(ctx, action, securityId, quantity, price);

    ctx.importResult.imported++;
  }

  private async autoCreateSecurity(
    ctx: ImportContext,
    securityName: string,
  ): Promise<string> {
    const words = securityName.trim().split(/\s+/);
    let generatedSymbol = words
      .map((word) => word.charAt(0).toUpperCase())
      .join("");

    if (generatedSymbol.length < 2) {
      generatedSymbol = securityName
        .substring(0, 4)
        .toUpperCase()
        .replace(/[^A-Z]/g, "");
    }
    generatedSymbol = generatedSymbol.substring(0, 9);
    generatedSymbol = `${generatedSymbol}*`;

    let existingSecurity = await ctx.queryRunner.manager.findOne(Security, {
      where: { symbol: generatedSymbol, userId: ctx.userId },
    });

    if (existingSecurity && existingSecurity.name !== securityName) {
      let counter = 2;
      let uniqueSymbol = `${generatedSymbol}${counter}`;
      while (
        await ctx.queryRunner.manager.findOne(Security, {
          where: { symbol: uniqueSymbol, userId: ctx.userId },
        })
      ) {
        counter++;
        uniqueSymbol = `${generatedSymbol}${counter}`;
      }
      generatedSymbol = uniqueSymbol;
      existingSecurity = null;
    }

    if (existingSecurity) {
      const securityId = existingSecurity.id;
      ctx.securityMap.set(securityName, securityId);
      return securityId;
    }

    const newSecurity = new Security();
    newSecurity.userId = ctx.userId;
    newSecurity.symbol = generatedSymbol;
    newSecurity.name = securityName;
    newSecurity.securityType = null;
    newSecurity.exchange = null;
    newSecurity.currencyCode = ctx.account.currencyCode;
    newSecurity.isActive = true;
    newSecurity.skipPriceUpdates = true;
    const savedSecurity = await ctx.queryRunner.manager.save(newSecurity);

    ctx.importResult.securitiesCreated++;
    this.logger.log(
      `Auto-created security: ${generatedSymbol} for "${securityName}" (price updates disabled)`,
    );

    ctx.securityMap.set(securityName, savedSecurity.id);
    return savedSecurity.id;
  }

  private async processCashTransaction(
    ctx: ImportContext,
    investmentTx: InvestmentTransaction,
    action: InvestmentAction,
    quantity: number,
    price: number,
    totalAmount: number,
    securityId: string | null,
  ): Promise<void> {
    let cashAccountId = ctx.accountId;
    let cashAccountCurrency = ctx.account.currencyCode;

    if (
      ctx.account.accountSubType === AccountSubType.INVESTMENT_BROKERAGE &&
      ctx.account.linkedAccountId
    ) {
      cashAccountId = ctx.account.linkedAccountId;
      ctx.affectedAccountIds.add(cashAccountId);
      const linkedAccount = await ctx.queryRunner.manager.findOne(Account, {
        where: { id: ctx.account.linkedAccountId },
      });
      if (linkedAccount) {
        cashAccountCurrency = linkedAccount.currencyCode;
      }
    }

    const cashAffectingActions = [
      InvestmentAction.BUY,
      InvestmentAction.SELL,
      InvestmentAction.DIVIDEND,
      InvestmentAction.INTEREST,
      InvestmentAction.CAPITAL_GAIN,
    ];

    if (!cashAffectingActions.includes(action)) {
      return;
    }

    const cashAmount =
      action === InvestmentAction.BUY ? -totalAmount : totalAmount;

    let securitySymbol = "Unknown";
    if (securityId) {
      const security = await ctx.queryRunner.manager.findOne(Security, {
        where: { id: securityId },
      });
      if (security) {
        securitySymbol = security.symbol;
      }
    }

    const formatAction = (act: string) => {
      return act
        .split("_")
        .map(
          (word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase(),
        )
        .join(" ");
    };
    const actionLabel = formatAction(action);

    let payeeName: string;
    if (action === InvestmentAction.BUY || action === InvestmentAction.SELL) {
      payeeName = `${actionLabel}: ${securitySymbol} ${quantity} @ $${price.toFixed(2)}`;
    } else if (action === InvestmentAction.INTEREST) {
      payeeName = `${actionLabel}: $${totalAmount.toFixed(2)}`;
    } else {
      payeeName = `${actionLabel}: ${securitySymbol} $${totalAmount.toFixed(2)}`;
    }

    const cashTx = new Transaction();
    cashTx.userId = ctx.userId;
    cashTx.accountId = cashAccountId;
    cashTx.transactionDate = investmentTx.transactionDate;
    cashTx.amount = cashAmount;
    cashTx.currencyCode = cashAccountCurrency;
    cashTx.exchangeRate = 1;
    cashTx.payeeName = payeeName;
    cashTx.payeeId = null;
    cashTx.description = investmentTx.description;
    cashTx.status = TransactionStatus.CLEARED;
    cashTx.isTransfer = false;

    const savedCashTx = await ctx.queryRunner.manager.save(cashTx);

    investmentTx.transactionId = savedCashTx.id;
    await ctx.queryRunner.manager.save(investmentTx);

    await updateAccountBalance(ctx.queryRunner, cashAccountId, cashAmount);
  }

  private async processHoldings(
    ctx: ImportContext,
    action: InvestmentAction,
    securityId: string | null,
    quantity: number,
    price: number,
  ): Promise<void> {
    const holdingsActions = [
      InvestmentAction.BUY,
      InvestmentAction.SELL,
      InvestmentAction.REINVEST,
      InvestmentAction.TRANSFER_IN,
      InvestmentAction.TRANSFER_OUT,
    ];

    if (!holdingsActions.includes(action) || !securityId || !quantity) {
      return;
    }

    const quantityChange = [
      InvestmentAction.SELL,
      InvestmentAction.TRANSFER_OUT,
    ].includes(action)
      ? -quantity
      : quantity;

    let holding = await ctx.queryRunner.manager.findOne(Holding, {
      where: { accountId: ctx.accountId, securityId },
    });

    if (!holding) {
      holding = new Holding();
      holding.accountId = ctx.accountId;
      holding.securityId = securityId;
      holding.quantity = quantityChange;
      holding.averageCost = price || 0;
    } else {
      const currentQuantity = Number(holding.quantity);
      const currentAvgCost = Number(holding.averageCost || 0);
      const newQuantity = currentQuantity + quantityChange;

      if (quantityChange > 0 && price) {
        const totalCostBefore = currentQuantity * currentAvgCost;
        const totalCostAdded = quantityChange * price;
        holding.averageCost =
          newQuantity > 0
            ? (totalCostBefore + totalCostAdded) / newQuantity
            : 0;
      }

      holding.quantity = newQuantity;
    }

    await ctx.queryRunner.manager.save(holding);
  }
}
