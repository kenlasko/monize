import { ConflictException } from "@nestjs/common";
import { tr } from "../../i18n/translate";

/**
 * One kind of row that still points at a record, for a refusal of the form
 * "this record is used elsewhere". `ids` names the rows when the client needs
 * them to link to the items (a loan account has its own page).
 */
export interface RecordInUseEntry {
  kind: string;
  count: number;
  ids?: string[];
}

export const RECORD_IN_USE_CODE = "RECORD_IN_USE";

/** "transactions (3), warranties (1)": each kind's label comes from `errors.recordInUse.kinds.<kind>`. */
export function recordInUseSummary(entries: RecordInUseEntry[]): string {
  return entries
    .map(
      ({ kind, count }) =>
        `${tr(`errors.recordInUse.kinds.${kind}`, kind)} (${count})`,
    )
    .join(", ");
}

/**
 * The 409 for a delete (or an undo of a create) that would clear or orphan
 * rows outside the record. `message` names the counts in words; `errors` lists
 * them for the client, which links each kind to where the items can be seen
 * (`HttpErrorBody` forwards `errorCode` and `errors`).
 */
export function recordInUseException(
  message: string,
  entries: RecordInUseEntry[],
): ConflictException {
  return new ConflictException({
    message,
    errorCode: RECORD_IN_USE_CODE,
    errors: entries,
  });
}
