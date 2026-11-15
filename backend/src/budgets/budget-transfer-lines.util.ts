import { BadRequestException, NotFoundException } from "@nestjs/common";
import { EntityManager, In } from "typeorm";
import { tr } from "../i18n/translate";
import { Account } from "../accounts/entities/account.entity";

/**
 * Refuses an account the user does not own as a transfer line's account. A
 * transfer line reads the user's own legs whose counterpart is that account
 * (`budget-spending.util.ts`), so it names one of their accounts.
 */
export async function assertTransferAccountsOwned(
  m: EntityManager,
  userId: string,
  accountIds: readonly string[],
): Promise<void> {
  const wanted = [...new Set(accountIds)];
  if (wanted.length === 0) return;
  const owned = await m.getRepository(Account).find({
    where: { id: In(wanted), userId },
    select: ["id"],
  });
  const ownedIds = new Set(owned.map((a) => a.id));
  const missing = wanted.find((id) => !ownedIds.has(id));
  if (missing) {
    throw new NotFoundException(
      tr(
        "errors.budgets.transferAccountNotFound",
        `Account with ID ${missing} not found`,
        { id: missing },
      ),
    );
  }
}

/**
 * Refuses two transfer lines naming one account, outgoing or income
 * (issue #2141): a transfer to it counted as savings progress must not also
 * reduce income, and a source counted twice would double its income.
 */
export function assertOneTransferLinePerAccount(
  accountIds: readonly string[],
): void {
  if (new Set(accountIds).size !== accountIds.length) {
    throw new BadRequestException(
      tr(
        "errors.budgets.transferAccountAlreadyInBudget",
        "This account already has a transfer line in the budget",
      ),
    );
  }
}
