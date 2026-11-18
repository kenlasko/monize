import { aliasesCanOverlap, aliasesConflict } from "./alias-overlap.util";
import { matchesAliasPattern } from "./alias-match.util";

function* globs(alphabet: string[], maxLength: number): Generator<string> {
  yield "";
  let level = [""];
  for (let length = 1; length <= maxLength; length++) {
    const next: string[] = [];
    for (const prefix of level) {
      for (const c of alphabet) {
        next.push(prefix + c);
      }
    }
    for (const g of next) yield g;
    level = next;
  }
}

describe("aliasesConflict", () => {
  it.each([
    ["Amazon", "amazon", true],
    ["*Amazon*", "Amazon Prime", true],
    ["Amazon Prime", "*amazon*", true],
    ["STARBUCKS RESERVE*", "*STARBUCKS*", true],
    ["AMZN*MKTP", "AMZN*", true],
    ["Lidl", "Aldi", false],
    ["*lidl", "lidl*", false],
    ["a*b", "a*c", false],
  ])("%s vs %s is %s, in both orders", (a, b, expected) => {
    expect(aliasesConflict(a, b)).toBe(expected);
    expect(aliasesConflict(b, a)).toBe(expected);
  });

  it("agrees with the createAlias refusal rule on its own pairs", () => {
    const pairs: Array<[string, string]> = [
      ["LIDL", "LIDL"],
      ["lidl", "LIDL"],
      ["*lidl*", "LIDL WARSZAWA"],
      ["LIDL WARSZAWA", "*lidl*"],
      ["x", "y"],
    ];
    for (const [a, b] of pairs) {
      const rule =
        a.toLowerCase() === b.toLowerCase() ||
        matchesAliasPattern(a, b) ||
        matchesAliasPattern(b, a);
      expect(aliasesConflict(a, b)).toBe(rule);
    }
  });
});

describe("aliasesCanOverlap", () => {
  it.each([
    ["Netflix", "netflix", true],
    ["Netflix", "Hulu", false],
    ["Netflix", "*flix*", true],
    ["*flix*", "Netflix", true],
    ["Hulu", "*flix*", false],
    ["*AMAZON*", "*PRIME*", true],
    ["AMAZON*", "PRIME*", false],
    ["*AMAZON", "*PRIME", false],
    ["AMAZON*", "AMA*ON", true],
    ["a*b", "c*d", false],
    ["a*b", "a*", true],
    ["a*", "*a", true],
    ["a**b", "a*b", true],
  ])("%s vs %s is %s", (a, b, expected) => {
    expect(aliasesCanOverlap(a, b)).toBe(expected);
    expect(aliasesCanOverlap(b, a)).toBe(expected);
  });

  it("equals a brute force over every text up to 12 characters on {a, b}", () => {
    const texts: string[] = [...globs(["a", "b"], 12)];
    const patterns = [...globs(["a", "b", "*"], 6)].filter((g) => g !== "");
    const matches = patterns.map((pattern) =>
      Uint8Array.from(texts, (t) => (matchesAliasPattern(t, pattern) ? 1 : 0)),
    );
    let compared = 0;
    const disagreements: string[] = [];
    for (let i = 0; i < patterns.length; i += 1) {
      for (let j = i; j < patterns.length; j += 7) {
        let brute = false;
        for (let k = 0; k < texts.length && !brute; k += 1) {
          brute = matches[i][k] === 1 && matches[j][k] === 1;
        }
        if (aliasesCanOverlap(patterns[i], patterns[j]) !== brute) {
          disagreements.push(`${patterns[i]} | ${patterns[j]}`);
        }
        compared += 1;
      }
    }
    expect(disagreements).toEqual([]);
    expect(compared).toBeGreaterThan(50000);
  });
});
