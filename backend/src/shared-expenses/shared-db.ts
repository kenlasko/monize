import { tokenHashesEqual } from "../auth/crypto.util";
import { createHash } from "crypto";
import { EntityManager } from "typeorm";
import { getRequestContext } from "../common/request-context";
import { SharedGroup, SharedParticipant } from "./shared-types";
import { sharedError } from "./shared-errors";

export function assertSharedPrincipal(userId: string): void {
  const context = getRequestContext();
  if (context?.realUserId && context.realUserId !== userId)
    sharedError("readOnly");
}

/** All group writers, including invite acceptance, serialize before reading state. */
export async function lockSharedGroup(
  manager: EntityManager,
  groupId: string,
): Promise<void> {
  await manager.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
    `shared-group:${groupId}`,
  ]);
}

export async function requireSharedGroup(
  manager: EntityManager,
  userId: string,
  groupId: string,
  access: "READ" | "WRITE" | "OWNER" = "READ",
  allowArchived = false,
): Promise<SharedGroup> {
  assertSharedPrincipal(userId);
  const rows: SharedGroup[] = await manager.query(
    `
    SELECT g.id, g.owner_user_id AS "ownerUserId", g.name, g.description,
      g.currency_code AS "currencyCode", c.decimal_places AS "decimalPlaces",
      CASE WHEN g.ownership_request_id IS NOT NULL THEN json_build_object('requestId', g.ownership_request_id,
        'participantId', g.ownership_candidate_id, 'accepted', EXISTS (SELECT 1 FROM shared_memberships candidate
          WHERE candidate.group_id = g.id AND candidate.participant_id = g.ownership_candidate_id AND candidate.revoked_at IS NULL
          AND candidate.ownership_accepted_request_id = g.ownership_request_id)) ELSE NULL END AS "ownershipTransfer",
      g.revision, g.financial_revision AS "financialRevision", g.archived_at AS "archivedAt",
      CASE WHEN g.owner_user_id = $2 THEN 'OWNER' ELSE m.role END AS role,
      m.participant_id AS "myParticipantId", m.muted, g.is_detached_copy AS "isDetachedCopy", g.split_template AS "splitTemplate"
    FROM shared_groups g JOIN currencies c ON c.code = g.currency_code
    LEFT JOIN shared_memberships m ON m.group_id = g.id AND m.user_id = $2 AND m.revoked_at IS NULL
    WHERE g.id = $1 AND (g.owner_user_id = $2 OR m.id IS NOT NULL)`,
    [groupId, userId],
  );
  const group = rows[0];
  if (!group) sharedError("notFound");
  if (
    (access === "OWNER" && group.role !== "OWNER") ||
    (access === "WRITE" && group.role === "VIEWER")
  )
    sharedError("readOnly");
  if (access !== "READ" && group.archivedAt && !allowArchived)
    sharedError("archived");
  return group;
}

export async function sharedParticipants(
  manager: EntityManager,
  groupId: string,
): Promise<SharedParticipant[]> {
  return manager.query(
    `SELECT p.id, p.name, p.is_active AS "isActive", m.id IS NOT NULL AS connected, m.role
    FROM shared_participants p LEFT JOIN shared_memberships m ON m.participant_id = p.id AND m.revoked_at IS NULL
    WHERE p.group_id = $1 ORDER BY (m.user_id = (SELECT app_current_user_id())) DESC NULLS LAST, lower(p.name), p.id`,
    [groupId],
  );
}

export function requireRevision(actual: number, expected: number): void {
  if (actual !== expected) sharedError("stale");
}

/** Canonical object keys make a replay independent of JSON property insertion order. */
export function sharedFingerprint(value: unknown): string {
  const canonical = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(canonical);
    if (input && typeof input === "object")
      return Object.fromEntries(
        Object.keys(input)
          .sort()
          .map((key) => [
            key,
            canonical((input as Record<string, unknown>)[key]),
          ]),
      );
    return input;
  };
  return createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
}

/** Called under the group advisory lock. A response and its effects commit together. */
export async function sharedCommand<T>(
  manager: EntityManager,
  userId: string,
  groupId: string,
  operationId: string,
  payload: unknown,
  execute: () => Promise<T>,
): Promise<T> {
  const hash = sharedFingerprint(payload);
  const prior: { payload_hash: string; result: T }[] = await manager.query(
    "SELECT payload_hash, result FROM shared_commands WHERE id = $1 AND user_id = $2 AND group_id = $3",
    [operationId, userId, groupId],
  );
  if (prior[0]) {
    if (!tokenHashesEqual(prior[0].payload_hash, hash))
      sharedError("retryChanged");
    return prior[0].result;
  }
  await manager.query(
    "INSERT INTO shared_commands (id, user_id, group_id, payload_hash) VALUES ($1, $2, $3, $4)",
    [operationId, userId, groupId, hash],
  );
  const result = await execute();
  await manager.query(
    "UPDATE shared_commands SET result = $1 WHERE id = $2 AND user_id = $3",
    [JSON.stringify(result), operationId, userId],
  );
  return result;
}

export async function sharedActivity(
  manager: EntityManager,
  userId: string,
  groupId: string,
  action: string,
  detail: Record<string, unknown> = {},
  entryId?: string,
): Promise<void> {
  // A group-local name is deliberately used instead of the account's email/name.
  await manager.query(
    `INSERT INTO shared_activity (group_id, entry_id, actor_user_id, actor_name, action, detail)
    SELECT $1, $2, $3, p.name, $4, $5 FROM shared_memberships m
    JOIN shared_participants p ON p.id = m.participant_id
    WHERE m.group_id = $1 AND m.user_id = $3 AND m.revoked_at IS NULL`,
    [groupId, entryId ?? null, userId, action, JSON.stringify(detail)],
  );
}

export async function currencyPlaces(
  manager: EntityManager,
  code: string,
): Promise<number> {
  const rows: { decimal_places: number }[] = await manager.query(
    "SELECT decimal_places FROM currencies WHERE code = $1",
    [code],
  );
  const places = rows[0]?.decimal_places;
  if (places === undefined || places < 0 || places > 4) sharedError("currency");
  return places;
}

export async function advanceSharedRevision(
  manager: EntityManager,
  groupId: string,
  financial: boolean,
): Promise<void> {
  await manager.query(
    "UPDATE shared_groups SET revision = revision + 1, financial_revision = financial_revision + $2 WHERE id = $1",
    [groupId, financial ? 1 : 0],
  );
}
