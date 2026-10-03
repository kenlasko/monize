import { Injectable } from "@nestjs/common";
import { McpServer } from "@modelcontextprotocol/server";
import type { ServerContext } from "@modelcontextprotocol/server";
import { z } from "zod";
import { AiRelayService } from "../../ai/relay/ai-relay.service";
import { AiActionBuilderService } from "../../ai/actions/ai-action-builder.service";
import { AiActionsService } from "../../ai/actions/ai-actions.service";
import type {
  AiActionRuleTestPreview,
  PendingAiAction,
} from "../../ai/actions/ai-action.types";
import { RULE_LANGUAGE_GUIDE } from "../../ai/query/tool-definitions";
import {
  manageTransactionRulesFields,
  manageTransactionRulesSchema,
} from "../../ai/query/tool-input-schemas";
import { stripHtml } from "../../common/sanitization.util";
import {
  RuleToolInput,
  RuleToolRefusal,
  RuleToolRunInput,
  TransactionRuleToolPrepService,
  zeroMatchNote,
} from "../../transaction-rules/rule-tool-prep.service";
import { RELAY_PREVIEW_SHOWN, emitRelayCard } from "../mcp-relay-confirm";
import {
  resolveUserContext,
  requireScope,
  toolResult,
  toolError,
  safeToolError,
} from "../mcp-context";
import { confirmWrite, isAsk } from "../mcp-confirm";
import { McpWriteLimiter } from "../mcp-write-limiter";
import { manageTransactionRulesOutput } from "../tool-output-schemas";
import { WRITE } from "../mcp-annotations";
import { uuidString } from "./schema-fragments";

type RuleOperation = "list" | "create" | "update" | "delete" | "run" | "test";

/** A refusal as text: the message, then the `{ path, code }` entries the REST API would return. */
function refusalText(refusal: RuleToolRefusal): string {
  const head = refusal.errors.length
    ? `${refusal.message} ${JSON.stringify(refusal.errors)}`
    : refusal.message;
  return refusal.hints?.length
    ? `${head} Fix: ${refusal.hints.join(" ")}`
    : head;
}

const changes = (test: AiActionRuleTestPreview): string => {
  const note = zeroMatchNote(test);
  return `It would change ${test.matchedCount} of ${test.scanned} transactions examined${test.truncated ? " (more match than are examined)" : ""}.${note ? ` ${note}` : ""}`;
};

@Injectable()
export class McpRulesTools {
  constructor(
    private readonly prepService: TransactionRuleToolPrepService,
    private readonly relayService: AiRelayService,
    private readonly actionBuilder: AiActionBuilderService,
    private readonly aiActions: AiActionsService,
    private readonly writeLimiter: McpWriteLimiter,
  ) {}

  register(server: McpServer) {
    server.registerTool(
      "manage_transaction_rules",
      {
        title: "Manage transaction rules",
        annotations: WRITE,
        description:
          RULE_LANGUAGE_GUIDE +
          " Rules run in order. Changes need the user's confirmation; run applies a rule to existing transactions; test previews and saves nothing. update: ruleId plus only the changed fields (condition or actions replaces the whole one).",
        inputSchema: manageTransactionRulesFields.extend({
          operation: z.enum([
            "list",
            "create",
            "update",
            "delete",
            "run",
            "test",
          ]),
          ruleId: uuidString().optional().describe("Omit to test a draft."),
          search: z.string().max(100).optional().describe("list: name filter."),
        }),
        outputSchema: manageTransactionRulesOutput,
      },
      async (args, ctx) => {
        const user = resolveUserContext(ctx);
        if (!user) return toolError("No user context");
        const operation = args.operation as RuleOperation;
        const isRead = operation === "list" || operation === "test";
        const check = requireScope(user.scopes, isRead ? "read" : "write");
        if (check.error) return check.result;

        try {
          if (operation === "list") {
            return toolResult(
              await this.prepService.list(user.userId, {
                ruleId: args.ruleId,
                search: args.search,
                limit: args.limit,
              }),
            );
          }

          // The same per-operation requirements the assistant enforces.
          const parsed = manageTransactionRulesSchema.safeParse(args);
          if (!parsed.success) {
            return toolError(
              parsed.error.issues
                .map((i) => `${i.path.join(".")}: ${i.message}`)
                .join("; "),
            );
          }

          const rule: RuleToolInput = {
            ruleId: args.ruleId,
            name: stripHtml(args.name),
            enabled: args.enabled,
            triggers: args.triggers,
            stopProcessing: args.stopProcessing,
            activeFrom: args.activeFrom,
            activeTo: args.activeTo,
            condition: args.condition,
            actions: args.actions,
          };
          const run: RuleToolRunInput = {
            accountNames: args.accountNames,
            startDate: args.startDate,
            endDate: args.endDate,
            limit: args.limit,
          };

          if (operation === "test") {
            const prep = await this.prepService.prepareTest(
              user.userId,
              rule,
              run,
            );
            if (!prep.ok) return toolError(refusalText(prep));
            return toolResult({
              rule: prep.preview.rule.name,
              ...this.prepService.toLlmTest(
                prep.preview.test,
                prep.preview.labels,
              ),
            });
          }

          return await this.write(
            server,
            ctx,
            user.userId,
            operation,
            rule,
            run,
          );
        } catch (err: unknown) {
          return safeToolError(err);
        }
      },
    );
  }

  /**
   * Prepare the card for one write: names resolved, the definition validated and
   * tested exactly as the commit will apply it. A refusal is a message and
   * writes nothing.
   */
  private async prepare(
    userId: string,
    operation: "create" | "update" | "delete" | "run",
    rule: RuleToolInput,
    run: RuleToolRunInput,
  ): Promise<
    | { ok: true; action: PendingAiAction; message: string }
    | { ok: false; error: string }
  > {
    if (operation === "create") {
      const prep = await this.prepService.prepareCreate(userId, rule);
      if (!prep.ok) return { ok: false, error: refusalText(prep) };
      return {
        ok: true,
        action: this.actionBuilder.buildCreateTransactionRule(
          userId,
          prep.preview,
        ),
        message: `Create transaction rule "${prep.preview.rule.name}"?\n${changes(prep.preview.test)}`,
      };
    }
    if (operation === "update") {
      const prep = await this.prepService.prepareUpdate(userId, rule);
      if (!prep.ok) return { ok: false, error: refusalText(prep) };
      const renamed =
        prep.preview.rule.name !== prep.preview.current.name
          ? ` (renamed to "${prep.preview.rule.name}")`
          : "";
      return {
        ok: true,
        action: this.actionBuilder.buildUpdateTransactionRule(
          userId,
          prep.preview,
        ),
        message: `Apply this edit to rule "${prep.preview.current.name}"${renamed}?${prep.preview.test ? `\n${changes(prep.preview.test)}` : ""}`,
      };
    }
    if (operation === "delete") {
      const prep = await this.prepService.prepareDelete(userId, rule);
      if (!prep.ok) return { ok: false, error: refusalText(prep) };
      return {
        ok: true,
        action: this.actionBuilder.buildDeleteTransactionRule(
          userId,
          prep.preview,
        ),
        message: `Delete transaction rule "${prep.preview.rule.name}"?`,
      };
    }
    const prep = await this.prepService.prepareRun(userId, rule, run);
    if (!prep.ok) return { ok: false, error: refusalText(prep) };
    return {
      ok: true,
      action: this.actionBuilder.buildRunTransactionRule(userId, prep.preview),
      message: `Run rule "${prep.preview.rule.name}" on existing transactions?\n${changes(prep.preview.test)}`,
    };
  }

  private async write(
    server: McpServer,
    ctx: ServerContext,
    userId: string,
    operation: "create" | "update" | "delete" | "run",
    rule: RuleToolInput,
    run: RuleToolRunInput,
  ) {
    const prepared = await this.prepare(userId, operation, rule, run);
    if (!prepared.ok) return toolError(prepared.error);

    // A run counts as one write however many rows it changes.
    const budget = await this.writeLimiter.reserve(userId, 1);
    if (budget) return budget;

    const { action } = prepared;
    // Only the round that ASKS may hand the confirmation to the web chat. On a
    // retry the human has already answered in their own client, and a relay
    // turn that began in between would swallow that answer.
    if (
      !ctx.mcpReq.requestState() &&
      (await emitRelayCard(this.relayService, userId, action))
    ) {
      return toolResult(RELAY_PREVIEW_SHOWN);
    }
    const confirmation = await confirmWrite(
      server,
      ctx,
      prepared.message,
      action.descriptor,
    );
    if (isAsk(confirmation)) return confirmation.ask;
    if (confirmation === "declined") {
      return toolError(
        "Cancelled: the confirmation was declined, so nothing was changed.",
      );
    }

    // "accepted", or "unsupported": no dialog reached a human, and the client
    // still gates every tool call with its own approval prompt.
    const result = await this.aiActions.commitApproved(
      userId,
      action.descriptor,
    );
    await this.writeLimiter.record(userId, action.type);
    return toolResult({
      id: result.id,
      ...(operation === "delete" ? { deleted: true } : {}),
      ...(result.ruleRun ? { ruleRun: result.ruleRun } : {}),
    });
  }
}
