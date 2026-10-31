import { createHash, randomBytes, randomUUID } from "crypto";
import { Injectable } from "@nestjs/common";
import { DataSource, EntityManager } from "typeorm";
import { withScopedDb } from "../common/db/scoped-db";
import { EncryptionService } from "../common/encryption/encryption.service";
import { SharedInvitationDto } from "./dto/shared-group.dto";
import { SharedCommandDto } from "./dto/shared-command.dto";
import {
  advanceSharedRevision,
  assertSharedPrincipal,
  lockSharedGroup,
  requireRevision,
  requireSharedGroup,
  sharedActivity,
  sharedCommand,
  sharedParticipants,
} from "./shared-db";
import { sharedError } from "./shared-errors";

interface InvitationRow {
  id: string;
  groupId: string;
  participantId: string;
  role: "EDITOR" | "VIEWER";
  groupName: string;
  participantName: string;
  email: string | null;
  consumedBy: string | null;
  consumed: boolean;
  available: boolean;
}

@Injectable()
export class SharedInvitationsService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly encryption: EncryptionService,
  ) {}

  async create(userId: string, groupId: string, dto: SharedInvitationDto) {
    return withScopedDb(this.dataSource, async (manager) => {
      await lockSharedGroup(manager, groupId);
      const group = await requireSharedGroup(manager, userId, groupId, "OWNER");
      const saved = await sharedCommand(
        manager,
        userId,
        groupId,
        dto.operationId,
        dto,
        async () => {
          requireRevision(group.revision, dto.expectedRevision);
          const participant = (await sharedParticipants(manager, groupId)).find(
            (p) => p.id === dto.participantId && p.isActive,
          );
          if (!participant) sharedError("participant");
          if (participant.connected) sharedError("alreadyMember");
          const id = randomUUID();
          const token = randomBytes(32).toString("base64url");
          // Issuing a replacement invalidates any previously copied invitation.
          await manager.query(
            "UPDATE shared_invitations SET revoked_at = CURRENT_TIMESTAMP WHERE group_id = $1 AND participant_id = $2 AND consumed_at IS NULL AND revoked_at IS NULL",
            [groupId, participant.id],
          );
          await manager.query(
            `INSERT INTO shared_invitations (id, group_id, participant_id, role, token_hash, target_email, group_name, participant_name, expires_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,CURRENT_TIMESTAMP + INTERVAL '7 days')`,
            [
              id,
              groupId,
              participant.id,
              dto.role,
              this.hash(token),
              dto.email?.trim().toLowerCase() || null,
              group.name,
              participant.name,
            ],
          );
          await advanceSharedRevision(manager, groupId, false);
          await sharedActivity(manager, userId, groupId, "INVITATION_CREATED", {
            participantId: participant.id,
            role: dto.role,
          });
          // The private replay record holds AES-GCM ciphertext, never the token.
          return {
            id,
            encryptedToken: this.encryption.encrypt(token),
            revision: group.revision + 1,
          };
        },
      );
      return {
        id: saved.id,
        token: this.encryption.decrypt(saved.encryptedToken),
        revision: saved.revision,
      };
    });
  }

  async inspect(userId: string, token: string) {
    assertSharedPrincipal(userId);
    return withScopedDb(this.dataSource, async (manager) => {
      const invite = await this.lookup(manager, userId, token);
      return {
        groupName: invite.groupName,
        participantName: invite.participantName,
        role: invite.role,
        alreadyJoined: invite.consumedBy === userId,
      };
    });
  }

  async claim(userId: string, token: string) {
    assertSharedPrincipal(userId);
    try {
      return await withScopedDb(this.dataSource, async (manager) => {
        const first = await this.lookup(manager, userId, token);
        await lockSharedGroup(manager, first.groupId);
        const invite = await this.lookup(manager, userId, token);
        if (invite.consumedBy === userId) {
          await requireSharedGroup(manager, userId, invite.groupId);
          return { id: invite.groupId };
        }
        const groups: { archived_at: string | null }[] = await manager.query(
          "SELECT archived_at FROM shared_groups WHERE id = $1",
          [invite.groupId],
        );
        if (!groups[0] || groups[0].archived_at) sharedError("invite");
        const active: { id: string }[] = await manager.query(
          "SELECT id FROM shared_memberships WHERE group_id = $1 AND (participant_id = $2 OR user_id = $3) AND revoked_at IS NULL",
          [invite.groupId, invite.participantId, userId],
        );
        if (active[0]) sharedError("alreadyMember");
        // The partial unique indexes guard both identity and participant claims.
        await manager.query(
          "INSERT INTO shared_memberships (group_id, participant_id, user_id, role) VALUES ($1,$2,$3,$4)",
          [invite.groupId, invite.participantId, userId, invite.role],
        );
        await manager.query(
          "UPDATE shared_invitations SET consumed_at = CURRENT_TIMESTAMP, consumed_by_user_id = $2 WHERE id = $1 AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at > CURRENT_TIMESTAMP",
          [invite.id, userId],
        );
        await sharedActivity(manager, userId, invite.groupId, "MEMBER_JOINED", {
          participantId: invite.participantId,
        });
        return { id: invite.groupId };
      });
    } catch (error) {
      if ((error as { code?: string }).code === "23505")
        sharedError("alreadyMember");
      throw error;
    }
  }

  async revoke(
    userId: string,
    groupId: string,
    invitationId: string,
    dto: SharedCommandDto,
  ) {
    return withScopedDb(this.dataSource, async (manager) => {
      await lockSharedGroup(manager, groupId);
      const group = await requireSharedGroup(manager, userId, groupId, "OWNER");
      return sharedCommand(
        manager,
        userId,
        groupId,
        dto.operationId,
        { ...dto, invitationId },
        async () => {
          requireRevision(group.revision, dto.expectedRevision);
          const rows: { id: string }[] = await manager.query(
            "SELECT id FROM shared_invitations WHERE id = $1 AND group_id = $2",
            [invitationId, groupId],
          );
          if (!rows[0]) sharedError("notFound");
          await manager.query(
            "UPDATE shared_invitations SET revoked_at = CURRENT_TIMESTAMP WHERE id = $1 AND group_id = $2",
            [invitationId, groupId],
          );
          await advanceSharedRevision(manager, groupId, false);
          await sharedActivity(manager, userId, groupId, "INVITATION_REVOKED");
          return { id: invitationId, revision: group.revision + 1 };
        },
      );
    });
  }

  async list(userId: string, groupId: string) {
    return withScopedDb(this.dataSource, async (manager) => {
      await requireSharedGroup(manager, userId, groupId, "OWNER", true);
      return manager.query(
        `SELECT id, participant_id AS "participantId", role, expires_at AS "expiresAt", consumed_at AS "consumedAt", revoked_at AS "revokedAt"
        FROM shared_invitations WHERE group_id = $1 ORDER BY created_at DESC LIMIT 100`,
        [groupId],
      );
    });
  }

  private hash(token: string): string {
    return createHash("sha256").update(token).digest("hex");
  }

  private async lookup(
    manager: EntityManager,
    userId: string,
    token: string,
  ): Promise<InvitationRow> {
    const hash = this.hash(token);
    await manager.query(
      "SELECT set_config('app.shared_invitation_hash', $1, true)",
      [hash],
    );
    const rows: InvitationRow[] = await manager.query(
      `SELECT id, group_id AS "groupId", participant_id AS "participantId", role,
      group_name AS "groupName", participant_name AS "participantName", target_email AS email,
      consumed_by_user_id AS "consumedBy", consumed_at IS NOT NULL AS consumed,
      revoked_at IS NULL AND expires_at > CURRENT_TIMESTAMP AS available
      FROM shared_invitations WHERE token_hash = $1`,
      [hash],
    );
    const invite = rows[0];
    if (
      !invite ||
      !invite.available ||
      (invite.consumed && invite.consumedBy !== userId)
    )
      sharedError("invite");
    const users: {
      email: string;
      email_verified: boolean;
      is_active: boolean;
    }[] = await manager.query(
      "SELECT email, email_verified, is_active FROM users WHERE id = $1",
      [userId],
    );
    const user = users[0];
    if (!user?.is_active) sharedError("invite");
    if (
      invite.email &&
      (!user.email_verified ||
        user.email.toLowerCase() !== invite.email.toLowerCase())
    )
      sharedError("inviteEmail");
    return invite;
  }
}
