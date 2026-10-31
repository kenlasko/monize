import { randomUUID } from "crypto";
import { gunzipSync } from "zlib";
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from "@nestjs/common";
import {
  withDelegateContext,
  withSystemContext,
  withUserContext,
} from "@/common/db/with-context";
import { withScopedDb } from "@/common/db/scoped-db";
import { SharedExpensesModule } from "@/shared-expenses/shared-expenses.module";
import { SharedGroupsService } from "@/shared-expenses/shared-groups.service";
import { SharedEntriesService } from "@/shared-expenses/shared-entries.service";
import { SharedInvitationsService } from "@/shared-expenses/shared-invitations.service";
import { SharedMembershipsService } from "@/shared-expenses/shared-memberships.service";
import { SharedDocumentsService } from "@/shared-expenses/shared-documents.service";
import { SharedFinanceService } from "@/shared-expenses/shared-finance.service";
import { SharedCollaborationService } from "@/shared-expenses/shared-collaboration.service";
import { SharedNotificationsService } from "@/shared-expenses/shared-notifications.service";
import { eraseSharedUser } from "@/shared-expenses/shared-erasure";
import { SharedEntryDto } from "@/shared-expenses/dto/shared-entry.dto";
import { AttachmentsService } from "@/attachments/attachments.service";
import { BackupModule } from "@/backup/backup.module";
import { BackupService } from "@/backup/backup.service";
import { ATTACHMENT_EXPORT_SQL } from "@/backup/export-attachments";
import { SupportBackupService } from "@/backup/support-backup/support-backup.service";
import {
  createTestAccount,
  createTestCategory,
} from "../helpers/test-factories";
import {
  EnforcedIntegrationHarness,
  cleanTables,
  createEnforcedIntegrationModule,
  createTestUserDirect,
} from "../helpers/integration-setup";

describe("Shared documents, delivery and detached restore under enforced RLS (SE-005/006/010)", () => {
  jest.setTimeout(180000);
  let h: EnforcedIntegrationHarness;
  let groups: SharedGroupsService,
    entries: SharedEntriesService,
    invitations: SharedInvitationsService;
  let members: SharedMembershipsService,
    documents: SharedDocumentsService,
    attachments: AttachmentsService;
  let finance: SharedFinanceService,
    collaboration: SharedCollaborationService,
    notifications: SharedNotificationsService;
  let backup: BackupService;
  let owner: string,
    guest: string,
    outsider: string,
    groupId: string,
    me: string,
    anna: string;
  const as = <T>(id: string, body: () => Promise<T>) =>
    withUserContext(id, body);
  const command = (expectedRevision = 0) => ({
    operationId: randomUUID(),
    expectedRevision,
  });
  const file = (name = "receipt.png", marker = "shared") => {
    const buffer = Buffer.concat([
      Buffer.from("89504e470d0a1a0a", "hex"),
      Buffer.from(marker),
    ]);
    return { buffer, size: buffer.length, originalname: name };
  };

  const previousEncryptionKey = process.env.ENCRYPTION_KEY;
  const previousJwtSecret = process.env.JWT_SECRET;
  beforeAll(async () => {
    process.env.JWT_SECRET =
      "shared-expenses-lifecycle-jwt-secret-for-tests-only";
    process.env.ENCRYPTION_KEY =
      "shared-expenses-integration-test-key-32-chars";
    h = await createEnforcedIntegrationModule([
      SharedExpensesModule,
      BackupModule,
    ]);
    groups = h.module.get(SharedGroupsService);
    entries = h.module.get(SharedEntriesService);
    invitations = h.module.get(SharedInvitationsService);
    members = h.module.get(SharedMembershipsService);
    documents = h.module.get(SharedDocumentsService);
    attachments = h.module.get(AttachmentsService);
    finance = h.module.get(SharedFinanceService);
    collaboration = h.module.get(SharedCollaborationService);
    notifications = h.module.get(SharedNotificationsService);
    backup = h.module.get(BackupService);
    await h.owner.query(
      "INSERT INTO currencies (code,name,symbol,decimal_places) VALUES ('PLN','Polish zloty','PLN',2) ON CONFLICT (code) DO NOTHING",
    );
  });
  afterAll(async () => {
    if (h) await h.close();
    if (previousJwtSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = previousJwtSecret;
    if (previousEncryptionKey === undefined) delete process.env.ENCRYPTION_KEY;
    else process.env.ENCRYPTION_KEY = previousEncryptionKey;
  });
  beforeEach(async () => {
    await cleanTables(h.owner, ["shared_groups", "users"]);
    owner = (await createTestUserDirect(h.owner)).id;
    guest = (await createTestUserDirect(h.owner)).id;
    outsider = (await createTestUserDirect(h.owner)).id;
    groupId = (
      await as(owner, () =>
        groups.create(owner, {
          operationId: randomUUID(),
          name: "Private trip title",
          myName: "Owner alias",
          currencyCode: "PLN",
          participants: [{ name: "Anna alias" }],
        }),
      )
    ).id;
    const group = await as(owner, () => groups.detail(owner, groupId));
    me = group.myParticipantId!;
    anna = group.participants.find((p) => p.name === "Anna alias")!.id;
    const invite = await as(owner, () =>
      invitations.create(owner, groupId, {
        ...command(group.revision),
        participantId: anna,
        role: "EDITOR",
      }),
    );
    await as(guest, () => invitations.claim(guest, invite.token));
  });
  const input = (overrides: Partial<SharedEntryDto> = {}): SharedEntryDto => ({
    ...command(),
    type: "EXPENSE",
    title: "Dinner with private note",
    note: "Private receipt note",
    amount: "300",
    currencyCode: "PLN",
    date: "2026-01-10",
    splitMode: "EQUAL",
    shares: [me, anna].map((participantId) => ({ participantId })),
    contributions: [{ participantId: me, value: "300" }],
    ...overrides,
  });
  async function revoke() {
    const group = await as(owner, () => groups.detail(owner, groupId));
    await as(owner, () =>
      members.change(owner, groupId, anna, {
        ...command(group.revision),
        action: "REVOKE",
      }),
    );
  }

  it("shares the actual bytes with members and denies outsiders, delegates and a revoked uploader", async () => {
    const uploaded = await as(guest, () =>
      documents.upload(guest, groupId, undefined, command(), file()),
    );
    expect(
      (await as(owner, () => attachments.getForDownload(owner, uploaded.id)))
        .data,
    ).toEqual(file().buffer);
    await expect(
      as(outsider, () => attachments.getForDownload(outsider, uploaded.id)),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      withDelegateContext(owner, outsider, () =>
        attachments.getForDownload(owner, uploaded.id),
      ),
    ).rejects.toThrow();
    await revoke();
    await expect(
      as(guest, () => attachments.getForDownload(guest, uploaded.id)),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(
      await as(guest, () =>
        withScopedDb(h.app, (m) =>
          m.query(
            "SELECT attachment_id FROM attachment_blobs WHERE attachment_id = $1",
            [uploaded.id],
          ),
        ),
      ),
    ).toEqual([]);
  });

  it("replays one upload without duplicating a scan or its original, and moves both within the group", async () => {
    const dto = command();
    const pair = await as(owner, () =>
      documents.upload(
        owner,
        groupId,
        undefined,
        dto,
        file(),
        file("original.png", "private-original"),
      ),
    );
    const replay = await as(owner, () =>
      documents.upload(
        owner,
        groupId,
        undefined,
        dto,
        file(),
        file("original.png", "private-original"),
      ),
    );
    expect(replay.id).toBe(pair.id);
    expect(pair.originalAttachmentId).toBeTruthy();
    const entry = await as(owner, () => entries.save(owner, groupId, input()));
    await as(owner, () =>
      documents.update(owner, groupId, pair.id, {
        expectedRevision: 1,
        filename: "Dinner.png",
        documentKind: "receipt",
        entryId: entry.id,
      }),
    );
    const rows = await h.owner.query(
      "SELECT shared_entry_id, shared_group_id, document_kind FROM transaction_attachments ORDER BY id",
    );
    expect(rows).toHaveLength(2);
    expect(
      rows.every(
        (r: Record<string, unknown>) =>
          r.shared_entry_id === entry.id &&
          r.shared_group_id === null &&
          r.document_kind === "receipt",
      ),
    ).toBe(true);
    await expect(
      as(owner, () =>
        documents.update(owner, groupId, pair.id, {
          expectedRevision: 1,
          filename: "Stale.png",
          documentKind: "other",
        }),
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(
      (await as(owner, () => groups.detail(owner, groupId))).balances
        .totalExpenses,
    ).toBe("300.0000");
  });

  it("exports only private-owned and currently accessible group documents, including after the uploader is revoked", async () => {
    const entry = await as(owner, () => entries.save(owner, groupId, input()));
    const groupFile = await as(owner, () =>
      documents.upload(owner, groupId, undefined, command(), file()),
    );
    const entryFile = await as(owner, () =>
      documents.upload(owner, groupId, entry.id, command(), file()),
    );
    const guestFile = await as(guest, () =>
      documents.upload(guest, groupId, undefined, command(), file()),
    );
    async function privateFile(userId: string) {
      const account = await createTestAccount(h.owner, userId, {
        currencyCode: "PLN",
      });
      const [transaction] = await h.owner.query(
        "INSERT INTO transactions (user_id,account_id,transaction_date,amount,currency_code) VALUES ($1,$2,'2026-01-10',-300,'PLN') RETURNING id",
        [userId, account.id],
      );
      return as(userId, () =>
        attachments.create(
          userId,
          { kind: "transaction", id: transaction.id },
          file(),
        ),
      );
    }
    const ownedPrivate = await privateFile(guest);
    await privateFile(owner);
    const checkExport = async (userId: string, expected: string[]) => {
      const ids = (rows: { id?: string; attachment_id?: string }[]) =>
        rows.map((row) => row.id ?? row.attachment_id).sort();
      // The owner connection bypasses RLS: these assertions prove the explicit
      // export predicate still confines metadata AND bytes when RLS is off.
      for (const sql of Object.values(ATTACHMENT_EXPORT_SQL)) {
        expect(ids(await h.owner.query(sql, [userId]))).toEqual(
          [...expected].sort(),
        );
      }
      const { buffer } = await as(userId, () => backup.exportToBuffer(userId));
      const archive = JSON.parse(gunzipSync(buffer).toString());
      expect(ids(archive.transaction_attachments)).toEqual(
        [...expected].sort(),
      );
      expect(ids(archive.attachment_blobs)).toEqual([...expected].sort());
    };
    await checkExport(guest, [
      groupFile.id,
      entryFile.id,
      guestFile.id,
      ownedPrivate.id,
    ]);
    await checkExport(outsider, []);
    await revoke();
    await checkExport(guest, [ownedPrivate.id]);
  });

  it("publishes independent bytes without the original unless explicitly selected", async () => {
    const account = await createTestAccount(h.owner, owner, {
      currencyCode: "PLN",
    });
    const [transaction] = await h.owner.query(
      "INSERT INTO transactions (user_id,account_id,transaction_date,amount,currency_code) VALUES ($1,$2,'2026-01-10',-300,'PLN') RETURNING id",
      [owner, account.id],
    );
    const privateFile = await as(owner, () =>
      attachments.create(
        owner,
        { kind: "transaction", id: transaction.id },
        file(),
        file("original.png", "private-original"),
      ),
    );
    const published = await as(owner, () =>
      documents.publish(owner, groupId, {
        ...command(),
        sourceAttachmentId: privateFile.id,
        includeOriginal: false,
      }),
    );
    expect(published.id).not.toBe(privateFile.id);
    expect(published.originalAttachmentId).toBeNull();
    await as(owner, () => attachments.remove(owner, privateFile.id));
    expect(
      (await as(guest, () => attachments.getForDownload(guest, published.id)))
        .data,
    ).toEqual(file().buffer);
  });

  it("keeps attachment limits under the group lock and refuses an editor editing someone else's file", async () => {
    const entry = await as(owner, () => entries.save(owner, groupId, input()));
    for (let i = 0; i < 10; i++)
      await as(owner, () =>
        documents.upload(owner, groupId, entry.id, command(), file(`${i}.png`)),
      );
    const extra = await as(owner, () =>
      documents.upload(owner, groupId, undefined, command(), file("extra.png")),
    );
    await expect(
      as(owner, () =>
        documents.update(owner, groupId, extra.id, {
          expectedRevision: 1,
          filename: "extra.png",
          documentKind: "receipt",
          entryId: entry.id,
        }),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      as(guest, () =>
        documents.update(guest, groupId, extra.id, {
          expectedRevision: 1,
          filename: "foreign.png",
          documentKind: "receipt",
        }),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(
      (await as(owner, () => documents.list(owner, groupId, 0, entry.id)))
        .items,
    ).toHaveLength(10);
  });

  it("stores future-only split defaults without rewriting earlier pennies", async () => {
    const saved = await as(owner, () =>
      entries.save(
        owner,
        groupId,
        input({
          amount: "0.01",
          contributions: [{ participantId: me, value: "0.01" }],
        }),
      ),
    );
    const group = await as(owner, () => groups.detail(owner, groupId));
    await as(owner, () =>
      groups.update(owner, groupId, {
        ...command(group.revision),
        splitTemplate: {
          mode: "WEIGHT",
          shares: [
            { participantId: me, value: "2" },
            { participantId: anna, value: "1" },
          ],
        },
      }),
    );
    const reloaded = await as(owner, () =>
      entries.get(owner, groupId, saved.id),
    );
    // Allocation order is not part of the journal contract. Compare every
    // stored value by its participant/kind identity, including zero shares.
    const byIdentity = (rows: typeof saved.allocations) =>
      Object.fromEntries(
        rows.map((row) => [`${row.participantId}:${row.kind}`, row]),
      );
    expect(reloaded.allocations).toHaveLength(saved.allocations.length);
    expect(byIdentity(reloaded.allocations)).toEqual(
      byIdentity(saved.allocations),
    );
    expect(
      (await as(owner, () => groups.detail(owner, groupId))).splitTemplate
        ?.mode,
    ).toBe("WEIGHT");
    await expect(
      as(guest, () =>
        groups.update(guest, groupId, { ...command(), splitTemplate: null }),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("notifies affected members once, respects mute and previews reminder recipients without private banking data", async () => {
    await as(owner, () => entries.save(owner, groupId, input()));
    await as(owner, () => notifications.deliver(groupId));
    await as(owner, () => notifications.deliver(groupId));
    const rows = await h.owner.query(
      "SELECT title,message,data FROM notifications WHERE user_id = $1 AND alert_type = 'SHARED_EXPENSE_UPDATED'",
      [guest],
    );
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain("Private receipt note");
    await as(guest, () => members.mute(guest, groupId, true));
    await as(owner, () => entries.save(owner, groupId, input()));
    await as(owner, () => notifications.deliver(groupId));
    expect(
      await h.owner.query(
        "SELECT count(*)::int AS n FROM notifications WHERE user_id = $1",
        [guest],
      ),
    ).toEqual([{ n: 1 }]);
    await as(guest, () => members.mute(guest, groupId, false));
    const group = await as(owner, () => groups.detail(owner, groupId));
    const dto = command(group.financialRevision);
    await as(owner, () => collaboration.remind(owner, groupId, anna, dto));
    await as(owner, () => collaboration.remind(owner, groupId, anna, dto));
    await expect(
      as(owner, () =>
        collaboration.remind(
          owner,
          groupId,
          anna,
          command(group.financialRevision),
        ),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    await as(owner, () => notifications.deliver(groupId));
    expect(
      await h.owner.query(
        "SELECT count(*)::int AS n FROM notifications WHERE user_id = $1",
        [guest],
      ),
    ).toEqual([{ n: 2 }]);
  });

  it("records access removal as its own event and delivers only that event to the revoked participant", async () => {
    await as(owner, () => entries.save(owner, groupId, input()));
    await revoke();
    const events = await h.owner.query(
      "SELECT id, action, detail FROM shared_activity WHERE group_id=$1 AND action='MEMBER_REVOKED'",
      [groupId],
    );
    expect(events).toHaveLength(1);
    expect(events[0].detail.participantId).toBe(anna);
    await expect(
      as(guest, () => groups.detail(guest, groupId)),
    ).rejects.toBeInstanceOf(NotFoundException);
    // A revoked participant can recover this generic notice from their own backlog,
    // but earlier expense events must no longer expose a link to the live group.
    await as(guest, () => notifications.deliver());
    await as(owner, () => notifications.deliver(groupId));
    const notices = await h.owner.query(
      "SELECT dedupe_key,target,data FROM notifications WHERE user_id=$1 AND alert_type='SHARED_EXPENSE_UPDATED'",
      [guest],
    );
    expect(notices).toEqual([
      {
        dedupe_key: `shared:${events[0].id}`,
        target: "/shared-expenses",
        data: { groupId, accessChanged: true },
      },
    ]);
  });

  async function bookGuest(entryId: string) {
    const group = await as(guest, () => groups.detail(guest, groupId));
    const category = await createTestCategory(h.owner, guest);
    const integration = await as(guest, () =>
      finance.enable(guest, groupId, {
        ...command(group.revision),
        accountName: "My private bridge",
      }),
    );
    const dto = { ...command(1), categoryId: category.id };
    const preview = await as(guest, () =>
      finance.preview(guest, groupId, entryId, dto),
    );
    await as(guest, () =>
      finance.book(guest, groupId, entryId, {
        ...dto,
        previewFingerprint: preview.fingerprint,
      }),
    );
    return integration;
  }

  it("restores a detached snapshot beside an unchanged live group with remapped private postings and shared bytes", async () => {
    const saved = await as(owner, () => entries.save(owner, groupId, input()));
    const image = await as(owner, () =>
      documents.upload(owner, groupId, saved.id, command(), file()),
    );
    await bookGuest(saved.id);
    const { buffer, report } = await as(guest, () =>
      backup.exportToBuffer(guest),
    );
    expect(report.complete).toBe(true);
    const archive = JSON.parse(gunzipSync(buffer).toString());
    expect(archive.shared_memberships).toBeUndefined();
    expect(archive.shared_invitations).toBeUndefined();
    expect(archive.shared_groups).toHaveLength(1);
    expect(archive.shared_postings).toHaveLength(1);
    const later = await as(owner, () =>
      entries.save(
        owner,
        groupId,
        {
          ...input({
            amount: "600",
            contributions: [{ participantId: me, value: "600" }],
          }),
          expectedRevision: 1,
        },
        saved.id,
      ),
    );
    await as(guest, () =>
      backup.restoreData(guest, {
        compressedData: buffer,
        password: "TestPassword123!",
      }),
    );
    const all = await as(guest, () => groups.list(guest));
    expect(all).toHaveLength(2);
    const copy = all.find((g) => g.isDetachedCopy)!;
    const copied = await as(guest, () =>
      groups.detail(guest, copy.id as string),
    );
    expect(copied.id).not.toBe(groupId);
    expect(copied.participants.map((p) => p.id)).not.toContain(anna);
    expect(copied.balances.totalExpenses).toBe("300.0000");
    expect(copied.participants.filter((p) => p.connected)).toHaveLength(1);
    expect(
      (await as(owner, () => entries.get(owner, groupId, saved.id))).revision,
    ).toBe(later.revision);
    const own = await as(guest, () => finance.overview(guest, copied.id));
    expect(own.entries.filter((e) => e.needsReview)).toHaveLength(0);
    const copiedFiles = await as(guest, () => documents.list(guest, copied.id));
    expect(copiedFiles.items[0].id).not.toBe(image.id);
    expect(
      (
        await as(guest, () =>
          attachments.getForDownload(guest, copiedFiles.items[0].id),
        )
      ).data,
    ).toEqual(file().buffer);
    expect(
      (await as(owner, () => attachments.getForDownload(owner, image.id))).data,
    ).toEqual(file().buffer);
  });

  it("keeps one's accepted ledger readable and unlinkable after revocation", async () => {
    const saved = await as(owner, () => entries.save(owner, groupId, input()));
    const integration = await bookGuest(saved.id);
    await revoke();
    const own = await as(guest, () => finance.overview(guest, groupId));
    expect(own.accessRevoked).toBe(true);
    await as(guest, () => finance.unlink(guest, groupId, saved.id, command(1)));
    expect(
      await h.owner.query(
        "SELECT current_balance FROM accounts WHERE id = $1",
        [integration.accountId],
      ),
    ).toEqual([{ current_balance: "0.0000" }]);
    expect(
      (await as(owner, () => groups.detail(owner, groupId))).balances
        .totalExpenses,
    ).toBe("300.0000");
  });

  it("requires transfer before owner erasure and preserves a departing member's shared uploads", async () => {
    await expect(
      withSystemContext(() =>
        withScopedDb(h.app, (m) => eraseSharedUser(m, owner)),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    const uploaded = await as(guest, () =>
      documents.upload(guest, groupId, undefined, command(), file()),
    );
    await withSystemContext(() =>
      withScopedDb(h.app, async (m) => {
        await eraseSharedUser(m, guest);
        await m.query("DELETE FROM users WHERE id = $1", [guest]);
      }),
    );
    expect(
      (await as(owner, () => attachments.getForDownload(owner, uploaded.id)))
        .data,
    ).toEqual(file().buffer);
    expect(
      (await as(owner, () => groups.detail(owner, groupId))).participants.find(
        (p) => p.id === anna,
      )?.connected,
    ).toBe(false);
    const surviving = await as(owner, () => documents.list(owner, groupId));
    expect(
      surviving.items.find((item) => item.id === uploaded.id)?.uploaderName,
    ).toBe("Anna alias");
  });

  it("produces a support snapshot without private text that can be restored", async () => {
    await as(owner, () => entries.save(owner, groupId, input()));
    const support = h.module.get(SupportBackupService);
    const { buffer } = await as(guest, () =>
      support.generate(guest, {
        multiplier: 1.73,
        password: "SharedSupport123!",
      }),
    );
    await as(outsider, () =>
      backup.restoreData(outsider, {
        compressedData: buffer,
        password: "TestPassword123!",
        backupPassword: "SharedSupport123!",
      }),
    );
    const copies = await as(outsider, () => groups.list(outsider));
    expect(copies).toHaveLength(1);
    const copy = await as(outsider, () =>
      groups.detail(outsider, copies[0].id as string),
    );
    expect(JSON.stringify(copy)).not.toContain("Private receipt note");
    expect(copy.isDetachedCopy).toBe(true);
    expect(copy.balances.settlementReady).toBe(true);
  });
});
