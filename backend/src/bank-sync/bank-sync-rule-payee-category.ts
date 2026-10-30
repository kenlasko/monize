import { EntityManager, In } from "typeorm";
import { Payee } from "../payees/entities/payee.entity";
import type { RuleNetChanges } from "../transaction-rules/rule-effects";

/**
 * The payee whose default category a bank-synced row takes after the `import`
 * rules ran, or null when the row keeps the category it has.
 *
 * A synced row is written with the payee the bank's counterparty resolves to,
 * and that payee's default category, before the rules run. A rule that cleans
 * the bank's text into another payee ("CARD 1234 STARBUCKS #55" to "Starbucks")
 * leaves the row with the first payee's category, usually none. So when the
 * rules changed the payee to an existing one and set no category, the row
 * takes the new payee's default category, as it would have had it been
 * written with that payee. A category a rule set always wins, and a structural
 * action (a split or a transfer) leaves the row with no category to give.
 *
 * The writer and the preview both read the rules' net changes through this,
 * so the preview shows the category the commit writes.
 */
export function payeeGivingDefaultCategory(
  changes: RuleNetChanges,
): string | null {
  if (changes.categoryId !== undefined) return null;
  if (changes.structure !== undefined) return null;
  return typeof changes.payeeId === "string" ? changes.payeeId : null;
}

/** A payee's default category, with its name for a preview to show. */
export interface PayeeDefaultCategory {
  categoryId: string;
  categoryName: string | null;
}

/**
 * The default category of each of `payeeIds` that has one, by payee id. A
 * payee without a default category, or not the user's, is absent.
 */
export async function loadPayeeDefaultCategories(
  m: EntityManager,
  userId: string,
  payeeIds: readonly string[],
): Promise<Map<string, PayeeDefaultCategory>> {
  const ids = [...new Set(payeeIds)];
  const found = new Map<string, PayeeDefaultCategory>();
  if (ids.length === 0) return found;
  const payees = await m.getRepository(Payee).find({
    where: { id: In(ids), userId },
    relations: { defaultCategory: true },
  });
  for (const payee of payees) {
    if (payee.defaultCategoryId === null) continue;
    found.set(payee.id, {
      categoryId: payee.defaultCategoryId,
      categoryName: payee.defaultCategory?.name ?? null,
    });
  }
  return found;
}
