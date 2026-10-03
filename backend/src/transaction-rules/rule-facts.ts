import { EntityManager } from "typeorm";
import { primaryAttachmentSql } from "../attachments/primary-attachment.util";
import { TransactionAttachment } from "../attachments/entities/transaction-attachment.entity";
import { Category } from "../categories/entities/category.entity";
import {
  RULE_WEEKDAYS,
  RuleFacts,
  RuleTransactionType,
  RuleWeekday,
} from "./rule-condition.types";

/** Money scale: facts carry the amount as a scaled integer (1/10000 units). */
const MONEY_SCALE = 10000;

/**
 * What the caller already knows about one row. `create()` has all of it in
 * hand; the applier loads it from the stored row for the other paths.
 */
export interface RuleFactsInput {
  readonly accountId: string;
  /** Derived from the account, never from the request. */
  readonly currencyCode: string | null;
  /** Signed, in account currency (a number or a decimal string). */
  readonly amount: number | string | null;
  /** True when the row is a leg of a transfer. */
  readonly isTransfer: boolean;
  /** For a transfer leg: the account the money left and the account it reached. */
  readonly fromAccountId?: string | null;
  readonly toAccountId?: string | null;
  readonly payeeId: string | null;
  /** The raw payee text the source supplied (typed name, import text). */
  readonly payeeText: string | null;
  readonly categoryId: string | null;
  /** The category itself plus its ancestors, from `loadCategoryChains`. */
  readonly categoryAncestorIds?: readonly string[];
  readonly description: string | null;
  readonly tagIds: readonly string[];
  readonly hasSplits: boolean;
  /**
   * Design 10.3. A caller that does not know one leaves it out and the fact is
   * unknown (`null`, and `hasAttachment` false): a leaf on it is false except
   * `isEmpty`.
   */
  readonly referenceNumber?: string | null;
  /** The transaction's calendar date, `YYYY-MM-DD`; `dayOfMonth` and `weekday` derive from it. */
  readonly transactionDate?: string | null;
  readonly status?: string | null;
  /** True when the row has a visible attachment (`loadAttachmentPresence`). */
  readonly hasAttachment?: boolean;
}

const CALENDAR_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * The day of month and weekday of a calendar date string, read from the digits
 * and never through the server's timezone: `Date.UTC` names the same instant
 * everywhere and `getUTCDay` reads it back in UTC, so 2026-03-01 is a Sunday
 * in every zone. Anything that is not a real `YYYY-MM-DD` date is unknown.
 */
export function calendarDayParts(
  date: string | null | undefined,
): { dayOfMonth: number; weekday: RuleWeekday } | null {
  const match = typeof date === "string" ? CALENDAR_DATE.exec(date) : null;
  if (match === null) return null;
  const [year, month, day] = [match[1], match[2], match[3]].map(Number);
  const at = new Date(Date.UTC(year, month - 1, day));
  // Date.UTC rolls 2026-02-31 over to March; the round trip refuses it.
  if (
    at.getUTCFullYear() !== year ||
    at.getUTCMonth() !== month - 1 ||
    at.getUTCDate() !== day
  ) {
    return null;
  }
  // getUTCDay: 0 = Sunday; RULE_WEEKDAYS starts on Monday.
  return { dayOfMonth: day, weekday: RULE_WEEKDAYS[(at.getUTCDay() + 6) % 7] };
}

/**
 * The type of a row, derived from what it is, never from the account type
 * (INV-REPORT-001 principle): a transfer leg is TRANSFER, otherwise the sign
 * decides. A zero amount is neither income nor spending, so its type is
 * unknown (`null`): a `type` leaf is false for every operator on it, and a
 * rule never treats an empty row as spending by default.
 */
export function deriveRuleType(
  isTransfer: boolean,
  scaledAmount: number | null,
): RuleTransactionType | null {
  if (isTransfer) return "TRANSFER";
  if (scaledAmount === null || scaledAmount === 0) return null;
  return scaledAmount > 0 ? "INCOME" : "EXPENSE";
}

const blankToNull = (value: string | null | undefined): string | null =>
  value === undefined || value === null ? null : value;

/**
 * Build the frozen facts the evaluator reads. Pure. The `Transaction` entity
 * has no memo column (only `description` and `referenceNumber`), so there is
 * no `memo` field: a stored rule that names one is invalid (`UNKNOWN_FIELD`).
 */
export function buildRuleFacts(input: RuleFactsInput): RuleFacts {
  const scaled =
    input.amount === null
      ? null
      : Math.round(Number(input.amount) * MONEY_SCALE);
  const amount = scaled !== null && Number.isFinite(scaled) ? scaled : null;
  const parts = calendarDayParts(input.transactionDate);
  return Object.freeze({
    accountId: input.accountId,
    fromAccountId: input.isTransfer ? (input.fromAccountId ?? null) : null,
    toAccountId: input.isTransfer ? (input.toAccountId ?? null) : null,
    type: deriveRuleType(input.isTransfer, amount),
    payeeId: input.payeeId,
    payeeText: blankToNull(input.payeeText),
    categoryId: input.categoryId,
    categoryAncestorIds: Object.freeze(
      input.categoryId === null
        ? []
        : [...(input.categoryAncestorIds ?? [input.categoryId])],
    ),
    description: blankToNull(input.description),
    amount,
    currencyCode: input.currencyCode,
    tagIds: Object.freeze([...new Set(input.tagIds)]),
    hasSplits: input.hasSplits,
    referenceNumber: blankToNull(input.referenceNumber),
    date: parts === null ? null : (input.transactionDate ?? null),
    dayOfMonth: parts?.dayOfMonth ?? null,
    weekday: parts?.weekday ?? null,
    status: blankToNull(input.status),
    hasAttachment: input.hasAttachment === true,
  });
}

/**
 * For each id in `categoryIds`, the category plus its ancestors (nearest
 * first). One query on the caller's manager: `categories.parent_id` is the
 * only link, and a user's category tree is small, so the tree is read once
 * and walked in memory. An id that is not the user's has no chain and maps to
 * `[id]`. A parent cycle stops the walk at the first repeat.
 */
export async function loadCategoryChains(
  m: EntityManager,
  userId: string,
  categoryIds: readonly string[],
): Promise<ReadonlyMap<string, readonly string[]>> {
  const wanted = [...new Set(categoryIds)];
  const chains = new Map<string, readonly string[]>();
  if (wanted.length === 0) return chains;
  const rows = await m.getRepository(Category).find({
    select: { id: true, parentId: true },
    where: { userId },
  });
  const parentOf = new Map(rows.map((row) => [row.id, row.parentId]));
  for (const id of wanted) {
    const chain: string[] = [];
    let cursor: string | null | undefined = id;
    while (cursor && !chain.includes(cursor)) {
      chain.push(cursor);
      cursor = parentOf.get(cursor);
    }
    chains.set(id, Object.freeze(chain));
  }
  return chains;
}

/**
 * The ids among `transactionIds` that have a visible attachment: one query on
 * the caller's manager, however many rows. A scanned document is stored as two
 * rows (the picture the user sees and its hidden original), so the originals
 * are left out exactly as the register's paperclip does
 * (`primaryAttachmentSql`); the row counts once, and only its presence matters.
 */
export async function loadAttachmentPresence(
  m: EntityManager,
  userId: string,
  transactionIds: readonly string[],
): Promise<ReadonlySet<string>> {
  const wanted = [...new Set(transactionIds)];
  if (wanted.length === 0) return new Set();
  const rows = await m
    .getRepository(TransactionAttachment)
    .createQueryBuilder("ta")
    .select("ta.transactionId", "transactionId")
    .distinct(true)
    .where("ta.userId = :userId", { userId })
    .andWhere("ta.transactionId IN (:...wanted)", { wanted })
    .andWhere(primaryAttachmentSql("ta"))
    .getRawMany<{ transactionId: string }>();
  return new Set(rows.map((row) => row.transactionId));
}
