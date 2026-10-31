import { BadRequestException } from "@nestjs/common";
import { randomUUID } from "crypto";
import { EntityManager } from "typeorm";
import { tr } from "../i18n/translate";
import {
  personalFingerprint,
  SharedPersonalEffect,
} from "../shared-expenses/shared-projection";
import { canonicalUuid } from "./backup-id-remap.util";
import { BackupData, backupTables } from "./backup-format";

/** Explicit membership predicates also protect exports when RLS is off. */
export const SHARED_EXPORT_GROUPS = `SELECT g.id FROM shared_groups g WHERE
  g.owner_user_id = $1 OR EXISTS (SELECT 1 FROM shared_memberships m
    WHERE m.group_id = g.id AND m.user_id = $1 AND m.revoked_at IS NULL)`;

export function exportedAttachment(alias = "transaction_attachments"): string {
  return `(${alias}.user_id = $1 AND ${alias}.shared_group_id IS NULL AND ${alias}.shared_entry_id IS NULL)
    OR ${alias}.shared_group_id IN (${SHARED_EXPORT_GROUPS})
    OR ${alias}.shared_entry_id IN (SELECT id FROM shared_entries WHERE group_id IN (${SHARED_EXPORT_GROUPS}))`;
}

/** Nonstandard principal columns are forced, never taken from an archive. */
export const RESTORE_PRINCIPAL_COLUMNS: Readonly<
  Record<string, Readonly<Record<string, "owner" | "anonymous">>>
> = {
  shared_groups: { owner_user_id: "owner" },
  shared_entries: { created_by_user_id: "owner" },
  shared_activity: { actor_user_id: "anonymous" },
};

/** Live ownership and upload replay state never survives a detached restore. */
export const RESTORE_CLEARED_COLUMNS: Readonly<
  Record<string, readonly string[]>
> = {
  shared_groups: ["ownership_request_id", "ownership_candidate_id"],
  transaction_attachments: ["upload_request_id", "upload_fingerprint"],
};

/** Before authentication/staging: the virtual snapshot claim must be in this file's group. */
export function validateSharedSnapshot(data: BackupData): BackupData {
  const tables = backupTables(data);
  if (!tables.shared_groups) return data;
  const participants = new Map(
    (tables.shared_participants ?? []).map((p) => [
      canonicalUuid(p.id),
      canonicalUuid(p.group_id),
    ]),
  );
  const groups = (tables.shared_groups ?? []).map((group) => {
    const participant = canonicalUuid(group._snapshot_participant_id);
    if (
      !participant ||
      participants.get(participant) !== canonicalUuid(group.id)
    ) {
      throw new BadRequestException(
        tr(
          "sharedExpenses.invalidBackup",
          "The shared snapshot does not identify a participant in its own group.",
        ),
      );
    }
    return { ...group, _snapshot_participant_id: participant };
  });
  return { ...data, shared_groups: groups } as BackupData;
}

/** Called after every ID has been remapped, before any bytes or rows are written. */
export function prepareSharedRestore(
  data: BackupData,
  userId: string,
): BackupData {
  const tables = backupTables(data);
  const next: Record<string, unknown> = { ...data };
  const rewrittenTables = new Set([
    ...Object.keys(RESTORE_PRINCIPAL_COLUMNS),
    ...Object.keys(RESTORE_CLEARED_COLUMNS),
  ]);
  for (const table of rewrittenTables) {
    if (!tables[table]) continue;
    next[table] = tables[table].map((row) => ({
      ...row,
      ...Object.fromEntries(
        Object.entries(RESTORE_PRINCIPAL_COLUMNS[table] ?? {}).map(
          ([column, policy]) => [column, policy === "owner" ? userId : null],
        ),
      ),
      ...Object.fromEntries(
        (RESTORE_CLEARED_COLUMNS[table] ?? []).map((column) => [column, null]),
      ),
      ...(table === "shared_groups" ? { is_detached_copy: true } : {}),
    }));
  }
  if (tables.shared_postings)
    next.shared_postings = tables.shared_postings.map((row) => ({
      ...row,
      input_fingerprint: personalFingerprint(
        (row.accepted_snapshot as { effect: SharedPersonalEffect }).effect,
      ),
    }));
  return next as unknown as BackupData;
}

/** Only freshly remapped groups receive a new owner membership; no old grant is replayed. */
export async function claimRestoredSharedGroups(
  manager: EntityManager,
  data: BackupData,
  userId: string,
): Promise<void> {
  for (const group of backupTables(data).shared_groups ?? []) {
    await manager.query(
      `INSERT INTO shared_memberships (id, group_id, participant_id, user_id, role, muted)
      SELECT $1, g.id, p.id, $4, 'OWNER', true FROM shared_groups g
      JOIN shared_participants p ON p.group_id = g.id AND p.id = $3
      WHERE g.id = $2 AND g.owner_user_id = $4 AND g.is_detached_copy`,
      [randomUUID(), group.id, group._snapshot_participant_id, userId],
    );
  }
}
