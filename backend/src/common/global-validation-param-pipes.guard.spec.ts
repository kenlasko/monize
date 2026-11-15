import {
  Controller,
  DefaultValuePipe,
  Get,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Query,
} from "@nestjs/common";
import { ROUTE_ARGS_METADATA } from "@nestjs/common/constants";
import { RouteParamtypes } from "@nestjs/common/enums/route-paramtypes.enum";
import { readdirSync, statSync } from "fs";
import { join, relative } from "path";

import { ParseBondQuantityPipe } from "../bonds/bond-query.pipes";

/**
 * A pipe on a `@Query()` or `@Param()` parameter runs after the global
 * `ValidationPipe` (`createGlobalValidationPipe`), whose `transform: true`
 * converts a parameter TypeScript emits as `Number` to `+value` and one emitted
 * as `Boolean` to `value === "true"` first. A pipe on such a parameter never
 * sees the request's text: `ParseBondQuantityPipe` accepted only text on a
 * `number` parameter and refused every request (issue 2221), and a pipe that
 * took the number instead could no longer tell `0x10` from `16`.
 *
 * The guard reads what TypeScript actually emitted (`design:paramtypes`), not
 * the annotation as written: `x?: number` and `type Q = number` emit `Number`,
 * while `x: number | undefined` emits `Object` and is passed through untouched.
 * Only the Nest pipes written for an already-converted value may sit on a
 * `Number` or `Boolean` parameter.
 */

const SRC_ROOT = join(__dirname, "..");

/** Nest pipes that accept the number or boolean the global pipe converted. */
const CONVERTED_VALUE_PIPES: ReadonlySet<string> = new Set([
  "DefaultValuePipe",
  "ParseBoolPipe",
  "ParseFloatPipe",
  "ParseIntPipe",
]);

const SCANNED: ReadonlyMap<number, string> = new Map([
  [RouteParamtypes.QUERY, "Query"],
  [RouteParamtypes.PARAM, "Param"],
]);

interface RouteArg {
  readonly index: number;
  readonly data?: unknown;
  readonly pipes: readonly unknown[];
}

// A plain walk rather than `git ls-files`, so a controller not yet staged is
// scanned too.
function controllerFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "node_modules" || entry === "dist") continue;
      out.push(...controllerFiles(full));
    } else if (entry.endsWith(".controller.ts")) {
      out.push(full);
    }
  }
  return out;
}

function pipeName(pipe: unknown): string {
  return typeof pipe === "function"
    ? pipe.name
    : (pipe as object).constructor.name;
}

type ControllerClass = { readonly name: string; readonly prototype: object };

/**
 * Every pipe outside `CONVERTED_VALUE_PIPES` on a named `@Query()` or
 * `@Param()` argument of `controller` whose emitted type is `Number` or
 * `Boolean`, as `Class.method(@Query("key") Type) Pipe`.
 */
function convertedValuePipeOffenders(controller: ControllerClass): string[] {
  const offenders: string[] = [];
  for (const method of Object.getOwnPropertyNames(controller.prototype)) {
    if (method === "constructor") continue;
    const args = Reflect.getMetadata(
      ROUTE_ARGS_METADATA,
      controller,
      method,
    ) as Record<string, RouteArg> | undefined;
    if (!args) continue;
    const types = (Reflect.getMetadata(
      "design:paramtypes",
      controller.prototype,
      method,
    ) ?? []) as unknown[];
    for (const [key, arg] of Object.entries(args)) {
      const decorator = SCANNED.get(Number(key.split(":")[0]));
      const type = types[arg.index];
      if (
        decorator === undefined ||
        typeof arg.data !== "string" ||
        (type !== Number && type !== Boolean)
      ) {
        continue;
      }
      for (const pipe of arg.pipes) {
        const name = pipeName(pipe);
        if (CONVERTED_VALUE_PIPES.has(name)) continue;
        offenders.push(
          `${controller.name}.${method}(@${decorator}("${arg.data}") ${(type as { name: string }).name}) ${name}`,
        );
      }
    }
  }
  return offenders;
}

describe("a pipe on a number- or boolean-typed query or route parameter", () => {
  it("is one written for the global ValidationPipe's converted value", () => {
    const offenders: string[] = [];
    let controllers = 0;
    for (const file of controllerFiles(SRC_ROOT)) {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const exported = Object.values(require(file) as object) as unknown[];
      for (const value of exported) {
        if (
          typeof value !== "function" ||
          Reflect.getMetadata("path", value) === undefined
        ) {
          continue;
        }
        controllers += 1;
        for (const offender of convertedValuePipeOffenders(
          value as ControllerClass,
        )) {
          offenders.push(`src/${relative(SRC_ROOT, file)}: ${offender}`);
        }
      }
    }
    expect(controllers).toBeGreaterThan(50);
    expect(
      offenders.map(
        (o) =>
          `${o} receives +value or value === "true", not the query text: declare the parameter string so the pipe checks the text (as ParseBondQuantityPipe does), or use ParseIntPipe / ParseBoolPipe`,
      ),
    ).toEqual([]);
  }, 120_000);

  describe("the scan", () => {
    @Controller("probe")
    class Probe {
      @Get("a")
      numberQuery(
        @Query("quantity", new ParseBondQuantityPipe()) _q: number,
      ): void {}

      @Get("b/:on")
      booleanParam(@Param("on", ParseBondQuantityPipe) _on?: boolean): void {}

      @Get("c/:id")
      uuidOnNumber(@Param("id", ParseUUIDPipe) _id: number): void {}

      @Get("d")
      textQuery(
        @Query("quantity", new ParseBondQuantityPipe()) _q: string,
      ): void {}

      @Get("e")
      nestNumber(
        @Query("days", new DefaultValuePipe(30), ParseIntPipe) _d: number,
      ): void {}

      @Get("f")
      untouchedUnion(
        @Query("quantity", new ParseBondQuantityPipe()) _q: number | undefined,
      ): void {}
    }

    it("names every pipe of another kind on a Number or Boolean parameter, constructed or not", () => {
      expect(convertedValuePipeOffenders(Probe)).toEqual([
        'Probe.numberQuery(@Query("quantity") Number) ParseBondQuantityPipe',
        'Probe.booleanParam(@Param("on") Boolean) ParseBondQuantityPipe',
        'Probe.uuidOnNumber(@Param("id") Number) ParseUUIDPipe',
      ]);
    });
  });
});
