import { SplitKind } from "../../../transactions/entities/split-kind.enum";
import { MappedBillSplit } from "../../mny/model/mny-import-model";
import { KmySchedule, KmyTemplateSplit } from "../model/kmy-raw";
import {
  Rational,
  abs,
  isZero,
  neg,
  parseKmyNumber,
  sum,
} from "../model/kmy-rational";
import { KMY_TYPE } from "./kmy-account-tree";
import {
  amountPlaces,
  legRational,
  toUnits,
  unitsToNumber,
} from "./kmy-amounts";
import { rawCurrencyOf } from "./kmy-map-accounts";
import { KmyMapContext } from "./kmy-row-builder";

/**
 * Spec 5.10.3: the account, amount, category or transfer and legs a schedule's
 * template becomes, including the loan-payment simplification.
 */

type Fixed = KmyTemplateSplit & { value: Rational; shares: Rational };

export function isFixed(split: KmyTemplateSplit): split is Fixed {
  return split.value !== "autoCalc" && split.shares !== "autoCalc";
}

export interface Shape {
  readonly loan: boolean;
  readonly accountKey: string;
  readonly currencyCode: string;
  readonly amount: number;
  readonly categoryHandle: number | null;
  readonly transferAccountKey: string | null;
  readonly splits: readonly MappedBillSplit[];
  readonly memo: string;
}

function abs0(units: bigint): bigint {
  return units < 0n ? -units : units;
}

function commodity(context: KmyMapContext, schedule: KmySchedule): string {
  return schedule.template?.commodity?.trim() || context.mapping.baseCurrency;
}

/** The category handle (account ordinal) of a category or equity split's account. */
function categoryHandle(
  context: KmyMapContext,
  accountId: string,
  type: number,
): number | null {
  const account = context.tree.byId.get(accountId);
  return account &&
    (type === KMY_TYPE.INCOME ||
      type === KMY_TYPE.EXPENSE ||
      type === KMY_TYPE.EQUITY)
    ? account.ordinal
    : null;
}

/** Account, amount, category/transfer and legs of the template (spec 5.10.3). */
export function scheduleShape(
  context: KmyMapContext,
  schedule: KmySchedule,
  splits: readonly KmyTemplateSplit[],
  assets: readonly KmyTemplateSplit[],
): Shape | null {
  const keyOf = (split: KmyTemplateSplit): string | undefined =>
    context.mapping.keyById.get(split.account);
  const currencyOfKey = (key: string): string =>
    context.mapping.currencyByKey.get(key) as string;
  const numberOf = (value: Rational, currency: string): number =>
    unitsToNumber(
      toUnits(value, amountPlaces(currency, context.coinDecimals)),
      amountPlaces(currency, context.coinDecimals),
    );

  // Loan payments: the amortization and interest are computed at entry time.
  const loanType = (split: KmyTemplateSplit): boolean =>
    [KMY_TYPE.LOAN, KMY_TYPE.ASSET_LOAN].includes(
      context.tree.byId.get(split.account)?.type as 5 | 14,
    );
  const hasAutoCalc = splits.some((split) => !isFixed(split));
  if (schedule.type === 5 || hasAutoCalc) {
    const loan = assets.find(loanType);
    const payment = assets.find((split) => split !== loan);
    if (!loan || !payment) {
      return null;
    }
    const paymentKey = keyOf(payment);
    if (paymentKey === undefined) {
      return null;
    }
    let amount: Rational;
    if (isFixed(payment)) {
      amount = payment.shares;
    } else {
      const periodic = parseKmyNumber(
        context.tree.byId.get(loan.account)?.kvp.get("periodic-payment") ?? "",
      );
      if (periodic.kind !== "value" || isZero(periodic.value)) {
        return null;
      }
      amount = neg(abs(periodic.value));
    }
    const loanKey = keyOf(loan);
    return {
      loan: true,
      accountKey: paymentKey,
      currencyCode: currencyOfKey(paymentKey),
      amount: numberOf(amount, currencyOfKey(paymentKey)),
      categoryHandle: null,
      transferAccountKey: loanKey ?? null,
      splits: [],
      memo: payment.memo,
    };
  }

  const parent = assets[0] as Fixed;
  const parentKey = keyOf(parent);
  if (parentKey === undefined) {
    return null;
  }
  const currency = currencyOfKey(parentKey);
  const fixed = splits as readonly Fixed[];
  const base = {
    loan: false,
    accountKey: parentKey,
    currencyCode: currency,
    amount: numberOf(parent.shares, currency),
    memo: parent.memo,
  };
  if (splits.length === 1) {
    return {
      ...base,
      categoryHandle: null,
      transferAccountKey: null,
      splits: [],
    };
  }
  if (splits.length === 2) {
    const other = fixed.find((split) => split !== parent) as Fixed;
    const otherType = context.tree.byId.get(other.account)?.type as number;
    if (assets.includes(other)) {
      return {
        ...base,
        categoryHandle: null,
        transferAccountKey: keyOf(other) ?? null,
        splits: [],
      };
    }
    return {
      ...base,
      categoryHandle: categoryHandle(context, other.account, otherType),
      transferAccountKey: null,
      splits: [],
    };
  }

  // Three or more splits: legs as spec 5.6.3, the first asset split the parent.
  const parentAccount = context.tree.byId.get(parent.account);
  const parentInCommodity =
    parentAccount !== undefined &&
    rawCurrencyOf(parentAccount, context.mapping.baseCurrency) ===
      commodity(context, schedule);
  const places = amountPlaces(currency, context.coinDecimals);
  const others = fixed.filter((split) => split !== parent);
  // A parent of value 0 has no ratio: a leg in the parent's own currency is
  // `-shares`, any other leaves the template unbalanced (spec 5.6.3).
  let ratioless = false;
  const legUnits = others.map((other) => {
    const exact = legRational(
      other.value,
      parent.value,
      parent.shares,
      parentInCommodity,
    );
    if (exact !== null) {
      return toUnits(exact, places);
    }
    const otherAccount = context.tree.byId.get(other.account);
    if (
      otherAccount !== undefined &&
      parentAccount !== undefined &&
      rawCurrencyOf(otherAccount, context.mapping.baseCurrency) ===
        rawCurrencyOf(parentAccount, context.mapping.baseCurrency)
    ) {
      return toUnits(neg(other.shares), places);
    }
    ratioless = true;
    return 0n;
  });
  const parentUnits = toUnits(parent.shares, places);
  let residual =
    parentUnits - legUnits.reduce((total, units) => total + units, 0n);
  const balanced = !ratioless && isZero(sum(fixed.map((split) => split.value)));
  const legs: MappedBillSplit[] = others.map((other, index) => {
    const key = keyOf(other);
    const isAsset = assets.includes(other);
    return {
      kind:
        isAsset && key !== undefined ? SplitKind.TRANSFER : SplitKind.CATEGORY,
      categoryHandle: isAsset
        ? null
        : categoryHandle(
            context,
            other.account,
            context.tree.byId.get(other.account)?.type as number,
          ),
      transferAccountKey: isAsset ? (key ?? null) : null,
      amount: unitsToNumber(legUnits[index], places),
      memo: other.memo.trim() === "" ? null : other.memo,
    };
  });
  if (balanced && residual !== 0n && legs.length > 0) {
    let target = 0;
    legUnits.forEach((units, index) => {
      if (abs0(units) > abs0(legUnits[target])) target = index;
    });
    legs[target] = {
      ...legs[target],
      amount: unitsToNumber(legUnits[target] + residual, places),
    };
    residual = 0n;
  }
  if (!balanced) {
    legs.push({
      kind: SplitKind.CATEGORY,
      categoryHandle: null,
      transferAccountKey: null,
      amount: unitsToNumber(residual, places),
      memo: null,
    });
  }
  return {
    ...base,
    categoryHandle: null,
    transferAccountKey: null,
    splits: legs,
  };
}
