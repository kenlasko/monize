import { LoanFeesController } from "./loan-fees.controller";
import { LoanFeesService } from "./loan-fees.service";

describe("LoanFeesController", () => {
  const service = {
    list: jest.fn().mockResolvedValue([]),
    replace: jest.fn().mockResolvedValue([]),
  };
  const controller = new LoanFeesController(
    service as unknown as LoanFeesService,
  );
  const req = { user: { id: "user-1" } };

  it("lists the caller's mortgage fees with the JWT's user", async () => {
    await controller.list(req, "acc-1");
    expect(service.list).toHaveBeenCalledWith("user-1", "acc-1");
  });

  it("replaces the fee set with the JWT's user", async () => {
    const fees = [
      {
        categoryId: "cat-tax",
        name: "Tax",
        calculation: "FIXED" as const,
        basis: "ANNUAL" as const,
        amount: 1200,
      },
    ];
    await controller.replace(req, "acc-1", { fees });
    expect(service.replace).toHaveBeenCalledWith("user-1", "acc-1", fees);
  });
});
