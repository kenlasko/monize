import {
  compareVersions,
  decideOffer,
  followsPrereleases,
  parseVersion,
} from "./version-policy";

function order(a: string, b: string): number {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (left === null || right === null) throw new Error(`bad: ${a} ${b}`);
  return compareVersions(left, right);
}

describe("compareVersions", () => {
  it("follows semver precedence, the spec's own example chain included", () => {
    const chain = [
      "1.0.0-alpha",
      "1.0.0-alpha.1",
      "1.0.0-alpha.beta",
      "1.0.0-beta",
      "1.0.0-beta.2",
      "1.0.0-beta.11",
      "1.0.0-rc.1",
      "1.0.0",
      "1.0.1",
      "1.2.0",
      "1.10.0",
      "2.0.0",
    ];
    for (let i = 0; i + 1 < chain.length; i += 1) {
      expect(order(chain[i], chain[i + 1])).toBe(-1);
      expect(order(chain[i + 1], chain[i])).toBe(1);
    }
  });

  it("ignores build metadata and a leading v", () => {
    expect(order("v1.21.0", "1.21.0+win.1")).toBe(0);
  });

  it("rejects what is not a version", () => {
    expect(parseVersion("1.21")).toBeNull();
    expect(parseVersion("01.2.3")).toBeNull();
    expect(parseVersion("latest")).toBeNull();
  });
});

describe("followsPrereleases", () => {
  it("is true only for a prerelease install", () => {
    expect(followsPrereleases("1.21.0")).toBe(false);
    expect(followsPrereleases("1.21.1-beta")).toBe(true);
    expect(followsPrereleases("nonsense")).toBe(false);
  });
});

describe("decideOffer", () => {
  it("accepts a newer stable release", () => {
    expect(decideOffer("1.21.0", "1.22.0")).toEqual({ accept: true });
    expect(decideOffer("1.21.0", "v1.21.1")).toEqual({ accept: true });
  });

  it("never offers a downgrade or the running version", () => {
    expect(decideOffer("1.21.0", "1.20.9")).toEqual({
      accept: false,
      reason: "not-newer",
    });
    expect(decideOffer("1.21.0", "1.21.0")).toEqual({
      accept: false,
      reason: "not-newer",
    });
    // A beta install never steps back to the stable release before it.
    expect(decideOffer("1.21.1-beta", "1.21.0")).toEqual({
      accept: false,
      reason: "not-newer",
    });
  });

  it("never offers a prerelease to a stable install", () => {
    expect(decideOffer("1.21.0", "1.22.0-beta")).toEqual({
      accept: false,
      reason: "prerelease-for-stable",
    });
  });

  it("lets a prerelease install follow prereleases and the next stable", () => {
    expect(decideOffer("1.21.1-beta.1", "1.21.1-beta.2")).toEqual({
      accept: true,
    });
    expect(decideOffer("1.21.1-beta", "1.21.1")).toEqual({ accept: true });
  });

  it("refuses an unparseable version on either side", () => {
    expect(decideOffer("1.21.0", "garbage")).toEqual({
      accept: false,
      reason: "invalid",
    });
  });
});
