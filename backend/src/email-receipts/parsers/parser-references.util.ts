import { BadRequestException } from "@nestjs/common";
import { EntityManager, In } from "typeorm";
import { Category } from "../../categories/entities/category.entity";
import { tr } from "../../i18n/translate";
import { Payee } from "../../payees/entities/payee.entity";
import type { ReceiptParserValidationError } from "../parsing/receipt-parser.validation";

/**
 * Every payee and category a parser names must be the user's own. Read in the
 * transaction that writes the parser (the caller's manager), so a category
 * deleted between the check and the write cannot slip through, and a refusal
 * has written nothing.
 */
export async function assertParserReferencesOwned(
  m: EntityManager,
  userId: string,
  refs: { payeeId: string | null; categoryIds: readonly string[] },
): Promise<void> {
  if (refs.payeeId !== null) {
    const owned = await m
      .getRepository(Payee)
      .count({ where: { id: refs.payeeId, userId } });
    if (owned === 0) {
      throw new BadRequestException(
        tr(
          "errors.emailReceipts.parserPayeeNotFound",
          "The payee of this parser was not found.",
        ),
      );
    }
  }
  if (refs.categoryIds.length > 0) {
    const owned = await m.getRepository(Category).count({
      where: { userId, id: In([...refs.categoryIds]) },
    });
    if (owned !== refs.categoryIds.length) {
      throw new BadRequestException(
        tr(
          "errors.emailReceipts.parserCategoryNotFound",
          "A category named in this parser was not found.",
        ),
      );
    }
  }
}

/** `path: code` for every problem, the way a 400 lists them. */
export function describeValidationErrors(
  errors: readonly ReceiptParserValidationError[],
): string {
  return errors
    .map(
      (error) =>
        `${error.path === "" ? "(definition)" : error.path}: ${error.code}`,
    )
    .join("; ");
}

/** The 400 for a definition the validator refuses, listing every code it found. */
export function invalidDefinitionError(
  errors: readonly ReceiptParserValidationError[],
): BadRequestException {
  const codes = describeValidationErrors(errors);
  return new BadRequestException(
    tr(
      "errors.emailReceipts.parserDefinitionInvalid",
      `The parser definition is not valid: ${codes}`,
      { codes },
    ),
  );
}
