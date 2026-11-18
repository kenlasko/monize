import {
  computerLabel,
  DEFAULT_MDNS_LABEL,
  isMdnsLabel,
  localName,
  MAX_MDNS_SUFFIX,
  mdnsCandidates,
} from "./names";

describe("isMdnsLabel", () => {
  it.each(["monize", "monize-2", "a", "desktop-8f3k2qx", "x".repeat(63)])(
    "accepts %s",
    (label) => expect(isMdnsLabel(label)).toBe(true),
  );

  it.each([
    "",
    "Monize",
    "-monize",
    "monize-",
    "mon_ize",
    "monize.local",
    "x".repeat(64),
    null,
    7,
  ])("refuses %p", (label) => expect(isMdnsLabel(label)).toBe(false));
});

describe("mdnsCandidates", () => {
  it("starts from monize and counts up from 2", () => {
    const list = mdnsCandidates(null);
    expect(list.slice(0, 3)).toEqual(["monize", "monize-2", "monize-3"]);
    expect(list).toHaveLength(MAX_MDNS_SUFFIX);
  });

  it("tries the persisted label first and does not repeat it", () => {
    const list = mdnsCandidates("monize-3");
    expect(list.slice(0, 3)).toEqual([
      "monize-3",
      DEFAULT_MDNS_LABEL,
      "monize-2",
    ]);
    expect(list.filter((label) => label === "monize-3")).toHaveLength(1);
  });

  it("ignores a persisted value that is not a label", () => {
    expect(mdnsCandidates("Not A Label")[0]).toBe(DEFAULT_MDNS_LABEL);
  });
});

describe("computerLabel", () => {
  it("lower-cases a Windows computer name", () => {
    expect(computerLabel("DESKTOP-8F3K2QX")).toBe("desktop-8f3k2qx");
  });

  it("keeps the first label of a dotted name", () => {
    expect(computerLabel("kens-pc.lan")).toBe("kens-pc");
  });

  it("refuses a name DNS cannot carry", () => {
    expect(computerLabel("KEN_PC")).toBeNull();
    expect(computerLabel("")).toBeNull();
  });

  it("builds the .local name", () => {
    expect(localName("monize-2")).toBe("monize-2.local");
  });
});
