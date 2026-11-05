import { Injectable, Logger } from "@nestjs/common";
import { isPositiveFinite } from "../../common/helpers/is-positive-finite";
import {
  YahooFinanceService,
  YahooQuoteResult,
} from "../../securities/yahoo-finance.service";
import { CRYPTO_EXCHANGE } from "../../securities/providers/crypto-pair.util";
import { HistoricalPrice } from "../../securities/providers/quote-provider.interface";
import { mapWithConcurrency } from "../../common/concurrency.util";
import { todayYMD } from "../../common/date-utils";
import { isSparseRateSeries } from "../rate-gap-plan";
import {
  FxQuote,
  FxQuoteChoice,
  FxQuoteObservation,
  chooseFxQuote,
  quoteNeedsInverse,
} from "../quoted-rate.util";
import {
  FxObservation,
  FxProviderName,
  FxRateProvider,
} from "./fx-provider.interface";

/**
 * Cap on concurrent Yahoo FX quote fetches, so a refresh does not burst every
 * currency pair at once (the daily refresh runs alongside the security price
 * refresh, so the combined load on Yahoo has to stay bounded).
 */
export const FX_FETCH_CONCURRENCY = 6;

/**
 * The quote Yahoo answers for a pair it has no real price for (plan section
 * 7.3, issue #1677): `IDRUSD=X` was seen quoting exactly `0.01` while
 * `USDIDR=X` quoted 17871. A real rate can be 0.01 too, so an exact match is
 * only a suspicion until the reverse symbol is asked.
 */
export const YAHOO_FX_PLACEHOLDER_RATE = 0.01;

/**
 * How far the placeholder may sit from the rate the reverse symbol implies
 * and still be read as a real rate, as a fraction of the placeholder (1 %,
 * issue #1677).
 */
export const PLACEHOLDER_TOLERANCE = 0.01;

/**
 * How many pairs the adapter remembers as "ask the reverse symbol first". The
 * order is insertion, not last use: a remembered pair never asks the direct
 * symbol first again, so it is not re-inserted, and the first remembered is
 * the first forgotten. A forgotten pair costs one extra call the next time and
 * is remembered again (issue #1677).
 */
export const REVERSE_FIRST_MEMORY_LIMIT = 256;

/** How many quotes a free-text currency search asks Yahoo for. */
export const CURRENCY_SEARCH_COUNT = 20;

/** Yahoo's symbol for the `from -> to` rate. */
function fxSymbol(from: string, to: string): string {
  return `${from}${to}=X`;
}

/** The unique days a series carries a usable rate for. */
function observationDays(series: readonly FxObservation[]): string[] {
  return [...new Set(series.map((point) => point.date))];
}

/** The key the reverse-first memory holds a `from -> to` question under. */
function pairKey(from: string, to: string): string {
  return `${from}/${to}`;
}

/**
 * Whether the reverse symbol's quote contradicts a direct quote of exactly the
 * placeholder: the rate it implies is more than the tolerance away from it.
 * `|1/r - p| / p > t` is written as `|1 - p*r| > t*p*r` (both positive), so no
 * rate is reciprocated to decide it.
 */
function contradictsPlaceholder(reverse: number): boolean {
  const product = YAHOO_FX_PLACEHOLDER_RATE * reverse;
  return Math.abs(1 - product) > PLACEHOLDER_TOLERANCE * product;
}

/**
 * The currency code a Yahoo FX symbol names for a free-text query: of a
 * six-letter pair (`EURUSD=X`), the half the query spells, else the base; of
 * anything else, the query itself upper-cased, as the lookup always answered.
 */
function currencyCodeFromSymbol(symbol: string, query: string): string {
  const upperQuery = query.toUpperCase();
  const pair = symbol.replace("=X", "");
  if (pair.length !== 6) return upperQuery;
  const base = pair.substring(0, 3);
  const quote = pair.substring(3, 6);
  if (base === upperQuery) return base;
  if (quote === upperQuery) return quote;
  return base;
}

/**
 * Exchange rates from Yahoo Finance, through `YahooFinanceService` (its
 * throttle, retry and breaker stay in front of every call).
 *
 * Yahoo cannot enumerate the currencies it quotes, so `carries` is always true
 * and it is the chain's last resort for any pair. Two rules that used to live
 * in `ExchangeRateService` are the adapter's now, so a caller on the chain
 * keeps them without knowing the provider:
 *
 * - A latest quote below 1 is checked against the reverse symbol and the one
 *   with more digits is the observation (`quoted-rate.util.ts`, issue #1604);
 *   a quote too coarse either way is answered as "no rate", never stored.
 * - A daily window is asked of the direct symbol, then the reverse when the
 *   direct answer is sparse, and the two are merged densest first; the window
 *   is "not answered" only when nothing was found and a symbol did not answer,
 *   the rule `fillRateWindow` holds today.
 * - A direct quote of exactly `YAHOO_FX_PLACEHOLDER_RATE` whose reverse
 *   disagrees by more than `PLACEHOLDER_TOLERANCE` is Yahoo's placeholder: it
 *   is discarded, the reverse is the observation, and the pair is remembered
 *   as reverse-first (issue #1677). A placeholder whose reverse does not
 *   answer is never stored; it is below `MIN_PRECISE_QUOTED_RATE` anyway.
 *
 * The reverse-first memory is a cost saving, not a correctness rule: a
 * remembered pair asks the reverse symbol first on later `fetchLatest`,
 * `fetchLive` and `fetchDailySeries` calls, which saves the placeholder call,
 * but every latest quote still goes through the same choice, so forgetting a
 * pair (the map is bounded and process-local) changes the calls, never the
 * quoted rate. For a daily window the order can decide which symbol's answer
 * is primary on a tie in density. Daily bars are not checked for the
 * placeholder: a pair not yet remembered asks the direct window first, as
 * before this check existed.
 *
 * Two lookup aids answer the currency lookup through the same client:
 * `verifyCurrency` asks the code's chart against USD (Yahoo's `null` cannot
 * say "unknown", so it answers `true` or `null`, never `false`), and
 * `searchCurrency` reads the first FX quote of `searchQuotes`. The chain asks
 * `verifyCurrency` only of a code no provider carries, and `carries` is
 * always true here, so it is not reached while this adapter is configured.
 *
 * Observations come back in the orientation that answered; the writer orients
 * them. A quote is dated `todayYMD()`, as the refresh dates it today, so no
 * Yahoo row changes when the service moves onto the chain. Yahoo's client
 * answers `null` for an outage and for an unknown symbol alike, so a batch is
 * "not answered" only when no symbol in it answered at all.
 */
@Injectable()
export class YahooFxProvider implements FxRateProvider {
  readonly name: FxProviderName = "yahoo";
  readonly source = "yahoo_finance";
  private readonly logger = new Logger(YahooFxProvider.name);
  /** Pairs whose direct symbol answered the placeholder; insertion-ordered, oldest first. */
  private readonly reverseFirst = new Set<string>();

  constructor(private readonly yahoo: YahooFinanceService) {}

  async carries(_code: string): Promise<boolean> {
    return true;
  }

  async fetchLatest(
    base: string,
    quotes: readonly string[],
  ): Promise<ReadonlyMap<string, FxObservation> | null> {
    const date = todayYMD();
    const choices = await mapWithConcurrency(
      quotes,
      FX_FETCH_CONCURRENCY,
      (quote) => this.chooseQuote(base, quote),
    );

    const found = new Map<string, FxObservation>();
    let anySymbolAnswered = false;
    for (const [index, choice] of choices.entries()) {
      if (choice.answered) anySymbolAnswered = true;
      if (choice.observation) {
        found.set(quotes[index], { ...choice.observation, date });
      }
    }
    if (quotes.length > 0 && !anySymbolAnswered) return null;
    return found;
  }

  async fetchDailySeries(
    from: string,
    to: string,
    start: string,
    end: string,
  ): Promise<FxObservation[] | null> {
    // A pair remembered as reverse-first asks the reverse symbol first; the
    // rule is otherwise the same with the two symbols' roles swapped.
    const [askFrom, askTo] = this.reverseFirst.has(pairKey(from, to))
      ? [to, from]
      : [from, to];
    const first = await this.fetchWindow(askFrom, askTo, start, end);
    if (
      first !== null &&
      !isSparseRateSeries(observationDays(first), start, end)
    ) {
      return first;
    }

    const second = await this.fetchWindow(askTo, askFrom, start, end);
    const firstPoints = first ?? [];
    const secondPoints = second ?? [];
    if (firstPoints.length === 0 && secondPoints.length === 0) {
      // Both symbols, not either: "this pair has no rates in this window" is
      // only known when both answered. One of them answering `[]` while the
      // other failed is half-knowledge, and is reported as no answer.
      return first !== null && second !== null ? [] : null;
    }

    // The denser answer first, the one asked first on a tie; the other
    // contributes only the days the first has no bar for.
    const [primary, secondary] =
      observationDays(secondPoints).length > observationDays(firstPoints).length
        ? [secondPoints, firstPoints]
        : [firstPoints, secondPoints];
    const covered = new Set(observationDays(primary));
    return [
      ...primary,
      ...secondary.filter((point) => !covered.has(point.date)),
    ];
  }

  async fetchLive(from: string, to: string): Promise<FxObservation | null> {
    const { observation } = await this.chooseQuote(from, to);
    return observation ? { ...observation, date: todayYMD() } : null;
  }

  async verifyCurrency(code: string): Promise<boolean | null> {
    const upper = code.toUpperCase();
    const counter = upper === "USD" ? "EUR" : "USD";
    const quote = await this.yahoo.fetchQuote(fxSymbol(upper, counter));
    return quote === null ? null : true;
  }

  async searchCurrency(query: string): Promise<string | null> {
    const quotes = await this.yahoo.searchQuotes(query, CURRENCY_SEARCH_COUNT);
    if (quotes === null) return null;
    const fx = quotes.find(
      (quote) => quote.quoteType === "CURRENCY" || quote.symbol.includes("=X"),
    );
    return fx ? currencyCodeFromSymbol(fx.symbol, query) : null;
  }

  /**
   * The crypto adapter's door to Yahoo: one coin pair symbol's latest quote,
   * asked as given (`BTC-CAD`), through the client's throttle and breaker.
   * `{ quote: null }` is Yahoo saying the symbol does not exist; `null` is no
   * answer. The `<COIN>-<FIAT>` grammar, the dating and the choice of rate are
   * `CryptoFxProvider`'s: this adapter keeps its own `=X` grammar, its
   * always-true `carries` and its placeholder check, and is only the one file
   * under `currencies/` that holds the Yahoo client
   * (`fx-provider-source.guard.spec.ts`).
   */
  async fetchPairSymbolQuote(
    symbol: string,
  ): Promise<{ quote: YahooQuoteResult | null } | null> {
    return this.yahoo.fetchQuoteAnswer(symbol);
  }

  /**
   * The crypto adapter's door to Yahoo's daily bars for one coin pair symbol
   * over [start, end] (`YYYY-MM-DD`, UTC days), asked as a coin's listing so
   * no exchange suffix or alternate listing is tried. `[]` is Yahoo answering
   * with no bars (or no such symbol); `null` is no answer.
   */
  async fetchPairSymbolWindow(
    symbol: string,
    start: string,
    end: string,
  ): Promise<HistoricalPrice[] | null> {
    return this.yahoo.fetchHistoricalWindow(
      symbol,
      CRYPTO_EXCHANGE,
      new Date(`${start}T00:00:00.000Z`),
      new Date(`${end}T23:59:59.999Z`),
    );
  }

  /**
   * One pair's latest quote: the direct symbol, then the reverse when the
   * direct quote is absent or below 1, and `chooseFxQuote` between them; a
   * pair remembered as reverse-first asks the two the other way round.
   * `answered` is whether either symbol answered at all, with or without a
   * usable rate.
   */
  private async chooseQuote(
    from: string,
    to: string,
  ): Promise<{ observation: FxQuoteObservation | null; answered: boolean }> {
    const reverseFirst = this.reverseFirst.has(pairKey(from, to));
    const [askFrom, askTo] = reverseFirst ? [to, from] : [from, to];

    const firstQuote = await this.fetchRate(askFrom, askTo);
    const first: FxQuote = { from: askFrom, to: askTo, rate: firstQuote.rate };
    const secondQuote = quoteNeedsInverse(first.rate)
      ? await this.fetchRate(askTo, askFrom)
      : null;
    const second: FxQuote | null = secondQuote
      ? { from: askTo, to: askFrom, rate: secondQuote.rate }
      : null;
    const answered = firstQuote.answered || (secondQuote?.answered ?? false);

    const [direct, reverse] = reverseFirst ? [second, first] : [first, second];
    const choice = this.choose(from, to, direct, reverse, first, second);
    if (choice.reason === "imprecise") {
      this.logger.warn(
        `Provider quotes for ${from}/${to} are rounded too coarsely to use in either direction`,
      );
    }
    return { observation: choice.observation, answered };
  }

  /**
   * The placeholder cross-check in front of `chooseFxQuote` (issue #1677). A
   * direct quote of exactly the placeholder that its reverse contradicts is
   * dropped and the pair remembered as reverse-first; one the reverse could
   * not check is reported here, once, and left to `chooseFxQuote`, which
   * refuses it as too coarse to store. Anything else is `chooseFxQuote`
   * between the two quotes in the order they were asked.
   */
  private choose(
    from: string,
    to: string,
    direct: FxQuote | null,
    reverse: FxQuote | null,
    first: FxQuote,
    second: FxQuote | null,
  ): FxQuoteChoice {
    if (direct?.rate !== YAHOO_FX_PLACEHOLDER_RATE) {
      return chooseFxQuote(first, second);
    }
    if (reverse === null || !isPositiveFinite(reverse.rate)) {
      this.logger.warn(
        `Yahoo quoted ${fxSymbol(from, to)} at the placeholder ${YAHOO_FX_PLACEHOLDER_RATE} and ${fxSymbol(to, from)} did not answer with a usable rate to check it; no rate for ${from}/${to}`,
      );
      return { observation: null, reason: "unavailable" };
    }
    if (!contradictsPlaceholder(reverse.rate)) {
      return chooseFxQuote(first, second);
    }
    this.rememberReverseFirst(from, to);
    this.logger.log(
      `Yahoo quoted ${fxSymbol(from, to)} at the placeholder ${YAHOO_FX_PLACEHOLDER_RATE} against ${fxSymbol(to, from)} at ${reverse.rate}; using the reverse and asking it first from now on`,
    );
    return chooseFxQuote(reverse, null);
  }

  /** Remember a pair as reverse-first, forgetting the oldest past the limit. */
  private rememberReverseFirst(from: string, to: string): void {
    const key = pairKey(from, to);
    this.reverseFirst.delete(key);
    this.reverseFirst.add(key);
    while (this.reverseFirst.size > REVERSE_FIRST_MEMORY_LIMIT) {
      const oldest = this.reverseFirst.values().next().value as string;
      this.reverseFirst.delete(oldest);
    }
  }

  /** The `from -> to` quote; `answered` is whether Yahoo returned anything for the symbol. */
  private async fetchRate(
    from: string,
    to: string,
  ): Promise<{ rate: number | null; answered: boolean }> {
    const quote = await this.yahoo.fetchQuote(fxSymbol(from, to));
    if (quote === null) return { rate: null, answered: false };
    return { rate: quote.regularMarketPrice ?? null, answered: true };
  }

  /**
   * The daily closes of one symbol over the window, as observations dated by
   * their bar and kept to [start, end]; a bar without a usable close is
   * dropped. `null` when Yahoo did not answer for the symbol.
   */
  private async fetchWindow(
    from: string,
    to: string,
    start: string,
    end: string,
  ): Promise<FxObservation[] | null> {
    const prices = await this.yahoo.fetchHistoricalWindow(
      fxSymbol(from, to),
      null,
      new Date(`${start}T00:00:00.000Z`),
      new Date(`${end}T23:59:59.999Z`),
    );
    if (prices === null) return null;
    return prices.flatMap((bar) => toObservation(from, to, bar, start, end));
  }
}

function toObservation(
  from: string,
  to: string,
  bar: HistoricalPrice,
  start: string,
  end: string,
): FxObservation[] {
  if (!Number.isFinite(bar.close) || bar.close <= 0) return [];
  const date = bar.date.toISOString().slice(0, 10);
  if (date < start || date > end) return [];
  return [{ from, to, date, rate: bar.close }];
}
