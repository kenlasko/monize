import { plainToInstance } from "class-transformer";
import { validateSync } from "class-validator";
import {
  LOAN_OCCURRENCES_MAX_COUNT,
  LoanOccurrencesQueryDto,
} from "./loan-occurrences-query.dto";

const errorsFor = (query: Record<string, unknown>) =>
  validateSync(plainToInstance(LoanOccurrencesQueryDto, query), {
    whitelist: true,
    forbidNonWhitelisted: true,
  }).map((e) => e.property);

describe("LoanOccurrencesQueryDto", () => {
  it("accepts no count, and a count inside the bound", () => {
    expect(errorsFor({})).toEqual([]);
    expect(errorsFor({ count: "1" })).toEqual([]);
    expect(errorsFor({ count: String(LOAN_OCCURRENCES_MAX_COUNT) })).toEqual(
      [],
    );
  });

  it(`refuses 0 and ${LOAN_OCCURRENCES_MAX_COUNT + 1} (spec section 8.5)`, () => {
    expect(errorsFor({ count: "0" })).toContain("count");
    expect(
      errorsFor({ count: String(LOAN_OCCURRENCES_MAX_COUNT + 1) }),
    ).toContain("count");
  });

  it("refuses a count that is not a whole number", () => {
    expect(errorsFor({ count: "2.5" })).toContain("count");
    expect(errorsFor({ count: "twelve" })).toContain("count");
  });

  it("refuses a key it does not declare", () => {
    expect(errorsFor({ through: "2027-01-01" })).toContain("through");
  });
});
