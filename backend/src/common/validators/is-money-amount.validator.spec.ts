import "reflect-metadata";
import { validate } from "class-validator";
import { plainToInstance } from "class-transformer";
import { IsMoneyAmount } from "./is-money-amount.validator";

class Coin {
  @IsMoneyAmount()
  amount: number;
}

class Fiat {
  @IsMoneyAmount(4)
  amount: number;
}

async function messages<T extends object>(
  cls: new () => T,
  amount: unknown,
): Promise<string[]> {
  const errors = await validate(plainToInstance(cls, { amount }));
  return errors.flatMap((e) => Object.values(e.constraints ?? {}));
}

describe("IsMoneyAmount", () => {
  it("accepts 0.00000005 at the default eight places without throwing", async () => {
    expect(await messages(Coin, 0.00000005)).toEqual([]);
  });

  it("refuses 0.000000051 at eight places", async () => {
    expect(await messages(Coin, 0.000000051)).toEqual([
      "amount must have at most 8 decimal places",
    ]);
  });

  it("refuses a fifth place and accepts four at four places", async () => {
    expect(await messages(Fiat, 12.34567)).toEqual([
      "amount must have at most 4 decimal places",
    ]);
    expect(await messages(Fiat, 12.3456)).toEqual([]);
    expect(await messages(Fiat, 12.345)).toEqual([]);
  });

  it.each([0, -5, 1_000_000.5, 21_000_000, 1e-7])("accepts %p", async (n) => {
    expect(await messages(Coin, n)).toEqual([]);
  });

  it.each([NaN, Infinity, -Infinity])("refuses %p", async (n) => {
    expect(await messages(Coin, n)).not.toEqual([]);
  });

  it.each(["1.5", null, undefined, {}])("refuses non-number %p", async (v) => {
    expect(await messages(Coin, v)).not.toEqual([]);
  });
});
