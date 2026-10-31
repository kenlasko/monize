import { randomUUID } from "crypto";
import { Injectable } from "@nestjs/common";
import { DataSource } from "typeorm";
import { withScopedDb } from "../common/db/scoped-db";
import { LinkSharedPersonDto, SharedPersonDto } from "./dto/shared-group.dto";
import {
  assertSharedPrincipal,
  requireSharedGroup,
  sharedParticipants,
} from "./shared-db";
import { sharedError } from "./shared-errors";
import { journalBalances, readSharedJournal } from "./shared-journal";

@Injectable()
export class SharedPeopleService {
  constructor(private readonly dataSource: DataSource) {}

  async list(userId: string) {
    assertSharedPrincipal(userId);
    return withScopedDb(
      this.dataSource,
      async (manager) => {
        const people: { id: string; name: string; payeeId: string | null }[] =
          await manager.query(
            'SELECT id, name, payee_id AS "payeeId" FROM shared_people WHERE user_id = $1 ORDER BY lower(name), id',
            [userId],
          );
        const links: {
          personId: string;
          groupId: string;
          participantId: string;
          groupName: string;
          currencyCode: string;
        }[] = await manager.query(
          `SELECT l.person_id AS "personId", l.group_id AS "groupId", l.participant_id AS "participantId", g.name AS "groupName", g.currency_code AS "currencyCode"
        FROM shared_person_links l JOIN shared_groups g ON g.id = l.group_id
        WHERE l.user_id = $1 AND (g.owner_user_id = $1 OR EXISTS (SELECT 1 FROM shared_memberships m WHERE m.group_id = g.id AND m.user_id = $1 AND m.revoked_at IS NULL))`,
          [userId],
        );
        const balances = new Map<string, ReturnType<typeof journalBalances>>();
        for (const groupId of new Set(links.map((link) => link.groupId))) {
          const participants = await sharedParticipants(manager, groupId);
          balances.set(
            groupId,
            journalBalances(
              participants.map((p) => p.id),
              await readSharedJournal(manager, groupId),
            ),
          );
        }
        return people.map((person) => ({
          ...person,
          groups: links
            .filter((l) => l.personId === person.id)
            .map((l) => ({
              ...l,
              position: balances
                .get(l.groupId)!
                .positions.find((p) => p.participantId === l.participantId),
            })),
        }));
      },
      "REPEATABLE READ",
    );
  }

  async save(userId: string, dto: SharedPersonDto, personId?: string) {
    assertSharedPrincipal(userId);
    return withScopedDb(this.dataSource, async (manager) => {
      if (!dto.name.trim()) sharedError("participant");
      if (dto.payeeId) {
        const payees: { id: string }[] = await manager.query(
          "SELECT id FROM payees WHERE id = $1 AND user_id = $2",
          [dto.payeeId, userId],
        );
        if (!payees[0]) sharedError("payee");
      }
      if (personId) {
        const existing: { id: string }[] = await manager.query(
          "SELECT id FROM shared_people WHERE id = $1 AND user_id = $2 FOR UPDATE",
          [personId, userId],
        );
        if (!existing[0]) sharedError("notFound");
        await manager.query(
          "UPDATE shared_people SET name = $3, payee_id = $4 WHERE id = $1 AND user_id = $2",
          [personId, userId, dto.name.trim(), dto.payeeId ?? null],
        );
      } else {
        personId = randomUUID();
        await manager.query(
          "INSERT INTO shared_people (id, user_id, name, payee_id) VALUES ($1,$2,$3,$4)",
          [personId, userId, dto.name.trim(), dto.payeeId ?? null],
        );
      }
      return { id: personId };
    });
  }

  async link(userId: string, groupId: string, dto: LinkSharedPersonDto) {
    return withScopedDb(this.dataSource, async (manager) => {
      await requireSharedGroup(manager, userId, groupId);
      const people: { id: string }[] = await manager.query(
        "SELECT id FROM shared_people WHERE id = $1 AND user_id = $2 FOR UPDATE",
        [dto.personId, userId],
      );
      if (
        !people[0] ||
        !(await sharedParticipants(manager, groupId)).some(
          (p) => p.id === dto.participantId,
        )
      )
        sharedError("participant");
      const linked: { participant_id: string }[] = await manager.query(
        "SELECT participant_id FROM shared_person_links WHERE person_id = $1 AND group_id = $2 AND user_id = $3",
        [dto.personId, groupId, userId],
      );
      if (linked[0] && linked[0].participant_id !== dto.participantId)
        sharedError("alreadyMember");
      await manager.query(
        `INSERT INTO shared_person_links (user_id, person_id, group_id, participant_id) VALUES ($1,$2,$3,$4)
        ON CONFLICT (user_id, participant_id) DO UPDATE SET person_id = EXCLUDED.person_id`,
        [userId, dto.personId, groupId, dto.participantId],
      );
      return { id: dto.personId };
    });
  }

  async remove(userId: string, personId: string) {
    assertSharedPrincipal(userId);
    return withScopedDb(this.dataSource, async (manager) => {
      await manager.query(
        "DELETE FROM shared_people WHERE id = $1 AND user_id = $2",
        [personId, userId],
      );
      return { id: personId };
    });
  }
}
