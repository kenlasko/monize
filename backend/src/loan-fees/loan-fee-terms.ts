import { BadRequestException } from "@nestjs/common";
import { EntityManager, In } from "typeorm";
import { Category } from "../categories/entities/category.entity";
import { tr } from "../i18n/translate";
import {
  LoanFeeFacts,
  LoanFeeTerms,
  priceLoanFee,
  priceLoanFees,
} from "../loan-installments/loan-fees";
import { LoanFeeDto } from "./dto/loan-fee.dto";

/**
 * The checks every write of a mortgage's fees runs before it writes
 * (`docs/specs/mortgage-fees.md` section 7), shared by the mortgage create
 * and `LoanFeesService.replace`: the shape of each fee, one fee per
 * category, never the interest category, and categories the caller owns.
 */

/** The fees of a request as `loan_fees` stores them, refusing a malformed one. */
export function normalizeLoanFees(dtos: readonly LoanFeeDto[]): LoanFeeTerms[] {
  const seen = new Set<string>();
  return dtos.map((dto) => {
    if (seen.has(dto.categoryId)) {
      throw new BadRequestException(
        tr(
          "errors.loanFees.duplicateCategory",
          "Each mortgage fee needs its own category.",
        ),
      );
    }
    seen.add(dto.categoryId);
    const fixed = dto.calculation === "FIXED";
    const amount = dto.amount ?? null;
    const rate = dto.rate ?? null;
    if (
      fixed
        ? amount === null || rate !== null
        : rate === null || amount !== null
    ) {
      throw new BadRequestException(
        tr(
          "errors.loanFees.valueMismatch",
          "A fixed fee takes an amount and a percentage fee takes a rate.",
        ),
      );
    }
    return {
      categoryId: dto.categoryId,
      name: dto.name.trim(),
      calculation: dto.calculation,
      basis: dto.basis,
      amount: fixed ? amount : null,
      rate: fixed ? null : rate,
    };
  });
}

/**
 * Refuse a fee on the mortgage's interest category or on a category the
 * caller does not own. Runs inside the caller's transaction, before any write.
 */
export async function assertLoanFeeCategories(
  m: EntityManager,
  userId: string,
  fees: readonly LoanFeeTerms[],
  interestCategoryId: string | null | undefined,
): Promise<void> {
  if (fees.length === 0) return;
  if (fees.some((fee) => fee.categoryId === interestCategoryId)) {
    throw new BadRequestException(
      tr(
        "errors.loanFees.interestCategory",
        "A mortgage fee cannot use the mortgage's interest category.",
      ),
    );
  }
  const ids = fees.map((fee) => fee.categoryId);
  const owned = await m.getRepository(Category).find({
    where: { id: In(ids), userId },
  });
  if (owned.length !== new Set(ids).size) {
    throw new BadRequestException(
      tr(
        "errors.loanFees.invalidCategory",
        "Choose one of your own categories for each mortgage fee.",
      ),
    );
  }
}

/** One fee's line of a new template: unsigned amount, memo the fee's name. */
export interface FeeTemplateLine {
  readonly categoryId: string;
  readonly memo: string;
  readonly amount: number;
}

/**
 * The fee lines of a template's installment, priced at `facts`
 * (`priceLoanFees`, the loop the template rewrite prices through), and
 * their total. A fee that cannot be priced is refused (400): a write never
 * stores a guessed line.
 */
export function priceFeeTemplateLines(
  fees: readonly LoanFeeTerms[],
  facts: LoanFeeFacts,
): { lines: FeeTemplateLine[]; total: number } {
  const priced = priceLoanFees(fees, facts);
  if (priced.kind === "unknown") {
    const fee = fees.find((f) => priceLoanFee(f, facts).kind === "unknown");
    const name = fee?.name ?? "";
    throw new BadRequestException(
      tr(
        "errors.loanFees.unpriceable",
        `The fee "${name}" cannot be worked out: the mortgage has no original principal. Enter the amount originally borrowed first.`,
        { name },
      ),
    );
  }
  return {
    lines: fees.map((fee, i) => ({
      categoryId: fee.categoryId,
      memo: fee.name,
      amount: priced.amounts[i],
    })),
    total: priced.total,
  };
}
