import { rawPayee } from "../__fixtures__/kmy-raw-builders";
import { KmyPayee, KmyPayeeMatch } from "../model/kmy-raw";
import { translateKey, translatePayeeMatch } from "./kmy-payee-match";

function payee(
  name: string,
  match: Partial<KmyPayeeMatch> & { kind: KmyPayeeMatch["kind"] },
): KmyPayee {
  return rawPayee("P1", name, {
    match: { ignoreCase: true, keys: [], ...match },
  });
}

function keyed(
  name: string,
  keys: string[],
  ignoreCase = true,
): ReturnType<typeof translatePayeeMatch> {
  return translatePayeeMatch(
    payee(name, { kind: "key", keys, ignoreCase }),
    name.trim(),
  );
}

describe("translateKey (the subset grammar of spec 5.5.1)", () => {
  it.each([
    ["CITY POWER", "*CITY POWER*"],
    ["^CITY POWER", "CITY POWER*"],
    ["CITY POWER$", "*CITY POWER"],
    ["^CITY POWER$", "CITY POWER"],
    ["^THE\\ AMERICAN\\ CHE\\ CONS\\ PAY$", "THE AMERICAN CHE CONS PAY"],
    ["^AMZN.*MKTP$", "AMZN*MKTP"],
    ["^AMZN.*?MKTP$", "AMZN*MKTP"],
    ["^.*AMZN.*.*$", "*AMZN*"],
    ["a\\.b", "*a.b*"],
    ["caf\\é", "*café*"],
    ["^abc\\$", "abc$*"],
    ["^", "*"],
    ["$", "*"],
    [".*", "*"],
    ["^$", ""],
    ["a\\$b", "*a$b*"],
  ])("%s becomes %s", (key, glob) => {
    expect(translateKey(key)?.glob).toBe(glob);
  });

  it.each([
    "AMAZON.COM",
    "^(SHELL\\|ESSO)",
    "(SHELL|ESSO)",
    "\\d{4} PAYROLL",
    "\\d",
    "\\b",
    "\\s",
    "\\w",
    "\\0",
    "\\Q.\\E",
    "a+",
    "a?",
    "a*",
    "[abc]",
    "a{2}",
    "a|b",
    "(?i)a",
    "a^b",
    "a$b",
    "^^a",
    "a$$",
    ".*+",
    ".*??",
    "a\\",
    ".",
    "a.b",
    ".+",
  ])("%s is outside the subset", (key) => {
    expect(translateKey(key)).toBeNull();
  });

  it("marks an escaped star", () => {
    expect(translateKey("SALE \\*50%")?.literalStar).toBe(true);
    expect(translateKey("SALE 50%")?.literalStar).toBe(false);
  });
});

describe("translatePayeeMatch: truth table", () => {
  it("Disabled: no alias, payeeMatchingDisabled", () => {
    expect(
      translatePayeeMatch(
        payee("Corner Market", { kind: "disabled" }),
        "Corner Market",
      ),
    ).toEqual({
      candidates: [],
      warnings: [{ code: "payeeMatchingDisabled", subject: "Corner Market" }],
    });
  });

  it("Name, ic: the name contained anywhere", () => {
    const result = translatePayeeMatch(
      payee("Netflix", { kind: "name" }),
      "Netflix",
    );
    expect(result.candidates).toEqual([{ glob: "*Netflix*", key: "Netflix" }]);
    expect(result.warnings).toEqual([]);
  });

  it("Name, case-sensitive, a cased letter: widened", () => {
    const result = translatePayeeMatch(
      payee("Netflix", { kind: "name", ignoreCase: false }),
      "Netflix",
    );
    expect(result.candidates[0].glob).toBe("*Netflix*");
    expect(result.warnings).toEqual([
      { code: "payeeMatchCaseWidened", subject: "Netflix: Netflix" },
    ]);
  });

  it("Name with a star in the name: literalStar", () => {
    const result = translatePayeeMatch(payee("A*B", { kind: "name" }), "A*B");
    expect(result.candidates).toEqual([]);
    expect(result.warnings).toEqual([
      {
        code: "payeeMatchKeyNotImported",
        subject: "A*B: A*B",
        detail: "literalStar",
      },
    ]);
  });

  it("NameExact, ic, a cased letter: the name as an alias", () => {
    const result = translatePayeeMatch(
      payee("bank", { kind: "nameExact" }),
      "bank",
    );
    expect(result.candidates).toEqual([{ glob: "bank", key: "bank" }]);
    expect(result.warnings).toEqual([]);
  });

  it("NameExact, not ic: nothing, no warning (the exact-name tier is the rule)", () => {
    expect(
      translatePayeeMatch(
        payee("bank", { kind: "nameExact", ignoreCase: false }),
        "bank",
      ),
    ).toEqual({ candidates: [], warnings: [] });
  });

  it("NameExact with no cased letter (7/11): nothing, no warning", () => {
    expect(
      translatePayeeMatch(payee("7/11", { kind: "nameExact" }), "7/11"),
    ).toEqual({ candidates: [], warnings: [] });
  });

  it("NameExact, ic, a name with edge spaces: edgeWhitespace", () => {
    const result = translatePayeeMatch(
      payee(" bank ", { kind: "nameExact" }),
      "bank",
    );
    expect(result.warnings).toEqual([
      {
        code: "payeeMatchKeyNotImported",
        subject: "bank:  bank ",
        detail: "edgeWhitespace",
      },
    ]);
  });

  it("Key ^$ imports nothing and says nothing", () => {
    expect(keyed("X", ["^$"])).toEqual({ candidates: [], warnings: [] });
  });

  it("Key outside the subset: payeeMatchKeyNotImported, untranslatable", () => {
    expect(keyed("Amazon", ["AMAZON.COM"])).toEqual({
      candidates: [],
      warnings: [
        {
          code: "payeeMatchKeyNotImported",
          subject: "Amazon: AMAZON.COM",
          detail: "untranslatable",
        },
      ],
    });
  });

  it("Key mode keeps each key's own outcome, in key order", () => {
    const result = keyed("Amazon", ["^AMZN.*MKTP$", "AMAZON.COM", "AMAZON"]);
    expect(result.candidates.map((c) => c.glob)).toEqual([
      "AMZN*MKTP",
      "*AMAZON*",
    ]);
    expect(result.warnings).toHaveLength(1);
  });
});

describe("translatePayeeMatch: the checks", () => {
  const detailOf = (key: string, name = "Shop"): string | undefined =>
    keyed(name, [key]).warnings[0]?.detail;

  it("1: a literal star", () => {
    expect(detailOf("SALE \\*50%", "Sale")).toBe("literalStar");
  });
  it("2: a glob that is only a star", () => {
    expect(detailOf(".*", "Misc")).toBe("matchesEverything");
    expect(detailOf("^.*$", "Misc")).toBe("matchesEverything");
    expect(detailOf("^", "Misc")).toBe("matchesEverything");
  });
  it("3: an angle bracket", () => {
    expect(detailOf("A<B")).toBe("angleBracket");
    expect(detailOf("^A>")).toBe("angleBracket");
  });
  it("4: whitespace at an end of the glob", () => {
    expect(detailOf("^ A$")).toBe("edgeWhitespace");
    expect(detailOf("^A\\ $")).toBe("edgeWhitespace");
    // a star on each side hides the edge: the text may continue either way
    expect(detailOf(" A ")).toBeUndefined();
  });
  it("5: longer than 255 characters", () => {
    expect(detailOf(`^${"a".repeat(256)}$`)).toBe("tooLong");
    expect(keyed("Shop", [`^${"a".repeat(255)}$`]).candidates).toHaveLength(1);
  });
  it("6: a character whose lowercase has another length", () => {
    expect(detailOf("^İSTANBUL$")).toBe("caseFolding");
  });

  it("7: an exact glob equal to the trimmed name, case-sensitive: nothing", () => {
    expect(keyed("Amazon", ["^Amazon$"], false)).toEqual({
      candidates: [],
      warnings: [],
    });
  });
  it("7: an exact glob with no cased letter equal to the name: nothing", () => {
    expect(keyed("7/11", ["^7/11$"])).toEqual({ candidates: [], warnings: [] });
  });
  it("7 does not apply to a case-insensitive key with a cased letter", () => {
    expect(keyed("Amazon", ["^Amazon$"]).candidates).toEqual([
      { glob: "Amazon", key: "^Amazon$" },
    ]);
  });
  it("7 does not apply when the glob differs from the name", () => {
    expect(keyed("Amazon", ["^amazon$"], false).candidates).toHaveLength(1);
  });

  it("8: case-sensitive with a cased letter is imported and widened", () => {
    const result = keyed("Gym", ["^GYM CLUB"], false);
    expect(result.candidates).toEqual([
      { glob: "GYM CLUB*", key: "^GYM CLUB" },
    ]);
    expect(result.warnings).toEqual([
      { code: "payeeMatchCaseWidened", subject: "Gym: ^GYM CLUB" },
    ]);
  });
  it("9: a case-sensitive key with no cased letter is imported silently", () => {
    expect(keyed("Shop", ["^1234"], false)).toEqual({
      candidates: [{ glob: "1234*", key: "^1234" }],
      warnings: [],
    });
  });
  it("9: a case-insensitive key is imported silently", () => {
    expect(keyed("Shop", ["^SHOP"]).warnings).toEqual([]);
  });
});

describe("translatePayeeMatch: worked examples (spec 5.5.5)", () => {
  it.each([
    [
      "Big Org",
      ["^THE\\ AMERICAN\\ CHE\\ CONS\\ PAY$"],
      true,
      ["THE AMERICAN CHE CONS PAY"],
      [],
    ],
    ["City Power", ["CITY POWER"], true, ["*CITY POWER*"], []],
    ["Amazon", ["^AMZN.*MKTP$"], true, ["AMZN*MKTP"], []],
    [
      "Amazon",
      ["AMAZON.COM"],
      true,
      [],
      ["payeeMatchKeyNotImported:untranslatable"],
    ],
    ["Gym", ["^GYM CLUB"], false, ["GYM CLUB*"], ["payeeMatchCaseWidened:"]],
    [
      "Fuel",
      ["^(SHELL\\|ESSO)"],
      true,
      [],
      ["payeeMatchKeyNotImported:untranslatable"],
    ],
    [
      "Payroll",
      ["\\d{4} PAYROLL"],
      true,
      [],
      ["payeeMatchKeyNotImported:untranslatable"],
    ],
    ["Misc", [".*"], true, [], ["payeeMatchKeyNotImported:matchesEverything"]],
    [
      "Sale",
      ["SALE \\*50%"],
      true,
      [],
      ["payeeMatchKeyNotImported:literalStar"],
    ],
    ["Amazon", ["^Amazon$"], false, [], []],
  ])("%s %j (ic %s)", (name, keys, ic, globs, warnings) => {
    const result = keyed(name, keys, ic);
    expect(result.candidates.map((c) => c.glob)).toEqual(globs);
    expect(result.warnings.map((w) => `${w.code}:${w.detail ?? ""}`)).toEqual(
      warnings,
    );
  });
});
