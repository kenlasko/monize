import { readdirSync, readFileSync, statSync } from "fs";
import { builtinModules } from "module";
import { join } from "path";

/**
 * A module `imports` entry must never be able to evaluate to `undefined`.
 *
 * Module files are CommonJS, so a circular `import` between two of them hands
 * the second one a half-filled `exports` object: the
 * `@Module({ imports: [...] })` decorator evaluates with `undefined` in the
 * array, and Nest refuses to build the application with "Nest cannot create the
 * module instance" -- naming a module, not the edge that broke it. Unit specs
 * assemble their own testing modules and never touch `AppModule`, so a new
 * module edge that closes a cycle ships green and fails on container start
 * (issue #1247 added NotificationsModule -> ScheduledTransactionsModule and
 * BudgetsModule -> ScheduledTransactionsModule).
 *
 * `forwardRef(() => X)` is the fix, and the rule is exact:
 *
 * > A **bare** `imports` entry is unsafe **iff the module it names can reach
 * > the declaring module through `import` statements** -- that is, iff the edge
 * > lies on a require cycle.
 *
 * A `forwardRef` edge reads its target during Nest's scan, after every file has
 * finished loading, so it can never see a half-filled `exports`. A bare edge
 * reads it at decoration time, and whether that is too early depends on **which
 * file `require` reached first** -- which is the hole the first version of this
 * spec had. It walked from `AppModule` only, proving one load order clean while
 * the integration suite (whose `RootTestModule` pulls `TransactionsModule` in
 * first) and the container both blew up on `NetWorthModule imports[1] is
 * undefined`. Nine bare edges lay on cycles at that point, seven of them added
 * by issue #1247 and two older ones that had simply never been entered from the
 * wrong side.
 *
 * So this spec checks the rule twice, two different ways:
 *
 * 1. **Statically, over every load order at once.** The import graph decides
 *    reachability, so no order has to be sampled. The scan over-approximates
 *    the require graph (a type-only import TypeScript would elide still counts
 *    as an edge), and that direction is the safe one: it can only ask for a
 *    `forwardRef` that was not strictly needed, never bless a bare edge that
 *    needed one. Failures name the edge.
 * 2. **At runtime, as Nest reads it, from every module file in turn.** Ground
 *    truth for one order per case, and regex-free -- it is what catches a
 *    parser blind spot in (1). Each case starts from a fresh module registry
 *    with one file required first, then walks the whole graph.
 *
 * Neither instantiates a provider or opens a database connection, so this stays
 * a unit test.
 */

/** Every `.ts` under `src/`, tests excluded -- the require graph, not the modules. */
const SPEC_FILE = /\.(spec|test)\.ts$/;

const collectSources = (dir: string, into = new Map<string, string>()) => {
  for (const entry of readdirSync(dir).sort()) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      collectSources(full, into);
      continue;
    }
    if (!entry.endsWith(".ts") || SPEC_FILE.test(entry)) continue;
    into.set(full, readFileSync(full, "utf8"));
  }
  return into;
};

const stripComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

/**
 * Resolve an import specifier against the files we collected rather than the
 * filesystem, so the analysis is a pure function of its input and can be fed a
 * synthetic graph by its own self-test.
 */
const resolveSpecifier = (
  fromFile: string,
  specifier: string,
  known: ReadonlySet<string>,
  srcRoot: string,
): string | null => {
  let base: string;
  if (specifier.startsWith(".")) {
    base = join(fromFile, "..", specifier);
  } else if (specifier.startsWith("@/")) {
    base = join(srcRoot, specifier.slice(2));
  } else {
    return null;
  }
  for (const candidate of [`${base}.ts`, join(base, "index.ts")]) {
    if (known.has(candidate)) return candidate;
  }
  return null;
};

/** Balanced-bracket end of the literal opening at `openIndex`. */
const closingIndex = (text: string, openIndex: number): number => {
  let depth = 0;
  for (let i = openIndex; i < text.length; i++) {
    if ("[({".includes(text[i])) depth++;
    else if ("])}".includes(text[i])) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
};

const importGraph = (
  sources: ReadonlyMap<string, string>,
  srcRoot: string,
): Map<string, Set<string>> => {
  const known = new Set(sources.keys());
  const graph = new Map<string, Set<string>>();
  for (const [file, raw] of sources) {
    const source = stripComments(raw);
    const targets = new Set<string>();
    // `import type ... from` is erased by TypeScript and creates no require
    // edge; every other form does.
    const patterns = [
      /(?:^|\n)\s*import\s+(?!type\s)[\s\S]*?from\s*["']([^"']+)["']/g,
      /(?:^|\n)\s*import\s*["']([^"']+)["']/g,
      /(?:^|\n)\s*export\s+[\s\S]*?from\s*["']([^"']+)["']/g,
    ];
    for (const pattern of patterns) {
      for (const match of source.matchAll(pattern)) {
        const target = resolveSpecifier(file, match[1], known, srcRoot);
        if (target && target !== file) targets.add(target);
      }
    }
    graph.set(file, targets);
  }
  return graph;
};

type MetadataEdge = {
  readonly from: string;
  readonly to: string;
  readonly name: string;
  readonly deferred: boolean;
};

/**
 * The `imports:` array of every `*.module.ts`, one entry per named module class,
 * with whether every occurrence of that name is wrapped in `forwardRef`.
 */
const metadataEdges = (
  sources: ReadonlyMap<string, string>,
  srcRoot: string,
): MetadataEdge[] => {
  const known = new Set(sources.keys());
  const edges: MetadataEdge[] = [];
  for (const [file, raw] of sources) {
    if (!file.endsWith(".module.ts")) continue;
    const source = stripComments(raw);

    const named = new Map<string, string>();
    for (const match of source.matchAll(
      /import\s*\{([^}]*)\}\s*from\s*["']([^"']+)["']/g,
    )) {
      const target = resolveSpecifier(file, match[2], known, srcRoot);
      if (!target || !target.endsWith(".module.ts")) continue;
      for (const clause of match[1].split(",")) {
        const local = clause
          .trim()
          .split(/\s+as\s+/)
          .pop()
          ?.trim();
        if (local) named.set(local, target);
      }
    }

    const declaration = source.indexOf("imports: [");
    if (declaration < 0) continue;
    const open = source.indexOf("[", declaration);
    const importsText = source.slice(open, closingIndex(source, open) + 1);

    for (const [name, target] of named) {
      const occurrences = [
        ...importsText.matchAll(
          new RegExp(`(?<![A-Za-z0-9_$.])${name}(?![A-Za-z0-9_$])`, "g"),
        ),
      ];
      if (occurrences.length === 0) continue;
      const deferred = occurrences.every((occurrence) =>
        /forwardRef\(\(\)\s*=>\s*$/.test(
          importsText.slice(0, occurrence.index),
        ),
      );
      edges.push({ from: file, to: target, name, deferred });
    }
  }
  return edges;
};

/**
 * Every bare `imports` edge whose target can reach the declaring file through
 * `import` statements: the edges that evaluate to `undefined` under at least one
 * load order.
 */
export const bareEdgesOnRequireCycles = (
  sources: ReadonlyMap<string, string>,
  srcRoot: string,
): string[] => {
  const graph = importGraph(sources, srcRoot);
  const reachable = new Map<string, Set<string>>();
  const reachableFrom = (start: string): Set<string> => {
    const cached = reachable.get(start);
    if (cached) return cached;
    const seen = new Set<string>();
    const queue = [start];
    while (queue.length > 0) {
      for (const next of graph.get(queue.shift() as string) ?? []) {
        if (seen.has(next)) continue;
        seen.add(next);
        queue.push(next);
      }
    }
    reachable.set(start, seen);
    return seen;
  };

  return metadataEdges(sources, srcRoot)
    .filter((edge) => !edge.deferred && reachableFrom(edge.to).has(edge.from))
    .map(
      (edge) =>
        `${edge.from.slice(srcRoot.length + 1)} imports ${edge.name} bare, ` +
        `but ${edge.name} can reach it back -- needs forwardRef(() => ${edge.name})`,
    );
};

describe("module graph", () => {
  const srcRoot = __dirname;
  const sources = collectSources(srcRoot);

  describe("statically, over every load order", () => {
    it("defers every module import that lies on a require cycle", () => {
      expect(bareEdgesOnRequireCycles(sources, srcRoot)).toEqual([]);
    });

    it("is reading the source tree it thinks it is", () => {
      // A floor, so an analysis that silently enumerated nothing fails instead
      // of reporting a clean graph.
      const moduleFiles = [...sources.keys()].filter((file) =>
        file.endsWith(".module.ts"),
      );
      expect(sources.size).toBeGreaterThan(500);
      expect(moduleFiles.length).toBeGreaterThan(20);
      expect(metadataEdges(sources, srcRoot).length).toBeGreaterThan(80);
    });

    it("reports a planted bare edge on a cycle, and only that one", () => {
      // The self-test the real scan cannot be: on a clean tree the check above
      // passes whether it works or not.
      const root = "/synthetic/src";
      const synthetic = new Map<string, string>([
        [
          `${root}/a/a.module.ts`,
          `import { BModule } from "../b/b.module";
           import { CModule } from "../c/c.module";
           @Module({ imports: [BModule, forwardRef(() => CModule)] })
           export class AModule {}`,
        ],
        [
          `${root}/b/b.module.ts`,
          `import { AModule } from "../a/a.module";
           @Module({ imports: [forwardRef(() => AModule)] })
           export class BModule {}`,
        ],
        [
          `${root}/c/c.module.ts`,
          `import { AModule } from "../a/a.module";
           @Module({ imports: [forwardRef(() => AModule)] })
           export class CModule {}`,
        ],
        [
          `${root}/d/d.module.ts`,
          `import { BModule } from "../b/b.module";
           @Module({ imports: [BModule] })
           export class DModule {}`,
        ],
      ]);

      // A -> B is bare and B imports A back: unsafe. A -> C is the same cycle
      // deferred: safe. D -> B is bare but B never reaches D: safe.
      expect(bareEdgesOnRequireCycles(synthetic, root)).toEqual([
        "a/a.module.ts imports BModule bare, but BModule can reach it back -- needs forwardRef(() => BModule)",
      ]);
    });

    it("sees a `forwardRef` mentioned in a comment as bare", () => {
      // How the first fix read green: the explanatory comment sits inside the
      // `imports` array, so a scan that did not strip comments found the word
      // `forwardRef` beside a name that was still bare.
      const root = "/synthetic/src";
      const synthetic = new Map<string, string>([
        [
          `${root}/a/a.module.ts`,
          `import { BModule } from "../b/b.module";
           @Module({
             imports: [
               // forwardRef: BModule reaches back here.
               BModule,
             ],
           })
           export class AModule {}`,
        ],
        [
          `${root}/b/b.module.ts`,
          `import { AModule } from "../a/a.module";
           @Module({ imports: [forwardRef(() => AModule)] })
           export class BModule {}`,
        ],
      ]);
      expect(bareEdgesOnRequireCycles(synthetic, root)).toHaveLength(1);
    });
  });

  describe("at runtime, as Nest reads it", () => {
    type ModuleClass = { name?: string };
    type SelfDeclaredDep = { index?: number };
    type ForwardRefLike = { forwardRef: () => unknown };
    type DynamicModuleLike = { module: unknown };

    const isForwardRef = (entry: unknown): entry is ForwardRefLike =>
      typeof entry === "object" &&
      entry !== null &&
      typeof (entry as ForwardRefLike).forwardRef === "function";

    const isDynamicModule = (entry: unknown): entry is DynamicModuleLike =>
      typeof entry === "object" &&
      entry !== null &&
      "module" in (entry as DynamicModuleLike);

    /**
     * Unwrap whatever an `imports` entry can be into the module class itself:
     * Nest accepts a class, a `forwardRef`, a `DynamicModule`, and a promise of
     * either of the last two.
     */
    const resolveEntry = async (entry: unknown): Promise<unknown> => {
      if (entry instanceof Promise) return resolveEntry(await entry);
      if (isForwardRef(entry)) return resolveEntry(entry.forwardRef());
      if (isDynamicModule(entry)) return resolveEntry(entry.module);
      return entry;
    };

    /**
     * The same defect one level down, and the one that actually took the
     * container out: a **provider** whose constructor parameter type is
     * `undefined` because the class it names was mid-load when this file
     * decorated. Nest reports it as "Nest can't resolve dependencies of the X
     * (A, B, ?, ...)" and stops at the first one; this lists them all.
     *
     * `@Inject(forwardRef(() => X))` is the fix here too -- it records the
     * dependency as a self-declared param, read after every file has loaded, so
     * the missing `design:paramtypes` entry no longer matters. A param that
     * already carries one is therefore not a problem, whatever its reflected
     * type.
     */
    const undefinedConstructorParams = (
      classes: Iterable<unknown>,
    ): string[] => {
      const problems: string[] = [];
      for (const cls of classes) {
        if (typeof cls !== "function") continue;
        const params: unknown[] =
          Reflect.getMetadata("design:paramtypes", cls) ?? [];
        const selfDeclared: SelfDeclaredDep[] =
          Reflect.getMetadata("self:paramtypes", cls) ?? [];
        const declared = new Set(selfDeclared.map((dep) => dep?.index));
        params.forEach((param, index) => {
          if (param !== undefined || declared.has(index)) return;
          problems.push(
            `${(cls as ModuleClass).name} constructor param [${index}] is undefined -- ` +
              `a circular import that needs @Inject(forwardRef(() => X))`,
          );
        });
      }
      return problems;
    };

    /** Every class a module declares as a provider or a controller. */
    const declaredClasses = (module: unknown): unknown[] => {
      const found: unknown[] = [];
      for (const key of ["providers", "controllers"]) {
        const declared: unknown[] =
          Reflect.getMetadata(key, module as object) ?? [];
        for (const entry of declared) {
          if (typeof entry === "function") found.push(entry);
          else if (
            entry !== null &&
            typeof entry === "object" &&
            typeof (entry as { useClass?: unknown }).useClass === "function"
          ) {
            found.push((entry as { useClass: unknown }).useClass);
          }
        }
      }
      return found;
    };

    const walkGraph = async (appModule: unknown) => {
      const problems: string[] = [];
      const classes = new Set<unknown>();
      const seen = new Set<unknown>();
      const queue: unknown[] = [appModule];

      while (queue.length > 0) {
        const current = queue.shift();
        if (seen.has(current)) continue;
        seen.add(current);

        for (const cls of declaredClasses(current)) classes.add(cls);

        const imports: unknown[] =
          Reflect.getMetadata("imports", current as object) ?? [];
        for (const [index, entry] of imports.entries()) {
          const resolved = await resolveEntry(entry);
          if (typeof resolved !== "function") {
            problems.push(
              `${(current as ModuleClass)?.name ?? String(current)} imports[${index}] is ` +
                `${String(resolved)} -- a circular module import that needs forwardRef(() => X)`,
            );
            continue;
          }
          queue.push(resolved);
        }
      }

      problems.push(...undefinedConstructorParams(classes));

      return { problems, visited: seen.size, providers: classes.size };
    };

    const entryPoints = [...sources.keys()].filter((file) =>
      file.endsWith(".module.ts"),
    );

    /**
     * Every package the source tree requires, loaded once for the whole file.
     *
     * Each case needs a fresh registry for `src/`, where the cycles are; it
     * does not need a fresh copy of Nest, TypeORM and the rest, which no `src/`
     * cycle runs through and which were most of each case's cost. So each case
     * hands the same instances back through `jest.doMock` after its reset, and
     * only the source tree is evaluated again. A package can never be part of
     * a cycle in `src/` (it does not import back into it), so which load order
     * a case measures is unchanged.
     */
    const packageInstances = new Map<string, unknown>();
    const builtins = new Set(builtinModules);
    const requiredPackages = (): string[] => {
      const found = new Set<string>();
      const specifier = /(?:\bfrom|\brequire\(|\bimport\()\s*["']([^"']+)["']/g;
      for (const source of sources.values()) {
        for (const match of stripComments(source).matchAll(specifier)) {
          const name = match[1];
          if (name.startsWith(".") || name.startsWith("@/")) continue;
          if (name.startsWith("node:") || builtins.has(name.split("/")[0])) {
            continue;
          }
          found.add(name);
        }
      }
      return [...found].sort();
    };

    beforeAll(() => {
      /* eslint-disable @typescript-eslint/no-require-imports */
      for (const name of requiredPackages()) {
        try {
          packageInstances.set(name, require(name));
        } catch {
          // A type-only import of a package with no runtime entry: nothing to
          // reuse, and the case loads whatever it really requires itself.
        }
      }
      /* eslint-enable @typescript-eslint/no-require-imports */
    });

    it("reuses a real set of packages across the cases", () => {
      expect(packageInstances.has("@nestjs/common")).toBe(true);
      expect(packageInstances.has("typeorm")).toBe(true);
    });

    it.each(entryPoints.map((file) => [file.slice(srcRoot.length + 1), file]))(
      "builds a resolvable graph when %s loads first",
      async (_label, file) => {
        jest.resetModules();
        for (const [name, instance] of packageInstances) {
          jest.doMock(name, () => instance);
        }
        // `require`, not `import`: the load ORDER is the subject of the case, so
        // each one needs a fresh registry and a load it controls. A top-level
        // `import` is hoisted and cached once for the whole file, which would
        // make all 40-odd cases measure the same order -- the hole the previous
        // version of this spec had.
        /* eslint-disable @typescript-eslint/no-require-imports */
        // The entry point, before anything else -- that is the whole case. Its
        // own circular imports settle here, and `AppModule` then sees whatever
        // shape that order produced.
        require(file);
        const { AppModule } = require("./app.module") as { AppModule: unknown };
        /* eslint-enable @typescript-eslint/no-require-imports */

        const { problems, visited, providers } = await walkGraph(AppModule);

        expect(problems).toEqual([]);
        expect(visited).toBeGreaterThan(20);
        expect(providers).toBeGreaterThan(100);
      },
      30000,
    );
  });
});
