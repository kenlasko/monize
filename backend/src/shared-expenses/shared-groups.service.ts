import { SharedGroup } from "./shared-types";
import { SharedPosition } from "./shared-balances";
import { summarizeSharedPositions } from "./shared-summary";
import { randomUUID } from "crypto";
import { allocateShares } from "./shared-allocation";
import { Injectable } from "@nestjs/common";
import { DataSource } from "typeorm";
import { withScopedDb } from "../common/db/scoped-db";
import {
  CreateSharedGroupDto,
  UpdateSharedGroupDto,
  ChangeSharedParticipantDto,
} from "./dto/shared-group.dto";
import {
  advanceSharedRevision,
  assertSharedPrincipal,
  currencyPlaces,
  lockSharedGroup,
  requireRevision,
  requireSharedGroup,
  sharedActivity,
  sharedCommand,
  sharedParticipants,
} from "./shared-db";
import { SharedCommandDto } from "./dto/shared-command.dto";
import { SharedListDto } from "./dto/shared-entry.dto";
import { sharedError } from "./shared-errors";
import {
  journalBalances,
  publicSharedEntry,
  readSharedJournal,
} from "./shared-journal";

@Injectable()
export class SharedGroupsService {
  constructor(private readonly dataSource: DataSource) {}

  async list(userId: string) {
    assertSharedPrincipal(userId);
    return withScopedDb(
      this.dataSource,
      async (manager) => {
        const ids: { id: string }[] = await manager.query(
          `SELECT g.id FROM shared_groups g WHERE g.owner_user_id = $1
        OR EXISTS (SELECT 1 FROM shared_memberships m WHERE m.group_id = g.id AND m.user_id = $1 AND m.revoked_at IS NULL)
        ORDER BY g.updated_at DESC, g.id`,
          [userId],
        );
        const result: (Omit<SharedGroup, "ownerUserId"> & {
          myPosition: SharedPosition | null;
          participantCount: number;
          settlementReady: boolean;
        })[] = [];
        for (const { id } of ids) {
          const { ownerUserId: _owner, ...group } = await requireSharedGroup(
            manager,
            userId,
            id,
          );
          const participants = await sharedParticipants(manager, id);
          const balances = journalBalances(
            participants.map((p) => p.id),
            await readSharedJournal(manager, id),
          );
          result.push({
            ...group,
            participantCount: participants.length,
            myPosition:
              balances.positions.find(
                (p) => p.participantId === group.myParticipantId,
              ) ?? null,
            settlementReady: balances.settlementReady,
          });
        }
        return result;
      },
      "REPEATABLE READ",
    );
  }

  async overview(userId: string) {
    const groups = await this.list(userId);
    return { groups, totals: summarizeSharedPositions(groups) };
  }

  async detail(
    userId: string,
    groupId: string,
    offset = 0,
    filters: SharedListDto = {},
  ) {
    return withScopedDb(
      this.dataSource,
      async (manager) => {
        const { ownerUserId: _owner, ...group } = await requireSharedGroup(
          manager,
          userId,
          groupId,
        );
        const participants = await sharedParticipants(manager, groupId);
        const entries = await readSharedJournal(manager, groupId);
        const balances = journalBalances(
          participants.map((p) => p.id),
          entries,
        );
        const activity: {
          id: string;
          actorName: string;
          action: string;
          entryId: string | null;
          detail: Record<string, unknown>;
          createdAt: string;
        }[] = await manager.query(
          `SELECT id, actor_name AS "actorName", action, entry_id AS "entryId", detail, created_at AS "createdAt"
        FROM shared_activity WHERE group_id = $1 ORDER BY created_at DESC, id DESC LIMIT 100`,
          [groupId],
        );
        const filtered = entries.filter(
          (entry) =>
            (!filters.search ||
              [entry.title, entry.note, entry.categoryLabel].some((s) =>
                s?.toLowerCase().includes(filters.search!.toLowerCase()),
              )) &&
            (!filters.type || entry.type === filters.type) &&
            (!filters.startDate || entry.date >= filters.startDate) &&
            (!filters.endDate || entry.date <= filters.endDate) &&
            (!filters.participantId ||
              entry.allocations.some(
                (a) => a.participantId === filters.participantId,
              ) ||
              entry.fromParticipantId === filters.participantId ||
              entry.toParticipantId === filters.participantId),
        );
        return {
          ...group,
          participants,
          balances,
          unresolvedEntries: entries
            .filter((entry) => entry.draftReason === "MISSING_RATE")
            .map((entry) => ({
              id: entry.id,
              title: entry.title,
              date: entry.date,
              currencyCode: entry.currencyCode,
            })),
          entries: filtered
            .slice(offset, offset + 100)
            .map((entry) =>
              publicSharedEntry(
                entry,
                userId,
                group.role === "OWNER",
                group.myParticipantId,
              ),
            ),
          entryCount: filtered.length,
          nextOffset: offset + 100 < filtered.length ? offset + 100 : null,
          activity,
        };
      },
      "REPEATABLE READ",
    );
  }

  async export(userId: string, groupId: string) {
    return withScopedDb(
      this.dataSource,
      async (manager) => {
        const { ownerUserId: _owner, ...group } = await requireSharedGroup(
          manager,
          userId,
          groupId,
        );
        const participants = await sharedParticipants(manager, groupId);
        const entries = await readSharedJournal(manager, groupId);
        return {
          group,
          participants,
          entries: entries.map((entry) =>
            publicSharedEntry(
              entry,
              userId,
              group.role === "OWNER",
              group.myParticipantId,
            ),
          ),
          balances: journalBalances(
            participants.map((p) => p.id),
            entries,
          ),
        };
      },
      "REPEATABLE READ",
    );
  }

  async create(userId: string, dto: CreateSharedGroupDto) {
    assertSharedPrincipal(userId);
    return withScopedDb(this.dataSource, async (manager) => {
      const groupId = dto.operationId;
      await lockSharedGroup(manager, groupId);
      const existing: { id: string }[] = await manager.query(
        "SELECT id FROM shared_groups WHERE id = $1 AND owner_user_id = $2",
        [groupId, userId],
      );
      await currencyPlaces(manager, dto.currencyCode);
      if (
        !dto.name.trim() ||
        !dto.myName.trim() ||
        dto.participants.some((p) => !p.name.trim())
      )
        sharedError("participant");
      if (!existing[0]) {
        await this.requirePeople(
          manager,
          userId,
          dto.participants.flatMap((person) =>
            person.personId ? [person.personId] : [],
          ),
        );
        await manager.query(
          `INSERT INTO shared_groups (id, owner_user_id, name, description, currency_code) VALUES ($1, $2, $3, $4, $5)`,
          [
            groupId,
            userId,
            dto.name.trim(),
            dto.description ?? null,
            dto.currencyCode,
          ],
        );
      }
      return sharedCommand(
        manager,
        userId,
        groupId,
        dto.operationId,
        dto,
        async () => {
          const me = randomUUID();
          await manager.query(
            "INSERT INTO shared_participants (id, group_id, name) VALUES ($1, $2, $3)",
            [me, groupId, dto.myName.trim()],
          );
          await manager.query(
            "INSERT INTO shared_memberships (group_id, participant_id, user_id, role) VALUES ($1, $2, $3, 'OWNER')",
            [groupId, me, userId],
          );
          for (const person of dto.participants) {
            const id = randomUUID();
            await manager.query(
              "INSERT INTO shared_participants (id, group_id, name) VALUES ($1, $2, $3)",
              [id, groupId, person.name.trim()],
            );
            if (person.personId)
              await this.linkPerson(
                manager,
                userId,
                groupId,
                id,
                person.personId,
              );
          }
          await sharedActivity(manager, userId, groupId, "GROUP_CREATED");
          return { id: groupId };
        },
      );
    });
  }

  async removeEmpty(userId: string, groupId: string, dto: SharedCommandDto) {
    return withScopedDb(this.dataSource, async (manager) => {
      await lockSharedGroup(manager, groupId);
      const group = await requireSharedGroup(
        manager,
        userId,
        groupId,
        "OWNER",
        true,
      );
      requireRevision(group.revision, dto.expectedRevision);
      const occupied: { present: boolean }[] = await manager.query(
        `SELECT EXISTS (SELECT 1 FROM shared_entries WHERE group_id = $1)
          OR EXISTS (SELECT 1 FROM shared_integrations WHERE group_id = $1)
          OR EXISTS (SELECT 1 FROM transaction_attachments WHERE shared_group_id = $1) AS present`,
        [groupId],
      );
      if (occupied[0].present) sharedError("groupNotEmpty");
      await manager.query(
        "DELETE FROM shared_groups WHERE id = $1 AND owner_user_id = $2",
        [groupId, userId],
      );
      return { id: groupId };
    });
  }

  async update(userId: string, groupId: string, dto: UpdateSharedGroupDto) {
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
        dto,
        async () => {
          requireRevision(group.revision, dto.expectedRevision);
          if (dto.name !== undefined && !dto.name.trim())
            sharedError("participant");
          if (dto.splitTemplate) {
            const active = (await sharedParticipants(manager, groupId)).filter(
              (p) => p.isActive,
            );
            if (
              dto.splitTemplate.shares.some(
                (s) => !active.some((p) => p.id === s.participantId),
              )
            )
              sharedError("participant");
            allocateShares(
              "100",
              2,
              dto.splitTemplate.mode,
              dto.splitTemplate.shares,
              "template",
            );
          }
          if (dto.currencyCode && dto.currencyCode !== group.currencyCode) {
            await currencyPlaces(manager, dto.currencyCode);
            const rows: { id: string }[] = await manager.query(
              "SELECT id FROM shared_entries WHERE group_id = $1 UNION ALL SELECT id FROM shared_integrations WHERE group_id = $1 LIMIT 1",
              [groupId],
            );
            if (rows[0]) sharedError("currencyLocked");
          }
          await manager.query(
            `UPDATE shared_groups SET name = $2, description = $3, currency_code = $4,
          archived_at = CASE WHEN $5::boolean IS NULL THEN archived_at WHEN $5 THEN CURRENT_TIMESTAMP ELSE NULL END,
          split_template = $6, revision = revision + 1 WHERE id = $1`,
            [
              groupId,
              dto.name?.trim() ?? group.name,
              dto.description ?? group.description,
              dto.currencyCode ?? group.currencyCode,
              dto.archived ?? null,
              JSON.stringify(
                dto.splitTemplate === undefined
                  ? (group.splitTemplate ?? null)
                  : dto.splitTemplate,
              ),
            ],
          );
          await sharedActivity(
            manager,
            userId,
            groupId,
            dto.archived === true
              ? "GROUP_ARCHIVED"
              : dto.archived === false
                ? "GROUP_RESTORED"
                : "GROUP_UPDATED",
          );
          return { id: groupId, revision: group.revision + 1 };
        },
      );
    });
  }

  async participant(
    userId: string,
    groupId: string,
    participantId: string | undefined,
    dto: ChangeSharedParticipantDto,
  ) {
    return withScopedDb(this.dataSource, async (manager) => {
      await lockSharedGroup(manager, groupId);
      const group = await requireSharedGroup(manager, userId, groupId, "OWNER");
      return sharedCommand(
        manager,
        userId,
        groupId,
        dto.operationId,
        { ...dto, participantId },
        async () => {
          requireRevision(group.revision, dto.expectedRevision);
          const participants = await sharedParticipants(manager, groupId);
          if (
            !dto.name.trim() ||
            (participantId && !participants.some((p) => p.id === participantId))
          )
            sharedError("participant");
          if (!participantId && participants.length >= 50)
            sharedError("participantLimit");
          if (
            dto.isActive === false &&
            participants.some((p) => p.id === participantId && p.connected)
          )
            sharedError("alreadyMember");
          if (dto.personId)
            await this.requirePeople(manager, userId, [dto.personId]);
          const id = participantId ?? randomUUID();
          if (participantId)
            await manager.query(
              "UPDATE shared_participants SET name = $3, is_active = COALESCE($4, is_active) WHERE id = $1 AND group_id = $2",
              [id, groupId, dto.name.trim(), dto.isActive ?? null],
            );
          else
            await manager.query(
              "INSERT INTO shared_participants (id, group_id, name) VALUES ($1, $2, $3)",
              [id, groupId, dto.name.trim()],
            );
          if (dto.personId)
            await this.linkPerson(manager, userId, groupId, id, dto.personId);
          await advanceSharedRevision(manager, groupId, false);
          await sharedActivity(
            manager,
            userId,
            groupId,
            participantId ? "PARTICIPANT_UPDATED" : "PARTICIPANT_ADDED",
            { participantId: id, name: dto.name.trim() },
          );
          return { id, revision: group.revision + 1 };
        },
      );
    });
  }

  private async requirePeople(
    manager: import("typeorm").EntityManager,
    userId: string,
    personIds: string[],
  ) {
    const ids = [...new Set(personIds)].sort();
    if (!ids.length) return;
    const people: { id: string }[] = await manager.query(
      "SELECT id FROM shared_people WHERE id = ANY($1::uuid[]) AND user_id = $2 ORDER BY id FOR KEY SHARE",
      [ids, userId],
    );
    if (people.length !== ids.length) sharedError("participant");
  }

  private async linkPerson(
    manager: import("typeorm").EntityManager,
    userId: string,
    groupId: string,
    participantId: string,
    personId: string,
  ) {
    await manager.query(
      `INSERT INTO shared_person_links (user_id, person_id, group_id, participant_id) VALUES ($1, $2, $3, $4)
      ON CONFLICT (user_id, participant_id) DO UPDATE SET person_id = EXCLUDED.person_id`,
      [userId, personId, groupId, participantId],
    );
  }
}
