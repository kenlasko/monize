import {
  BadRequestException,
  ConflictException,
  HttpException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  forwardRef,
} from "@nestjs/common";
import { DataSource } from "typeorm";
import { withScopedDb } from "../common/db/scoped-db";
import { tr } from "../i18n/translate";
import { ScheduledTransaction } from "../scheduled-transactions/entities/scheduled-transaction.entity";
import { TransactionRulesService } from "../transaction-rules/transaction-rules.service";
import {
  CreateTransactionRuleDto,
  MAX_RULE_NAME_LENGTH,
} from "../transaction-rules/dto/create-transaction-rule.dto";
import { TransactionRuleResponseDto } from "../transaction-rules/dto/transaction-rule-response.dto";
import {
  SETTLE_LOAN_INSTALLMENT,
  SETTLE_LOAN_INSTALLMENT_DEFAULTS,
} from "../transaction-rules/rule-action.types";
import { RuleConditionLeaf } from "../transaction-rules/rule-condition.types";
import { Account, AccountType } from "./entities/account.entity";
import { readLoanFees } from "../loan-installments/loan-fee-lines";
import {
  LoanSettlementResponseDto,
  PaymentMatchingDto,
  PaymentMatchingFailureDto,
} from "./dto/payment-matching.dto";

/** The newest settled installments `listSettlements` returns. */
export const MAX_LOAN_SETTLEMENTS_LISTED = 200;

/** The `type` leaf value of a bank debit (`RULE_TRANSACTION_TYPES`). */
const EXPENSE_ROW_TYPE = "EXPENSE";

/** Stands in for the loan's id while a definition is checked before the loan exists. */
const PLACEHOLDER_LOAN_ID = "00000000-0000-0000-0000-000000000000";

/** The `errorCode` reported for a failure that carried none of its own. */
export const PAYMENT_MATCHING_FAILED = "PAYMENT_MATCHING_FAILED";

/** The loans payment matching applies to (spec decision 4). */
const SETTLEABLE_LOAN_TYPES: readonly AccountType[] = [
  AccountType.MORTGAGE,
  AccountType.LOAN,
];

/** What the create and setup flows report: the rule, or why there is none. */
export type PaymentMatchingOutcome =
  | { ruleId: string; error: null }
  | { ruleId: null; error: PaymentMatchingFailureDto };

interface SettlementRow {
  claim_id: string;
  due_date: string;
  posted_date: string;
  transaction_id: string;
  transaction_status: string;
  rule_id: string | null;
  pricing: Record<string, unknown> | null;
}

/**
 * The "Payment matching" rule of a loan (`docs/specs/loan-installment-settlement.md`
 * decision 5): a `settle_loan_installment` rule over the bank debits of the
 * loan's scheduled payment's source account, created through
 * `TransactionRulesService.create` (appended at the end of the user's order,
 * its references checked in this write's transaction), with the loan's
 * `payment_matching_rule_id` pointed at it and the bill's `auto_post` turned
 * off, so the bank row, not the bill, pays each installment. Also the read of
 * the installments such rules settled (the `rule` claims).
 */
@Injectable()
export class LoanPaymentMatchingService {
  private readonly logger = new Logger(LoanPaymentMatchingService.name);

  constructor(
    private readonly dataSource: DataSource,
    @Inject(forwardRef(() => TransactionRulesService))
    private readonly transactionRulesService: TransactionRulesService,
  ) {}

  /**
   * Refuse a request whose patterns the rule create would refuse, before the
   * caller writes the account or the schedule: the same shape check and 400
   * as the create, over the rule this request would build.
   */
  assertDefinable(sourceAccountId: string, dto: PaymentMatchingDto): void {
    const rule = paymentMatchingRule(
      { id: PLACEHOLDER_LOAN_ID, name: "", accountType: AccountType.MORTGAGE },
      sourceAccountId,
      dto,
    );
    this.transactionRulesService.assertDefinitionShape(
      rule.condition,
      rule.actions,
    );
  }

  /**
   * Create the loan's payment-matching rule, point the loan at it and turn
   * the bill's auto-post off, in one transaction: a refusal writes none of
   * the three. Every check runs inside it, after the schedule row lock and
   * then the account's (the order a settlement takes them, spec section 13),
   * so two requests for one loan cannot both see no rule. The source account
   * is the schedule's own account, the one the bank debits land in.
   */
  async createMatchingRule(
    userId: string,
    loanAccountId: string,
    dto: PaymentMatchingDto,
  ): Promise<TransactionRuleResponseDto> {
    return withScopedDb(this.dataSource, async (m) => {
      const accounts = m.getRepository(Account);
      const schedules = m.getRepository(ScheduledTransaction);
      const pointer = await accounts.findOne({
        where: { id: loanAccountId, userId },
      });
      if (!pointer) throw accountNotFound();
      if (!SETTLEABLE_LOAN_TYPES.includes(pointer.accountType)) {
        throw new BadRequestException(
          tr(
            "errors.accounts.paymentMatchingLoanOnly",
            "Payment matching applies to mortgages and loans only",
          ),
        );
      }
      const schedule = pointer.scheduledTransactionId
        ? await schedules.findOne({
            where: { id: pointer.scheduledTransactionId, userId },
            lock: { mode: "pessimistic_write" },
          })
        : null;
      const account = schedule
        ? await accounts.findOne({
            where: { id: loanAccountId, userId },
            lock: { mode: "pessimistic_write" },
          })
        : null;
      if (
        !schedule ||
        !account ||
        account.scheduledTransactionId !== schedule.id
      ) {
        throw new BadRequestException(
          tr(
            "errors.accounts.paymentMatchingRequiresSchedule",
            "Payment matching needs the loan's scheduled payment. Set up its payments first.",
          ),
        );
      }
      // The settlement does not price mortgage fee lines yet
      // (docs/specs/mortgage-fees.md section 8): a rule on a fee-carrying
      // bill would refuse every bank debit while turning auto-post off.
      if ((await readLoanFees(m, account)).length > 0) {
        throw new BadRequestException(
          tr(
            "errors.loanFees.paymentMatchingUnsupported",
            "Payment matching cannot settle a mortgage payment that includes fees yet. Turn off payment matching or remove the fees.",
          ),
        );
      }
      if (account.paymentMatchingRuleId) {
        throw new ConflictException({
          message: tr(
            "errors.accounts.paymentMatchingRuleExists",
            "This loan already has a payment matching rule",
          ),
          errorCode: "PAYMENT_MATCHING_RULE_EXISTS",
          ruleId: account.paymentMatchingRuleId,
        });
      }

      const rule = await this.transactionRulesService.create(
        userId,
        paymentMatchingRule(account, schedule.accountId, dto),
      );
      await accounts.update(
        { id: account.id, userId },
        { paymentMatchingRuleId: rule.id },
      );
      await schedules.update({ id: schedule.id, userId }, { autoPost: false });
      return rule;
    });
  }

  /**
   * `createMatchingRule` for a flow that has already committed the loan and
   * its schedule (the mortgage create, the loan-payment setup, several
   * commits by design, spec section 15 item 6): a refusal is returned for the
   * caller to report beside the saved account, never thrown, so the account
   * and schedule stay and the person can create the rule from Loan Details.
   */
  async createMatchingRuleReported(
    userId: string,
    loanAccountId: string,
    dto: PaymentMatchingDto,
  ): Promise<PaymentMatchingOutcome> {
    try {
      const rule = await this.createMatchingRule(userId, loanAccountId, dto);
      return { ruleId: rule.id, error: null };
    } catch (error) {
      const failure = paymentMatchingFailure(error);
      this.logger.warn(
        `Payment matching rule not created for loan ${loanAccountId}: ${failure.errorCode}`,
      );
      return { ruleId: null, error: failure };
    }
  }

  /**
   * The installments payment-matching rules settled on this loan: the `rule`
   * claims on the loan's scheduled payment, with the settled row, newest
   * occurrence first, at most `MAX_LOAN_SETTLEMENTS_LISTED`. Owner-scoped
   * through the account and the schedule: another user's loan is a 404.
   */
  async listSettlements(
    userId: string,
    loanAccountId: string,
  ): Promise<LoanSettlementResponseDto[]> {
    return withScopedDb(this.dataSource, async (m) => {
      const account = await m.getRepository(Account).findOne({
        where: { id: loanAccountId, userId },
      });
      if (!account) throw accountNotFound();
      const rows: SettlementRow[] = await m.query(
        `SELECT stp.id AS claim_id,
                TO_CHAR(stp.original_due_date, 'YYYY-MM-DD') AS due_date,
                TO_CHAR(stp.posted_date, 'YYYY-MM-DD') AS posted_date,
                stp.transaction_id,
                t.status AS transaction_status,
                stp.rule_id,
                stp.pricing
           FROM scheduled_transaction_postings stp
           JOIN scheduled_transactions st
             ON st.id = stp.scheduled_transaction_id AND st.user_id = $2
           JOIN accounts a
             ON a.scheduled_transaction_id = st.id
            AND a.id = $1 AND a.user_id = $2
           JOIN transactions t
             ON t.id = stp.transaction_id AND t.user_id = $2
          WHERE stp.source = 'rule'
          ORDER BY stp.original_due_date DESC, stp.created_at DESC
          LIMIT $3`,
        [loanAccountId, userId, MAX_LOAN_SETTLEMENTS_LISTED],
      );
      return rows.map(toSettlementResponse);
    });
  }
}

/**
 * The rule the "Payment matching" section creates (spec decision 5): the
 * loan's source account, a debit, the payee glob and the optional description
 * glob; the settlement action with the window default and the two policies;
 * triggers `create` and `import`; `stopProcessing`, so no later rule
 * restructures a settled row.
 */
export function paymentMatchingRule(
  loan: Pick<Account, "id" | "name" | "accountType">,
  sourceAccountId: string,
  dto: PaymentMatchingDto,
): CreateTransactionRuleDto {
  const leaves: RuleConditionLeaf[] = [
    { field: "accountId", op: "eq", value: sourceAccountId },
    { field: "type", op: "eq", value: EXPENSE_ROW_TYPE },
    { field: "payeeText", op: "matches", value: dto.payeePattern },
  ];
  if (dto.descriptionPattern) {
    leaves.push({
      field: "description",
      op: "matches",
      value: dto.descriptionPattern,
    });
  }
  const label =
    loan.accountType === AccountType.LOAN ? "Loan payment" : "Mortgage payment";
  return {
    name: `${label} - ${loan.name}`
      .replace(/[<>]/g, "")
      .trim()
      .slice(0, MAX_RULE_NAME_LENGTH),
    enabled: true,
    triggers: ["create", "import"],
    stopProcessing: true,
    condition: { all: leaves },
    actions: [
      {
        type: SETTLE_LOAN_INSTALLMENT,
        loanAccountId: loan.id,
        dueDateWindow: { ...SETTLE_LOAN_INSTALLMENT_DEFAULTS.dueDateWindow },
        excess: dto.excess ?? SETTLE_LOAN_INSTALLMENT_DEFAULTS.excess,
        shortfall: dto.shortfall ?? SETTLE_LOAN_INSTALLMENT_DEFAULTS.shortfall,
      },
    ],
  };
}

function accountNotFound(): NotFoundException {
  return new NotFoundException(
    tr("errors.accounts.notFound", "Account not found"),
  );
}

/** The refusal's own `errorCode` and message, else the generic failure. */
function paymentMatchingFailure(error: unknown): PaymentMatchingFailureDto {
  if (error instanceof HttpException) {
    const body = error.getResponse();
    const record =
      typeof body === "object" && body !== null
        ? (body as Record<string, unknown>)
        : {};
    return {
      errorCode:
        typeof record.errorCode === "string"
          ? record.errorCode
          : PAYMENT_MATCHING_FAILED,
      message:
        typeof record.message === "string" ? record.message : error.message,
    };
  }
  return {
    errorCode: PAYMENT_MATCHING_FAILED,
    message: tr(
      "errors.accounts.paymentMatchingFailed",
      "The loan was saved, but its payment matching rule could not be created. Create it from the loan's details.",
    ),
  };
}

/** A pricing figure the claim stored as a fixed-decimal string, as a number. */
function pricingNumber(
  pricing: Record<string, unknown> | null,
  read: (p: Record<string, unknown>) => unknown,
): number | null {
  if (!pricing) return null;
  const value = read(pricing);
  if (typeof value !== "string" && typeof value !== "number") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function toSettlementResponse(row: SettlementRow): LoanSettlementResponseDto {
  const lines = (p: Record<string, unknown>) =>
    (p.lines ?? {}) as Record<string, unknown>;
  return {
    claimId: row.claim_id,
    dueDate: row.due_date,
    postedDate: row.posted_date,
    transactionId: row.transaction_id,
    transactionStatus: row.transaction_status,
    principal: pricingNumber(row.pricing, (p) => lines(p).principal),
    interest: pricingNumber(row.pricing, (p) => lines(p).interest),
    extraPrincipal: pricingNumber(row.pricing, (p) => lines(p).extra),
    debtBefore: pricingNumber(row.pricing, (p) => p.debtBefore),
    installmentNumber: pricingNumber(row.pricing, (p) => p.installmentNumber),
    ruleId: row.rule_id,
  };
}
