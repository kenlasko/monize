import { validate } from "class-validator";
import { CreatePayeeDto } from "./create-payee.dto";

function buildDto(overrides: Partial<CreatePayeeDto> = {}): CreatePayeeDto {
  const dto = new CreatePayeeDto();
  dto.name = "Starbucks";
  Object.assign(dto, overrides);
  return dto;
}

describe("CreatePayeeDto", () => {
  it("passes validation with just the required name", async () => {
    const errors = await validate(buildDto());
    expect(errors).toHaveLength(0);
  });

  // ── name: payees.name is VARCHAR(255) (database/schema.sql) ─────────

  it("accepts a name at the payees.name column cap (255 characters)", async () => {
    const errors = await validate(buildDto({ name: "x".repeat(255) }));
    expect(errors).toHaveLength(0);
  });

  it("rejects a name one character past the payees.name column cap", async () => {
    const errors = await validate(buildDto({ name: "x".repeat(256) }));
    expect(errors.map((e) => e.property)).toEqual(["name"]);
    expect(errors[0].constraints).toHaveProperty("maxLength");
  });

  it("rejects a missing name", async () => {
    const dto = buildDto();
    delete (dto as Partial<CreatePayeeDto>).name;
    const errors = await validate(dto);
    expect(errors.map((e) => e.property)).toEqual(["name"]);
  });
});
