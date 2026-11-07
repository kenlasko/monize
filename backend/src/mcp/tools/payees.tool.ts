import { Injectable } from "@nestjs/common";
import { describeSkippedRows } from "../../common/bulk-create.types";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/server";
import type {
  InputRequiredResult,
  ServerContext,
} from "@modelcontextprotocol/server";
import { PayeesService } from "../../payees/payees.service";
import { formatPhoneForDisplay } from "../../common/phone-number.util";
import { contactLookupOptions } from "../../ai/actions/ai-actions.service";
import {
  PayeeToolPrepService,
  ManageCreatePayeeRow,
  ManageUpdatePayeeRow,
  ManageDeletePayeeRow,
} from "../../payees/payee-tool-prep.service";
import { AiRelayService } from "../../ai/relay/ai-relay.service";
import { AiActionBuilderService } from "../../ai/actions/ai-action-builder.service";
import { PendingAiAction } from "../../ai/actions/ai-action.types";
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
import { getPayeesOutput, managePayeesOutput } from "../tool-output-schemas";
import { READ_ONLY, WRITE } from "../mcp-annotations";
import {
  manageOperation,
  approvalMode,
  dryRun,
  itemsArray,
} from "./schema-fragments";
import { numberArg, booleanArg } from "../../common/tool-schemas";

type ManagePayeeOperation = "create" | "update" | "delete";
type ApprovalMode = "bulk" | "individual";

interface ManagePayeeItem {
  // create
  name?: string;
  categoryName?: string;
  // update (name identifies the payee; the rest are the changes)
  newName?: string;
  website?: string;
  address?: string;
  email?: string;
  phone?: string;
}

/**
 * The contact lines on a payee confirmation card.
 *
 * A field the request did not mention is omitted; one being cleared says so
 * explicitly, because a card that silently drops "address" for both cases would
 * have the user approve an edit whose effect they cannot see.
 */
function contactCardLines(preview: {
  address?: string | null;
  email?: string | null;
  phone?: string | null;
}): string {
  const rows: string[] = [];
  for (const [label, value] of [
    ["Address", preview.address],
    ["Email", preview.email],
    // A phone is shown the way a person reads one, never the stored E.164:
    // the human approving this card has to recognise the number.
    [
      "Phone",
      preview.phone === undefined
        ? undefined
        : preview.phone === null
          ? null
          : formatPhoneForDisplay(preview.phone),
    ],
  ] as const) {
    if (value !== undefined) rows.push(`\n${label}: ${value ?? "(cleared)"}`);
  }
  return rows.join("");
}

@Injectable()
export class McpPayeesTools {
  constructor(
    private readonly payeesService: PayeesService,
    private readonly prepService: PayeeToolPrepService,
    private readonly relayService: AiRelayService,
    private readonly actionBuilder: AiActionBuilderService,
    private readonly writeLimiter: McpWriteLimiter,
  ) {}

  register(server: McpServer) {
    server.registerTool(
      "list_payees",
      {
        title: "List payees",
        annotations: READ_ONLY,
        description:
          "The user's payees with their default category, contact details and " +
          "usage. `search` is a case-insensitive substring of the name. A has* " +
          "filter true keeps payees with that detail, false those without it " +
          "(hasEmail:false finds payees still needing one). `totalCount` counts " +
          "matches; when `truncated`, `payees` is only the first `limit`, so " +
          "never call it all of the user's payees.",
        inputSchema: z.object({
          search: z
            .string()
            .max(200)
            .optional()
            .describe("Case-insensitive substring of the payee name."),
          status: z
            .enum(["active", "inactive", "all"])
            .optional()
            .describe("Defaults to 'all'."),
          sortBy: z
            .enum(["name", "lastUsed", "transactionCount"])
            .optional()
            .describe(
              "name (A-Z, default), lastUsed (most recent first, never-used last), or transactionCount (busiest first).",
            ),
          limit: numberArg(z.number().int().min(1).max(500))
            .optional()
            .describe("Return only the first N rows after sorting."),
          hasWebsite: booleanArg().optional().describe("Filter on a website."),
          hasLogo: booleanArg()
            .optional()
            .describe("Filter on a resolved brand icon."),
          hasAddress: booleanArg().optional().describe("Filter on an address."),
          hasEmail: booleanArg().optional().describe("Filter on an email."),
          hasPhone: booleanArg()
            .optional()
            .describe("Filter on a phone number."),
          hasDefaultCategory: booleanArg()
            .optional()
            .describe("Filter on a default category."),
        }),
        outputSchema: getPayeesOutput,
      },
      async (args, ctx) => {
        const user = resolveUserContext(ctx);
        if (!user) return toolError("No user context");
        const check = requireScope(user.scopes, "read");
        if (check.error) return check.result;

        try {
          return toolResult(
            await this.payeesService.getLlmPayees(user.userId, args),
          );
        } catch (err: unknown) {
          return safeToolError(err);
        }
      },
    );

    server.registerTool(
      "manage_payees",
      {
        title: "Manage payees",
        annotations: WRITE,
        description:
          "Create, rename, edit or delete payees. An update identifies the " +
          "payee by `name` and needs at least one change; an empty string " +
          "clears a contact field. A website also resolves its icon. Deleting " +
          "a payee leaves its transactions their stored payee name. With " +
          "automatic contact lookup on, a single new payee with no contact " +
          "details is looked up before its card, which may carry suggestions; " +
          "a batch is looked up after approval.",
        inputSchema: z.object({
          operation: manageOperation(),
          items: itemsArray(
            z.object({
              name: z
                .string()
                .max(100)
                .describe(
                  "create: the new name. update/delete: the payee's current name.",
                ),
              newName: z
                .string()
                .max(100)
                .optional()
                .describe("update: rename to this."),
              categoryName: z
                .string()
                .max(100)
                .optional()
                .describe("The payee's default category."),
              website: z
                .string()
                .max(2048)
                .optional()
                .describe("Web address. A bare domain is stored as https."),
              address: z
                .string()
                .max(500)
                .optional()
                .describe("Postal address, free text."),
              email: z
                .string()
                .max(255)
                .optional()
                .describe("Contact email address."),
              phone: z
                .string()
                .max(50)
                .optional()
                .describe(
                  "Contact phone number, any format with country code.",
                ),
            }),
          ),
          approvalMode: approvalMode(),
          dryRun: dryRun(),
        }),
        outputSchema: managePayeesOutput,
      },
      async (args, ctx) => {
        const user = resolveUserContext(ctx);
        if (!user) return toolError("No user context");
        const check = requireScope(user.scopes, "write");
        if (check.error) return check.result;

        const operation = args.operation as ManagePayeeOperation;
        const items = args.items as ManagePayeeItem[];
        const approvalMode = (args.approvalMode ?? "bulk") as ApprovalMode;

        try {
          if (args.dryRun) {
            return this.manageDryRun(user.userId, operation, items);
          }
          if (operation === "create") {
            return await this.manageCreate(
              server,
              ctx,
              user.userId,
              items,
              approvalMode,
            );
          }
          if (operation === "update") {
            return await this.manageUpdate(
              server,
              ctx,
              user.userId,
              items,
              approvalMode,
            );
          }
          return await this.manageDelete(
            server,
            ctx,
            user.userId,
            items,
            approvalMode,
          );
        } catch (err: unknown) {
          return safeToolError(err);
        }
      },
    );
  }

  // -------------------------------------------------------------------------
  // helpers
  // -------------------------------------------------------------------------

  private toCreateRow(item: ManagePayeeItem): ManageCreatePayeeRow {
    return {
      name: item.name as string,
      categoryName: item.categoryName,
      website: item.website,
      address: item.address,
      email: item.email,
      phone: item.phone,
    };
  }

  private toUpdateRow(item: ManagePayeeItem): ManageUpdatePayeeRow {
    return {
      name: item.name as string,
      newName: item.newName,
      categoryName: item.categoryName,
      website: item.website,
      address: item.address,
      email: item.email,
      phone: item.phone,
    };
  }

  private toDeleteRow(item: ManagePayeeItem): ManageDeletePayeeRow {
    return { name: item.name as string };
  }

  private async manageDryRun(
    userId: string,
    operation: ManagePayeeOperation,
    items: ManagePayeeItem[],
  ) {
    const prep =
      operation === "create"
        ? await this.prepService.prepareCreatePayees(
            userId,
            items.map((i) => this.toCreateRow(i)),
          )
        : operation === "update"
          ? await this.prepService.prepareUpdatePayees(
              userId,
              items.map((i) => this.toUpdateRow(i)),
            )
          : await this.prepService.prepareDeletePayees(
              userId,
              items.map((i) => this.toDeleteRow(i)),
            );
    return toolResult({
      dryRun: true,
      operation,
      previews: prep.previewRows,
      skipped: prep.skipped,
      message:
        "This is a preview. Call again with dryRun=false to apply the changes.",
    });
  }

  private async emitOrConfirm(
    server: McpServer,
    ctx: ServerContext,
    userId: string,
    pendingAction: PendingAiAction,
    confirmMessage: string,
  ): Promise<"relay" | "accepted" | "declined" | { ask: InputRequiredResult }> {
    // Only the round that ASKS may hand the confirmation to the web chat. On a
    // retry the human has already answered in their own client, and a relay
    // turn that began in between would swallow that answer.
    if (
      !ctx.mcpReq.requestState() &&
      (await emitRelayCard(this.relayService, userId, pendingAction))
    ) {
      return "relay";
    }
    const confirmation = await confirmWrite(
      server,
      ctx,
      confirmMessage,
      pendingAction.descriptor,
    );
    if (isAsk(confirmation)) return confirmation;
    return confirmation === "declined" ? "declined" : "accepted";
  }

  private async manageCreate(
    server: McpServer,
    ctx: ServerContext,
    userId: string,
    items: ManagePayeeItem[],
    approvalMode: ApprovalMode,
  ) {
    if (items.length === 1) {
      const preview = await this.prepService.prepareCreatePayeeSingle(
        userId,
        this.toCreateRow(items[0]),
        { lookupContact: true },
      );
      const budget = await this.writeLimiter.reserve(userId, 1);
      if (budget) return budget;
      const action = this.actionBuilder.buildCreatePayee(userId, preview);
      const outcome = await this.emitOrConfirm(
        server,
        ctx,
        userId,
        action,
        `Create this payee?\nName: ${preview.name}${preview.defaultCategoryName ? `\nDefault category: ${preview.defaultCategoryName}` : ""}${preview.website ? `\nWebsite: ${preview.website}` : ""}${contactCardLines(preview)}`,
      );
      if (isAsk(outcome)) return outcome.ask;
      if (outcome === "relay") return toolResult(RELAY_PREVIEW_SHOWN);
      if (outcome === "declined")
        return toolError(
          "Cancelled: the confirmation was declined, so no payee was created.",
        );
      const payee = await this.payeesService.create(
        userId,
        {
          name: preview.name,
          defaultCategoryId: preview.defaultCategoryId ?? undefined,
          website: preview.website,
          address: preview.address,
          email: preview.email,
          phone: preview.phone,
        },
        preview.contactLookup ? { contactLookup: preview.contactLookup } : {},
      );
      await this.writeLimiter.record(userId, "create_payee");
      return toolResult({ id: payee.id, name: payee.name, count: 1 });
    }

    const prep = await this.prepService.prepareCreatePayees(
      userId,
      items.map((i) => this.toCreateRow(i)),
    );
    if (prep.okPreviews.length === 0) {
      return toolError(
        `None of the payees could be prepared.${describeSkippedRows(prep.skipped, items.length)}`,
      );
    }
    const budget = await this.writeLimiter.reserve(
      userId,
      prep.okPreviews.length,
    );
    if (budget) return budget;

    if (approvalMode === "individual") {
      const cards = prep.okPreviews.map((p) =>
        this.actionBuilder.buildCreatePayee(userId, p),
      );
      return this.runIndividual(server, ctx, userId, cards, prep.skipped);
    }

    const action = this.actionBuilder.buildBatchActions(
      userId,
      "create_payee",
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
      `Create ${prep.okPreviews.length} payee(s)?${prep.skipped.length ? ` (${prep.skipped.length} skipped)` : ""}`,
      action.descriptor,
    );
    if (isAsk(confirmation)) return confirmation.ask;
    if (confirmation === "declined")
      return toolError(
        "Cancelled: the confirmation was declined, so nothing was created.",
      );
    const ids: string[] = [];
    for (const preview of prep.okPreviews) {
      const payee = await this.payeesService.create(
        userId,
        {
          name: preview.name,
          defaultCategoryId: preview.defaultCategoryId ?? undefined,
          website: preview.website,
          address: preview.address,
          email: preview.email,
          phone: preview.phone,
        },
        preview.contactLookup ? { contactLookup: preview.contactLookup } : {},
      );
      ids.push(payee.id);
      await this.writeLimiter.record(userId, "create_payee");
    }
    return toolResult({ ids, count: ids.length, skipped: prep.skipped });
  }

  private async manageUpdate(
    server: McpServer,
    ctx: ServerContext,
    userId: string,
    items: ManagePayeeItem[],
    approvalMode: ApprovalMode,
  ) {
    if (items.length === 1) {
      const preview = await this.prepService.prepareUpdatePayeeSingle(
        userId,
        this.toUpdateRow(items[0]),
      );
      const budget = await this.writeLimiter.reserve(userId, 1);
      if (budget) return budget;
      const action = this.actionBuilder.buildUpdatePayee(userId, preview);
      const outcome = await this.emitOrConfirm(
        server,
        ctx,
        userId,
        action,
        `Apply this payee edit?\nName: ${preview.name}\nDefault category: ${preview.defaultCategoryName ?? "(none)"}${preview.website !== undefined ? `\nWebsite: ${preview.website ?? "(cleared)"}` : ""}${contactCardLines(preview)}`,
      );
      if (isAsk(outcome)) return outcome.ask;
      if (outcome === "relay") return toolResult(RELAY_PREVIEW_SHOWN);
      if (outcome === "declined")
        return toolError(
          "Cancelled: the confirmation was declined, so the payee was not changed.",
        );
      const payee = await this.payeesService.update(userId, preview.payeeId, {
        name: preview.name,
        defaultCategoryId: preview.defaultCategoryId,
        website: preview.website,
        address: preview.address,
        email: preview.email,
        phone: preview.phone,
      });
      await this.writeLimiter.record(userId, "update_payee");
      return toolResult({ id: payee.id, name: payee.name, count: 1 });
    }

    const prep = await this.prepService.prepareUpdatePayees(
      userId,
      items.map((i) => this.toUpdateRow(i)),
    );
    if (prep.okPreviews.length === 0) {
      return toolError(
        `None of the payee edits could be prepared.${describeSkippedRows(prep.skipped, items.length)}`,
      );
    }
    const budget = await this.writeLimiter.reserve(
      userId,
      prep.okPreviews.length,
    );
    if (budget) return budget;

    if (approvalMode === "individual") {
      const cards = prep.okPreviews.map((p) =>
        this.actionBuilder.buildUpdatePayee(userId, p),
      );
      return this.runIndividual(server, ctx, userId, cards, prep.skipped);
    }

    const action = this.actionBuilder.buildBatchActions(
      userId,
      "update_payee",
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
      `Apply ${prep.okPreviews.length} payee edit(s)?${prep.skipped.length ? ` (${prep.skipped.length} skipped)` : ""}`,
      action.descriptor,
    );
    if (isAsk(confirmation)) return confirmation.ask;
    if (confirmation === "declined")
      return toolError(
        "Cancelled: the confirmation was declined, so nothing was changed.",
      );
    const ids: string[] = [];
    for (const preview of prep.okPreviews) {
      const payee = await this.payeesService.update(userId, preview.payeeId, {
        name: preview.name,
        defaultCategoryId: preview.defaultCategoryId,
        website: preview.website,
        address: preview.address,
        email: preview.email,
        phone: preview.phone,
      });
      ids.push(payee.id);
      await this.writeLimiter.record(userId, "update_payee");
    }
    return toolResult({ ids, count: ids.length, skipped: prep.skipped });
  }

  private async manageDelete(
    server: McpServer,
    ctx: ServerContext,
    userId: string,
    items: ManagePayeeItem[],
    approvalMode: ApprovalMode,
  ) {
    if (items.length === 1) {
      const preview = await this.prepService.prepareDeletePayeeSingle(
        userId,
        this.toDeleteRow(items[0]),
      );
      const budget = await this.writeLimiter.reserve(userId, 1);
      if (budget) return budget;
      const action = this.actionBuilder.buildDeletePayee(userId, preview);
      const outcome = await this.emitOrConfirm(
        server,
        ctx,
        userId,
        action,
        `Delete this payee?\nName: ${preview.name}`,
      );
      if (isAsk(outcome)) return outcome.ask;
      if (outcome === "relay") return toolResult(RELAY_PREVIEW_SHOWN);
      if (outcome === "declined")
        return toolError(
          "Cancelled: the confirmation was declined, so the payee was not deleted.",
        );
      await this.payeesService.remove(userId, preview.payeeId);
      await this.writeLimiter.record(userId, "delete_payee");
      return toolResult({ id: preview.payeeId, deleted: true, count: 1 });
    }

    const prep = await this.prepService.prepareDeletePayees(
      userId,
      items.map((i) => this.toDeleteRow(i)),
    );
    if (prep.okPreviews.length === 0) {
      return toolError(
        `None of the payees could be prepared.${describeSkippedRows(prep.skipped, items.length)}`,
      );
    }
    const budget = await this.writeLimiter.reserve(
      userId,
      prep.okPreviews.length,
    );
    if (budget) return budget;

    if (approvalMode === "individual") {
      const cards = prep.okPreviews.map((p) =>
        this.actionBuilder.buildDeletePayee(userId, p),
      );
      return this.runIndividual(server, ctx, userId, cards, prep.skipped);
    }

    const action = this.actionBuilder.buildBatchActions(
      userId,
      "delete_payee",
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
      `Delete ${prep.okPreviews.length} payee(s)?${prep.skipped.length ? ` (${prep.skipped.length} skipped)` : ""}`,
      action.descriptor,
    );
    if (isAsk(confirmation)) return confirmation.ask;
    if (confirmation === "declined")
      return toolError(
        "Cancelled: the confirmation was declined, so nothing was deleted.",
      );
    const ids: string[] = [];
    for (const preview of prep.okPreviews) {
      await this.payeesService.remove(userId, preview.payeeId);
      ids.push(preview.payeeId);
      await this.writeLimiter.record(userId, "delete_payee");
    }
    return toolResult({ ids, count: ids.length, skipped: prep.skipped });
  }

  /**
   * Individual mode: relay path emits every card to the web chat; otherwise
   * confirm + commit each card in turn.
   */
  private async runIndividual(
    server: McpServer,
    ctx: ServerContext,
    userId: string,
    cards: PendingAiAction[],
    skipped: { index: number; reason: string }[],
  ) {
    // Only the round that asks may hand the cards to the web chat; on a retry
    // the human has already answered in their own client.
    if (
      !ctx.mcpReq.requestState() &&
      (await emitRelayCard(this.relayService, userId, cards[0]))
    ) {
      for (let i = 1; i < cards.length; i++) {
        await emitRelayCard(this.relayService, userId, cards[i]);
      }
      return toolResult(RELAY_PREVIEW_SHOWN);
    }
    // Every card is asked in ONE round: a round per card would be 25 rounds on
    // a full batch, and a multi-round-trip flow is two.
    const answers = await confirmWriteMany(
      server,
      ctx,
      confirmItemsForCards(cards, (card) => this.confirmLineFor(card)),
    );
    if (!(answers instanceof Map)) return answers.ask;
    const ids: string[] = [];
    for (const [index, card] of cards.entries()) {
      if (answers.get(cardKey(index)) === "declined") continue;
      const id = await this.commitCard(userId, card);
      if (id) ids.push(id);
    }
    return toolResult({ ids, count: ids.length, skipped });
  }

  private confirmLineFor(card: PendingAiAction): string {
    const p = card.preview;
    switch (card.type) {
      case "delete_payee":
        return `Delete this payee?\nName: ${p.name}`;
      case "update_payee":
        return `Apply this payee edit?\nName: ${p.name}\nDefault category: ${p.categoryName ?? "(none)"}${p.website !== undefined ? `\nWebsite: ${p.website ?? "(cleared)"}` : ""}${contactCardLines(p)}`;
      default:
        return `Create this payee?\nName: ${p.name}${p.categoryName ? `\nDefault category: ${p.categoryName}` : ""}${p.website ? `\nWebsite: ${p.website}` : ""}${contactCardLines(p)}`;
    }
  }

  /** Commit one signed payee card directly (non-relay individual mode). */
  private async commitCard(
    userId: string,
    card: PendingAiAction,
  ): Promise<string | null> {
    const d = card.descriptor;
    switch (d.type) {
      case "create_payee": {
        const payee = await this.payeesService.create(
          userId,
          {
            name: d.name,
            defaultCategoryId: d.defaultCategoryId ?? undefined,
            website: d.website,
            address: d.address,
            email: d.email,
            phone: d.phone,
          },
          contactLookupOptions(d),
        );
        await this.writeLimiter.record(userId, "create_payee");
        return payee.id;
      }
      case "update_payee": {
        const payee = await this.payeesService.update(userId, d.payeeId, {
          name: d.name,
          defaultCategoryId: d.defaultCategoryId,
          website: d.website,
          address: d.address,
          email: d.email,
          phone: d.phone,
        });
        await this.writeLimiter.record(userId, "update_payee");
        return payee.id;
      }
      case "delete_payee": {
        await this.payeesService.remove(userId, d.payeeId);
        await this.writeLimiter.record(userId, "delete_payee");
        return d.payeeId;
      }
      default:
        return null;
    }
  }
}
