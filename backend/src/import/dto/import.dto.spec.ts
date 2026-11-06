import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { CsvColumnMappingConfigDto, ImportCsvDto } from "./import.dto";

// Mirrors the global ValidationPipe (whitelist + forbidNonWhitelisted), so a
// payload rejected here is rejected by the running API and vice versa.
const validateStrict = (instance: object) =>
  validate(instance, { whitelist: true, forbidNonWhitelisted: true });

describe("CSV import DTO validation", () => {
  const baseMapping = {
    date: 0,
    amount: 5,
    dateFormat: "MM/DD/YYYY",
    hasHeader: true,
    delimiter: ",",
  };

  const investmentMapping = {
    ...baseMapping,
    investmentMode: true,
    actionColumn: 1,
    securityColumn: 2,
    quantityColumn: 3,
    priceColumn: 4,
    commissionColumn: 6,
    actionKeywords: {
      buy: ["acquisto", "compra"],
      cashOut: ["prelievo"],
    },
  };

  it.each(["DD-MMM-YYYY", "MMM DD, YYYY", "DD MMMM YYYY", "DD.MM.YYYY"])(
    "accepts the date format %s",
    async (dateFormat) => {
      const instance = plainToInstance(CsvColumnMappingConfigDto, {
        ...baseMapping,
        dateFormat,
      });
      expect(await validateStrict(instance)).toHaveLength(0);
    },
  );

  it.each(["DD/MM/YYYY;", "DD (MM) YYYY", "%d/%m/%Y"])(
    "refuses the date format %s",
    async (dateFormat) => {
      const instance = plainToInstance(CsvColumnMappingConfigDto, {
        ...baseMapping,
        dateFormat,
      });
      const errors = await validateStrict(instance);
      expect(errors.map((e) => e.property)).toEqual(["dateFormat"]);
    },
  );

  it.each(["MMM DD, YYYY", "DD MMM YYYY"])(
    "accepts an ImportCsvDto whose mapping and top-level date format are %s",
    async (dateFormat) => {
      // The wizard sends the mapping's format as the top-level one too.
      const instance = plainToInstance(ImportCsvDto, {
        content: "Date,Amount\nJan 15, 2026,10",
        accountId: "0b6f9070-9e2e-4f0e-9a3e-3a4b5c6d7e8f",
        columnMapping: { ...baseMapping, dateFormat },
        categoryMappings: [],
        accountMappings: [],
        dateFormat,
      });
      expect(await validateStrict(instance)).toHaveLength(0);
    },
  );

  it("accepts the investment column mapping fields", async () => {
    const instance = plainToInstance(
      CsvColumnMappingConfigDto,
      investmentMapping,
    );
    const errors = await validateStrict(instance);
    expect(errors).toHaveLength(0);
  });

  it("accepts ImportCsvDto with securityMappings", async () => {
    const instance = plainToInstance(ImportCsvDto, {
      content: "Date,Action\n01/15/2026,Buy",
      accountId: "0b6f9070-9e2e-4f0e-9a3e-3a4b5c6d7e8f",
      columnMapping: investmentMapping,
      categoryMappings: [],
      accountMappings: [],
      securityMappings: [
        {
          originalName: "AAPL",
          securityId: "0b6f9070-9e2e-4f0e-9a3e-3a4b5c6d7e8f",
        },
        {
          originalName: "Some Fund",
          createNew: "SF*",
          securityType: "MUTUAL_FUND",
        },
      ],
    });
    const errors = await validateStrict(instance);
    expect(errors).toHaveLength(0);
  });

  it("still rejects an unknown extra field on the column mapping", async () => {
    const instance = plainToInstance(CsvColumnMappingConfigDto, {
      ...baseMapping,
      notAField: 1,
    });
    const errors = await validateStrict(instance);
    expect(errors.some((e) => e.property === "notAField")).toBe(true);
  });

  it("rejects an unknown field nested inside actionKeywords", async () => {
    const instance = plainToInstance(CsvColumnMappingConfigDto, {
      ...baseMapping,
      investmentMode: true,
      actionKeywords: { frobnicate: ["x"] },
    });
    const errors = await validateStrict(instance);
    expect(errors.some((e) => e.property === "actionKeywords")).toBe(true);
  });

  it("bounds each action keyword list at 20 entries", async () => {
    const instance = plainToInstance(CsvColumnMappingConfigDto, {
      ...baseMapping,
      investmentMode: true,
      actionKeywords: { buy: Array.from({ length: 21 }, (_, i) => `kw${i}`) },
    });
    const errors = await validateStrict(instance);
    expect(errors.some((e) => e.property === "actionKeywords")).toBe(true);
  });

  it("rejects an out-of-range investment column index", async () => {
    const instance = plainToInstance(CsvColumnMappingConfigDto, {
      ...baseMapping,
      investmentMode: true,
      actionColumn: 101,
    });
    const errors = await validateStrict(instance);
    expect(errors.some((e) => e.property === "actionColumn")).toBe(true);
  });
});
