import { readFileSync } from "fs";
import { join } from "path";

/**
 * M1: the file side of verification must not share the mapper's amount logic,
 * or a defect in that logic makes both sides agree. `kmy-file-expectations.ts`
 * may read the raw model, the rational and rounding helpers, the account and
 * security identity and KMyMoney's own share replay -- nothing that decides
 * what a split's amount is, which splits count, or what a row is.
 */
describe("kmy-file-expectations imports (M1 guard)", () => {
  const source = readFileSync(
    join(__dirname, "kmy-file-expectations.ts"),
    "utf8",
  );
  const imports = [
    ...source.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+"([^"]+)"/g),
  ].map((match) => ({
    names: match[1]
      .split(",")
      .map((name) => name.trim())
      .filter(Boolean),
    from: match[2],
  }));

  const ALLOWED: Record<string, readonly string[] | "types"> = {
    "../model/kmy-raw": "types",
    "../model/kmy-rational": ["Rational", "ZERO", "add", "toNumber"],
    "./kmy-account-tree": ["AccountTree", "KMY_TYPE"],
    "./kmy-amounts": [
      "QUANTITY_PLACES",
      "amountPlaces",
      "isIsoDate",
      "toUnits",
      "unitsToNumber",
    ],
    "./kmy-map-accounts": ["KmyAccountMapping"],
    "./kmy-map-securities": ["KmySecurityMapping"],
    "./kmy-stock-splits": ["journalOrder", "replayStockAccount"],
  };

  it("reads its imports", () => {
    expect(imports.length).toBeGreaterThan(3);
  });

  it.each(Object.keys(ALLOWED))(
    "takes only identity and arithmetic from %s",
    (from) => {
      const allowed = ALLOWED[from];
      for (const entry of imports.filter((i) => i.from === from)) {
        if (allowed === "types") {
          continue;
        }
        expect(entry.names.filter((name) => !allowed.includes(name))).toEqual(
          [],
        );
      }
    },
  );

  it("imports from no other module (no row builder, sign helper, split filter or opening-balance fold)", () => {
    expect(
      imports.map((i) => i.from).filter((from) => !(from in ALLOWED)),
    ).toEqual([]);
  });
});
