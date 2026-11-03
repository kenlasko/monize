import { EntityManager } from "typeorm";
import { Account, AccountType } from "../accounts/entities/account.entity";
import { roundMoney } from "../common/round.util";
import { LoanFee } from "../loan-fees/entities/loan-fee.entity";
import { ScheduledTransactionSplit } from "../scheduled-transactions/entities/scheduled-transaction-split.entity";
import { LoanFeeTerms, loanFeeFactsFor, priceLoanFees } from "./loan-fees";

/**
 * A mortgage's fee lines on its payment template
 * (`docs/specs/mortgage-fees.md` sections 4 and 5, INV-LOAN-011): how the
 * loan pricing reads the configured fees and prices the lines that carry
 * them. `identifyLoanTemplate` decides which lines are fee lines; this file
 * prices them.
 */

/** A template line that is a configured mortgage fee's. */
export interface LoanFeeLine {
  readonly split: ScheduledTransactionSplit;
  readonly fee: LoanFeeTerms;
}

/** A fee line priced for one installment: the unsigned amount it carries. */
export interface PricedFeeLine {
  readonly split: ScheduledTransactionSplit;
  readonly fee: LoanFeeTerms;
  readonly amount: number;
}

/**
 * A mortgage's configured fees, in display order (spec section 2). Only a
 * mortgage carries fees, so no other account type reads the table.
 */
export async function readLoanFees(
  m: EntityManager,
  loanAccount: Pick<Account, "id" | "accountType">,
): Promise<LoanFeeTerms[]> {
  if (loanAccount.accountType !== AccountType.MORTGAGE) return [];
  return m.getRepository(LoanFee).find({
    where: { accountId: loanAccount.id },
    order: { sortOrder: "ASC", createdAt: "ASC" },
  });
}

export type PricedFeeLines =
  | {
      kind: "ok";
      lines: PricedFeeLine[];
      /** The sum of the priced lines. */
      total: number;
      /** The sum of the lines as the template stores them. */
      templateTotal: number;
    }
  | { kind: "unknown"; reason: string };

/**
 * Price a template's fee lines for one installment: from each fee's terms at
 * `debt` when `reprice` (`priceLoanFees`), else at the amounts the template
 * stores. Sums on scaled integers, never by accumulating floats.
 */
export function priceFeeLines(
  feeLines: readonly LoanFeeLine[],
  input: {
    debt: number;
    loanAccount: Pick<
      Account,
      "currencyCode" | "originalPrincipal" | "openingBalance"
    >;
    frequency: string;
    reprice: boolean;
  },
): PricedFeeLines {
  const stored = feeLines.map((line) =>
    roundMoney(Math.abs(Number(line.split.amount))),
  );
  const templateTotal =
    stored.reduce((units, amount) => units + Math.round(amount * 10_000), 0) /
    10_000;
  if (!input.reprice) {
    return {
      kind: "ok",
      lines: feeLines.map((line, i) => ({ ...line, amount: stored[i] })),
      total: templateTotal,
      templateTotal,
    };
  }
  const priced = priceLoanFees(
    feeLines.map((line) => line.fee),
    loanFeeFactsFor(input.loanAccount, input.debt, input.frequency),
  );
  if (priced.kind === "unknown") return priced;
  return {
    kind: "ok",
    lines: feeLines.map((line, i) => ({ ...line, amount: priced.amounts[i] })),
    total: priced.total,
    templateTotal,
  };
}
