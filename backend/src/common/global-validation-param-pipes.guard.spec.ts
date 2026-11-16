import {
  Controller,
  DefaultValuePipe,
  Get,
  Param,
  ParseBoolPipe,
  ParseFloatPipe,
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
 * The global `ValidationPipe` (`createGlobalValidationPipe`) hands a `@Query()`
 * or `@Param()` parameter TypeScript emits as `Number` or `Boolean` the
 * request's own value (an empty one as absent), not `+value` or
 * `value === "true"` as Nest's would: those conversions read `?limit=0x10` as
 * 16, `?limit=` as 0 and `?includeInactive=yes` as false before any pipe could
 * refuse them (issues 2221, 2225). Such a parameter therefore converts its own
 * text, with the Nest pipe written for it as its last pipe: `ParseIntPipe` or
 * `ParseFloatPipe` on a `Number`, `ParseBoolPipe` on a `Boolean`, optionally
 * after a `DefaultValuePipe`. Without one the handler would receive a string;
 * a pipe of ours there would take the text a `number` declaration promises is
 * not text, so a parameter a pipe of ours checks is declared `string`, as
 * `ParseBondQuantityPipe`'s is.
 *
 * The converter is last so that the handler receives what it converted; a
 * bound or a check of ours belongs in the handler or on a `string` parameter.
 *
 * The guard reads what TypeScript actually emitted (`design:paramtypes`), not
 * the annotation as written: `x?: number` and a local `type Q = number` emit
 * `Number`, while `x: number | undefined` emits `Object` and is passed through
 * untouched. An imported numeric alias emits `Object` under the isolated-module
 * transpile Jest runs but `Number` under `nest build`, so the guard cannot see
 * it: declare `number` or `boolean` itself.
 */

const SRC_ROOT = join(__dirname, "..");

type PipeClass = abstract new (...args: never[]) => unknown;

/** The Nest pipes that convert the text of each emitted type, matched by identity. */
const CONVERTERS: ReadonlyMap<unknown, readonly PipeClass[]> = new Map<
  unknown,
  readonly PipeClass[]
>([
  [Number, [ParseIntPipe, ParseFloatPipe]],
  [Boolean, [ParseBoolPipe]],
]);

function isPipeOf(pipe: unknown, nest: PipeClass): boolean {
  return pipe === nest || pipe instanceof nest;
}

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

/** Own and inherited method names, so a handler on a base class is scanned. */
function methodNames(prototype: object): string[] {
  const names = new Set<string>();
  for (
    let proto: object | null = prototype;
    proto !== null && proto !== Object.prototype;
    proto = Object.getPrototypeOf(proto) as object | null
  ) {
    for (const name of Object.getOwnPropertyNames(proto)) {
      if (name !== "constructor") names.add(name);
    }
  }
  return [...names];
}

/**
 * Every named `@Query()` or `@Param()` argument of `controller` whose emitted
 * type is `Number` or `Boolean` and whose pipes are not a converter of that
 * type, last, after nothing but a `DefaultValuePipe`, as
 * `Class.method(@Query("key") Type) pipes`. Pipes applied with `@UsePipes` are
 * out of scope: no controller applies one that way.
 */
function unconvertedParamOffenders(controller: ControllerClass): string[] {
  const offenders: string[] = [];
  for (const method of methodNames(controller.prototype)) {
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
      const converters = CONVERTERS.get(type);
      if (
        decorator === undefined ||
        typeof arg.data !== "string" ||
        converters === undefined
      ) {
        continue;
      }
      const last = arg.pipes[arg.pipes.length - 1];
      const converted =
        converters.some((nest) => isPipeOf(last, nest)) &&
        arg.pipes
          .slice(0, -1)
          .every((pipe) => isPipeOf(pipe, DefaultValuePipe));
      if (converted) continue;
      offenders.push(
        `${controller.name}.${method}(@${decorator}("${arg.data}") ${(type as { name: string }).name}) [${arg.pipes.map(pipeName).join(", ")}]`,
      );
    }
  }
  return offenders;
}

describe("a number- or boolean-typed query or route parameter", () => {
  it("converts its own text with the Nest pipe written for its type", () => {
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
        for (const offender of unconvertedParamOffenders(
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
          `${o} receives the request's text, not a converted value: end its pipes with ParseIntPipe or ParseFloatPipe (number) or ParseBoolPipe (boolean), after at most a DefaultValuePipe, or declare it string for a pipe of ours, as ParseBondQuantityPipe's is (docs/backend/entities-and-dtos.md)`,
      ),
    ).toEqual([]);
  }, 120_000);

  describe("the scan", () => {
    // A local class named like Nest's, which the scan must not admit.
    const LookalikePipe = {
      ParseIntPipe: class {
        transform(value: unknown): unknown {
          return value;
        }
      },
    }.ParseIntPipe;

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

      @Get("g")
      lookalike(@Query("days", LookalikePipe) _d: number): void {}

      @Get("f")
      untouchedUnion(
        @Query("quantity", new ParseBondQuantityPipe()) _q: number | undefined,
      ): void {}

      @Get("h")
      bareNumber(@Query("days") _d?: number): void {}

      @Get("i")
      wrongKind(@Query("on", ParseIntPipe) _on: boolean): void {}

      @Get("j")
      defaultAfter(
        @Query("days", ParseIntPipe, new DefaultValuePipe(3)) _d: number,
      ): void {}

      @Get("k")
      nestBoolean(
        @Query("on", new ParseBoolPipe({ optional: true })) _on?: boolean,
      ): void {}

      @Get("l")
      nestFloat(
        @Query("t", new DefaultValuePipe(0.5), ParseFloatPipe) _t: number,
      ): void {}

      @Get("m")
      oursBefore(
        @Query("days", new ParseBondQuantityPipe(), ParseIntPipe) _d: number,
      ): void {}
    }

    const offenders = [
      'numberQuery(@Query("quantity") Number) [ParseBondQuantityPipe]',
      'booleanParam(@Param("on") Boolean) [ParseBondQuantityPipe]',
      'uuidOnNumber(@Param("id") Number) [ParseUUIDPipe]',
      'lookalike(@Query("days") Number) [ParseIntPipe]',
      'bareNumber(@Query("days") Number) []',
      'wrongKind(@Query("on") Boolean) [ParseIntPipe]',
      'defaultAfter(@Query("days") Number) [ParseIntPipe, DefaultValuePipe]',
      'oursBefore(@Query("days") Number) [ParseBondQuantityPipe, ParseIntPipe]',
    ];

    it("names every Number or Boolean parameter not ending in its own type's Nest converter", () => {
      expect(unconvertedParamOffenders(Probe)).toEqual(
        offenders.map((o) => `Probe.${o}`),
      );
    });

    it("scans a handler the controller inherits", () => {
      @Controller("child")
      class Child extends Probe {}
      expect(unconvertedParamOffenders(Child)).toEqual(
        offenders.map((o) => `Child.${o}`),
      );
    });
  });
});
