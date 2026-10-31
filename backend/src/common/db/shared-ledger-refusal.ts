import { QueryFailedError } from "typeorm";
import { tr } from "../../i18n/translate";

/** Only the dedicated ledger trigger code is public; never return driver text. */
export function sharedLedgerRefusal(error: unknown): string | null {
  if (
    !(error instanceof QueryFailedError) ||
    error.driverError?.code !== "PSE01"
  )
    return null;
  return tr(
    "sharedExpenses.managedLedger",
    "Review or unlink this transaction in Shared expenses before changing its financial values.",
  );
}
