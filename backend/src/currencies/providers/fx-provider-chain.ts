import {
  FxObservation,
  FxRateProvider,
  RateProviderName,
} from "./fx-provider.interface";

/** An observation with the `exchange_rates.source` slug of the provider that made it. */
export interface FxChainObservation extends FxObservation {
  source: string;
}

export interface FxLatestResult {
  /** The first carrying provider's observation, per quote. */
  found: ReadonlyMap<string, FxChainObservation>;
  /** Quotes every carrying provider failed to answer: an outage, not an absence. */
  unanswered: string[];
  /**
   * Quotes no configured provider carries beside `base`: a fact about the
   * configuration, not an outage. A quote in none of the three fields was
   * answered without a rate by every provider that carries it.
   */
  uncarried: string[];
}

export interface FxDailySeriesResult {
  points: FxObservation[];
  /**
   * Whether the window may be remembered as what `points` says it is. True when
   * a provider answered with observations, when every carrying provider
   * answered with nothing, or when no provider carries the pair; false the
   * moment a carrying provider did not answer and nothing was found, because
   * that provider may hold history the others do not (INV-FX-005).
   */
  answered: boolean;
  /**
   * Whether some configured provider that may be asked about the pair carries
   * it. `false` only when every such provider said it does not: a coin without
   * a `quote_symbol` (claimed by the crypto adapter, carried by nobody), or a
   * pair no configured provider quotes. A provider that could not say counts
   * as carrying, so an unknown is never reported as uncarried. An uncarried
   * pair was asked of nobody, so its empty answer is a fact about the
   * configuration and the coin's mapping, not about the provider's history: a
   * caller never records coverage or an empty window for it, because mapping
   * a symbol changes the answer without changing the chain.
   */
  carried: boolean;
  /** The source slug of the provider whose points these are; `null` when there are none. */
  source: string | null;
}

export interface FxProviderDescription {
  name: RateProviderName;
  source: string;
}

/**
 * The configured exchange rate providers, in `FX_PROVIDERS` order, behind one
 * door.
 *
 * Every provider question passes through here (INV-FX-005): a provider is asked
 * only for the pairs it carries, providers are asked in order, and "the
 * provider answered with nothing" is kept apart from "the provider did not
 * answer" per provider, so an outage at the first provider is never recorded as
 * an empty window the second might have filled. The truth table is section 5
 * of `docs/specs/exchange-rate-providers.md`; `fx-provider-chain.spec.ts`
 * holds every row of it.
 *
 * A provider that `claims` a code (the crypto adapter claims every coin) is
 * the only one asked about a pair with that code on either side, and is asked
 * about nothing else (INV-CRYPTO-002, `docs/specs/crypto-accounts.md`
 * decision 5): Yahoo's `carries` is always true, so without the claim a coin
 * pair would reach its `=X` grammar first, and the coin adapter, which carries
 * every fiat code as a coin's counterpart, would answer a fiat pair it cannot
 * price as "nothing there" and hide the fiat providers' outage.
 *
 * A routing question that throws (`claims` or `carries`, which the crypto
 * adapter answers from a read of `currencies`) is "the provider could not
 * say", never "no": a pair whose claim is unknown is asked of nobody and is
 * `unanswered` (a series not `answered`, a live quote `null`), and a pair a
 * provider was to be asked about but could not say whether it carries is
 * `unanswered` by that provider. Read as `false`, an unknown claim would hand a
 * coin pair to Yahoo's `=X` grammar, whose `carries` is always true, and store
 * a coin rate under a fiat source.
 *
 * Built once by the factory in `currencies.module.ts`, which is why the class
 * is its own DI token rather than decorated `@Injectable()`.
 */
export class FxProviderChain {
  constructor(private readonly providers: readonly FxRateProvider[]) {}

  /**
   * The latest rate of `base` against each of `quotes`.
   *
   * Each quote goes to the first provider that carries both codes. A quote the
   * provider answered without a rate, or did not answer, moves on to the next
   * carrying provider; it is `unanswered` only when every carrying provider
   * returned `null`, and `uncarried` when there was no carrying provider.
   */
  async latest(
    base: string,
    quotes: readonly string[],
  ): Promise<FxLatestResult> {
    const found = new Map<string, FxChainObservation>();
    const carried = new Set<string>();
    const answered = new Set<string>();
    let remaining = [...new Set(quotes)];
    const claimed = new Set<string>();
    // A quote whose claim no provider could answer is asked of nobody: it is
    // counted carried and never answered, so it reports as unanswered.
    const unroutable = new Set<string>();
    for (const quote of remaining) {
      const claim = await this.pairClaimed(base, quote);
      if (claim === null) {
        unroutable.add(quote);
        carried.add(quote);
      } else if (claim) {
        claimed.add(quote);
      }
    }

    for (const provider of this.providers) {
      const askable = remaining.filter((quote) => !unroutable.has(quote));
      if (askable.length === 0) break;
      const carriesBase = await answerOf(() => provider.carries(base));
      if (carriesBase === false) continue;
      const asked: string[] = [];
      for (const quote of askable) {
        const may = await this.mayAsk(
          provider,
          base,
          quote,
          claimed.has(quote),
        );
        if (may === false) continue;
        // Due to be asked, but it could not say whether it may be or whether
        // it carries the pair: not an answer.
        const carriesQuote =
          may === null || carriesBase === null
            ? null
            : await answerOf(() => provider.carries(quote));
        if (carriesQuote === null) carried.add(quote);
        else if (carriesQuote) asked.push(quote);
      }
      if (asked.length === 0) continue;
      for (const quote of asked) carried.add(quote);

      const answer = await provider.fetchLatest(base, asked);
      if (answer === null) continue;
      for (const quote of asked) {
        answered.add(quote);
        const observation = answer.get(quote);
        if (observation) {
          found.set(quote, { ...observation, source: provider.source });
        }
      }
      remaining = remaining.filter((quote) => !found.has(quote));
    }

    return {
      found,
      unanswered: remaining.filter(
        (quote) => carried.has(quote) && !answered.has(quote),
      ),
      uncarried: remaining.filter((quote) => !carried.has(quote)),
    };
  }

  /**
   * Daily observations for one pair over [start, end], from the first carrying
   * provider that has any. A provider that answers with nothing hands the
   * window to the next; one that does not answer does too, but then the window
   * is `answered: false` unless a later provider found something. A pair no
   * provider that may be asked carries is `carried: false` (and `answered`,
   * since nobody failed to answer).
   */
  async dailySeries(
    from: string,
    to: string,
    start: string,
    end: string,
  ): Promise<FxDailySeriesResult> {
    let everyCarrierAnswered = true;
    let carried = false;
    const claimed = await this.pairClaimed(from, to);
    if (claimed === null) {
      return { points: [], answered: false, carried: true, source: null };
    }
    for (const provider of this.providers) {
      const asks = await this.asks(provider, from, to, claimed);
      if (asks === null) {
        // Could not say whether it carries the pair: not uncarried.
        carried = true;
        everyCarrierAnswered = false;
        continue;
      }
      if (!asks) continue;
      carried = true;
      const series = await provider.fetchDailySeries(from, to, start, end);
      if (series === null) {
        everyCarrierAnswered = false;
        continue;
      }
      if (series.length > 0) {
        return {
          points: series,
          answered: true,
          carried: true,
          source: provider.source,
        };
      }
    }
    return {
      points: [],
      answered: everyCarrierAnswered,
      carried,
      source: null,
    };
  }

  /**
   * The freshest observation for a pair: the first `fetchLive` answer from a
   * carrying provider that has a live feed, else the first `latest`
   * observation, else `null`.
   */
  async live(from: string, to: string): Promise<FxChainObservation | null> {
    const claimed = await this.pairClaimed(from, to);
    if (claimed === null) return null;
    for (const provider of this.providers) {
      if (!provider.fetchLive) continue;
      if ((await this.asks(provider, from, to, claimed)) !== true) continue;
      const observation = await provider.fetchLive(from, to);
      if (observation) return { ...observation, source: provider.source };
    }
    const { found } = await this.latest(from, [to]);
    return found.get(to) ?? null;
  }

  /** Whether any configured provider quotes this code. */
  async carriesAny(code: string): Promise<boolean> {
    for (const provider of this.providers) {
      if (await provider.carries(code)) return true;
    }
    return false;
  }

  /**
   * Whether the configured providers that can verify a code know it: `true`
   * when any says so, `false` only when every one answered no, `null` when one
   * did not answer (it may know the code) or none can verify at all. A lookup
   * aid for a code `carriesAny` does not vouch for; it never gates a rate.
   */
  async verifyCurrency(code: string): Promise<boolean | null> {
    let everyVerifierAnswered = true;
    let anyVerifier = false;
    for (const provider of this.providers) {
      if (!provider.verifyCurrency) continue;
      anyVerifier = true;
      const known = await provider.verifyCurrency(code);
      if (known === true) return true;
      if (known === null) everyVerifierAnswered = false;
    }
    return anyVerifier && everyVerifierAnswered ? false : null;
  }

  /** The first code a configured provider's free-text search resolves `query` to, in order. */
  async searchCurrency(query: string): Promise<string | null> {
    for (const provider of this.providers) {
      if (!provider.searchCurrency) continue;
      const code = await provider.searchCurrency(query);
      if (code !== null) return code;
    }
    return null;
  }

  /** Name and source slug per configured provider, in order, for the status endpoint. */
  describe(): FxProviderDescription[] {
    return this.providers.map((provider) => ({
      name: provider.name,
      source: provider.source,
    }));
  }

  /**
   * Whether a provider is to be asked about the pair: it may, and it carries
   * both codes. `null` when it was due to be asked but could not say.
   */
  private async asks(
    provider: FxRateProvider,
    from: string,
    to: string,
    claimed: boolean,
  ): Promise<boolean | null> {
    const may = await this.mayAsk(provider, from, to, claimed);
    if (may !== true) return may;
    const carriesFrom = await answerOf(() => provider.carries(from));
    if (carriesFrom !== true) return carriesFrom;
    return answerOf(() => provider.carries(to));
  }

  /**
   * Whether some configured provider claims either code of the pair; `null`
   * when none does and one could not say.
   */
  private async pairClaimed(from: string, to: string): Promise<boolean | null> {
    let unknown = false;
    for (const provider of this.providers) {
      const claim = await this.claimOf(provider, from, to);
      if (claim === true) return true;
      if (claim === null) unknown = true;
    }
    return unknown ? null : false;
  }

  /** Whether the provider claims either code; `null` when it could not say and claimed neither. */
  private async claimOf(
    provider: FxRateProvider,
    from: string,
    to: string,
  ): Promise<boolean | null> {
    const claims = provider.claims?.bind(provider);
    if (!claims) return false;
    const first = await answerOf(() => claims(from));
    if (first === true) return true;
    const second = await answerOf(() => claims(to));
    if (second === true) return true;
    return first === null || second === null ? null : false;
  }

  /**
   * The claim rule, before `carries`: a claimed pair is asked only of a
   * provider that claims one of its codes, and an unclaimed pair only of a
   * provider that claims nothing. `null` when the provider could not say
   * whether it claims a claimed pair.
   */
  private async mayAsk(
    provider: FxRateProvider,
    from: string,
    to: string,
    claimed: boolean,
  ): Promise<boolean | null> {
    if (!provider.claims) return !claimed;
    if (!claimed) return false;
    return this.claimOf(provider, from, to);
  }
}

/**
 * A provider's answer to a routing question (`claims`, `carries`), or `null`
 * when the question threw: the provider could not say, which is neither yes
 * nor no.
 */
async function answerOf(
  question: () => Promise<boolean>,
): Promise<boolean | null> {
  try {
    return await question();
  } catch {
    return null;
  }
}
