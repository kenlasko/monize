import { Injectable, Logger } from "@nestjs/common";
import { isPositiveFinite } from "../../common/helpers/is-positive-finite";
import { DataSource } from "typeorm";
import { withScopedDb } from "../../common/db/scoped-db";
import { mapWithConcurrency } from "../../common/concurrency.util";
import { HistoricalPrice } from "../../securities/providers/quote-provider.interface";
import { Currency, CurrencyKind } from "../entities/currency.entity";
import { quoteSymbolCoinTicker } from "../currency-kind.util";
import {
  FxObservation,
  FxRateProvider,
  PairProviderName,
} from "./fx-provider.interface";
import { YahooFxProvider } from "./yahoo-fx.provider";

/**
 * How long the adapter trusts what it read of `currencies`. A currency write
 * through `CurrenciesService` forgets it at once; the expiry covers every other
 * writer (a restore, an import, another replica's request).
 */
export const CRYPTO_CURRENCY_CACHE_MS = 5 * 60 * 1000;

/**
 * How soon after a read of `currencies` a code missing from it may trigger
 * another. A code the snapshot does not hold may be a coin created on another
 * replica or written by a restore since the read, and answering "not mine"
 * for it would hand a coin pair to Yahoo's `=X` grammar (INV-CRYPTO-002), so a
 * miss re-reads before answering. The throttle is what keeps a stale snapshot
 * from costing a query on every question; within it, and after a re-read that
 * still lacks the code, `claims` and `carries` reject ("could not say") rather
 * than answer "not mine", and the chain retries the pair next tick.
 */
export const CRYPTO_MISS_RELOAD_MS = 5 * 1000;

/** Cap on concurrent coin quotes per `fetchLatest`; the Yahoo client throttles beneath it too. */
export const CRYPTO_FETCH_CONCURRENCY = 4;

/** What the adapter knows of one `currencies` row. */
interface CodeFacts {
  kind: CurrencyKind;
  /** The Yahoo coin ticker of a CRYPTO row's `quote_symbol`; null when it has none. */
  coinTicker: string | null;
}

/**
 * The Yahoo symbol that prices a pair, and the observation's orientation:
 * `rate` is the price of one `from` in `to`.
 */
interface PairSymbol {
  symbol: string;
  from: string;
  to: string;
}

/** The UTC day of an epoch in seconds, `YYYY-MM-DD`. */
function utcDay(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toISOString().slice(0, 10);
}

/**
 * Exchange rates for cryptocurrencies (`docs/specs/crypto-accounts.md`,
 * decision 5), priced from Yahoo's `<COIN>-<FIAT>` symbols: the symbols a
 * crypto security is priced from.
 *
 * **Always in the chain, never configured.** The module factory appends it
 * after whatever `FX_PROVIDERS` names, because no other provider carries a
 * coin and a chain without it could never price a CRYPTO currency. Its name is
 * a `PairProviderName`, not an `FxProviderName`: `resolveFxProviders` keeps
 * refusing `crypto` as a token, the frontend's label list of configurable
 * names (held to `FX_PROVIDER_NAMES` by a contract test) is not widened by a
 * name nobody can configure, and the status endpoint's `describe()` still
 * lists it so the Currencies page can say where a coin's rows come from.
 *
 * **What it carries and claims.** `carries(code)` is true for a CRYPTO
 * currency with a `quote_symbol` and for every FIAT currency (a pair needs
 * both sides); `claims(code)` is true for every CRYPTO currency, so the chain
 * asks this adapter, and only this adapter, about a pair with a coin on either
 * side (INV-CRYPTO-002), and never about a fiat pair. A coin without a symbol
 * is claimed but not carried: the pair is uncarried, and the refresh names
 * the Currencies page as where to map one. Both read `currencies` through
 * `withScopedDb` (every caller of the chain runs under an identity), cached
 * for `CRYPTO_CURRENCY_CACHE_MS` and forgotten by `CurrenciesService` on a
 * currency write and by the backup restore after it commits; a failed read
 * rejects both, never answers `false`. A code the snapshot does not hold is
 * read again before the answer (a coin created on another replica, which no
 * local `forgetCurrencies` reached), at most once per
 * `CRYPTO_MISS_RELOAD_MS`, and the pair's symbol comes from the map that read
 * returned; a code still absent (within the throttle, or after that read)
 * rejects both too, because every code in use has a `currencies` row and its
 * absence means the read is stale, not that the code is fiat.
 *
 * **Symbols.** The coin ticker is the part of `quote_symbol` before its last
 * hyphen, and the fiat is whichever fiat the pair names, not the one in the
 * symbol: `BTC` mapped to `BTC-CAD` is priced against EUR through `BTC-EUR`.
 * A pair of two coins asks `<coinA>-<coinB>` once, in the order asked. An
 * observation is `from = <Monize coin code>`, `to = <fiat code>` (the first
 * coin for two coins), at the quote's `regularMarketPrice`, dated by the UTC
 * day of its `regularMarketTime` (a coin's Yahoo session is the UTC day), else
 * today's UTC day. No `MIN_PRECISE_QUOTED_RATE` check: that rule is about the
 * four-decimal rounding of `=X` pairs, and Yahoo quotes a coin at its own
 * price hint.
 *
 * **Answers.** `null` is "Yahoo did not answer" (an outage, a throttle, the
 * open breaker); a symbol Yahoo reports as not found, or a quote without a
 * usable price, is "answered, nothing there" (INV-FX-005), so the chain may
 * remember an empty window but never an outage as one. A batch is `null` only
 * when no symbol in it answered at all, as in the Yahoo adapter.
 *
 * **Transport.** Every call reaches Yahoo through `YahooFxProvider`'s pair
 * symbol doors and so through `YahooFinanceService`'s throttle, retry and
 * breaker; this file holds the `-` symbol grammar and nothing that fetches.
 * Kept apart from `YahooFxProvider` rather than teaching it the `-` form,
 * whose `carries` is always true and whose placeholder check is for `=X`
 * pairs.
 */
@Injectable()
export class CryptoFxProvider implements FxRateProvider {
  readonly name: PairProviderName = "crypto";
  readonly source = "yahoo_crypto";
  private readonly logger = new Logger(CryptoFxProvider.name);
  private snapshot: {
    loadedAt: number;
    codes: ReadonlyMap<string, CodeFacts>;
  } | null = null;
  /** The read in flight, shared, so concurrent questions cost one query. */
  private loading: Promise<ReadonlyMap<string, CodeFacts>> | null = null;

  constructor(
    private readonly dataSource: DataSource,
    private readonly yahoo: YahooFxProvider,
  ) {}

  async carries(code: string): Promise<boolean> {
    const facts = await this.factsOf(code);
    return facts.kind === "CRYPTO" ? facts.coinTicker !== null : true;
  }

  async claims(code: string): Promise<boolean> {
    return (await this.factsOf(code)).kind === "CRYPTO";
  }

  /**
   * What `currencies` says of one code, for `claims` and `carries`. A code
   * still absent after `currenciesHolding` re-read (or while its throttle
   * forbids a re-read) is not "not a coin": every code the chain is asked
   * about is a `currencies` row (the foreign keys on every column that holds
   * one), so absence means the snapshot is older than the row. That is "could
   * not say", and it rejects as a failed read does, so the chain asks nobody
   * about the pair this tick rather than handing it to Yahoo's `=X` grammar
   * (INV-CRYPTO-002). A code the snapshot holds is answered from it: a kind
   * changes only while nothing references the code, so a kind another replica
   * changed since the read prices nothing.
   */
  private async factsOf(code: string): Promise<CodeFacts> {
    const facts = (await this.currenciesHolding([code])).get(
      code.toUpperCase(),
    );
    if (facts === undefined) {
      throw new Error(
        `Could not say whether ${code} is a coin: the currencies read does not hold it yet`,
      );
    }
    return facts;
  }

  /** Drop what was read of `currencies`; the next question reads it again. */
  forgetCurrencies(): void {
    this.snapshot = null;
  }

  async fetchLatest(
    base: string,
    quotes: readonly string[],
  ): Promise<ReadonlyMap<string, FxObservation> | null> {
    const codes = await this.currenciesHolding([base, ...quotes]);
    const answers = await mapWithConcurrency(
      quotes,
      CRYPTO_FETCH_CONCURRENCY,
      (quote) => this.latestFor(codes, base, quote),
    );

    const found = new Map<string, FxObservation>();
    let anySymbolAsked = false;
    let anySymbolAnswered = false;
    for (const [index, answer] of answers.entries()) {
      if (answer.asked) anySymbolAsked = true;
      if (answer.answered) anySymbolAnswered = true;
      if (answer.observation) found.set(quotes[index], answer.observation);
    }
    if (anySymbolAsked && !anySymbolAnswered) return null;
    return found;
  }

  async fetchDailySeries(
    from: string,
    to: string,
    start: string,
    end: string,
  ): Promise<FxObservation[] | null> {
    const pair = this.pairSymbol(
      await this.currenciesHolding([from, to]),
      from,
      to,
    );
    if (pair === null) return [];
    const bars = await this.yahoo.fetchPairSymbolWindow(
      pair.symbol,
      start,
      end,
    );
    if (bars === null) return null;
    return bars.flatMap((bar) => toObservation(pair, bar, start, end));
  }

  /** One quote of `base`: whether a symbol was asked, whether Yahoo answered, and the observation. */
  private async latestFor(
    codes: ReadonlyMap<string, CodeFacts>,
    base: string,
    quote: string,
  ): Promise<{
    asked: boolean;
    answered: boolean;
    observation: FxObservation | null;
  }> {
    const pair = this.pairSymbol(codes, base, quote);
    if (pair === null) {
      return { asked: false, answered: false, observation: null };
    }
    const answer = await this.yahoo.fetchPairSymbolQuote(pair.symbol);
    if (answer === null) {
      return { asked: true, answered: false, observation: null };
    }
    const price = answer.quote?.regularMarketPrice;
    if (!isPositiveFinite(price)) {
      return { asked: true, answered: true, observation: null };
    }
    const time = answer.quote?.regularMarketTime;
    const date =
      typeof time === "number" && Number.isFinite(time)
        ? utcDay(time)
        : utcDay(Date.now() / 1000);
    return {
      asked: true,
      answered: true,
      observation: { from: pair.from, to: pair.to, date, rate: price },
    };
  }

  /**
   * The symbol that prices `a`/`b`, or `null` when this adapter prices no
   * such pair: neither side a coin it can price, or a coin without a symbol.
   */
  private pairSymbol(
    codes: ReadonlyMap<string, CodeFacts>,
    a: string,
    b: string,
  ): PairSymbol | null {
    const first = codes.get(a.toUpperCase());
    const second = codes.get(b.toUpperCase());
    if (!first || !second || a === b) return null;
    const firstCoin = first.kind === "CRYPTO";
    const secondCoin = second.kind === "CRYPTO";
    if (firstCoin && first.coinTicker === null) return null;
    if (secondCoin && second.coinTicker === null) return null;

    if (firstCoin && secondCoin) {
      return {
        symbol: `${first.coinTicker}-${second.coinTicker}`,
        from: a,
        to: b,
      };
    }
    if (firstCoin)
      return { symbol: `${first.coinTicker}-${b}`, from: a, to: b };
    if (secondCoin)
      return { symbol: `${second.coinTicker}-${a}`, from: b, to: a };
    return null;
  }

  /**
   * What `currencies` says of each code, read again first when one of `wanted`
   * is not in the snapshot and the snapshot is older than
   * `CRYPTO_MISS_RELOAD_MS`. A code still missing after that read, or while
   * the throttle forbids one, is not in the map, and `claims` / `carries`
   * reject for it (`factsOf`).
   */
  private async currenciesHolding(
    wanted: readonly string[],
  ): Promise<ReadonlyMap<string, CodeFacts>> {
    const codes = await this.currencies();
    const missing = wanted.some((code) => !codes.has(code.toUpperCase()));
    if (!missing) return codes;
    const loadedAt = this.snapshot?.loadedAt ?? 0;
    if (Date.now() - loadedAt < CRYPTO_MISS_RELOAD_MS) return codes;
    if (this.loading === null) {
      this.loading = this.load().finally(() => {
        this.loading = null;
      });
    }
    return this.loading;
  }

  /** What `currencies` says of each code, from the cache while it is fresh. */
  private async currencies(): Promise<ReadonlyMap<string, CodeFacts>> {
    if (
      this.snapshot !== null &&
      Date.now() - this.snapshot.loadedAt < CRYPTO_CURRENCY_CACHE_MS
    ) {
      return this.snapshot.codes;
    }
    if (this.loading === null) {
      this.loading = this.load().finally(() => {
        this.loading = null;
      });
    }
    return this.loading;
  }

  /**
   * Read every currency's kind and price symbol. A failed read is not cached
   * and rejects: `claims` and `carries` reject with it, and the chain reads a
   * rejected routing question as "could not say", asking nobody about a pair
   * whose claim it cannot settle and reporting it unanswered for the one
   * refresh (`FxProviderChain`). An empty map would make every coin unclaimed
   * and hand coin pairs to Yahoo's `=X` grammar under a fiat source
   * (INV-CRYPTO-002). The next question reads again.
   */
  private async load(): Promise<ReadonlyMap<string, CodeFacts>> {
    try {
      const rows = await withScopedDb(this.dataSource, (manager) =>
        manager.getRepository(Currency).find({
          select: { code: true, kind: true, quoteSymbol: true },
        }),
      );
      const codes = new Map<string, CodeFacts>();
      for (const row of rows) {
        const kind: CurrencyKind = row.kind === "CRYPTO" ? "CRYPTO" : "FIAT";
        codes.set(row.code, {
          kind,
          coinTicker:
            kind === "CRYPTO" && row.quoteSymbol
              ? quoteSymbolCoinTicker(row.quoteSymbol)
              : null,
        });
      }
      this.snapshot = { loadedAt: Date.now(), codes };
      return codes;
    } catch (error) {
      this.logger.warn(
        `Could not read the currencies a coin is priced against: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw error;
    }
  }
}

/** A daily bar as an observation of the pair, kept to [start, end]; a bar without a usable close is dropped. */
function toObservation(
  pair: PairSymbol,
  bar: HistoricalPrice,
  start: string,
  end: string,
): FxObservation[] {
  if (!isPositiveFinite(bar.close)) return [];
  const date = bar.date.toISOString().slice(0, 10);
  if (date < start || date > end) return [];
  return [{ from: pair.from, to: pair.to, date, rate: bar.close }];
}
