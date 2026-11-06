import "reflect-metadata";
import { validate } from "class-validator";
import { plainToInstance } from "class-transformer";
import { CreateScheduledTransactionDto } from "./create-scheduled-transaction.dto";
import { PostScheduledTransactionDto } from "./post-scheduled-transaction.dto";

/**
 * A coin pair's rate and a coin's amount are routinely below 1e-6, which
 * JavaScript prints in exponent form; class-validator's `maxDecimalPlaces`
 * throws on those (a 500). The rate fields use `@IsFxRate`, the amount fields
 * `@IsMoneyAmount`.
 */
async function propertyErrors(
  cls: new () => object,
  property: string,
  value: unknown,
): Promise<string[]> {
  const errors = await validate(plainToInstance(cls, { [property]: value }), {
    skipMissingProperties: true,
  });
  return errors
    .filter((e) => e.property === property)
    .flatMap((e) => Object.keys(e.constraints ?? {}));
}

describe.each([
  ["CreateScheduledTransactionDto", CreateScheduledTransactionDto],
  ["PostScheduledTransactionDto", PostScheduledTransactionDto],
])("%s exchangeRate", (_name, dto) => {
  it("accepts a coin pair's rate", async () => {
    expect(await propertyErrors(dto, "exchangeRate", 0.0000073529)).toEqual([]);
  });

  it("refuses zero", async () => {
    expect(await propertyErrors(dto, "exchangeRate", 0)).toContain("min");
  });

  it("accepts 7e-8 without throwing", async () => {
    expect(await propertyErrors(dto, "exchangeRate", 7e-8)).toEqual([]);
  });

  it("refuses an eleventh decimal place", async () => {
    expect(await propertyErrors(dto, "exchangeRate", 0.00000000011)).toContain(
      "hasFxRatePlaces",
    );
  });
});

describe("CreateScheduledTransactionDto investmentExchangeRate", () => {
  const field = "investmentExchangeRate";

  it("accepts a coin pair's rate and 7e-8 without throwing", async () => {
    expect(
      await propertyErrors(CreateScheduledTransactionDto, field, 0.0000073529),
    ).toEqual([]);
    expect(
      await propertyErrors(CreateScheduledTransactionDto, field, 7e-8),
    ).toEqual([]);
  });

  it("refuses zero and a negative rate", async () => {
    expect(
      await propertyErrors(CreateScheduledTransactionDto, field, 0),
    ).toContain("min");
    expect(
      await propertyErrors(CreateScheduledTransactionDto, field, -1),
    ).toContain("min");
  });
});

describe.each([
  ["CreateScheduledTransactionDto", CreateScheduledTransactionDto, "amount"],
  ["PostScheduledTransactionDto", PostScheduledTransactionDto, "amount"],
])("%s %s", (_name, dto, field) => {
  it("accepts 0.00000005 and refuses a ninth decimal place", async () => {
    expect(await propertyErrors(dto, field, 0.00000005)).toEqual([]);
    expect(await propertyErrors(dto, field, 0.000000051)).toContain(
      "hasMoneyAmountPlaces",
    );
  });
});
