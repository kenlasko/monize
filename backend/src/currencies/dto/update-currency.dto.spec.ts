import { validate } from "class-validator";
import { UpdateCurrencyDto } from "./update-currency.dto";

function buildDto(overrides: Partial<UpdateCurrencyDto> = {}): UpdateCurrencyDto {
  const dto = new UpdateCurrencyDto();
  Object.assign(dto, overrides);
  return dto;
}

describe("UpdateCurrencyDto", () => {
  it("passes validation with no fields (all optional)", async () => {
    const dto = buildDto();
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it("passes validation with only name provided", async () => {
    const dto = buildDto({ name: "Updated Dollar" });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it("passes validation with only symbol provided", async () => {
    const dto = buildDto({ symbol: "$$" });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it("passes validation with all updatable fields", async () => {
    const dto = buildDto({
      name: "Updated Dollar",
      symbol: "U$",
      decimalPlaces: 3,
      isActive: false,
    });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it("does not include code as an updatable property", () => {
    const dto = buildDto();
    // code should not be a recognized property on UpdateCurrencyDto
    // (it's omitted via OmitType)
    expect("code" in dto).toBe(false);
  });

  it("rejects name exceeding 100 characters", async () => {
    const dto = buildDto({ name: "x".repeat(101) });
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].property).toBe("name");
  });

  it("rejects symbol exceeding 10 characters", async () => {
    const dto = buildDto({ symbol: "x".repeat(11) });
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].property).toBe("symbol");
  });

  it("rejects decimalPlaces above 4", async () => {
    const dto = buildDto({ decimalPlaces: 5 });
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].property).toBe("decimalPlaces");
  });

  it("rejects decimalPlaces below 0", async () => {
    const dto = buildDto({ decimalPlaces: -1 });
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].property).toBe("decimalPlaces");
  });

  it("rejects non-boolean isActive", async () => {
    const dto = buildDto({ isActive: "true" as any });
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].property).toBe("isActive");
  });

});
