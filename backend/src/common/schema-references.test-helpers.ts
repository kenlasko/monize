import { readFileSync } from "fs";
import { join } from "path";

const SCHEMA_PATH = join(__dirname, "..", "..", "..", "database", "schema.sql");

/** Schema text with `--` comments blanked, so documentation cannot match. */
const uncommented = readFileSync(SCHEMA_PATH, "utf8")
  .split("\n")
  .map((line) => line.replace(/--.*$/, ""))
  .join("\n");

/**
 * Every `table.column` with a foreign key to `<table>(id)` in
 * `database/schema.sql`: an inline REFERENCES, a FOREIGN KEY clause inside
 * CREATE TABLE, or an ALTER TABLE ... ADD CONSTRAINT ... FOREIGN KEY. Sorted.
 */
export function foreignKeysTo(table: string): string[] {
  const references: string[] = [];
  const target = String.raw`REFERENCES\s+${table}\s*\(\s*id\s*\)`;
  const tableBlocks = uncommented.matchAll(
    /CREATE TABLE(?: IF NOT EXISTS)?\s+(\w+)\s*\(([\s\S]*?)\n\);/g,
  );
  for (const [, owner, body] of tableBlocks) {
    for (const match of body.matchAll(
      new RegExp(String.raw`^\s*(\w+)\s+[A-Za-z0-9_() ,]*?${target}`, "gim"),
    )) {
      references.push(`${owner}.${match[1]}`);
    }
    for (const match of body.matchAll(
      new RegExp(String.raw`FOREIGN KEY\s*\((\w+)\)\s*${target}`, "gi"),
    )) {
      references.push(`${owner}.${match[1]}`);
    }
  }
  for (const match of uncommented.matchAll(
    new RegExp(
      String.raw`ALTER TABLE\s+(?:IF EXISTS\s+)?(\w+)\s+ADD CONSTRAINT\s+\w+\s+FOREIGN KEY\s*\((\w+)\)\s*${target}`,
      "gi",
    ),
  )) {
    references.push(`${match[1]}.${match[2]}`);
  }
  return references.sort();
}
