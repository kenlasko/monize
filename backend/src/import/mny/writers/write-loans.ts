import { EntityManager } from "typeorm";
import {
  Account,
  AccountType,
} from "../../../accounts/entities/account.entity";
import {
  mortgageTypeOf,
  storesConstantPayment,
} from "../../../accounts/mortgage-type.util";
import { LoanRateChange } from "../../../loan-rate-changes/entities/loan-rate-change.entity";
import { MappedLoanRate, MappedLoanTerms } from "../model/mny-import-model";

/**
 * Applies the loan terms the mapper inferred, without overwriting anything the
 * account already carries.
 *
 * Two rules make this safe to run on a second import into a populated profile.
 * A null field on the mapped terms means "the evidence did not settle this",
 * so it is not written at all; and a field the account already has a value for
 * is left alone, because a user who set their loan's interest category by hand
 * outranks an inference from payment shape.
 *
 * Runs after transactions and categories exist, since the terms reference both.
 *
 * A KMyMoney loan also states its rates, original amount and term (spec
 * kmymoney-import 5.11). The earliest rate is the account's `interestRate`;
 * with more than one, each becomes a `loan_rate_changes` row, written only
 * when this import fills the rate and the loan has no timeline of its own.
 */

export interface WriteLoansInput {
  readonly loans: readonly MappedLoanTerms[];
  readonly accountIdByKey: ReadonlyMap<string, string>;
  readonly categoryIdByHandle: ReadonlyMap<number, string>;
}

export interface WrittenLoans {
  /** Loan accounts that received at least one inferred term. */
  readonly updated: number;
}

export async function writeLoans(
  manager: EntityManager,
  userId: string,
  input: WriteLoansInput,
): Promise<WrittenLoans> {
  if (input.loans.length === 0) {
    return { updated: 0 };
  }

  const repo = manager.getRepository(Account);
  let updated = 0;

  for (const loan of input.loans) {
    const id = input.accountIdByKey.get(loan.accountKey);
    if (!id) {
      continue;
    }

    const account = await repo.findOne({
      where: { id, userId },
      select: [
        "id",
        "interestCategoryId",
        "interestBookingMode",
        "sourceAccountId",
        "paymentAmount",
        "paymentFrequency",
        "paymentStartDate",
        "accountType",
        "mortgageType",
        "interestRate",
        "originalPrincipal",
        "amortizationMonths",
      ],
    });
    if (!account) {
      continue;
    }

    const patch: Partial<Account> = {};

    const interestCategoryId =
      loan.interestCategoryHandle === null
        ? undefined
        : input.categoryIdByHandle.get(loan.interestCategoryHandle);
    if (interestCategoryId && !account.interestCategoryId) {
      patch.interestCategoryId = interestCategoryId;
    }

    // AUTO is the column's default, so an account still on it has never been
    // configured and the inference is an improvement rather than an override.
    if (
      loan.interestBookingMode !== null &&
      account.interestBookingMode === "AUTO"
    ) {
      patch.interestBookingMode = loan.interestBookingMode;
    }

    const sourceAccountId =
      loan.sourceAccountKey === null
        ? undefined
        : input.accountIdByKey.get(loan.sourceAccountKey);
    if (sourceAccountId && !account.sourceAccountId) {
      patch.sourceAccountId = sourceAccountId;
    }

    // A LINEAR or INTEREST_ONLY mortgage has no constant payment: its null is
    // the method's answer, not a gap to fill, and the column's CHECK refuses
    // one (docs/specs/mortgage-types.md, decision 11). A re-import into a
    // profile where the user switched an imported mortgage to one of them
    // leaves the column alone.
    const storesPayment =
      account.accountType !== AccountType.MORTGAGE ||
      storesConstantPayment(mortgageTypeOf(account));
    if (
      storesPayment &&
      loan.paymentAmount !== null &&
      account.paymentAmount === null
    ) {
      patch.paymentAmount = loan.paymentAmount;
    }
    if (loan.paymentFrequency !== null && account.paymentFrequency === null) {
      patch.paymentFrequency = loan.paymentFrequency;
    }
    if (loan.paymentStartDate !== null && account.paymentStartDate === null) {
      patch.paymentStartDate = loan.paymentStartDate as unknown as Date;
    }

    const rates = loan.rates ?? [];
    const fillsRate = rates.length > 0 && account.interestRate === null;
    if (fillsRate) {
      patch.interestRate = rates[0].annualRate;
    }
    if (
      loan.originalPrincipal != null &&
      loan.originalPrincipal > 0 &&
      account.originalPrincipal === null
    ) {
      patch.originalPrincipal = loan.originalPrincipal;
    }
    if (
      loan.amortizationMonths != null &&
      loan.amortizationMonths > 0 &&
      account.amortizationMonths === null
    ) {
      patch.amortizationMonths = loan.amortizationMonths;
    }

    if (Object.keys(patch).length === 0) {
      continue;
    }

    await repo.update({ id, userId }, patch);
    if (fillsRate && rates.length > 1) {
      await writeRateTimeline(manager, userId, id, rates);
    }
    updated += 1;
  }

  return { updated };
}

/**
 * The stated rates as the loan's timeline: the first an `initial` row, the
 * rest `manual` (the user's own records, which detection keeps), none of
 * them stating a payment -- the file records one payment, not one per rate,
 * so the installment keeps reading `accounts.payment_amount` (INV-LOAN-009).
 * A loan that already has a timeline keeps it.
 */
async function writeRateTimeline(
  manager: EntityManager,
  userId: string,
  accountId: string,
  rates: readonly MappedLoanRate[],
): Promise<void> {
  const repo = manager.getRepository(LoanRateChange);
  const existing = await repo.count({ where: { accountId } });
  if (existing > 0) {
    return;
  }
  for (const [index, rate] of rates.entries()) {
    await repo.save(
      repo.create({
        userId,
        accountId,
        effectiveDate: rate.effectiveDate,
        annualRate: rate.annualRate,
        newPaymentAmount: null,
        source: index === 0 ? "initial" : "manual",
        note: null,
      }),
    );
  }
}
