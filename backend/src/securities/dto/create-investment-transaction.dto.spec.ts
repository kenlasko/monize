import "reflect-metadata";
import { validate } from "class-validator";
import { plainToInstance } from "class-transformer";
import { CreateInvestmentTransactionDto } from "./create-investment-transaction.dto";

/** The errors on `exchangeRate` alone, whatever else the payload lacks. */
async function rateErrors(exchangeRate: unknown): Promise<string[]> {
  const dto = plainToInstance(CreateInvestmentTransactionDto, { exchangeRate });
  const errors = await validate(dto);
  return errors
    .filter((e) => e.property === "exchangeRate")
    .flatMap((e) => Object.keys(e.constraints ?? {}));
}

describe("CreateInvestmentTransactionDto exchangeRate", () => {
  it("accepts a coin pair's rate (CAD -> BTC)", async () => {
    expect(await rateErrors(0.0000073529)).toEqual([]);
  });

  it("accepts the smallest rate the column holds (ten places)", async () => {
    expect(await rateErrors(0.0000000001)).toEqual([]);
  });

  it("refuses zero", async () => {
    expect(await rateErrors(0)).toContain("min");
  });

  it("refuses a rate finer than the column's ten places", async () => {
    expect(await rateErrors(0.00000000001)).not.toEqual([]);
  });
});
