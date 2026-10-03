import { BadRequestException, NotFoundException } from "@nestjs/common";
import { DataSource } from "typeorm";
import { Category } from "../categories/entities/category.entity";
import { createScopedDbMocks } from "../test-helpers/scoped-db-testing";
import { RULE_CARD_PREVIEW_ROWS } from "../ai/actions/ai-action.types";
import { RuleRunPreview } from "./rule-run.types";
import { TransactionRuleResponseDto } from "./dto/transaction-rule-response.dto";
import { TransactionRuleToolPrepService } from "./rule-tool-prep.service";
import { validateRuleDefinition } from "./rule-validation";
import {
  ACCOUNT_ID,
  CATEGORY_ID,
  PAYEE_ID,
  RULE_ID,
  TAG_ID,
  USER_ID,
  VALID_ACTIONS,
  VALID_CONDITION,
} from "./transaction-rules.test-helpers";

jest.mock("../common/db/scoped-db", () =>
  jest.requireActual("../test-helpers/scoped-db-testing").scopedDbMockModule(),
);

const OTHER_CATEGORY_ID = "c0000000-0000-4000-8000-0000000000c2";

function storedDto(
  over: Partial<TransactionRuleResponseDto> = {},
): TransactionRuleResponseDto {
  return {
    id: RULE_ID,
    name: "Groceries",
    enabled: true,
    position: 0,
    triggers: ["create", "import"],
    condition: VALID_CONDITION,
    actions: VALID_ACTIONS,
    stopProcessing: false,
    activeFrom: null,
    activeTo: null,
    revision: 3,
    createdAt: new Date("2026-09-01T00:00:00Z"),
    updatedAt: new Date("2026-09-01T00:00:00Z"),
    invalid: false,
    invalidReasons: [],
    ...over,
  };
}

function runPreview(rows = 2): RuleRunPreview {
  return {
    matched: Array.from({ length: rows }, (_, i) => ({
      transactionId: `t-${i}`,
      date: "2026-09-01",
      payeeName: "Netflix",
      amount: -15.99,
      currencyCode: "USD",
      changes: {
        categoryId: { before: null, after: CATEGORY_ID },
        tagIds: { before: [], after: [TAG_ID] },
      },
    })),
    skipped: [{ transactionId: "t-x", reason: "reconciled_locked" }],
    scanned: 40,
    conditionMatchedCount: rows + 1,
    truncated: false,
    fingerprint: "f".repeat(64),
    labels: {
      accounts: {},
      categories: { [CATEGORY_ID]: "Bills: Streaming" },
      payees: {},
      tags: { [TAG_ID]: "Subscriptions" },
      rules: {},
    },
    aiReviewRequests: 0,
  };
}

function build() {
  const categories = [
    { id: CATEGORY_ID, name: "Streaming", parentId: "parent-bills" },
    { id: "parent-bills", name: "Bills", parentId: null },
    { id: OTHER_CATEGORY_ID, name: "Streaming", parentId: "parent-fun" },
    { id: "parent-fun", name: "Fun", parentId: null },
  ];
  const categoryRepo = { find: jest.fn().mockResolvedValue(categories) };
  const { manager, dataSource } = createScopedDbMocks([
    [Category, categoryRepo],
  ]);
  const named: Record<string, string> = {
    [ACCOUNT_ID]: "Checking",
    [PAYEE_ID]: "Netflix",
    [TAG_ID]: "Subscriptions",
  };
  // `loadRuleLabels` reads accounts, payees and tags with `find({ where: { id: In(ids) } })`.
  manager.find.mockImplementation(
    async (_entity: unknown, opts: { where: { id: { value: string[] } } }) =>
      opts.where.id.value
        .filter((id) => named[id])
        .map((id) => ({ id, name: named[id] })),
  );
  const rulesService = {
    get: jest.fn().mockResolvedValue(storedDto()),
    list: jest.fn().mockResolvedValue([storedDto()]),
  };
  const runService = {
    previewDraft: jest.fn().mockResolvedValue(runPreview()),
    previewRun: jest.fn().mockResolvedValue(runPreview()),
  };
  const accountsService = {
    resolveAccountFilter: jest.fn(async (_u: string, names: string[]) =>
      names.every((n) => n === "Checking")
        ? { accountIds: names.map(() => ACCOUNT_ID) }
        : { error: `Unknown account: ${names.join(", ")}` },
    ),
    findAll: jest.fn().mockResolvedValue([{ name: "Checking" }]),
  };
  const payeesService = {
    resolveByName: jest.fn(async (_u: string, name: string) =>
      name === "Netflix" ? { id: PAYEE_ID, name } : null,
    ),
  };
  const tagsService = {
    findAll: jest.fn().mockResolvedValue([
      { id: TAG_ID, name: "Subscriptions" },
      { id: "t2", name: "Groceries" },
    ]),
  };
  const service = new TransactionRuleToolPrepService(
    dataSource as unknown as DataSource,
    rulesService as never,
    runService as never,
    accountsService as never,
    payeesService as never,
    tagsService as never,
  );
  return {
    service,
    rulesService,
    runService,
    accountsService,
    payeesService,
    tagsService,
  };
}

const namedCondition = {
  all: [
    { field: "accountId", op: "eq", value: "Checking" },
    { field: "payeeId", op: "eq", value: "Netflix" },
  ],
};
const namedActions = [
  { type: "set_category", categoryName: "Bills: Streaming" },
  { type: "add_tags", tagNames: ["subscriptions"] },
];

describe("TransactionRuleToolPrepService", () => {
  describe("prepareCreate", () => {
    it("resolves the names of a split and a conversion and fills clearCategory", async () => {
      const { service, runService } = build();
      const condition = {
        all: [
          {
            field: "payeeText",
            op: "matches",
            value: "PRINCIPAL: {principal} INTEREST: {interest}*",
          },
        ],
      };
      const prep = await service.prepareCreate(USER_ID, {
        name: "Loan",
        condition,
        actions: [
          {
            type: "split",
            payeeName: "Netflix",
            parts: [
              {
                amount: "{principal}",
                transferTo: "Checking",
                payeeName: "Netflix",
              },
              { amount: "{interest}", categoryName: "Bills: Streaming" },
            ],
          },
        ],
      });
      expect(prep.ok).toBe(true);
      if (!prep.ok) return;
      expect(prep.preview.rule.actions).toEqual([
        {
          type: "split",
          payeeId: PAYEE_ID,
          parts: [
            {
              amount: "{principal}",
              transferAccountId: ACCOUNT_ID,
              payeeId: PAYEE_ID,
            },
            { amount: "{interest}", categoryId: CATEGORY_ID },
          ],
        },
      ]);
      expect(runService.previewDraft).toHaveBeenCalled();

      const converted = await service.prepareCreate(USER_ID, {
        name: "Loan",
        condition,
        actions: [{ type: "convert_to_transfer", toAccountName: "Checking" }],
      });
      expect(converted.ok && converted.preview.rule.actions).toEqual([
        {
          type: "convert_to_transfer",
          toAccountId: ACCOUNT_ID,
          clearCategory: true,
        },
      ]);
    });

    it("resolves names with the shared resolvers and tests the rule with ids", async () => {
      const { service, runService } = build();
      const prep = await service.prepareCreate(USER_ID, {
        name: "  Streaming <b> ",
        condition: namedCondition,
        actions: namedActions,
      });

      expect(prep.ok).toBe(true);
      if (!prep.ok) return;
      expect(prep.preview.rule).toEqual({
        name: "Streaming b",
        enabled: true,
        triggers: ["create", "import"],
        stopProcessing: false,
        activeFrom: null,
        activeTo: null,
        condition: VALID_CONDITION,
        actions: [
          { type: "set_category", categoryId: CATEGORY_ID, onlyIfEmpty: true },
          { type: "add_tags", tagIds: [TAG_ID] },
        ],
      });
      expect(runService.previewDraft).toHaveBeenCalledWith(
        USER_ID,
        {
          condition: VALID_CONDITION,
          actions: [
            {
              type: "set_category",
              categoryId: CATEGORY_ID,
              onlyIfEmpty: true,
            },
            { type: "add_tags", tagIds: [TAG_ID] },
          ],
          activeFrom: null,
          activeTo: null,
          filters: {},
        },
        { authoring: true },
      );
      expect(prep.preview.labels).toEqual({
        accounts: { [ACCOUNT_ID]: "Checking" },
        payees: { [PAYEE_ID]: "Netflix" },
        categories: { [CATEGORY_ID]: "Bills: Streaming" },
        tags: { [TAG_ID]: "Subscriptions" },
      });
    });

    it("carries the active window on the card and tests the draft with it", async () => {
      const { service, runService } = build();
      const prep = await service.prepareCreate(USER_ID, {
        name: "Mortgage",
        condition: namedCondition,
        actions: namedActions,
        activeFrom: "2026-10-01",
        activeTo: "2026-12-31",
      });
      if (!prep.ok) throw new Error(`expected a preview: ${prep.message}`);
      expect(prep.preview.rule).toMatchObject({
        activeFrom: "2026-10-01",
        activeTo: "2026-12-31",
      });
      expect(runService.previewDraft).toHaveBeenCalledWith(
        USER_ID,
        expect.objectContaining({
          activeFrom: "2026-10-01",
          activeTo: "2026-12-31",
        }),
        { authoring: true },
      );
    });

    it("reads an empty string as an open side", async () => {
      const { service } = build();
      const prep = await service.prepareCreate(USER_ID, {
        name: "Mortgage",
        condition: namedCondition,
        actions: namedActions,
        activeFrom: "",
        activeTo: "2026-12-31",
      });
      if (!prep.ok) throw new Error("expected a preview");
      expect(prep.preview.rule).toMatchObject({
        activeFrom: null,
        activeTo: "2026-12-31",
      });
    });

    it("refuses a window whose first day is after its last, with the draft preview's entry", async () => {
      const { service, runService } = build();
      runService.previewDraft.mockRejectedValue(
        new BadRequestException({
          message:
            "The first active date must not be after the last active date",
          errorCode: "ACTIVE_WINDOW_INVALID",
        }),
      );
      const prep = await service.prepareCreate(USER_ID, {
        name: "Mortgage",
        condition: namedCondition,
        actions: namedActions,
        activeFrom: "2026-12-31",
        activeTo: "2026-10-01",
      });
      expect(prep).toMatchObject({
        ok: false,
        errors: [{ path: "", code: "ACTIVE_WINDOW_INVALID" }],
      });
    });

    it("trims the test to the first rows and keeps the counts of all of them", async () => {
      const { service, runService } = build();
      runService.previewDraft.mockResolvedValue(
        runPreview(RULE_CARD_PREVIEW_ROWS + 5),
      );
      const prep = await service.prepareCreate(USER_ID, {
        name: "Streaming",
        condition: namedCondition,
        actions: namedActions,
      });
      if (!prep.ok) throw new Error("expected a preview");
      expect(prep.preview.test.matchedCount).toBe(RULE_CARD_PREVIEW_ROWS + 5);
      expect(prep.preview.test.rows).toHaveLength(RULE_CARD_PREVIEW_ROWS);
      expect(prep.preview.test.scanned).toBe(40);
      expect(prep.preview.test.skippedCount).toBe(1);
    });

    it("refuses an unknown name with its path and does not test the rule", async () => {
      const { service, runService } = build();
      const prep = await service.prepareCreate(USER_ID, {
        name: "Streaming",
        condition: {
          all: [{ field: "payeeId", op: "eq", value: "Nope" }],
        },
        actions: namedActions,
      });
      expect(prep).toMatchObject({
        ok: false,
        message: expect.stringContaining("Unknown payee: 'Nope'"),
        errors: [
          {
            path: "condition.all[0].value",
            code: "NAME_NOT_FOUND",
            name: "Nope",
            kind: "payees",
          },
        ],
      });
      expect(runService.previewDraft).not.toHaveBeenCalled();
    });

    it("refuses an ambiguous category and names the qualified candidates", async () => {
      const { service } = build();
      const prep = await service.prepareCreate(USER_ID, {
        name: "Streaming",
        condition: namedCondition,
        actions: [{ type: "set_category", categoryName: "Streaming" }],
      });
      expect(prep).toMatchObject({
        ok: false,
        message: expect.stringContaining("Ambiguous category: 'Streaming'"),
        errors: [
          {
            path: "actions[0].categoryName",
            code: "NAME_AMBIGUOUS",
            suggestions: expect.arrayContaining([
              "Bills: Streaming",
              "Fun: Streaming",
            ]),
          },
        ],
      });
    });

    it("suggests the closest account when a name does not resolve", async () => {
      const { service } = build();
      const prep = await service.prepareCreate(USER_ID, {
        name: "Streaming",
        condition: { field: "accountId", op: "eq", value: "Checkin" },
        actions: namedActions,
      });
      expect(prep).toMatchObject({
        ok: false,
        errors: [
          {
            code: "NAME_NOT_FOUND",
            kind: "accounts",
            suggestions: ["Checking"],
          },
        ],
      });
    });

    it("returns the validator's structured errors as they are", async () => {
      const { service, runService } = build();
      runService.previewDraft.mockRejectedValue(
        new BadRequestException({
          message: "The rule definition is not valid",
          errorCode: "INVALID_RULE",
          errors: [
            { path: "condition.all[0].op", code: "OPERATOR_NOT_ALLOWED" },
          ],
        }),
      );
      const prep = await service.prepareCreate(USER_ID, {
        name: "Streaming",
        condition: namedCondition,
        actions: namedActions,
      });
      expect(prep).toEqual({
        ok: false,
        message: "The rule definition is not valid",
        errors: [{ path: "condition.all[0].op", code: "OPERATOR_NOT_ALLOWED" }],
        hints: ["For field accountId op must be one of: eq, neq, in, notIn."],
      });
    });

    it("keeps the error code when a 4xx carries no entries", async () => {
      const { service, runService } = build();
      runService.previewDraft.mockRejectedValue(
        new BadRequestException({
          message: "range",
          errorCode: "DATE_RANGE_INVALID",
        }),
      );
      const prep = await service.prepareCreate(USER_ID, {
        name: "Streaming",
        condition: namedCondition,
        actions: namedActions,
      });
      expect(prep).toMatchObject({
        ok: false,
        errors: [{ path: "", code: "DATE_RANGE_INVALID" }],
      });
    });

    it("throws a failure that is not the caller's to fix", async () => {
      const { service, runService } = build();
      runService.previewDraft.mockRejectedValue(new Error("connection lost"));
      await expect(
        service.prepareCreate(USER_ID, {
          name: "Streaming",
          condition: namedCondition,
          actions: namedActions,
        }),
      ).rejects.toThrow("connection lost");
    });

    it.each(["", "   ", "<>", "x".repeat(101)])(
      "refuses the name %j",
      async (name) => {
        const { service, runService } = build();
        const prep = await service.prepareCreate(USER_ID, {
          name,
          condition: namedCondition,
          actions: namedActions,
        });
        expect(prep).toMatchObject({
          ok: false,
          errors: [{ path: "name", code: "INVALID_NAME" }],
        });
        expect(runService.previewDraft).not.toHaveBeenCalled();
      },
    );

    it("refuses a definition naming more than the bound of distinct names", async () => {
      const { service, payeesService } = build();
      const prep = await service.prepareCreate(USER_ID, {
        name: "Streaming",
        condition: {
          any: Array.from({ length: 4 }, (_, leaf) => ({
            field: "tagIds",
            op: "hasAny",
            value: Array.from({ length: 50 }, (_, i) => `tag-${leaf}-${i}`),
          })),
        },
        actions: namedActions,
      });
      expect(prep).toMatchObject({
        ok: false,
        errors: [{ code: "TOO_MANY_NAMES" }],
      });
      expect(payeesService.resolveByName).not.toHaveBeenCalled();
    });
  });

  describe("prepareUpdate", () => {
    it("carries the revision it read and the full resulting rule", async () => {
      const { service, runService } = build();
      const prep = await service.prepareUpdate(USER_ID, {
        ruleId: RULE_ID,
        name: "Renamed",
        actions: [{ type: "add_tags", tagNames: ["Subscriptions"] }],
      });
      if (!prep.ok) throw new Error(`expected a preview: ${prep.message}`);
      expect(prep.preview.ruleId).toBe(RULE_ID);
      expect(prep.preview.expectedRevision).toBe(3);
      expect(prep.preview.current.name).toBe("Groceries");
      expect(prep.preview.rule).toEqual({
        name: "Renamed",
        enabled: true,
        triggers: ["create", "import"],
        stopProcessing: false,
        activeFrom: null,
        activeTo: null,
        // The condition the model did not send is the stored one, ids intact.
        condition: VALID_CONDITION,
        actions: [{ type: "add_tags", tagIds: [TAG_ID] }],
      });
      expect(runService.previewDraft).toHaveBeenCalledTimes(1);
      expect(prep.preview.test).toBeDefined();
    });

    describe("a stored rule whose pattern predates the authoring advice", () => {
      const OLD_CONDITION = {
        field: "description",
        op: "matches",
        value: "NETFLIX.COM",
      };

      // The stub validates the draft with the option the service passes, as
      // the real previewDraft does.
      function withValidatingPreview() {
        const built = build();
        built.rulesService.get.mockResolvedValue(
          storedDto({ condition: OLD_CONDITION as never }),
        );
        built.runService.previewDraft.mockImplementation(
          async (
            _userId: string,
            dto: { condition: unknown; actions: unknown },
            options?: { authoring?: boolean },
          ) => {
            const errors = validateRuleDefinition(
              { condition: dto.condition, actions: dto.actions },
              { authoring: options?.authoring ?? true },
            );
            if (errors.length > 0) {
              throw new BadRequestException({
                message: "The rule definition is not valid",
                errorCode: "INVALID_RULE",
                errors,
              });
            }
            return runPreview();
          },
        );
        return built;
      }

      it("builds a card for an update of the actions alone", async () => {
        const { service, runService } = withValidatingPreview();
        const prep = await service.prepareUpdate(USER_ID, {
          ruleId: RULE_ID,
          actions: [{ type: "add_tags", tagNames: ["Subscriptions"] }],
        });
        if (!prep.ok) throw new Error(`expected a preview: ${prep.message}`);
        expect(prep.preview.rule.condition).toEqual(OLD_CONDITION);
        expect(runService.previewDraft).toHaveBeenCalledWith(
          USER_ID,
          expect.anything(),
          { authoring: false },
        );
      });

      it("refuses an update that changes the condition to such a pattern", async () => {
        const { service, runService } = withValidatingPreview();
        const prep = await service.prepareUpdate(USER_ID, {
          ruleId: RULE_ID,
          condition: { field: "description", op: "matches", value: "HBO.COM" },
        });
        expect(prep).toMatchObject({
          ok: false,
          errors: [
            { path: "condition.value", code: "PATTERN_WITHOUT_WILDCARD" },
          ],
        });
        expect(runService.previewDraft).toHaveBeenCalledWith(
          USER_ID,
          expect.anything(),
          { authoring: true },
        );
      });

      it("keeps the advice off when the condition is sent back unchanged", async () => {
        const { service } = withValidatingPreview();
        const prep = await service.prepareUpdate(USER_ID, {
          ruleId: RULE_ID,
          condition: OLD_CONDITION,
          actions: [{ type: "add_tags", tagNames: ["Subscriptions"] }],
        });
        expect(prep.ok).toBe(true);
      });
    });

    it("tests a moved window although condition and actions are untouched", async () => {
      const { service, runService } = build();
      const prep = await service.prepareUpdate(USER_ID, {
        ruleId: RULE_ID,
        activeFrom: "2026-10-01",
      });
      if (!prep.ok) throw new Error("expected a preview");
      expect(prep.preview.rule).toMatchObject({
        activeFrom: "2026-10-01",
        activeTo: null,
      });
      expect(prep.preview.current).toMatchObject({ activeFrom: null });
      expect(prep.preview.test).toBeDefined();
      expect(runService.previewDraft).toHaveBeenCalledWith(
        USER_ID,
        expect.objectContaining({ activeFrom: "2026-10-01", activeTo: null }),
        { authoring: false },
      );
    });

    it("clears one side of a stored window with an empty string and keeps the other", async () => {
      const { service, rulesService } = build();
      rulesService.get.mockResolvedValue(
        storedDto({ activeFrom: "2026-10-01", activeTo: "2026-12-31" }),
      );
      const prep = await service.prepareUpdate(USER_ID, {
        ruleId: RULE_ID,
        activeTo: "",
      });
      if (!prep.ok) throw new Error("expected a preview");
      expect(prep.preview.rule).toMatchObject({
        activeFrom: "2026-10-01",
        activeTo: null,
      });
    });

    it("refuses an edit that sends the stored window back", async () => {
      const { service, rulesService } = build();
      rulesService.get.mockResolvedValue(
        storedDto({ activeFrom: "2026-10-01" }),
      );
      const prep = await service.prepareUpdate(USER_ID, {
        ruleId: RULE_ID,
        activeFrom: "2026-10-01",
      });
      expect(prep).toMatchObject({ ok: false, errors: [] });
    });

    it("does not test a change that leaves condition and actions alone", async () => {
      const { service, runService } = build();
      const prep = await service.prepareUpdate(USER_ID, {
        ruleId: RULE_ID,
        enabled: false,
      });
      if (!prep.ok) throw new Error("expected a preview");
      expect(prep.preview.rule.enabled).toBe(false);
      expect(prep.preview.test).toBeUndefined();
      expect(runService.previewDraft).not.toHaveBeenCalled();
    });

    it("refuses an edit that sends the stored values back", async () => {
      const { service, runService } = build();
      const prep = await service.prepareUpdate(USER_ID, {
        ruleId: RULE_ID,
        name: "Groceries",
        triggers: ["create", "import"],
        condition: namedCondition,
        actions: [
          { type: "set_category", categoryName: "Bills: Streaming" },
          { type: "add_tags", tagNames: ["Subscriptions"] },
        ],
      });
      expect(prep).toMatchObject({
        ok: false,
        message: expect.stringContaining("nothing to change"),
      });
      expect(runService.previewDraft).toHaveBeenCalledTimes(0);
    });

    it("refuses a rule that does not exist", async () => {
      const { service, rulesService } = build();
      rulesService.get.mockRejectedValue(new NotFoundException("gone"));
      const prep = await service.prepareUpdate(USER_ID, {
        ruleId: RULE_ID,
        name: "x",
      });
      expect(prep).toMatchObject({ ok: false, message: "gone" });
    });

    it("asks for a ruleId when none was given", async () => {
      const { service, rulesService } = build();
      const prep = await service.prepareUpdate(USER_ID, { name: "x" });
      expect(prep).toMatchObject({
        ok: false,
        errors: [{ path: "ruleId", code: "VALUE_REQUIRED" }],
      });
      expect(rulesService.get).not.toHaveBeenCalled();
    });
  });

  describe("prepareDelete", () => {
    it("names the rule and the revision it showed", async () => {
      const { service } = build();
      const prep = await service.prepareDelete(USER_ID, { ruleId: RULE_ID });
      if (!prep.ok) throw new Error("expected a preview");
      expect(prep.preview.expectedRevision).toBe(3);
      expect(prep.preview.rule.name).toBe("Groceries");
      expect(prep.preview.labels.categories[CATEGORY_ID]).toBe(
        "Bills: Streaming",
      );
    });
  });

  describe("prepareRun", () => {
    it("carries the plan's fingerprint and the resolved filters", async () => {
      const { service, runService } = build();
      const prep = await service.prepareRun(
        USER_ID,
        { ruleId: RULE_ID },
        {
          accountNames: ["Checking"],
          startDate: "2026-01-01",
          endDate: "2026-06-30",
          limit: 50,
        },
      );
      if (!prep.ok) throw new Error("expected a preview");
      const filters = {
        accountIds: [ACCOUNT_ID],
        startDate: "2026-01-01",
        endDate: "2026-06-30",
        limit: 50,
      };
      expect(runService.previewRun).toHaveBeenCalledWith(
        USER_ID,
        RULE_ID,
        filters,
      );
      expect(prep.preview).toMatchObject({
        ruleId: RULE_ID,
        fingerprint: "f".repeat(64),
        filters,
      });
      expect(prep.preview.labels.accounts[ACCOUNT_ID]).toBe("Checking");
    });

    it("refuses a run that would change nothing instead of offering a card for it", async () => {
      const { service, runService } = build();
      runService.previewRun.mockResolvedValue({
        ...runPreview(0),
        scanned: 12,
      });
      const prep = await service.prepareRun(USER_ID, { ruleId: RULE_ID }, {});
      expect(prep).toMatchObject({
        ok: false,
        message: expect.stringContaining("no transactions (12 examined"),
      });
    });

    it("refuses a rule that cannot run with the run service's entries", async () => {
      const { service, runService } = build();
      runService.previewRun.mockRejectedValue(
        new BadRequestException({
          message: "not valid",
          errorCode: "INVALID_RULE",
          errors: [{ path: "actions[0]", code: "REFERENCE_NOT_FOUND" }],
        }),
      );
      const prep = await service.prepareRun(USER_ID, { ruleId: RULE_ID }, {});
      expect(prep).toMatchObject({
        ok: false,
        errors: [{ path: "actions[0]", code: "REFERENCE_NOT_FOUND" }],
      });
    });

    it("refuses an unknown account without previewing", async () => {
      const { service, runService } = build();
      const prep = await service.prepareRun(
        USER_ID,
        { ruleId: RULE_ID },
        { accountNames: ["Nowhere"] },
      );
      expect(prep).toMatchObject({
        ok: false,
        errors: [{ path: "accountNames", code: "NAME_NOT_FOUND" }],
      });
      expect(runService.previewRun).not.toHaveBeenCalled();
    });
  });

  describe("prepareTest", () => {
    it("tests a draft through the draft preview and nothing else", async () => {
      const { service, runService, rulesService } = build();
      const prep = await service.prepareTest(
        USER_ID,
        { condition: namedCondition, actions: namedActions },
        { accountNames: ["Checking"], limit: 20 },
      );
      if (!prep.ok) throw new Error("expected a result");
      expect(prep.preview.ruleId).toBeUndefined();
      expect(runService.previewDraft).toHaveBeenCalledWith(
        USER_ID,
        expect.objectContaining({
          filters: { accountIds: [ACCOUNT_ID], limit: 20 },
        }),
        { authoring: true },
      );
      expect(runService.previewRun).not.toHaveBeenCalled();
      expect(rulesService.get).not.toHaveBeenCalled();
    });

    it("tests a saved rule with a replaced window as a draft built on it", async () => {
      const { service, runService } = build();
      const prep = await service.prepareTest(
        USER_ID,
        { ruleId: RULE_ID, activeFrom: "2026-10-01" },
        {},
      );
      if (!prep.ok) throw new Error("expected a result");
      expect(runService.previewRun).not.toHaveBeenCalled();
      expect(runService.previewDraft).toHaveBeenCalledWith(
        USER_ID,
        expect.objectContaining({
          condition: VALID_CONDITION,
          actions: VALID_ACTIONS,
          activeFrom: "2026-10-01",
          activeTo: null,
        }),
        { authoring: false },
      );
      expect(prep.preview.rule.activeFrom).toBe("2026-10-01");
    });

    it("tests a draft built on a saved rule with that rule's window", async () => {
      const { service, runService, rulesService } = build();
      rulesService.get.mockResolvedValue(
        storedDto({ activeFrom: "2026-10-01", activeTo: "2026-12-31" }),
      );
      const prep = await service.prepareTest(
        USER_ID,
        {
          ruleId: RULE_ID,
          condition: { field: "payeeId", op: "eq", value: "Netflix" },
        },
        {},
      );
      if (!prep.ok) throw new Error("expected a result");
      expect(runService.previewDraft).toHaveBeenCalledWith(
        USER_ID,
        expect.objectContaining({
          activeFrom: "2026-10-01",
          activeTo: "2026-12-31",
        }),
        expect.anything(),
      );
    });

    it("tests a saved rule through the run preview", async () => {
      const { service, runService } = build();
      const prep = await service.prepareTest(USER_ID, { ruleId: RULE_ID }, {});
      if (!prep.ok) throw new Error("expected a result");
      expect(prep.preview.ruleId).toBe(RULE_ID);
      expect(runService.previewRun).toHaveBeenCalledWith(USER_ID, RULE_ID, {});
      expect(runService.previewDraft).not.toHaveBeenCalled();
    });

    it("tests a saved rule with a replaced condition as a draft built on it", async () => {
      const { service, runService } = build();
      const prep = await service.prepareTest(
        USER_ID,
        {
          ruleId: RULE_ID,
          condition: { field: "payeeId", op: "eq", value: "Netflix" },
        },
        {},
      );
      if (!prep.ok) throw new Error("expected a result");
      expect(runService.previewDraft).toHaveBeenCalledWith(
        USER_ID,
        expect.objectContaining({
          condition: { field: "payeeId", op: "eq", value: PAYEE_ID },
          actions: VALID_ACTIONS,
        }),
        { authoring: true },
      );
      expect(prep.preview.rule.name).toBe("Groceries");
    });

    describe("a stored rule whose pattern predates the authoring advice", () => {
      const OLD_CONDITION = {
        field: "description",
        op: "matches",
        value: "NETFLIX.COM",
      };

      // The stub validates the draft with the option the service passes, as
      // the real previewDraft does.
      function withValidatingPreview() {
        const built = build();
        built.rulesService.get.mockResolvedValue(
          storedDto({ condition: OLD_CONDITION as never }),
        );
        built.runService.previewDraft.mockImplementation(
          async (
            _userId: string,
            dto: { condition: unknown; actions: unknown },
            options?: { authoring?: boolean },
          ) => {
            const errors = validateRuleDefinition(
              { condition: dto.condition, actions: dto.actions },
              { authoring: options?.authoring ?? true },
            );
            if (errors.length > 0) {
              throw new BadRequestException({
                message: "The rule definition is not valid",
                errorCode: "INVALID_RULE",
                errors,
              });
            }
            return runPreview();
          },
        );
        return built;
      }

      it("tests new actions on the unchanged condition", async () => {
        const { service, runService } = withValidatingPreview();
        const prep = await service.prepareTest(
          USER_ID,
          {
            ruleId: RULE_ID,
            actions: [{ type: "add_tags", tagNames: ["Subscriptions"] }],
          },
          {},
        );
        if (!prep.ok) throw new Error(`expected a result: ${prep.message}`);
        expect(prep.preview.rule.condition).toEqual(OLD_CONDITION);
        expect(runService.previewDraft).toHaveBeenCalledWith(
          USER_ID,
          expect.anything(),
          { authoring: false },
        );
      });

      it("tests the same condition sent back unchanged", async () => {
        const { service, runService } = withValidatingPreview();
        const prep = await service.prepareTest(
          USER_ID,
          { ruleId: RULE_ID, condition: OLD_CONDITION },
          {},
        );
        expect(prep.ok).toBe(true);
        expect(runService.previewDraft).toHaveBeenCalledWith(
          USER_ID,
          expect.anything(),
          { authoring: false },
        );
      });

      it("refuses a test that changes the condition to such a pattern", async () => {
        const { service, runService } = withValidatingPreview();
        const prep = await service.prepareTest(
          USER_ID,
          {
            ruleId: RULE_ID,
            condition: {
              field: "description",
              op: "matches",
              value: "HBO.COM",
            },
          },
          {},
        );
        expect(prep).toMatchObject({
          ok: false,
          errors: [
            { path: "condition.value", code: "PATTERN_WITHOUT_WILDCARD" },
          ],
        });
        expect(runService.previewDraft).toHaveBeenCalledWith(
          USER_ID,
          expect.anything(),
          { authoring: true },
        );
      });

      it("still applies the advice to a draft with no ruleId", async () => {
        const { service, runService } = withValidatingPreview();
        const prep = await service.prepareTest(
          USER_ID,
          {
            condition: OLD_CONDITION,
            actions: [{ type: "add_tags", tagNames: ["Subscriptions"] }],
          },
          {},
        );
        expect(prep).toMatchObject({
          ok: false,
          errors: [
            { path: "condition.value", code: "PATTERN_WITHOUT_WILDCARD" },
          ],
        });
        expect(runService.previewDraft).toHaveBeenCalledWith(
          USER_ID,
          expect.anything(),
          { authoring: true },
        );
      });
    });
  });

  describe("toLlmTest", () => {
    it("names the category, payee and tag ids in each change", async () => {
      const { service } = build();
      const prep = await service.prepareTest(USER_ID, { ruleId: RULE_ID }, {});
      if (!prep.ok) throw new Error("expected a result");
      const llm = service.toLlmTest(prep.preview.test, prep.preview.labels);
      expect(llm.matchedCount).toBe(2);
      expect(llm.rows[0].changes).toEqual({
        category: { before: null, after: "Bills: Streaming" },
        tags: { before: [], after: ["Subscriptions"] },
      });
      expect(llm.skipped).toEqual([
        { transactionId: "t-x", reason: "reconciled_locked" },
      ]);
    });
  });

  describe("toLlmTest: a planned structure", () => {
    const LOAN = "a0000000-0000-4000-8000-0000000000a1";
    const INTEREST = "c0000000-0000-4000-8000-0000000000c1";
    const OVERPAY = "b0000000-0000-4000-8000-0000000000b1";
    const base = {
      matchedCount: 1,
      conditionMatchedCount: 1,
      scanned: 5,
      truncated: false,
      skipped: [],
      skippedCount: 0,
      aiReviewRequests: 0,
      labels: {
        accounts: { [LOAN]: "Loan account" },
        payees: { [OVERPAY]: "Loan overpayment" },
        categories: { [INTEREST]: "Loans: Interest" },
        tags: {},
        rules: {},
      },
    };
    const rowWith = (structure: unknown) => ({
      transactionId: "t1",
      date: "2026-10-05",
      payeeName: "x",
      amount: -1500.75,
      currencyCode: "PLN",
      changes: { structure: { before: null, after: structure } },
    });

    it("names the accounts, categories and payees of a split's parts", () => {
      const { service } = build();
      const llm = service.toLlmTest(
        {
          ...base,
          rows: [
            rowWith({
              kind: "split",
              parts: [
                {
                  amount: -1200.5,
                  categoryId: null,
                  transferAccountId: LOAN,
                  payeeId: OVERPAY,
                  memo: null,
                },
                {
                  amount: -300.25,
                  categoryId: INTEREST,
                  transferAccountId: null,
                  payeeId: null,
                  memo: "interest",
                },
              ],
            }),
          ],
        } as never,
        base.labels as never,
      );
      expect(llm.rows[0].changes).toEqual({
        structure: {
          kind: "split",
          parts: [
            {
              amount: -1200.5,
              category: null,
              transferTo: "Loan account",
              payee: "Loan overpayment",
              memo: null,
            },
            {
              amount: -300.25,
              category: "Loans: Interest",
              transferTo: null,
              payee: null,
              memo: "interest",
            },
          ],
        },
      });
    });

    it("names the account of a transfer and keeps the id of one it has no name for", () => {
      const { service } = build();
      const llm = service.toLlmTest(
        {
          ...base,
          rows: [
            rowWith({ kind: "transfer", accountId: LOAN, clearCategory: true }),
            rowWith({
              kind: "transfer",
              accountId: "gone",
              clearCategory: false,
            }),
          ],
        } as never,
        base.labels as never,
      );
      expect(llm.rows.map((r) => r.changes.structure)).toEqual([
        { kind: "transfer", account: "Loan account", clearCategory: true },
        { kind: "transfer", account: "gone", clearCategory: false },
      ]);
    });
  });

  describe("a test that matches nothing", () => {
    const empty = {
      matchedCount: 0,
      conditionMatchedCount: 0,
      scanned: 40,
      truncated: false,
      rows: [],
      skipped: [],
      skippedCount: 0,
      aiReviewRequests: 0,
      labels: { accounts: {}, payees: {}, categories: {}, tags: {}, rules: {} },
    };

    it("states it plainly for the model, with the advice to re-check", () => {
      const { service } = build();
      const llm = service.toLlmTest(empty, empty.labels as never);
      expect(llm.message).toContain(
        "This rule matches none of the 40 latest transactions.",
      );
      expect(llm.message).toContain("usually wrong");
      expect(llm.message).toContain("without * equals the whole text");
    });

    it("says nothing when it matched something, or when nothing was examined", () => {
      const { service } = build();
      expect(
        service.toLlmTest(
          { ...empty, matchedCount: 1, conditionMatchedCount: 1 },
          empty.labels as never,
        ).message,
      ).toBeUndefined();
      expect(
        service.toLlmTest({ ...empty, scanned: 0 }, empty.labels as never)
          .message,
      ).toBeUndefined();
    });
  });

  describe("a test whose condition matches but changes nothing", () => {
    const already = {
      matchedCount: 0,
      conditionMatchedCount: 7,
      scanned: 40,
      truncated: false,
      rows: [],
      skipped: [],
      skippedCount: 0,
      aiReviewRequests: 0,
      labels: { accounts: {}, payees: {}, categories: {}, tags: {}, rules: {} },
    };

    it("is not a zero-match warning: the model is told nothing would change, and that it is not an error", () => {
      const { service } = build();
      const llm = service.toLlmTest(already, already.labels as never);
      expect(llm.conditionMatchedCount).toBe(7);
      expect(llm.message).toContain(
        "The condition matches 7 of the 40 latest transactions, but nothing would change",
      );
      expect(llm.message).toContain("only-if-empty");
      expect(llm.message).toContain("not an error");
      expect(llm.message).not.toContain("matches none");
      expect(llm.message).not.toContain("usually wrong");
    });

    it("does not call a request_ai_review-only rule wrong", () => {
      // An AI-review-only rule has matchedCount 0 by construction; only the
      // condition count says whether the rule is wrong.
      const { service } = build();
      const llm = service.toLlmTest(
        { ...already, aiReviewRequests: 7 },
        already.labels as never,
      );
      expect(llm.message).not.toContain("matches none");
    });

    it("still warns when the condition matched nothing, and stays silent when the count is absent", () => {
      const { service } = build();
      expect(
        service.toLlmTest(
          { ...already, conditionMatchedCount: 0 },
          already.labels as never,
        ).message,
      ).toContain("matches none of the 40");
      expect(
        service.toLlmTest(
          { ...already, conditionMatchedCount: undefined } as never,
          already.labels as never,
        ).message,
      ).toBeUndefined();
    });
  });

  describe("list", () => {
    it("returns rules in the name form the tools accept back", async () => {
      const { service } = build();
      const list = await service.list(USER_ID);
      expect(list.totalCount).toBe(1);
      expect(list.truncated).toBe(false);
      expect(list.rules[0]).toMatchObject({
        id: RULE_ID,
        revision: 3,
        condition: {
          all: [
            { field: "accountId", op: "eq", value: "Checking" },
            { field: "payeeId", op: "eq", value: "Netflix" },
          ],
        },
        actions: [
          {
            type: "set_category",
            categoryName: "Bills: Streaming",
            onlyIfEmpty: true,
          },
          { type: "add_tags", tagNames: ["Subscriptions"] },
        ],
        invalid: false,
      });
    });

    it("returns the active window of each rule", async () => {
      const { service, rulesService } = build();
      rulesService.list.mockResolvedValue([
        storedDto({ activeFrom: "2026-10-01", activeTo: null }),
      ]);
      const list = await service.list(USER_ID);
      expect(list.rules[0]).toMatchObject({
        activeFrom: "2026-10-01",
        activeTo: null,
      });
    });

    it("says how many it left out, filters by name, and leaves an invalid rule as stored", async () => {
      const { service, rulesService } = build();
      rulesService.list.mockResolvedValue([
        storedDto({ id: "r1", name: "Alpha" }),
        storedDto({ id: "r2", name: "Beta" }),
        storedDto({
          id: "r3",
          name: "Broken",
          condition: {} as never,
          actions: [],
          invalid: true,
          invalidReasons: [{ path: "condition", code: "INVALID_SHAPE" }],
        }),
      ]);
      const page = await service.list(USER_ID, { limit: 1 });
      expect(page).toMatchObject({ totalCount: 3, truncated: true });
      expect(page.rules).toHaveLength(1);

      const search = await service.list(USER_ID, { search: "BRO" });
      expect(search.rules).toEqual([
        expect.objectContaining({
          id: "r3",
          condition: {},
          invalid: true,
          invalidReasons: [{ path: "condition", code: "INVALID_SHAPE" }],
        }),
      ]);
    });
  });
});
