import {
  KmyAccount,
  KmyRawFile,
  KmySchedule,
  KmySplit,
  KmyTransaction,
} from "../model/kmy-raw";
import {
  KmyRounding,
  Rational,
  compare,
  isZero,
  roundToDenominator,
} from "../model/kmy-rational";
import { KMY_TYPE } from "./kmy-account-tree";

/**
 * The only file fixes that change an amount KMyMoney shows, applied to the raw
 * model before anything is mapped or verified, so the importer and its
 * verification read the file as KMyMoney itself shows it after opening it
 * (spec 5.1, reference 2.3).
 *
 * KMyMoney's `applyFileFixes` (`kmymoney/mymoney/mymoneyfile.cpp`) steps one
 * level at a time from the file's FIXVERSION to 12. Of `fixFile_0` ...
 * `fixFile_11`, only `fixFile_0` -- run for a file at level 0 and no other --
 * touches a split's value or shares:
 *
 *  - `fixTransactions_0`: an empty transaction commodity becomes the base
 *    currency; then, split by split, when the split account's currency is the
 *    transaction commodity and `value != shares`, `shares := value`; then, for
 *    every split not on a stock account (`isInvest`), when `shares` is not at
 *    the account's fraction, both `shares` and `value` are converted to it with
 *    `AlkValue::RoundRound` (round half to even). The fraction is the account
 *    currency's (or security's) smallest account fraction, its smallest cash
 *    fraction for a cash account; an account whose currency is unknown is left
 *    alone (the C++ catches the exception and moves on).
 *  - `fixSchedule_0`: a template with no commodity takes the first split's
 *    account currency, and a split with zero shares and a non-zero value gets
 *    `shares := value`.
 *
 * A file at any other level is returned unchanged: the XML reader never
 * compensates (`mymoneyxmlreader.cpp`, `readSplit`) and a balance is the sum of
 * `shares` (`AccountBalances::operator+=`).
 */
export function applyKmyFileFixes(
  raw: KmyRawFile,
  baseCurrency: string,
): KmyRawFile {
  if (raw.fileInfo.fixVersion !== 0) {
    return raw;
  }
  const accounts = new Map(
    raw.accounts.map((account) => [account.id, account]),
  );
  const fractions = new Map<string, { saf: bigint; scf: bigint }>();
  for (const currency of raw.currencies) {
    fractions.set(currency.id, { saf: currency.saf, scf: currency.scf });
  }
  for (const security of raw.securities) {
    fractions.set(security.id, { saf: security.saf, scf: security.saf });
  }

  const fractionOf = (account: KmyAccount): bigint | null => {
    // `MyMoneyFile::security("")` is the base currency.
    const found = fractions.get(account.currency || baseCurrency);
    if (!found) {
      return null;
    }
    return account.type === KMY_TYPE.CASH ? found.scf : found.saf;
  };

  const fixSplit = (split: KmySplit, commodity: string): KmySplit => {
    const account = accounts.get(split.account);
    if (!account) {
      return split;
    }
    let { value, shares } = split;
    if (account.currency === commodity && compare(value, shares) !== 0) {
      shares = value;
    }
    const fraction =
      account.type === KMY_TYPE.STOCK ? null : fractionOf(account);
    if (fraction !== null && fraction > 0n) {
      const rounded = roundToFraction(shares, fraction);
      if (compare(rounded, shares) !== 0) {
        shares = rounded;
        value = roundToFraction(value, fraction);
      }
    }
    return value === split.value && shares === split.shares
      ? split
      : { ...split, value, shares };
  };

  const fixTransaction = (transaction: KmyTransaction): KmyTransaction => {
    const commodity = transaction.commodity?.trim() || baseCurrency;
    return {
      ...transaction,
      commodity,
      splits: transaction.splits.map((split) => fixSplit(split, commodity)),
    };
  };

  const fixSchedule = (schedule: KmySchedule): KmySchedule => {
    const template = schedule.template;
    if (!template) {
      return schedule;
    }
    const first = template.splits[0]
      ? accounts.get(template.splits[0].account)
      : undefined;
    const commodity =
      template.commodity?.trim() || first?.currency || template.commodity;
    return {
      ...schedule,
      template: {
        ...template,
        commodity,
        splits: template.splits.map((split) =>
          split.shares !== "autoCalc" &&
          split.value !== "autoCalc" &&
          isZero(split.shares) &&
          !isZero(split.value)
            ? { ...split, shares: split.value }
            : split,
        ),
      },
    };
  };

  return {
    ...raw,
    transactions: raw.transactions.map(fixTransaction),
    schedules: raw.schedules.map(fixSchedule),
  };
}

function roundToFraction(a: Rational, fraction: bigint): Rational {
  return roundToDenominator(a, fraction, KmyRounding.Round);
}
