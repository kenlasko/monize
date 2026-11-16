import { Logger } from "@nestjs/common";
import {
  ProviderAdmission,
  ProviderHealthService,
} from "../../provider-health/provider-health.service";
import { isCalendarDate } from "../../common/validators/is-calendar-date.validator";
import { addDaysYMD } from "../../common/date-utils";
import {
  FxObservation,
  FxProviderName,
  FxRateProvider,
} from "./fx-provider.interface";
import { isRecord } from "../../common/helpers/is-record";
import { isPositiveFinite } from "../../common/helpers/is-positive-finite";

/** The id this adapter reports under. Must match `TRACKED_PROVIDERS`. */
export const FRANKFURTER_V2_PROVIDER = "frankfurter_v2";

/** The public instance; `FX_FRANKFURTER_V2_BASE_URL` points at a self-hosted one or a proxy. */
export const DEFAULT_FRANKFURTER_V2_BASE_URL = "https://api.frankfurter.dev/v2";

/** A latest-rates or currency-list call answers in one small body. */
export const FRANKFURTER_V2_LATEST_TIMEOUT_MS = 15_000;

/**
 * A blended range answers daily however long it is: the whole USD/CAD history
 * (1.48 MB, 23,453 rows) took 30.6 s uncached on 2026-11-16, so twice that
 * (`docs/specs/frankfurter-v2-provider.md`, decision 8).
 */
export const FRANKFURTER_V2_SERIES_TIMEOUT_MS = 120_000;

/** The currency list is held this long (decision 5). */
export const FRANKFURTER_V2_CURRENCY_LIST_TTL_MS = 24 * 60 * 60_000;

/** How long the compiled-in list stands in after the list could not be fetched. */
export const FRANKFURTER_V2_CURRENCY_LIST_RETRY_MS = 5 * 60_000;

/**
 * The `type: "currency"` codes the public instance listed on 2026-11-16
 * (`docs/specs/frankfurter-v2-provider.md`, section 3.4). Read only when the
 * instance's own list cannot be fetched.
 */
export const FRANKFURTER_V2_FALLBACK_CURRENCIES: readonly string[] = (
  "AED AFN ALL AMD ANG AOA ARS AUD AWG AZN BAM BBD BDT BHD BIF BMD BND BOB BRL " +
  "BSD BTN BWP BYN BZD CAD CDF CHF CLP CMD CNH CNY COP CRC CUP CVE CZK DJF DKK " +
  "DOP DZD EGP ERN ETB EUR FJD FKP GBP GEL GGP GHS GIP GMD GNF GTQ GYD HKD HNL " +
  "HTG HUF IDR ILS IMP INR IQD IRR ISK JEP JMD JOD JPY KES KGS KHR KMF KPW KRW " +
  "KWD KYD KZT LAK LBP LKR LRD LSL LYD MAD MDL MGA MKD MMK MNT MOP MRU MUR MVR " +
  "MWK MXN MYR MZN NAD NGN NIO NOK NPR NZD OMR PAB PEN PGK PHP PKR PLN PYG QAR " +
  "RON RSD RUB RWF SAR SBD SCR SDG SEK SGD SHP SLE SOS SRD SSP STN SVC SYP SZL " +
  "THB TJS TMT TND TOP TRY TTD TWD TZS UAH UGX USD UYU UZS VES VND VUV WST XAF " +
  "XCD XCG XDR XOF XPF YER ZAR ZMW ZWG"
).split(" ");

const FALLBACK_CURRENCY_SET: ReadonlySet<string> = new Set(
  FRANKFURTER_V2_FALLBACK_CURRENCIES,
);

/** Names the deployment to the instance operator; the project asks for nothing more. */
const USER_AGENT = "Monize (+https://github.com/kenlasko/monize)";

/**
 * The base URL the adapter calls, from `FX_FRANKFURTER_V2_BASE_URL`: the
 * default when unset or blank, otherwise the value trimmed with any trailing
 * slash removed. A self-hosted instance may serve at a path without `/v2`.
 */
export function resolveFrankfurterV2BaseUrl(
  raw: string | null | undefined,
): string {
  const trimmed = (raw ?? "").trim().replace(/\/+$/, "");
  return trimmed.length > 0 ? trimmed : DEFAULT_FRANKFURTER_V2_BASE_URL;
}

/** What one request came back with; `null` is "did not answer". */
type FrankfurterV2Answer =
  { kind: "body"; body: unknown } | { kind: "not-found" } | null;

interface CachedCurrencyList {
  codes: ReadonlySet<string>;
  validUntil: number;
}

/** One `/rates` record, the only shape v2 answers a rate in. */
interface RateRecord {
  date: string;
  base: string;
  quote: string;
  rate: number;
}

/** Saturday or Sunday, read in UTC because a `YYYY-MM-DD` carries no zone. */
function isWeekend(ymd: string): boolean {
  const [y, m, d] = ymd.split("-").map(Number);
  const day = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return day === 0 || day === 6;
}

/** The Friday before a Saturday or Sunday. */
function fridayBefore(ymd: string): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const day = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return addDaysYMD(ymd, day === 0 ? -2 : -1);
}

/**
 * The records of a `/rates` answer, or `null` when the body is not an array.
 * A malformed record inside an array is skipped, not fatal: the others are
 * still observations the instance made.
 */
function readRateRecords(body: unknown): RateRecord[] | null {
  if (!Array.isArray(body)) return null;
  const records: RateRecord[] = [];
  for (const item of body) {
    if (!isRecord(item)) continue;
    const { date, base, quote, rate } = item;
    if (!isCalendarDate(date)) continue;
    if (typeof base !== "string" || typeof quote !== "string") continue;
    // A published rate is a positive finite number; anything else is not an observation.
    if (typeof rate !== "number" || !isPositiveFinite(rate)) continue;
    records.push({
      date,
      base: base.toUpperCase(),
      quote: quote.toUpperCase(),
      rate,
    });
  }
  return records;
}

/**
 * `[{ iso_code, type, ... }]`, kept to `type: "currency"`: a coin is priced by
 * the crypto provider alone (INV-CRYPTO-002) and a metal is not a currency
 * Monize holds. A list with no currency in it is not one this adapter can act on.
 */
function readCurrencyList(body: unknown): ReadonlySet<string> | null {
  if (!Array.isArray(body)) return null;
  const codes = new Set<string>();
  for (const item of body) {
    if (!isRecord(item) || item.type !== "currency") continue;
    const code = item.iso_code;
    if (typeof code === "string" && /^[A-Z]{3}$/.test(code)) codes.add(code);
  }
  return codes.size > 0 ? codes : null;
}

/**
 * Exchange rates from Frankfurter's v2 API: rates blended from about a hundred
 * central banks, no key, daily history for USD/CAD from 1953, about 160 fiat
 * currencies. The chain's first provider. `docs/specs/frankfurter-v2-provider.md`
 * records the responses this adapter is built on, and why its slug stays
 * `frankfurter_v2` after the ECB-only v1 adapter was removed: the rows that
 * adapter wrote keep `frankfurter`, and the coverage they recorded (history
 * from 1999) is not read as this provider's.
 *
 * Three endpoints. `rates?base=B&quotes=Q1,Q2` (latest, or `date=` one day)
 * and `rates?from=S&to=E&base=B&quotes=Q` answer an array of
 * `{ date, base, quote, rate }`, "quote per 1 base", which is
 * `FxObservation { from: base, to: quote }` with no inversion. `currencies` is
 * the list `carries` and `verifyCurrency` read, fiat entries only, cached for
 * a day, with the compiled-in list standing in while it cannot be fetched.
 *
 * No Saturday or Sunday row leaves this adapter (decision 3): the blend
 * re-publishes Friday's observations of other banks under the weekend's dates,
 * which observe nothing `resolveFxRate`'s carry-forward does not already give.
 * A `latest` dated on a weekend is asked again for the Friday before it, so a
 * weekend refresh still stores Friday's rate dated Friday (decision 4).
 *
 * Every call goes through the breaker in the shape every outbound client here
 * uses: a non-2xx is
 * a complete answer recorded the moment it arrives, a 2xx is recorded only
 * once its body has arrived, and a probe holder hands back a slot the breaker
 * did not count. A 404 is "answered, nothing"; a 422 (a code the instance's
 * own list named, refused by `/rates`), a 429, a 5xx and every transport
 * failure are "did not answer" (`null`), and only the transport failures move
 * the breaker (section 3.3).
 */
export class FrankfurterV2FxProvider implements FxRateProvider {
  readonly name: FxProviderName = "frankfurter_v2";
  readonly source = "frankfurter_v2";
  private readonly logger = new Logger(FrankfurterV2FxProvider.name);
  private currencyList: CachedCurrencyList | null = null;
  private currencyListInFlight: Promise<ReadonlySet<string>> | null = null;

  constructor(
    private readonly health: ProviderHealthService,
    private readonly baseUrl: string = DEFAULT_FRANKFURTER_V2_BASE_URL,
  ) {}

  async carries(code: string): Promise<boolean> {
    const codes = await this.currencyCodes();
    return codes.has(code.toUpperCase());
  }

  /**
   * Whether the instance's own list names the code. While the compiled-in list
   * stands in, a code it does not name is no answer: the instance may carry it.
   */
  async verifyCurrency(code: string): Promise<boolean | null> {
    const codes = await this.currencyCodes();
    if (codes.has(code.toUpperCase())) return true;
    return codes === FALLBACK_CURRENCY_SET ? null : false;
  }

  async fetchLatest(
    base: string,
    quotes: readonly string[],
  ): Promise<ReadonlyMap<string, FxObservation> | null> {
    if (quotes.length === 0) return new Map();

    const latest = await this.ratesFor(base, quotes, null);
    if (latest === null) return null;
    const dates = new Set([...latest.values()].map((point) => point.date));
    const weekend = [...dates].find(isWeekend);
    if (weekend === undefined) return latest;

    // A weekend `latest` is a re-blend of Friday's observations; ask for the
    // Friday itself so the row stored is the one that was observed. A
    // non-answer here is a non-answer for the whole call: the weekend values
    // are never stored in its place.
    return this.ratesFor(base, quotes, fridayBefore(weekend));
  }

  async fetchDailySeries(
    from: string,
    to: string,
    start: string,
    end: string,
  ): Promise<FxObservation[] | null> {
    // The dates go into the query string. A caller passes calendar dates
    // (`ParseCalendarDatePipe`, `enumerateDaysYMD`); anything else is a bug
    // here, not a request to send.
    if (!isCalendarDate(start) || !isCalendarDate(end)) {
      throw new Error(
        `Frankfurter v2 daily series needs YYYY-MM-DD bounds, got "${start}" and "${end}"`,
      );
    }
    const fromCode = from.toUpperCase();
    const toCode = to.toUpperCase();
    const context = `daily rates for ${from}/${to} from ${start} to ${end}`;
    const answer = await this.request(
      `rates?from=${start}&to=${end}&base=${encodeURIComponent(fromCode)}&quotes=${encodeURIComponent(toCode)}`,
      FRANKFURTER_V2_SERIES_TIMEOUT_MS,
      context,
    );
    if (answer === null) return null;
    if (answer.kind === "not-found") return [];

    const records = readRateRecords(answer.body);
    if (records === null) return this.unreadable(context);
    const points: FxObservation[] = [];
    for (const record of records) {
      if (record.base !== fromCode || record.quote !== toCode) continue;
      // The instance moves a start back to the previous published day; that
      // record is outside the window the caller asked for.
      if (record.date < start || record.date > end) continue;
      if (isWeekend(record.date)) continue;
      points.push({ from, to, date: record.date, rate: record.rate });
    }
    return points.sort((a, b) => a.date.localeCompare(b.date));
  }

  /**
   * One `/rates` call for a base against quotes, latest when `date` is null.
   * An empty map is "answered, no rate for any of them".
   */
  private async ratesFor(
    base: string,
    quotes: readonly string[],
    date: string | null,
  ): Promise<ReadonlyMap<string, FxObservation> | null> {
    const baseCode = base.toUpperCase();
    const symbols = quotes.map((quote) => quote.toUpperCase()).join(",");
    const context =
      date === null
        ? `latest rates for ${base} against ${symbols}`
        : `rates for ${base} against ${symbols} on ${date}`;
    // Each code encoded on its own, so the separator stays a literal comma.
    const quotesParam = quotes
      .map((quote) => encodeURIComponent(quote.toUpperCase()))
      .join(",");
    const datePart = date === null ? "" : `date=${date}&`;
    const answer = await this.request(
      `rates?${datePart}base=${encodeURIComponent(baseCode)}&quotes=${quotesParam}`,
      FRANKFURTER_V2_LATEST_TIMEOUT_MS,
      context,
    );
    const found = new Map<string, FxObservation>();
    if (answer === null) return null;
    if (answer.kind === "not-found") return found;

    const records = readRateRecords(answer.body);
    if (records === null) return this.unreadable(context);
    for (const quote of quotes) {
      const quoteCode = quote.toUpperCase();
      // The identity record (quote equal to base) is never a rate the chain
      // asked for; `rate 1` means "same currency" and nothing else.
      if (quoteCode === baseCode) continue;
      const record = records.find(
        (item) => item.base === baseCode && item.quote === quoteCode,
      );
      if (record !== undefined) {
        found.set(quote, {
          from: base,
          to: quote,
          date: record.date,
          rate: record.rate,
        });
      }
    }
    return found;
  }

  /**
   * The instance's own fiat list, fetched once and held for a day; while it
   * cannot be fetched, the compiled-in list, held for a few minutes.
   * Concurrent callers share one fetch.
   */
  private async currencyCodes(): Promise<ReadonlySet<string>> {
    const cached = this.currencyList;
    if (cached !== null && Date.now() < cached.validUntil) return cached.codes;
    if (this.currencyListInFlight === null) {
      this.currencyListInFlight = this.loadCurrencyList().finally(() => {
        this.currencyListInFlight = null;
      });
    }
    return this.currencyListInFlight;
  }

  private async loadCurrencyList(): Promise<ReadonlySet<string>> {
    const context = "the list of currencies Frankfurter v2 carries";
    const answer = await this.request(
      "currencies",
      FRANKFURTER_V2_LATEST_TIMEOUT_MS,
      context,
    );
    const codes =
      answer?.kind === "body" ? readCurrencyList(answer.body) : null;
    if (codes === null) {
      if (answer?.kind === "body") this.unreadable(context);
      this.logger.warn(
        `The compiled-in list of ${FRANKFURTER_V2_FALLBACK_CURRENCIES.length} Frankfurter v2 currencies stands in ` +
          `for ${Math.round(FRANKFURTER_V2_CURRENCY_LIST_RETRY_MS / 60_000)} minutes`,
      );
      this.currencyList = {
        codes: FALLBACK_CURRENCY_SET,
        validUntil: Date.now() + FRANKFURTER_V2_CURRENCY_LIST_RETRY_MS,
      };
      return FALLBACK_CURRENCY_SET;
    }
    this.currencyList = {
      codes,
      validUntil: Date.now() + FRANKFURTER_V2_CURRENCY_LIST_TTL_MS,
    };
    return codes;
  }

  /**
   * One GET against the instance, through the breaker. `null` is "did not
   * answer": refused by the breaker, a transport failure, a timeout, a body
   * that never finished, or a non-2xx other than 404.
   */
  private async request(
    path: string,
    timeoutMs: number,
    context: string,
  ): Promise<FrankfurterV2Answer> {
    let admission: ProviderAdmission;
    try {
      admission = this.health.assertAvailable(FRANKFURTER_V2_PROVIDER);
    } catch (error) {
      // Refused before anything was asked. `logFailure` prints nothing for a
      // refusal and reports what it suppressed on the next line that prints.
      this.health.logFailure(
        this.logger,
        FRANKFURTER_V2_PROVIDER,
        context,
        error,
      );
      return null;
    }

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/${path}`, {
        headers: { Accept: "application/json", "User-Agent": USER_AGENT },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      this.reportFailure(admission, context, error);
      return null;
    }

    if (!response.ok) {
      // A complete answer with nothing left to read: the host is up, whatever
      // it said.
      this.health.recordSuccess(FRANKFURTER_V2_PROVIDER);
      if (response.status === 404) {
        this.logger.warn(`Frankfurter v2 has nothing for ${context}`);
        return { kind: "not-found" };
      }
      // A 422 names a code the instance's own list carried but `/rates`
      // refused, and fails the whole request; a 429 or a 5xx declines it.
      // None says the window is empty, so none is remembered as one, and none
      // is a transport failure, so the breaker does not count it.
      this.health.logFailure(
        this.logger,
        FRANKFURTER_V2_PROVIDER,
        context,
        new Error(`Frankfurter v2 returned HTTP ${response.status}`),
      );
      return null;
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch (error) {
      // A body that never finished arriving is a transport failure after the
      // headers; it is counted here or a stalling host never opens the
      // breaker. Malformed JSON lands here too and is not counted, which is
      // the breaker's own rule.
      this.reportFailure(admission, context, error);
      return null;
    }
    this.health.recordSuccess(FRANKFURTER_V2_PROVIDER);
    return { kind: "body", body };
  }

  /**
   * Count and log one failed attempt, and give back the probe slot when the
   * breaker did not count it. Only the probe holder may hand the slot back.
   */
  private reportFailure(
    admission: ProviderAdmission,
    context: string,
    error: unknown,
  ): void {
    const counted = this.health.recordFailure(FRANKFURTER_V2_PROVIDER, error);
    if (!counted && admission === "probe") {
      this.health.releaseProbe(FRANKFURTER_V2_PROVIDER);
    }
    this.health.logFailure(
      this.logger,
      FRANKFURTER_V2_PROVIDER,
      context,
      error,
    );
  }

  /**
   * A 2xx whose body is not the shape this adapter reads: "did not answer" to
   * the chain and one rate-limited line to the operator, uncounted.
   */
  private unreadable(context: string): null {
    this.health.logFailure(
      this.logger,
      FRANKFURTER_V2_PROVIDER,
      context,
      new Error(`Frankfurter v2 returned an unreadable response to ${context}`),
    );
    return null;
  }
}
