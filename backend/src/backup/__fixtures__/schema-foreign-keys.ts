import { readFileSync } from "fs";
import { join } from "path";

/**
 * `database/schema.sql` read as data, for the specs that prove a restore
 * declaration against it (`restore-plan.spec.ts`, `restore-references.spec.ts`).
 * One parser, so the two cannot disagree about what the schema says.
 */

export interface ForeignKey {
  table: string;
  column: string;
  referencedTable: string;
  referencedColumn: string;
}

export const SCHEMA_PATH = join(
  __dirname,
  "..",
  "..",
  "..",
  "..",
  "database",
  "schema.sql",
);

export function readSchema(): string {
  return readFileSync(SCHEMA_PATH, "utf8");
}

/** The schema with line comments removed -- several document an FK in prose. */
function withoutLineComments(sql: string): string {
  return sql
    .split("\n")
    .map((line) => line.replace(/--.*$/, ""))
    .join("\n");
}

/**
 * Extracts every foreign key from schema.sql: column-level `REFERENCES`,
 * table-level `FOREIGN KEY (...) REFERENCES ...`, and the `ALTER TABLE ... ADD
 * CONSTRAINT ... FOREIGN KEY` statements the schema uses for references it
 * cannot declare inline (forward references to tables defined further down).
 */
export function parseForeignKeys(sql: string): ForeignKey[] {
  // Strip line comments first -- several columns document their FK in a comment
  // ("FK added after categories table"), which would otherwise match.
  const clean = withoutLineComments(sql);

  const foreignKeys: ForeignKey[] = [];

  const tableBlocks = clean.matchAll(
    /CREATE TABLE(?: IF NOT EXISTS)?\s+(\w+)\s*\(([\s\S]*?)\n\);/g,
  );
  for (const [, table, body] of tableBlocks) {
    for (const match of body.matchAll(
      /^\s*(\w+)\s+[A-Za-z0-9_() ,]*?REFERENCES\s+(\w+)\s*\((\w+)\)/gm,
    )) {
      foreignKeys.push({
        table,
        column: match[1],
        referencedTable: match[2],
        referencedColumn: match[3],
      });
    }
    for (const match of body.matchAll(
      /FOREIGN KEY\s*\(([^)]+)\)\s*REFERENCES\s+(\w+)\s*\(([^)]+)\)/g,
    )) {
      const columns = match[1].split(",").map((value) => value.trim());
      const targets = match[3].split(",").map((value) => value.trim());
      if (columns.length !== targets.length)
        throw new Error("Mismatched FK column lists");
      for (const [index, column] of columns.entries()) {
        foreignKeys.push({
          table,
          column,
          referencedTable: match[2],
          referencedColumn: targets[index],
        });
      }
    }
  }

  for (const match of clean.matchAll(
    /ALTER TABLE\s+(?:IF EXISTS\s+)?(\w+)\s+ADD CONSTRAINT\s+\w+\s+FOREIGN KEY\s*\(([^)]+)\)\s*REFERENCES\s+(\w+)\s*\(([^)]+)\)/g,
  )) {
    const columns = match[2].split(",").map((value) => value.trim());
    const targets = match[4].split(",").map((value) => value.trim());
    if (columns.length !== targets.length)
      throw new Error("Mismatched FK column lists");
    for (const [index, column] of columns.entries()) {
      foreignKeys.push({
        table: match[1],
        column,
        referencedTable: match[3],
        referencedColumn: targets[index],
      });
    }
  }

  return foreignKeys;
}

/** One table's column definitions: name and declared type, in schema order. */
export function parseTableColumns(
  sql: string,
  table: string,
): { name: string; type: string }[] | null {
  const block = new RegExp(
    `CREATE TABLE(?: IF NOT EXISTS)?\\s+${table}\\s*\\(([\\s\\S]*?)\\n\\);`,
  ).exec(withoutLineComments(sql));
  if (!block) return null;
  const columns: { name: string; type: string }[] = [];
  for (const match of block[1].matchAll(/^\s*(\w+)\s+([A-Za-z]+(?:\[\])?)/gm)) {
    const name = match[1];
    if (/^(CONSTRAINT|PRIMARY|UNIQUE|CHECK|FOREIGN|EXCLUDE)$/i.test(name)) {
      continue;
    }
    columns.push({ name, type: match[2].toUpperCase() });
  }
  return columns;
}
