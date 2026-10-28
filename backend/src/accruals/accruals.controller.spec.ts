import { GUARDS_METADATA } from "@nestjs/common/constants";
import { DEMO_RESTRICTED_KEY } from "../common/guards/demo-mode.guard";
import { AccrualsController } from "./accruals.controller";
describe("accrual controller boundaries", () => {
  it("has an authentication guard and restricts both mutation handlers in demo mode", () => {
    expect(
      Reflect.getMetadata(GUARDS_METADATA, AccrualsController),
    ).toHaveLength(1);
    for (const method of ["save", "remove"] as const) {
      expect(
        Reflect.getMetadata(
          DEMO_RESTRICTED_KEY,
          AccrualsController.prototype[method],
        ),
      ).toBe(true);
    }
  });
});
