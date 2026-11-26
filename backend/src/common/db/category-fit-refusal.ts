import { QueryFailedError } from "typeorm";
import { tr } from "../../i18n/translate";

/**
 * The database's FIT backstop (`database/schema.sql`) refuses a Transfer
 * category on a category row with SQLSTATE 23514 and its own constraint name,
 * `category_fits_row` (INV-CATEGORY-001). Only that name is a client error:
 * every other 23514 (a CHECK such as `chk_split_kind_exclusive`) marks a defect
 * and stays a 500. The message is the generic one: the trigger does not know
 * which category it refused, and the service paths that do name it refuse
 * before the write.
 */
export function categoryFitsRefusal(error: unknown): string | null {
  if (
    !(error instanceof QueryFailedError) ||
    error.driverError?.code !== "23514" ||
    error.driverError?.constraint !== "category_fits_row"
  ) {
    return null;
  }
  return tr(
    "errors.categories.transferCategoryOnCategoryRowGeneric",
    "A Transfer category can go only on a transfer",
  );
}
