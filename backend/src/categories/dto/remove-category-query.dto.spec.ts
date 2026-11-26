import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { RemoveCategoryQueryDto } from "./remove-category-query.dto";

const errorsFor = (reassignTo: unknown) =>
  validate(plainToInstance(RemoveCategoryQueryDto, { reassignTo }));

describe("RemoveCategoryQueryDto", () => {
  it.each([undefined, "uncategorized", "3f2504e0-4f89-41d3-9a0c-0305e82c3301"])(
    "accepts %s",
    async (value) => {
      expect(await errorsFor(value)).toEqual([]);
    },
  );

  it.each([
    "",
    "nobody",
    "uncategorized; DROP TABLE",
    "3f2504e0-4f89-41d3-9a0c-0305e82c33010",
    ["uncategorized"],
    "x".repeat(500),
  ])("rejects %j", async (value) => {
    expect((await errorsFor(value)).length).toBeGreaterThan(0);
  });
});
