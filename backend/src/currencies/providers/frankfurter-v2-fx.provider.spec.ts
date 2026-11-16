import { Logger } from "@nestjs/common";
import { ProviderHealthService } from "../../provider-health/provider-health.service";
import { ProviderUnavailableError } from "../../provider-health/provider-unavailable.error";
import { TRACKED_PROVIDERS } from "../../provider-health/providers";
import { CURRENCY_METADATA } from "../currency-metadata";
import {
  DEFAULT_FRANKFURTER_V2_BASE_URL,
  FRANKFURTER_V2_CURRENCY_LIST_RETRY_MS,
  FRANKFURTER_V2_CURRENCY_LIST_TTL_MS,
  FRANKFURTER_V2_FALLBACK_CURRENCIES,
  FRANKFURTER_V2_LATEST_TIMEOUT_MS,
  FRANKFURTER_V2_PROVIDER,
  FRANKFURTER_V2_SERIES_TIMEOUT_MS,
  FrankfurterV2FxProvider,
  resolveFrankfurterV2BaseUrl,
} from "./frankfurter-v2-fx.provider";

/*
 * Fixtures, copied verbatim from section 3.1 of
 * `docs/specs/frankfurter-v2-provider.md`, recorded from the public instance
 * on 2026-11-16. None is edited by hand: a fixture is evidence only while the
 * producer could have written it. `CURRENCIES` is seven entries of the
 * recorded 200, unedited.
 */

const LATEST_USD = JSON.parse(
  '[{"date":"2026-11-16","base":"USD","quote":"CAD","rate":1.4262},{"date":"2026-11-16","base":"USD","quote":"EUR","rate":0.90573},' +
    '{"date":"2026-11-16","base":"USD","quote":"SGD","rate":1.2878}]',
);
/** `rates?date=2026-11-13&base=USD&quotes=CAD,EUR`, a Friday. */
const FRIDAY_USD = JSON.parse(
  '[{"date":"2026-11-13","base":"USD","quote":"CAD","rate":1.4242},{"date":"2026-11-13","base":"USD","quote":"EUR","rate":0.90271}]',
);
/** `rates?date=2026-11-14&base=USD&quotes=CAD`, a Saturday, dated Saturday. */
const SATURDAY_USD_CAD = JSON.parse(
  '[{"date":"2026-11-14","base":"USD","quote":"CAD","rate":1.4243}]',
);
/** `rates?from=2026-11-13&to=2026-11-16&base=USD&quotes=CAD`: Friday to Monday. */
const WEEKEND_RANGE = JSON.parse(
  '[{"date":"2026-11-13","base":"USD","quote":"CAD","rate":1.4242},{"date":"2026-11-14","base":"USD","quote":"CAD","rate":1.4243},' +
    '{"date":"2026-11-15","base":"USD","quote":"CAD","rate":1.4244},{"date":"2026-11-16","base":"USD","quote":"CAD","rate":1.4262}]',
);
/** `rates?from=2024-01-01&to=2024-01-05&base=USD&quotes=CAD`: a holiday row on 2024-01-01. */
const RANGE_2024_01_01_TO_05 = JSON.parse(
  '[{"date":"2024-01-01","base":"USD","quote":"CAD","rate":1.3225},{"date":"2024-01-02","base":"USD","quote":"CAD","rate":1.3258},' +
    '{"date":"2024-01-03","base":"USD","quote":"CAD","rate":1.3318},{"date":"2024-01-04","base":"USD","quote":"CAD","rate":1.3331},' +
    '{"date":"2024-01-05","base":"USD","quote":"CAD","rate":1.3344}]',
);
/** `rates?from=1985-01-01&to=1985-01-03&base=USD&quotes=CAD`: the start moved back to 1984-12-31. */
const RANGE_START_MOVED_BACK = JSON.parse(
  '[{"date":"1984-12-31","base":"USD","quote":"CAD","rate":1.3194},{"date":"1985-01-02","base":"USD","quote":"CAD","rate":1.3216},' +
    '{"date":"1985-01-03","base":"USD","quote":"CAD","rate":1.321}]',
);
/** `rates?from=1953-05-08&to=1953-05-14&base=USD&quotes=CAD`: USD/CAD's first published days. */
const FIRST_DAYS_1953 = JSON.parse(
  '[{"date":"1953-05-11","base":"USD","quote":"CAD","rate":0.99408},{"date":"1953-05-12","base":"USD","quote":"CAD","rate":0.99455},' +
    '{"date":"1953-05-13","base":"USD","quote":"CAD","rate":0.99526}]',
);
/** `rates?from=2024-01-02&to=2024-01-03&base=TWD&quotes=USD`: a code the ECB never published. */
const TWD_USD = JSON.parse(
  '[{"date":"2024-01-02","base":"TWD","quote":"USD","rate":0.032518},{"date":"2024-01-03","base":"TWD","quote":"USD","rate":0.032352}]',
);
/** `rates?from=1950-01-01&to=1950-01-10&base=USD&quotes=CAD`, and the same for 2030. */
const EMPTY_RANGE = JSON.parse("[]");
const INVALID_CURRENCY = JSON.parse(
  '{"status":422,"message":"invalid currency: XYZ"}',
);
const NOT_FOUND = JSON.parse('{"status":404,"message":"not found"}');
/** Seven entries of `GET {base}/currencies`: five currencies, a coin and a metal. */
const CURRENCIES = JSON.parse(
  '[{"iso_code":"AED","iso_numeric":"784","name":"United Arab Emirates Dirham","symbol":"د.إ","type":"currency","start_date":"1996-04-11","end_date":"2026-11-16"},' +
    '{"iso_code":"BTC","iso_numeric":null,"name":"Bitcoin","symbol":"₿","type":"crypto","start_date":"2010-07-18","end_date":"2026-11-15"},' +
    '{"iso_code":"CAD","iso_numeric":"124","name":"Canadian Dollar","symbol":"$","type":"currency","start_date":"1953-05-11","end_date":"2026-11-16"},' +
    '{"iso_code":"EUR","iso_numeric":"978","name":"Euro","symbol":"€","type":"currency","start_date":"1999-01-01","end_date":"2026-11-16"},' +
    '{"iso_code":"TWD","iso_numeric":"901","name":"New Taiwan Dollar","symbol":"$","type":"currency","start_date":"1981-01-02","end_date":"2026-11-16"},' +
    '{"iso_code":"USD","iso_numeric":"840","name":"United States Dollar","symbol":"$","type":"currency","start_date":"1948-06-21","end_date":"2026-11-16"},' +
    '{"iso_code":"XAU","iso_numeric":"959","name":"Gold (Troy Ounce)","symbol":"oz t","type":"metal","start_date":"1999-01-05","end_date":"2026-11-16"}]',
);

/** A `fetch failed` as undici raises it: the one shape the breaker counts by name alone. */
function transportFailure(): Error {
  const error = new TypeError("fetch failed");
  (error as { cause?: unknown }).cause = Object.assign(
    new Error("getaddrinfo EAI_AGAIN api.frankfurter.dev"),
    { code: "EAI_AGAIN" },
  );
  return error;
}

describe("FrankfurterV2FxProvider", () => {
  const originalFetch = global.fetch;
  let fetchMock: jest.Mock;
  let health: jest.Mocked<
    Pick<
      ProviderHealthService,
      | "assertAvailable"
      | "recordSuccess"
      | "recordFailure"
      | "releaseProbe"
      | "logFailure"
    >
  >;
  let provider: FrankfurterV2FxProvider;
  let warn: jest.SpyInstance;
  let timeoutSpy: jest.SpyInstance;

  const respond = (status: number, payload: unknown) => ({
    ok: status >= 200 && status < 300,
    status,
    json: jest.fn().mockResolvedValue(payload),
  });
  const answer = (status: number, payload: unknown) =>
    fetchMock.mockResolvedValueOnce(respond(status, payload));
  const askedUrl = (call = 0): string => fetchMock.mock.calls[call][0];
  const askedInit = (call = 0): RequestInit => fetchMock.mock.calls[call][1];
  const series = (start: string, end: string, from = "USD", to = "CAD") =>
    provider.fetchDailySeries(from, to, start, end);

  beforeEach(() => {
    fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    health = {
      assertAvailable: jest.fn().mockReturnValue("open-gate"),
      recordSuccess: jest.fn(),
      recordFailure: jest.fn().mockReturnValue(true),
      releaseProbe: jest.fn(),
      logFailure: jest.fn(),
    } as unknown as typeof health;
    provider = new FrankfurterV2FxProvider(
      health as unknown as ProviderHealthService,
    );
    warn = jest.spyOn(Logger.prototype, "warn").mockImplementation(() => {});
    timeoutSpy = jest.spyOn(AbortSignal, "timeout");
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  afterAll(() => {
    global.fetch = originalFetch;
  });

  it("names itself as the chain, the row and the breaker know it, apart from the v1 rows' frankfurter slug", () => {
    expect(provider.name).toBe("frankfurter_v2");
    expect(provider.source).toBe("frankfurter_v2");
    expect(FRANKFURTER_V2_PROVIDER).toBe("frankfurter_v2");
    expect(TRACKED_PROVIDERS[FRANKFURTER_V2_PROVIDER]).toBe("Frankfurter");
    expect(DEFAULT_FRANKFURTER_V2_BASE_URL).toBe(
      "https://api.frankfurter.dev/v2",
    );
  });

  describe("fetchLatest", () => {
    it("answers each { base, quote, rate } record as { from: base, to: quote }, dated by the instance, no inversion", async () => {
      answer(200, LATEST_USD);

      const found = await provider.fetchLatest("USD", ["CAD", "EUR", "SGD"]);

      expect([...found!.entries()]).toEqual([
        ["CAD", { from: "USD", to: "CAD", date: "2026-11-16", rate: 1.4262 }],
        ["EUR", { from: "USD", to: "EUR", date: "2026-11-16", rate: 0.90573 }],
        ["SGD", { from: "USD", to: "SGD", date: "2026-11-16", rate: 1.2878 }],
      ]);
      expect(askedUrl()).toBe(
        `${DEFAULT_FRANKFURTER_V2_BASE_URL}/rates?base=USD&quotes=CAD,EUR,SGD`,
      );
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("sends the headers the instance operator can act on, under the latest timeout", async () => {
      answer(200, LATEST_USD);

      await provider.fetchLatest("USD", ["CAD"]);

      const headers = askedInit().headers as Record<string, string>;
      expect(headers["User-Agent"]).toContain("Monize");
      expect(headers.Accept).toBe("application/json");
      expect(timeoutSpy).toHaveBeenCalledWith(FRANKFURTER_V2_LATEST_TIMEOUT_MS);
    });

    it("asks nothing for an empty quote list", async () => {
      const found = await provider.fetchLatest("USD", []);

      expect(found!.size).toBe(0);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(health.assertAvailable).not.toHaveBeenCalled();
    });

    it("leaves out a quote the answer has no record for: answered, no rate for it", async () => {
      answer(200, LATEST_USD);

      const found = await provider.fetchLatest("USD", ["CAD", "JPY"]);

      expect([...found!.keys()]).toEqual(["CAD"]);
    });

    it("never answers the identity record as a rate", async () => {
      answer(200, [
        { date: "2026-11-16", base: "USD", quote: "USD", rate: 1.0 },
        ...LATEST_USD,
      ]);

      const found = await provider.fetchLatest("USD", ["USD", "CAD"]);

      expect([...found!.keys()]).toEqual(["CAD"]);
    });

    it("asks again for the Friday when latest comes back dated on a weekend, and answers Friday's rows", async () => {
      answer(200, SATURDAY_USD_CAD);
      answer(200, FRIDAY_USD);

      const found = await provider.fetchLatest("USD", ["CAD", "EUR"]);

      expect(askedUrl(1)).toBe(
        `${DEFAULT_FRANKFURTER_V2_BASE_URL}/rates?date=2026-11-13&base=USD&quotes=CAD,EUR`,
      );
      expect([...found!.entries()]).toEqual([
        ["CAD", { from: "USD", to: "CAD", date: "2026-11-13", rate: 1.4242 }],
        ["EUR", { from: "USD", to: "EUR", date: "2026-11-13", rate: 0.90271 }],
      ]);
    });

    it("reads a Sunday's latest back to the Friday two days before", async () => {
      answer(200, [
        { date: "2026-11-15", base: "USD", quote: "CAD", rate: 1.4244 },
      ]);
      answer(200, FRIDAY_USD);

      const found = await provider.fetchLatest("USD", ["CAD"]);

      expect(askedUrl(1)).toContain("date=2026-11-13&");
      expect(found!.get("CAD")!.date).toBe("2026-11-13");
    });

    it("stores nothing of the weekend answer when the Friday request does not answer", async () => {
      answer(200, SATURDAY_USD_CAD);
      answer(503, { status: 503, message: "busy" });

      expect(await provider.fetchLatest("USD", ["CAD"])).toBeNull();
    });

    it("reads a 422 for a code the list named as no answer, not as an empty answer", async () => {
      answer(422, INVALID_CURRENCY);

      const found = await provider.fetchLatest("USD", ["CAD", "XYZ"]);

      expect(found).toBeNull();
      expect(health.recordSuccess).toHaveBeenCalledTimes(1);
      expect(health.recordFailure).not.toHaveBeenCalled();
      expect(health.logFailure).toHaveBeenCalledTimes(1);
      expect((health.logFailure.mock.calls[0][3] as Error).message).toContain(
        "HTTP 422",
      );
    });

    it("drops a record whose rate is not a positive finite number, or whose date is not a calendar date", async () => {
      answer(200, [
        { date: "2026-11-16", base: "USD", quote: "CAD", rate: 0 },
        { date: "2026-11-16", base: "USD", quote: "EUR", rate: "0.9" },
        { date: "today", base: "USD", quote: "SGD", rate: 1.3 },
        { date: "2026-11-16", base: "USD", quote: "JPY", rate: 154.2 },
      ]);

      const found = await provider.fetchLatest("USD", [
        "CAD",
        "EUR",
        "SGD",
        "JPY",
      ]);

      expect([...found!.keys()]).toEqual(["JPY"]);
    });
  });

  describe("fetchDailySeries", () => {
    it("asks one range for the pair under the series timeout, keeping a weekday holiday's row", async () => {
      answer(200, RANGE_2024_01_01_TO_05);

      const points = await series("2024-01-01", "2024-01-05");

      expect(points!.map((point) => [point.date, point.rate])).toEqual([
        ["2024-01-01", 1.3225],
        ["2024-01-02", 1.3258],
        ["2024-01-03", 1.3318],
        ["2024-01-04", 1.3331],
        ["2024-01-05", 1.3344],
      ]);
      expect(points![0]).toEqual({
        from: "USD",
        to: "CAD",
        date: "2024-01-01",
        rate: 1.3225,
      });
      expect(askedUrl()).toBe(
        `${DEFAULT_FRANKFURTER_V2_BASE_URL}/rates?from=2024-01-01&to=2024-01-05&base=USD&quotes=CAD`,
      );
      expect(timeoutSpy).toHaveBeenCalledWith(FRANKFURTER_V2_SERIES_TIMEOUT_MS);
      expect(health.recordSuccess).toHaveBeenCalledTimes(1);
    });

    it("drops the Saturday and Sunday rows the blend publishes", async () => {
      answer(200, WEEKEND_RANGE);

      const points = await series("2026-11-13", "2026-11-16");

      expect(points!.map((point) => point.date)).toEqual([
        "2026-11-13",
        "2026-11-16",
      ]);
    });

    it("answers a weekend-only window as answered with nothing", async () => {
      answer(200, WEEKEND_RANGE.slice(1, 3));

      expect(await series("2026-11-14", "2026-11-15")).toEqual([]);
      expect(health.logFailure).not.toHaveBeenCalled();
    });

    it("drops the record the instance moved back before start", async () => {
      answer(200, RANGE_START_MOVED_BACK);

      const points = await series("1985-01-01", "1985-01-03");

      expect(points!.map((point) => point.date)).toEqual([
        "1985-01-02",
        "1985-01-03",
      ]);
    });

    it("reaches back before 1999, to USD/CAD's first published day in 1953", async () => {
      answer(200, FIRST_DAYS_1953);

      const points = await series("1953-05-08", "1953-05-14");

      expect(points!.map((point) => [point.date, point.rate])).toEqual([
        ["1953-05-11", 0.99408],
        ["1953-05-12", 0.99455],
        ["1953-05-13", 0.99526],
      ]);
    });

    it("answers a code the ECB never published, in the orientation asked", async () => {
      answer(200, TWD_USD);

      const points = await series("2024-01-02", "2024-01-03", "TWD", "USD");

      expect(points).toEqual([
        { from: "TWD", to: "USD", date: "2024-01-02", rate: 0.032518 },
        { from: "TWD", to: "USD", date: "2024-01-03", rate: 0.032352 },
      ]);
    });

    it.each([
      ["wholly before the pair's history", "1950-01-01", "1950-01-10"],
      ["wholly in the future", "2030-01-01", "2030-01-05"],
    ])(
      "reads the 200 [] for a window %s as answered with nothing",
      async (_label, start, end) => {
        answer(200, EMPTY_RANGE);

        expect(await series(start, end)).toEqual([]);
        expect(health.recordSuccess).toHaveBeenCalledTimes(1);
        expect(health.logFailure).not.toHaveBeenCalled();
      },
    );

    it("reads a 404 as answered with nothing, warned about once", async () => {
      answer(404, NOT_FOUND);

      expect(await series("2024-01-01", "2024-01-05")).toEqual([]);
      expect(health.recordSuccess).toHaveBeenCalledTimes(1);
      expect(health.logFailure).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledTimes(1);
    });

    it("keeps only records of the pair asked, ordered by date whatever order the body lists them in", async () => {
      answer(200, [
        { date: "2024-01-04", base: "USD", quote: "CAD", rate: 1.3331 },
        { date: "2024-01-03", base: "USD", quote: "EUR", rate: 0.91 },
        { date: "2024-01-02", base: "USD", quote: "CAD", rate: 1.3258 },
        { date: "2024-01-03", base: "USD", quote: "CAD", rate: null },
      ]);

      const points = await series("2024-01-01", "2024-01-05");

      expect(points!.map((point) => point.date)).toEqual([
        "2024-01-02",
        "2024-01-04",
      ]);
    });

    it("refuses to build a request from bounds that are not calendar dates", async () => {
      await expect(series("2024-01-01", "2024-01-05&base=EUR")).rejects.toThrow(
        "YYYY-MM-DD",
      );
      expect(fetchMock).not.toHaveBeenCalled();
      expect(health.assertAvailable).not.toHaveBeenCalled();
    });
  });

  /** Section 3.3 of the spec, row by row, against the fake breaker. */
  describe("status handling (spec section 3.3)", () => {
    it("200, body parsed: recorded as an answer once, after the body arrived", async () => {
      const response = respond(200, LATEST_USD);
      let recordedBeforeBody = false;
      response.json.mockImplementation(async () => {
        recordedBeforeBody = health.recordSuccess.mock.calls.length > 0;
        return LATEST_USD;
      });
      fetchMock.mockResolvedValueOnce(response);

      await provider.fetchLatest("USD", ["CAD"]);

      expect(health.assertAvailable).toHaveBeenCalledWith("frankfurter_v2");
      expect(recordedBeforeBody).toBe(false);
      expect(health.recordSuccess).toHaveBeenCalledTimes(1);
      expect(health.recordSuccess).toHaveBeenCalledWith("frankfurter_v2");
      expect(health.recordFailure).not.toHaveBeenCalled();
      expect(health.logFailure).not.toHaveBeenCalled();
    });

    it.each([422, 429, 500, 503])(
      "HTTP %i: null, recorded as an answer, logged once through logFailure",
      async (status) => {
        answer(status, { status, message: "busy" });

        expect(await series("2024-01-01", "2024-01-05")).toBeNull();
        expect(health.recordSuccess).toHaveBeenCalledTimes(1);
        expect(health.recordFailure).not.toHaveBeenCalled();
        expect(health.logFailure).toHaveBeenCalledTimes(1);
        const [, providerId, context, error] = health.logFailure.mock.calls[0];
        expect(providerId).toBe("frankfurter_v2");
        expect(context).toContain("USD/CAD");
        expect((error as Error).message).toContain(`HTTP ${status}`);
        expect(warn).not.toHaveBeenCalled();
      },
    );

    it("transport failure: null, counted by recordFailure and logged with the same error", async () => {
      const failure = transportFailure();
      fetchMock.mockRejectedValueOnce(failure);

      expect(await series("2024-01-01", "2024-01-05")).toBeNull();
      expect(health.recordSuccess).not.toHaveBeenCalled();
      expect(health.recordFailure).toHaveBeenCalledWith(
        "frankfurter_v2",
        failure,
      );
      expect(health.logFailure.mock.calls[0][3]).toBe(failure);
      expect(health.releaseProbe).not.toHaveBeenCalled();
    });

    it("a probe holder whose failure the breaker did not count hands the slot back", async () => {
      health.assertAvailable.mockReturnValue("probe");
      health.recordFailure.mockReturnValue(false);
      fetchMock.mockRejectedValueOnce(new TypeError("Invalid URL"));

      expect(await provider.fetchLatest("USD", ["CAD"])).toBeNull();
      expect(health.releaseProbe).toHaveBeenCalledWith("frankfurter_v2");
    });

    it("an open-gate admission never releases, even when the failure was not counted", async () => {
      health.recordFailure.mockReturnValue(false);
      fetchMock.mockRejectedValueOnce(new TypeError("Invalid URL"));

      expect(await provider.fetchLatest("USD", ["CAD"])).toBeNull();
      expect(health.releaseProbe).not.toHaveBeenCalled();
    });

    it("200 whose body never finishes: null, counted as a failure, never recorded as an answer", async () => {
      const stalled = Object.assign(new Error("Body Timeout Error"), {
        code: "UND_ERR_BODY_TIMEOUT",
      });
      const response = respond(200, null);
      response.json.mockRejectedValue(stalled);
      fetchMock.mockResolvedValueOnce(response);

      expect(await series("2024-01-01", "2024-01-05")).toBeNull();
      expect(health.recordSuccess).not.toHaveBeenCalled();
      expect(health.recordFailure).toHaveBeenCalledWith(
        "frankfurter_v2",
        stalled,
      );
    });

    it.each([
      ["the v1 shape", { amount: 1.0, base: "USD", rates: { CAD: 1.4 } }],
      ["a string", "ok"],
      ["null", null],
    ])(
      "200 with %s: null, the answer recorded, one unreadable-response line",
      async (_label, body) => {
        answer(200, body);

        expect(await provider.fetchLatest("USD", ["CAD"])).toBeNull();
        answer(200, body);
        expect(await series("2024-01-01", "2024-01-05")).toBeNull();

        expect(health.recordSuccess).toHaveBeenCalledTimes(2);
        expect(health.recordFailure).not.toHaveBeenCalled();
        expect(health.logFailure).toHaveBeenCalledTimes(2);
        expect((health.logFailure.mock.calls[0][3] as Error).message).toContain(
          "unreadable",
        );
      },
    );

    it("a refusal by the breaker is null with nothing asked, and goes through logFailure", async () => {
      const refusal = new ProviderUnavailableError(
        "Frankfurter v2",
        30_000,
        null,
      );
      health.assertAvailable.mockImplementation(() => {
        throw refusal;
      });

      expect(await provider.fetchLatest("USD", ["CAD"])).toBeNull();
      expect(await series("2024-01-01", "2024-01-05")).toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();
      expect(health.recordSuccess).not.toHaveBeenCalled();
      expect(health.recordFailure).not.toHaveBeenCalled();
      expect(health.logFailure).toHaveBeenCalledTimes(2);
      expect(health.logFailure.mock.calls[0][3]).toBe(refusal);
    });
  });

  describe("carries", () => {
    let now: number;

    beforeEach(() => {
      now = Date.parse("2026-11-16T09:00:00.000Z");
      jest.spyOn(Date, "now").mockImplementation(() => now);
    });

    it("reads the instance's list once and answers from its currency entries only", async () => {
      answer(200, CURRENCIES);

      expect(await provider.carries("CAD")).toBe(true);
      expect(await provider.carries("TWD")).toBe(true);
      expect(await provider.carries("aed")).toBe(true);
      expect(await provider.carries("BTC")).toBe(false);
      expect(await provider.carries("XAU")).toBe(false);
      expect(await provider.carries("SGD")).toBe(false);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(askedUrl()).toBe(`${DEFAULT_FRANKFURTER_V2_BASE_URL}/currencies`);
      expect(timeoutSpy).toHaveBeenCalledWith(FRANKFURTER_V2_LATEST_TIMEOUT_MS);
      expect(health.recordSuccess).toHaveBeenCalledTimes(1);
    });

    it("holds the list for 24 hours, then asks again", async () => {
      answer(200, CURRENCIES);
      await provider.carries("CAD");

      now += FRANKFURTER_V2_CURRENCY_LIST_TTL_MS - 1;
      await provider.carries("CAD");
      expect(fetchMock).toHaveBeenCalledTimes(1);

      now += 1;
      answer(200, CURRENCIES);
      await provider.carries("CAD");
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("concurrent callers share one list request", async () => {
      answer(200, CURRENCIES);

      const answers = await Promise.all([
        provider.carries("CAD"),
        provider.carries("BTC"),
        provider.carries("USD"),
      ]);

      expect(answers).toEqual([true, false, true]);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("stands the compiled-in list in when the list cannot be fetched, and asks again after a few minutes", async () => {
      fetchMock.mockRejectedValueOnce(transportFailure());

      expect(await provider.carries("SGD")).toBe(true);
      expect(await provider.carries("BTC")).toBe(false);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toContain("compiled-in list");

      now += FRANKFURTER_V2_CURRENCY_LIST_RETRY_MS - 1;
      await provider.carries("CAD");
      expect(fetchMock).toHaveBeenCalledTimes(1);

      now += 1;
      answer(200, CURRENCIES);
      expect(await provider.carries("SGD")).toBe(false);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it.each([
      ["a 503", 503, { status: 503, message: "down" }],
      ["an empty list", 200, []],
      ["a list with no currency entry", 200, [CURRENCIES[1], CURRENCIES[6]]],
      ["the v1 shape", 200, { CAD: "Canadian Dollar" }],
    ])(
      "stands the compiled-in list in after %s",
      async (_label, status, body) => {
        answer(status, body);

        expect(await provider.carries("SGD")).toBe(true);
        expect(
          warn.mock.calls.some((c) =>
            String(c[0]).includes("compiled-in list"),
          ),
        ).toBe(true);
      },
    );

    it("the compiled-in list is the 161 fiat codes section 3.4 records, and covers every code Monize knows", () => {
      expect(FRANKFURTER_V2_FALLBACK_CURRENCIES).toHaveLength(161);
      expect(new Set(FRANKFURTER_V2_FALLBACK_CURRENCIES).size).toBe(161);
      expect([...FRANKFURTER_V2_FALLBACK_CURRENCIES].sort()).toEqual(
        FRANKFURTER_V2_FALLBACK_CURRENCIES,
      );
      for (const code of Object.keys(CURRENCY_METADATA)) {
        expect(FRANKFURTER_V2_FALLBACK_CURRENCIES).toContain(code);
      }
      expect(FRANKFURTER_V2_FALLBACK_CURRENCIES).not.toContain("BTC");
      expect(FRANKFURTER_V2_FALLBACK_CURRENCIES).not.toContain("XAU");
    });
  });

  describe("verifyCurrency", () => {
    it("answers from the instance's own list, without a call per code", async () => {
      answer(200, CURRENCIES);

      expect(await provider.verifyCurrency("CAD")).toBe(true);
      expect(await provider.verifyCurrency("BTC")).toBe(false);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("while the compiled-in list stands in, a code it does not name is no answer, not unknown", async () => {
      fetchMock.mockRejectedValueOnce(transportFailure());

      expect(await provider.verifyCurrency("CAD")).toBe(true);
      expect(await provider.verifyCurrency("BTC")).toBeNull();
    });
  });

  describe("the base URL", () => {
    it.each([
      [undefined, DEFAULT_FRANKFURTER_V2_BASE_URL],
      [null, DEFAULT_FRANKFURTER_V2_BASE_URL],
      ["   ", DEFAULT_FRANKFURTER_V2_BASE_URL],
      ["https://api.frankfurter.dev/v2/", DEFAULT_FRANKFURTER_V2_BASE_URL],
      [" https://fx.internal.example/ ", "https://fx.internal.example"],
    ])("resolves %p to %s", (raw, expected) => {
      expect(resolveFrankfurterV2BaseUrl(raw)).toBe(expected);
    });

    it("is what every request is built on, with one slash before the path", async () => {
      const selfHosted = new FrankfurterV2FxProvider(
        health as unknown as ProviderHealthService,
        resolveFrankfurterV2BaseUrl("http://frankfurter:8080/"),
      );
      answer(200, LATEST_USD);

      await selfHosted.fetchLatest("USD", ["CAD"]);

      expect(askedUrl()).toBe(
        "http://frankfurter:8080/rates?base=USD&quotes=CAD",
      );
    });
  });
});
