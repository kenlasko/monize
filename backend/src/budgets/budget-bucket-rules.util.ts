import { BadRequestException } from "@nestjs/common";
import { decimalPlacesOf } from "../common/amount-precision.util";
import { tr } from "../i18n/translate";
import { BudgetBucketTargetType } from "./entities/budget-bucket.entity";

/**
 * The bucket rules of docs/future-plans/bucket-budget.md (decision 10, section
 * 6.4), as pure functions. `BudgetBucketsService` applies them to rows it has
 * read; the wizard apply (`BudgetGeneratorService.apply`) applies them to the
 * buckets of a request, so there is one copy of each rule.
 */
export const MAX_BUCKETS_PER_BUDGET = 12;
export const MAX_BUCKET_NAME_LENGTH = 50;
const MAX_PERCENT = 100;
const PERCENT_PLACES = 2;

/** A bucket already accepted: a stored row (with `id`) or a request item. */
export interface BucketNameSibling {
  id?: string;
  name: string;
}

/**
 * The trimmed name, or a refusal when it is not 1 to 50 characters or matches
 * a sibling ignoring case and surrounding space. `selfId` excludes the bucket
 * being renamed from the comparison.
 */
export function checkedBucketName(
  raw: string,
  siblings: BucketNameSibling[],
  selfId: string | null,
): string {
  const name = raw.trim();
  if (name.length < 1 || name.length > MAX_BUCKET_NAME_LENGTH) {
    throw new BadRequestException(
      tr(
        "errors.budgets.bucketNameInvalid",
        `A bucket name must be 1 to ${MAX_BUCKET_NAME_LENGTH} characters`,
        { max: MAX_BUCKET_NAME_LENGTH },
      ),
    );
  }
  const key = name.toLowerCase();
  if (
    siblings.some(
      (b) =>
        (b.id === undefined || b.id !== selfId) &&
        b.name.trim().toLowerCase() === key,
    )
  ) {
    throw new BadRequestException(
      tr(
        "errors.budgets.bucketNameDuplicate",
        "This budget already has a bucket with that name",
      ),
    );
  }
  return name;
}

/** A target above zero; a PERCENT target also at most 100 with two decimals. */
export function checkBucketTarget(
  type: BudgetBucketTargetType,
  value: number,
): void {
  if (!(value > 0)) {
    throw new BadRequestException(
      tr(
        "errors.budgets.bucketTargetInvalid",
        "A bucket target must be greater than zero",
      ),
    );
  }
  if (
    type === BudgetBucketTargetType.PERCENT &&
    (value > MAX_PERCENT || decimalPlacesOf(value) > PERCENT_PLACES)
  ) {
    throw new BadRequestException(
      tr(
        "errors.budgets.bucketPercentInvalid",
        "A percent target must be greater than 0 and at most 100, with at most two decimals",
      ),
    );
  }
}

/** The cap (or null), refused when set on a bucket that does not carry over. */
export function checkedBucketCarryCap(
  carryOver: boolean,
  carryCap: number | null,
): number | null {
  if (carryCap === null) return null;
  if (!carryOver) {
    throw new BadRequestException(
      tr(
        "errors.budgets.bucketCarryCapNeedsCarryOver",
        "A carry cap needs carry-over turned on",
      ),
    );
  }
  return carryCap;
}
