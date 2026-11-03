import { readFileSync } from "fs";
import { join } from "path";
import { fetch as undiciFetch } from "undici";
import {
  checkQuoteTableUrl,
  HtmlTableFinanceService,
  QuoteTableError,
} from "./html-table-finance.service";
import { AiEgressRefusedError } from "../ai/providers/provider-egress";

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

/** What undici rejects with when the resolver does not answer in time. */
function dnsTimeout() {
  return Object.assign(new TypeError("fetch failed"), {
    cause: Object.assign(new Error("getaddrinfo EAI_AGAIN slow.example.org"), {
      code: "EAI_AGAIN",
    }),
  });
}

/** What undici rejects with when `publicOnlyLookup` refuses the answer. */
function privateAtConnect() {
  return Object.assign(new TypeError("fetch failed"), {
    cause: new AiEgressRefusedError("rebind.example.net"),
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
        "<table><tr><th>Fecha</th><th>Cierre</th></tr>" +
          "<tr><td>2026-11-02</td><td>102,345</td></tr>" +
          "<tr><td>2026-11-01</td><td>101,998</td></tr></table>",
      ),
    );
    await expect(
      service.loadTable("https://example.com/x"),
    ).rejects.toMatchObject({ reason: "ambiguous", detail: "numbers" });
  });

  it("gives one download to callers who ask for the same page at once", async () => {
    let release!: (response: Response) => void;
    fetchMock.mockReturnValueOnce(
      new Promise<Response>((resolve) => {
        release = resolve;
      }),
    );
    fetchMock.mockResolvedValueOnce(htmlResponse(page));
    const first = service.loadTable("https://example.com/shared");
    const second = service.loadTable("https://example.com/shared");
    const other = service.loadTable("https://example.com/other");
    release(htmlResponse(page));

    const [a, b] = await Promise.all([first, second]);
    await other;
    expect(a).toBe(b);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not keep a failed load for the next caller", async () => {
    fetchMock.mockResolvedValueOnce(new Response("nope", { status: 500 }));
    await expect(
      service.loadTable("https://example.com/flaky"),
    ).rejects.toMatchObject({ reason: "http-status" });

    fetchMock.mockResolvedValueOnce(htmlResponse(page));
    await expect(
      service.loadTable("https://example.com/flaky"),
    ).resolves.toBeDefined();
  });

  it("answers null for a page that cannot be reached, then backs off it", async () => {
    fetchMock.mockRejectedValueOnce(refused());
    const opts = { quoteUrl: "https://down.example.com/q" };

    await expect(service.fetchQuote("KRUG", null, opts)).resolves.toBeNull();
    // The series of the same page, asked right after, waits for no second
    // timeout.
    await expect(
      service.fetchHistoricalSeries("KRUG", null, "1y", opts),
    ).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("backs off only the page that failed, never another page of the same site", async () => {
    // One user's slow or dead page must not stop every other user's page on
    // a shared site such as www.ariva.de for the rest of the run.
    fetchMock.mockRejectedValueOnce(refused());
    await expect(
      service.loadTable("https://example.com/x"),
    ).rejects.toMatchObject({ reason: "unreachable" });
    await expect(
      service.loadTable("https://example.com/x"),
    ).rejects.toMatchObject({ reason: "unreachable" });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fetchMock.mockResolvedValueOnce(htmlResponse(page));
    await expect(
      service.loadTable("https://example.com/y"),
    ).resolves.toBeDefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("lets a preview neither start nor wait out a back-off", async () => {
    fetchMock.mockRejectedValueOnce(refused());
    await expect(
      service.loadTable("https://example.com/p", new Date(), { preview: true }),
    ).rejects.toMatchObject({ reason: "unreachable" });

    // The preview's failure did not back the page off for refreshes.
    fetchMock.mockResolvedValueOnce(htmlResponse(page));
    await expect(
      service.loadTable("https://example.com/p"),
    ).resolves.toBeDefined();

    // And a page a refresh backed off is still asked when previewed.
    fetchMock.mockRejectedValueOnce(refused());
    await expect(
      service.loadTable("https://example.com/q"),
    ).rejects.toMatchObject({ reason: "unreachable" });
    fetchMock.mockResolvedValueOnce(htmlResponse(page));
    await expect(
      service.loadTable("https://example.com/q", new Date(), { preview: true }),
    ).resolves.toBeDefined();
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("blames a dead redirect target, never the page the address started on", async () => {
    // https://example.com/a redirects to a page that does not answer.
    fetchMock
      .mockResolvedValueOnce(redirect("https://dead.example.net/a"))
      .mockRejectedValueOnce(refused());
    await expect(
      service.loadTable("https://example.com/a"),
    ).rejects.toMatchObject({ reason: "unreachable" });

    // The starting site's other pages are still read.
    fetchMock.mockResolvedValueOnce(htmlResponse(page));
    await expect(
      service.loadTable("https://example.com/b"),
    ).resolves.toBeDefined();

    // Asked again, the redirect is followed to the dead page, which is refused
    // without being waited for a second time.
    fetchMock.mockResolvedValueOnce(redirect("https://dead.example.net/a"));
    await expect(
      service.loadTable("https://example.com/a"),
    ).rejects.toMatchObject({
      reason: "unreachable",
      detail: "failed recently",
    });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("asks a backed-off page again once the back-off has passed", async () => {
    jest.useFakeTimers({ now: new Date(Date.UTC(2026, 10, 2, 12)) });
    try {
      fetchMock.mockRejectedValueOnce(refused());
      await expect(
        service.loadTable("https://example.com/x"),
      ).rejects.toMatchObject({ reason: "unreachable" });
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

  it("reports a resolver that did not answer as unreachable, not as a private address", async () => {
    fetchMock.mockRejectedValueOnce(dnsTimeout());
    await expect(
      service.loadTable("https://slow.example.org/x"),
    ).rejects.toMatchObject({ reason: "unreachable" });
  });

  it("reports a name that resolved to a private address as one, and does not back it off", async () => {
    fetchMock.mockRejectedValueOnce(privateAtConnect());
    await expect(
      service.loadTable("https://rebind.example.net/x"),
    ).rejects.toMatchObject({ reason: "private-address" });

    fetchMock.mockRejectedValueOnce(privateAtConnect());
    await expect(
      service.loadTable("https://rebind.example.net/x"),
    ).rejects.toMatchObject({ reason: "private-address" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("reads the charset a page declares in a <meta> tag when the header names none", async () => {
    // windows-1252 writes the euro sign as byte 0x80, which UTF-8 cannot read.
    const latin1 = (html: string) =>
      Buffer.from(html.replace("€", "\x80"), "latin1");
    const table =
      "<table><tr><th>Datum</th><th>Schluß</th></tr>" +
      "<tr><td>2. März 2026</td><td>1,50 €</td></tr></table>";
    for (const meta of [
      '<meta charset="iso-8859-1">',
      '<meta http-equiv="Content-Type" content="text/html; charset=windows-1252">',
    ]) {
      fetchMock.mockResolvedValueOnce(
        htmlResponse(latin1(`<html><head>${meta}</head><body>${table}`), 200, {
          "content-type": "text/html",
        }),
      );
      const read = await service.loadTable(
        `https://example.com/${meta.length}`,
      );
      expect(read.columns.close).toBe("Schluß");
      expect(read.prices[0].date.toISOString().slice(0, 10)).toBe("2026-03-02");
      expect(read.currencyCode).toBe("EUR");
    }
  });

  it("lets a byte-order mark win over the header, as browsers do", async () => {
    const utf8 = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from(
        "<table><tr><th>Datum</th><th>Schluß</th></tr>" +
          "<tr><td>02.11.26</td><td>1,50</td></tr></table>",
        "utf8",
      ),
    ]);
    fetchMock.mockResolvedValueOnce(
      htmlResponse(utf8, 200, {
        "content-type": "text/html; charset=iso-8859-1",
      }),
    );
    const read = await service.loadTable("https://example.com/bom");
    expect(read.columns.close).toBe("Schluß");
  });

  it("drops expired pages from the cache and keeps it within a row budget", async () => {
    const rows = (n: number) =>
      "<table><tr><th>Date</th><th>Close</th></tr>" +
      Array.from({ length: n }, (_, i) => {
        const d = new Date(Date.UTC(1990, 0, 1) + i * 86_400_000);
        // Unclosed cells, so 130,000 rows fit in the 5 MB a download allows.
        return `<tr><td>${d.toISOString().slice(0, 10)}<td>${i + 1}.5`;
      }).join("") +
      "</table>";
    const cache = (service as unknown as { cache: Map<string, unknown> }).cache;

    const t0 = new Date(Date.UTC(2026, 10, 2, 12));
    fetchMock.mockResolvedValueOnce(htmlResponse(rows(3)));
    await service.loadTable("https://example.com/old", t0);
    expect(cache.has("https://example.com/old")).toBe(true);

    // Six minutes later the first page has expired and is dropped on insert.
    const t1 = new Date(t0.getTime() + 6 * 60_000);
    fetchMock.mockResolvedValueOnce(htmlResponse(rows(3)));
    await service.loadTable("https://example.com/new", t1);
    expect(cache.has("https://example.com/old")).toBe(false);

    // Pages that together pass the row budget cannot all be held: the oldest
    // goes. (90,000 rows is within what one page's reader keeps.)
    for (const name of ["big1", "big2", "big3"]) {
      fetchMock.mockResolvedValueOnce(htmlResponse(rows(90_000)));
      await service.loadTable(`https://example.com/${name}`, t1);
    }
    expect(cache.has("https://example.com/big1")).toBe(false);
    expect(cache.has("https://example.com/big3")).toBe(true);
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
    "http://metadata.google.internal/computeMetadata",
    "http://printer.local/prices",
    "http://[::ffff:7f00:1]/prices",
    "http://2130706433/prices",
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
