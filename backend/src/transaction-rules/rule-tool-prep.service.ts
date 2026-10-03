import { forwardRef, HttpException, Inject, Injectable } from "@nestjs/common";
import { isDeepStrictEqual } from "node:util";
import { DataSource } from "typeorm";
import { AccountsService } from "../accounts/accounts.service";
import {
  AiActionRuleState,
  AiActionRuleTestPreview,
  RULE_CARD_PREVIEW_ROWS,
  RuleRunFiltersDescriptor,
} from "../ai/actions/ai-action.types";
import { Category } from "../categories/entities/category.entity";
import {
  resolveCategoryNamePaths,
  suggestQualifiedCategoryNames,
} from "../categories/category-name.util";
import { withScopedDb } from "../common/db/scoped-db";
import { suggestClosestNames } from "../common/name-suggestions.util";
import { PayeesService } from "../payees/payees.service";
import { TagsService } from "../tags/tags.service";
import { RuleAction } from "./rule-action.types";
import { RuleConditionNode } from "./rule-condition.types";
import {
  EMPTY_RULE_LABELS,
  RuleDefinitionLabels,
  loadRuleLabels,
  mergeRuleLabels,
} from "./rule-labels";
import {
  NameLookup,
  NameResolution,
  RuleNameKind,
  RuleToolError,
  collectNamedReferences,
  idsToNames,
  namesToIds,
} from "./rule-name-mapping";
import { withActionDefaults } from "./rule-references";
import type { RuleStructurePlan } from "./rule-structure";
import { RuleHintDefinition, ruleErrorHints } from "./rule-validation-hints";
import { RuleRunPreview } from "./rule-run.types";
import {
  MAX_RULE_NAME_LENGTH,
  MIN_RULE_NAME_LENGTH,
} from "./dto/create-transaction-rule.dto";
import { RuleDefinition, collectReferencedIds } from "./rule-validation";
import { RULE_TRIGGERS, RuleTrigger } from "./rule-trigger.types";
import { TransactionRulesRunService } from "./transaction-rules-run.service";
import { TransactionRulesService } from "./transaction-rules.service";
import { TransactionRuleResponseDto } from "./dto/transaction-rule-response.dto";
import {
  DEFAULT_RULE_TOOL_LIST_LIMIT,
  MAX_RULE_TOOL_LIST_LIMIT,
} from "./transaction-rules.limits";

/** Distinct names one definition may ask this service to resolve. */
const MAX_RULE_TOOL_NAMES = 200;

/**
 * What a model supplies for a rule. `condition` and `actions` are in the name
 * form (`rule-name-mapping.ts`): names where the stored rule has ids.
 */
export interface RuleToolInput {
  ruleId?: string;
  name?: string;
  enabled?: boolean;
  triggers?: RuleTrigger[];
  stopProcessing?: boolean;
  /** The active window, `YYYY-MM-DD` (INV-RULE-004); null clears a side, absent leaves it. */
  activeFrom?: string | null;
  activeTo?: string | null;
  condition?: Record<string, unknown>;
  actions?: Record<string, unknown>[];
}

/** Which existing transactions a run or a test looks at, accounts by name. */
export interface RuleToolRunInput {
  accountNames?: string[];
  startDate?: string;
  endDate?: string;
  limit?: number;
}

/** A refusal the model can act on: a message and the structured entries behind it. */
export interface RuleToolRefusal {
  ok: false;
  message: string;
  errors: RuleToolError[];
  /** One short sentence per distinct problem: what is wrong and the correct form. */
  hints?: string[];
}

export type RulePrep<T> = { ok: true; preview: T } | RuleToolRefusal;

export interface CreateRulePreview {
  rule: AiActionRuleState;
  labels: RuleDefinitionLabels;
  test: AiActionRuleTestPreview;
}

export interface UpdateRulePreview {
  ruleId: string;
  expectedRevision: number;
  rule: AiActionRuleState;
  current: AiActionRuleState;
  labels: RuleDefinitionLabels;
  /** Absent when the edit leaves condition and actions alone. */
  test?: AiActionRuleTestPreview;
}

export interface DeleteRulePreview {
  ruleId: string;
  expectedRevision: number;
  rule: AiActionRuleState;
  labels: RuleDefinitionLabels;
}

export interface RunRulePreview {
  ruleId: string;
  rule: AiActionRuleState;
  labels: RuleDefinitionLabels;
  filters: RuleRunFiltersDescriptor;
  /** The plan's hash; the commit refuses when the plan no longer matches it. */
  fingerprint: string;
  test: AiActionRuleTestPreview;
}

export interface TestRulePreview {
  /** Absent for a draft. */
  ruleId?: string;
  rule: AiActionRuleState;
  labels: RuleDefinitionLabels;
  filters: RuleRunFiltersDescriptor;
  test: AiActionRuleTestPreview;
}

/** A rule as a model reads it: names, not ids. */
export interface LlmRule {
  id: string;
  name: string;
  enabled: boolean;
  position: number;
  triggers: RuleTrigger[];
  stopProcessing: boolean;
  activeFrom: string | null;
  activeTo: string | null;
  revision: number;
  condition: unknown;
  actions: unknown[];
  invalid: boolean;
  invalidReasons: { path: string; code: string }[];
}

export interface LlmRuleList {
  rules: LlmRule[];
  totalCount: number;
  truncated: boolean;
}

/** One row of a test result, with the ids in its changes named. */
export interface LlmRuleTestRow {
  transactionId: string;
  date: string;
  payeeName: string | null;
  amount: number;
  currencyCode: string;
  changes: {
    category?: { before: string | null; after: string | null };
    payee?: { before: string | null; after: string | null };
    tags?: { before: string[]; after: string[] };
    /** A structural action's plan with names: the parts a split makes, or the transfer's account. */
    structure?: LlmRuleStructure;
  };
}

export type LlmRuleStructure =
  | { kind: "transfer"; account: string; clearCategory: boolean }
  | {
      kind: "split";
      parts: {
        amount: number;
        category: string | null;
        transferTo: string | null;
        payee: string | null;
        memo: string | null;
      }[];
    };

export interface LlmRuleTest {
  /** Set when the test matched nothing: what that usually means and what to do. */
  message?: string;
  matchedCount: number;
  /** Transactions whose rule condition matched, changed or not. */
  conditionMatchedCount: number;
  scanned: number;
  truncated: boolean;
  rows: LlmRuleTestRow[];
  skippedCount: number;
  skipped: { transactionId: string; reason: string }[];
}

/**
 * The plain statement a rule whose CONDITION matches nothing deserves, for the
 * model and the person reading the card. `null` when the condition matched
 * something (even if no action would change it), when the count is absent
 * (no information), or when there was nothing to match against (an empty
 * ledger says nothing about the rule).
 */
export function zeroMatchWarning(test: {
  conditionMatchedCount?: number;
  scanned: number;
}): string | null {
  if (test.conditionMatchedCount !== 0 || test.scanned === 0) return null;
  return `This rule matches none of the ${test.scanned} latest transactions.`;
}

/** Appended for the model: a condition that matches nothing is usually wrong. */
export const ZERO_MATCH_ADVICE =
  "A rule that matches nothing is usually wrong: re-check the field, operator and pattern (a matches pattern without * equals the whole text; use contains for a part) and test again before asking the user to confirm.";

/**
 * The condition matched but no row would change: not an error, so it carries
 * no advice to rewrite the rule.
 */
export function noChangeNote(test: {
  matchedCount: number;
  conditionMatchedCount?: number;
  scanned: number;
}): string | null {
  const matched = test.conditionMatchedCount ?? 0;
  if (matched === 0 || test.matchedCount !== 0) return null;
  return `The condition matches ${matched} of the ${test.scanned} latest transactions, but nothing would change (for example they already have the value and only-if-empty is on, or they are locked or reconciled). This is not an error.`;
}

/** Zero-match warning plus advice, or the no-change note, or an empty string. */
export function zeroMatchNote(test: {
  matchedCount: number;
  conditionMatchedCount?: number;
  scanned: number;
}): string {
  const warning = zeroMatchWarning(test);
  return warning
    ? `${warning} ${ZERO_MATCH_ADVICE}`
    : (noChangeNote(test) ?? "");
}

const sanitizeName = (value: string): string =>
  value.replace(/[<>]/g, "").trim();

/**
 * Name resolution, validation and previews for the `manage_transaction_rules`
 * and `list_transaction_rules` tools. Both tool surfaces (the AI Assistant's
 * executor and the MCP server) delegate here, so they stay thin adapters with
 * identical behaviour.
 *
 * A refusal a model can act on (an unknown name, an invalid definition, a stale
 * rule) is returned as a {@link RuleToolRefusal} carrying the same structured
 * `{ path, code }` entries the REST API answers with; nothing is written and no
 * card is built. Anything else, including a 5xx, is thrown.
 */
@Injectable()
export class TransactionRuleToolPrepService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly rulesService: TransactionRulesService,
    private readonly runService: TransactionRulesRunService,
    @Inject(forwardRef(() => AccountsService))
    private readonly accountsService: AccountsService,
    @Inject(forwardRef(() => PayeesService))
    private readonly payeesService: PayeesService,
    private readonly tagsService: TagsService,
  ) {}

  /** The user's rules in the name form a model reads and can send back. */
  async list(
    userId: string,
    options: { ruleId?: string; search?: string; limit?: number } = {},
  ): Promise<LlmRuleList> {
    const all = await this.rulesService.list(userId);
    const needle = options.search?.trim().toLowerCase();
    const matching = all.filter(
      (rule) =>
        (!options.ruleId || rule.id === options.ruleId) &&
        (!needle || rule.name.toLowerCase().includes(needle)),
    );
    const take = Math.min(
      Math.max(Math.trunc(options.limit ?? DEFAULT_RULE_TOOL_LIST_LIMIT), 1),
      MAX_RULE_TOOL_LIST_LIMIT,
    );
    const page = matching.slice(0, take);
    const labels = await this.labelsFor(userId, page);
    return {
      rules: page.map((rule) => this.toLlmRule(rule, labels)),
      totalCount: matching.length,
      truncated: matching.length > page.length,
    };
  }

  async prepareCreate(
    userId: string,
    raw: RuleToolInput,
  ): Promise<RulePrep<CreateRulePreview>> {
    const input = withWindowCleared(raw);
    const name = this.checkedName(input.name);
    if (!name.ok) return name;
    const definition = await this.resolveDefinition(
      userId,
      input.condition,
      input.actions,
    );
    if (!definition.ok) return definition;

    const rule: AiActionRuleState = {
      name: name.value,
      enabled: input.enabled ?? true,
      triggers: input.triggers ?? [...RULE_TRIGGERS],
      stopProcessing: input.stopProcessing ?? false,
      activeFrom: input.activeFrom ?? null,
      activeTo: input.activeTo ?? null,
      ...definition.value,
    };
    const tested = await this.testDraft(userId, rule, {});
    if (!tested.ok) return tested;
    return {
      ok: true,
      preview: {
        rule,
        labels: await this.labelsForDefinition(userId, definition.value),
        test: tested.value.test,
      },
    };
  }

  async prepareUpdate(
    userId: string,
    raw: RuleToolInput,
  ): Promise<RulePrep<UpdateRulePreview>> {
    const input = withWindowCleared(raw);
    const stored = await this.loadRule(userId, input.ruleId);
    if (!stored.ok) return stored;
    const current = toState(stored.value);

    let name = current.name;
    if (input.name !== undefined) {
      const checked = this.checkedName(input.name);
      if (!checked.ok) return checked;
      name = checked.value;
    }
    let definition = {
      condition: current.condition,
      actions: current.actions,
    };
    const redefined =
      input.condition !== undefined || input.actions !== undefined;
    if (redefined) {
      const resolved = await this.resolveDefinition(
        userId,
        input.condition ?? this.namesOf(current, stored.labels).condition,
        input.actions ?? this.namesOf(current, stored.labels).actions,
      );
      if (!resolved.ok) return resolved;
      definition = resolved.value;
    }
    const rule: AiActionRuleState = {
      name,
      enabled: input.enabled ?? current.enabled,
      triggers: input.triggers ?? current.triggers,
      stopProcessing: input.stopProcessing ?? current.stopProcessing,
      // null clears a side of the window; absent leaves it as stored.
      activeFrom:
        input.activeFrom === undefined ? current.activeFrom : input.activeFrom,
      activeTo:
        input.activeTo === undefined ? current.activeTo : input.activeTo,
      ...definition,
    };
    // A change is a value difference, not a field being present.
    if (isDeepStrictEqual(rule, current)) {
      return refusal(
        "The rule already has these values, so there is nothing to change.",
      );
    }

    // A moved window changes which rows the rule reaches, so it is tested too
    // (and its order is checked before the card is built).
    const windowMoved =
      rule.activeFrom !== current.activeFrom ||
      rule.activeTo !== current.activeTo;
    let test: AiActionRuleTestPreview | undefined;
    if (redefined || windowMoved) {
      // The same decision the REST update makes: the glob-trap advice applies
      // only when the condition changes, so a stored rule that predates it can
      // still have its actions edited.
      const authoring = !isDeepStrictEqual(rule.condition, current.condition);
      const tested = await this.testDraft(userId, rule, {}, authoring);
      if (!tested.ok) return tested;
      test = tested.value.test;
    }
    return {
      ok: true,
      preview: {
        ruleId: stored.value.id,
        expectedRevision: stored.value.revision,
        rule,
        current,
        labels: mergeRuleLabels(
          stored.labels,
          await this.labelsForDefinition(userId, definition),
        ),
        ...(test ? { test } : {}),
      },
    };
  }

  async prepareDelete(
    userId: string,
    input: RuleToolInput,
  ): Promise<RulePrep<DeleteRulePreview>> {
    const stored = await this.loadRule(userId, input.ruleId);
    if (!stored.ok) return stored;
    return {
      ok: true,
      preview: {
        ruleId: stored.value.id,
        expectedRevision: stored.value.revision,
        rule: toState(stored.value),
        labels: stored.labels,
      },
    };
  }

  /**
   * What running a saved rule on existing transactions would change, with the
   * fingerprint the commit must echo. A run that would change nothing is
   * refused: a card offering it would be an approval for nothing.
   */
  async prepareRun(
    userId: string,
    input: RuleToolInput,
    run: RuleToolRunInput,
  ): Promise<RulePrep<RunRulePreview>> {
    const stored = await this.loadRule(userId, input.ruleId);
    if (!stored.ok) return stored;
    const filters = await this.resolveFilters(userId, run);
    if (!filters.ok) return filters;
    const planned = await this.guard(async () =>
      this.runService.previewRun(userId, stored.value.id, filters.value.ids),
    );
    if (!planned.ok) return planned;
    if (planned.value.matched.length === 0) {
      return refusal(
        `Running this rule would change no transactions (${planned.value.scanned} examined, ${planned.value.skipped.length} skipped).`,
      );
    }
    return {
      ok: true,
      preview: {
        ruleId: stored.value.id,
        rule: toState(stored.value),
        labels: mergeRuleLabels(stored.labels, filters.value.labels),
        filters: filters.value.ids,
        fingerprint: planned.value.fingerprint,
        test: toCardTest(planned.value),
      },
    };
  }

  /**
   * The test: a draft (`condition` + `actions`) or a saved rule (`ruleId`)
   * against existing transactions. Writes nothing and builds no card.
   */
  async prepareTest(
    userId: string,
    raw: RuleToolInput,
    run: RuleToolRunInput,
  ): Promise<RulePrep<TestRulePreview>> {
    const input = withWindowCleared(raw);
    const filters = await this.resolveFilters(userId, run);
    if (!filters.ok) return filters;

    if (
      input.condition === undefined &&
      input.actions === undefined &&
      input.activeFrom === undefined &&
      input.activeTo === undefined
    ) {
      const stored = await this.loadRule(userId, input.ruleId);
      if (!stored.ok) return stored;
      const planned = await this.guard(async () =>
        this.runService.previewRun(userId, stored.value.id, filters.value.ids),
      );
      if (!planned.ok) return planned;
      return {
        ok: true,
        preview: {
          ruleId: stored.value.id,
          rule: toState(stored.value),
          labels: mergeRuleLabels(stored.labels, filters.value.labels),
          filters: filters.value.ids,
          test: toCardTest(planned.value),
        },
      };
    }

    const stored = input.ruleId
      ? await this.loadRule(userId, input.ruleId)
      : null;
    if (stored && !stored.ok) return stored;
    const base = stored?.value ? toState(stored.value) : undefined;
    const resolved = await this.resolveDefinition(
      userId,
      input.condition ??
        (base && stored
          ? this.namesOf(base, stored.labels).condition
          : undefined),
      input.actions ??
        (base && stored
          ? this.namesOf(base, stored.labels).actions
          : undefined),
    );
    if (!resolved.ok) return resolved;
    const rule: AiActionRuleState = {
      name: input.name ? sanitizeName(input.name) : (base?.name ?? "Draft"),
      enabled: input.enabled ?? base?.enabled ?? true,
      triggers: input.triggers ?? base?.triggers ?? [...RULE_TRIGGERS],
      stopProcessing: input.stopProcessing ?? base?.stopProcessing ?? false,
      activeFrom:
        input.activeFrom === undefined
          ? (base?.activeFrom ?? null)
          : input.activeFrom,
      activeTo:
        input.activeTo === undefined
          ? (base?.activeTo ?? null)
          : input.activeTo,
      ...resolved.value,
    };
    // The same decision prepareUpdate and the REST preview make: the glob-trap
    // advice applies to a draft or a changed condition, not to a stored rule's
    // unchanged one.
    const authoring =
      !base || !isDeepStrictEqual(rule.condition, base.condition);
    const tested = await this.testDraft(
      userId,
      rule,
      filters.value.ids,
      authoring,
    );
    if (!tested.ok) return tested;
    return {
      ok: true,
      preview: {
        rule,
        labels: mergeRuleLabels(
          filters.value.labels,
          await this.labelsForDefinition(userId, resolved.value),
        ),
        filters: filters.value.ids,
        test: tested.value.test,
      },
    };
  }

  /** A test result as a model reads it: the ids in each change named. */
  toLlmTest(
    test: AiActionRuleTestPreview,
    labels: RuleDefinitionLabels,
  ): LlmRuleTest {
    const nameOf = (
      table: Readonly<Record<string, string>>,
      id: string | null,
    ): string | null => (id === null ? null : (table[id] ?? id));
    const note = zeroMatchNote(test);
    return {
      ...(note ? { message: note } : {}),
      matchedCount: test.matchedCount,
      conditionMatchedCount: test.conditionMatchedCount,
      scanned: test.scanned,
      truncated: test.truncated,
      skippedCount: test.skippedCount,
      skipped: test.skipped.map((s) => ({
        transactionId: s.transactionId,
        reason: s.reason,
      })),
      rows: test.rows.map((row) => {
        const { categoryId, payeeId, tagIds, structure } = row.changes as {
          categoryId?: { before: string | null; after: string | null };
          payeeId?: { before: string | null; after: string | null };
          tagIds?: { before: string[]; after: string[] };
          structure?: { before: null; after: RuleStructurePlan | null };
        };
        const tagName = (id: string): string =>
          test.labels.tags[id] ?? labels.tags[id] ?? id;
        return {
          transactionId: row.transactionId,
          date: row.date,
          payeeName: row.payeeName,
          amount: row.amount,
          currencyCode: row.currencyCode,
          changes: {
            ...(categoryId && {
              category: {
                before: nameOf(
                  { ...labels.categories, ...test.labels.categories },
                  categoryId.before,
                ),
                after: nameOf(
                  { ...labels.categories, ...test.labels.categories },
                  categoryId.after,
                ),
              },
            }),
            ...(payeeId && {
              payee: {
                before: nameOf(
                  { ...labels.payees, ...test.labels.payees },
                  payeeId.before,
                ),
                after: nameOf(
                  { ...labels.payees, ...test.labels.payees },
                  payeeId.after,
                ),
              },
            }),
            ...(tagIds && {
              tags: {
                before: tagIds.before.map(tagName),
                after: tagIds.after.map(tagName),
              },
            }),
            ...(structure?.after && {
              structure: this.namedStructure(structure.after, labels, test),
            }),
          },
        };
      }),
    };
  }

  /** A planned structure with the names of the accounts, categories and payees it points at. */
  private namedStructure(
    plan: RuleStructurePlan,
    labels: RuleDefinitionLabels,
    test: AiActionRuleTestPreview,
  ): LlmRuleStructure {
    const nameOf = (
      kind: "accounts" | "categories" | "payees",
      id: string | null,
    ): string | null =>
      id === null ? null : (test.labels[kind][id] ?? labels[kind][id] ?? id);
    if (plan.kind === "transfer") {
      return {
        kind: "transfer",
        account: nameOf("accounts", plan.accountId) ?? plan.accountId,
        clearCategory: plan.clearCategory,
      };
    }
    return {
      kind: "split",
      parts: plan.parts.map((part) => ({
        amount: part.amount,
        category: nameOf("categories", part.categoryId),
        transferTo: nameOf("accounts", part.transferAccountId),
        payee: nameOf("payees", part.payeeId),
        memo: part.memo,
      })),
    };
  }

  // -- internals -----------------------------------------------------------

  private checkedName(
    raw: string | undefined,
  ): { ok: true; value: string } | RuleToolRefusal {
    const value = sanitizeName(raw ?? "");
    if (
      value.length < MIN_RULE_NAME_LENGTH ||
      value.length > MAX_RULE_NAME_LENGTH
    ) {
      return {
        ok: false,
        message: `The rule name must be ${MIN_RULE_NAME_LENGTH} to ${MAX_RULE_NAME_LENGTH} characters.`,
        errors: [{ path: "name", code: "INVALID_NAME" }],
      };
    }
    return { ok: true, value };
  }

  /** The stored rule, its state, and the names of the ids in it. */
  private async loadRule(
    userId: string,
    ruleId: string | undefined,
  ): Promise<
    | {
        ok: true;
        value: TransactionRuleResponseDto;
        labels: RuleDefinitionLabels;
      }
    | RuleToolRefusal
  > {
    if (!ruleId) {
      return {
        ok: false,
        message:
          "ruleId is required. Call list_transaction_rules to find the rule's id.",
        errors: [{ path: "ruleId", code: "VALUE_REQUIRED" }],
      };
    }
    const found = await this.guard(() => this.rulesService.get(userId, ruleId));
    if (!found.ok) return found;
    return {
      ok: true,
      value: found.value,
      labels: await this.labelsFor(userId, [found.value]),
    };
  }

  /** Names -> ids for a definition; shape and ownership are checked by the test that follows. */
  private async resolveDefinition(
    userId: string,
    condition: unknown,
    actions: unknown,
  ): Promise<
    | {
        ok: true;
        value: { condition: RuleConditionNode; actions: RuleAction[] };
      }
    | RuleToolRefusal
  > {
    const refs = collectNamedReferences(condition, actions);
    const total =
      refs.accounts.length +
      refs.payees.length +
      refs.categories.length +
      refs.tags.length;
    if (total > MAX_RULE_TOOL_NAMES) {
      return {
        ok: false,
        message: `The rule names too many distinct accounts, payees, categories and tags (at most ${MAX_RULE_TOOL_NAMES}).`,
        errors: [{ path: "condition", code: "TOO_MANY_NAMES" }],
      };
    }
    const lookup = await this.resolveNames(userId, refs);
    const mapped = namesToIds(condition, actions, lookup);
    if (mapped.errors.length > 0) {
      return {
        ok: false,
        message: describeNameErrors(mapped.errors),
        errors: mapped.errors,
      };
    }
    return {
      ok: true,
      value: {
        condition: mapped.condition as RuleConditionNode,
        actions: withActionDefaults(mapped.actions) as RuleAction[],
      },
    };
  }

  private async resolveNames(
    userId: string,
    refs: ReturnType<typeof collectNamedReferences>,
  ): Promise<NameLookup> {
    const found = new Map<string, NameResolution>();
    const key = (kind: RuleNameKind, name: string): string =>
      `${kind}\u0000${name}`;
    const put = (
      kind: RuleNameKind,
      name: string,
      value: NameResolution,
    ): void => {
      found.set(key(kind, name), value);
    };

    if (refs.accounts.length > 0) {
      const batch = await this.accountsService.resolveAccountFilter(
        userId,
        refs.accounts,
      );
      if (batch.accountIds) {
        refs.accounts.forEach((name, i) =>
          put("accounts", name, { id: batch.accountIds?.[i] }),
        );
      } else {
        const open = await this.accountsService.findAll(userId, false);
        for (const name of refs.accounts) {
          const one = await this.accountsService.resolveAccountFilter(userId, [
            name,
          ]);
          put(
            "accounts",
            name,
            one.accountIds?.[0]
              ? { id: one.accountIds[0] }
              : {
                  failure: "NAME_NOT_FOUND",
                  suggestions: suggestClosestNames(
                    name,
                    open.map((a) => a.name),
                  ),
                },
          );
        }
      }
    }

    for (const name of refs.payees) {
      const payee = await this.payeesService.resolveByName(userId, name);
      put(
        "payees",
        name,
        payee ? { id: payee.id } : { failure: "NAME_NOT_FOUND" },
      );
    }

    if (refs.categories.length > 0) {
      await withScopedDb(this.dataSource, async (m) => {
        const categories = await m.getRepository(Category).find({
          where: { userId },
          select: ["id", "name", "parentId"],
        });
        for (const match of resolveCategoryNamePaths(
          categories,
          refs.categories,
        )) {
          put(
            "categories",
            match.input,
            match.id
              ? { id: match.id }
              : {
                  failure:
                    match.failure === "ambiguous"
                      ? "NAME_AMBIGUOUS"
                      : "NAME_NOT_FOUND",
                  suggestions:
                    match.candidates.length > 0
                      ? match.candidates
                      : suggestQualifiedCategoryNames(categories, match.input),
                },
          );
        }
      });
    }

    if (refs.tags.length > 0) {
      const tags = await this.tagsService.findAll(userId);
      const byName = new Map(tags.map((t) => [t.name.toLowerCase(), t.id]));
      for (const name of refs.tags) {
        const id = byName.get(name.trim().toLowerCase());
        put(
          "tags",
          name,
          id
            ? { id }
            : {
                failure: "NAME_NOT_FOUND",
                suggestions: suggestClosestNames(
                  name,
                  tags.map((t) => t.name),
                ),
              },
        );
      }
    }

    return (kind, name) =>
      found.get(key(kind, name)) ?? { failure: "NAME_NOT_FOUND" };
  }

  private async resolveFilters(
    userId: string,
    run: RuleToolRunInput,
  ): Promise<
    | {
        ok: true;
        value: { ids: RuleRunFiltersDescriptor; labels: RuleDefinitionLabels };
      }
    | RuleToolRefusal
  > {
    let accountIds: string[] | undefined;
    let labels = EMPTY_RULE_LABELS;
    if (run.accountNames?.length) {
      const names = [...new Set(run.accountNames)];
      const resolved = await this.accountsService.resolveAccountFilter(
        userId,
        names,
      );
      if (!resolved.accountIds) {
        return {
          ok: false,
          message: resolved.error ?? "Unknown account.",
          errors: [{ path: "accountNames", code: "NAME_NOT_FOUND" }],
        };
      }
      accountIds = resolved.accountIds;
      labels = {
        ...EMPTY_RULE_LABELS,
        accounts: Object.fromEntries(accountIds.map((id, i) => [id, names[i]])),
      };
    }
    return {
      ok: true,
      value: {
        ids: {
          ...(accountIds ? { accountIds } : {}),
          ...(run.startDate ? { startDate: run.startDate } : {}),
          ...(run.endDate ? { endDate: run.endDate } : {}),
          ...(run.limit !== undefined ? { limit: run.limit } : {}),
        },
        labels,
      },
    };
  }

  /** The draft preview: validates exactly like a create and writes nothing. */
  private async testDraft(
    userId: string,
    rule: AiActionRuleState,
    filters: RuleRunFiltersDescriptor,
    authoring = true,
  ): Promise<
    { ok: true; value: { test: AiActionRuleTestPreview } } | RuleToolRefusal
  > {
    const planned = await this.guard(
      () =>
        this.runService.previewDraft(
          userId,
          {
            condition: rule.condition as unknown as Record<string, unknown>,
            actions: rule.actions as unknown as Record<string, unknown>[],
            activeFrom: rule.activeFrom,
            activeTo: rule.activeTo,
            filters: { ...filters },
          },
          { authoring },
        ),
      rule,
    );
    if (!planned.ok) return planned;
    return { ok: true, value: { test: toCardTest(planned.value) } };
  }

  /**
   * Run a service call and turn a 4xx into a refusal carrying the response's
   * structured `errors`, so the model reads the same entries the REST API
   * returns. A 5xx and anything unexpected is thrown.
   */
  private async guard<T>(
    call: () => Promise<T>,
    definition: RuleHintDefinition = {},
  ): Promise<{ ok: true; value: T } | RuleToolRefusal> {
    try {
      return { ok: true, value: await call() };
    } catch (err) {
      if (
        err instanceof HttpException &&
        err.getStatus() >= 400 &&
        err.getStatus() < 500
      ) {
        const body = err.getResponse();
        const detail =
          typeof body === "object" && body !== null
            ? (body as { errors?: unknown; errorCode?: unknown })
            : {};
        const errors = Array.isArray(detail.errors)
          ? (detail.errors as RuleToolError[])
          : [];
        const listed =
          errors.length === 0 && typeof detail.errorCode === "string"
            ? [{ path: "", code: detail.errorCode }]
            : errors;
        const hints = ruleErrorHints(listed, definition);
        return {
          ok: false,
          message: err.message,
          errors: listed,
          ...(hints.length > 0 ? { hints } : {}),
        };
      }
      throw err;
    }
  }

  private async labelsFor(
    userId: string,
    rules: readonly TransactionRuleResponseDto[],
  ): Promise<RuleDefinitionLabels> {
    const wanted = {
      accountIds: new Set<string>(),
      payeeIds: new Set<string>(),
      categoryIds: new Set<string>(),
      tagIds: new Set<string>(),
    };
    for (const rule of rules) {
      if (rule.invalid) continue;
      const ids = collectReferencedIds(rule);
      ids.accountIds.forEach((id) => wanted.accountIds.add(id));
      ids.payeeIds.forEach((id) => wanted.payeeIds.add(id));
      ids.categoryIds.forEach((id) => wanted.categoryIds.add(id));
      ids.tagIds.forEach((id) => wanted.tagIds.add(id));
    }
    return withScopedDb(this.dataSource, (m) =>
      loadRuleLabels(m, userId, {
        accountIds: [...wanted.accountIds],
        payeeIds: [...wanted.payeeIds],
        categoryIds: [...wanted.categoryIds],
        tagIds: [...wanted.tagIds],
      }),
    );
  }

  private async labelsForDefinition(
    userId: string,
    definition: RuleDefinition,
  ): Promise<RuleDefinitionLabels> {
    const ids = collectReferencedIds(definition);
    return withScopedDb(this.dataSource, (m) => loadRuleLabels(m, userId, ids));
  }

  private namesOf(
    state: { condition: RuleConditionNode; actions: RuleAction[] },
    labels: RuleDefinitionLabels,
  ): { condition: unknown; actions: unknown[] } {
    return idsToNames(state, labels);
  }

  private toLlmRule(
    rule: TransactionRuleResponseDto,
    labels: RuleDefinitionLabels,
  ): LlmRule {
    const definition = rule.invalid
      ? { condition: rule.condition, actions: rule.actions as unknown[] }
      : idsToNames(rule, labels);
    return {
      id: rule.id,
      name: rule.name,
      enabled: rule.enabled,
      position: rule.position,
      triggers: rule.triggers,
      stopProcessing: rule.stopProcessing,
      activeFrom: rule.activeFrom,
      activeTo: rule.activeTo,
      revision: rule.revision,
      condition: definition.condition,
      actions: definition.actions,
      invalid: rule.invalid,
      invalidReasons: rule.invalidReasons.map(({ path, code }) => ({
        path,
        code,
      })),
    };
  }
}

/** A blank side of the window ("" from a tool call) means open, the same as null. */
function withWindowCleared(input: RuleToolInput): RuleToolInput {
  const open = (side: string | null | undefined): string | null | undefined =>
    side === "" ? null : side;
  return {
    ...input,
    activeFrom: open(input.activeFrom),
    activeTo: open(input.activeTo),
  };
}

function refusal(message: string): RuleToolRefusal {
  return { ok: false, message, errors: [] };
}

function toState(rule: TransactionRuleResponseDto): AiActionRuleState {
  return {
    name: rule.name,
    enabled: rule.enabled,
    triggers: [...rule.triggers],
    stopProcessing: rule.stopProcessing,
    activeFrom: rule.activeFrom,
    activeTo: rule.activeTo,
    condition: rule.condition,
    actions: [...rule.actions],
  };
}

/** A run preview trimmed to what a card lists: the counts cover every row. */
function toCardTest(preview: RuleRunPreview): AiActionRuleTestPreview {
  return {
    matchedCount: preview.matched.length,
    conditionMatchedCount: preview.conditionMatchedCount,
    scanned: preview.scanned,
    truncated: preview.truncated,
    rows: preview.matched.slice(0, RULE_CARD_PREVIEW_ROWS),
    skipped: preview.skipped.slice(0, RULE_CARD_PREVIEW_ROWS),
    skippedCount: preview.skipped.length,
    aiReviewRequests: preview.aiReviewRequests,
    labels: preview.labels,
  };
}

function describeNameErrors(errors: readonly RuleToolError[]): string {
  const first = errors[0];
  const kind = {
    accounts: "account",
    payees: "payee",
    categories: "category",
    tags: "tag",
  }[first.kind ?? "accounts"];
  const more = errors.length > 1 ? ` (and ${errors.length - 1} more)` : "";
  const hint = first.suggestions?.length
    ? ` Did you mean ${first.suggestions.map((s) => `'${s}'`).join(", ")}?`
    : "";
  return first.code === "NAME_AMBIGUOUS"
    ? `Ambiguous ${kind}: '${first.name}'${more}.${hint}`
    : `Unknown ${kind}: '${first.name}'${more}.${hint} Call the matching list tool to look up valid names.`;
}
