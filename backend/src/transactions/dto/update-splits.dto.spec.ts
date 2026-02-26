import "reflect-metadata";
import { validate } from "class-validator";
import { plainToInstance } from "class-transformer";
import { UpdateSplitsDto } from "./update-splits.dto";

function buildDto(data: any): UpdateSplitsDto {
  return plainToInstance(UpdateSplitsDto, data, {
    enableImplicitConversion: true,
  });
}

describe("UpdateSplitsDto", () => {
  const validSplit = {
    categoryId: "d290f1ee-6c54-4b01-90e6-d701748f0851",
    amount: 50.0,
  };

  it("accepts valid splits array", async () => {
    const dto = buildDto({ splits: [validSplit] });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it("accepts empty splits array", async () => {
    const dto = buildDto({ splits: [] });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it("rejects missing splits field", async () => {
    const dto = buildDto({});
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].property).toBe("splits");
  });

  it("rejects non-array splits", async () => {
    const dto = buildDto({ splits: "not-an-array" });
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].property).toBe("splits");
  });

  it("rejects more than 100 splits", async () => {
    const splits = Array.from({ length: 101 }, () => ({ ...validSplit }));
    const dto = buildDto({ splits });
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].property).toBe("splits");
    expect(errors[0].constraints).toHaveProperty("arrayMaxSize");
  });

  it("accepts exactly 100 splits", async () => {
    const splits = Array.from({ length: 100 }, () => ({ ...validSplit }));
    const dto = buildDto({ splits });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });
});
