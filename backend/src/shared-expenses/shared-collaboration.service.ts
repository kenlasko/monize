import { Injectable } from "@nestjs/common";
import { DataSource } from "typeorm";
import { withScopedDb } from "../common/db/scoped-db";
import { SharedCommandDto } from "./dto/shared-command.dto";
import {
  lockSharedGroup,
  requireRevision,
  requireSharedGroup,
  sharedActivity,
  sharedCommand,
  sharedParticipants,
} from "./shared-db";
import { sharedError } from "./shared-errors";
import { journalBalances, readSharedJournal } from "./shared-journal";
import { fixedUnits } from "./shared-money";

@Injectable()
export class SharedCollaborationService {
  constructor(private readonly dataSource: DataSource) {}

  async activity(userId: string, groupId: string, offset = 0) {
    return withScopedDb(this.dataSource, async (manager) => {
      await requireSharedGroup(manager, userId, groupId);
      const rows: {
        id: string;
        actorName: string;
        action: string;
        entryId: string | null;
        detail: Record<string, unknown>;
        createdAt: string;
      }[] = await manager.query(
        `SELECT id, actor_name AS "actorName", action, entry_id AS "entryId", detail, created_at AS "createdAt"
         FROM shared_activity WHERE group_id = $1 ORDER BY created_at DESC, id DESC LIMIT 101 OFFSET $2`,
        [groupId, offset],
      );
      return {
        items: rows.slice(0, 100),
        nextOffset: rows.length > 100 ? offset + 100 : null,
      };
    });
  }

  async remind(
    userId: string,
    groupId: string,
    participantId: string,
    dto: SharedCommandDto,
  ) {
    return withScopedDb(this.dataSource, async (manager) => {
      await lockSharedGroup(manager, groupId);
      const group = await requireSharedGroup(manager, userId, groupId, "WRITE");
      return sharedCommand(
        manager,
        userId,
        groupId,
        dto.operationId,
        { ...dto, participantId },
        async () => {
          requireRevision(group.financialRevision, dto.expectedRevision);
          const participants = await sharedParticipants(manager, groupId);
          const recipient = participants.find((p) => p.id === participantId);
          if (
            !recipient?.connected ||
            participantId === group.myParticipantId ||
            group.isDetachedCopy
          )
            sharedError("reminderRecipient");
          const balances = journalBalances(
            participants.map((p) => p.id),
            await readSharedJournal(manager, groupId),
          );
          if (!balances.settlementReady) sharedError("unknownBalance");
          if (
            fixedUnits(
              balances.positions.find((p) => p.participantId === participantId)!
                .balance!,
              4,
              true,
            ) >= 0n
          )
            sharedError("repaymentChanged");
          const recent: { id: string }[] = await manager.query(
            `SELECT id FROM shared_activity WHERE group_id = $1 AND action = 'REMINDER_SENT'
           AND detail->>'participantId' = $2 AND created_at > CURRENT_TIMESTAMP - INTERVAL '1 day' LIMIT 1`,
            [groupId, participantId],
          );
          if (recent.length) sharedError("reminderTooSoon");
          await sharedActivity(manager, userId, groupId, "REMINDER_SENT", {
            participantId,
          });
          return { id: participantId };
        },
      );
    });
  }
}
