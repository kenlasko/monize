import { EntityManager, In } from "typeorm";
import { Account, AccountSubType } from "../accounts/entities/account.entity";
import { UserPreference } from "../users/entities/user-preference.entity";
import { preferredCurrency } from "../common/default-currency.util";
import {
  buildRateIndex,
  RateIndex,
  resolveIndexedRate,
} from "../common/time-series/rate-index.util";
import { investmentRowRateInto } from "./investment-row-fx.util";

/**
 * The factors that take a listed row's amount (in `amountCurrencyCode`) into
 * the reader's reporting currency and into the row's own account's currency,
 * by the row's own settled rate or the market rate on its own date
 * (`investmentRowRateInto`). A surface converting a dividend or a trade
 * multiplies by these rather than converting at today's rate (issue #2106).
 * `null` is a row no admissible rate reaches.
 */
export interface InvestmentRowReportingRates {
  reportingCurrencyCode: string;
  reportingRate: number | null;
  accountRate: number | null;
  /**
   * The same factor into every currency the page's accounts are kept in, and
   * the reporting currency: a surface totalling a brokerage whose linked cash
   * account is in another currency reads the one it reports in.
   */
  ratesInto: Record<string, number | null>;
}

/** What a listed row carries that the rates are worked out from. */
export interface InvestmentRowRateSource {
  transactionDate: string;
  exchangeRate: number | string | null;
  amountCurrencyCode?: string | null;
  account?: {
    currencyCode?: string | null;
    accountSubType?: string | null;
    linkedAccountId?: string | null;
  } | null;
  fundingAccount?: { currencyCode?: string | null } | null;
}

/**
 * Stamp {@link InvestmentRowReportingRates} onto every row of a page, after
 * `attachInvestmentRowCurrencies` has named each amount's currency. Mutates in
 * place, as that does: these are the entity instances the controller serialises.
 *
 * The cash leg settles where `findCashAccount` resolves it -- the funding
 * account, else the brokerage's linked cash account, else the account itself
 * -- the same order the transaction-history summary reads. The history is
 * loaded once per target currency for the page's span, inside `m`.
 */
export async function attachInvestmentRowReportingRates<
  T extends InvestmentRowRateSource & Partial<InvestmentRowReportingRates>,
>(m: EntityManager, userId: string, rows: readonly T[]): Promise<void> {
  if (rows.length === 0) return;
  const reporting = preferredCurrency(
    await m.getRepository(UserPreference).findOne({ where: { userId } }),
  );

  const linkedIds = [
    ...new Set(
      rows
        .map((row) => row.account?.linkedAccountId)
        .filter((id): id is string => Boolean(id)),
    ),
  ];
  const linkedCurrency = new Map(
    (linkedIds.length > 0
      ? await m.getRepository(Account).find({
          where: { userId, id: In(linkedIds) },
          select: { id: true, currencyCode: true },
        })
      : []
    ).map((account) => [account.id, account.currencyCode] as const),
  );
  const sources = rows.map((row) => ({
    amountCurrency: row.amountCurrencyCode ?? null,
    settlementCurrency:
      row.fundingAccount?.currencyCode ||
      // Only a brokerage settles in its linked cash account (the replay's
      // `settlementCurrencies`); a cash account linked back to its brokerage
      // settles in its own currency.
      (row.account?.linkedAccountId &&
      row.account.accountSubType === AccountSubType.INVESTMENT_BROKERAGE
        ? linkedCurrency.get(row.account.linkedAccountId)
        : undefined) ||
      row.account?.currencyCode ||
      null,
    exchangeRate: row.exchangeRate,
    date: String(row.transactionDate).slice(0, 10),
  }));

  // The reporting currency, every account's on the page, and the linked
  // accounts' (a brokerage's cash, a cash account's brokerage), so a surface
  // totalling a pair kept in two currencies finds the one it reports in.
  const targets = new Set<string>([reporting, ...linkedCurrency.values()]);
  const currencies = new Set<string>();
  for (const [i, row] of rows.entries()) {
    if (row.account?.currencyCode) targets.add(row.account.currencyCode);
    if (sources[i].amountCurrency) currencies.add(sources[i].amountCurrency);
    if (sources[i].settlementCurrency) {
      currencies.add(sources[i].settlementCurrency);
    }
  }
  const dates = sources.map((source) => source.date).sort();
  const indexes = new Map<string, RateIndex>();
  for (const target of targets) {
    indexes.set(
      target,
      await buildRateIndex(
        (sql, params) => m.query(sql, params),
        new Set([...currencies].filter((code) => code !== target)),
        target,
        dates[0],
        dates[dates.length - 1],
      ),
    );
  }
  const rateOn = (from: string, to: string, date: string) => {
    const index = indexes.get(to);
    return index ? resolveIndexedRate(index, from, to, date).rate : null;
  };

  for (const [i, row] of rows.entries()) {
    const ratesInto: Record<string, number | null> = {};
    for (const target of targets) {
      ratesInto[target] = (
        await investmentRowRateInto(target, sources[i], rateOn)
      ).rate;
    }
    const accountCurrency = row.account?.currencyCode ?? null;
    Object.assign(row, {
      reportingCurrencyCode: reporting,
      reportingRate: ratesInto[reporting] ?? null,
      accountRate:
        accountCurrency === null ? null : (ratesInto[accountCurrency] ?? null),
      ratesInto,
    });
  }
}
