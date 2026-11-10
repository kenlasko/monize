import { Injectable } from "@nestjs/common";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/server";
import type { ServerContext } from "@modelcontextprotocol/server";
import {
  LIST_TAGS_DESCRIPTION,
  listTagsSchema,
} from "../../ai/query/tool-input-schemas";
import { TagsService } from "../../tags/tags.service";
import {
  ManageTagOperation,
  ManageTagRow,
  TagToolPrepService,
} from "../../tags/tag-tool-prep.service";
import { AiRelayService } from "../../ai/relay/ai-relay.service";
import { AiActionBuilderService } from "../../ai/actions/ai-action-builder.service";
import { AiActionsService } from "../../ai/actions/ai-actions.service";
import {
  ApprovalMode,
  PendingAiAction,
  resolveApprovalMode,
} from "../../ai/actions/ai-action.types";
import { describeSkippedRows } from "../../common/bulk-create.types";
import { RELAY_PREVIEW_SHOWN, emitRelayCard } from "../mcp-relay-confirm";
import {
  resolveUserContext,
  requireScope,
  toolResult,
  toolError,
  safeToolError,
} from "../mcp-context";
import {
  cardKey,
  confirmItemsForCards,
  confirmWrite,
  confirmWriteMany,
  isAsk,
} from "../mcp-confirm";
import { McpWriteLimiter } from "../mcp-write-limiter";
import { listTagsOutput, manageTagsOutput } from "../tool-output-schemas";
import { READ_ONLY, WRITE } from "../mcp-annotations";
import {
  manageOperation,
  approvalMode,
  dryRun,
  itemsArray,
} from "./schema-fragments";

const BATCH_OPERATION = {
  create: "create_tag",
  update: "update_tag",
  delete: "delete_tag",
} as const;

/** What one tag card proposes, as the text of an MCP confirmation. */
function confirmLineFor(card: PendingAiAction): string {
  const p = card.preview;
  const look =
    (p.tagColor !== undefined ? `\nColour: ${p.tagColor ?? "(cleared)"}` : "") +
    (p.tagIcon !== undefined ? `\nIcon: ${p.tagIcon ?? "(cleared)"}` : "");
  switch (card.type) {
    case "delete_tag":
      return `Delete this tag?\nName: ${p.name}\nIt is removed from ${p.tagUseCount ?? 0} transaction(s) and split line(s); nothing else on them changes.`;
    case "update_tag":
      return `Apply this tag edit?\nTag: ${p.previousName ?? p.name}${p.previousName ? `\nRename to: ${p.name}` : ""}${look}`;
    default:
      return `Create this tag?\nName: ${p.name}${look}`;
  }
}

/**
 * `list_tags` and `manage_tags`: thin adapters over `TagsService.getLlmTags`
 * and `TagToolPrepService`, the methods the assistant's executor calls too. An
 * approved card commits through `AiActionsService.commitApproved`, the
 * executors `/ai/actions/confirm` uses, so a tag write is validated once
 * whichever surface approved it; the MCP write cap is this tool's.
 */
@Injectable()
export class McpTagsTools {
  constructor(
    private readonly tagsService: TagsService,
    private readonly prepService: TagToolPrepService,
    private readonly relayService: AiRelayService,
    private readonly actionBuilder: AiActionBuilderService,
    private readonly aiActions: AiActionsService,
    private readonly writeLimiter: McpWriteLimiter,
  ) {}

  register(server: McpServer) {
    server.registerTool(
      "list_tags",
      {
        title: "List tags",
        annotations: READ_ONLY,
        description: LIST_TAGS_DESCRIPTION,
        inputSchema: listTagsSchema,
        outputSchema: listTagsOutput,
      },
      async (args, ctx) => {
        const user = resolveUserContext(ctx);
        if (!user) return toolError("No user context");
        const check = requireScope(user.scopes, "read");
        if (check.error) return check.result;

        try {
          return toolResult(
            await this.tagsService.getLlmTags(user.userId, args),
          );
        } catch (err: unknown) {
          return safeToolError(err);
        }
      },
    );

    server.registerTool(
      "manage_tags",
      {
        title: "Manage tags",
        annotations: WRITE,
        description:
          "Create, rename, recolour or delete tags. Each item names a tag by " +
          "`name` (its current name on update/delete); an update needs a " +
          "change, and an empty color or icon clears it. Deleting a tag " +
          "removes it from every transaction and split line, and nothing else " +
          "on them. To tag transactions use manage_transactions.",
        inputSchema: z.object({
          operation: manageOperation(),
          items: itemsArray(
            z.object({
              name: z
                .string()
                .max(100)
                .describe(
                  "create: the new name. update/delete: the tag's current name.",
                ),
              newName: z
                .string()
                .max(100)
                .optional()
                .describe("update: rename to this."),
              color: z.string().max(7).optional().describe("#RRGGBB."),
              icon: z.string().max(50).optional().describe("Icon name."),
            }),
          ),
          approvalMode: approvalMode(),
          dryRun: dryRun(),
        }),
        outputSchema: manageTagsOutput,
      },
      async (args, ctx) => {
        const user = resolveUserContext(ctx);
        if (!user) return toolError("No user context");
        const check = requireScope(user.scopes, "write");
        if (check.error) return check.result;

        const operation = args.operation as ManageTagOperation;
        const items = args.items as ManageTagRow[];
        try {
          if (
            items.some((i) => i.newName !== undefined) &&
            operation !== "update"
          ) {
            return toolError("newName is used only with operation update.");
          }
          if (args.dryRun) {
            const prep = await this.prepareMany(user.userId, operation, items);
            return toolResult({
              dryRun: true,
              operation,
              previews: prep.previewRows,
              skipped: prep.skipped,
              message:
                "This is a preview. Call again with dryRun=false to apply the changes.",
            });
          }
          if (items.length === 1) {
            return await this.writeOne(
              server,
              ctx,
              user.userId,
              operation,
              items[0],
            );
          }
          return await this.writeMany(
            server,
            ctx,
            user.userId,
            operation,
            items,
            resolveApprovalMode(
              args.approvalMode as ApprovalMode | undefined,
              items.length,
            ),
          );
        } catch (err: unknown) {
          return safeToolError(err);
        }
      },
    );
  }

  private prepareMany(
    userId: string,
    operation: ManageTagOperation,
    items: ManageTagRow[],
  ) {
    // The overloads pick the row type per operation; the envelope is the same.
    return operation === "create"
      ? this.prepService.prepareMany(userId, "create", items)
      : operation === "update"
        ? this.prepService.prepareMany(userId, "update", items)
        : this.prepService.prepareMany(userId, "delete", items);
  }

  private async writeOne(
    server: McpServer,
    ctx: ServerContext,
    userId: string,
    operation: ManageTagOperation,
    item: ManageTagRow,
  ) {
    const preview = await this.prepService.prepareOne(userId, operation, item);
    const budget = await this.writeLimiter.reserve(userId, 1);
    if (budget) return budget;
    const action = this.actionBuilder.buildTagAction(userId, preview);
    // Only the round that ASKS may hand the confirmation to the web chat. On a
    // retry the human has already answered in their own client.
    if (
      !ctx.mcpReq.requestState() &&
      (await emitRelayCard(this.relayService, userId, action))
    ) {
      return toolResult(RELAY_PREVIEW_SHOWN);
    }
    const confirmation = await confirmWrite(
      server,
      ctx,
      confirmLineFor(action),
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
      count: 1,
      ...(operation === "delete" ? { deleted: true } : {}),
    });
  }

  private async writeMany(
    server: McpServer,
    ctx: ServerContext,
    userId: string,
    operation: ManageTagOperation,
    items: ManageTagRow[],
    mode: ApprovalMode,
  ) {
    const prep = await this.prepareMany(userId, operation, items);
    if (prep.okPreviews.length === 0) {
      return toolError(
        `None of the tag changes could be prepared.${describeSkippedRows(prep.skipped, items.length)}`,
      );
    }
    const budget = await this.writeLimiter.reserve(
      userId,
      prep.okPreviews.length,
    );
    if (budget) return budget;

    if (mode === "individual") {
      const cards = prep.okPreviews.map((p) =>
        this.actionBuilder.buildTagAction(userId, p),
      );
      if (
        !ctx.mcpReq.requestState() &&
        (await emitRelayCard(this.relayService, userId, cards[0]))
      ) {
        for (const card of cards.slice(1)) {
          await emitRelayCard(this.relayService, userId, card);
        }
        return toolResult(RELAY_PREVIEW_SHOWN);
      }
      // Every card is asked in ONE round: a round per card would be 25 rounds
      // on a full batch, and a multi-round-trip flow is two.
      const answers = await confirmWriteMany(
        server,
        ctx,
        confirmItemsForCards(cards, confirmLineFor),
      );
      if (!(answers instanceof Map)) return answers.ask;
      const ids: string[] = [];
      for (const [index, card] of cards.entries()) {
        if (answers.get(cardKey(index)) === "declined") continue;
        const result = await this.aiActions.commitApproved(
          userId,
          card.descriptor,
        );
        await this.writeLimiter.record(userId, card.type);
        ids.push(result.id);
      }
      return toolResult({ ids, count: ids.length, skipped: prep.skipped });
    }

    const action = this.actionBuilder.buildBatchActions(
      userId,
      BATCH_OPERATION[operation],
      prep.okRows,
      prep.previewRows,
    );
    if (
      !ctx.mcpReq.requestState() &&
      (await emitRelayCard(this.relayService, userId, action))
    ) {
      return toolResult(RELAY_PREVIEW_SHOWN);
    }
    const confirmation = await confirmWrite(
      server,
      ctx,
      `Apply ${prep.okPreviews.length} tag change(s) (${operation})?${prep.skipped.length ? ` (${prep.skipped.length} skipped)` : ""}`,
      action.descriptor,
    );
    if (isAsk(confirmation)) return confirmation.ask;
    if (confirmation === "declined") {
      return toolError(
        "Cancelled: the confirmation was declined, so nothing was changed.",
      );
    }
    const result = await this.aiActions.commitApproved(
      userId,
      action.descriptor,
    );
    const ids = result.ids ?? [];
    for (let i = 0; i < ids.length; i++) {
      await this.writeLimiter.record(userId, BATCH_OPERATION[operation]);
    }
    // A row the commit skipped is reported by its index in the call's items.
    const skippedAtCommit = (result.skipped ?? []).map((skip) => ({
      index: prep.okIndex[skip.index] ?? skip.index,
      reason: skip.reason,
    }));
    return toolResult({
      ids,
      count: ids.length,
      skipped: [...prep.skipped, ...skippedAtCommit],
    });
  }
}
