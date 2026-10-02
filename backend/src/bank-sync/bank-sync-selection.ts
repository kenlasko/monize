import { BadRequestException } from "@nestjs/common";
import { tr } from "../i18n/translate";

/**
 * What the person chose in the preview (spec section 7b): the keys to import and
 * the keys to add to the exceptions. Every other new row stays as it was.
 */
export interface BankSyncSelection {
  importKeys: readonly string[];
  excludeKeys: readonly string[];
}

/**
 * The selection a request carries, or undefined when it carries neither list: a
 * sync without one imports every new row, as it always did. Either list given
 * makes a selection, and the other is then empty (an empty `importKeys` imports
 * nothing; it is not "absent").
 */
export function selectionOf(
  importKeys: readonly string[] | undefined,
  excludeKeys: readonly string[] | undefined,
): BankSyncSelection | undefined {
  if (importKeys === undefined && excludeKeys === undefined) return undefined;
  return { importKeys: importKeys ?? [], excludeKeys: excludeKeys ?? [] };
}

/**
 * Refuses (400) a key that is in both lists: a bank transaction cannot be
 * imported and excepted at once. Checked before the bank is read and again by
 * the write, so the write never depends on its caller having asked.
 */
export function assertDisjointSelection(selection: BankSyncSelection): void {
  const importing = new Set(selection.importKeys);
  if (selection.excludeKeys.some((key) => importing.has(key))) {
    throw new BadRequestException(
      tr(
        "errors.bankSync.selectionOverlap",
        "A transaction cannot be both imported and added to the exceptions.",
      ),
    );
  }
}
