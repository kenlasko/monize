import * as fs from "fs";
import * as path from "path";
import * as ts from "typescript";

/**
 * Guards the whole backend against enum-backed varchar columns that are
 * narrower than a value the code is allowed to store in them.
 *
 * The bug class this catches: loan_scenarios' mode columns were VARCHAR(16)
 * while the property type admitted 'LOWER_INSTALLMENT' (17 chars), so saving
 * a lower-installment scenario failed only against a real database with
 * 22001 "value too long for type character varying(16)". Unit tests mock the
 * repository and never see column widths, so the mismatch is invisible to
 * them by construction.
 *
 * Method: compile every *.entity.ts under src/ and, for each @Column of a
 * varchar type with a declared length whose TypeScript property type resolves
 * to a union of string literals (an enum-like column), assert that
 *   1. the longest admissible literal fits the entity's declared length, and
 *   2. database/schema.sql declares the same table.column at least that wide
 *      (the entity drives test databases via synchronize, but production
 *      schemas come from schema.sql/migrations -- both sides must fit).
 */
describe("entity varchar capacities (enum-backed columns)", () => {
  interface EnumColumn {
    file: string;
    className: string;
    property: string;
    tableName: string | null;
    columnName: string;
    declaredLength: number;
    literals: string[];
  }

  const SRC_DIR = __dirname;
  const SCHEMA_SQL_PATH = path.resolve(__dirname, "../../database/schema.sql");

  function findEntityFiles(dir: string): string[] {
    const out: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        out.push(...findEntityFiles(full));
      } else if (entry.name.endsWith(".entity.ts")) {
        out.push(full);
      }
    }
    return out;
  }

  /** String value of an object-literal property, for literal initializers. */
  function literalString(expr: ts.Expression): string | null {
    return ts.isStringLiteralLike(expr) ? expr.text : null;
  }

  function literalNumber(expr: ts.Expression): number | null {
    return ts.isNumericLiteral(expr) ? Number(expr.text) : null;
  }

  function objectProp(
    obj: ts.ObjectLiteralExpression,
    name: string,
  ): ts.Expression | null {
    for (const prop of obj.properties) {
      if (
        ts.isPropertyAssignment(prop) &&
        ts.isIdentifier(prop.name) &&
        prop.name.text === name
      ) {
        return prop.initializer;
      }
    }
    return null;
  }

  function decoratorCall(
    node: ts.HasDecorators,
    decoratorName: string,
  ): ts.CallExpression | null {
    for (const decorator of ts.getDecorators(node) ?? []) {
      if (
        ts.isCallExpression(decorator.expression) &&
        ts.isIdentifier(decorator.expression.expression) &&
        decorator.expression.expression.text === decoratorName
      ) {
        return decorator.expression;
      }
    }
    return null;
  }

  /** All string literals of a union type; null when any part is not one. */
  function unionStringLiterals(type: ts.Type): string[] | null {
    const parts = type.isUnion() ? type.types : [type];
    const literals: string[] = [];
    for (const part of parts) {
      if (part.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined)) continue;
      if (part.isStringLiteral()) {
        literals.push(part.value);
      } else {
        return null;
      }
    }
    return literals.length > 0 ? literals : null;
  }

  function collectEnumColumns(): EnumColumn[] {
    const files = findEntityFiles(SRC_DIR);
    expect(files.length).toBeGreaterThan(0);

    const program = ts.createProgram(files, {
      target: ts.ScriptTarget.ES2021,
      module: ts.ModuleKind.CommonJS,
      experimentalDecorators: true,
      strictNullChecks: true,
      skipLibCheck: true,
      baseUrl: SRC_DIR,
      paths: { "@/*": ["*"] },
    });
    const checker = program.getTypeChecker();
    const columns: EnumColumn[] = [];

    for (const file of files) {
      const source = program.getSourceFile(file);
      if (!source) continue;
      ts.forEachChild(source, (node) => {
        if (!ts.isClassDeclaration(node) || !node.name) return;

        const entityCall = decoratorCall(node, "Entity");
        const tableArg = entityCall?.arguments[0];
        const tableName =
          tableArg && ts.isStringLiteralLike(tableArg) ? tableArg.text : null;

        for (const member of node.members) {
          if (!ts.isPropertyDeclaration(member) || !member.type) continue;
          const columnCall = decoratorCall(member, "Column");
          const options = columnCall?.arguments[0];
          if (!options || !ts.isObjectLiteralExpression(options)) continue;

          const columnType = objectProp(options, "type");
          const isVarchar =
            columnType !== null &&
            /^(varchar|character varying)$/i.test(
              literalString(columnType) ?? "",
            );
          const lengthExpr = objectProp(options, "length");
          const declaredLength = lengthExpr && literalNumber(lengthExpr);
          if (!isVarchar || !declaredLength) continue;

          const literals = unionStringLiterals(
            checker.getTypeFromTypeNode(member.type),
          );
          if (!literals) continue; // free-form string column, not enum-like

          const nameExpr = objectProp(options, "name");
          const columnName =
            (nameExpr && literalString(nameExpr)) ??
            (ts.isIdentifier(member.name) ? member.name.text : "");

          columns.push({
            file: path.relative(SRC_DIR, file),
            className: node.name!.text,
            property: ts.isIdentifier(member.name)
              ? member.name.text
              : columnName,
            tableName,
            columnName,
            declaredLength,
            literals,
          });
        }
      });
    }
    return columns;
  }

  /** VARCHAR width of table.column in schema.sql, or null when absent. */
  function schemaWidth(tableName: string, columnName: string): number | null {
    const schema = fs.readFileSync(SCHEMA_SQL_PATH, "utf8");
    const tableMatch = new RegExp(
      `CREATE TABLE (?:IF NOT EXISTS )?${tableName}\\s*\\(([\\s\\S]*?)\\n\\);`,
      "i",
    ).exec(schema);
    if (!tableMatch) return null;
    const columnMatch = new RegExp(
      `(?:^|\\n)\\s*${columnName}\\s+(?:VARCHAR|CHARACTER VARYING)\\s*\\((\\d+)\\)`,
      "i",
    ).exec(tableMatch[1]);
    return columnMatch ? Number(columnMatch[1]) : null;
  }

  const enumColumns = collectEnumColumns();

  it("finds the known enum-backed columns (sanity check)", () => {
    // If the sweep silently found nothing, every other assertion would
    // vacuously pass; pin a couple of known columns to keep it honest.
    const names = enumColumns.map((c) => c.columnName);
    expect(names).toContain("recurring_extra_mode");
    expect(names).toContain("recurring_extra_frequency");
  });

  it("every enum-backed varchar column fits its longest allowed value", () => {
    const tooNarrow = enumColumns
      .map((c) => {
        const widest = [...c.literals].sort((a, b) => b.length - a.length)[0];
        return { ...c, widest };
      })
      .filter((c) => c.widest.length > c.declaredLength)
      .map(
        (c) =>
          `${c.className}.${c.property} (${c.file}): column ${c.columnName} is ` +
          `varchar(${c.declaredLength}) but '${c.widest}' is ${c.widest.length} chars`,
      );
    expect(tooNarrow).toEqual([]);
  });

  it("schema.sql declares every enum-backed column at least as wide", () => {
    const mismatches = enumColumns
      .filter((c) => c.tableName !== null)
      .map((c) => ({ ...c, schema: schemaWidth(c.tableName!, c.columnName) }))
      .filter((c) => {
        if (c.schema === null) return false; // column added by an unmerged path
        const widest = Math.max(...c.literals.map((l) => l.length));
        return c.schema < widest || c.schema < c.declaredLength;
      })
      .map(
        (c) =>
          `${c.tableName}.${c.columnName}: schema.sql has varchar(${c.schema}), ` +
          `entity declares ${c.declaredLength}, longest value is ` +
          `${Math.max(...c.literals.map((l) => l.length))} chars`,
      );
    expect(mismatches).toEqual([]);
  });
});
