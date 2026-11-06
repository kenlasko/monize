import "reflect-metadata";
import { validate } from "class-validator";
import { plainToInstance } from "class-transformer";
import { IsShareQuantity } from "./is-share-quantity.validator";

class Position {
  @IsShareQuantity()
  quantity: number;
}

class Shares {
  @IsShareQuantity(4)
  quantity: number;
}

async function messages<T extends object>(
  cls: new () => T,
  quantity: unknown,
): Promise<string[]> {
  const errors = await validate(plainToInstance(cls, { quantity }));
  return errors.flatMap((e) => Object.values(e.constraints ?? {}));
}

describe("IsShareQuantity", () => {
  it("accepts 0.00000005 and 7e-8 without throwing", async () => {
    expect(await messages(Position, 0.00000005)).toEqual([]);
    expect(await messages(Position, 7e-8)).toEqual([]);
  });

  it("refuses 0.000000051 at eight places", async () => {
    expect(await messages(Position, 0.000000051)).toEqual([
      "quantity must have at most 8 decimal places",
    ]);
  });

  it("honours a narrower limit", async () => {
    expect(await messages(Shares, 1.2345)).toEqual([]);
    expect(await messages(Shares, 1.23456)).toEqual([
      "quantity must have at most 4 decimal places",
    ]);
  });

  it.each([NaN, Infinity, -Infinity, "1", null, undefined])(
    "refuses %p",
    async (v) => {
      expect(await messages(Position, v)).not.toEqual([]);
    },
  );
});
