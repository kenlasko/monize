import type { ValidatedToken } from "../pat.service";
import { admitPat, admittedPatOf, patBearerOf } from "./pat-bearer";

const TOKEN: ValidatedToken = {
  userId: "11111111-1111-1111-1111-111111111111",
  scopes: "read",
  tokenId: "22222222-2222-2222-2222-222222222222",
};

describe("patBearerOf", () => {
  it("reads a PAT bearer", () => {
    expect(
      patBearerOf({ headers: { authorization: "Bearer pat_abc123" } }),
    ).toBe("pat_abc123");
  });

  it("reads the scheme case-insensitively", () => {
    expect(
      patBearerOf({ headers: { authorization: "bearer pat_abc123" } }),
    ).toBe("pat_abc123");
  });

  it("returns null for a JWT bearer", () => {
    expect(
      patBearerOf({ headers: { authorization: "Bearer eyJhbGciOi.e30.sig" } }),
    ).toBeNull();
  });

  it("returns null when there is no authorization header", () => {
    expect(patBearerOf({ headers: {} })).toBeNull();
  });

  it("returns null when the request has no headers", () => {
    expect(patBearerOf({})).toBeNull();
  });

  it.each([
    ["an array", ["Bearer pat_abc"]],
    ["a number", 42],
    ["an object", { a: 1 }],
  ])("returns null for a non-string header (%s)", (_label, value) => {
    expect(patBearerOf({ headers: { authorization: value } })).toBeNull();
  });

  it.each([
    ["Bearer pat_ "],
    ["Bearer pat_abc "],
    ["Bearer pat_abc def"],
    ["Bearer  pat_abc"],
    ["Bearer pat_"],
  ])("returns null for %p", (header) => {
    expect(patBearerOf({ headers: { authorization: header } })).toBeNull();
  });
});

describe("admitPat / admittedPatOf", () => {
  it("round-trips the token for the same request object", () => {
    const req = {};
    admitPat(req, TOKEN);
    expect(admittedPatOf(req)).toBe(TOKEN);
  });

  it("has no entry for a different request object", () => {
    admitPat({}, TOKEN);
    expect(admittedPatOf({})).toBeUndefined();
  });
});
