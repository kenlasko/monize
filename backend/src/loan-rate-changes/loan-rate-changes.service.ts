import {
  Injectable,
  Logger,
  NotFoundException,
  ConflictException,
  BadRequestException,
} from "@nestjs/common";
import { DataSource, EntityManager } from "typeorm";
import { tr } from "../i18n/translate";
import { withScopedDb } from "../common/db/scoped-db";
import { LoanRateChange } from "./entities/loan-rate-change.entity";
import { Account, AccountType } from "../accounts/entities/account.entity";
import { CreateLoanRateChangeDto } from "./dto/create-loan-rate-change.dto";
import { UpdateLoanRateChangeDto } from "./dto/update-loan-rate-change.dto";
import {
  MortgageType,
  mortgageTypeOf,
  storesConstantPayment,
} from "../accounts/mortgage-type.util";
import { datedAnnuityInstallment } from "../accounts/annuity-relevel.util";
import { formatDateYMDLocal } from "../common/date-utils";
import { ensureYMD } from "../common/recurrence";
import {
  applyLoanTemplateRewrite,
  LoanTemplateRewritePlan,
  planLoanTemplateRewrite,
} from "../loan-installments/reprice-template";
import {
  NextPaymentChange,
  nextPaymentChangeAfter,
} from "../loan-installments/next-payment-change";

const RATE_CHANGE_ACCOUNT_TYPES = [AccountType.LOAN, AccountType.MORTGAGE];

/**
 * A before/after summary of how a linked scheduled bill payment would change
 * to match the rate timeline at the template's own due date. Returned by
 * `create`, `update` and `remove`, which apply nothing, so the UI can ask the
 * user before `applyScheduledPaymentSync` writes it
 * (`docs/specs/scheduled-loan-installment-pricing.md` section 7.5).
 */
export interface ScheduledPaymentPreview {
  scheduledTransactionId: string;
  scheduledTransactionName: string | null;
  currencyCode: string;
  /** The installment the proposed figures are for: the template's `next_due_date`. */
  dueDate: string;
  /** Absolute total payment amounts (null when unknown from the schedule) */
  currentPaymentAmount: number | null;
  proposedPaymentAmount: number;
  /** Absolute principal/interest portions; current values are null when the
   * schedule's splits do not clearly separate them */
  currentPrincipal: number | null;
  proposedPrincipal: number;
  currentInterest: number | null;
  proposedInterest: number;
  /** The extra-principal line the rewritten template carries (0 when there is none) */
  extraPrincipal: number;
  /**
   * The first later due date from which the bill becomes a different stated
   * payment, and that payment; null when no row stating a payment is dated
   * after `dueDate`.
   */
  nextPaymentChange: NextPaymentChange | null;
}

/** The template rewrite the sync would apply, plus its user-facing preview. */
export interface ScheduledSyncPlan {
  rewrite: LoanTemplateRewritePlan;
  preview: ScheduledPaymentPreview;
}

/** A rate change plus the pending scheduled-payment change, if any. */
export type CreateLoanRateChangeResult = LoanRateChange & {
  scheduledPaymentPreview: ScheduledPaymentPreview | null;
};

/** The deleted change's pending scheduled-payment change, if any. */
export interface RemoveLoanRateChangeResult {
  scheduledPaymentPreview: ScheduledPaymentPreview | null;
}

/** Normalize a DATE column value (string at runtime, Date in tests) to YYYY-MM-DD */
export function toYmd(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  if (typeof value === "string") return value.split("T")[0];
  return formatDateYMDLocal(value);
}

function dayBefore(ymd: string): string {
  const [year, month, day] = ymd.split("-").map(Number);
  const date = new Date(year, month - 1, day - 1);
  return formatDateYMDLocal(date);
}

/**
 * The type of a mortgage whose method states every installment itself
 * (LINEAR, INTEREST_ONLY), or null for an annuity mortgage and any other
 * loan. A stated payment on a rate change of such a mortgage would be a second,
 * conflicting answer to "what is the installment" (spec section 5.3).
 */
export function derivedInstallmentType(account: Account): MortgageType | null {
  if (account.accountType !== AccountType.MORTGAGE) return null;
  const type = mortgageTypeOf(account);
  return storesConstantPayment(type) ? null : type;
}

/** Refuse a stated payment for a mortgage whose method derives it. */
export function refuseStatedPayment(
  account: Account,
  paymentAmount: number | null | undefined,
): void {
  const type = derivedInstallmentType(account);
  if (type !== null && paymentAmount != null) {
    throw new BadRequestException(
      tr(
        "errors.loanRateChanges.methodDerivesPayment",
        `A ${type} mortgage's installment is priced from its debt and rate on each due date, so a rate change cannot state a payment amount`,
        { type },
      ),
    );
  }
}

@Injectable()
export class LoanRateChangesService {
  private readonly logger = new Logger(LoanRateChangesService.name);

  constructor(private dataSource: DataSource) {}

  async findAll(userId: string, accountId: string): Promise<LoanRateChange[]> {
    await this.verifyLoanAccount(userId, accountId);
    return withScopedDb(this.dataSource, (m) =>
      m.getRepository(LoanRateChange).find({
        where: { userId, accountId },
        order: { effectiveDate: "ASC" },
      }),
    );
  }

  /**
   * Record a rate change. The account's own `interestRate`/`paymentAmount` are
   * left untouched (they are user-owned via the edit form), and so is the
   * linked scheduled bill: the result carries a preview of how the sync would
   * rewrite it at its own due date, and nothing is applied until the caller
   * confirms through `applyScheduledPaymentSync` (spec 7.5).
   */
  async create(
    userId: string,
    accountId: string,
    dto: CreateLoanRateChangeDto,
  ): Promise<CreateLoanRateChangeResult> {
    const account = await this.verifyLoanAccount(userId, accountId);

    refuseStatedPayment(account, dto.newPaymentAmount);
    if (dto.newPaymentAmount != null && dto.recalculatePayment) {
      throw new BadRequestException(
        tr(
          "errors.loanRateChanges.paymentModeConflict",
          "Provide either a new payment amount or recalculatePayment, not both",
        ),
      );
    }
    if (dto.recalculatePayment) {
      if (account.accountType !== AccountType.MORTGAGE) {
        throw new BadRequestException(
          tr(
            "errors.loanRateChanges.recalculateMortgageOnly",
            "Payment recalculation is only available for mortgage accounts",
          ),
        );
      }
      if (account.isClosed) {
        throw new BadRequestException(
          tr(
            "errors.accounts.updateRateClosed",
            "Cannot update rate on a closed account",
          ),
        );
      }
    }

    const saved = await withScopedDb(this.dataSource, async (m) => {
      await this.rejectDuplicateDate(m, accountId, dto.effectiveDate);
      // Read in the same transaction as the insert, so the payment recorded
      // is priced from the ledger the row is written against.
      const newPaymentAmount = dto.recalculatePayment
        ? await this.recalculatePaymentForRate(
            m,
            account,
            dto.annualRate,
            dto.effectiveDate,
          )
        : (dto.newPaymentAmount ?? null);
      await this.insertInitialRowIfFirst(m, account, dto.effectiveDate);

      const rateChange = m.create(LoanRateChange, {
        userId,
        accountId,
        effectiveDate: dto.effectiveDate,
        annualRate: dto.annualRate,
        newPaymentAmount,
        source: "manual" as const,
        note: dto.note ?? null,
      });

      return m.save(rateChange);
    });

    return {
      ...saved,
      scheduledPaymentPreview: await this.previewScheduledPayment(account),
    };
  }

  /**
   * Edit a rate change. Like `create`, it writes the row and returns the
   * preview of the sync; the bill is rewritten only once the user confirms
   * (spec 7.5: Scenario 2 of issue #1637 wrote a stated payment into every
   * earlier occurrence because the edit applied at once).
   */
  async update(
    userId: string,
    accountId: string,
    id: string,
    dto: UpdateLoanRateChangeDto,
  ): Promise<CreateLoanRateChangeResult> {
    const account = await this.verifyLoanAccount(userId, accountId);
    refuseStatedPayment(account, dto.newPaymentAmount);
    const rateChange = await this.findOne(userId, accountId, id);

    const saved = await withScopedDb(this.dataSource, async (m) => {
      if (
        dto.effectiveDate !== undefined &&
        dto.effectiveDate !== rateChange.effectiveDate
      ) {
        await this.rejectDuplicateDate(m, accountId, dto.effectiveDate);
      }

      const merged = m.merge(LoanRateChange, rateChange, {
        ...(dto.effectiveDate !== undefined
          ? { effectiveDate: dto.effectiveDate }
          : {}),
        ...(dto.annualRate !== undefined ? { annualRate: dto.annualRate } : {}),
        ...(dto.newPaymentAmount !== undefined
          ? { newPaymentAmount: dto.newPaymentAmount }
          : {}),
        ...(dto.note !== undefined ? { note: dto.note } : {}),
        // A user-edited inferred row becomes manual so re-running detection
        // never clobbers their correction.
        ...(rateChange.source === "inferred"
          ? { source: "manual" as const }
          : {}),
      });

      return m.save(merged);
    });

    return {
      ...saved,
      scheduledPaymentPreview: await this.previewScheduledPayment(account),
    };
  }

  /**
   * Delete a rate change and return the preview of the sync the remaining
   * timeline calls for (the `initial` row's payment when the only change
   * goes); the bill is rewritten only once the user confirms.
   */
  async remove(
    userId: string,
    accountId: string,
    id: string,
  ): Promise<RemoveLoanRateChangeResult> {
    const account = await this.verifyLoanAccount(userId, accountId);
    const rateChange = await this.findOne(userId, accountId, id);

    await withScopedDb(this.dataSource, (m) => m.remove(rateChange));

    return {
      scheduledPaymentPreview: await this.previewScheduledPayment(account),
    };
  }

  /**
   * The pending scheduled-payment change for an account, applied to nothing:
   * what `applyScheduledPaymentSync` would write. Null when the account has no
   * applicable linked bill, when its installment cannot be priced, or when
   * the read failed (logged).
   */
  async previewScheduledPayment(
    account: Account,
  ): Promise<ScheduledPaymentPreview | null> {
    try {
      const plan = await withScopedDb(this.dataSource, (m) =>
        this.buildScheduledUpdate(m, account),
      );
      return plan?.preview ?? null;
    } catch (error) {
      // The rate change itself is already committed; a preview that cannot
      // be read must not fail the request that recorded it (the tolerance
      // this flow has always had). The apply endpoint reads it again.
      this.logger.warn(
        `Could not preview the scheduled payment of loan account ${account.id}: ${error.message}`,
      );
      return null;
    }
  }

  /**
   * Apply the pending scheduled-payment change for an account after the user
   * has granted permission. Plans through the same function as the preview,
   * inside one transaction with the write, and writes what it returned
   * through `applyLoanTemplateRewrite`: the template's parent and its managed
   * lines, and nothing on the account (spec 7.5; `accounts.payment_amount`
   * stays the contractual payment, decision 5). Returns the applied change,
   * or null when there is nothing to sync.
   */
  async applyScheduledPaymentSync(
    userId: string,
    accountId: string,
  ): Promise<ScheduledPaymentPreview | null> {
    const account = await this.verifyLoanAccount(userId, accountId);
    return withScopedDb(this.dataSource, async (m) => {
      const plan = await this.buildScheduledUpdate(m, account);
      if (!plan) return null;
      await applyLoanTemplateRewrite(m, plan.rewrite);
      return plan.preview;
    });
  }

  /**
   * Price the linked scheduled bill at its own `next_due_date` through the
   * one installment pricing path (`planLoanTemplateRewrite`, purpose `sync`:
   * the debt, the rate and the annuity payment all dated there, INV-LOAN-006
   * and INV-LOAN-009) and describe the rewrite as a before/after preview.
   * Runs inside the caller's transaction, which locks the schedule row.
   *
   * A change dated after the template's due date does not move that
   * installment: the preview's `nextPaymentChange` names the first later due
   * date from which the bill becomes the stated payment (spec 7.5). Null
   * when the account is closed or has no linked bill, when the bill is not a
   * template this module manages, when its ledger cannot be read, or when
   * the debt is retired: the sync is an offer, and it offers nothing it
   * cannot price.
   */
  async buildScheduledUpdate(
    m: EntityManager,
    account: Account,
  ): Promise<ScheduledSyncPlan | null> {
    if (account.isClosed || !account.scheduledTransactionId) return null;

    const rewrite = await planLoanTemplateRewrite(
      m,
      account.scheduledTransactionId,
      "sync",
    );
    if (!rewrite) return null;
    const { scheduledTransaction: scheduled, installment } = rewrite;
    // The pointer is the account's own statement of which bill is its
    // payment; a bill that pays another loan, or another owner's bill, is not
    // this account's to rewrite.
    if (
      rewrite.loanAccount.id !== account.id ||
      scheduled.userId !== account.userId
    ) {
      this.logger.warn(
        `Scheduled transaction ${scheduled.id} is not the loan payment of account ${account.id}; not syncing it`,
      );
      return null;
    }
    if (installment.kind !== "ok") {
      if (installment.kind !== "paid-off") {
        this.logger.warn(
          `Not syncing scheduled transaction ${scheduled.id}: ${installment.reason}`,
        );
      }
      return null;
    }

    const dueDate = ensureYMD(scheduled.nextDueDate);
    const timeline = await m.getRepository(LoanRateChange).find({
      where: { accountId: account.id },
      order: { effectiveDate: "ASC" },
    });
    const { allocation, template } = installment;
    const preview: ScheduledPaymentPreview = {
      scheduledTransactionId: scheduled.id,
      scheduledTransactionName: scheduled.name ?? null,
      currencyCode: scheduled.currencyCode ?? account.currencyCode ?? "",
      dueDate,
      currentPaymentAmount: installment.templateAmount,
      proposedPaymentAmount: allocation.total,
      currentPrincipal: template.principalSplit
        ? Math.abs(Number(template.principalSplit.amount))
        : null,
      proposedPrincipal: allocation.principal,
      currentInterest: Math.abs(Number(template.interestSplit.amount)),
      proposedInterest: allocation.interest,
      extraPrincipal: allocation.extraPrincipal,
      // A derived installment (LINEAR, INTEREST_ONLY) states no payment on
      // its rows (`refuseStatedPayment`), so the search finds none.
      nextPaymentChange: nextPaymentChangeAfter(
        timeline,
        {
          startDate: scheduled.startDate,
          nextDueDate: scheduled.nextDueDate,
          frequency: scheduled.frequency,
          endDate: scheduled.endDate ?? null,
          occurrencesRemaining: scheduled.occurrencesRemaining ?? null,
        },
        dueDate,
        installment.extraPrincipalAmount,
        account.paymentAmount,
      ),
    };

    return { rewrite, preview };
  }

  /**
   * Snapshot the origination rate as an 'initial' row the first time any
   * change is recorded, so the timeline carries an explicit anchor for the
   * pre-change rate rather than relying on the account's current scalar.
   */
  async insertInitialRowIfFirst(
    manager: EntityManager,
    account: Account,
    firstChangeDate: string,
  ): Promise<void> {
    const count = await manager.count(LoanRateChange, {
      where: { accountId: account.id },
    });
    if (count > 0) return;
    if (account.interestRate == null) return;

    const startDate = toYmd(account.paymentStartDate);
    const effectiveDate =
      startDate && startDate < firstChangeDate
        ? startDate
        : dayBefore(firstChangeDate);

    const initial = manager.create(LoanRateChange, {
      userId: account.userId,
      accountId: account.id,
      effectiveDate,
      annualRate: Number(account.interestRate),
      newPaymentAmount:
        account.paymentAmount != null ? Number(account.paymentAmount) : null,
      source: "initial" as const,
      note: null,
    });
    await manager.save(initial);
  }

  /** Ownership and type gate applied before any rate-change operation */
  async verifyLoanAccount(userId: string, accountId: string): Promise<Account> {
    const account = await withScopedDb(this.dataSource, (m) =>
      m.getRepository(Account).findOne({
        where: { id: accountId, userId },
      }),
    );
    if (!account) {
      throw new NotFoundException(
        tr(
          "errors.accounts.accountWithIdNotFound",
          `Account with ID ${accountId} not found`,
          { id: accountId },
        ),
      );
    }
    if (!RATE_CHANGE_ACCOUNT_TYPES.includes(account.accountType)) {
      throw new BadRequestException(
        tr(
          "errors.loanRateChanges.notLoanAccount",
          "Rate changes are only available for loan and mortgage accounts",
        ),
      );
    }
    return account;
  }

  private async findOne(
    userId: string,
    accountId: string,
    id: string,
  ): Promise<LoanRateChange> {
    const rateChange = await withScopedDb(this.dataSource, (m) =>
      m.getRepository(LoanRateChange).findOne({
        where: { id, userId, accountId },
      }),
    );
    if (!rateChange) {
      throw new NotFoundException(
        tr(
          "errors.loanRateChanges.notFound",
          `Rate change with ID ${id} not found`,
          { id },
        ),
      );
    }
    return rateChange;
  }

  private async rejectDuplicateDate(
    manager: EntityManager,
    accountId: string,
    effectiveDate: string,
  ): Promise<void> {
    const existing = await manager.findOne(LoanRateChange, {
      where: { accountId, effectiveDate },
    });
    if (existing) {
      throw new ConflictException(
        tr(
          "errors.loanRateChanges.duplicateDate",
          `A rate change effective ${effectiveDate} already exists for this account`,
          { date: effectiveDate },
        ),
      );
    }
  }

  /**
   * Payment that holds the remaining amortization constant at the new rate
   * (the pre-history mortgage-rate endpoint's behaviour, now opt-in), priced
   * from the debt the new rate first applies to: the ledger through the
   * effective date (spec decision 5), so a payment already posted for a date
   * before a future-dated change is not still owed by it.
   */
  private async recalculatePaymentForRate(
    m: EntityManager,
    account: Account,
    annualRate: number,
    effectiveDate: string,
  ): Promise<number | null> {
    // A LINEAR or INTEREST_ONLY mortgage records no payment on a rate change:
    // the method prices every installment, and the template follows through
    // the confirmed sync (spec section 5.3).
    if (derivedInstallmentType(account) !== null) return null;
    return datedAnnuityInstallment(m, account, annualRate, effectiveDate);
  }
}
