import { randomUUID } from "crypto";
import { SharedCommandDto } from "./dto/shared-command.dto";
import { Injectable } from "@nestjs/common";
import { DataSource } from "typeorm";
import { withScopedDb } from "../common/db/scoped-db";
import { ChangeSharedMembershipDto } from "./dto/shared-group.dto";
import {
  advanceSharedRevision,
  lockSharedGroup,
  requireRevision,
  requireSharedGroup,
  sharedActivity,
  sharedCommand,
} from "./shared-db";
import { sharedError } from "./shared-errors";

@Injectable()
export class SharedMembershipsService {
  constructor(private readonly dataSource: DataSource) {}

  async change(
    userId: string,
    groupId: string,
    participantId: string,
    dto: ChangeSharedMembershipDto,
  ) {
    return withScopedDb(this.dataSource, async (manager) => {
      await lockSharedGroup(manager, groupId);
      const group = await requireSharedGroup(
        manager,
        userId,
        groupId,
        "OWNER",
        true,
      );
      return sharedCommand(
        manager,
        userId,
        groupId,
        dto.operationId,
        { ...dto, participantId },
        async () => {
          requireRevision(group.revision, dto.expectedRevision);
          const members: {
            id: string;
            user_id: string;
            role: string;
            active: boolean;
          }[] = await manager.query(
            "SELECT m.id, m.user_id, m.role, p.is_active AS active FROM shared_memberships m JOIN shared_participants p ON p.id = m.participant_id WHERE m.group_id = $1 AND m.participant_id = $2 AND m.revoked_at IS NULL",
            [groupId, participantId],
          );
          const member = members[0];
          if (!member || member.user_id === userId || member.role === "OWNER")
            sharedError("participant");
          if (
            (dto.action === "REQUEST_OWNER" ||
              dto.action === "TRANSFER_OWNER") &&
            !member.active
          )
            sharedError("participant");
          if (dto.action === "REQUEST_OWNER") {
            const requestId = randomUUID();
            await manager.query(
              "UPDATE shared_groups SET ownership_request_id = $2, ownership_candidate_id = $3, revision = revision + 1 WHERE id = $1",
              [groupId, requestId, participantId],
            );
            await sharedActivity(
              manager,
              userId,
              groupId,
              "OWNERSHIP_REQUESTED",
              { participantId },
            );
            return { id: participantId, revision: group.revision + 1 };
          }
          if (
            dto.action === "TRANSFER_OWNER" &&
            (group.ownershipTransfer?.participantId !== participantId ||
              !group.ownershipTransfer.accepted)
          )
            sharedError("ownershipConsent");
          await sharedActivity(
            manager,
            userId,
            groupId,
            dto.action === "TRANSFER_OWNER"
              ? "OWNER_TRANSFERRED"
              : dto.action === "REVOKE"
                ? "MEMBER_REVOKED"
                : "MEMBER_UPDATED",
            { participantId, action: dto.action },
          );
          if (dto.action === "TRANSFER_OWNER") {
            await manager.query(
              "UPDATE shared_memberships SET role = 'EDITOR' WHERE group_id = $1 AND user_id = $2 AND revoked_at IS NULL",
              [groupId, userId],
            );
            await manager.query(
              "UPDATE shared_memberships SET role = 'OWNER' WHERE id = $1",
              [member.id],
            );
            await manager.query(
              "UPDATE shared_groups SET owner_user_id = $2, ownership_request_id = NULL, ownership_candidate_id = NULL, revision = revision + 1 WHERE id = $1",
              [groupId, member.user_id],
            );
          } else {
            if (
              dto.action === "REVOKE" &&
              group.ownershipTransfer?.participantId === participantId
            ) {
              await manager.query(
                "UPDATE shared_groups SET ownership_request_id = NULL, ownership_candidate_id = NULL WHERE id = $1",
                [groupId],
              );
            }
            await manager.query(
              "UPDATE shared_memberships SET role = CASE WHEN $2 = 'REVOKE' THEN role ELSE $2 END, revoked_at = CASE WHEN $2 = 'REVOKE' THEN CURRENT_TIMESTAMP ELSE NULL END WHERE id = $1",
              [member.id, dto.action],
            );
            await advanceSharedRevision(manager, groupId, false);
          }
          return { id: participantId, revision: group.revision + 1 };
        },
      );
    });
  }

  async acceptOwnership(
    userId: string,
    groupId: string,
    requestId: string,
    dto: SharedCommandDto,
  ) {
    return withScopedDb(this.dataSource, async (manager) => {
      await lockSharedGroup(manager, groupId);
      const group = await requireSharedGroup(
        manager,
        userId,
        groupId,
        "READ",
        true,
      );
      return sharedCommand(
        manager,
        userId,
        groupId,
        dto.operationId,
        { ...dto, requestId, action: "ACCEPT_OWNER" },
        async () => {
          requireRevision(group.revision, dto.expectedRevision);
          if (
            group.ownershipTransfer?.requestId !== requestId ||
            group.ownershipTransfer.participantId !== group.myParticipantId
          )
            sharedError("ownershipConsent");
          await manager.query(
            "UPDATE shared_memberships SET ownership_accepted_request_id = $3 WHERE group_id = $1 AND user_id = $2 AND revoked_at IS NULL",
            [groupId, userId, requestId],
          );
          return { requestId };
        },
      );
    });
  }

  async mute(userId: string, groupId: string, muted: boolean) {
    return withScopedDb(this.dataSource, async (manager) => {
      await requireSharedGroup(manager, userId, groupId);
      await manager.query(
        "UPDATE shared_memberships SET notification_since = CASE WHEN muted IS DISTINCT FROM $3 THEN CURRENT_TIMESTAMP ELSE notification_since END, muted = $3 WHERE group_id = $1 AND user_id = $2 AND revoked_at IS NULL",
        [groupId, userId, muted],
      );
      return { muted };
    });
  }

  async leave(userId: string, groupId: string) {
    return withScopedDb(this.dataSource, async (manager) => {
      await lockSharedGroup(manager, groupId);
      const group = await requireSharedGroup(manager, userId, groupId);
      if (group.role === "OWNER") sharedError("owner");
      await sharedActivity(manager, userId, groupId, "MEMBER_LEFT", {
        participantId: group.myParticipantId,
      });
      await manager.query(
        "UPDATE shared_memberships SET revoked_at = CURRENT_TIMESTAMP WHERE group_id = $1 AND user_id = $2 AND revoked_at IS NULL",
        [groupId, userId],
      );
      return { id: groupId };
    });
  }
}
