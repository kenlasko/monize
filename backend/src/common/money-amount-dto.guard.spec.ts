import { readFileSync } from "node:fs";
import { join } from "node:path";

import { globSync } from "glob";
import * as ts from "typescript";

/**
 * A money amount is validated with `@IsMoneyAmount(...)`
 * (`validators/is-money-amount.validator.ts`) and a share or coin quantity with
 * `@IsShareQuantity(...)` (`validators/is-share-quantity.validator.ts`), never
 * `@IsNumber({ maxDecimalPlaces: n })`.
 *
 * class-validator's `maxDecimalPlaces` reads the places off
 * `value.toString().split(".")[1].length`. Below 1e-6 JavaScript prints a
 * number in exponent form ("5e-8"), so that read throws a TypeError and the
 * request is a 500 for 0.00000005 BTC, a legitimate amount now that the money
 * columns are `NUMERIC(24,8)`. `@IsMoneyAmount` counts the places through
 * `decimalPlacesOf`, which is exponent-safe. Rates and percentages are not
 * amounts and keep `maxDecimalPlaces` (or `@IsFxRate` for an exchange rate).
 *
 * The scan reads the syntax tree: a property whose name ends in one of the
 * money suffixes and whose decorators name `maxDecimalPlaces`. A comment that
 * mentions the option never trips it.
 */

const SRC = join(__dirname, "..");

/** A field named like this holds an amount, a balance, a price, a fee or a quantity. */
export const MONEY_FIELD_NAME =
  /(?:amount|Amount|balance|Balance|threshold|Threshold|price|Price|commission|quantity|Quantity)$/;

/**
 * Money fields still validated with `maxDecimalPlaces` (`file: field`).
 * Shrink-only (`docs/guard-tests.md`): convert a field and delete its line;
 * never add one.
 */
const BASELINE = new Set<string>([]);

/** Every money-named property in `source` whose decorators use `maxDecimalPlaces`. */
export function moneyFieldsWithMaxDecimalPlaces(
  fileName: string,
  source: string,
): string[] {
  const sf = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.ES2021,
    true,
  );
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyDeclaration(node) && ts.isIdentifier(node.name)) {
      const name = node.name.text;
      const decorators = ts.getDecorators(node) ?? [];
      if (
        MONEY_FIELD_NAME.test(name) &&
        decorators.some((d) => d.getText(sf).includes("maxDecimalPlaces"))
      ) {
        found.push(name);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

function sourceFiles(): string[] {
  return globSync("**/*.ts", {
    cwd: SRC,
    absolute: true,
    ignore: ["**/*.spec.ts", "**/*.d.ts", "**/node_modules/**"],
  });
}

describe("money amounts and quantities are validated with @IsMoneyAmount and @IsShareQuantity", () => {
  it("no amount, balance, threshold, price, commission or quantity field uses maxDecimalPlaces", () => {
    const offenders = sourceFiles()
      .flatMap((file) =>
        moneyFieldsWithMaxDecimalPlaces(file, readFileSync(file, "utf8")).map(
          (field) =>
            `${file.slice(SRC.length + 1).replace(/\\/g, "/")}: ${field}`,
        ),
      )
      .filter((entry) => !BASELINE.has(entry));

    expect(offenders).toEqual([]);
  });

  it("the baseline is empty", () => {
    expect([...BASELINE]).toEqual([]);
  });

  it("the scan recognises the shape it was written for", () => {
    const bad = `class A {
      @IsOptional()
      @IsNumber({ maxDecimalPlaces: 4 })
      @Min(0)
      lowBalanceThreshold?: number;
      @IsNumber({ allowNaN: false, maxDecimalPlaces: 10 })
      closePrice: number;
      @IsNumber({ maxDecimalPlaces: 8 })
      investmentQuantity: number;
    }`;
    expect(moneyFieldsWithMaxDecimalPlaces("a.ts", bad)).toEqual([
      "lowBalanceThreshold",
      "closePrice",
      "investmentQuantity",
    ]);
  });

  it("the scan leaves rates, comments and @IsMoneyAmount alone", () => {
    const fine = `class A {
      // @IsNumber({ maxDecimalPlaces: 4 }) would 500 on 5e-8
      @IsMoneyAmount(4)
      amount: number;
      @IsNumber({ maxDecimalPlaces: 4 })
      interestRate: number;
      @IsNumber({ maxDecimalPlaces: 4 })
      priceAlertPercent: number;
    }`;
    expect(moneyFieldsWithMaxDecimalPlaces("a.ts", fine)).toEqual([]);
  });
});
