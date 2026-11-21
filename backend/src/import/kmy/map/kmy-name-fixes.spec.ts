import {
  rawAccount,
  rawFile,
  rawInstitution,
  rawPayee,
  rawSchedule,
  rawSecurity,
  rawTag,
} from "../__fixtures__/kmy-raw-builders";
import {
  KMY_MAX_NAME_FIXES,
  KMY_MAX_NAME_LENGTH,
  KMY_NAME_FIX_ORIGINAL_CHARS,
  appendOriginal,
  applyKmyNameFixes,
  clipName,
  fitName,
  nameLength,
} from "./kmy-name-fixes";

const SEPA =
  "SEPA-BASISLASTSCHRIFT Stadtwerke Musterstadt GmbH Mandatsreferenz MR-0042 " +
  "Glaeubiger-ID DE98ZZZ09999999999 ".repeat(8);

describe("nameLength and clipName", () => {
  it("count and cut code points, as a VARCHAR does, never half a surrogate pair", () => {
    const emoji = "\u{1F600}";
    expect(emoji.length).toBe(2);
    expect(nameLength(emoji.repeat(3))).toBe(3);
    expect(nameLength("plain")).toBe(5);
    expect(clipName(emoji.repeat(3), 2)).toBe(emoji.repeat(2));
    expect(clipName("short", 10)).toBe("short");
  });

  it("fitName cuts the base so the suffix still fits", () => {
    const name = fitName("x".repeat(300), " - Cash");
    expect(nameLength(name)).toBe(KMY_MAX_NAME_LENGTH);
    expect(name.endsWith("x - Cash")).toBe(true);
    expect(fitName("Short", " (2)")).toBe("Short (2)");
  });
});

describe("applyKmyNameFixes (issue #2313)", () => {
  const long = (prefix: string) => `${prefix} ${"y".repeat(300)}`;
  const raw = rawFile({
    payees: [rawPayee("P1", "Corner Market"), rawPayee("P2", ` ${SEPA} `)],
    accounts: [
      rawAccount({ id: "CHK", name: long("Checking"), type: 1 }),
      rawAccount({ id: "INV", name: "i".repeat(250), type: 7 }),
      rawAccount({ id: "FOOD", name: long("Food"), type: 13 }),
      rawAccount({ id: "EQ", name: long("Equity"), type: 16 }),
      rawAccount({ id: "STK", name: long("Stock"), type: 15 }),
    ],
    securities: [rawSecurity({ id: "E1", name: long("Fund") })],
    schedules: [rawSchedule({ name: long("Rent") })],
    institutions: [rawInstitution("I1", long("Bank"))],
    tags: [rawTag("G1", "Holiday"), rawTag("G2", "t".repeat(101))],
  });

  it("lists every too-long name with its bound, and nothing that fits", () => {
    const { fixes } = applyKmyNameFixes(raw, []);
    expect(
      fixes.entries.map(({ kind, handle, maxLength }) => ({
        kind,
        handle,
        maxLength,
      })),
    ).toEqual([
      { kind: "payee", handle: 2, maxLength: 255 },
      { kind: "account", handle: 6, maxLength: 255 },
      // An investment account's name gains " - Brokerage".
      { kind: "account", handle: 7, maxLength: 255 - " - Brokerage".length },
      { kind: "category", handle: 8, maxLength: 255 },
      { kind: "category", handle: 9, maxLength: 255 },
      { kind: "security", handle: 1, maxLength: 255 },
      { kind: "schedule", handle: 1, maxLength: 255 },
      { kind: "institution", handle: 1, maxLength: 255 },
      { kind: "tag", handle: 2, maxLength: 100 },
    ]);
    expect(fixes.entries[0]).toMatchObject({
      original: SEPA.trim(),
      originalLength: SEPA.trim().length,
    });
    expect(fixes.omitted).toBe(0);
  });

  it("cuts every too-long name to fit when the user chose none, and echoes the names it used", () => {
    const fixed = applyKmyNameFixes(raw, []);
    expect(fixed.raw.payees[1].name).toBe(clipName(SEPA.trim(), 255).trimEnd());
    expect(fixed.raw.payees[0]).toBe(raw.payees[0]);
    for (const named of [
      ...fixed.raw.payees,
      ...fixed.raw.securities,
      ...fixed.raw.schedules,
      ...fixed.raw.institutions,
    ]) {
      expect(nameLength(named.name)).toBeLessThanOrEqual(255);
    }
    expect(fixed.raw.tags[1].name).toBe("t".repeat(100));
    const investment = fixed.raw.accounts.find((a) => a.id === "INV");
    expect(investment?.name.length).toBe(255 - " - Brokerage".length);
    // A stock account is a holding, never written under its own name.
    expect(fixed.raw.accounts.find((a) => a.id === "STK")?.name).toBe(
      long("Stock"),
    );
    expect(fixed.renames).toHaveLength(fixed.fixes.entries.length);
    expect(fixed.renames[0]).toEqual({
      kind: "payee",
      handle: 2,
      name: fixed.raw.payees[1].name,
    });
  });

  it("uses a rename the user chose, trimmed, when it fits", () => {
    const fixed = applyKmyNameFixes(raw, [
      { kind: "payee", handle: 2, name: "  Stadtwerke Musterstadt  " },
      { kind: "category", handle: 8, name: "Groceries" },
    ]);
    expect(fixed.raw.payees[1].name).toBe("Stadtwerke Musterstadt");
    expect(fixed.raw.accounts.find((a) => a.id === "FOOD")?.name).toBe(
      "Groceries",
    );
    expect(fixed.renames).toContainEqual({
      kind: "payee",
      handle: 2,
      name: "Stadtwerke Musterstadt",
    });
  });

  it("cuts instead when a rename is blank, too long for its element, or of another kind", () => {
    const fixed = applyKmyNameFixes(raw, [
      { kind: "payee", handle: 2, name: "   " },
      { kind: "account", handle: 7, name: "j".repeat(250) },
      { kind: "account", handle: 8, name: "Wrong kind" },
    ]);
    expect(fixed.raw.payees[1].name).toBe(clipName(SEPA.trim(), 255).trimEnd());
    expect(fixed.raw.accounts.find((a) => a.id === "INV")?.name).toBe(
      "i".repeat(255 - " - Brokerage".length),
    );
    expect(fixed.raw.accounts.find((a) => a.id === "FOOD")?.name).toBe(
      clipName(long("Food"), 255),
    );
  });

  it("ignores a rename of a name that already fits", () => {
    const fixed = applyKmyNameFixes(raw, [
      { kind: "payee", handle: 1, name: "Something else" },
    ]);
    expect(fixed.raw.payees[0].name).toBe("Corner Market");
  });

  it("returns the file untouched when every name fits", () => {
    const fits = rawFile({ payees: [rawPayee("P1", "Corner Market")] });
    const fixed = applyKmyNameFixes(fits, [
      { kind: "payee", handle: 1, name: "Other" },
    ]);
    expect(fixed.raw).toBe(fits);
    expect(fixed.fixes).toEqual({ entries: [], omitted: 0 });
    expect(fixed.renames).toEqual([]);
  });

  it("lists at most KMY_MAX_NAME_FIXES, cuts the rest, and carries a bounded original", () => {
    const many = rawFile({
      payees: Array.from({ length: KMY_MAX_NAME_FIXES + 2 }, (_, index) =>
        rawPayee(`P${index}`, `${index} ${"z".repeat(5_000)}`),
      ),
    });
    const fixed = applyKmyNameFixes(many, []);
    expect(fixed.fixes.entries).toHaveLength(KMY_MAX_NAME_FIXES);
    expect(fixed.fixes.omitted).toBe(2);
    expect(fixed.renames).toHaveLength(KMY_MAX_NAME_FIXES);
    expect(fixed.fixes.entries[0].original).toHaveLength(
      KMY_NAME_FIX_ORIGINAL_CHARS,
    );
    expect(fixed.fixes.entries[0].originalLength).toBe(5_002);
    const last = fixed.raw.payees[KMY_MAX_NAME_FIXES + 1];
    expect(nameLength(last.name)).toBe(255);
  });

  it("keeps the whole name of every replaced element as originalName", () => {
    const fixed = applyKmyNameFixes(raw, [
      { kind: "payee", handle: 2, name: "Stadtwerke" },
    ]);
    expect(fixed.raw.payees[1].originalName).toBe(SEPA.trim());
    expect(fixed.raw.payees[0].originalName).toBeUndefined();
    expect(fixed.raw.accounts.find((a) => a.id === "CHK")?.originalName).toBe(
      long("Checking"),
    );
  });

  it("never cuts two names of one kind to the same text, unless the user chose it", () => {
    const shared = "s".repeat(260);
    const tagShared = "t".repeat(110);
    const twins = rawFile({
      payees: [
        rawPayee("P1", `${shared} first`),
        rawPayee("P2", `${shared} second`),
        rawPayee("P3", "s".repeat(255)),
      ],
      tags: [rawTag("G1", `${tagShared} a`), rawTag("G2", `${tagShared} b`)],
    });

    const cut = applyKmyNameFixes(twins, []);
    // P3 fits and holds the plain cut, so both long ones are numbered.
    expect(cut.raw.payees.map((p) => p.name)).toEqual([
      `${"s".repeat(251)} (2)`,
      `${"s".repeat(251)} (3)`,
      "s".repeat(255),
    ]);
    expect(cut.raw.tags.map((t) => t.name)).toEqual([
      "t".repeat(100),
      `${"t".repeat(96)} (2)`,
    ]);

    const merged = applyKmyNameFixes(twins, [
      { kind: "payee", handle: 1, name: "Stadtwerke" },
      { kind: "payee", handle: 2, name: "stadtwerke" },
    ]);
    expect(merged.raw.payees.map((p) => p.name).slice(0, 2)).toEqual([
      "Stadtwerke",
      "stadtwerke",
    ]);

    const avoided = applyKmyNameFixes(twins, [
      { kind: "tag", handle: 2, name: "t".repeat(100) },
    ]);
    expect(avoided.raw.tags.map((t) => t.name)).toEqual([
      `${"t".repeat(96)} (2)`,
      "t".repeat(100),
    ]);
  });
});

describe("appendOriginal", () => {
  it("adds the original after a blank line when it fits, or stands alone", () => {
    expect(appendOriginal("My notes", "Original", 500)).toEqual({
      text: "My notes\n\nOriginal",
      cut: false,
    });
    expect(appendOriginal("", "Original", 500)).toEqual({
      text: "Original",
      cut: false,
    });
  });

  it("cuts the original to the room left and says so, never the text before it", () => {
    expect(appendOriginal("ab", "cdefgh", 7)).toEqual({
      text: "ab\n\ncde",
      cut: true,
    });
    expect(appendOriginal("abcdefg", "xyz", 7)).toEqual({
      text: "abcdefg",
      cut: true,
    });
  });
});
