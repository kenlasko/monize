import type { PayeesService } from "../payees/payees.service";

/** How an existing payee was found for the bank's counterparty text. */
export type PayeeFoundVia = "name" | "alias";

/** A payee the bank's counterparty text resolved to. */
export interface ResolvedPayee {
  payeeId: string | null;
  payeeName: string | null;
  defaultCategoryId: string | null;
  /** For the preview's category column; the write never reads it. */
  defaultCategoryName: string | null;
  /** How the payee was found; null for `NO_PAYEE`. */
  via: PayeeFoundVia | null;
}

export const NO_PAYEE: ResolvedPayee = {
  payeeId: null,
  payeeName: null,
  defaultCategoryId: null,
  defaultCategoryName: null,
  via: null,
};

/**
 * The payee an existing counterparty resolves to, the way the file import does:
 * an exact name, then an alias pattern (the `PayeesService` lookups the importer
 * shares). Null when the user has no such payee. Read-only, so the sync (which
 * creates the payee on a null) and the preview (which only reports it) ask the
 * same question, and `via` says which of the two answered.
 */
export async function findExistingPayee(
  payees: Pick<PayeesService, "findByName" | "findPayeeByAlias">,
  userId: string,
  text: string,
): Promise<ResolvedPayee | null> {
  const byName = await payees.findByName(userId, text);
  const found = byName ?? (await payees.findPayeeByAlias(userId, text));
  if (!found) return null;
  return {
    payeeId: found.id,
    payeeName: found.name,
    defaultCategoryId: found.defaultCategoryId,
    defaultCategoryName: found.defaultCategory?.name ?? null,
    via: byName ? "name" : "alias",
  };
}
