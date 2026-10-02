import type { RuleTraceEntry } from "../transaction-rules/rule-effects";
import {
  emptyImportPreviewLabels,
  matchedRuleViews,
  mergeImportPreviewLabels,
  ruleChangesView,
} from "./rule-trace";

const entry = (over: Partial<RuleTraceEntry> = {}): RuleTraceEntry => ({
  ruleId: "rule-1",
  matched: true,
  applied: [],
  skipped: [],
  changes: {},
  stopped: false,
  ...over,
});

describe("ruleChangesView", () => {
  it("copies only the fields a rule changed, as plain data", () => {
    const changes = {
      categoryId: { before: null, after: "c1" },
      description: { before: "a", after: "b" },
      payeeName: { before: null, after: "Shop" },
      payeeCreated: true,
      tagIds: {
        before: ["t1"] as readonly string[],
        after: ["t1", "t2"] as readonly string[],
      },
    };
    const view = ruleChangesView(changes);
    expect(view).toEqual({
      categoryId: { before: null, after: "c1" },
      description: { before: "a", after: "b" },
      payeeName: { before: null, after: "Shop" },
      payeeCreated: true,
      tagIds: { before: ["t1"], after: ["t1", "t2"] },
    });
    expect(view.categoryId).not.toBe(changes.categoryId);
    expect(view.tagIds?.after).not.toBe(changes.tagIds.after);
  });

  it("leaves out a field that was not changed, and a payeeCreated that is not true", () => {
    expect(ruleChangesView({})).toEqual({});
    expect(ruleChangesView({ payeeCreated: false } as never)).toEqual({});
    expect(ruleChangesView({ payeeId: { before: "p1", after: null } })).toEqual(
      {
        payeeId: { before: "p1", after: null },
      },
    );
  });
});

describe("matchedRuleViews", () => {
  it("lists the matched rules in order, by name, and leaves the others out", () => {
    const views = matchedRuleViews(
      [
        entry({
          ruleId: "r1",
          applied: [{ type: "set_category" }],
          skipped: [{ type: "set_payee_from_text", reason: "payee_not_found" }],
          changes: { categoryId: { before: null, after: "c1" } },
        }),
        entry({ ruleId: "r2", matched: false }),
        entry({ ruleId: "r3", matched: false, skippedRule: "disabled" }),
        entry({ ruleId: "r4", stopped: true }),
      ],
      { r1: "First", r4: "Last" },
    );
    expect(views).toEqual([
      {
        ruleId: "r1",
        ruleName: "First",
        changes: { categoryId: { before: null, after: "c1" } },
        applied: [{ type: "set_category" }],
        skipped: [{ type: "set_payee_from_text", reason: "payee_not_found" }],
        stopped: false,
      },
      {
        ruleId: "r4",
        ruleName: "Last",
        changes: {},
        applied: [],
        skipped: [],
        stopped: true,
      },
    ]);
  });

  it("names a rule it has no name for as null, never by its id, and copes with no names at all", () => {
    expect(matchedRuleViews([entry()], {})[0].ruleName).toBeNull();
    expect(matchedRuleViews([entry()], null)[0].ruleName).toBeNull();
  });

  it("drops what a rule's application carries beyond type and reason (an AI review's outcome)", () => {
    const [view] = matchedRuleViews(
      [entry({ applied: [{ type: "request_ai_review", outcome: "queued" }] })],
      null,
    );
    expect(view.applied).toEqual([{ type: "request_ai_review" }]);
  });

  it("is empty for an empty trace", () => {
    expect(matchedRuleViews([], {})).toEqual([]);
  });
});

describe("the labels of a preview", () => {
  it("starts empty and takes the names of each row, later rows adding to earlier ones", () => {
    const labels = emptyImportPreviewLabels();
    expect(labels).toEqual({ categories: {}, payees: {}, tags: {} });
    mergeImportPreviewLabels(labels, {
      categories: { c1: "Food" },
      payees: {},
      tags: { t1: "Weekly" },
    });
    mergeImportPreviewLabels(labels, {
      categories: { c2: "Rent" },
      payees: { p1: "Shop" },
      tags: {},
    });
    expect(labels).toEqual({
      categories: { c1: "Food", c2: "Rent" },
      payees: { p1: "Shop" },
      tags: { t1: "Weekly" },
    });
  });

  it("gives each preview its own set", () => {
    const a = emptyImportPreviewLabels();
    const b = emptyImportPreviewLabels();
    mergeImportPreviewLabels(a, {
      categories: { c1: "x" },
      payees: {},
      tags: {},
    });
    expect(b.categories).toEqual({});
  });
});
