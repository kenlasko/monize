import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { CreateCategoryDto } from "./create-category.dto";

describe("CreateCategoryDto type", () => {
  const errorsFor = async (body: Record<string, unknown>) =>
    validate(plainToInstance(CreateCategoryDto, { name: "X", ...body }), {
      whitelist: true,
      forbidNonWhitelisted: true,
    });

  it.each(["income", "expense", "transfer"])("accepts %s", async (type) => {
    expect(await errorsFor({ type })).toEqual([]);
  });

  it("rejects any other type, and still accepts the legacy flag alone", async () => {
    expect((await errorsFor({ type: "savings" })).length).toBe(1);
    expect(await errorsFor({ isIncome: true })).toEqual([]);
  });
});
