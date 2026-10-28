import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from "@nestjs/common";
import { tr } from "../i18n/translate";

export const accrualErrors = {
  ruleUnsupported: () =>
    new BadRequestException(
      tr(
        "errors.accruals.ruleUnsupported",
        "For accrued entries, run rules manually after reviewing the impact. Keep the transaction structure and choose an existing payee.",
      ),
    ),

  historyUnsupported: () =>
    new ConflictException(
      tr(
        "errors.accruals.historyUnsupported",
        "This batch cannot be safely restored from history. Split the batch or remove unsupported transfer or investment entries.",
      ),
    ),
  missing: () =>
    new NotFoundException(
      tr(
        "errors.accruals.notFound",
        "The transaction or accrual schedule was not found.",
      ),
    ),
  ineligible: () =>
    new BadRequestException(
      tr(
        "errors.accruals.ineligible",
        "Choose an income or expense transaction, or a category split. Transfers, investment entries and void transactions cannot be accrued.",
      ),
    ),
  period: () =>
    new BadRequestException(
      tr(
        "errors.accruals.invalidPeriod",
        "Choose a valid start month and between 1 and 600 months.",
      ),
    ),
  conflict: () =>
    new ConflictException(
      tr(
        "errors.accruals.changed",
        "The transaction or schedule changed. Review a fresh preview before saving.",
      ),
    ),
  owner: () =>
    new ForbiddenException(
      tr(
        "errors.accruals.ownerOnly",
        "Only the owner can manage accrual schedules.",
      ),
    ),
  family: () =>
    new BadRequestException(
      tr(
        "errors.accruals.familyRequired",
        "Choose expense or income for an uncategorized transaction.",
      ),
    ),
};
