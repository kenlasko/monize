import { BadRequestException } from "@nestjs/common";
import { tr } from "../i18n/translate";
import { FIAT_MONEY_DECIMALS, roundMoney, sumMoney } from "./round.util";

/**
 * Shared validation for transaction/scheduled-transaction split amount totals.
 *
 * Confirms that the sum of the split amounts equals the parent transaction
 * amount at the parent currency's money precision (`options.decimals`,
 * `moneyDecimalsFor(currency.decimalPlaces)`: four for fiat, a coin's own
 * places up to eight), and that the minimum split count is met. Comparing at
 * fewer places than the currency carries would let lines that do not sum to
 * the parent appear to: `-0.00004 - 0.00004` against `-0.00008` BTC is
 * `0 !== -0.0001` at four places, and `-0.005` against `-0.005025` is equal.
 *
 * - The default minimum split count is 2.
 * - When {@link options.allowSinglePassthrough} is `true` (the default for
 *   transaction-level splits where a single transfer or investment split is
 *   considered a "pass-through"), exactly one split is allowed when it is a
 *   transfer or investment split (the caller filters by `predicate`).
 *
 * @throws BadRequestException when the count or sum constraints are violated.
 */
export function validateSplitAmountSum(
  splits: { amount: number }[],
  transactionAmount: number,
  options: {
    allowSinglePassthrough?: boolean;
    isPassthrough?: (split: unknown) => boolean;
    /**
     * The parent currency's money precision. Defaults to the fiat four; a
     * caller on an account-currency path passes `moneyDecimalsFor(...)` of the
     * parent account's currency.
     */
    decimals?: number;
  } = {},
): void {
  const decimals = options.decimals ?? FIAT_MONEY_DECIMALS;
  const allowSinglePassthrough = options.allowSinglePassthrough ?? false;

  const isPassthrough =
    allowSinglePassthrough &&
    splits.length === 1 &&
    (options.isPassthrough?.(splits[0]) ?? false);

  if (splits.length < 2 && !isPassthrough) {
    throw new BadRequestException(
      tr(
        "errors.common.splitMinCount",
        "Split transactions must have at least 2 splits",
      ),
    );
  }

  const roundedSum = sumMoney(
    splits.map((split) => Number(split.amount)),
    decimals,
  );
  const roundedAmount = roundMoney(Number(transactionAmount), decimals);

  if (roundedSum !== roundedAmount) {
    throw new BadRequestException(
      tr(
        "errors.common.splitAmountMismatch",
        `Split amounts (${roundedSum}) must equal transaction amount (${roundedAmount})`,
        { roundedSum, roundedAmount },
      ),
    );
  }

  // Mixed-sign children are deliberately NOT refused, although the split DTO
  // long documented "must be same sign as parent transaction" (audit P5-004
  // proposed enforcing it). Three facts decide it the other way:
  //
  // - The client has only ever validated the sum, and the importers write
  //   splits without this validator at all -- so real ledgers already hold
  //   mixed-sign splits, the canonical case being a paycheck: gross salary
  //   (+3,500) and withholdings (-500) under a +3,000 net deposit, which is
  //   how Microsoft Money models it and how its `.mny` files import. Each
  //   child there is individually true; the parent is a net by design.
  //   Enforcing the sign here would make that data uneditable (the form
  //   resends the full split set on every save) and silently stop its
  //   scheduled postings -- a 400 nobody sees, from a cron.
  //
  // - The reporting distortion P5-004 described ("income that never arrived")
  //   is resolved where it belongs: category surfaces read the children
  //   *signed* and net within the category (docs/backend/transactions-and-money.md, "What a category
  //   cost is its debits NET OF its credits" -- issue #1125), so a credit
  //   child reduces the category it is filed under instead of fabricating
  //   income beside it.
  //
  // - Investment splits require mixing (one brokerage line can sell
  //   (+proceeds), pay a fee (-) and buy (-) at once), and each such child is
  //   validated against its computed cash impact -- stricter than a sign rule.
  //
  // The signed-sum equality above remains the invariant: whatever the signs,
  // the children must account for exactly the parent's movement.
}
