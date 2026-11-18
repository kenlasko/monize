import { AliasLedger } from "./payee-alias-collision";

function ledger(): AliasLedger {
  const l = new AliasLedger([
    { owner: "coffee", name: "Coffee" },
    { owner: "amazon", name: "Amazon" },
    { owner: "prime", name: "Prime Video" },
    { owner: "gym", name: "Gym" },
  ]);
  return l;
}

describe("AliasLedger", () => {
  it("accepts an alias nothing else touches", () => {
    expect(ledger().decide("*NETFLIX*", "prime")).toEqual({
      kind: "accept",
      overlap: null,
    });
  });

  it("refuses a literal equal, ignoring case, to another payee's alias", () => {
    const l = ledger();
    l.hold("Starbucks", "coffee");
    expect(l.decide("STARBUCKS", "prime")).toEqual({
      kind: "conflict",
      detail: "Coffee: Starbucks",
    });
  });

  it("refuses a glob that matches another payee's alias, and the reverse", () => {
    const l = ledger();
    l.hold("*STARBUCKS*", "coffee");
    expect(l.decide("STARBUCKS RESERVE*", "prime")).toEqual({
      kind: "conflict",
      detail: "Coffee: *STARBUCKS*",
    });
    expect(l.decide("STARBUCKS RESERVE", "prime")).toEqual({
      kind: "conflict",
      detail: "Coffee: *STARBUCKS*",
    });
    const reverse = ledger();
    reverse.hold("Starbucks Reserve", "coffee");
    expect(reverse.decide("*STARBUCKS*", "prime").kind).toBe("conflict");
  });

  it("does not compare an alias with the same payee's own", () => {
    const l = ledger();
    l.hold("*STARBUCKS*", "coffee");
    expect(l.decide("STARBUCKS RESERVE*", "coffee")).toEqual({
      kind: "accept",
      overlap: null,
    });
  });

  it("refuses a literal equal, ignoring case, to another payee's name", () => {
    expect(ledger().decide("amazon", "prime")).toEqual({
      kind: "conflict",
      detail: "Amazon (name)",
    });
    expect(ledger().decide("amazon", "amazon").kind).toBe("accept");
  });

  it("does not compare a glob with payee names", () => {
    expect(ledger().decide("*amazon*", "prime").kind).toBe("accept");
  });

  it("names the first alias the globs can both match as an overlap", () => {
    const l = ledger();
    l.hold("*AMAZON*", "amazon");
    expect(l.decide("*PRIME*", "prime")).toEqual({
      kind: "accept",
      overlap: "Amazon: *AMAZON*",
    });
    expect(l.decide("PRIME", "prime")).toEqual({
      kind: "accept",
      overlap: null,
    });
  });

  it("counts an alias held under an owner with no listed name by its owner key", () => {
    const l = new AliasLedger([]);
    l.hold("x*", "someone");
    expect(l.decide("x", "other")).toEqual({
      kind: "conflict",
      detail: "someone: x*",
    });
  });
});
