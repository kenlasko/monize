import {
  matchedAliasPattern,
  reportPayeeResolution,
  type PayeeResolutionReport,
} from "./payee-resolution";

describe("matchedAliasPattern", () => {
  const aliases = [
    { payeeId: "p-1", alias: "OTHER*" },
    { payeeId: "p-2", alias: "NOPE" },
    { payeeId: "p-2", alias: "bied*" },
    { payeeId: "p-2", alias: "*1234" },
  ];

  it("finds the first alias of that payee that matches, case-insensitively", () => {
    expect(matchedAliasPattern(aliases, "p-2", "BIEDRONKA 1234")).toBe("bied*");
  });

  it("ignores another payee's aliases, even when they match", () => {
    expect(matchedAliasPattern(aliases, "p-1", "BIEDRONKA")).toBeNull();
    expect(matchedAliasPattern(aliases, "p-1", "OTHER SHOP")).toBe("OTHER*");
  });

  it("is null when none matches", () => {
    expect(matchedAliasPattern(aliases, "p-2", "ZABKA")).toBeNull();
    expect(matchedAliasPattern([], "p-2", "ZABKA")).toBeNull();
  });
});

describe("reportPayeeResolution", () => {
  const report = (
    over: Partial<PayeeResolutionReport> = {},
  ): PayeeResolutionReport => ({
    original: "BIEDRONKA 4711",
    name: "Biedronka S.A.",
    found: null,
    aliasPattern: null,
    rule: null,
    ...over,
  });

  it("reports an existing payee found by exact name, with its id", () => {
    expect(
      reportPayeeResolution(
        report({
          found: { payeeId: "p-1", via: "name" },
          name: "BIEDRONKA 4711",
        }),
      ),
    ).toEqual({
      original: "BIEDRONKA 4711",
      name: "BIEDRONKA 4711",
      via: "name",
      aliasPattern: null,
      payeeId: "p-1",
    });
  });

  it("reports an alias with the pattern that matched", () => {
    expect(
      reportPayeeResolution(
        report({
          found: { payeeId: "p-2", via: "alias" },
          aliasPattern: "BIEDRONKA*",
        }),
      ),
    ).toEqual({
      original: "BIEDRONKA 4711",
      name: "Biedronka S.A.",
      via: "alias",
      aliasPattern: "BIEDRONKA*",
      payeeId: "p-2",
    });
  });

  it("keeps an alias whose pattern could not be found, without inventing one", () => {
    expect(
      reportPayeeResolution(
        report({ found: { payeeId: "p-2", via: "alias" } }),
      ),
    ).toMatchObject({ via: "alias", aliasPattern: null, payeeId: "p-2" });
  });

  it("never reports a pattern for a name match, whatever pattern it is handed", () => {
    expect(
      reportPayeeResolution(
        report({
          found: { payeeId: "p-1", via: "name" },
          aliasPattern: "STRAY*",
        }),
      ).aliasPattern,
    ).toBeNull();
  });

  it("reports a payee to be created when the source gave text and nothing matched", () => {
    expect(reportPayeeResolution(report({ name: "BIEDRONKA 4711" }))).toEqual({
      original: "BIEDRONKA 4711",
      name: "BIEDRONKA 4711",
      via: "new",
      aliasPattern: null,
      payeeId: null,
    });
  });

  it("reports no payee when the source gave no text and nothing set one", () => {
    expect(
      reportPayeeResolution(report({ original: null, name: null })),
    ).toEqual({
      original: null,
      name: null,
      via: "none",
      aliasPattern: null,
      payeeId: null,
    });
  });

  it("lets a rule outrank the lookup, and keeps the source's own text as the original", () => {
    expect(
      reportPayeeResolution(
        report({
          found: { payeeId: "p-2", via: "alias" },
          aliasPattern: "BIEDRONKA*",
          rule: { payeeId: "p-9" },
          name: "Rule's payee",
        }),
      ),
    ).toEqual({
      original: "BIEDRONKA 4711",
      name: "Rule's payee",
      via: "rule",
      aliasPattern: null,
      payeeId: "p-9",
    });
  });

  it("reports a rule that creates or clears the payee with no id", () => {
    expect(
      reportPayeeResolution(
        report({ rule: { payeeId: null }, name: "Created" }),
      ),
    ).toMatchObject({ via: "rule", payeeId: null, name: "Created" });
    expect(
      reportPayeeResolution(report({ rule: { payeeId: null }, name: null })),
    ).toMatchObject({ via: "rule", payeeId: null, name: null });
  });

  it("reports a rule even when the source gave no text", () => {
    expect(
      reportPayeeResolution(
        report({ original: null, rule: { payeeId: "p-9" } }),
      ),
    ).toMatchObject({ original: null, via: "rule" });
  });
});
