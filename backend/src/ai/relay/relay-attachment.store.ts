import { Injectable, Logger } from "@nestjs/common";
import { randomUUID } from "crypto";
import { AttachmentDto } from "../query/dto/ai-query.dto";
import { validateAttachments } from "../query/attachment-validation";
import { RelayAttachmentRef } from "./ai-relay.types";

/** URI scheme the agent reads to fetch a relayed attachment as an MCP resource. */
export const ATTACHMENT_URI_SCHEME = "monize-attachment";

/** Build the `monize-attachment://<id>` resource URI for an attachment id. */
export function attachmentUri(id: string): string {
  return `${ATTACHMENT_URI_SCHEME}://${id}`;
}

/**
 * How long a stored attachment is retained before it is pruned. Matched to the
 * relay broker's HARD_WAIT_MS so an attachment always outlives the longest a
 * prompt can stay in flight (the agent can still read it right up to the moment
 * the browser gives up).
 */
const ATTACHMENT_TTL_MS = 20 * 60 * 1000; // 20 minutes

/**
 * Cap on attachments retained per user. Bounds memory for this single-process,
 * in-memory broker if a user uploads many attachments whose prompts never
 * settle. Oldest entries (by store time) are evicted first.
 */
const MAX_STORED_ATTACHMENTS = 50;

/** A validated attachment held in memory for an in-flight relayed prompt. */
export interface StoredAttachment {
  id: string;
  userId: string;
  kind: "image" | "pdf" | "text";
  mediaType: string;
  filename: string;
  /** Decoded bytes (already validated for size and magic-byte signature). */
  data: Buffer;
  /** Epoch ms the attachment was stored; used for TTL pruning and LRU eviction. */
  at: number;
}

/**
 * In-memory, per-process store for attachments uploaded with a relayed prompt.
 *
 * Mirrors the AiRelayService broker's ephemeral design: nothing touches the DB
 * or disk, and a multi-replica deployment would need a shared backplane. The
 * agent never receives the bytes directly -- it reads them through the
 * `monize-attachment://<id>` MCP resource, which looks them up here scoped to
 * the calling user. The nested map keying makes a cross-user read structurally
 * impossible: an id is only ever resolved within its owner's bucket.
 */
@Injectable()
export class RelayAttachmentStore {
  private readonly logger = new Logger(RelayAttachmentStore.name);

  /** userId -> (attachmentId -> attachment). */
  private readonly byUser = new Map<string, Map<string, StoredAttachment>>();

  /**
   * Validate and persist attachments for a user, returning lightweight refs
   * (no bytes) to carry on the claimed prompt. Re-runs the shared
   * validateAttachments (size limits + magic bytes) so the client is never
   * trusted, exactly like the native query path.
   */
  store(userId: string, attachments: AttachmentDto[]): RelayAttachmentRef[] {
    if (attachments.length === 0) {
      return [];
    }
    validateAttachments(attachments);

    const now = Date.now();
    const existing =
      this.byUser.get(userId) ?? new Map<string, StoredAttachment>();
    // Build the next bucket immutably from the existing entries plus the new ones.
    const next = new Map(existing);

    const refs: RelayAttachmentRef[] = attachments.map((att) => {
      const id = randomUUID();
      // Strip any stray whitespace/newlines from the base64 before decoding.
      const data = Buffer.from(att.data.replace(/\s+/g, ""), "base64");
      next.set(id, {
        id,
        userId,
        kind: att.kind,
        mediaType: att.mediaType,
        filename: att.filename,
        data,
        at: now,
      });
      return {
        id,
        filename: att.filename,
        mediaType: att.mediaType,
        kind: att.kind,
        uri: attachmentUri(id),
      };
    });

    this.byUser.set(userId, this.enforceBounds(next, now));
    return refs;
  }

  /**
   * Look up a stored attachment for a user, or undefined if it is unknown or
   * expired. Prunes expired entries for the user on access.
   */
  get(userId: string, id: string): StoredAttachment | undefined {
    this.pruneExpired(userId);
    return this.byUser.get(userId)?.get(id);
  }

  /**
   * Eagerly drop attachments once their prompt has settled. TTL is the
   * backstop; this just reclaims memory sooner. Missing ids are ignored.
   */
  releaseForPrompt(userId: string, ids: string[]): void {
    const bucket = this.byUser.get(userId);
    if (!bucket || ids.length === 0) {
      return;
    }
    const next = new Map(bucket);
    for (const id of ids) {
      next.delete(id);
    }
    if (next.size === 0) {
      this.byUser.delete(userId);
    } else {
      this.byUser.set(userId, next);
    }
  }

  /** Drop expired entries for a user; clean up the empty bucket. */
  private pruneExpired(userId: string): void {
    const bucket = this.byUser.get(userId);
    if (!bucket) {
      return;
    }
    const cutoff = Date.now() - ATTACHMENT_TTL_MS;
    const live = [...bucket.entries()].filter(([, v]) => v.at >= cutoff);
    if (live.length === 0) {
      this.byUser.delete(userId);
    } else if (live.length !== bucket.size) {
      this.byUser.set(userId, new Map(live));
    }
  }

  /**
   * Drop expired entries and evict oldest until within the per-user cap. Pure:
   * returns the bounded bucket rather than mutating in place.
   */
  private enforceBounds(
    bucket: Map<string, StoredAttachment>,
    now: number,
  ): Map<string, StoredAttachment> {
    const cutoff = now - ATTACHMENT_TTL_MS;
    let entries = [...bucket.entries()].filter(([, v]) => v.at >= cutoff);
    if (entries.length > MAX_STORED_ATTACHMENTS) {
      const ordered = [...entries].sort((a, b) => a[1].at - b[1].at);
      entries = ordered.slice(entries.length - MAX_STORED_ATTACHMENTS);
      this.logger.warn(
        `Relay attachment store for a user exceeded ${MAX_STORED_ATTACHMENTS}; evicted oldest`,
      );
    }
    return new Map(entries);
  }
}
