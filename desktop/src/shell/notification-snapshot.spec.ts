import {
  MAX_SNAPSHOT_ROWS,
  MAX_TARGET_LENGTH,
  MAX_TEXT_LENGTH,
  parseSnapshot,
} from "./notification-snapshot";

const ROW = {
  id: "0b6f3c1e-2d4a-4f7e-9a1b-3c5d7e9f1a2b",
  createdAt: "2026-11-13T10:00:00.000Z",
  title: "Payment reminder",
  body: "A bill or scheduled payment needs your attention.",
  target: "/bills",
};

describe("parseSnapshot", () => {
  it("reads a signed-in snapshot, with createdAt as milliseconds", () => {
    expect(parseSnapshot({ identity: "user-1", rows: [ROW] })).toEqual({
      identity: "user-1",
      rows: [
        {
          id: ROW.id,
          createdAtMs: Date.parse(ROW.createdAt),
          title: ROW.title,
          body: ROW.body,
          target: "/bills",
        },
      ],
    });
  });

  it("reads a signed-out snapshot and a row without a target", () => {
    expect(parseSnapshot({ identity: null, rows: [] })).toEqual({
      identity: null,
      rows: [],
    });
    expect(
      parseSnapshot({ identity: "u", rows: [{ ...ROW, target: null }] })
        ?.rows[0].target,
    ).toBeNull();
  });

  it.each([
    ["not an object", "snapshot"],
    ["null", null],
    ["an array", []],
    ["no identity", { rows: [] }],
    ["a numeric identity", { identity: 7, rows: [] }],
    ["an empty identity", { identity: "", rows: [] }],
    ["an identity with spaces", { identity: "a b", rows: [] }],
    ["a long identity", { identity: "u".repeat(129), rows: [] }],
    ["no rows", { identity: "u" }],
    ["rows that are not a list", { identity: "u", rows: {} }],
    ["rows while signed out", { identity: null, rows: [ROW] }],
    [
      "too many rows",
      { identity: "u", rows: Array(MAX_SNAPSHOT_ROWS + 1).fill(ROW) },
    ],
  ])("drops %s", (_label, raw) => {
    expect(parseSnapshot(raw)).toBeNull();
  });

  it.each([
    ["a missing id", { ...ROW, id: undefined }],
    ["an id with a slash", { ...ROW, id: "../x" }],
    ["an id too long", { ...ROW, id: "a".repeat(65) }],
    ["an unparseable date", { ...ROW, createdAt: "yesterday" }],
    ["a numeric date", { ...ROW, createdAt: 1 }],
    ["an empty title", { ...ROW, title: "" }],
    ["a long title", { ...ROW, title: "t".repeat(MAX_TEXT_LENGTH + 1) }],
    ["a missing body", { ...ROW, body: undefined }],
    ["a long target", { ...ROW, target: `/${"a".repeat(MAX_TARGET_LENGTH)}` }],
    ["a numeric target", { ...ROW, target: 5 }],
    ["a missing target", { ...ROW, target: undefined }],
  ])("drops the whole snapshot for a row with %s", (_label, row) => {
    expect(parseSnapshot({ identity: "u", rows: [ROW, row] })).toBeNull();
  });

  it("keeps nothing it was not sent: extra fields are not carried", () => {
    const parsed = parseSnapshot({
      identity: "u",
      rows: [{ ...ROW, amount: 12.5 }],
      token: "x",
    });
    expect(Object.keys(parsed ?? {}).sort()).toEqual(["identity", "rows"]);
    expect(Object.keys(parsed?.rows[0] ?? {}).sort()).toEqual([
      "body",
      "createdAtMs",
      "id",
      "target",
      "title",
    ]);
  });
});
