import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import {
  CreatePayrollDeductionRulesDto,
  UpdatePayrollDeductionRuleDto,
} from "./create-payroll-deduction-rule.dto";

describe("payroll deduction DTOs: an empty box is no figure", () => {
  it("reads an empty next maximum or expected amount as null on an update", async () => {
    const dto = plainToInstance(UpdatePayrollDeductionRuleDto, {
      nextYearlyMaximum: "",
      nextExpectedPerPaycheque: "",
      expectedPerPaycheque: "",
    });
    expect(
      await validate(dto, { whitelist: true, forbidNonWhitelisted: true }),
    ).toEqual([]);
    expect(dto.nextYearlyMaximum).toBeNull();
    expect(dto.nextExpectedPerPaycheque).toBeNull();
    expect(dto.expectedPerPaycheque).toBeNull();
  });

  it("does the same on a batch line, and still refuses a negative figure", async () => {
    const dto = plainToInstance(CreatePayrollDeductionRulesDto, {
      scheduledTransactionId: "22222222-2222-4222-8222-222222222222",
      resetDate: "2027-01-01",
      lines: [
        {
          categoryId: "33333333-3333-4333-8333-333333333333",
          yearlyMaximum: 1000,
          nextYearlyMaximum: "",
        },
      ],
    });
    expect(await validate(dto)).toEqual([]);
    expect(dto.lines[0].nextYearlyMaximum).toBeNull();
    const refused = plainToInstance(UpdatePayrollDeductionRuleDto, {
      nextYearlyMaximum: -1,
    });
    expect(await validate(refused)).not.toEqual([]);
  });
});
