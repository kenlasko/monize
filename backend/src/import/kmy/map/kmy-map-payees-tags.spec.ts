import { rawFile, rawPayee, rawTag } from "../__fixtures__/kmy-raw-builders";
import { KmyPayeeMatch } from "../model/kmy-raw";
import {
  mapKmyPayees,
  mapKmyTags,
  payeeHandleById,
  tagHandleById,
} from "./kmy-map-payees-tags";

const key = (keys: string[], ignoreCase = true) => ({
  match: { kind: "key", ignoreCase, keys } as KmyPayeeMatch,
});
const name = (ignoreCase = true) => ({
  match: { kind: "name", ignoreCase, keys: [] } as KmyPayeeMatch,
});

describe("mapKmyPayees (spec 5.5)", () => {
  const raw = rawFile({
    payees: [
      rawPayee("P1", " Corner Market "),
      rawPayee("P2", "City Power", { reference: "R1" }),
      rawPayee("P3", "corner market"),
      rawPayee("P4", "   "),
    ],
  });

  it("indexes payees and tags by their ordinal", () => {
    expect(payeeHandleById(raw).get("P2")).toBe(2);
    expect(
      tagHandleById(rawFile({ tags: [rawTag("G1", "x")] })).get("G1"),
    ).toBe(1);
  });

  it("imports every payee when nothing filters, unique by name case-insensitively", () => {
    const result = mapKmyPayees(raw, null);
    expect(result.payees).toEqual([
      { handle: 1, name: "Corner Market" },
      { handle: 2, name: "City Power" },
    ]);
    expect(result.nameByHandle.get(3)).toBe("corner market");
    expect(result.skipped).toBe(1);
  });

  it("imports only referenced payees and warns once per payee, and per field list, with details Monize has no field for", () => {
    const result = mapKmyPayees(raw, new Set([2]));
    expect(result.payees).toEqual([{ handle: 2, name: "City Power" }]);
    expect(result.skipped).toBe(3);
    expect(result.warnings).toEqual([
      { code: "payeeMatchingDisabled", subject: "City Power" },
      {
        code: "payeeDetailsNotImported",
        subject: "City Power",
        detail: "reference",
      },
    ]);
  });

  it("names every unsupported field of a payee in one warning", () => {
    const result = mapKmyPayees(
      rawFile({
        payees: [
          rawPayee("P1", "A", {
            reference: "R",
            hasIdentifiers: true,
            hasLinkPattern: true,
          }),
        ],
      }),
      null,
    );
    expect(
      result.warnings.filter((w) => w.code === "payeeDetailsNotImported"),
    ).toEqual([
      {
        code: "payeeDetailsNotImported",
        subject: "A",
        detail: "reference, payeeIdentifier, idpattern/urltemplate",
      },
    ]);
  });
});

describe("mapKmyPayees: matching rules as aliases (spec 5.5.1, 5.5.5)", () => {
  const map = (
    payees: ReturnType<typeof rawPayee>[],
    referenced: ReadonlySet<number> | null = null,
  ) => mapKmyPayees(rawFile({ payees }), referenced);

  it("maps the synthetic file's rule and the disabled one", () => {
    const result = map([
      rawPayee("P1", "Corner Market"),
      rawPayee("P2", "City Power", key(["CITY POWER"])),
    ]);
    expect(result.payees).toEqual([
      { handle: 1, name: "Corner Market" },
      { handle: 2, name: "City Power", aliases: ["*CITY POWER*"] },
    ]);
    expect(result.warnings).toEqual([
      { code: "payeeMatchingDisabled", subject: "Corner Market" },
    ]);
  });

  it("refuses a later alias an earlier payee's alias matches (Coffee, Starbucks Reserve)", () => {
    const result = map([
      rawPayee("P1", "Other"),
      rawPayee("P2", "Pad"),
      rawPayee("P3", "Coffee", key(["STARBUCKS"])),
      rawPayee("P4", "Starbucks Reserve", key(["^STARBUCKS RESERVE"])),
    ]);
    expect(result.payees.map((p) => p.aliases)).toEqual([
      undefined,
      undefined,
      ["*STARBUCKS*"],
      undefined,
    ]);
    expect(
      result.warnings.filter((w) => w.code === "payeeMatchKeyConflict"),
    ).toEqual([
      {
        code: "payeeMatchKeyConflict",
        subject: "Starbucks Reserve: STARBUCKS RESERVE*",
        detail: "Coffee: *STARBUCKS*",
      },
    ]);
  });

  it("keeps both aliases that can match the same text and warns on the later (Amazon, Prime Video)", () => {
    const result = map([
      rawPayee("P5", "Amazon", name()),
      rawPayee("P6", "Prime Video", key(["PRIME"])),
    ]);
    expect(result.payees.map((p) => p.aliases)).toEqual([
      ["*Amazon*"],
      ["*PRIME*"],
    ]);
    expect(result.warnings).toEqual([
      {
        code: "payeeMatchKeyOverlap",
        subject: "Prime Video: *PRIME*",
        detail: "Amazon: *Amazon*",
      },
    ]);
  });

  it("refuses a literal alias equal to another written payee's name", () => {
    const result = map([
      rawPayee("P1", "Bank"),
      rawPayee("P2", "Branch", key(["^BANK$"])),
    ]);
    expect(result.payees[1].aliases).toBeUndefined();
    expect(result.warnings).toContainEqual({
      code: "payeeMatchKeyConflict",
      subject: "Branch: BANK",
      detail: "Bank (name)",
    });
  });

  it("merges payees of one name ignoring case into one alias set without a collision", () => {
    const result = map([
      rawPayee("P1", "Amazon", key(["AMAZON", "^AMZN"])),
      rawPayee("P2", "AMAZON", key(["amazon", "AMZN MKTP"])),
    ]);
    expect(result.payees).toEqual([
      {
        handle: 1,
        name: "Amazon",
        aliases: ["*AMAZON*", "AMZN*", "*AMZN MKTP*"],
      },
    ]);
    expect(result.warnings).toEqual([]);
  });

  it("drops an alias another alias of the same payee subsumes", () => {
    const result = map([
      rawPayee("P1", "Shell", key(["^SHELL ONE", "SHELL", "^SHELL"])),
    ]);
    expect(result.payees[0].aliases).toEqual(["*SHELL*"]);
  });

  it("keeps a narrow alias when its broad sibling was refused", () => {
    const result = map([
      rawPayee("P1", "Coffee", key(["^SHELL"])),
      rawPayee("P2", "Gas", key(["SHELL ONE", "SHELL"])),
    ]);
    // `*SHELL*` matches Coffee's `SHELL*` and is refused; `*SHELL ONE*` stays
    expect(result.payees[1].aliases).toEqual(["*SHELL ONE*"]);
    expect(
      result.warnings.filter((w) => w.code === "payeeMatchKeyConflict"),
    ).toHaveLength(1);
  });

  it("drops a payee's rules with the payee under referenced-only", () => {
    const result = map(
      [
        rawPayee("P1", "A", key(["AAA"])),
        rawPayee("P2", "B", key(["BBB"])),
        rawPayee("P3", "C", key(["^C.D"])),
      ],
      new Set([2]),
    );
    expect(result.payees).toEqual([
      { handle: 2, name: "B", aliases: ["*BBB*"] },
    ]);
    expect(result.warnings).toEqual([]);
  });

  it("reports every untranslated key with the payee and the key as written", () => {
    const result = map([
      rawPayee("P1", "Amazon", key(["AMAZON.COM", "^AMZN"])),
      rawPayee("P2", "Gym", key(["^GYM CLUB"], false)),
    ]);
    expect(result.warnings).toEqual([
      {
        code: "payeeMatchKeyNotImported",
        subject: "Amazon: AMAZON.COM",
        detail: "untranslatable",
      },
      { code: "payeeMatchCaseWidened", subject: "Gym: ^GYM CLUB" },
    ]);
    expect(result.payees.map((p) => p.aliases)).toEqual([
      ["AMZN*"],
      ["GYM CLUB*"],
    ]);
  });
});

describe("mapKmyTags (spec 5.5)", () => {
  const raw = rawFile({
    tags: [
      rawTag("G1", "household"),
      rawTag("G2", "Household"),
      rawTag("G3", "x".repeat(150)),
      rawTag("G4", "unused"),
      rawTag("G5", " "),
    ],
  });

  it("creates only referenced tags, truncates to 100 characters and merges case variants", () => {
    const result = mapKmyTags(raw, new Set([1, 2, 3, 5]));
    expect(result.tags.map((t) => t.name)).toEqual([
      "household",
      "x".repeat(100),
    ]);
    expect(result.byHandle.get(2)).toBe(result.byHandle.get(1));
    expect(result.inFile).toBe(5);
    expect(result.skipped).toBe(2);
    expect(result.warnings).toEqual([]);
  });
});
