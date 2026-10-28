import type { EntityManager } from "typeorm";
import type { Transaction } from "../transactions/entities/transaction.entity";
import {
  reportingAmount,
  reportingConversion,
  reportingCurrency,
  reportingRates,
} from "./reporting-money";
import { sumMoney } from "../common/round.util";

/** Read-only report copies. Native filters have already run; never save these. */
export async function convertReportTransactions(
  manager: EntityManager,
  userId: string,
  transactions: Transaction[],
  convertAmounts = true,
) {
  const currency = await reportingCurrency(manager, userId);
  if (!convertAmounts) return { currency, transactions };
  const rates = await reportingRates(manager, transactions, currency);
  return {
    currency,
    transactions: transactions.map((transaction) => {
      const cashProvenance = {
        readOnly: true as const,
        reportId: transaction.id,
        sourceTransactionId: transaction.id,
        cashDate: transaction.transactionDate,
        effectiveDate: transaction.transactionDate,
        sourceAmount: String(transaction.amount),
        nativeAmount: String(transaction.amount),
      };
      const provenance = transaction.reportingProvenance ?? cashProvenance;
      const splits = transaction.splits?.map((split) => ({
        ...split,
        amount: reportingAmount(split.amount, transaction, currency, rates),
        reportingProvenance: {
          ...(split.reportingProvenance ?? {
            ...cashProvenance,
            reportId: split.id,
            sourceSplitId: split.id,
            sourceAmount: String(split.amount),
            nativeAmount: String(split.amount),
          }),
          conversion: reportingConversion(
            split.amount,
            transaction,
            currency,
            rates,
          ),
        },
      }));
      return Object.assign(
        Object.create(Object.getPrototypeOf(transaction)) as Transaction,
        transaction,
        {
          reportingProvenance: {
            ...provenance,
            conversion: reportingConversion(
              transaction.amount,
              transaction,
              currency,
              rates,
            ),
          },
          sourceAmount: transaction.amount,
          sourceCurrencyCode: transaction.currencyCode,
          amount:
            transaction.isSplit && splits?.length
              ? sumMoney(splits.map((split) => Number(split.amount)))
              : reportingAmount(
                  transaction.amount,
                  transaction,
                  currency,
                  rates,
                ),
          currencyCode: currency,
          ...(splits ? { splits } : {}),
        },
      );
    }),
  };
}
