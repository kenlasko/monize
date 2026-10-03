import { ConfigService } from "@nestjs/config";
import { AiActionBuilderService } from "./ai-action-builder.service";
import { AiActionSigningService } from "./ai-action-signing.service";
import {
  AI_ACTION_ENVELOPE_FIELDS,
  AI_ACTION_TYPES,
  AiActionDescriptor,
  PendingAiAction,
} from "./ai-action.types";
import type {
  CreateRulePreview,
  DeleteRulePreview,
  RunRulePreview,
  UpdateRulePreview,
} from "../../transaction-rules/rule-tool-prep.service";

const USER = "user-1";
const RULE = "e0000000-0000-4000-8000-000000000005";
const CAT = "c0000000-0000-4000-8000-000000000003";
const ACC = "a0000000-0000-4000-8000-000000000001";
const FINGERPRINT = "f".repeat(64);

const rule = {
  name: "Streaming",
  enabled: true,
  triggers: ["create", "import"] as ("create" | "import")[],
  stopProcessing: false,
  activeFrom: "2026-10-01" as string | null,
  activeTo: null as string | null,
  condition: { field: "payeeId", op: "eq", value: "p1" } as const,
  actions: [
    { type: "set_category", categoryId: CAT, onlyIfEmpty: true },
  ] as const,
};
const labels = {
  accounts: { [ACC]: "Checking" },
  payees: { p1: "Netflix" },
  categories: { [CAT]: "Bills: Streaming" },
  tags: {},
};
const test = {
  matchedCount: 1,
  conditionMatchedCount: 1,
  scanned: 10,
  truncated: false,
  rows: [],
  skipped: [],
  skippedCount: 0,
  aiReviewRequests: 0,
  labels: { accounts: {}, categories: {}, payees: {}, tags: {}, rules: {} },
};

const createPreview = (): CreateRulePreview => ({
  rule: { ...rule, actions: [...rule.actions] },
  labels,
  test,
});
const updatePreview = (): UpdateRulePreview => ({
  ruleId: RULE,
  expectedRevision: 4,
  rule: { ...rule, name: "Renamed", actions: [...rule.actions] },
  current: { ...rule, actions: [...rule.actions] },
  labels,
  test,
});
const deletePreview = (): DeleteRulePreview => ({
  ruleId: RULE,
  expectedRevision: 4,
  rule: { ...rule, actions: [...rule.actions] },
  labels,
});
const runPreview = (): RunRulePreview => ({
  ruleId: RULE,
  rule: { ...rule, actions: [...rule.actions] },
  labels,
  filters: { accountIds: [ACC], startDate: "2026-01-01", limit: 50 },
  fingerprint: FINGERPRINT,
  test,
});

describe("AiActionBuilderService transaction rule actions", () => {
  let builder: AiActionBuilderService;
  let signing: AiActionSigningService;

  beforeEach(() => {
    signing = new AiActionSigningService({
      get: jest
        .fn()
        .mockReturnValue("test-secret-key-at-least-32-chars-long!!"),
    } as unknown as ConfigService);
    builder = new AiActionBuilderService(signing);
  });

  const cases: [string, () => PendingAiAction][] = [
    [
      "create_transaction_rule",
      () => builder.buildCreateTransactionRule(USER, createPreview()),
    ],
    [
      "update_transaction_rule",
      () => builder.buildUpdateTransactionRule(USER, updatePreview()),
    ],
    [
      "delete_transaction_rule",
      () => builder.buildDeleteTransactionRule(USER, deletePreview()),
    ],
    [
      "run_transaction_rule",
      () => builder.buildRunTransactionRule(USER, runPreview()),
    ],
  ];

  it("registers every new type as a confirmable action", () => {
    for (const [type] of cases) {
      expect(AI_ACTION_TYPES).toContain(type);
    }
  });

  it.each(cases)(
    "%s is signed, bound to the user, and verifies after the browser's JSON round trip",
    (type, build) => {
      const action = build();
      expect(action.type).toBe(type);
      expect(action.descriptor).toMatchObject({ type, userId: USER });
      expect(action.actionId).toBe(action.descriptor.actionId);
      expect(action.expiresAt).toBe(action.descriptor.expiresAt);

      const echoed = JSON.parse(
        JSON.stringify(action.descriptor),
      ) as AiActionDescriptor;
      expect(signing.verify(echoed, action.signature)).toBe(true);
    },
  );

  it.each(cases)(
    "%s does not verify once any signed value is altered",
    (_type, build) => {
      const action = build();
      const tampered = JSON.parse(
        JSON.stringify({ ...action.descriptor, userId: "user-2" }),
      ) as AiActionDescriptor;
      expect(signing.verify(tampered, action.signature)).toBe(false);
    },
  );

  it.each(cases)(
    "%s differs between two builds of the same change only in the envelope fields",
    (_type, build) => {
      const strip = (d: AiActionDescriptor): Record<string, unknown> => {
        const copy: Record<string, unknown> = { ...d };
        for (const field of AI_ACTION_ENVELOPE_FIELDS) delete copy[field];
        return copy;
      };
      const a = build();
      const b = build();
      expect(a.actionId).not.toBe(b.actionId);
      expect(strip(a.descriptor)).toEqual(strip(b.descriptor));
    },
  );

  it("create carries the resolved rule as ids and puts the names on the card, not in the descriptor", () => {
    const action = builder.buildCreateTransactionRule(USER, createPreview());
    expect(action.descriptor).toMatchObject({
      rule: {
        name: "Streaming",
        enabled: true,
        triggers: ["create", "import"],
        activeFrom: "2026-10-01",
        activeTo: null,
        actions: [{ type: "set_category", categoryId: CAT, onlyIfEmpty: true }],
      },
    });
    expect(JSON.stringify(action.descriptor)).not.toContain("Bills: Streaming");
    expect(action.preview.rule).toMatchObject({
      name: "Streaming",
      activeFrom: "2026-10-01",
      activeTo: null,
      labels: { categories: { [CAT]: "Bills: Streaming" } },
      test: { matchedCount: 1, scanned: 10 },
    });
  });

  it("update carries the expected revision and shows the rule as it was", () => {
    const action = builder.buildUpdateTransactionRule(USER, updatePreview());
    expect(action.descriptor).toMatchObject({
      ruleId: RULE,
      expectedRevision: 4,
      rule: { name: "Renamed" },
    });
    expect(action.preview.rule).toMatchObject({
      name: "Renamed",
      current: { name: "Streaming" },
    });
  });

  it("update omits the test when the preview has none", () => {
    const { test: _test, ...withoutTest } = updatePreview();
    const action = builder.buildUpdateTransactionRule(USER, withoutTest);
    expect(action.preview.rule).not.toHaveProperty("test");
  });

  it("delete identifies the rule and the revision the card showed", () => {
    const action = builder.buildDeleteTransactionRule(USER, deletePreview());
    expect(action.descriptor).toMatchObject({
      ruleId: RULE,
      expectedRevision: 4,
    });
    expect(action.descriptor).not.toHaveProperty("rule");
    expect(action.preview.rule).toMatchObject({ name: "Streaming" });
  });

  it("run carries the filters and the plan fingerprint, and lists the rows on the card", () => {
    const action = builder.buildRunTransactionRule(USER, runPreview());
    expect(action.descriptor).toMatchObject({
      ruleId: RULE,
      fingerprint: FINGERPRINT,
      filters: { accountIds: [ACC], startDate: "2026-01-01", limit: 50 },
    });
    expect(
      action.descriptor.type === "run_transaction_rule" &&
        action.descriptor.filters,
    ).not.toHaveProperty("endDate");
    expect(action.preview.rule).toMatchObject({
      filters: { accountIds: [ACC] },
      test: { matchedCount: 1 },
    });
  });

  it("copies the definition so a later edit of the preview cannot reach a signed value", () => {
    const preview = createPreview();
    const action = builder.buildCreateTransactionRule(USER, preview);
    preview.rule.actions.push({ type: "add_tags", tagIds: ["t"] });
    preview.rule.triggers.pop();
    expect(signing.verify(action.descriptor, action.signature)).toBe(true);
  });
});
