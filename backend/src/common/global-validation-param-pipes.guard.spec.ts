import * as nestCommon from "@nestjs/common";
import { ValidationPipe } from "@nestjs/common";
import { readdirSync, readFileSync, statSync } from "fs";
import { join, relative } from "path";
import * as ts from "typescript";

import { ParseBondQuantityPipe } from "../bonds/bond-query.pipes";

/**
 * A pipe on a `@Query()` or `@Param()` parameter runs after the global
 * `ValidationPipe` of `main.ts`, whose `transform: true` converts a parameter
 * declared `number` to `+value` and one declared `boolean` to
 * `value === "true"` first. A pipe of this repository on such a parameter
 * therefore never sees the request's text: one that accepts only a string
 * refuses every request (issue 2221, where `ParseBondQuantityPipe` answered
 * 400 for every quantity). Nest's own `ParseIntPipe` and `ParseBoolPipe`
 * accept the converted value; a pipe of ours is registered here with a value a
 * request sends, and the guard runs that value through both pipes in order.
 */

const SRC_ROOT = join(__dirname, "..");

interface Registered {
  readonly pipe: nestCommon.PipeTransform;
  /** A query text a valid request sends. */
  readonly raw: string;
  /** What the handler receives for it. */
  readonly expected: unknown;
}

/** Every pipe of ours on a `number` or `boolean` parameter, with a valid request value. */
const REGISTERED: Readonly<Record<string, Registered>> = {
  ParseBondQuantityPipe: {
    pipe: new ParseBondQuantityPipe(),
    raw: "3910",
    expected: 3910,
  },
};

interface Usage {
  readonly file: string;
  readonly line: number;
  readonly decorator: "Query" | "Param";
  readonly name: string;
  readonly type: "number" | "boolean";
  readonly pipe: string;
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "node_modules" || entry === "dist") continue;
      out.push(...sourceFiles(full));
      continue;
    }
    if (!entry.endsWith(".ts") || entry.endsWith(".spec.ts")) continue;
    out.push(full);
  }
  return out;
}

/** The class a pipe argument names: `X`, `new X(...)`, or neither. */
function pipeName(arg: ts.Expression): string | null {
  if (ts.isIdentifier(arg)) return arg.text;
  if (ts.isNewExpression(arg) && ts.isIdentifier(arg.expression)) {
    return arg.expression.text;
  }
  return null;
}

/**
 * Every pipe of ours (a class `@nestjs/common` does not export) on a
 * `@Query()` or `@Param()` parameter declared `number` or `boolean`.
 */
export function numericParamPipes(file: string, source: string): Usage[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const out: Usage[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isParameter(node) && node.type) {
      const type =
        node.type.kind === ts.SyntaxKind.NumberKeyword
          ? "number"
          : node.type.kind === ts.SyntaxKind.BooleanKeyword
            ? "boolean"
            : null;
      for (const decorator of ts.getDecorators(node) ?? []) {
        const call = decorator.expression;
        if (
          type === null ||
          !ts.isCallExpression(call) ||
          !ts.isIdentifier(call.expression) ||
          (call.expression.text !== "Query" && call.expression.text !== "Param")
        ) {
          continue;
        }
        for (const arg of call.arguments) {
          const pipe = pipeName(arg);
          if (pipe === null || pipe in nestCommon) continue;
          out.push({
            file,
            line: sf.getLineAndCharacterOfPosition(arg.getStart()).line + 1,
            decorator: call.expression.text,
            name: node.name.getText(sf),
            type,
            pipe,
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

describe("a pipe of ours on a number- or boolean-typed parameter", () => {
  const usages = sourceFiles(SRC_ROOT).flatMap((full) =>
    numericParamPipes(relative(SRC_ROOT, full), readFileSync(full, "utf8")),
  );

  it("is registered with a value a request sends", () => {
    const unregistered = usages
      .filter((u) => !(u.pipe in REGISTERED))
      .map(
        (u) =>
          `src/${u.file}:${u.line} ${u.pipe} on ${u.name}: ${u.type} receives the global ValidationPipe's ${u.type === "number" ? "+value" : 'value === "true"'}, not the query text; accept that value and register the pipe in REGISTERED, or declare the parameter string`,
      );
    expect(unregistered).toEqual([]);
  });

  it("names no pipe that is no longer on such a parameter", () => {
    const used = new Set(usages.map((u) => u.pipe));
    expect(Object.keys(REGISTERED).filter((p) => !used.has(p))).toEqual([]);
  });

  it.each(usages.map((u) => [`${u.file}:${u.line} ${u.pipe}`, u] as const))(
    "%s accepts what the global ValidationPipe hands it",
    async (_label, usage) => {
      const { pipe, raw, expected } = REGISTERED[usage.pipe];
      const global = new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      });
      const metadata: nestCommon.ArgumentMetadata = {
        type: usage.decorator === "Query" ? "query" : "param",
        metatype: usage.type === "number" ? Number : Boolean,
        data: usage.name,
      };
      const converted = await global.transform(raw, metadata);
      expect(pipe.transform(converted, metadata)).toEqual(expected);
    },
  );

  describe("the scanner", () => {
    const controller = (param: string) =>
      `class C {\n  m(\n    ${param},\n  ) {}\n}\n`;

    it("finds a pipe of ours on a number or a boolean, whether constructed or not", () => {
      expect(
        numericParamPipes(
          "a.ts",
          controller(
            '@Query("quantity", new ParseBondQuantityPipe()) q: number',
          ),
        ),
      ).toEqual([
        expect.objectContaining({
          decorator: "Query",
          name: "q",
          type: "number",
          pipe: "ParseBondQuantityPipe",
        }),
      ]);
      expect(
        numericParamPipes(
          "a.ts",
          controller('@Param("on", ParseFlagPipe)\n    on?: boolean'),
        ),
      ).toEqual([
        expect.objectContaining({
          decorator: "Param",
          type: "boolean",
          pipe: "ParseFlagPipe",
        }),
      ]);
    });

    it.each([
      [
        "a string parameter",
        '@Query("q", new ParseBondQuantityPipe()) q: string',
      ],
      [
        "Nest's own pipes",
        '@Query("d", new DefaultValuePipe(1), ParseIntPipe) d: number',
      ],
      ["a body", "@Body(new ParseBondQuantityPipe()) q: number"],
      ["an undecorated parameter", "q: number"],
    ])("ignores %s", (_label, param) => {
      expect(numericParamPipes("a.ts", controller(param))).toEqual([]);
    });
  });
});
