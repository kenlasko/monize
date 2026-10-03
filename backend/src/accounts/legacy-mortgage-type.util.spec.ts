import {
  withResolvedMortgageTypeColumn,
  withResolvedMortgageTypeProperty,
} from "./legacy-mortgage-type.util";

/**
 * A snapshot written before the contract migration resolves to the type the
 * migration gives a stored row (docs/specs/mortgage-types.md, table 4.2 and
 * task P3-B1), and loses the dropped flags.
 */
describe("withResolvedMortgageTypeColumn (backup rows)", () => {
  const mortgage = (fields: Record<string, unknown>) => ({
    id: "m-1",
    account_type: "MORTGAGE",
    name: "Home",
    ...fields,
  });

  it.each([
    [true, false, "CANADIAN_FIXED"],
    [true, true, "ANNUITY"],
    [false, false, "ANNUITY"],
    [false, true, "ANNUITY"],
    // A NULL flag reads as false, as the migrations' COALESCE does.
    [true, null, "CANADIAN_FIXED"],
    [null, false, "ANNUITY"],
  ])(
    "a pre-Phase-1 mortgage with flags (%s, %s) is %s",
    (isCanadian, isVariable, type) => {
      expect(
        withResolvedMortgageTypeColumn(
          mortgage({
            is_canadian_mortgage: isCanadian,
            is_variable_rate: isVariable,
          }),
        ),
      ).toEqual(mortgage({ mortgage_type: type }));
    },
  );

  it("reads a null type from the flags, as a Phase 1 backup carries it", () => {
    expect(
      withResolvedMortgageTypeColumn(
        mortgage({
          mortgage_type: null,
          is_canadian_mortgage: true,
          is_variable_rate: false,
        }),
      ).mortgage_type,
    ).toBe("CANADIAN_FIXED");
  });

  it("keeps a stored type over the flags", () => {
    expect(
      withResolvedMortgageTypeColumn(
        mortgage({
          mortgage_type: "LINEAR",
          is_canadian_mortgage: true,
          is_variable_rate: false,
        }),
      ),
    ).toEqual(mortgage({ mortgage_type: "LINEAR" }));
  });

  it("gives any other account the default, whatever its flags", () => {
    expect(
      withResolvedMortgageTypeColumn({
        id: "l-1",
        account_type: "LOAN",
        mortgage_type: null,
        is_canadian_mortgage: true,
        is_variable_rate: false,
      }),
    ).toEqual({ id: "l-1", account_type: "LOAN", mortgage_type: "ANNUITY" });
  });

  it("does not mutate the backup's row", () => {
    const row = mortgage({ is_canadian_mortgage: true });
    withResolvedMortgageTypeColumn(row);
    expect(row).toEqual(mortgage({ is_canadian_mortgage: true }));
  });
});

describe("withResolvedMortgageTypeProperty (action-history snapshots)", () => {
  it("resolves a whole pre-contract account snapshot", () => {
    expect(
      withResolvedMortgageTypeProperty({
        id: "m-1",
        accountType: "MORTGAGE",
        mortgageType: null,
        isCanadianMortgage: true,
        isVariableRate: false,
      }),
    ).toEqual({
      id: "m-1",
      accountType: "MORTGAGE",
      mortgageType: "CANADIAN_FIXED",
    });
    expect(
      withResolvedMortgageTypeProperty({
        id: "c-1",
        accountType: "CHEQUING",
        mortgageType: null,
      }),
    ).toEqual({ id: "c-1", accountType: "CHEQUING", mortgageType: "ANNUITY" });
  });

  it("leaves the type of a partial snapshot alone", () => {
    expect(
      withResolvedMortgageTypeProperty({
        name: "Renamed",
        isVariableRate: true,
      }),
    ).toEqual({ name: "Renamed" });
  });

  it("keeps a stored type", () => {
    expect(
      withResolvedMortgageTypeProperty({
        accountType: "MORTGAGE",
        mortgageType: "INTEREST_ONLY",
      }),
    ).toEqual({ accountType: "MORTGAGE", mortgageType: "INTEREST_ONLY" });
  });
});
