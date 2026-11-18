import type { CountryCode } from "libphonenumber-js/max";
import {
  rawAccount,
  rawFile,
  rawPayee,
  rawTag,
} from "../__fixtures__/kmy-raw-builders";
import { KmyPayeeMatch, KmyRawFile } from "../model/kmy-raw";
import {
  mapKmyPayees as mapPayees,
  mapKmyTags,
  payeeHandleById,
  tagHandleById,
  writtenPayees,
} from "./kmy-map-payees-tags";
import { resolvePayeeDefaults } from "./kmy-payee-details";

function mapKmyPayees(
  raw: KmyRawFile,
  referenced: ReadonlySet<number> | null,
  phoneRegion: CountryCode | null = null,
) {
  return mapPayees(raw, referenced, {
    defaults: resolvePayeeDefaults(
      writtenPayees(raw, referenced),
      raw.accounts,
    ),
    phoneRegion,
  });
}

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

describe("mapKmyPayees: default category (spec 5.5.2)", () => {
  const accounts = [
    rawAccount({ id: "A1", name: "Electricity", type: 13 }),
    rawAccount({ id: "A2", name: "Salary", type: 12 }),
    rawAccount({ id: "A3", name: "Checking", type: 1 }),
    rawAccount({ id: "A4", name: "Opening", type: 16, parentId: null }),
    rawAccount({ id: "AStd::Expense", name: "Expense", type: 13 }),
  ];
  const map = (
    payees: ReturnType<typeof rawPayee>[],
    referenced: ReadonlySet<number> | null = null,
  ) => mapKmyPayees(rawFile({ accounts, payees }), referenced);

  it("attaches an income or expense account's handle and lists it for the categories", () => {
    const raw = rawFile({
      accounts,
      payees: [
        rawPayee("P1", "City Power", { defaultAccountId: "A1" }),
        rawPayee("P2", "Employer", { defaultAccountId: "A2" }),
        rawPayee("P3", "Plain"),
      ],
    });
    const defaults = resolvePayeeDefaults(
      writtenPayees(raw, null),
      raw.accounts,
    );
    const handle = (id: string) =>
      raw.accounts.find((a) => a.id === id)?.ordinal;
    expect(defaults.categoryHandles).toEqual(
      new Set([handle("A1"), handle("A2")]),
    );
    const result = mapPayees(raw, null, { defaults, phoneRegion: null });
    expect(result.payees.map((p) => p.defaultCategoryHandle)).toEqual([
      handle("A1"),
      handle("A2"),
      undefined,
    ]);
    expect(result.warnings).toEqual(
      expect.not.arrayContaining([
        expect.objectContaining({ code: "payeeDefaultCategoryNotImported" }),
      ]),
    );
  });

  it("takes an equity account as the equity category of 5.4", () => {
    const raw = rawFile({
      accounts,
      payees: [rawPayee("P1", "Bank", { defaultAccountId: "A4" })],
    });
    const defaults = resolvePayeeDefaults(
      writtenPayees(raw, null),
      raw.accounts,
    );
    expect(defaults.equityHandles.size).toBe(1);
    expect(defaults.categoryHandles.size).toBe(0);
  });

  it.each([
    ["an asset account", "A3", "Checking"],
    ["an id the file does not define", "A999", "A999"],
    ["a standard root", "AStd::Expense", "Expense"],
  ])(
    "skips %s with a warning naming the payee and the account",
    (_label, id, detail) => {
      const result = map([
        rawPayee("P1", "City Power", { defaultAccountId: id }),
      ]);
      expect(result.payees[0].defaultCategoryHandle).toBeUndefined();
      expect(result.warnings).toContainEqual({
        code: "payeeDefaultCategoryNotImported",
        subject: "City Power",
        detail,
      });
    },
  );

  it("keeps the first default among payees of one name and warns on a different later one", () => {
    const result = map([
      rawPayee("P1", "City Power", { defaultAccountId: "A1" }),
      rawPayee("P2", "city power", { defaultAccountId: "A2" }),
      rawPayee("P3", "City POWER", { defaultAccountId: "A1" }),
    ]);
    expect(result.payees).toHaveLength(1);
    // A1 is the first account, so its handle is 1; the later A2 default is refused
    expect(result.payees[0].defaultCategoryHandle).toBe(1);
    expect(
      result.warnings.filter(
        (w) => w.code === "payeeDefaultCategoryNotImported",
      ),
    ).toEqual([
      {
        code: "payeeDefaultCategoryNotImported",
        subject: "city power",
        detail: "sameName",
      },
    ]);
  });

  it("takes a later payee's default when the first of the name has none", () => {
    const result = map([
      rawPayee("P1", "City Power"),
      rawPayee("P2", "city power", { defaultAccountId: "A1" }),
    ]);
    expect(result.payees[0].defaultCategoryHandle).toBeDefined();
  });

  it("ignores the default of a payee the import does not write", () => {
    const result = map(
      [rawPayee("P1", "A", { defaultAccountId: "A1" }), rawPayee("P2", "B")],
      new Set([2]),
    );
    expect(result.payees).toEqual([{ handle: 2, name: "B" }]);
    expect(result.warnings).toEqual([
      { code: "payeeMatchingDisabled", subject: "B" },
    ]);
  });
});

describe("mapKmyPayees: contact details (spec 5.5.3)", () => {
  const address = (over: Partial<ReturnType<typeof rawPayee>["address"]>) => ({
    street: "",
    city: "",
    state: "",
    postcode: "",
    telephone: "",
    ...over,
  });
  const contactOf = (
    over: Parameters<typeof rawPayee>[2],
    region: CountryCode | null = null,
  ) => {
    const result = mapKmyPayees(
      rawFile({ payees: [rawPayee("P1", "Shop", over)] }),
      null,
      region,
    );
    return {
      contact: result.payees[0].contact,
      detail: result.warnings.find((w) => w.code === "payeeDetailsNotImported")
        ?.detail,
    };
  };

  it("imports notes, email, phone and address, trimmed and sanitized", () => {
    expect(
      contactOf(
        {
          notes: "  Ask for <Sam> ",
          email: " billing@example.com ",
          address: address({
            street: "1 Main St\r\n Suite 2 \n",
            city: " Springfield",
            state: "IL",
            postcode: "62701",
            telephone: "+1 202 555 0123",
          }),
        },
        "US",
      ),
    ).toEqual({
      contact: {
        notes: "Ask for Sam",
        email: "billing@example.com",
        phone: "+12025550123",
        address: "1 Main St, Suite 2, Springfield, IL, 62701",
      },
      detail: undefined,
    });
  });

  it("leaves a payee with no details without a contact", () => {
    expect(contactOf({})).toEqual({ contact: undefined, detail: undefined });
    expect(contactOf({ notes: "   ", email: " " }).contact).toBeUndefined();
  });

  it("refuses notes over 500 characters but takes exactly 500", () => {
    expect(contactOf({ notes: "n".repeat(500) }).contact?.notes).toHaveLength(
      500,
    );
    expect(contactOf({ notes: "n".repeat(501) })).toEqual({
      contact: undefined,
      detail: "notes",
    });
  });

  it("refuses an email isEmail rejects, or over 255 characters", () => {
    expect(contactOf({ email: "not an address" }).detail).toBe("email");
    expect(contactOf({ email: `${"a".repeat(250)}@example.com` }).detail).toBe(
      "email",
    );
  });

  it("reads a national phone number only when the preferences name a region", () => {
    const tel = address({ telephone: "(202) 555-0123" });
    expect(contactOf({ address: tel }, "US").contact?.phone).toBe(
      "+12025550123",
    );
    expect(contactOf({ address: tel }, null)).toEqual({
      contact: undefined,
      detail: "phone",
    });
    expect(
      contactOf({ address: address({ telephone: "+44 20 7946 0958" }) }, null)
        .contact?.phone,
    ).toBe("+442079460958");
    expect(
      contactOf({ address: address({ telephone: "12" }) }, "US").detail,
    ).toBe("phone");
  });

  it("refuses an address over 500 characters", () => {
    expect(
      contactOf({ address: address({ street: "s".repeat(501) }) }).detail,
    ).toBe("address");
    expect(
      contactOf({ address: address({ street: "s".repeat(500) }) }).contact
        ?.address,
    ).toHaveLength(500);
  });

  it("keeps the fields that pass and names the ones that do not, with the unsupported ones", () => {
    const result = contactOf({
      notes: "fine",
      email: "bad",
      reference: "R1",
      hasIdentifiers: true,
    });
    expect(result.contact).toEqual({
      notes: "fine",
      email: null,
      phone: null,
      address: null,
    });
    expect(result.detail).toBe("reference, payeeIdentifier, email");
  });

  it("merges payees of one name: each field is the first present", () => {
    const result = mapKmyPayees(
      rawFile({
        payees: [
          rawPayee("P1", "Shop", { notes: "first" }),
          rawPayee("P2", "SHOP", { notes: "second", email: "a@example.com" }),
        ],
      }),
      null,
    );
    expect(result.payees[0].contact).toEqual({
      notes: "first",
      email: "a@example.com",
      phone: null,
      address: null,
    });
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
