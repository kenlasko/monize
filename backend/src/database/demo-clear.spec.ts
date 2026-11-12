import { readFileSync } from "fs";
import { join } from "path";
import { DEMO_CLEAR_EXCLUDED, DEMO_CLEAR_TABLES } from "./demo-clear";

/**
 * The daily demo reset clears a fixed list of tables. A feature that adds a
 * user-owned table and forgets the list leaves a visitor's rows in the demo
 * for good, so the list is held against the schema.
 */
const schema = readFileSync(
  join(__dirname, "../../../database/schema.sql"),
  "utf8",
);

/** Every table the schema creates, with the owner columns it declares. */
function ownedTables(): Map<string, string[]> {
  const owned = new Map<string, string[]>();
  for (const m of schema.matchAll(
    /CREATE TABLE (?:IF NOT EXISTS )?(\w+) \(([\s\S]*?)\n\);/g,
  )) {
    const columns = [...m[2].matchAll(/^\s+(\w*user_id)\s/gm)]
      .map((c) => c[1])
      .filter((c) => c === "user_id" || c === "owner_user_id");
    if (columns.length) owned.set(m[1], columns);
  }
  return owned;
}

describe("demo clear list", () => {
  const listed = new Map(DEMO_CLEAR_TABLES.map(([t, c]) => [t, c]));

  it("covers every table that has an owner column", () => {
    const missing = [...ownedTables().keys()].filter(
      (t) => !listed.has(t) && !(t in DEMO_CLEAR_EXCLUDED),
    );
    // A failure here means a table was added with a user_id: add it to
    // DEMO_CLEAR_TABLES (before anything that references it without cascade),
    // or to DEMO_CLEAR_EXCLUDED with the reason it can stay.
    expect(missing).toEqual([]);
  });

  it("deletes each table by an owner column it really has", () => {
    const owned = ownedTables();
    for (const [table, column] of DEMO_CLEAR_TABLES) {
      expect(owned.get(table)).toContain(column);
    }
  });

  it("lists no table twice and names no table the schema lacks", () => {
    expect(new Set(listed.keys()).size).toBe(DEMO_CLEAR_TABLES.length);
    const owned = ownedTables();
    for (const t of Object.keys(DEMO_CLEAR_EXCLUDED)) {
      expect(owned.has(t) || schema.includes(`CREATE TABLE ${t} `)).toBe(true);
    }
  });

  it("keeps the table that records the reset has run", () => {
    expect(listed.has("job_claims")).toBe(false);
    expect(DEMO_CLEAR_EXCLUDED).toHaveProperty("job_claims");
  });
});
