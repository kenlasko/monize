import { readFileSync } from "fs";
import { join } from "path";
import { Logger } from "@nestjs/common";
import {
  QUERY_BUDGET_SPECS,
  QueryBudgetKey,
  QueryBudgetSource,
  resolveQueryBudgets,
  resolveQueryBudgetsForConfig,
} from "./query-budgets";

const budgetKeys = Object.keys(QUERY_BUDGET_SPECS) as QueryBudgetKey[];

/** A ConfigService stand-in backed by a plain map of env values. */
const readerFor = (values: Record<string, unknown>) => ({
  get: (key: string) => values[key],
});

const makeLogger = () => {
  const logger = { log: jest.fn(), warn: jest.fn() };
  return logger as unknown as Logger & typeof logger;
};

describe("resolveQueryBudgets", () => {
  it("falls back to every default when no config is supplied at all", () => {
    const budgets = resolveQueryBudgets();

    expect(budgets).toEqual({
      maxIterations: 10,
      maxToolCalls: 20,
      queryTimeoutMs: 20 * 60 * 1000,
      maxInputTokens: 200_000,
      maxToolResultChars: 50_000,
    });
  });

  it("falls back to every default when the config has no overrides", () => {
    expect(resolveQueryBudgets(readerFor({}))).toEqual(resolveQueryBudgets());
  });

  it("applies every override, including a value below the default", () => {
    const budgets = resolveQueryBudgets(
      readerFor({
        AI_QUERY_MAX_ITERATIONS: "12",
        AI_QUERY_MAX_TOOL_CALLS: "40",
        AI_QUERY_TIMEOUT_MINUTES: "3",
        AI_QUERY_MAX_INPUT_TOKENS: "50000",
        AI_QUERY_MAX_TOOL_RESULT_CHARS: "10000",
      }),
    );

    expect(budgets).toEqual({
      maxIterations: 12,
      maxToolCalls: 40,
      queryTimeoutMs: 3 * 60 * 1000,
      maxInputTokens: 50_000,
      maxToolResultChars: 10_000,
    });
  });

  it("converts the timeout from minutes to milliseconds", () => {
    // The env var is in minutes for readability; the loop compares a ms delta.
    // Getting this backwards would give a 20-millisecond query budget.
    expect(
      resolveQueryBudgets(readerFor({ AI_QUERY_TIMEOUT_MINUTES: 1 }))
        .queryTimeoutMs,
    ).toBe(60_000);
  });

  it("accepts a numeric value as well as the string env vars arrive as", () => {
    expect(
      resolveQueryBudgets(readerFor({ AI_QUERY_MAX_ITERATIONS: 9 }))
        .maxIterations,
    ).toBe(9);
  });

  describe.each([
    ["a non-numeric string", "ten"],
    ["zero", "0"],
    ["a negative number", "-5"],
    ["a fraction", "2.5"],
    ["a boolean-ish string", "true"],
    ["Infinity", "Infinity"],
    ["NaN", Number.NaN],
  ])("rejects %s", (_label, raw) => {
    it("keeps the default and warns", () => {
      const logger = makeLogger();
      const budgets = resolveQueryBudgets(
        readerFor({ AI_QUERY_MAX_ITERATIONS: raw }),
        logger,
      );

      expect(budgets.maxIterations).toBe(
        QUERY_BUDGET_SPECS.maxIterations.default,
      );
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("AI_QUERY_MAX_ITERATIONS"),
      );
    });
  });

  it.each([
    ["an unset variable", undefined],
    ["an empty string", ""],
    ["a whitespace-only string", "   "],
  ])("treats %s as absent rather than invalid", (_label, raw) => {
    const logger = makeLogger();
    const budgets = resolveQueryBudgets(
      readerFor({ AI_QUERY_MAX_ITERATIONS: raw }),
      logger,
    );

    expect(budgets.maxIterations).toBe(
      QUERY_BUDGET_SPECS.maxIterations.default,
    );
    // An operator who set nothing has made no mistake, so nothing is logged.
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.log).not.toHaveBeenCalled();
  });

  it("logs an accepted override so the effective budget is visible", () => {
    const logger = makeLogger();
    resolveQueryBudgets(readerFor({ AI_QUERY_MAX_TOOL_CALLS: "30" }), logger);

    expect(logger.log).toHaveBeenCalledWith(
      expect.stringContaining("AI_QUERY_MAX_TOOL_CALLS=30"),
    );
  });

  it("does not log an override that merely restates the default", () => {
    const logger = makeLogger();
    resolveQueryBudgets(
      readerFor({
        AI_QUERY_MAX_TOOL_CALLS: String(
          QUERY_BUDGET_SPECS.maxToolCalls.default,
        ),
      }),
      logger,
    );

    expect(logger.log).not.toHaveBeenCalled();
  });

  it("resolves each budget from its own variable, not a shared one", () => {
    // One spec object copied and edited is the easy mistake here: every budget
    // would read the same env var and move together.
    for (const key of budgetKeys) {
      const spec = QUERY_BUDGET_SPECS[key];
      const budgets = resolveQueryBudgets(
        readerFor({ [spec.envVar]: spec.default + 1 }),
      );
      const others = budgetKeys.filter((k) => k !== key);
      for (const other of others) {
        const otherSpec = QUERY_BUDGET_SPECS[other];
        const value =
          other === "timeoutMinutes"
            ? budgets.queryTimeoutMs / 60_000
            : (budgets as unknown as Record<string, number>)[other];
        expect({ key, other, value }).toEqual({
          key,
          other,
          value: otherSpec.default,
        });
      }
    }
  });

  it("works when the config throws for unknown keys", () => {
    // Belt and braces: a reader that is strict about unknown keys must not
    // take the whole assistant down at construction time.
    const strict = {
      get: (key: string) => {
        if (!budgetKeys.some((k) => QUERY_BUDGET_SPECS[k].envVar === key)) {
          throw new Error(`unknown key ${key}`);
        }
        return undefined;
      },
    };
    expect(() => resolveQueryBudgets(strict)).not.toThrow();
  });
});

describe("resolveQueryBudgetsForConfig", () => {
  /** Budgets nothing in the environment or on a row could produce by accident. */
  const CENTRAL: ReturnType<typeof resolveQueryBudgets> = {
    maxIterations: 41,
    maxToolCalls: 42,
    queryTimeoutMs: 43 * 60 * 1000,
    maxInputTokens: 44_000,
    maxToolResultChars: 45_000,
  };

  const defaults = resolveQueryBudgets();

  it("gives the centrally managed provider the environment's budgets", () => {
    expect(
      resolveQueryBudgetsForConfig({ isSystemDefault: true }, CENTRAL),
    ).toEqual(CENTRAL);
  });

  // The whole point of the split: an operator's ceiling for the model they
  // host must not silently reshape a provider the user configured and can see.
  it("ignores the environment entirely for a user-configured provider", () => {
    expect(resolveQueryBudgetsForConfig({}, CENTRAL)).toEqual(defaults);
  });

  it("keeps the environment away from every individual budget", () => {
    const resolved = resolveQueryBudgetsForConfig(
      {},
      CENTRAL,
    ) as unknown as Record<string, number>;
    for (const [key, value] of Object.entries(
      CENTRAL as unknown as Record<string, number>,
    )) {
      expect({ key, value: resolved[key] }).not.toEqual({ key, value });
    }
  });

  it("applies every stored override", () => {
    const source: QueryBudgetSource = {
      queryMaxIterations: 9,
      queryMaxToolCalls: 30,
      queryTimeoutMinutes: 7,
      queryMaxInputTokens: 90_000,
      queryMaxToolResultChars: 20_000,
    };

    expect(resolveQueryBudgetsForConfig(source, CENTRAL)).toEqual({
      maxIterations: 9,
      maxToolCalls: 30,
      queryTimeoutMs: 7 * 60 * 1000,
      maxInputTokens: 90_000,
      maxToolResultChars: 20_000,
    });
  });

  it("falls back per budget, so one override does not move the others", () => {
    for (const key of budgetKeys) {
      const spec = QUERY_BUDGET_SPECS[key];
      const budgets = resolveQueryBudgetsForConfig(
        { [spec.field]: spec.default + 1 } as QueryBudgetSource,
        CENTRAL,
      );
      for (const other of budgetKeys.filter((k) => k !== key)) {
        const otherSpec = QUERY_BUDGET_SPECS[other];
        const value =
          other === "timeoutMinutes"
            ? budgets.queryTimeoutMs / 60_000
            : (budgets as unknown as Record<string, number>)[other];
        expect({ key, other, value }).toEqual({
          key,
          other,
          value: otherSpec.default,
        });
      }
    }
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
  ])("treats %s as unset without complaining", (_label, stored) => {
    const logger = makeLogger();
    const budgets = resolveQueryBudgetsForConfig(
      { queryMaxIterations: stored },
      CENTRAL,
      logger,
    );

    expect(budgets.maxIterations).toBe(
      QUERY_BUDGET_SPECS.maxIterations.default,
    );
    expect(logger.warn).not.toHaveBeenCalled();
  });

  // A row can only hold one of these through a hand edit or a restored
  // artifact -- the DTO refuses them on the way in -- and the documented
  // default is a better answer than a number nobody chose.
  describe("a stored value outside the accepted range", () => {
    it.each([
      ["zero", 0],
      ["a negative number", -1],
      ["a fraction", 2.5],
      ["a non-numeric value", "lots" as unknown as number],
      ["above the maximum", QUERY_BUDGET_SPECS.maxIterations.max + 1],
    ])("falls back to the default for %s", (_label, stored) => {
      const logger = makeLogger();

      const budgets = resolveQueryBudgetsForConfig(
        { queryMaxIterations: stored },
        CENTRAL,
        logger,
      );

      expect(budgets.maxIterations).toBe(
        QUERY_BUDGET_SPECS.maxIterations.default,
      );
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("queryMaxIterations"),
      );
    });

    it("falls back to the default below a budget's own minimum", () => {
      // Not every floor is 1: the token and character budgets are useless at
      // single digits, so their minimum is the one the spec table declares.
      const logger = makeLogger();
      const spec = QUERY_BUDGET_SPECS.maxInputTokens;

      const budgets = resolveQueryBudgetsForConfig(
        { queryMaxInputTokens: spec.min - 1 },
        CENTRAL,
        logger,
      );

      expect(budgets.maxInputTokens).toBe(spec.default);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("queryMaxInputTokens"),
      );
    });
  });

  it("accepts a value exactly on each bound", () => {
    for (const key of budgetKeys) {
      const spec = QUERY_BUDGET_SPECS[key];
      for (const bound of [spec.min, spec.max]) {
        const budgets = resolveQueryBudgetsForConfig(
          { [spec.field]: bound } as QueryBudgetSource,
          CENTRAL,
        );
        const value =
          key === "timeoutMinutes"
            ? budgets.queryTimeoutMs / 60_000
            : (budgets as unknown as Record<string, number>)[key];
        expect({ key, bound, value }).toEqual({ key, bound, value: bound });
      }
    }
  });

  it("converts a stored timeout from minutes to milliseconds", () => {
    expect(
      resolveQueryBudgetsForConfig({ queryTimeoutMinutes: 3 }, CENTRAL)
        .queryTimeoutMs,
    ).toBe(3 * 60 * 1000);
  });

  it("prefers the environment over a stored value on the system default", () => {
    // A row can never be both, but if one ever carried stray budgets the
    // operator's environment is the answer for the provider they own.
    expect(
      resolveQueryBudgetsForConfig(
        { isSystemDefault: true, queryMaxIterations: 3 },
        CENTRAL,
      ),
    ).toEqual(CENTRAL);
  });
});

describe("QUERY_BUDGET_SPECS", () => {
  it("gives every budget a distinct AI_QUERY_-prefixed variable", () => {
    const names = budgetKeys.map((k) => QUERY_BUDGET_SPECS[k].envVar);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) {
      expect(name).toMatch(/^AI_QUERY_[A-Z_]+$/);
    }
  });

  it("gives every budget a positive integer default and a description", () => {
    for (const key of budgetKeys) {
      const spec = QUERY_BUDGET_SPECS[key];
      expect(Number.isInteger(spec.default) && spec.default > 0).toBe(true);
      expect(spec.description.length).toBeGreaterThan(0);
    }
  });

  it("gives every budget a range its default sits inside", () => {
    for (const key of budgetKeys) {
      const spec = QUERY_BUDGET_SPECS[key];
      expect({
        key,
        ok:
          Number.isInteger(spec.min) &&
          Number.isInteger(spec.max) &&
          spec.min > 0 &&
          spec.min <= spec.default &&
          spec.default <= spec.max,
      }).toEqual({ key, ok: true });
    }
  });

  // One spec object copied from its neighbour is the mistake these catch: two
  // budgets sharing a field would overwrite each other on save, and two
  // sharing a column would not compile a migration.
  it("gives every budget a distinct field and column, named after its key", () => {
    const fields = budgetKeys.map((k) => QUERY_BUDGET_SPECS[k].field);
    const columns = budgetKeys.map((k) => QUERY_BUDGET_SPECS[k].column);
    expect(new Set(fields).size).toBe(fields.length);
    expect(new Set(columns).size).toBe(columns.length);

    for (const key of budgetKeys) {
      const spec = QUERY_BUDGET_SPECS[key];
      const expectedField = `query${key[0].toUpperCase()}${key.slice(1)}`;
      const expectedColumn = expectedField
        .replace(/([A-Z])/g, "_$1")
        .toLowerCase();
      expect({ key, field: spec.field, column: spec.column }).toEqual({
        key,
        field: expectedField,
        column: expectedColumn,
      });
    }
  });

  // A knob nobody can find is not configurable. `.env.example` is the only
  // place an operator looks, so a new budget that never reaches it ships
  // undiscoverable -- and a documented default that has drifted from the code
  // is worse than none, because it is believed.
  describe(".env.example parity", () => {
    const envExample = readFileSync(
      join(__dirname, "..", "..", "..", "..", ".env.example"),
      "utf8",
    );

    it.each(budgetKeys)("documents %s with its current default", (key) => {
      const spec = QUERY_BUDGET_SPECS[key];
      expect(envExample).toContain(`# ${spec.envVar}=${spec.default}`);
    });

    it("documents no AI_QUERY_ variable the code does not read", () => {
      const documented = [
        ...envExample.matchAll(/^#\s*(AI_QUERY_[A-Z_]+)=/gm),
      ].map((m) => m[1]);
      const known = budgetKeys.map((k) => QUERY_BUDGET_SPECS[k].envVar);
      expect([...new Set(documented)].sort()).toEqual([...known].sort());
    });

    it("says the variables cover the centrally managed provider only", () => {
      // The scope is the whole point of the split. An operator reading only
      // this file must not come away believing these bound every user's AI.
      expect(envExample).toMatch(
        /AI Assistant per-query budgets \(centrally managed provider only\)/,
      );
    });
  });

  // A per-provider budget with no column is a setting the UI can accept and
  // the database silently drops. The migration is replayed on top of
  // schema.sql, so schema.sql is the file that has to carry every column.
  describe("database/schema.sql parity", () => {
    const schema = readFileSync(
      join(__dirname, "..", "..", "..", "..", "database", "schema.sql"),
      "utf8",
    );
    const tableDdl = (() => {
      const match = schema.match(
        /CREATE TABLE ai_provider_configs \(([\s\S]*?)\n\);/,
      );
      if (!match) {
        throw new Error(
          "ai_provider_configs table not found in database/schema.sql -- this guard has lost its subject",
        );
      }
      return match[1];
    })();

    it.each(budgetKeys)("declares an integer column for %s", (key) => {
      const spec = QUERY_BUDGET_SPECS[key];
      expect(tableDdl).toMatch(
        new RegExp(`^\\s*${spec.column}\\s+INTEGER\\b`, "mi"),
      );
    });
  });
});
