import { LOAN_LIKE_ACCOUNT_TYPES } from '@/lib/minor-unit-booking';
import { roundMoney } from '@/lib/format';
import type { LoanOccurrence, ScheduledTransaction } from '@/types/scheduled-transaction';

/**
 * Whether a schedule may be a loan bill the server prices per occurrence:
 * a non-investment schedule moving money into a loan-like account, on its
 * own transfer or on a split line. Only a candidate is asked for its
 * projection; the server's `status` decides whether it IS one
 * (`docs/specs/scheduled-loan-installment-pricing.md` 8.1).
 */
export function isLoanBillCandidate(st: ScheduledTransaction): boolean {
  if (st.isInvestment) return false;
  const isLoanLike = (accountType: string | undefined | null) =>
    !!accountType && LOAN_LIKE_ACCOUNT_TYPES.has(accountType);
  if (isLoanLike(st.transferAccount?.accountType)) return true;
  return (st.splits ?? []).some((split) => isLoanLike(split.transferAccount?.accountType));
}

/** A line of a loan template, as the override editor holds it. */
interface LoanTemplateLine {
  transferAccountId?: string | null;
  categoryId?: string | null;
  memo?: string | null;
  amount: number;
}

type LoanLineRole = 'principal' | 'interest' | 'extraPrincipal' | `fee:${string}`;

/**
 * The role of each template line, identified as the server's
 * `identifyLoanTemplate` does: a transfer into the loan whose memo names
 * "extra" is the extra principal, the other transfer into the loan the
 * principal, a category line on one of the occurrence's fee categories that
 * fee's line (docs/specs/mortgage-fees.md section 6), and the one remaining
 * line the interest. Null when the lines are not that shape, which a
 * `priced` projection rules out.
 */
function loanLineRoles(
  lines: readonly LoanTemplateLine[],
  loanAccountId: string,
  feeCategoryIds: ReadonlySet<string>,
): LoanLineRole[] | null {
  const roles: LoanLineRole[] = [];
  const isExtra = (line: LoanTemplateLine) =>
    line.transferAccountId === loanAccountId && (line.memo ?? '').toLowerCase().includes('extra');
  const extraIndex = lines.findIndex(isExtra);
  for (const [index, line] of lines.entries()) {
    const role: LoanLineRole =
      index === extraIndex
        ? 'extraPrincipal'
        : line.transferAccountId === loanAccountId
          ? 'principal'
          : !line.transferAccountId && line.categoryId && feeCategoryIds.has(line.categoryId)
            ? `fee:${line.categoryId}`
            : 'interest';
    if (roles.includes(role)) return null;
    roles.push(role);
  }
  return roles.includes('interest') ? roles : null;
}

/**
 * The template's lines carrying one projected occurrence's figures, signed
 * as the template's own lines are (`sign` is the bill's direction): the
 * principal, interest and extra principal the server priced at the
 * occurrence's due date (INV-LOAN-009), never the template's stored split.
 *
 * Null when a figure is unknown (an incomplete occurrence), when the lines
 * are not the loan shape, or when the occurrence carries an extra principal
 * the template has no line for: the caller then does not present the
 * template's lines as this occurrence's.
 */
export function loanOccurrenceLines<T extends LoanTemplateLine>(
  lines: readonly T[],
  occurrence: LoanOccurrence,
  loanAccountId: string | null,
  sign: 1 | -1,
): T[] | null {
  const { principal, interest, extraPrincipal } = occurrence;
  // An older server answers no `fees`: no line is a fee's. A null is an
  // unknown, so the occurrence's lines are not presented.
  const fees = occurrence.fees === undefined ? [] : occurrence.fees;
  if (
    !loanAccountId ||
    principal === null ||
    interest === null ||
    extraPrincipal === null ||
    fees === null
  ) {
    return null;
  }
  const roles = loanLineRoles(lines, loanAccountId, new Set(fees.map((f) => f.categoryId)));
  if (!roles) return null;
  if (extraPrincipal !== 0 && !roles.includes('extraPrincipal')) return null;
  if (principal !== 0 && !roles.includes('principal')) return null;
  if (fees.some((f) => !roles.includes(`fee:${f.categoryId}`))) return null;
  const figure: Record<LoanLineRole, number> = { principal, interest, extraPrincipal };
  for (const fee of fees) figure[`fee:${fee.categoryId}`] = fee.amount;
  return lines.map((line, index) => ({
    ...line,
    amount: roundMoney(sign * figure[roles[index]]),
  }));
}
