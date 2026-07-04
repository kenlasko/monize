import { QueryFailedError, QueryRunner } from "typeorm";
import { PayeeAlias } from "./entities/payee-alias.entity";

/**
 * Insert a payee alias inside the caller's transaction, tolerating the
 * `payee_aliases` UNIQUE(user_id, LOWER(alias)) constraint. In-app conflict
 * checks cannot perfectly mirror that index (pattern matching, or a check-then-
 * insert race across concurrent transactions), so on a duplicate the insert is
 * rolled back to a savepoint and the function returns false ("skipped") instead
 * of poisoning the caller's transaction and aborting the whole operation. Any
 * other database error is rethrown. Returns true when the alias was created.
 *
 * The alias is a best-effort convenience on top of a merge/create, not the point
 * of it, so a lost alias must never roll back the reassignment work around it.
 */
export async function insertPayeeAliasIgnoringDuplicate(
  queryRunner: QueryRunner,
  alias: PayeeAlias,
  savepoint = "insert_payee_alias",
): Promise<boolean> {
  await queryRunner.query(`SAVEPOINT ${savepoint}`);
  try {
    await queryRunner.manager.save(alias);
    await queryRunner.query(`RELEASE SAVEPOINT ${savepoint}`);
    return true;
  } catch (error) {
    await queryRunner.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
    const isUniqueViolation =
      error instanceof QueryFailedError &&
      (error.driverError as { code?: string })?.code === "23505";
    if (!isUniqueViolation) {
      throw error;
    }
    return false;
  }
}
