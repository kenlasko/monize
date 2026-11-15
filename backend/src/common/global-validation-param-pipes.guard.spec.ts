import { ArgumentMetadata, PipeTransform } from "@nestjs/common";
import { readdirSync, readFileSync, statSync } from "fs";
import { join, relative } from "path";
import * as ts from "typescript";

import { ParseBondQuantityPipe } from "../bonds/bond-query.pipes";
import { createGlobalValidationPipe } from "./pipes/global-validation.pipe";

/**
 * A pipe on a `@Query()` or `@Param()` parameter runs after the global
 * `ValidationPipe` (`createGlobalValidationPipe`), whose `transform: true`
 * converts a parameter declared `number` to `+value` and one declared
 * `boolean` to `value === "true"` first. A pipe on such a parameter therefore
 * never sees the request's text: one that accepts only a string refuses every
 * request (issue 2221, where `ParseBondQuantityPipe` answered 400 for every
 * quantity). `CONVERTED_VALUE_PIPES` are the Nest pipes that accept the
 * converted value; any other pipe is registered here with a value a request
 * sends, and the guard runs that value through both pipes in order.
 * `@UsePipes` is out of scope: no controller applies a pipe that way.
 */

const SRC_ROOT = join(__dirname, "..");

/** Nest pipes that accept a number or boolean the global pipe converted. */
const CONVERTED_VALUE_PIPES: ReadonlySet<string> = new Set([
  "DefaultValuePipe",
  "ParseBoolPipe",
  "ParseFloatPipe",
  "ParseIntPipe",
]);

interface Registered {
  readonly pipe: PipeTransform;
  /** A query text a valid request sends. */
  readonly raw: string;
  /** What the handler receives for it. */
  readonly expected: unknown;
}

/** Every other pipe on a `number` or `boolean` parameter, with a valid request value. */
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
  /** The query or route key, the `data` the global pipe is given. */
  readonly key: string;
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

/** The class a pipe argument names: `X`, `ns.X`, `new X(...)`, `new ns.X(...)`, or neither. */
function pipeName(arg: ts.Expression): string | null {
  const target = ts.isNewExpression(arg) ? arg.expression : arg;
  if (ts.isIdentifier(target)) return target.text;
  if (ts.isPropertyAccessExpression(target)) return target.name.text;
  return null;
}

/**
 * The primitive TypeScript emits as the parameter's `design:paramtypes` entry,
 * where it is `Number` or `Boolean`: the keyword, alone or in a union with
 * `undefined` or `null` (`x?: number`, `x: number | undefined`).
 */
function primitiveOf(type: ts.TypeNode): "number" | "boolean" | null {
  const kinds = ts.isUnionTypeNode(type)
    ? type.types.filter(
        (t) =>
          t.kind !== ts.SyntaxKind.UndefinedKeyword &&
          !(
            ts.isLiteralTypeNode(t) &&
            t.literal.kind === ts.SyntaxKind.NullKeyword
          ),
      )
    : [type];
  if (kinds.length !== 1) return null;
  if (kinds[0].kind === ts.SyntaxKind.NumberKeyword) return "number";
  if (kinds[0].kind === ts.SyntaxKind.BooleanKeyword) return "boolean";
  return null;
}

/**
 * Every pipe outside `CONVERTED_VALUE_PIPES` on a `@Query("key", ...)` or
 * `@Param("key", ...)` parameter declared `number` or `boolean`.
 */
export function numericParamPipes(file: string, source: string): Usage[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const out: Usage[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isParameter(node) && node.type) {
      const type = primitiveOf(node.type);
      for (const decorator of ts.getDecorators(node) ?? []) {
        const call = decorator.expression;
        if (
          type === null ||
          !ts.isCallExpression(call) ||
          !ts.isIdentifier(call.expression) ||
          (call.expression.text !== "Query" &&
            call.expression.text !== "Param") ||
          call.arguments.length === 0 ||
          !ts.isStringLiteralLike(call.arguments[0])
        ) {
          continue;
        }
        const key = call.arguments[0].text;
        for (const arg of call.arguments.slice(1)) {
          const pipe = pipeName(arg);
          if (pipe === null || CONVERTED_VALUE_PIPES.has(pipe)) continue;
          out.push({
            file,
            line: sf.getLineAndCharacterOfPosition(arg.getStart()).line + 1,
            decorator: call.expression.text,
            key,
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
          `src/${u.file}:${u.line} ${u.pipe} on ${u.key}: ${u.type} receives the global ValidationPipe's ${u.type === "number" ? "+value" : 'value === "true"'}, not the query text; accept that value and register the pipe in REGISTERED, or declare the parameter string`,
      );
    expect(unregistered).toEqual([]);
  });

  it("names no pipe that is no longer on such a parameter", () => {
    const used = new Set(usages.map((u) => u.pipe));
    expect(Object.keys(REGISTERED).filter((p) => !used.has(p))).toEqual([]);
  });

  it("accepts what the global ValidationPipe hands it, for each one", async () => {
    const global = createGlobalValidationPipe();
    const refused: string[] = [];
    for (const usage of usages.filter((u) => u.pipe in REGISTERED)) {
      const { pipe, raw, expected } = REGISTERED[usage.pipe];
      const metadata: ArgumentMetadata = {
        type: usage.decorator === "Query" ? "query" : "param",
        metatype: usage.type === "number" ? Number : Boolean,
        data: usage.key,
      };
      try {
        const received = await pipe.transform(
          await global.transform(raw, metadata),
          metadata,
        );
        if (received !== expected) {
          refused.push(
            `src/${usage.file}:${usage.line} ${usage.pipe} gave ${String(received)}`,
          );
        }
      } catch (error) {
        refused.push(
          `src/${usage.file}:${usage.line} ${usage.pipe} refused ${JSON.stringify(raw)}: ${(error as Error).message}`,
        );
      }
    }
    expect(refused).toEqual([]);
  });

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
          key: "quantity",
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
        "a nullable union",
        '@Query("n", new ParseNPipe()) n: number | undefined',
      ],
      ["a namespaced pipe", '@Query("n", new pipes.ParseNPipe()) n: number'],
      [
        "a Nest pipe that refuses a number",
        '@Param("id", ParseUUIDPipe) id: number',
      ],
    ])("finds %s", (_label, param) => {
      expect(numericParamPipes("a.ts", controller(param))).toHaveLength(1);
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
      [
        "a union of two primitives",
        '@Query("q", new ParseQPipe()) q: number | string',
      ],
    ])("ignores %s", (_label, param) => {
      expect(numericParamPipes("a.ts", controller(param))).toEqual([]);
    });
  });
});
