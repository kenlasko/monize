import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { DataSource, EntityManager } from "typeorm";
import { Account, AccountType } from "../accounts/entities/account.entity";
import { datedLoanDebt } from "../accounts/dated-loan-debt.util";
import {
  DEFAULT_PERIODS_PER_YEAR,
  periodsPerYearForStoredFrequency,
} from "../accounts/payment-frequency.util";
import { currencyMinorUnitDecimals } from "../common/currency-minor-unit.util";
import { withScopedDb } from "../common/db/scoped-db";
import { ensureYMD } from "../common/recurrence";
import { roundMoney } from "../common/round.util";
import { tr } from "../i18n/translate";
import {
  LoanFeeTerms,
  originalPrincipalOf,
} from "../loan-installments/loan-fees";
import { ScheduledTransactionSplit } from "../scheduled-transactions/entities/scheduled-transaction-split.entity";
import { ScheduledTransaction } from "../scheduled-transactions/entities/scheduled-transaction.entity";
import { SplitKind } from "../transactions/entities/split-kind.enum";
import { LoanFeeDto } from "./dto/loan-fee.dto";
import { LoanFee } from "./entities/loan-fee.entity";
import {
  assertLoanFeeCategories,
  normalizeLoanFees,
  priceFeeTemplateLines,
} from "./loan-fee-terms";

/** A fee as the API answers it. */
export interface LoanFeeView {
  id: string;
  categoryId: string;
  name: string;
  calculation: LoanFee["calculation"];
  basis: LoanFee["basis"];
  amount: number | null;
  rate: number | null;
  sortOrder: number;
}

/**
 * A mortgage's fees (`docs/specs/mortgage-fees.md` section 7): read, and
 * replace with the payment template kept in step, in one transaction. The
 * pricing of the lines afterwards is the loan core's (INV-LOAN-011).
 */
@Injectable()
export class LoanFeesService {
  private readonly logger = new Logger(LoanFeesService.name);

  constructor(private readonly dataSource: DataSource) {}

  async list(userId: string, accountId: string): Promise<LoanFeeView[]> {
    return withScopedDb(this.dataSource, async (m) => {
      const account = await m
        .getRepository(Account)
        .findOne({ where: { id: accountId, userId } });
      if (!account) throw notFound();
      return (await this.readFees(m, accountId)).map(toView);
    });
  }

  /**
   * Replace the mortgage's fee set and sync its payment template: a removed
   * fee's line is deleted, a new fee gets a line (adopting the one existing
   * line on its category, refusing when there are several), and every fee
   * line is priced at the template's `next_due_date`. The parent moves by
   * exactly the change in fee lines, so the template stays equal to the sum
   * of its lines whatever the rest of it holds. Locks the account row, then
   * the schedule row; every refusal runs before the first write.
   */
  async replace(
    userId: string,
    accountId: string,
    dtos: readonly LoanFeeDto[],
  ): Promise<LoanFeeView[]> {
    return withScopedDb(this.dataSource, async (m) => {
      const account = await m.getRepository(Account).findOne({
        where: { id: accountId, userId },
        lock: { mode: "pessimistic_write" },
      });
      if (!account) throw notFound();
      if (account.accountType !== AccountType.MORTGAGE) {
        throw new BadRequestException(
          tr(
            "errors.loanFees.mortgageOnly",
            "Only mortgage accounts can have fees.",
          ),
        );
      }
      const fees = normalizeLoanFees(dtos);
      await assertLoanFeeCategories(
        m,
        userId,
        fees,
        account.interestCategoryId,
      );
      const previous = await this.readFees(m, accountId);

      await this.syncTemplate(m, userId, account, previous, fees);

      const repo = m.getRepository(LoanFee);
      await repo.delete({ accountId });
      if (fees.length > 0) {
        await repo.save(
          fees.map((fee, index) =>
            repo.create({
              ...fee,
              amount: fee.amount === null ? null : Number(fee.amount),
              rate: fee.rate === null ? null : Number(fee.rate),
              userId,
              accountId,
              sortOrder: index,
            }),
          ),
        );
      }
      return (await this.readFees(m, accountId)).map(toView);
    });
  }

  private readFees(m: EntityManager, accountId: string): Promise<LoanFee[]> {
    return m.getRepository(LoanFee).find({
      where: { accountId },
      order: { sortOrder: "ASC", createdAt: "ASC" },
    });
  }

  /**
   * The template half of `replace`. Plans every line first and refuses an
   * ambiguous one before writing any of them.
   */
  private async syncTemplate(
    m: EntityManager,
    userId: string,
    account: Account,
    previous: readonly LoanFeeTerms[],
    next: readonly LoanFeeTerms[],
  ): Promise<void> {
    if (!account.scheduledTransactionId) return;
    const schedule = await m.getRepository(ScheduledTransaction).findOne({
      where: { id: account.scheduledTransactionId, userId },
      lock: { mode: "pessimistic_write" },
    });
    if (!schedule) return;
    const splits = await m
      .getRepository(ScheduledTransactionSplit)
      .find({ where: { scheduledTransactionId: schedule.id } });

    // A fee's line is a category line with no transfer on the fee's
    // category, never the interest line (spec section 4).
    const linesOn = (categoryId: string) =>
      splits.filter(
        (s) =>
          s.categoryId === categoryId &&
          !s.transferAccountId &&
          s.categoryId !== account.interestCategoryId,
      );
    const nextCategories = new Set(next.map((fee) => fee.categoryId));
    const removed = previous
      .filter((fee) => !nextCategories.has(fee.categoryId))
      .map((fee) => linesOn(fee.categoryId)[0])
      .filter((s): s is ScheduledTransactionSplit => s !== undefined);
    const adopted = next.map((fee) => {
      const lines = linesOn(fee.categoryId);
      if (lines.length > 1) {
        throw new BadRequestException(
          tr(
            "errors.loanFees.ambiguousLine",
            `The scheduled payment already has several lines in the category of the fee "${fee.name}". Remove the extra lines from the scheduled payment first.`,
            { name: fee.name },
          ),
        );
      }
      return lines[0] ?? null;
    });
    if (next.length === 0 && removed.length === 0) return;

    const dueDate = ensureYMD(schedule.nextDueDate);
    const debt = await datedLoanDebt(m, account, dueDate);
    if (debt === null) {
      throw new ServiceUnavailableException(
        tr(
          "errors.accounts.loanLedgerUnreadable",
          "This loan's balance could not be read. Try again.",
        ),
      );
    }
    const priced = priceFeeTemplateLines(next, {
      debt,
      originalPrincipal: originalPrincipalOf(account),
      periodsPerYear:
        periodsPerYearForStoredFrequency(
          account.paymentFrequency || schedule.frequency,
        ) ?? DEFAULT_PERIODS_PER_YEAR,
      decimals: currencyMinorUnitDecimals(account.currencyCode),
    });

    // The parent moves by what the fee lines move: every line this write
    // replaces or removes leaves, every priced line arrives.
    const units = (value: number) => Math.round(value * 10000);
    let deltaUnits = 0;
    for (const line of [...removed, ...adopted]) {
      if (line) deltaUnits -= units(Math.abs(Number(line.amount)));
    }
    deltaUnits += units(priced.total);

    const splitRepo = m.getRepository(ScheduledTransactionSplit);
    for (const line of removed) {
      await splitRepo.delete({ id: line.id });
    }
    for (const [index, line] of priced.lines.entries()) {
      const existing = adopted[index];
      if (existing) {
        await splitRepo.update(
          { id: existing.id },
          { amount: -line.amount, memo: line.memo },
        );
      } else {
        await splitRepo.save(
          splitRepo.create({
            scheduledTransactionId: schedule.id,
            kind: SplitKind.CATEGORY,
            categoryId: line.categoryId,
            transferAccountId: null,
            amount: -line.amount,
            memo: line.memo,
          }),
        );
      }
    }
    if (deltaUnits !== 0) {
      const parent = roundMoney(
        (units(Number(schedule.amount)) - deltaUnits) / 10000,
      );
      await m
        .getRepository(ScheduledTransaction)
        .update({ id: schedule.id }, { amount: parent });
    }
    this.logger.log(
      `Synced ${next.length} fee line(s) on scheduled transaction ${schedule.id} for mortgage ${account.id}; removed ${removed.length}`,
    );
  }
}

function notFound(): NotFoundException {
  return new NotFoundException(
    tr("errors.accounts.notFound", "Account not found"),
  );
}

function toView(fee: LoanFee): LoanFeeView {
  return {
    id: fee.id,
    categoryId: fee.categoryId,
    name: fee.name,
    calculation: fee.calculation,
    basis: fee.basis,
    amount: fee.amount === null ? null : Number(fee.amount),
    rate: fee.rate === null ? null : Number(fee.rate),
    sortOrder: fee.sortOrder,
  };
}
