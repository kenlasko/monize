import { BadRequestException } from "@nestjs/common";
import { tr } from "../i18n/translate";

/**
 * What the person chose in the preview (spec section 7b): the keys to import and
 * the keys to add to the exceptions. Every other new row stays as it was.
 *
 * The three lists of possible duplicates (docs/specs/import-duplicate-review.md
 * section 4): `mergeKeys` are merged into the existing transaction they pair
 * with, `keepKeys` are linked to it and leave it as it is, `replaceKeys` are
 * imported after it is deleted. A possible duplicate in `importKeys` is
 * imported beside it; in `excludeKeys`, added to the exceptions.
 */
export interface BankSyncSelection {
  importKeys: readonly string[];
  excludeKeys: readonly string[];
  mergeKeys: readonly string[];
  keepKeys: readonly string[];
  replaceKeys: readonly string[];
}

/** The lists a sync request may carry, as the DTO reads them. */
export interface BankSyncSelectionLists {
  importKeys?: readonly string[];
  excludeKeys?: readonly string[];
  mergeKeys?: readonly string[];
  keepKeys?: readonly string[];
  replaceKeys?: readonly string[];
}

/**
 * The selection a request carries, or undefined when it carries no list: a
 * sync without one imports every new row that is not a possible duplicate, as
 * it always did. Any list given makes a selection, and the others are then
 * empty (an empty `importKeys` imports nothing; it is not "absent").
 */
export function selectionOf(
  lists: BankSyncSelectionLists | undefined,
): BankSyncSelection | undefined {
  if (
    lists === undefined ||
    (lists.importKeys === undefined &&
      lists.excludeKeys === undefined &&
      lists.mergeKeys === undefined &&
      lists.keepKeys === undefined &&
      lists.replaceKeys === undefined)
  ) {
    return undefined;
  }
  return {
    importKeys: lists.importKeys ?? [],
    excludeKeys: lists.excludeKeys ?? [],
    mergeKeys: lists.mergeKeys ?? [],
    keepKeys: lists.keepKeys ?? [],
    replaceKeys: lists.replaceKeys ?? [],
  };
}

/** Whether the selection decides about a possible duplicate in a way that names its existing transaction. */
export function namesExistingTransactions(
  selection: BankSyncSelection,
): boolean {
  return (
    selection.mergeKeys.length > 0 ||
    selection.keepKeys.length > 0 ||
    selection.replaceKeys.length > 0
  );
}

/**
 * Refuses (400) a key that is in two lists: a bank transaction cannot be
 * imported and excepted at once, nor merged and kept. Checked before the bank
 * is read and again by the write, so the write never depends on its caller
 * having asked.
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
  const seen = new Set<string>();
  for (const list of [
    selection.importKeys,
    selection.excludeKeys,
    selection.mergeKeys,
    selection.keepKeys,
    selection.replaceKeys,
  ]) {
    for (const key of new Set(list)) {
      if (seen.has(key)) {
        throw new BadRequestException(
          tr(
            "errors.bankSync.selectionConflict",
            "A transaction can have only one decision: import it, add it to the exceptions, merge it, keep yours or replace yours.",
          ),
        );
      }
      seen.add(key);
    }
  }
}
