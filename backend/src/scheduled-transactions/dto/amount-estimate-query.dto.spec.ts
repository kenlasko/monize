import { plainToInstance } from "class-transformer";
import { validateSync } from "class-validator";
import { AmountEstimateQueryDto } from "./amount-estimate-query.dto";

const UUID = "11111111-1111-4111-8111-111111111111";

const errorsFor = (query: Record<string, unknown>) =>
  validateSync(plainToInstance(AmountEstimateQueryDto, query), {
    whitelist: true,
    forbidNonWhitelisted: true,
  }).map((e) => e.property);

describe("AmountEstimateQueryDto", () => {
  it("requires a payee and a category without a transfer account (issue #2096)", () => {
    expect(errorsFor({ payeeId: UUID, categoryId: UUID })).toEqual([]);
    expect(errorsFor({ payeeId: UUID })).toContain("categoryId");
    expect(errorsFor({})).toEqual(
      expect.arrayContaining(["payeeId", "categoryId"]),
    );
  });

  it("takes a transfer account and a frequency instead (issue #2164)", () => {
    expect(
      errorsFor({ transferAccountId: UUID, frequency: "MONTHLY" }),
    ).toEqual([]);
    expect(errorsFor({ transferAccountId: "not-a-uuid" })).toContain(
      "transferAccountId",
    );
    expect(
      errorsFor({ transferAccountId: UUID, frequency: "FORTNIGHTLY" }),
    ).toContain("frequency");
  });

  it("still validates a payee or category sent beside a transfer account", () => {
    expect(
      errorsFor({ transferAccountId: UUID, payeeId: "x".repeat(10_000) }),
    ).toContain("payeeId");
    expect(
      errorsFor({ transferAccountId: UUID, categoryId: "not-a-uuid" }),
    ).toContain("categoryId");
  });
});
