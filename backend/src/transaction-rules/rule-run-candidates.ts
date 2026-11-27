import { EntityManager, In } from "typeorm";
import { lockTransactionRows } from "../common/db/locks";
import { applyInvestmentTransactionFilters } from "../common/investment-filter.util";
import { applyRegisterOrder } from "../transactions/register-order";
import { Transaction } from "../transactions/entities/transaction.entity";
import { RuleRunFilters } from "./rule-run.types";
import type { RuleRowInput } from "./transaction-rules-applier.service";
import {
  DEFAULT_RULE_RUN_LIMIT,
  MAX_RULE_RUN_LIMIT,
} from "./transaction-rules.limits";

/**
 * One thing a rule is evaluated on: a plain transaction, or a transfer.
 *
 * A same-owner transfer is one unit however many of its legs matched the
 * filters: the rule is evaluated once, over the outgoing leg's facts, and the
 * result is written to both legs (the B5 semantics of `applyToNewTransfer`).
 * A transfer whose other leg is not the caller's is a unit of its own leg
 * alone, with `crossOwnerTransferLeg` set, so `set_payee` is refused.
 */
export interface CandidateUnit {
  /** The row the facts are read from. */
  readonly primary: Transaction;
  /** Every row the effects are written to (the primary first). */
  readonly legs: readonly Transaction[];
  readonly isTransfer: boolean;
  readonly fromAccountId: string | null;
  readonly toAccountId: string | null;
  readonly crossOwnerTransferLeg: boolean;
}

export interface CandidateSet {
  readonly units: CandidateUnit[];
  readonly truncated: boolean;
  /**
   * For each candidate a split's transfer line links, the status of that
   * split's parent: a category written onto the row is written onto the line
   * too (INV-CATEGORY-002), so a reconciled parent keeps the row as it is
   * under the strict lock. Absent: no candidate is such a row.
   */
  readonly lineParentStatus?: ReadonlyMap<string, string | null>;
}

/** The limit a caller asked for, inside 1..max (the run's ceiling unless the caller names its own). */
export function effectiveRunLimit(
  limit: number | undefined,
  max: number = MAX_RULE_RUN_LIMIT,
): number {
  return Math.min(
    Math.max(Math.trunc(limit ?? DEFAULT_RULE_RUN_LIMIT), 1),
    max,
  );
}

const isOutgoing = (row: Transaction): boolean => Number(row.amount) < 0;

/** The outgoing leg of a pair; on a tie (both zero) the lower id, so the choice is stable. */
function outgoingOf(a: Transaction, b: Transaction): Transaction {
  const outgoing = [a, b].find(isOutgoing);
  if (outgoing) return outgoing;
  return a.id < b.id ? a : b;
}

function unitFor(
  row: Transaction,
  partners: ReadonlyMap<string, Transaction>,
): CandidateUnit {
  if (!row.isTransfer) {
    return {
      primary: row,
      legs: [row],
      isTransfer: false,
      fromAccountId: null,
      toAccountId: null,
      crossOwnerTransferLeg: false,
    };
  }
  const candidate = row.linkedTransactionId
    ? partners.get(row.linkedTransactionId)
    : undefined;
  // The link must run both ways: a one-way link is not a pair.
  const partner =
    candidate?.linkedTransactionId === row.id ? candidate : undefined;
  if (partner) {
    const outgoing = outgoingOf(row, partner);
    const incoming = outgoing === row ? partner : row;
    return {
      primary: outgoing,
      legs: [outgoing, incoming],
      isTransfer: true,
      fromAccountId: outgoing.accountId,
      toAccountId: incoming.accountId,
      crossOwnerTransferLeg: false,
    };
  }
  // The partner is not the caller's (or is gone): this leg alone.
  const outgoing = isOutgoing(row);
  return {
    primary: row,
    legs: [row],
    isTransfer: true,
    fromAccountId: outgoing ? row.accountId : null,
    toAccountId: outgoing ? null : row.accountId,
    crossOwnerTransferLeg: true,
  };
}

/** Which end of the register a run scans from. */
export type CandidateDirection = "ASC" | "DESC";

/**
 * The caller's non-investment transactions in range, in register order,
 * grouped into evaluation units. Two queries however many rows: the
 * candidates, then the transfer partners the filters did not select. With
 * `lock`, every leg is row-locked (ascending by id, docs/concurrency-and-
 * idempotency.md section 5) and read again, so the facts the plan is built on
 * are the ones the write replaces.
 *
 * `direction` defaults to `"DESC"`, newest first, the order every run has
 * scanned in. A run that settles loan installments asks for `"ASC"`, oldest
 * first, so its fold prices each row on the debt the rows before it leave
 * (INV-RULE-005); the cap then keeps the oldest rows and `truncated` says the
 * newer ones wait for the next page.
 */
export async function loadCandidateUnits(
  m: EntityManager,
  userId: string,
  filters: RuleRunFilters,
  options: {
    lock: boolean;
    direction?: CandidateDirection;
    /** A ceiling other than the run's, for a read that writes nothing (the match). */
    maxLimit?: number;
  },
): Promise<CandidateSet> {
  const limit = effectiveRunLimit(filters.limit, options.maxLimit);
  const qb = m
    .getRepository(Transaction)
    .createQueryBuilder("transaction")
    .innerJoin("transaction.account", "account")
    .where("transaction.userId = :userId", { userId })
    // A split transfer's counterpart hangs off a parent; rules do not see it (design 6.3, Q2).
    .andWhere("transaction.parentTransactionId IS NULL");
  applyInvestmentTransactionFilters(qb, "account");
  if (filters.accountIds && filters.accountIds.length > 0) {
    qb.andWhere("transaction.accountId IN (:...accountIds)", {
      accountIds: [...filters.accountIds],
    });
  }
  if (filters.startDate) {
    qb.andWhere("transaction.transactionDate >= :startDate", {
      startDate: filters.startDate,
    });
  }
  if (filters.endDate) {
    qb.andWhere("transaction.transactionDate <= :endDate", {
      endDate: filters.endDate,
    });
  }
  applyRegisterOrder(qb, "transaction", options.direction ?? "DESC").take(
    limit + 1,
  );
  const found = await qb.getMany();
  const truncated = found.length > limit;
  const rows = found.slice(0, limit);

  const byId = new Map(rows.map((row) => [row.id, row]));
  const partnerIds = rows
    .filter((row) => row.isTransfer && row.linkedTransactionId)
    .map((row) => row.linkedTransactionId as string)
    .filter((id) => !byId.has(id));
  const extra =
    partnerIds.length > 0
      ? await m.find(Transaction, {
          where: { id: In([...new Set(partnerIds)]), userId },
        })
      : [];
  // Only a plain, top-level transfer leg is a partner.
  const partners = new Map(
    [...rows, ...extra]
      .filter((row) => row.isTransfer && row.parentTransactionId === null)
      .map((row) => [row.id, row]),
  );

  // The split parents whose transfer lines link a candidate. A category the
  // run writes onto such a row reaches its line too, so with `lock` each
  // parent is locked before any candidate: a split parent before its legs
  // (`common/db/locks.ts`).
  const transferIds = rows.filter((row) => row.isTransfer).map((r) => r.id);
  const lineParents =
    transferIds.length > 0
      ? ((await m.query(
          `SELECT s.linked_transaction_id AS "rowId", s.transaction_id AS "parentId"
             FROM transaction_splits s
             JOIN transactions p ON p.id = s.transaction_id
            WHERE s.linked_transaction_id = ANY($1) AND p.user_id = $2`,
          [transferIds, userId],
        )) as { rowId: string; parentId: string }[])
      : [];
  const parentIds = [...new Set(lineParents.map((line) => line.parentId))];
  if (options.lock && parentIds.length > 0) {
    await lockTransactionRows(m, parentIds, userId);
  }
  const parentStatus = new Map(
    parentIds.length > 0
      ? (
          (await m.query(
            `SELECT id, status FROM transactions WHERE id = ANY($1) AND user_id = $2`,
            [parentIds, userId],
          )) as { id: string; status: string | null }[]
        ).map((parent) => [parent.id, parent.status])
      : [],
  );
  const lineParentStatus = new Map(
    lineParents.map((line) => [
      line.rowId,
      parentStatus.get(line.parentId) ?? null,
    ]),
  );

  let usable: ReadonlyMap<string, Transaction> = partners;
  let ordered = rows;
  if (options.lock) {
    const ids = new Set<string>(rows.map((row) => row.id));
    for (const partner of partners.values()) ids.add(partner.id);
    await lockTransactionRows(m, [...ids], userId);
    const fresh = await m.find(Transaction, {
      where: { id: In([...ids]), userId },
    });
    const freshById = new Map(fresh.map((row) => [row.id, row]));
    ordered = rows
      .map((row) => freshById.get(row.id))
      .filter((row): row is Transaction => row !== undefined);
    usable = new Map(
      fresh
        .filter((row) => row.isTransfer && row.parentTransactionId === null)
        .map((row) => [row.id, row]),
    );
  }

  const units: CandidateUnit[] = [];
  const seen = new Set<string>();
  for (const row of ordered) {
    const unit = unitFor(row, usable);
    if (seen.has(unit.primary.id)) continue;
    seen.add(unit.primary.id);
    units.push(unit);
  }
  return {
    units,
    truncated,
    ...(lineParentStatus.size > 0 ? { lineParentStatus } : {}),
  };
}

/**
 * The facts input of a unit, read from its primary row. One spelling for the
 * run's plan and the match, so the two can never evaluate a row differently.
 */
export function unitRowInput(
  unit: CandidateUnit,
  tagsByRow: ReadonlyMap<string, readonly string[]>,
  attached: ReadonlySet<string>,
): RuleRowInput {
  const { primary } = unit;
  return {
    accountId: primary.accountId,
    currencyCode: primary.currencyCode,
    amount: primary.amount,
    isTransfer: unit.isTransfer,
    fromAccountId: unit.fromAccountId,
    toAccountId: unit.toAccountId,
    payeeId: primary.payeeId,
    payeeText: primary.payeeName,
    payeeName: primary.payeeName,
    categoryId: primary.categoryId,
    description: primary.description,
    tagIds: tagsByRow.get(primary.id) ?? [],
    hasSplits: primary.isSplit,
    referenceNumber: primary.referenceNumber,
    transactionDate: primary.transactionDate,
    status: primary.status,
    hasAttachment: attached.has(primary.id),
  };
}
