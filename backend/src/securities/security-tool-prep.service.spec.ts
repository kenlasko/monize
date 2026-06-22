import { BadRequestException } from "@nestjs/common";
import { SecurityToolPrepService } from "./security-tool-prep.service";

describe("SecurityToolPrepService", () => {
  let prep: SecurityToolPrepService;
  let securities: Record<string, jest.Mock>;
  const USER = "u1";

  const createPreview = {
    symbol: "AAPL",
    name: "Apple Inc.",
    securityType: "STOCK",
    exchange: "NASDAQ",
    currencyCode: "USD",
    isFavourite: false,
    quoteProvider: "yahoo" as const,
    msnInstrumentId: null,
  };

  beforeEach(() => {
    securities = {
      previewCreateSecurity: jest.fn(),
      previewUpdateSecurity: jest.fn(),
      previewDeleteSecurity: jest.fn(),
    };
    prep = new SecurityToolPrepService(securities as any);
  });

  it("prepares create rows, skipping lookup failures by index", async () => {
    securities.previewCreateSecurity
      .mockResolvedValueOnce(createPreview)
      .mockRejectedValueOnce(
        new BadRequestException('No security matches "X"'),
      );

    const result = await prep.prepareCreateSecurities(USER, [
      { query: "AAPL" },
      { query: "X" },
    ]);

    expect(result.okPreviews).toHaveLength(1);
    expect(result.okRows[0]).toMatchObject({
      symbol: "AAPL",
      name: "Apple Inc.",
    });
    expect(result.okIndex).toEqual([0]);
    expect(result.skipped).toEqual([
      { index: 1, reason: 'No security matches "X"' },
    ]);
    expect(result.previewRows[1]).toMatchObject({
      status: "error",
      symbol: "X",
    });
  });

  it("prepares update rows mapped to batch descriptors", async () => {
    securities.previewUpdateSecurity.mockResolvedValue({
      securityId: "sec-1",
      symbol: "AAPL",
      name: "Apple Inc.",
      securityType: "ETF",
      exchange: "NYSE",
      currencyCode: "USD",
      isFavourite: true,
    });

    const result = await prep.prepareUpdateSecurities(USER, [
      { query: "AAPL", isFavourite: true },
    ]);

    expect(result.okRows).toEqual([
      {
        securityId: "sec-1",
        securityType: "ETF",
        exchange: "NYSE",
        currencyCode: "USD",
        isFavourite: true,
      },
    ]);
    expect(result.previewRows[0]).toMatchObject({
      status: "ok",
      symbol: "AAPL",
    });
  });

  it("converts country weighting percentages to decimals before previewing", async () => {
    securities.previewUpdateSecurity.mockResolvedValue({
      securityId: "sec-1",
      symbol: "XEQT",
      name: "iShares Core Equity ETF",
      securityType: "ETF",
      exchange: "TSX",
      currencyCode: "CAD",
      isFavourite: false,
      countryWeightings: [
        { name: "United States", weight: 0.6 },
        { name: "Canada", weight: 0.25 },
      ],
    });

    const result = await prep.prepareUpdateSecurities(USER, [
      {
        query: "XEQT",
        countryWeightings: [
          { name: "United States", weight: 60 },
          { name: "Canada", weight: 25 },
        ],
      },
    ]);

    // Percentages are divided by 100 before reaching the service.
    expect(securities.previewUpdateSecurity).toHaveBeenCalledWith(USER, {
      query: "XEQT",
      securityType: undefined,
      exchange: undefined,
      currencyCode: undefined,
      isFavourite: undefined,
      countryWeightings: [
        { name: "United States", weight: 0.6 },
        { name: "Canada", weight: 0.25 },
      ],
    });
    // The resolved (decimal) weights flow into the batch row.
    expect(result.okRows[0].countryWeightings).toEqual([
      { name: "United States", weight: 0.6 },
      { name: "Canada", weight: 0.25 },
    ]);
  });

  it("prepares delete rows to id-only descriptors", async () => {
    securities.previewDeleteSecurity.mockResolvedValue({
      securityId: "sec-1",
      symbol: "AAPL",
      name: "Apple Inc.",
    });

    const result = await prep.prepareDeleteSecurities(USER, [
      { query: "AAPL" },
    ]);

    expect(result.okRows).toEqual([{ securityId: "sec-1" }]);
    expect(result.previewRows[0]).toMatchObject({
      status: "ok",
      symbol: "AAPL",
      securityName: "Apple Inc.",
    });
  });

  it("flags update rows that fail to resolve", async () => {
    securities.previewUpdateSecurity.mockRejectedValue(
      new BadRequestException('No security matches "X"'),
    );

    const result = await prep.prepareUpdateSecurities(USER, [{ query: "X" }]);

    expect(result.okRows).toEqual([]);
    expect(result.skipped).toEqual([
      { index: 0, reason: 'No security matches "X"' },
    ]);
    expect(result.previewRows[0]).toMatchObject({
      status: "error",
      symbol: "X",
    });
  });

  it("flags delete rows that fail to resolve", async () => {
    securities.previewDeleteSecurity.mockRejectedValue(
      new BadRequestException('No security matches "X"'),
    );

    const result = await prep.prepareDeleteSecurities(USER, [{ query: "X" }]);

    expect(result.okRows).toEqual([]);
    expect(result.skipped).toEqual([
      { index: 0, reason: 'No security matches "X"' },
    ]);
    expect(result.previewRows[0]).toMatchObject({
      status: "error",
      symbol: "X",
    });
  });
});
