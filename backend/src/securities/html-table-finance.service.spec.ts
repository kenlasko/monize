import { readFileSync } from "fs";
import { join } from "path";
import { fetch as undiciFetch } from "undici";
import {
  checkQuoteTableUrl,
  HtmlTableFinanceService,
  QuoteTableError,
  rangeStart,
} from "./html-table-finance.service";

jest.mock("undici", () => {
  const actual = jest.requireActual("undici");
  return { ...actual, fetch: jest.fn() };
});

const fetchMock = undiciFetch as unknown as jest.Mock;
const ARIVA =
  "https://www.ariva.de/1-unze-kruegerrand-gold-kurs/kurse/historische-kurse";
const page = readFileSync(
  join(
    __dirname,
    "__fixtures__",
    "quote-tables",
    "ariva-historische-kurse.html",
  ),
);

function htmlResponse(
  body: Uint8Array | string,
  status = 200,
  headers: Record<string, string> = {},
) {
  return new Response(body as BodyInit, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", ...headers },
  });
}

function refused() {
  return Object.assign(new TypeError("fetch failed"), {
    cause: Object.assign(new Error("connect ECONNREFUSED"), {
      code: "ECONNREFUSED",
    }),
  });
}

function redirect(location: string) {
  return new Response(null, { status: 302, headers: { location } });
}

describe("HtmlTableFinanceService", () => {
  let service: HtmlTableFinanceService;

  beforeEach(() => {
    fetchMock.mockReset();
    service = new HtmlTableFinanceService();
  });

  it("answers nothing, without a request, for a security with no page", async () => {
    await expect(service.fetchQuote("KRUG", null, {})).resolves.toBeNull();
    await expect(
      service.fetchHistoricalSeries("KRUG", null, "1y"),
    ).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("quotes the newest row of the page, in the currency the cells name", async () => {
    fetchMock.mockResolvedValueOnce(htmlResponse(page));

    const quote = await service.fetchQuote("KRUG", null, { quoteUrl: ARIVA });

    expect(quote).toMatchObject({
      symbol: "KRUG",
      regularMarketPrice: 3609.23,
      regularMarketOpen: 3623.81,
      regularMarketDayHigh: 3635.17,
      regularMarketDayLow: 3604.05,
      regularMarketVolume: undefined,
      provider: "html_table",
      currencyCode: "EUR",
    });
    expect(service.getTradingDate(quote!).toISOString().slice(0, 10)).toBe(
      "2026-11-02",
    );
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe(ARIVA);
    expect(init).toMatchObject({ redirect: "manual" });
    expect(init.dispatcher).toBeDefined();
  });

  it("serves the quote and the series from one download", async () => {
    fetchMock.mockResolvedValueOnce(htmlResponse(page));

    await service.fetchQuote("KRUG", null, { quoteUrl: ARIVA });
    const series = await service.fetchHistoricalSeries("KRUG", null, "max", {
      quoteUrl: ARIVA,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(series?.prices).toHaveLength(23);
    expect(series?.currencyCode).toBe("EUR");
  });

  it("limits the series to the range asked for", async () => {
    jest.useFakeTimers({ now: new Date(Date.UTC(2026, 10, 2, 12)) });
    try {
      fetchMock.mockResolvedValueOnce(htmlResponse(page));
      const series = await service.fetchHistoricalSeries("KRUG", null, "5d", {
        quoteUrl: ARIVA,
      });
      expect(
        series?.prices.map((p) => p.date.toISOString().slice(0, 10)),
      ).toEqual(["2026-10-28", "2026-10-29", "2026-10-30", "2026-11-02"]);
    } finally {
      jest.useRealTimers();
    }
  });

  it("decodes a page in the charset its header names", async () => {
    const latin1 = Buffer.from(
      "<table><tr><th>Datum</th><th>Schluss</th></tr><tr><td>02.11.26</td><td>1,5 €</td></tr></table>".replace(
        "€",
        "EUR",
      ) + "<p>März</p>",
      "latin1",
    );
    fetchMock.mockResolvedValueOnce(
      htmlResponse(latin1, 200, {
        "content-type": "text/html; charset=iso-8859-1",
      }),
    );
    const table = await service.loadTable("https://example.com/k");
    expect(table.prices[0].close).toBe(1.5);
    expect(table.currencyCode).toBe("EUR");
  });

  it("follows a redirect to another public page", async () => {
    fetchMock
      .mockResolvedValueOnce(redirect("/moved"))
      .mockResolvedValueOnce(htmlResponse(page));

    const table = await service.loadTable("https://example.com/start");

    expect(table.prices).toHaveLength(23);
    expect(String(fetchMock.mock.calls[1][0])).toBe(
      "https://example.com/moved",
    );
  });

  it("refuses a redirect into a private network without following it", async () => {
    fetchMock.mockResolvedValueOnce(
      redirect("http://169.254.169.254/latest/meta-data"),
    );

    await expect(
      service.loadTable("https://example.com/start"),
    ).rejects.toMatchObject({
      reason: "private-address",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("stops after three redirects", async () => {
    fetchMock.mockResolvedValue(redirect("https://example.com/again"));

    await expect(
      service.loadTable("https://example.com/loop"),
    ).rejects.toMatchObject({
      reason: "too-many-redirects",
    });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("reports the site's status, and asks again next time: the site is up", async () => {
    fetchMock.mockResolvedValue(htmlResponse("gone", 404));

    await expect(
      service.loadTable("https://example.com/x"),
    ).rejects.toMatchObject({
      reason: "http-status",
      detail: "404",
    });
    await expect(
      service.loadTable("https://example.com/x"),
    ).rejects.toMatchObject({ reason: "http-status" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("reports a page without a price table", async () => {
    fetchMock.mockResolvedValueOnce(htmlResponse("<p>consent wall</p>"));
    await expect(
      service.loadTable("https://example.com/x"),
    ).rejects.toMatchObject({
      reason: "no-table",
    });
  });

  it("refuses a page whose numbers it cannot place, rather than guess", async () => {
    fetchMock.mockResolvedValueOnce(
      htmlResponse(
        "<table><tr><th>Date</th><th>Close</th></tr>" +
          "<tr><td>2026-11-02</td><td>102,345</td></tr>" +
          "<tr><td>2026-11-01</td><td>101,998</td></tr></table>",
      ),
    );
    await expect(
      service.loadTable("https://example.com/x"),
    ).rejects.toMatchObject({ reason: "ambiguous", detail: "numbers" });
  });

  it("answers null for a site that cannot be reached, then backs off it", async () => {
    fetchMock.mockRejectedValueOnce(refused());

    await expect(
      service.fetchQuote("KRUG", null, {
        quoteUrl: "https://down.example.com/q",
      }),
    ).resolves.toBeNull();
    // The series asked right after it is answered without a second timeout.
    await expect(
      service.fetchHistoricalSeries("KRUG", null, "1y", {
        quoteUrl: "https://down.example.com/other",
      }),
    ).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("backs off only the origin that failed, never another port of the same host", async () => {
    // One user's address on a closed port must not stop another user's
    // working page on that host from being read.
    fetchMock.mockRejectedValueOnce(refused());
    await expect(
      service.loadTable("https://example.com:81/x"),
    ).rejects.toBeInstanceOf(TypeError);
    await expect(
      service.loadTable("https://example.com:81/x"),
    ).rejects.toMatchObject({ reason: "unreachable" });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fetchMock.mockResolvedValueOnce(htmlResponse(page));
    await expect(service.loadTable(ARIVA)).resolves.toBeDefined();
    fetchMock.mockResolvedValueOnce(htmlResponse(page));
    await expect(
      service.loadTable("https://example.com/x"),
    ).resolves.toBeDefined();
  });

  it("blames a dead redirect target, never the site the address started on", async () => {
    // https://example.com/a redirects to a host that does not answer.
    fetchMock
      .mockResolvedValueOnce(redirect("https://dead.example.net/a"))
      .mockRejectedValueOnce(refused());
    await expect(
      service.loadTable("https://example.com/a"),
    ).rejects.toBeInstanceOf(TypeError);

    // Another page on the starting site is still read.
    fetchMock.mockResolvedValueOnce(htmlResponse(page));
    await expect(
      service.loadTable("https://example.com/b"),
    ).resolves.toBeDefined();

    // A second address redirecting to the dead host is refused at that hop,
    // without waiting for it again.
    fetchMock.mockResolvedValueOnce(redirect("https://dead.example.net/c"));
    await expect(
      service.loadTable("https://example.com/c"),
    ).rejects.toMatchObject({ reason: "unreachable" });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("asks a backed-off site again once the back-off has passed", async () => {
    jest.useFakeTimers({ now: new Date(Date.UTC(2026, 10, 2, 12)) });
    try {
      fetchMock.mockRejectedValueOnce(refused());
      await expect(
        service.loadTable("https://example.com/x"),
      ).rejects.toBeInstanceOf(TypeError);
      jest.setSystemTime(new Date(Date.UTC(2026, 10, 2, 12, 11)));
      fetchMock.mockResolvedValueOnce(htmlResponse(page));
      await expect(
        service.loadTable("https://example.com/x"),
      ).resolves.toBeDefined();
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });

  it("answers a gap-fill window with only that window's rows, and [] before the page", async () => {
    fetchMock.mockResolvedValueOnce(htmlResponse(page));
    const opts = { quoteUrl: ARIVA };

    const old = await service.fetchHistoricalWindowSeries(
      "KRUG",
      null,
      new Date(Date.UTC(2020, 2, 1)),
      new Date(Date.UTC(2020, 2, 31, 23, 59, 59, 999)),
      opts,
    );
    // An answer, not a failure: the fill may remember the month as empty.
    expect(old).not.toBeNull();
    expect(old!.prices).toEqual([]);

    const late = await service.fetchHistoricalWindowSeries(
      "KRUG",
      null,
      new Date(Date.UTC(2026, 9, 29)),
      new Date(Date.UTC(2026, 9, 30, 23, 59, 59, 999)),
      opts,
    );
    expect(late!.prices.map((p) => p.date.toISOString().slice(0, 10))).toEqual([
      "2026-10-29",
      "2026-10-30",
    ]);
    expect(late!.currencyCode).toBe("EUR");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("logs and answers null when the page has no table", async () => {
    fetchMock.mockResolvedValueOnce(htmlResponse("<p>nothing</p>"));
    await expect(
      service.fetchHistoricalSeries("KRUG", null, "1y", {
        quoteUrl: "https://example.com/empty",
      }),
    ).resolves.toBeNull();
  });

  it("does not search, nor answer sector data", async () => {
    await expect(service.lookupSecurity()).resolves.toBeNull();
    await expect(service.fetchStockSectorInfo()).resolves.toBeNull();
    await expect(service.fetchEtfSectorWeightings()).resolves.toBeNull();
  });
});

describe("checkQuoteTableUrl", () => {
  it.each([
    "http://localhost:3000/prices",
    "http://app.localhost/prices",
    "http://127.0.0.1/prices",
    "http://10.0.0.5/prices",
    "http://192.168.1.10/prices",
    "http://[::1]/prices",
    "http://169.254.169.254/latest",
  ])("refuses the private address %s", (url) => {
    expect(() => checkQuoteTableUrl(url)).toThrow(
      expect.objectContaining({ reason: "private-address" }),
    );
  });

  it.each([
    "ftp://example.com/x",
    "https://user:pw@example.com/x",
    "not a url",
    "file:///etc/passwd",
  ])("refuses %s", (url) => {
    expect(() => checkQuoteTableUrl(url)).toThrow(QuoteTableError);
  });

  it("accepts a public http or https page and resolves a relative redirect", () => {
    expect(checkQuoteTableUrl("http://example.com/a").toString()).toBe(
      "http://example.com/a",
    );
    expect(
      checkQuoteTableUrl("/b?x=1", "https://example.com/a").toString(),
    ).toBe("https://example.com/b?x=1");
  });
});

describe("rangeStart", () => {
  const now = new Date(Date.UTC(2026, 10, 2, 15));
  it.each([
    ["5d", "2026-10-28"],
    ["1wk", "2026-10-26"],
    ["1mo", "2026-10-02"],
    ["1y", "2025-11-02"],
    ["ytd", "2026-01-01"],
  ])("starts %s on %s", (range, expected) => {
    expect(rangeStart(range, now)?.toISOString().slice(0, 10)).toBe(expected);
  });

  it.each(["max", undefined, "nonsense"])(
    "reaches back without limit for %p",
    (range) => {
      expect(rangeStart(range, now)).toBeNull();
    },
  );
});
