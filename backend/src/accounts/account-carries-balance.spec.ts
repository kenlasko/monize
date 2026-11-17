import {
  accountCarriesBalance,
  accountCarriesBalanceSql,
} from "./account-carries-balance";

describe("accountCarriesBalance", () => {
  it.each([
    [false, 0, true],
    [false, 125.5, true],
    [true, 250, true],
    [true, -42.1, true],
    [true, 0, false],
  ])(
    "isClosed=%s currentBalance=%s -> %s",
    (isClosed, currentBalance, expected) => {
      expect(accountCarriesBalance({ isClosed, currentBalance })).toBe(
        expected,
      );
    },
  );

  it("reads a NUMERIC column delivered as a string", () => {
    expect(
      accountCarriesBalance({
        isClosed: true,
        currentBalance: "0.00000000" as unknown as number,
      }),
    ).toBe(false);
    expect(
      accountCarriesBalance({
        isClosed: true,
        currentBalance: "-0.0100" as unknown as number,
      }),
    ).toBe(true);
  });
});

describe("accountCarriesBalanceSql", () => {
  it("qualifies both columns with the alias", () => {
    expect(accountCarriesBalanceSql("a")).toBe(
      "(a.is_closed = false OR a.current_balance <> 0)",
    );
  });

  it("leaves the columns bare without an alias", () => {
    expect(accountCarriesBalanceSql()).toBe(
      "(is_closed = false OR current_balance <> 0)",
    );
  });
});
