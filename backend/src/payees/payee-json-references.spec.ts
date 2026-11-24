import { readFileSync } from "fs";
import { join } from "path";
import { EntityManager } from "typeorm";
import { RULE_CONDITION_FIELDS } from "../transaction-rules/rule-condition.types";
import {
  PAYEE_JSON_REFERENCES,
  PAYEE_RULE_ACTION_PATHS,
  countPayeeJsonReferences,
  repointRuleActions,
  repointRuleCondition,
  repointReportFilters,
} from "./payee-json-references";
import { reassignPayeeReferences } from "./payee-references";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const OTHER = "33333333-3333-4333-8333-333333333333";

const strip = (sql: string) =>
  sql
    .split("\n")
    .map((l) => l.replace(/--.*$/, ""))
    .join("\n");

describe("guard: payee ids kept in JSON", () => {
  const typesSource = strip(
    readFileSync(
      join(__dirname, "..", "transaction-rules", "rule-action.types.ts"),
      "utf8",
    ),
  );

  it("lists every rule action type whose interface carries a payeeId", () => {
    const carrying = [
      ...typesSource.matchAll(/export interface \w+ \{([\s\S]*?)\n\}/g),
    ]
      .map(([, body]) => body)
      .filter((body) => /readonly payeeId\??:/.test(body))
      .map((body) => /readonly type: "(\w+)"/.exec(body)?.[1])
      .filter((t): t is string => t !== undefined);
    expect(carrying.length).toBeGreaterThan(0);
    expect(Object.keys(PAYEE_RULE_ACTION_PATHS).sort()).toEqual(
      carrying.sort(),
    );
  });

  it("reads every condition field of kind payeeId", () => {
    const fields = Object.entries(RULE_CONDITION_FIELDS)
      .filter(([, spec]) => spec.kind === "payeeId")
      .map(([name]) => name);
    expect(fields.length).toBeGreaterThan(0);
    for (const field of fields) {
      expect(repointRuleCondition({ field, op: "eq", value: A }, A, B)).toEqual(
        { field, op: "eq", value: B },
      );
    }
  });

  it("names JSONB columns that exist in schema.sql", () => {
    const schema = strip(
      readFileSync(
        join(__dirname, "..", "..", "..", "database", "schema.sql"),
        "utf8",
      ),
    );
    for (const ref of PAYEE_JSON_REFERENCES) {
      const [table, column] = ref.split(".");
      const block = new RegExp(
        String.raw`CREATE TABLE\s+${table}\s*\(([\s\S]*?)\n\);`,
      ).exec(schema)?.[1];
      expect(block).toMatch(new RegExp(String.raw`\b${column}\s+JSONB`));
    }
  });
});

describe("repointing", () => {
  it("rewrites nested condition leaves, scalar and list, without repeats", () => {
    const cond = {
      all: [
        { field: "payeeId", op: "eq", value: A },
        { any: [{ field: "payeeId", op: "in", value: [A, B, OTHER] }] },
        { field: "categoryId", op: "eq", value: A },
      ],
    };
    expect(repointRuleCondition(cond, A, B)).toEqual({
      all: [
        { field: "payeeId", op: "eq", value: B },
        { any: [{ field: "payeeId", op: "in", value: [B, OTHER] }] },
        { field: "categoryId", op: "eq", value: A },
      ],
    });
  });

  it("rewrites each action kind that carries a payee", () => {
    const actions = [
      { type: "set_payee", payeeId: A, onlyIfEmpty: true },
      { type: "convert_to_transfer", toAccountId: "x", payeeId: A },
      { type: "convert_to_transfer", toAccountId: "x" },
      {
        type: "split",
        payeeId: A,
        parts: [{ amount: "rest", payeeId: A }, { amount: "1" }],
      },
      { type: "add_tags", tagIds: [A] },
    ];
    expect(repointRuleActions(actions, A, B)).toEqual([
      { type: "set_payee", payeeId: B, onlyIfEmpty: true },
      { type: "convert_to_transfer", toAccountId: "x", payeeId: B },
      { type: "convert_to_transfer", toAccountId: "x" },
      {
        type: "split",
        payeeId: B,
        parts: [{ amount: "rest", payeeId: B }, { amount: "1" }],
      },
      { type: "add_tags", tagIds: [A] },
    ]);
  });

  it("rewrites legacy and grouped custom report filters", () => {
    expect(
      repointReportFilters(
        {
          payeeIds: [A, OTHER],
          filterGroups: [
            {
              conditions: [
                { field: "payee", value: [A] },
                { field: "category", value: A },
              ],
            },
          ],
        },
        A,
        B,
      ),
    ).toEqual({
      payeeIds: [B, OTHER],
      filterGroups: [
        {
          conditions: [
            { field: "payee", value: [B] },
            { field: "category", value: A },
          ],
        },
      ],
    });
  });
});

describe("merge repoints rules", () => {
  const rule = {
    id: "r1",
    condition: { field: "payeeId", op: "eq", value: A },
    actions: [{ type: "set_payee", payeeId: A, onlyIfEmpty: true }],
  };

  function manager() {
    return {
      update: jest.fn().mockResolvedValue({ affected: 0 }),
      query: jest.fn((sql: string, _params?: unknown[]) => {
        if (sql.includes("FROM transaction_rules")) return [rule];
        if (sql.includes("FROM custom_reports")) return [];
        return [[], 0];
      }),
    };
  }

  it("writes the rule back with the target id and a new revision", async () => {
    const m = manager();
    const result = await reassignPayeeReferences(
      m as unknown as EntityManager,
      {
        userId: "u",
        sourcePayeeId: A,
        target: { id: B, name: "B" },
      },
    );
    const write = m.query.mock.calls.find(([sql]) =>
      sql.startsWith("UPDATE transaction_rules"),
    );
    expect(write?.[1]).toEqual([
      JSON.stringify({ field: "payeeId", op: "eq", value: B }),
      JSON.stringify([{ type: "set_payee", payeeId: B, onlyIfEmpty: true }]),
      "r1",
      "u",
    ]);
    expect(write?.[0]).toContain("revision = revision + 1");
    expect(result.json).toEqual({ rules: 1, reports: 0 });
  });

  it("counts what a merge would repoint", async () => {
    const m = { query: jest.fn().mockResolvedValue([{ n: "2" }]) };
    expect(
      await countPayeeJsonReferences(m as unknown as EntityManager, "u", A),
    ).toEqual({ rules: 2, reports: 2 });
  });
});
