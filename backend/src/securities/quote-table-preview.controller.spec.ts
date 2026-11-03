import { Logger } from "@nestjs/common";
import {
  BadGatewayException,
  BadRequestException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { QuoteTablePreviewController } from "./quote-table-preview.controller";
import {
  HtmlTableFinanceService,
  QuoteTableError,
} from "./html-table-finance.service";
import { ParsedQuoteTable } from "./html-table-quote.parser";
import { DEMO_RESTRICTED_KEY } from "../common/guards/demo-mode.guard";

const day = (iso: string) => new Date(`${iso}T00:00:00Z`);

function table(count: number): ParsedQuoteTable {
  return {
    prices: Array.from({ length: count }, (_, i) => ({
      date: day(`2026-01-${String(i + 1).padStart(2, "0")}`),
      open: null,
      high: null,
      low: null,
      close: i + 1,
      adjClose: null,
      volume: null,
    })),
    currencyCode: "EUR",
    columns: { date: "Datum", close: "Schluss" },
    tableIndex: 0,
    skippedRows: 1,
  };
}

describe("QuoteTablePreviewController", () => {
  const loadTable = jest.fn();
  const controller = new QuoteTablePreviewController({
    loadTable,
  } as unknown as HtmlTableFinanceService);

  beforeEach(() => loadTable.mockReset());

  it("is closed on a demo instance, whose shared login could use it as a fetcher", () => {
    expect(
      Reflect.getMetadata(
        DEMO_RESTRICTED_KEY,
        QuoteTablePreviewController.prototype.preview,
      ),
    ).toBe(true);
  });

  it("reads the page as a preview, which neither starts nor waits out a back-off", async () => {
    loadTable.mockResolvedValueOnce(table(3));
    await controller.preview({ url: "https://example.com/x" });
    expect(loadTable).toHaveBeenCalledWith(
      "https://example.com/x",
      expect.any(Date),
      { preview: true },
    );
  });

  it("returns the newest rows first with the table's span", async () => {
    loadTable.mockResolvedValueOnce(table(20));

    const preview = await controller.preview({ url: "https://example.com/x" });

    expect(preview).toMatchObject({
      columns: { date: "Datum", close: "Schluss" },
      currencyCode: "EUR",
      totalRows: 20,
      skippedRows: 1,
      firstDate: "2026-01-01",
      lastDate: "2026-01-20",
    });
    expect(preview.rows).toHaveLength(15);
    expect(preview.rows[0]).toEqual({
      date: "2026-01-20",
      open: null,
      high: null,
      low: null,
      close: 20,
      volume: null,
    });
    expect(preview.rows[14].date).toBe("2026-01-06");
  });

  it.each([
    ["invalid-url", BadRequestException],
    ["private-address", BadRequestException],
    ["too-many-redirects", BadGatewayException],
    ["http-status", BadGatewayException],
    ["too-large", BadGatewayException],
    ["unreachable", BadGatewayException],
    ["no-table", UnprocessableEntityException],
    ["ambiguous", UnprocessableEntityException],
  ] as const)("answers %s with %p", async (reason, type) => {
    loadTable.mockRejectedValueOnce(new QuoteTableError(reason, "503"));
    await expect(
      controller.preview({ url: "https://example.com/x" }),
    ).rejects.toBeInstanceOf(type);
  });

  it("answers an unexpected failure as a bad gateway and logs its cause", async () => {
    const logged = jest
      .spyOn(Logger.prototype, "error")
      .mockImplementation(() => undefined);
    loadTable.mockRejectedValueOnce(new TypeError("fetch failed"));
    await expect(
      controller.preview({ url: "https://example.com/x" }),
    ).rejects.toMatchObject({
      message: expect.stringContaining("unexpected error"),
    });
    expect(logged).toHaveBeenCalledWith(
      expect.stringContaining("Quote table preview failed unexpectedly"),
    );
    logged.mockRestore();
  });
});
