import { InvestmentAction } from "../../../securities/entities/investment-transaction.entity";
import { derivePriceFromTotal } from "../../../securities/investment-amount.util";
import { KmySplit } from "../model/kmy-raw";
import {
  Rational,
  ZERO,
  abs,
  add,
  div,
  isZero,
  neg,
  sign,
  sub,
  sum,
} from "../model/kmy-rational";
import { priceNumber, quantityNumber } from "./kmy-amounts";
import { KmyDissection } from "./kmy-dissect";

/**
 * Spec 5.7.2: the activity table. One pure function from a dissected
 * transaction (amounts already in the security's currency) to the action,
 * quantity, total, commission and derived price of the row.
 */

export interface TradeAmounts {
  readonly action: InvestmentAction;
  readonly quantity: number | null;
  /** The executed total, a magnitude in the security's currency. */
  readonly total: Rational;
  readonly commission: Rational;
  readonly price: number | null;
  /** Whether the asset split's cash is this row's cash (share-only actions move none). */
  readonly withCash: boolean;
  /** The income split whose category the row carries. */
  readonly categorySplit: KmySplit | null;
  /** Income on a buy or a sale: each becomes an INTEREST companion row. */
  readonly companions: readonly { split: KmySplit; amount: Rational }[];
}

/**
 * `null` when the transaction cannot import as a trade: a buy or sale of no
 * shares, or a total below zero (spec 5.7.6).
 */
export function tradeAmounts(
  d: KmyDissection,
  convert: (value: Rational) => Rational,
  money: (value: Rational) => number,
): TradeAmounts | null {
  const stock = d.stock;
  const asset = d.asset;
  const shares = stock.shares;
  const sumFees = sum(d.fees.map((split) => convert(split.value)));
  const firstIncome = d.income.length > 0 ? d.income[0] : null;
  const shareOnly = {
    total: ZERO,
    commission: ZERO,
    price: null,
    withCash: false,
    categorySplit: null,
    companions: [],
  };

  switch (d.activity) {
    case "BuyShares":
    case "SellShares": {
      const selling = d.activity === "SellShares";
      const quantityRational = selling ? neg(shares) : shares;
      let commission = sumFees;
      // An income split on a trade is accrued interest: a companion row, or
      // a fee when it is not income.
      const companions: { split: KmySplit; amount: Rational }[] = [];
      for (const income of d.income) {
        const gross = neg(convert(income.value));
        if (sign(gross) > 0) {
          companions.push({ split: income, amount: gross });
        } else {
          commission = add(commission, convert(income.value));
        }
      }
      const base = selling ? neg(convert(stock.value)) : convert(stock.value);
      const total = selling ? sub(base, commission) : add(base, commission);
      const quantity = quantityNumber(quantityRational);
      if (quantity <= 0 || sign(total) < 0) {
        return null;
      }
      const action = selling ? InvestmentAction.SELL : InvestmentAction.BUY;
      const price =
        derivePriceFromTotal({
          action,
          totalAmount: money(total),
          quantity,
          commission: money(commission),
        }) ?? priceNumber(div(abs(convert(stock.value)), quantityRational));
      return {
        action,
        quantity,
        total,
        commission,
        price,
        withCash: true,
        categorySplit: null,
        companions,
      };
    }
    case "Dividend":
    case "Yield":
    case "IntIncome": {
      const action =
        d.activity === "IntIncome"
          ? InvestmentAction.INTEREST
          : InvestmentAction.DIVIDEND;
      const total =
        d.income.length > 0
          ? neg(sum(d.income.map((split) => convert(split.value))))
          : add(asset ? convert(asset.value) : ZERO, sumFees);
      if (sign(total) < 0) {
        return null;
      }
      return {
        action,
        quantity: null,
        total,
        commission: sumFees,
        price: derivePriceFromTotal({
          action,
          totalAmount: money(total),
          quantity: null,
          commission: money(sumFees),
        }),
        withCash: true,
        categorySplit: firstIncome,
        companions: [],
      };
    }
    case "Reinvest": {
      const quantityRational = abs(shares);
      const total = add(convert(stock.value), sumFees);
      if (sign(total) < 0) {
        return null;
      }
      return {
        action: InvestmentAction.REINVEST,
        quantity: quantityNumber(quantityRational),
        total,
        commission: sumFees,
        price: isZero(quantityRational)
          ? null
          : priceNumber(div(convert(stock.value), shares)),
        withCash: asset !== null,
        categorySplit: firstIncome,
        companions: [],
      };
    }
    case "AddShares":
    case "RemoveShares":
      return {
        ...shareOnly,
        action:
          d.activity === "AddShares"
            ? InvestmentAction.ADD_SHARES
            : InvestmentAction.REMOVE_SHARES,
        quantity: quantityNumber(abs(shares)),
      };
    case "Split":
      return {
        ...shareOnly,
        action: InvestmentAction.SPLIT,
        quantity: quantityNumber(shares),
      };
  }
}
