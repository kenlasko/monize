import { Injectable } from "@nestjs/common";
import { DataSource } from "typeorm";
import { withScopedDb } from "../common/db/scoped-db";
import { FxAggregate } from "../common/fx-aggregate";
import { resolveUserDefaultCurrency } from "../common/default-currency.util";
import { ExchangeRateService } from "../currencies/exchange-rate.service";
import { InvestmentAction } from "../securities/entities/investment-transaction.entity";
import { AccountSubType } from "../accounts/entities/account.entity";
import { investmentRowHasEffect } from "../securities/investment-row-effects.util";
import { investmentRowRateInto } from "../securities/investment-row-fx.util";
import {
  InvestmentTransactionActionSummary,
  InvestmentTransactionSummary,
  InvestmentTransactionSummaryQueryDto,
} from "./dto/investment-transaction-summary.dto";

/** One filtered row, as the statement below returns it. */
interface SummaryRow {
  action: InvestmentAction;
  status: string;
  transaction_date: string;
  total_amount: string;
  currency_code: string | null;
  symbol: string | null;
  /** The row's own rate: amount currency -> settlement (cash) currency. */
  exchange_rate: string | null;
  /** The currency that rate converts INTO, from the row's own cash leg. */
  settlement_currency_code: string | null;
}

/**
 * A per-action accumulation while the fold runs.
 *
 * `excluded` is counted here rather than asked of `FxAggregate`: the aggregate
 * knows which pairs failed, not how many rows failed on them.
 */
interface ActionBucket {
  count: number;
  excluded: number;
  fx: FxAggregate;
}

function describe(
  fx: FxAggregate,
  excluded: number,
): Pick<
  InvestmentTransactionActionSummary,
  | "total"
  | "knownSubtotal"
  | "missingPairs"
  | "unknownCount"
  | "excludedCount"
  | "fxComplete"
> {
  return {
    total: fx.total,
    knownSubtotal: fx.knownSubtotal,
    missingPairs: fx.missingPairs,
    unknownCount: fx.unknownCount,
    excludedCount: excluded,
    fxComplete: fx.isComplete,
  };
}

/**
 * The KPIs above the Investment Transaction History report, computed over the
 * whole filtered result set.
 *
 * Two things this fixes, both of which made the "Total volume" card untrue
 * (issue #1394). The client used to add `total_amount` across rows whose
 * amounts are in the SECURITY's currency -- a EUR 1,000 trade and a USD 1,000
 * trade came out as 2,000 of the reader's money. And it added only the rows it
 * had fetched, stopping at a fixed number of pages, so a large filter produced
 * a confident number for part of the data.
 *
 * Here each row is converted at the rate that stood on its own transaction date
 * (today's rate answers today's question, not the trade's) and accumulated
 * through `FxAggregate`, so a missing pair withholds the total and names itself
 * rather than quietly shrinking the figure.
 *
 * The row set is exactly the one the report's table lists -- `findAll`'s,
 * including VOID rows and excluding a redemption's accrued-interest companion
 * -- so the count on the card and the rows underneath it are the same rows.
 * Counts read rows as records, so a VOID row is counted; amounts read rows as
 * effects, so a VOID row contributes nothing. It is a known zero, not an
 * unknown: it leaves the total complete and is not an exclusion.
 */
@Injectable()
export class InvestmentTransactionSummaryService {
  constructor(
    private dataSource: DataSource,
    private exchangeRateService: ExchangeRateService,
  ) {}

  async summarize(
    userId: string,
    query: InvestmentTransactionSummaryQueryDto,
  ): Promise<InvestmentTransactionSummary> {
    const currencyCode = await resolveUserDefaultCurrency(
      this.dataSource,
      userId,
    );
    const rows = await this.loadRows(userId, query);

    const overall = new FxAggregate();
    const buckets = new Map<InvestmentAction, ActionBucket>();
    const symbols = new Set<string>();
    const currencies = new Set<string>();
    let hasUnknownCurrency = false;
    let excludedOverall = 0;
    // Which rate answered each row, counted so the surface can say it.
    let transactionRateCount = 0;
    let marketRateCount = 0;
    let onwardMarketCount = 0;
    // One lookup per (currency, date) pair rather than per row: a year of one
    // security's trades asks for the same day's rate many times over.
    const rateCache = new Map<string, number | null>();

    for (const row of rows) {
      let bucket = buckets.get(row.action);
      if (!bucket) {
        bucket = { count: 0, excluded: 0, fx: new FxAggregate() };
        buckets.set(row.action, bucket);
      }
      bucket.count += 1;
      if (row.symbol) symbols.add(row.symbol);

      // A voided trade is still a row the register lists, so it is counted;
      // it moved no money, so it adds a known zero to the volume rather than
      // an unknown, and the total stays complete.
      if (!investmentRowHasEffect(row)) continue;

      // The report reads volume, so the magnitude: a sale and a purchase of the
      // same size are two thousand of activity, not zero.
      const amount = Math.abs(Number(row.total_amount));
      const from = row.currency_code;

      if (from === null) {
        // Neither the security nor the account named a currency, so there is
        // no pair to name and the reader's own currency is not the answer. A
        // security-less row is not this case: the statement above reads its
        // currency from the investment account.
        hasUnknownCurrency = true;
        overall.addUnknown();
        bucket.fx.addUnknown();
        excludedOverall += 1;
        bucket.excluded += 1;
        continue;
      }
      currencies.add(from);

      if (from === currencyCode || amount === 0) {
        // Zero needs no rate, and neither does a row already in the reporting
        // currency -- asking for one would invent a gap where there is none.
        overall.addConverted(amount);
        bucket.fx.addConverted(amount);
        continue;
      }

      // The row's OWN rate first: a trade that settled at 3.7287 settled at
      // 3.7287, and the realized-gains report multiplies by exactly that.
      // Converting the same sale at the market rate that stood on its date
      // gave the reader two different figures for one event, with nothing on
      // either surface saying which rate it had used.
      const { rate, basis, onward } = await investmentRowRateInto(
        currencyCode,
        {
          amountCurrency: from,
          settlementCurrency: row.settlement_currency_code,
          exchangeRate: row.exchange_rate,
          date: row.transaction_date,
        },
        (f, t, date) => this.rateOn(f, t, date, rateCache),
      );
      // `null` is unknown, never 1 and never the unconverted amount.
      const converted = rate === null ? null : amount * rate;
      if (converted === null) {
        excludedOverall += 1;
        bucket.excluded += 1;
      } else if (basis === "transaction") {
        transactionRateCount += 1;
        if (onward) onwardMarketCount += 1;
      } else {
        marketRateCount += 1;
      }
      overall.add(converted, from, currencyCode);
      bucket.fx.add(converted, from, currencyCode);
    }

    const byAction: InvestmentTransactionActionSummary[] = [
      ...buckets.entries(),
    ]
      .map(([action, bucket]) => ({
        action,
        count: bucket.count,
        ...describe(bucket.fx, bucket.excluded),
      }))
      // Largest activity first, as the report's badges have always been
      // ordered; the known subtotal is the only figure every bucket has.
      .sort((a, b) => b.knownSubtotal - a.knownSubtotal);

    return {
      currencyCode,
      transactionCount: rows.length,
      securitiesTraded: symbols.size,
      byAction,
      amountCurrencies: [...currencies].sort(),
      hasUnknownCurrency,
      transactionRateCount,
      marketRateCount,
      onwardMarketCount,
      ...describe(overall, excludedOverall),
    };
  }

  /**
   * The rate from `from` into `to` as it stood on `date`, cached per pair-day.
   *
   * `null` means no rate was found for the pair; `getRateForDate` already
   * returns 1 only when the two codes are equal.
   *
   * `fetchMissing: false` keeps a report GET inside the database: a filter
   * spanning years of trades would otherwise ask the provider once per
   * (pair, date) that the stored span does not cover, with nothing caching
   * the misses.
   */
  private async rateOn(
    from: string,
    to: string,
    date: string,
    cache: Map<string, number | null>,
  ): Promise<number | null> {
    const key = `${from}->${to}@${date}`;
    const cached = cache.get(key);
    if (cached !== undefined) return cached;
    const rate = await this.exchangeRateService.getRateForDate(from, to, date, {
      fetchMissing: false,
    });
    const usable = rate === null || rate <= 0 ? null : rate;
    cache.set(key, usable);
    return usable;
  }

  /**
   * The filtered rows, with each amount's own currency beside it.
   *
   * The account filter widens to the brokerages' linked cash accounts, which is
   * what the register's own filter does, so the summary counts the same rows
   * the table lists.
   */
  private async loadRows(
    userId: string,
    query: InvestmentTransactionSummaryQueryDto,
  ): Promise<SummaryRow[]> {
    return withScopedDb(this.dataSource, async (m) => {
      // Parameterized throughout, the action enum values included: a literal
      // spliced into the string is the habit this codebase does not keep.
      const params: unknown[] = [
        userId,
        InvestmentAction.INTEREST,
        InvestmentAction.REDEEM,
        // Only a brokerage settles in its linked cash account.
        AccountSubType.INVESTMENT_BROKERAGE,
      ];
      const clauses: string[] = [];

      if (query.accountIds && query.accountIds.length > 0) {
        const linked: { id: string }[] = await m.query(
          `SELECT linked_account_id AS id FROM accounts
            WHERE id = ANY($1) AND linked_account_id IS NOT NULL`,
          [query.accountIds],
        );
        const ids = [
          ...new Set([...query.accountIds, ...linked.map((r) => r.id)]),
        ];
        params.push(ids);
        clauses.push(`AND it.account_id = ANY($${params.length})`);
      }
      if (query.startDate) {
        params.push(query.startDate);
        clauses.push(`AND it.transaction_date >= $${params.length}`);
      }
      if (query.endDate) {
        params.push(query.endDate);
        clauses.push(`AND it.transaction_date <= $${params.length}`);
      }
      if (query.actions && query.actions.length > 0) {
        params.push(query.actions);
        clauses.push(`AND it.action = ANY($${params.length})`);
      }

      return m.query(
        // includes VOID rows: records read -- the card counts what the table
        // lists; `investmentRowHasEffect` above decides what the volume sums.
        // `COALESCE` is the same rule as `investmentRowCurrencies`: an amount
        // is in the security's currency, and a row that names no security is
        // in the investment account's, which is where
        // `resolveSettlementCurrencyPair` denominated it when it was written.
        // `exchange_rate` is the row's own: the rate its cash leg settled at,
        // converting the amount above into the settlement account's currency.
        // That account is the explicit funding account when the row names one,
        // otherwise the brokerage's linked cash sleeve, otherwise the
        // brokerage itself -- the same order `findCashAccount` resolves.
        `SELECT it.action AS action,
                it.status AS status,
                TO_CHAR(it.transaction_date, 'YYYY-MM-DD') AS transaction_date,
                it.total_amount::text AS total_amount,
                COALESCE(s.currency_code, a.currency_code) AS currency_code,
                it.exchange_rate::text AS exchange_rate,
                COALESCE(f.currency_code, cash.currency_code, a.currency_code)
                  AS settlement_currency_code,
                s.symbol AS symbol
           FROM investment_transactions it
           LEFT JOIN securities s ON s.id = it.security_id
           LEFT JOIN accounts a ON a.id = it.account_id
           LEFT JOIN accounts f ON f.id = it.funding_account_id
           LEFT JOIN accounts cash
             ON cash.id = a.linked_account_id
            AND a.account_sub_type = $4
          WHERE it.user_id = $1
            AND NOT (it.action = $2 AND EXISTS (
                  -- The parent is looked up as a record (includes VOID): what
                  -- decides whether the child row counts is the child's status.
                  SELECT 1 FROM investment_transactions parent
                   WHERE parent.id = it.linked_transaction_id
                     AND parent.user_id = it.user_id
                     AND parent.action = $3))
            ${clauses.join("\n            ")}`,
        params,
      );
    });
  }
}
