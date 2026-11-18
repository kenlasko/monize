import { EntityManager } from "typeorm";
import { PayeeAlias } from "../../../payees/entities/payee-alias.entity";
import { insertPayeeAliasIgnoringDuplicate } from "../../../payees/insert-payee-alias.util";
import { AliasLedger } from "../map/payee-alias-collision";
import { MappedPayee } from "../model/mny-import-model";
import { MnyWarning } from "../model/mny-warnings";

/**
 * KMyMoney import, spec 5.5.4: the payees' default categories, contact details
 * and matching aliases. Runs inside `writeAll`'s one transaction, right after
 * the rule pass, so the rows of this import keep the payee KMyMoney assigned
 * (the rule pass resolves payee names through aliases and has already run).
 *
 * Fill-only: a payee that already has its own default category or contact field
 * keeps it (`payeeDetailsKept`). An alias goes through the same collision table
 * as the mapper's, against the user's existing aliases and payee names, which
 * only the commit can see.
 */

export interface WrittenPayeeExtras {
  readonly aliasesCreated: number;
  readonly defaultCategoriesSet: number;
  /** Payees that received at least one contact field. */
  readonly contactDetailsSet: number;
  /** Post-import warnings: conflict, overlap, kept. */
  readonly warnings: readonly MnyWarning[];
}

export interface PayeeExtrasInput {
  readonly payees: readonly MappedPayee[];
  /** `WrittenPayees.idByName`. */
  readonly payeeIdByName: ReadonlyMap<string, string>;
  readonly categoryIdByHandle: ReadonlyMap<number, string>;
}

const NOTHING_WRITTEN: WrittenPayeeExtras = {
  aliasesCreated: 0,
  defaultCategoriesSet: 0,
  contactDetailsSet: 0,
  warnings: [],
};

interface FillRow {
  default_category_id: string | null;
  notes: string | null;
  email: string | null;
  phone: string | null;
  address: string | null;
  old_default_category_id: string | null;
  old_notes: string | null;
  old_email: string | null;
  old_phone: string | null;
  old_address: string | null;
}

const isEmpty = (value: string | null): boolean =>
  value === null || value === "";

/** Only fills what is empty; returns the values before and after so the caller can tell which landed. */
const FILL_EMPTY_SQL = `UPDATE payees SET
    default_category_id = COALESCE(payees.default_category_id, $3),
    notes = COALESCE(NULLIF(payees.notes, ''), $4, payees.notes),
    email = COALESCE(NULLIF(payees.email, ''), $5, payees.email),
    phone = COALESCE(NULLIF(payees.phone, ''), $6, payees.phone),
    address = COALESCE(NULLIF(payees.address, ''), $7, payees.address)
  FROM (
    SELECT id, default_category_id, notes, email, phone, address
    FROM payees WHERE id = $1 AND user_id = $2
  ) AS old
  WHERE payees.id = old.id AND payees.user_id = $2
  RETURNING payees.default_category_id, payees.notes, payees.email,
    payees.phone, payees.address,
    old.default_category_id AS old_default_category_id, old.notes AS old_notes,
    old.email AS old_email, old.phone AS old_phone, old.address AS old_address`;

function hasNewFields(payee: MappedPayee): boolean {
  return (
    (payee.aliases?.length ?? 0) > 0 ||
    (payee.defaultCategoryHandle ?? null) !== null ||
    payee.contact !== undefined
  );
}

export async function writePayeeExtras(
  manager: EntityManager,
  userId: string,
  input: PayeeExtrasInput,
): Promise<WrittenPayeeExtras> {
  const payees = input.payees.filter(hasNewFields);
  if (payees.length === 0) {
    return NOTHING_WRITTEN;
  }

  const warnings: MnyWarning[] = [];
  let defaultCategoriesSet = 0;
  let contactDetailsSet = 0;

  for (const payee of payees) {
    const payeeId = input.payeeIdByName.get(payee.name);
    const categoryId =
      payee.defaultCategoryHandle === undefined ||
      payee.defaultCategoryHandle === null
        ? null
        : (input.categoryIdByHandle.get(payee.defaultCategoryHandle) ?? null);
    const contact = payee.contact;
    if (
      payeeId === undefined ||
      (categoryId === null &&
        (contact === undefined ||
          Object.values(contact).every((value) => value === null)))
    ) {
      continue;
    }
    const result: unknown = await manager.query(FILL_EMPTY_SQL, [
      payeeId,
      userId,
      categoryId,
      contact?.notes ?? null,
      contact?.email ?? null,
      contact?.phone ?? null,
      contact?.address ?? null,
    ]);
    const rows = (
      Array.isArray((result as unknown[])[0])
        ? (result as unknown[][])[0]
        : result
    ) as FillRow[];
    const row = rows[0];
    if (!row) {
      continue;
    }

    const kept: string[] = [];
    let contactFilled = false;
    if (categoryId !== null) {
      if (isEmpty(row.old_default_category_id)) {
        defaultCategoriesSet += 1;
      } else if (row.old_default_category_id !== categoryId) {
        kept.push("default category");
      }
    }
    const fields = [
      ["notes", contact?.notes, row.old_notes],
      ["email", contact?.email, row.old_email],
      ["phone", contact?.phone, row.old_phone],
      ["address", contact?.address, row.old_address],
    ] as const;
    for (const [label, supplied, before] of fields) {
      if (supplied === null || supplied === undefined) {
        continue;
      }
      if (isEmpty(before)) {
        contactFilled = true;
      } else if (before !== supplied) {
        kept.push(label);
      }
    }
    if (contactFilled) {
      contactDetailsSet += 1;
    }
    if (kept.length > 0) {
      warnings.push({
        code: "payeeDetailsKept",
        subject: payee.name,
        detail: kept.join(", "),
      });
    }
  }

  const aliased = payees.filter((payee) => (payee.aliases?.length ?? 0) > 0);
  let aliasesCreated = 0;
  if (aliased.length > 0) {
    const written = await writeAliases(manager, userId, aliased, input);
    aliasesCreated = written.created;
    warnings.push(...written.warnings);
  }

  return { aliasesCreated, defaultCategoriesSet, contactDetailsSet, warnings };
}

async function writeAliases(
  manager: EntityManager,
  userId: string,
  payees: readonly MappedPayee[],
  input: PayeeExtrasInput,
): Promise<{ created: number; warnings: MnyWarning[] }> {
  const existingPayees: { id: string; name: string }[] = await manager.query(
    "SELECT id, name FROM payees WHERE user_id = $1",
    [userId],
  );
  const existingAliases: { alias: string; payee_id: string }[] =
    await manager.query(
      "SELECT alias, payee_id FROM payee_aliases WHERE user_id = $1",
      [userId],
    );
  const ledger = new AliasLedger(
    existingPayees.map((row) => ({ owner: row.id, name: row.name })),
  );
  const ownAliases = new Set<string>();
  for (const row of existingAliases) {
    ledger.hold(row.alias, row.payee_id);
    ownAliases.add(`${row.payee_id}|${row.alias.toLowerCase()}`);
  }

  const warnings: MnyWarning[] = [];
  let created = 0;
  for (const payee of payees) {
    const payeeId = input.payeeIdByName.get(payee.name);
    if (payeeId === undefined) {
      continue;
    }
    for (const glob of payee.aliases ?? []) {
      // The payee already has this alias: nothing to add, nothing to report.
      if (ownAliases.has(`${payeeId}|${glob.toLowerCase()}`)) {
        continue;
      }
      const subject = `${payee.name}: ${glob}`;
      const decision = ledger.decide(glob, payeeId);
      if (decision.kind === "conflict") {
        warnings.push({
          code: "payeeMatchKeyConflict",
          subject,
          detail: decision.detail,
        });
        continue;
      }
      const inserted = await insertPayeeAliasIgnoringDuplicate(
        manager,
        manager.create(PayeeAlias, { payeeId, userId, alias: glob }),
      );
      if (!inserted) {
        // The unique index saw a clash the collision table could not (a race
        // with a concurrent alias edit): skipped, not an aborted import.
        warnings.push({
          code: "payeeMatchKeyConflict",
          subject,
          detail: "alias already exists",
        });
        continue;
      }
      ledger.hold(glob, payeeId);
      ownAliases.add(`${payeeId}|${glob.toLowerCase()}`);
      created += 1;
      if (decision.overlap !== null) {
        warnings.push({
          code: "payeeMatchKeyOverlap",
          subject,
          detail: decision.overlap,
        });
      }
    }
  }
  return { created, warnings };
}
