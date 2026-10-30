import { BadRequestException } from "@nestjs/common";
import { EntityManager, QueryDeepPartialEntity } from "typeorm";
import { lockTransactionRuleList } from "../common/db/locks";
import { tr } from "../i18n/translate";
import { ScheduledTransaction } from "../scheduled-transactions/entities/scheduled-transaction.entity";
import { SETTLE_LOAN_INSTALLMENT } from "../transaction-rules/rule-action.types";
import {
  RuleConditionLeaf,
  RuleConditionNode,
} from "../transaction-rules/rule-condition.types";
import { TransactionRule } from "../transaction-rules/transaction-rule.entity";
import { Account } from "./entities/account.entity";
import { assertLoanSourceCurrency } from "./loan-source-currency.util";

/**
 * Refuse a "Payment from Account" the loan cannot be paid from: an account the
 * caller does not own, a closed one, or the loan itself. Runs inside the
 * update's transaction, before anything is written. A source in another
 * currency than the loan is refused too: its bill could never post.
 */
export async function assertLoanSourceAccount(
  m: EntityManager,
  userId: string,
  loanAccountId: string,
  sourceAccountId: string,
  loanCurrencyCode: string,
): Promise<void> {
  const source =
    sourceAccountId === loanAccountId
      ? null
      : await m.findOne(Account, { where: { id: sourceAccountId, userId } });
  if (!source || source.isClosed) {
    throw new BadRequestException(
      tr(
        "errors.accounts.invalidSourceAccount",
        "Choose an open account, other than the loan itself, to pay from",
      ),
    );
  }
  assertLoanSourceCurrency(source.currencyCode, loanCurrencyCode);
}

/**
 * Point what pays a loan at its new "Payment from Account", in the caller's
 * transaction: the linked payment schedule's `accountId` (so every upcoming
 * occurrence is drawn from the new account; posted rows keep theirs) and the
 * `accountId` leaves naming the previous source in each rule that settles
 * this loan's installments (the payment-matching rule of
 * `docs/specs/loan-installment-settlement.md` decision 5, and any the user
 * wrote by hand). Each rewritten rule's revision is bumped so an editor
 * holding the old definition is refused rather than overwriting it.
 *
 * The caller holds the loan's account row lock; the schedule row is locked
 * next, then the rule list, the order the account update already takes when
 * it reprices the template.
 */
export async function reassignLoanSourceAccount(
  m: EntityManager,
  userId: string,
  loan: Pick<Account, "id" | "scheduledTransactionId">,
  previousSourceId: string | null,
  nextSourceId: string,
): Promise<void> {
  if (loan.scheduledTransactionId) {
    const schedule = await m.findOne(ScheduledTransaction, {
      where: { id: loan.scheduledTransactionId, userId },
      lock: { mode: "pessimistic_write" },
    });
    if (schedule && schedule.accountId !== nextSourceId) {
      await m.update(
        ScheduledTransaction,
        { id: schedule.id, userId },
        { accountId: nextSourceId },
      );
    }
  }

  if (!previousSourceId) return;
  await lockTransactionRuleList(m, userId);
  const rules = await m.find(TransactionRule, { where: { userId } });
  for (const rule of rules) {
    if (!settlesLoan(rule, loan.id)) continue;
    const condition = replaceAccountLeaves(
      rule.condition,
      previousSourceId,
      nextSourceId,
    );
    if (condition === rule.condition) continue;
    await m.update(TransactionRule, { id: rule.id, userId }, {
      condition,
      revision: () => "revision + 1",
    } as QueryDeepPartialEntity<TransactionRule>);
  }
}

function settlesLoan(rule: TransactionRule, loanAccountId: string): boolean {
  return (rule.actions ?? []).some(
    (action) =>
      action.type === SETTLE_LOAN_INSTALLMENT &&
      action.loanAccountId === loanAccountId,
  );
}

/**
 * The condition with every `accountId` leaf value `from` replaced by `to`
 * (a list is de-duplicated). Returns the same object when nothing matched, so
 * the caller can tell an untouched rule by identity.
 */
export function replaceAccountLeaves(
  node: RuleConditionNode,
  from: string,
  to: string,
): RuleConditionNode {
  if ("all" in node || "any" in node) {
    const key = "all" in node ? "all" : "any";
    const children = (node as Record<typeof key, RuleConditionNode[]>)[key];
    const next = children.map((child) => replaceAccountLeaves(child, from, to));
    return next.every((child, i) => child === children[i])
      ? node
      : ({ ...node, [key]: next } as RuleConditionNode);
  }
  const leaf = node as RuleConditionLeaf;
  if (leaf.field !== "accountId") return node;
  if (leaf.value === from) return { ...leaf, value: to };
  if (Array.isArray(leaf.value) && leaf.value.includes(from)) {
    const value = [
      ...new Set(
        (leaf.value as readonly string[]).map((id) => (id === from ? to : id)),
      ),
    ];
    return { ...leaf, value };
  }
  return node;
}
