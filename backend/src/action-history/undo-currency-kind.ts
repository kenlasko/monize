import { EntityManager } from "typeorm";
import { assertAccountCurrencyKindIn } from "../accounts/account-currency-kind.util";
import { assertSecurityCurrencyIsFiatIn } from "../securities/security-currency-kind.util";
import { ActionHistory } from "./entities/action-history.entity";

/**
 * An undo or redo that writes an account or a security row back from its
 * snapshot is a write like any other, so it is held to the currency kind
 * rules every other writer is (INV-CRYPTO-001, `docs/specs/crypto-accounts.md`
 * decision 8): a CRYPTO account in a CRYPTO currency and no other account in
 * one, a security priced in fiat. The kind is read now, inside the undo's
 * transaction and `FOR KEY SHARE` like every writer's check, because the
 * snapshot was taken under whatever kind the code had then.
 *
 * Nothing to check for the undo of a create (it deletes the row), or for a
 * snapshot that carries no currency (or, for an account, no type): those
 * replay no currency.
 */
export async function assertUndoCurrencyKind(
  action: ActionHistory,
  manager: EntityManager,
  entity: "account" | "security",
): Promise<void> {
  if (action.action === "create") return;
  const snapshot = action.beforeData;
  const code: unknown = snapshot?.currencyCode;
  if (typeof code !== "string" || code === "") return;
  if (entity === "security") {
    await assertSecurityCurrencyIsFiatIn(manager, code);
    return;
  }
  const type: unknown = snapshot?.accountType;
  if (typeof type !== "string" || type === "") return;
  await assertAccountCurrencyKindIn(manager, type, code);
}
