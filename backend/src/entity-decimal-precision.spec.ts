import * as fs from "fs";
import * as path from "path";
import * as ts from "typescript";

/**
 * Guards the backend against decimal columns whose entity declaration has
 * drifted from `database/schema.sql`, and against per-unit price columns that
 * are too coarse to hold a sub-cent instrument.
 *
 * The bug class this catches: `investment_transactions.price` and the
 * `security_prices` closes were NUMERIC(20,6), and `holdings.average_cost`
 * inherited that scale from them. Six decimal places cannot represent a crypto
 * or penny holding -- 0.0000085 stores as 0.000009 -- and because cost basis is
 * quantity x price, the resulting error is a percentage of the position rather
 * than a rounding artefact. Nothing failed: the figures were internally
 * consistent and wrong, which is the hardest kind of wrong to notice. Mocked
 * repositories never see a column scale, so unit tests cannot see this at all.
 *
 * Method: compile every *.entity.ts under src/ and, for each @Column of decimal
 * type with a declared precision and scale, assert that
 *   1. schema.sql declares the same table.column with exactly that precision
 *      and scale (entities drive test databases via synchronize, while
 *      production schemas come from schema.sql plus migrations -- a divergence
 *      means one of the two is silently wrong), and
 *   2. any column holding a price *per unit* keeps at least
 *      MIN_UNIT_PRICE_SCALE decimal places.
 *
 * Money totals are deliberately not covered by (2): an amount in a currency is
 * stored at scale 8 (`NUMERIC(24,8)`, the most places a currency may carry, so
 * a coin keeps satoshis) and rounded at its currency's money precision, which
 * is a matter for `moneyDecimalsFor` rather than for the column
 * (`docs/specs/money-precision.md`). Check (1) holds those columns to
 * schema.sql like every other. Only per-unit prices need scale 10, so they are
 * named explicitly below -- a new one has to be added here by hand, which is
 * the point at which someone has to think about it.
 */
describe("entity decimal precision", () => {
  interface DecimalColumn {
    file: string;
    className: string;
    property: string;
    tableName: string | null;
    columnName: string;
    precision: number;
    scale: number;
  }

  const SRC_DIR = __dirname;
  const SCHEMA_SQL_PATH = path.resolve(__dirname, "../../database/schema.sql");

  /**
   * Columns holding a price or cost for one unit of a security, as
   * `table.column`. These must survive a sub-cent quote.
   */
  const UNIT_PRICE_COLUMNS = new Set([
    "investment_transactions.price",
    "holdings.average_cost",
    "security_prices.open_price",
    "security_prices.high_price",
    "security_prices.low_price",
    "security_prices.close_price",
    "security_prices.adjusted_close",
    // The scheduled copies of a per-unit price: each is written straight onto
    // the investment transaction it posts, so a truncation here reappears every
    // time the schedule fires.
    "scheduled_transactions.investment_price",
    "scheduled_transaction_splits.investment_price",
    "scheduled_transaction_overrides.investment_price",
  ]);

  /**
   * Enough places for a sub-cent instrument: at scale 10 a price of
   * 0.00012345678 survives intact, where scale 6 truncated it to 0.000123.
   */
  const MIN_UNIT_PRICE_SCALE = 10;

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

  /** Snake-case fallback for a column with no explicit `name:` option. */
  function snakeCase(value: string): string {
    return value.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
  }

  function collectDecimalColumns(): DecimalColumn[] {
    const files = findEntityFiles(SRC_DIR);
    expect(files.length).toBeGreaterThan(0);
    const columns: DecimalColumn[] = [];

    for (const file of files) {
      const source = ts.createSourceFile(
        file,
        fs.readFileSync(file, "utf8"),
        ts.ScriptTarget.ES2021,
        true,
      );
      ts.forEachChild(source, (node) => {
        if (!ts.isClassDeclaration(node) || !node.name) return;

        const entityCall = decoratorCall(node, "Entity");
        const tableArg = entityCall?.arguments[0];
        const tableName =
          tableArg && ts.isStringLiteralLike(tableArg) ? tableArg.text : null;

        for (const member of node.members) {
          if (!ts.isPropertyDeclaration(member)) continue;
          const columnCall = decoratorCall(member, "Column");
          const options = columnCall?.arguments[0];
          if (!options || !ts.isObjectLiteralExpression(options)) continue;

          const columnType = objectProp(options, "type");
          if (
            !columnType ||
            !/^(decimal|numeric)$/i.test(literalString(columnType) ?? "")
          ) {
            continue;
          }

          const precisionExpr = objectProp(options, "precision");
          const scaleExpr = objectProp(options, "scale");
          const precision = precisionExpr && literalNumber(precisionExpr);
          const scale = scaleExpr && literalNumber(scaleExpr);
          // A decimal column with no declared precision leaves it to the driver;
          // there is nothing to compare, so it is out of scope here.
          if (precision === null || scale === null) continue;

          const property = ts.isIdentifier(member.name)
            ? member.name.text
            : "(computed)";
          const nameExpr = objectProp(options, "name");
          const columnName =
            (nameExpr && literalString(nameExpr)) ?? snakeCase(property);

          columns.push({
            file: path.relative(SRC_DIR, file),
            className: node.name!.text,
            property,
            tableName,
            columnName,
            precision: precision as number,
            scale: scale as number,
          });
        }
      });
    }
    return columns;
  }

  /** `NUMERIC(p, s)` of table.column in schema.sql, or null when absent. */
  function schemaDecimal(
    tableName: string,
    columnName: string,
  ): { precision: number; scale: number } | null {
    const schema = fs.readFileSync(SCHEMA_SQL_PATH, "utf8");
    const tableMatch = new RegExp(
      `CREATE TABLE (?:IF NOT EXISTS )?${tableName}\\s*\\(([\\s\\S]*?)\\n\\);`,
      "i",
    ).exec(schema);
    if (!tableMatch) return null;
    const columnMatch = new RegExp(
      `(?:^|\\n)\\s*${columnName}\\s+(?:NUMERIC|DECIMAL)\\s*\\(\\s*(\\d+)\\s*,\\s*(\\d+)\\s*\\)`,
      "i",
    ).exec(tableMatch[1]);
    return columnMatch
      ? { precision: Number(columnMatch[1]), scale: Number(columnMatch[2]) }
      : null;
  }

  const decimalColumns = collectDecimalColumns();

  it("finds the known decimal columns (sanity check)", () => {
    // Without this, a sweep that silently found nothing would make every
    // assertion below pass vacuously.
    const names = decimalColumns.map(
      (c) => `${c.tableName ?? "?"}.${c.columnName}`,
    );
    expect(names).toContain("holdings.average_cost");
    expect(names).toContain("security_prices.close_price");
    expect(decimalColumns.length).toBeGreaterThan(20);
  });

  it("every unit-price column is named by a real entity column", () => {
    // Keeps UNIT_PRICE_COLUMNS from rotting into a list of names that no longer
    // exist, which would silently stop enforcing anything.
    const present = new Set(
      decimalColumns
        .filter((c) => c.tableName !== null)
        .map((c) => `${c.tableName}.${c.columnName}`),
    );
    const missing = [...UNIT_PRICE_COLUMNS].filter(
      (name) => !present.has(name),
    );
    expect(missing).toEqual([]);
  });

  it("entity precision and scale match schema.sql", () => {
    const mismatches = decimalColumns
      .filter((c) => c.tableName !== null)
      .map((c) => ({ ...c, schema: schemaDecimal(c.tableName!, c.columnName) }))
      .filter((c) => {
        // Absent from schema.sql: the column belongs to a table declared
        // elsewhere, or is not merged yet. Not this test's business.
        if (c.schema === null) return false;
        return c.schema.precision !== c.precision || c.schema.scale !== c.scale;
      })
      .map(
        (c) =>
          `${c.tableName}.${c.columnName} (${c.className}.${c.property}): entity ` +
          `declares NUMERIC(${c.precision},${c.scale}), schema.sql has ` +
          `NUMERIC(${c.schema!.precision},${c.schema!.scale})`,
      );
    expect(mismatches).toEqual([]);
  });

  it("every per-unit price column can hold a sub-cent price", () => {
    const tooCoarse = decimalColumns
      .filter(
        (c) =>
          c.tableName !== null &&
          UNIT_PRICE_COLUMNS.has(`${c.tableName}.${c.columnName}`) &&
          c.scale < MIN_UNIT_PRICE_SCALE,
      )
      .map(
        (c) =>
          `${c.tableName}.${c.columnName} has scale ${c.scale}; a price per unit ` +
          `needs at least ${MIN_UNIT_PRICE_SCALE} so a sub-cent instrument ` +
          `keeps its value`,
      );
    expect(tooCoarse).toEqual([]);
  });
});
