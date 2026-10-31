import { personalEffect } from "./shared-projection";
import { EntityManager } from "typeorm";
import { sharedBalances } from "./shared-balances";
import {
  SHARED_ALLOCATION_SELECT,
  SHARED_ENTRY_SELECT,
  SharedEntry,
  StoredAllocation,
} from "./shared-types";

export async function readSharedJournal(
  manager: EntityManager,
  groupId: string,
) {
  const entries: SharedEntry[] = await manager.query(
    `SELECT ${SHARED_ENTRY_SELECT} FROM shared_entries WHERE group_id = $1 ORDER BY entry_date DESC, created_at DESC, id DESC`,
    [groupId],
  );
  const allocations: StoredAllocation[] = await manager.query(
    `SELECT ${SHARED_ALLOCATION_SELECT} FROM shared_allocations WHERE group_id = $1 ORDER BY participant_id`,
    [groupId],
  );
  const byEntry = new Map<string, StoredAllocation[]>();
  for (const row of allocations)
    byEntry.set(row.entryId, [...(byEntry.get(row.entryId) ?? []), row]);
  return entries.map((entry) => ({
    ...entry,
    allocations: byEntry.get(entry.id) ?? [],
  }));
}

export type SharedJournalEntry = Awaited<
  ReturnType<typeof readSharedJournal>
>[number];

export function journalBalances(
  participantIds: readonly string[],
  entries: readonly SharedJournalEntry[],
) {
  return sharedBalances(
    participantIds,
    entries
      .filter(
        (entry) =>
          entry.state === "POSTED" || entry.draftReason === "MISSING_RATE",
      )
      .map((entry) => ({
        type: entry.type,
        amount: entry.groupAmount,
        shares: entry.allocations
          .filter((row) => row.kind === "SHARE" && row.groupAmount !== null)
          .map((row) => ({
            participantId: row.participantId,
            amount: row.groupAmount!,
          })),
        contributions: entry.allocations
          .filter(
            (row) => row.kind === "CONTRIBUTION" && row.groupAmount !== null,
          )
          .map((row) => ({
            participantId: row.participantId,
            amount: row.groupAmount!,
          })),
        fromParticipantId: entry.fromParticipantId,
        toParticipantId: entry.toParticipantId,
      })),
  );
}

/** No user IDs or private ledger references cross the collaboration boundary. */
export function publicSharedEntry(
  entry: SharedJournalEntry,
  userId: string,
  owner: boolean,
  participantId?: string | null,
) {
  const { createdByUserId, ...publicFields } = entry;
  return {
    ...publicFields,
    ownEffect: participantId ? personalEffect(entry, participantId) : null,
    canEdit: owner || createdByUserId === userId,
  };
}
