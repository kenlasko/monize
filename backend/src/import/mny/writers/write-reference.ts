import { randomUUID } from "node:crypto";
import { BadRequestException } from "@nestjs/common";
import { EntityManager } from "typeorm";
import { Account } from "../../../accounts/entities/account.entity";
import { Category } from "../../../categories/entities/category.entity";
import { Payee } from "../../../payees/entities/payee.entity";
import { tr } from "../../../i18n/translate";
import { insertCategoryIfAbsent } from "../../insert-category-if-absent";
import {
  MappedAccount,
  MappedCategory,
  MappedPayee,
} from "../model/mny-import-model";

/**
 * Writers for the entities transactions point at: accounts, categories, payees.
 *
 * All three are find-or-create by name, which is what makes a re-import into a
 * wiped profile clean and a second import into a populated one merge rather than
 * duplicate (design section 2, non-goals). Nothing here deletes.
 *
 * Account ids are pre-generated, so an investment pair's two `linked_account_id`
 * values are known before either row exists -- but the column is a
 * self-referencing foreign key and the pair points *both* ways, so no insertion
 * order can satisfy it inline. The links go in as one patch pass afterwards,
 * which is the same shape `AccountsService.createInvestmentPair` uses.
 */

export interface WrittenAccounts {
  /** Import-local account key -> the Monize account id it landed in. */
  readonly idByKey: ReadonlyMap<string, string>;
  readonly created: number;
  /** Accounts matched to a row that already existed. */
  readonly reused: number;
  /** Ids of the reused accounts: their balance stays the ledger's, not the file's. */
  readonly reusedIds: ReadonlySet<string>;
}

/**
 * Creates the mapped accounts, reusing any this user already has by name.
 *
 * Closure is **not** applied here: `AccountsService.updateBalance` refuses closed
 * accounts, so an account closed before its transactions are written would be
 * unwritable. `applyDeferredClosures` runs at the end of the import instead.
 */
export async function writeAccounts(
  manager: EntityManager,
  userId: string,
  accounts: readonly MappedAccount[],
): Promise<WrittenAccounts> {
  const repo = manager.getRepository(Account);
  const idByKey = new Map<string, string>();
  let created = 0;
  let reused = 0;
  const reusedIds = new Set<string>();

  const existing = await repo.find({
    where: { userId },
    select: ["id", "name", "currencyCode", "isClosed"],
  });
  const existingIdByName = new Map(
    existing.map((account) => [account.name.toLowerCase(), account.id]),
  );

  // Refuse before the first insert: rows in the file account's currency would
  // otherwise be booked into an account of another currency, or into a closed one.
  for (const account of accounts) {
    const match = existing.find(
      (row) => row.name.toLowerCase() === account.name.toLowerCase(),
    );
    if (!match) {
      continue;
    }
    if (match.isClosed) {
      throw new BadRequestException(
        tr(
          "errors.import.mnyExistingAccountClosed",
          `The existing account "${match.name}" is closed, so the Money file cannot be merged into it. Reopen it or rename it, then import again.`,
          { name: match.name },
        ),
      );
    }
    if (match.currencyCode !== account.currencyCode) {
      throw new BadRequestException(
        tr(
          "errors.import.mnyExistingAccountCurrency",
          `The existing account "${match.name}" uses ${match.currencyCode}, but the Money file account uses ${account.currencyCode}. Rename one of them, then import again.`,
          {
            name: match.name,
            existing: match.currencyCode,
            file: account.currencyCode,
          },
        ),
      );
    }
  }

  // Pass 1: decide every account's id, so a pair can reference its other half.
  for (const account of accounts) {
    const already = existingIdByName.get(account.name.toLowerCase());
    idByKey.set(account.key, already ?? randomUUID());
  }

  // Pass 2: insert the ones that are new, without their links.
  const inserted: MappedAccount[] = [];
  for (const account of accounts) {
    if (existingIdByName.has(account.name.toLowerCase())) {
      reused += 1;
      reusedIds.add(idByKey.get(account.key) as string);
      continue;
    }
    inserted.push(account);

    const balance = account.openingBalance;
    await repo.insert({
      id: idByKey.get(account.key),
      userId,
      name: account.name,
      accountType: account.accountType,
      accountSubType: account.accountSubType,
      currencyCode: account.currencyCode,
      openingBalance: balance,
      // Overwritten with the file-computed balance once transactions land; set
      // now so an import that fails mid-flight still shows a sane number.
      currentBalance: balance,
      creditLimit: account.creditLimit,
      description: account.description,
      isFavourite: account.favourite,
      excludeFromNetWorth: account.excludeFromNetWorth,
      isClosed: false,
      linkedAccountId: null,
    });
    created += 1;
  }

  // Pass 3: wire the investment pairs, now that both halves exist.
  for (const account of inserted) {
    if (!account.linkedKey) {
      continue;
    }
    const id = idByKey.get(account.key);
    const linkedAccountId = idByKey.get(account.linkedKey);
    if (id && linkedAccountId) {
      await repo.update({ id, userId }, { linkedAccountId });
    }
  }

  return { idByKey, created, reused, reusedIds };
}

/**
 * Closes the accounts Money had closed. Runs after every transaction and balance
 * is written, because a closed account rejects balance updates.
 */
export async function applyDeferredClosures(
  manager: EntityManager,
  userId: string,
  accounts: readonly MappedAccount[],
  idByKey: ReadonlyMap<string, string>,
): Promise<number> {
  const closed = accounts.filter((account) => account.closed);
  if (closed.length === 0) {
    return 0;
  }

  const repo = manager.getRepository(Account);
  for (const account of closed) {
    const id = idByKey.get(account.key);
    if (!id) {
      continue;
    }
    await repo.update(
      { id, userId },
      {
        isClosed: true,
        closedDate: account.closedDate
          ? (account.closedDate as unknown as Date)
          : null,
      },
    );
  }

  return closed.length;
}

export interface WrittenCategories {
  /** `parent:child` full name -> category id. */
  readonly idByFullName: ReadonlyMap<string, string>;
  readonly created: number;
}

/**
 * Creates the mapped categories, parents first.
 *
 * Money's income flag survives: it is read from `CAT.lType` by the mapper and
 * written here. The QIF path's shared entity creator hardcodes `isIncome: false`,
 * which is why this pipeline does not route through it.
 */
export async function writeCategories(
  manager: EntityManager,
  userId: string,
  categories: readonly MappedCategory[],
): Promise<WrittenCategories> {
  const repo = manager.getRepository(Category);
  const idByFullName = new Map<string, string>();
  let created = 0;

  const existing = await repo.find({
    where: { userId },
    select: ["id", "name", "parentId"],
  });
  // Keyed by name + parent id, matching the uniqueness the app enforces.
  const existingByKey = new Map(
    existing.map((category) => [
      `${category.name.toLowerCase()}|${category.parentId ?? ""}`,
      category.id,
    ]),
  );

  for (const category of categories) {
    const parentId = category.parentName
      ? (idByFullName.get(category.parentName) ?? null)
      : null;
    const key = `${category.name.toLowerCase()}|${parentId ?? ""}`;

    const already = existingByKey.get(key);
    if (already) {
      idByFullName.set(category.fullName, already);
      continue;
    }

    // Adopts a row another transaction created since the read above rather
    // than aborting the whole import on its unique violation (INV-IMPORT-003).
    const { id, inserted } = await insertCategoryIfAbsent(manager, {
      userId,
      name: category.name,
      parentId,
      isIncome: category.isIncome,
    });
    idByFullName.set(category.fullName, id);
    existingByKey.set(key, id);
    if (inserted) {
      created += 1;
    }
  }

  return { idByFullName, created };
}

export interface WrittenPayees {
  readonly idByName: ReadonlyMap<string, string>;
  readonly created: number;
}

/** Creates the mapped payees, reusing any the user already has by name. */
export async function writePayees(
  manager: EntityManager,
  userId: string,
  payees: readonly MappedPayee[],
): Promise<WrittenPayees> {
  const repo = manager.getRepository(Payee);
  const idByName = new Map<string, string>();
  let created = 0;

  const existing = await repo.find({
    where: { userId },
    select: ["id", "name"],
  });
  const existingIdByName = new Map(
    existing.map((payee) => [payee.name.toLowerCase(), payee.id]),
  );

  for (const payee of payees) {
    const already = existingIdByName.get(payee.name.toLowerCase());
    if (already) {
      idByName.set(payee.name, already);
      continue;
    }

    const id = randomUUID();
    await repo.insert({ id, userId, name: payee.name, isActive: true });
    idByName.set(payee.name, id);
    existingIdByName.set(payee.name.toLowerCase(), id);
    created += 1;
  }

  return { idByName, created };
}
