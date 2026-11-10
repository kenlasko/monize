import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { DataSource, EntityManager } from "typeorm";
import { tr } from "../i18n/translate";
import { withScopedDb } from "../common/db/scoped-db";
import { stripHtml } from "../common/sanitization.util";
import { didYouMean } from "../common/name-suggestions.util";
import { BulkCreateSkip, bulkSkipReason } from "../common/bulk-create.types";
import type {
  AiActionPreviewRow,
  BatchCreateTagRow,
  BatchDeleteTagRow,
  BatchUpdateTagRow,
} from "../ai/actions/ai-action.types";
import { Tag } from "./entities/tag.entity";
import { TagsService } from "./tags.service";

/** One `manage_tags` item: the tag by name, and what to set. */
export interface ManageTagRow {
  /** create: the new tag's name. update/delete: the tag's current name. */
  name: string;
  /** update: rename to this. */
  newName?: string;
  /** #RRGGBB; an empty string clears it. */
  color?: string;
  /** An icon name; an empty string clears it. */
  icon?: string;
}

export type ManageTagOperation = "create" | "update" | "delete";

export interface CreateTagPreview {
  name: string;
  color: string | null;
  icon: string | null;
}

/** A tag edit: only the fields it changes are present. */
export interface UpdateTagPreview {
  tagId: string;
  /** The tag's name now. */
  currentName: string;
  name?: string;
  color?: string | null;
  icon?: string | null;
}

export interface DeleteTagPreview {
  tagId: string;
  name: string;
  /** How often the tag is used, counted as `list_tags` counts it (`getUsage`). */
  useCount: number;
}

export type TagPreview = CreateTagPreview | UpdateTagPreview | DeleteTagPreview;

export interface PrepareTagsResult<P, R> {
  okPreviews: P[];
  okRows: R[];
  previewRows: AiActionPreviewRow[];
  okIndex: number[];
  skipped: BulkCreateSkip[];
}

const HEX_COLOR = /^#[0-9A-Fa-f]{6}$/;

/** The card row for a tag action (single card fields and bulk rows alike). */
export function tagPreviewRow(
  preview: CreateTagPreview | UpdateTagPreview | DeleteTagPreview,
): AiActionPreviewRow {
  if ("useCount" in preview) {
    return { status: "ok", name: preview.name, tagUseCount: preview.useCount };
  }
  if ("tagId" in preview) {
    return {
      status: "ok",
      name: preview.name ?? preview.currentName,
      ...(preview.name !== undefined
        ? { previousName: preview.currentName }
        : {}),
      ...(preview.color !== undefined ? { tagColor: preview.color } : {}),
      ...(preview.icon !== undefined ? { tagIcon: preview.icon } : {}),
    };
  }
  return {
    status: "ok",
    name: preview.name,
    tagColor: preview.color,
    tagIcon: preview.icon,
  };
}

/**
 * Name resolution and previews for `manage_tags`, shared by the assistant's
 * executor and the MCP tool so the two surfaces refuse and propose alike. A tag
 * is named, never addressed by id: names are unique per user, case-insensitively
 * (`idx_tags_user_name`). Every check here is repeated by the write
 * (`TagsService.create` / `update` refuse a taken name), so a card that went
 * stale is refused at confirm, never half-applied.
 */
@Injectable()
export class TagToolPrepService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly tagsService: TagsService,
  ) {}

  async prepareCreate(
    userId: string,
    row: ManageTagRow,
  ): Promise<CreateTagPreview> {
    const name = this.cleanName(row.name);
    return withScopedDb(this.dataSource, async (m) => {
      const [existing] = await this.tagsService.findByNames(m, userId, [name]);
      if (existing) throw this.nameConflict(name);
      return {
        name,
        color: this.cleanColor(row.color) ?? null,
        icon: this.cleanIcon(row.icon) ?? null,
      };
    });
  }

  async prepareUpdate(
    userId: string,
    row: ManageTagRow,
  ): Promise<UpdateTagPreview> {
    return withScopedDb(this.dataSource, async (m) => {
      const tag = await this.resolve(m, userId, row.name);
      const preview: UpdateTagPreview = {
        tagId: tag.id,
        currentName: tag.name,
      };
      if (row.newName !== undefined) {
        const newName = this.cleanName(row.newName);
        if (newName !== tag.name) {
          const [other] = await this.tagsService.findByNames(m, userId, [
            newName,
          ]);
          if (other && other.id !== tag.id) throw this.nameConflict(newName);
          preview.name = newName;
        }
      }
      const color = this.cleanColor(row.color);
      if (
        color !== undefined &&
        color?.toLowerCase() !== tag.color?.toLowerCase()
      ) {
        preview.color = color;
      }
      const icon = this.cleanIcon(row.icon);
      if (icon !== undefined && icon !== tag.icon) preview.icon = icon;
      if (
        preview.name === undefined &&
        preview.color === undefined &&
        preview.icon === undefined
      ) {
        throw new BadRequestException(
          tr(
            "errors.tags.noChange",
            `The tag "${tag.name}" already has these values: give a newName, color or icon that differs.`,
            { name: tag.name },
          ),
        );
      }
      return preview;
    });
  }

  async prepareDelete(
    userId: string,
    row: ManageTagRow,
  ): Promise<DeleteTagPreview> {
    const tag = await withScopedDb(this.dataSource, (m) =>
      this.resolve(m, userId, row.name),
    );
    // The figure list_tags gave the model for this tag, so the card and the
    // listing never disagree about the same tag.
    const usage = await this.tagsService.getUsage(userId);
    return {
      tagId: tag.id,
      name: tag.name,
      useCount: usage[tag.id]?.count ?? 0,
    };
  }

  /**
   * Every row of a batch, best-effort: a row that cannot be prepared is
   * skipped with its reason, and so is a row naming a tag an earlier row of the
   * same batch already creates or acts on (the second write would be refused).
   */
  async prepareMany(
    userId: string,
    operation: "create",
    rows: ManageTagRow[],
  ): Promise<PrepareTagsResult<CreateTagPreview, BatchCreateTagRow>>;
  async prepareMany(
    userId: string,
    operation: "update",
    rows: ManageTagRow[],
  ): Promise<PrepareTagsResult<UpdateTagPreview, BatchUpdateTagRow>>;
  async prepareMany(
    userId: string,
    operation: "delete",
    rows: ManageTagRow[],
  ): Promise<PrepareTagsResult<DeleteTagPreview, BatchDeleteTagRow>>;
  async prepareMany(
    userId: string,
    operation: ManageTagOperation,
    rows: ManageTagRow[],
  ): Promise<
    PrepareTagsResult<
      TagPreview,
      BatchCreateTagRow | BatchUpdateTagRow | BatchDeleteTagRow
    >
  > {
    const result: PrepareTagsResult<
      TagPreview,
      BatchCreateTagRow | BatchUpdateTagRow | BatchDeleteTagRow
    > = {
      okPreviews: [],
      okRows: [],
      previewRows: [],
      okIndex: [],
      skipped: [],
    };
    // Names (lower-cased) an earlier row creates, renames to or acts on.
    const claimed = new Set<string>();
    for (const [index, row] of rows.entries()) {
      try {
        const preview = await this.prepareOne(userId, operation, row);
        const keys = this.claimedNames(preview);
        if (keys.some((key) => claimed.has(key))) {
          throw new BadRequestException(
            tr(
              "errors.tags.repeatedInBatch",
              "Another item in this request already names this tag.",
            ),
          );
        }
        keys.forEach((key) => claimed.add(key));
        result.okPreviews.push(preview);
        result.okRows.push(this.toBatchRow(preview));
        result.okIndex.push(index);
        result.previewRows.push(tagPreviewRow(preview));
      } catch (err) {
        const reason = bulkSkipReason(err);
        result.skipped.push({ index, reason });
        result.previewRows.push({
          status: "error",
          name: row.name ?? null,
          error: reason,
        });
      }
    }
    return result;
  }

  prepareOne(
    userId: string,
    operation: ManageTagOperation,
    row: ManageTagRow,
  ): Promise<TagPreview> {
    if (operation === "create") return this.prepareCreate(userId, row);
    if (operation === "update") return this.prepareUpdate(userId, row);
    return this.prepareDelete(userId, row);
  }

  private toBatchRow(
    preview: TagPreview,
  ): BatchCreateTagRow | BatchUpdateTagRow | BatchDeleteTagRow {
    if ("useCount" in preview) return { tagId: preview.tagId };
    if ("tagId" in preview) {
      return {
        tagId: preview.tagId,
        ...(preview.name !== undefined ? { name: preview.name } : {}),
        ...(preview.color !== undefined ? { color: preview.color } : {}),
        ...(preview.icon !== undefined ? { icon: preview.icon } : {}),
      };
    }
    return { name: preview.name, color: preview.color, icon: preview.icon };
  }

  private claimedNames(preview: TagPreview): string[] {
    if ("useCount" in preview) return [preview.name.toLowerCase()];
    if ("tagId" in preview) {
      return [preview.currentName, preview.name]
        .filter((name): name is string => name !== undefined)
        .map((name) => name.toLowerCase());
    }
    return [preview.name.toLowerCase()];
  }

  /** The user's tag of this name (case-insensitively), or a refusal naming the closest. */
  private async resolve(
    m: EntityManager,
    userId: string,
    rawName: string,
  ): Promise<Tag> {
    const name = rawName.trim();
    const [tag] = name
      ? await this.tagsService.findByNames(m, userId, [name])
      : [];
    if (tag) return tag;
    const all = (await m.find(Tag, { where: { userId } })).map((t) => t.name);
    const suggestion = didYouMean(name, all);
    throw new NotFoundException(
      tr("errors.tags.unknownName", `Unknown tag: ${name}.${suggestion}`, {
        name,
        suggestion,
      }),
    );
  }

  private cleanName(raw: string): string {
    const name = (stripHtml(raw) ?? "").trim();
    if (!name) {
      throw new BadRequestException(
        tr("errors.tags.nameRequired", "A tag needs a name."),
      );
    }
    return name;
  }

  /** undefined: not given; null: cleared; else a validated #RRGGBB. */
  private cleanColor(raw: string | undefined): string | null | undefined {
    if (raw === undefined) return undefined;
    const color = raw.trim();
    if (color === "") return null;
    if (!HEX_COLOR.test(color)) {
      throw new BadRequestException(
        tr(
          "errors.tags.invalidColor",
          `"${color}" is not a colour: use #RRGGBB, for example #FF5733.`,
          { color },
        ),
      );
    }
    return color;
  }

  /** undefined: not given; null: cleared; else the icon name. */
  private cleanIcon(raw: string | undefined): string | null | undefined {
    if (raw === undefined) return undefined;
    const icon = (stripHtml(raw) ?? "").trim();
    return icon === "" ? null : icon;
  }

  private nameConflict(name: string): ConflictException {
    return new ConflictException(
      tr("errors.tags.nameConflict", `A tag named "${name}" already exists`, {
        name,
      }),
    );
  }
}
