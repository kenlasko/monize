import { validate } from "class-validator";
import { CreateCurrencyDto } from "./create-currency.dto";

function buildDto(
  overrides: Partial<CreateCurrencyDto> = {},
): CreateCurrencyDto {
  const dto = new CreateCurrencyDto();
  dto.code = "CAD";
  dto.name = "Canadian Dollar";
  dto.symbol = "CA$";
  Object.assign(dto, overrides);
  return dto;
}

describe("CreateCurrencyDto", () => {
  it("passes validation with all required fields", async () => {
    const dto = buildDto();
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it("passes validation with all fields provided", async () => {
    const dto = buildDto({
      decimalPlaces: 0,
      isActive: true,
    });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  // ── code ────────────────────────────────────────────────────

  it("rejects code shorter than 3 characters", async () => {
    const dto = buildDto({ code: "CA" });
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].property).toBe("code");
    expect(errors[0].constraints).toHaveProperty("isLength");
  });

  it("rejects code longer than 3 characters", async () => {
    const dto = buildDto({ code: "CADD" });
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].property).toBe("code");
  });

  it("rejects missing code", async () => {
    const dto = buildDto();
    delete (dto as any).code;
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].property).toBe("code");
  });

  it("rejects non-string code", async () => {
    const dto = buildDto({ code: 123 as any });
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].property).toBe("code");
  });

  // ── name ────────────────────────────────────────────────────

  it("rejects missing name", async () => {
    const dto = buildDto();
    delete (dto as any).name;
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].property).toBe("name");
  });

  it("rejects name exceeding 100 characters", async () => {
    const dto = buildDto({ name: "x".repeat(101) });
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].property).toBe("name");
  });

  // ── symbol ──────────────────────────────────────────────────

  it("rejects missing symbol", async () => {
    const dto = buildDto();
    delete (dto as any).symbol;
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].property).toBe("symbol");
  });

  it("rejects symbol exceeding 10 characters", async () => {
    const dto = buildDto({ symbol: "x".repeat(11) });
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].property).toBe("symbol");
  });

  // ── decimalPlaces (optional) ────────────────────────────────

  it("accepts decimalPlaces of 0", async () => {
    const dto = buildDto({ decimalPlaces: 0 });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it("accepts decimalPlaces of 4", async () => {
    const dto = buildDto({ decimalPlaces: 4 });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it("rejects decimalPlaces below 0", async () => {
    const dto = buildDto({ decimalPlaces: -1 });
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].property).toBe("decimalPlaces");
  });

  it("rejects decimalPlaces above 4", async () => {
    const dto = buildDto({ decimalPlaces: 5 });
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].property).toBe("decimalPlaces");
  });

  it("rejects non-integer decimalPlaces", async () => {
    const dto = buildDto({ decimalPlaces: 2.5 });
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].property).toBe("decimalPlaces");
  });

  it("allows decimalPlaces to be omitted", async () => {
    const dto = buildDto();
    delete dto.decimalPlaces;
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  // ── isActive (optional) ─────────────────────────────────────

  it("allows isActive to be omitted", async () => {
    const dto = buildDto();
    delete dto.isActive;
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it("accepts boolean isActive", async () => {
    const dto = buildDto({ isActive: false });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it("rejects non-boolean isActive", async () => {
    const dto = buildDto({ isActive: "yes" as any });
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].property).toBe("isActive");
  });
});
