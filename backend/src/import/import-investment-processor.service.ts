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
import { isGbxExchange, convertGbxToGbp } from "../common/gbx-currency.util";
import { roundToDecimals } from "../common/round.util";

@Injectable()
export class ImportInvestmentProcessorService {
  private readonly logger = new Logger(ImportInvestmentProcessorService.name);

  async processTransaction(ctx: ImportContext, qifTx: any): Promise<void> {
    // XIn/XOut are cash-only transfers between the investment account and
    // another account; they carry no security data and must be handled as
    // regular linked transactions rather than investment transactions.
    // The "Cash" action with a transfer account (L[Account Name]) is also
    // a pure cash transfer and must be handled the same way; otherwise it
    // gets incorrectly mapped to an INTEREST investment transaction.
    const qifActionRaw = (qifTx.action || "").toLowerCase();
    if (
      qifActionRaw === "xin" ||
      qifActionRaw === "xout" ||
      (qifActionRaw === "cash" && qifTx.isTransfer && qifTx.transferAccount)
    ) {
      await this.processCashTransfer(ctx, qifTx);
      return;
    }

    const actionMap: Record<string, InvestmentAction> = {
      buy: InvestmentAction.BUY,
      sell: InvestmentAction.SELL,
      div: InvestmentAction.DIVIDEND,
      intinc: InvestmentAction.INTEREST,
      cglong: InvestmentAction.CAPITAL_GAIN,
      cgshort: InvestmentAction.CAPITAL_GAIN,
      cgmid: InvestmentAction.CAPITAL_GAIN,
      stksplit: InvestmentAction.SPLIT,
      shrsin: InvestmentAction.TRANSFER_IN,
      shrsout: InvestmentAction.TRANSFER_OUT,
      reinvdiv: InvestmentAction.REINVEST,
      reinvint: InvestmentAction.REINVEST,
      reinvlg: InvestmentAction.REINVEST,
      reinvsh: InvestmentAction.REINVEST,
      reinvmd: InvestmentAction.REINVEST,
      // Quicken-specific actions
      contrib: InvestmentAction.BUY,
      margint: InvestmentAction.INTEREST,
      miscexp: InvestmentAction.INTEREST,
      miscinc: InvestmentAction.INTEREST,
      rtrncap: InvestmentAction.DIVIDEND,
      shtsell: InvestmentAction.SELL,
      cvrshrt: InvestmentAction.BUY,
      xin: InvestmentAction.TRANSFER_IN,
      xout: InvestmentAction.TRANSFER_OUT,
      cash: InvestmentAction.INTEREST,
      exercise: InvestmentAction.BUY,
      expire: InvestmentAction.REMOVE_SHARES,
      grant: InvestmentAction.ADD_SHARES,
      vest: InvestmentAction.ADD_SHARES,
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

    // Detect GBX (pence sterling) pricing for LSE securities.
    // QIF files from UK brokers quote prices in pence; convert to GBP.
    const needsGbxConversion = await this.shouldConvertGbx(ctx, securityId);

    // Calculate amounts
    const quantity = qifTx.quantity || 0;
    const rawPrice = qifTx.price || 0;
    const rawCommission = qifTx.commission || 0;
    const price = needsGbxConversion ? convertGbxToGbp(rawPrice) : rawPrice;
    const commission = needsGbxConversion
      ? convertGbxToGbp(rawCommission)
      : rawCommission;
    let totalAmount = qifTx.amount
      ? needsGbxConversion
        ? convertGbxToGbp(roundToDecimals(qifTx.amount, 2))
        : roundToDecimals(qifTx.amount, 2)
      : roundToDecimals(quantity * price + commission, 2);

    if (action === InvestmentAction.BUY) {
      totalAmount = roundToDecimals(quantity * price + commission, 2);
    } else if (action === InvestmentAction.SELL) {
      totalAmount = roundToDecimals(quantity * price - commission, 2);
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

  private async processCashTransfer(
    ctx: ImportContext,
    qifTx: any,
  ): Promise<void> {
    // Determine the cash account to credit/debit.
    // For brokerage accounts with a linked cash account, cash goes there.
    let cashAccountId = ctx.accountId;
    let cashCurrencyCode = ctx.account.currencyCode;
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
        cashCurrencyCode = linkedAccount.currencyCode;
      }
    }

    // Quicken XOut uses positive amounts even though money is leaving the
    // account.  Normalise to negative so the cash transaction correctly
    // decreases the source balance and the duplicate-detection query matches
    // the linked transaction created by the counterpart XIn entry.
    const actionLower = (qifTx.action || "").toLowerCase();
    let cashAmount = qifTx.amount || 0;
    if (actionLower === "xout" && cashAmount > 0) {
      cashAmount = -cashAmount;
    }
    const status = qifTx.reconciled
      ? TransactionStatus.RECONCILED
      : qifTx.cleared
        ? TransactionStatus.CLEARED
        : TransactionStatus.UNRECONCILED;

    let transferAccountId: string | null =
      qifTx.isTransfer && qifTx.transferAccount
        ? (ctx.accountMap.get(qifTx.transferAccount) ?? null)
        : null;
    // Case-insensitive fallback (matches resolveTransactionTarget behavior)
    if (!transferAccountId && qifTx.isTransfer && qifTx.transferAccount) {
      const lowerName = qifTx.transferAccount.toLowerCase();
      for (const [name, id] of ctx.accountMap) {
        if (id && name.toLowerCase() === lowerName) {
          transferAccountId = id;
          break;
        }
      }
    }

    // Duplicate detection using the same counting approach as the regular
    // processor: compare how many matching linked transfers already exist in
    // the DB against how many same-signature entries we have seen so far in
    // this import block, and only skip when the seen count does not exceed
    // the existing count.
    if (transferAccountId) {
      const existingCount = await ctx.queryRunner.manager
        .createQueryBuilder(Transaction, "t")
        .innerJoin(Transaction, "linked", "t.linked_transaction_id = linked.id")
        .where("t.user_id = :userId", { userId: ctx.userId })
        .andWhere("t.account_id = :accountId", { accountId: cashAccountId })
        .andWhere("t.is_transfer = true")
        .andWhere("t.transaction_date = :date", { date: qifTx.date })
        .andWhere("t.amount = :amount", { amount: cashAmount })
        .andWhere("linked.account_id = :linkedAccountId", {
          linkedAccountId: transferAccountId,
        })
        .getCount();

      // Always count every QIF entry with this signature, including ones where
      // existingCount is zero (i.e. a fresh import where this QIF entry itself
      // creates the first DB record). This ensures that when the next entry
      // with the same signature arrives and finds existingCount=1, seenSoFar
      // is already 1 so seenSoFar+1=2 > 1 and it is not incorrectly skipped.
      const sigKey = `xfer|${qifTx.date}|${cashAmount}|${transferAccountId}`;
      const seenSoFar = ctx.transferDupCounts.get(sigKey) || 0;
      ctx.transferDupCounts.set(sigKey, seenSoFar + 1);
      if (existingCount > 0 && seenSoFar + 1 <= existingCount) {
        ctx.importResult.skipped++;
        return;
      }
    }

    const cashTx = ctx.queryRunner.manager.create(Transaction, {
      userId: ctx.userId,
      accountId: cashAccountId,
      transactionDate: qifTx.date,
      amount: cashAmount,
      payeeName: qifTx.payee || null,
      description: qifTx.memo || null,
      status,
      currencyCode: cashCurrencyCode,
      isTransfer: !!transferAccountId,
    });
    const savedCashTx = await ctx.queryRunner.manager.save(cashTx);
    ctx.createdTransactionIds.push(savedCashTx.id);
    await updateAccountBalance(ctx.queryRunner, cashAccountId, cashAmount);

    if (transferAccountId) {
      ctx.affectedAccountIds.add(transferAccountId);
      const linkedAmount = -cashAmount;
      const targetAccount = await ctx.queryRunner.manager.findOne(Account, {
        where: { id: transferAccountId },
      });

      const linkedTx = ctx.queryRunner.manager.create(Transaction, {
        userId: ctx.userId,
        accountId: transferAccountId,
        transactionDate: qifTx.date,
        amount: linkedAmount,
        payeeName: qifTx.payee || `Transfer from ${ctx.account.name}`,
        description: qifTx.memo || null,
        status,
        currencyCode: targetAccount?.currencyCode || cashCurrencyCode,
        isTransfer: true,
        linkedTransactionId: savedCashTx.id,
      });
      const savedLinkedTx = await ctx.queryRunner.manager.save(linkedTx);
      ctx.createdTransactionIds.push(savedLinkedTx.id);

      await ctx.queryRunner.manager.update(Transaction, savedCashTx.id, {
        linkedTransactionId: savedLinkedTx.id,
      });
      await updateAccountBalance(
        ctx.queryRunner,
        transferAccountId,
        linkedAmount,
      );
    }

    ctx.importResult.imported++;
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

    const isCrossAccountTransfer = cashAccountId !== ctx.accountId;

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
    cashTx.isTransfer = isCrossAccountTransfer;

    const savedCashTx = await ctx.queryRunner.manager.save(cashTx);
    ctx.createdTransactionIds.push(savedCashTx.id);

    // Create linked transaction on the brokerage side so the target account
    // is visible from both sides of the transfer
    if (isCrossAccountTransfer) {
      const brokerageTx = new Transaction();
      brokerageTx.userId = ctx.userId;
      brokerageTx.accountId = ctx.accountId;
      brokerageTx.transactionDate = investmentTx.transactionDate;
      brokerageTx.amount = -cashAmount;
      brokerageTx.currencyCode = ctx.account.currencyCode;
      brokerageTx.exchangeRate = 1;
      brokerageTx.payeeName = payeeName;
      brokerageTx.payeeId = null;
      brokerageTx.description = investmentTx.description;
      brokerageTx.status = TransactionStatus.CLEARED;
      brokerageTx.isTransfer = true;
      brokerageTx.linkedTransactionId = savedCashTx.id;

      const savedBrokerageTx = await ctx.queryRunner.manager.save(brokerageTx);
      ctx.createdTransactionIds.push(savedBrokerageTx.id);

      savedCashTx.linkedTransactionId = savedBrokerageTx.id;
      await ctx.queryRunner.manager.save(savedCashTx);

      investmentTx.transactionId = savedBrokerageTx.id;
    } else {
      investmentTx.transactionId = savedCashTx.id;
    }

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

  /**
   * Check whether the security is on an LSE-family exchange with GBP currency,
   * meaning QIF prices are in pence and need conversion to pounds.
   */
  private async shouldConvertGbx(
    ctx: ImportContext,
    securityId: string | null,
  ): Promise<boolean> {
    if (!securityId) return false;
    const security = await ctx.queryRunner.manager.findOne(Security, {
      where: { id: securityId },
    });
    if (!security) return false;
    return isGbxExchange(security.exchange) && security.currencyCode === "GBP";
  }
}
