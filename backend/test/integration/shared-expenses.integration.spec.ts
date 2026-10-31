import { ExchangeRateService } from "@/currencies/exchange-rate.service";
import { AccountsService } from "@/accounts/accounts.service";
import { SharedEntryFinanceService } from "@/shared-expenses/shared-entry-finance.service";
import { raceTwo } from "../helpers/race";
import { randomUUID } from "crypto";
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from "@nestjs/common";
import { withUserContext } from "@/common/db/with-context";
import { withScopedDb } from "@/common/db/scoped-db";
import { SharedExpensesModule } from "@/shared-expenses/shared-expenses.module";
import { SharedGroupsService } from "@/shared-expenses/shared-groups.service";
import { SharedEntriesService } from "@/shared-expenses/shared-entries.service";
import { SharedInvitationsService } from "@/shared-expenses/shared-invitations.service";
import { SharedMembershipsService } from "@/shared-expenses/shared-memberships.service";
import { SharedEntryDto } from "@/shared-expenses/dto/shared-entry.dto";
import { SharedFinanceService } from "@/shared-expenses/shared-finance.service";
import { BookSharedEntryDto } from "@/shared-expenses/dto/shared-finance.dto";
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

describe("Shared expense journal under enforced RLS (SE-001/002/005/008/012)", () => {
  jest.setTimeout(120000);
  let harness: EnforcedIntegrationHarness;
  let groups: SharedGroupsService;
  let entries: SharedEntriesService;
  let invitations: SharedInvitationsService;
  let memberships: SharedMembershipsService;
  let finance: SharedFinanceService;
  let owner: string;
  let guest: string;
  let stranger: string;
  let groupId: string;
  let me: string;
  let anna: string;
  let ben: string;
  const as = <T>(id: string, fn: () => Promise<T>) => withUserContext(id, fn);

  const previousEncryptionKey = process.env.ENCRYPTION_KEY;
  beforeAll(async () => {
    process.env.ENCRYPTION_KEY =
      "shared-expenses-integration-test-key-32-chars";
    harness = await createEnforcedIntegrationModule([SharedExpensesModule]);
    jest
      .spyOn(harness.module.get(ExchangeRateService), "getRateForDate")
      .mockResolvedValue(null);
    groups = harness.module.get(SharedGroupsService);
    entries = harness.module.get(SharedEntriesService);
    invitations = harness.module.get(SharedInvitationsService);
    memberships = harness.module.get(SharedMembershipsService);
    finance = harness.module.get(SharedFinanceService);
    await harness.owner.query(
      "INSERT INTO currencies (code, name, symbol, decimal_places) VALUES ('PLN', 'Polish zloty', 'PLN', 2), ('EUR', 'Euro', 'EUR', 2) ON CONFLICT (code) DO NOTHING",
    );
  });
  afterAll(async () => {
    if (harness) await harness.close();
    if (previousEncryptionKey === undefined) delete process.env.ENCRYPTION_KEY;
    else process.env.ENCRYPTION_KEY = previousEncryptionKey;
  });
  beforeEach(async () => {
    await cleanTables(harness.owner, ["shared_groups", "users"]);
    owner = (await createTestUserDirect(harness.owner)).id;
    guest = (await createTestUserDirect(harness.owner)).id;
    stranger = (await createTestUserDirect(harness.owner)).id;
    groupId = (
      await as(owner, () =>
        groups.create(owner, {
          operationId: randomUUID(),
          name: "Weekend",
          myName: "Me",
          currencyCode: "PLN",
          participants: [{ name: "Anna" }, { name: "Ben" }],
        }),
      )
    ).id;
    const detail = await as(owner, () => groups.detail(owner, groupId));
    me = detail.myParticipantId!;
    anna = detail.participants.find((p) => p.name === "Anna")!.id;
    ben = detail.participants.find((p) => p.name === "Ben")!.id;
  });
  const expense = (
    overrides: Partial<SharedEntryDto> = {},
  ): SharedEntryDto => ({
    operationId: randomUUID(),
    expectedRevision: 0,
    type: "EXPENSE",
    title: "Dinner",
    amount: "300",
    currencyCode: "PLN",
    date: "2026-01-10",
    splitMode: "EQUAL",
    shares: [me, anna, ben].map((participantId) => ({ participantId })),
    contributions: [{ participantId: me, value: "300" }],
    ...overrides,
  });
  async function join(role: "EDITOR" | "VIEWER" = "EDITOR") {
    const group = await as(owner, () => groups.detail(owner, groupId));
    const invite = await as(owner, () =>
      invitations.create(owner, groupId, {
        operationId: randomUUID(),
        expectedRevision: group.revision,
        participantId: anna,
        role,
      }),
    );
    await as(guest, () => invitations.claim(guest, invite.token));
    return invite;
  }

  it("balances a receipt, replays a lost response and refuses a changed replay without writing", async () => {
    const dto = expense();
    const preview = await as(owner, () => entries.preview(owner, groupId, dto));
    const saved = await as(owner, () => entries.save(owner, groupId, dto));
    expect(saved.allocations).toEqual(preview.allocations);
    expect(await as(owner, () => entries.save(owner, groupId, dto))).toEqual(
      saved,
    );
    await expect(
      as(owner, () =>
        entries.save(owner, groupId, { ...dto, title: "Changed" }),
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    const detail = await as(owner, () => groups.detail(owner, groupId));
    expect(detail.entryCount).toBe(1);
    expect(detail.balances.positions.map((p) => p.balance).sort()).toEqual([
      "-100.0000",
      "-100.0000",
      "200.0000",
    ]);
    expect(
      await harness.owner.query(
        "SELECT count(*)::int AS n FROM shared_commands WHERE group_id = $1",
        [groupId],
      ),
    ).toEqual([{ n: 2 }]);
  });

  it("serializes two concurrent creates with the same command ID", async () => {
    const dto = expense();
    const [a, b] = await Promise.all([
      as(owner, () => entries.save(owner, groupId, dto)),
      as(owner, () => entries.save(owner, groupId, dto)),
    ]);
    expect(a).toEqual(b);
    expect(
      (await as(owner, () => groups.detail(owner, groupId))).entryCount,
    ).toBe(1);
  });

  it("joins an existing participant without replacing prior allocations or exposing user IDs", async () => {
    await as(owner, () => entries.save(owner, groupId, expense()));
    const invite = await join();
    expect(
      await as(guest, () => invitations.claim(guest, invite.token)),
    ).toEqual({ id: groupId });
    const detail = await as(guest, () => groups.detail(guest, groupId));
    expect(detail.myParticipantId).toBe(anna);
    expect(detail.participants[0].id).toBe(anna);
    expect(
      detail.balances.positions.find((p) => p.participantId === anna)?.balance,
    ).toBe("-100.0000");
    expect(JSON.stringify(detail)).not.toContain(owner);
    expect(JSON.stringify(detail)).not.toContain(guest);
    await expect(
      as(stranger, () => invitations.claim(stranger, invite.token)),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      as(stranger, () => groups.detail(stranger, groupId)),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("allows only one claimant after two connections wait on the same invitation's group lock", async () => {
    await as(owner, () => entries.save(owner, groupId, expense()));
    const group = await as(owner, () => groups.detail(owner, groupId));
    const invite = await as(owner, () =>
      invitations.create(owner, groupId, {
        operationId: randomUUID(),
        expectedRevision: group.revision,
        participantId: anna,
        role: "EDITOR",
      }),
    );
    const before = await harness.owner.query(
      "SELECT * FROM shared_allocations WHERE group_id=$1 ORDER BY id",
      [groupId],
    );
    const result = await raceTwo(
      harness.owner,
      () => as(guest, () => invitations.claim(guest, invite.token)),
      () => as(stranger, () => invitations.claim(stranger, invite.token)),
      {
        gate: {
          sql: "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
          params: [`shared-group:${groupId}`],
        },
      },
    );
    expect(result.fulfilled).toBe(1);
    expect(result.reasons).toEqual([expect.any(BadRequestException)]);
    expect(
      await harness.owner.query(
        "SELECT user_id FROM shared_memberships WHERE group_id=$1 AND participant_id=$2 AND revoked_at IS NULL",
        [groupId, anna],
      ),
    ).toEqual([
      { user_id: result.a.status === "fulfilled" ? guest : stranger },
    ]);
    expect(
      await harness.owner.query(
        "SELECT * FROM shared_allocations WHERE group_id=$1 ORDER BY id",
        [groupId],
      ),
    ).toEqual(before);
  });

  it("keeps viewer writes and direct SQL deletes outside their read grant", async () => {
    await join("VIEWER");
    await expect(
      as(guest, () => entries.save(guest, groupId, expense())),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await as(guest, () =>
      withScopedDb(harness.app, async (m) => {
        await m.query("DELETE FROM shared_participants WHERE id = $1", [ben]);
      }),
    );
    expect(
      (await as(owner, () => groups.detail(owner, groupId))).participants,
    ).toHaveLength(3);
    await expect(
      as(guest, () =>
        withScopedDb(harness.app, async (m) => {
          await m.query(
            "UPDATE shared_memberships SET role = 'OWNER' WHERE user_id = $1",
            [guest],
          );
        }),
      ),
    ).rejects.toThrow();
    await as(guest, () => memberships.mute(guest, groupId, true));
  });

  it("allows an editor's new entry but refuses editing someone else's entry", async () => {
    const original = await as(owner, () =>
      entries.save(owner, groupId, expense()),
    );
    await join();
    await as(guest, () => entries.save(guest, groupId, expense()));
    await expect(
      as(guest, () =>
        entries.save(
          guest,
          groupId,
          expense({ expectedRevision: 1 }),
          original.id,
        ),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(
      (await as(owner, () => groups.detail(owner, groupId))).entryCount,
    ).toBe(2);
  });

  it("refuses a stale edit before changing the entry, allocations or activity", async () => {
    const dto = expense();
    const saved = await as(owner, () => entries.save(owner, groupId, dto));
    const before = await as(owner, () => groups.detail(owner, groupId));
    await expect(
      as(owner, () =>
        entries.save(
          owner,
          groupId,
          { ...dto, operationId: randomUUID(), expectedRevision: 2 },
          saved.id,
        ),
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(await as(owner, () => groups.detail(owner, groupId))).toEqual(
      before,
    );
  });

  it("keeps note-only edits out of the financial revision", async () => {
    const dto = expense();
    const saved = await as(owner, () => entries.save(owner, groupId, dto));
    const updated = await as(owner, () =>
      entries.save(
        owner,
        groupId,
        {
          ...dto,
          operationId: randomUUID(),
          expectedRevision: 1,
          note: "Receipt attached later",
        },
        saved.id,
      ),
    );
    expect(updated.revision).toBe(2);
    expect(updated.financialRevision).toBe(1);
  });

  it("uses the frozen original rate for partial refunds and rejects over-refunding", async () => {
    const saved = await as(owner, () =>
      entries.save(
        owner,
        groupId,
        expense({
          amount: "30",
          currencyCode: "EUR",
          fxRate: "4.3",
          contributions: [{ participantId: me, value: "30" }],
        }),
      ),
    );
    const refund = expense({
      type: "REFUND",
      sourceEntryId: saved.id,
      amount: "10",
      currencyCode: "EUR",
      fxRate: "5",
      splitMode: "EXACT",
      shares: [{ participantId: anna, value: "10" }],
      contributions: [{ participantId: me, value: "10" }],
    });
    const reversed = await as(owner, () =>
      entries.save(owner, groupId, refund),
    );
    expect(reversed.groupAmount).toBe("43.0000");
    await expect(
      as(owner, () =>
        entries.save(owner, groupId, { ...refund, operationId: randomUUID() }),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      as(owner, () =>
        entries.reverse(owner, groupId, saved.id, {
          operationId: randomUUID(),
          expectedRevision: 1,
          reason: "Wrong expense",
        }),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("records a partial repayment without counting it as group income or expense", async () => {
    await as(owner, () => entries.save(owner, groupId, expense()));
    await as(owner, () =>
      entries.save(
        owner,
        groupId,
        expense({
          type: "REPAYMENT",
          amount: "40",
          fromParticipantId: anna,
          toParticipantId: me,
          shares: [],
          contributions: [],
          expectedGroupRevision: 1,
        }),
      ),
    );
    const { balances } = await as(owner, () => groups.detail(owner, groupId));
    expect(balances.totalExpenses).toBe("300.0000");
    expect(balances.totalIncome).toBe("0.0000");
    expect(
      balances.positions.find((p) => p.participantId === anna)?.balance,
    ).toBe("-60.0000");
  });

  it("keeps future entries as drafts and missing FX explicitly incomplete", async () => {
    await as(owner, () =>
      entries.save(owner, groupId, expense({ date: "2099-01-01" })),
    );
    expect(
      (await as(owner, () => groups.detail(owner, groupId))).balances
        .totalExpenses,
    ).toBe("0.0000");
    await as(owner, () =>
      entries.save(owner, groupId, expense({ currencyCode: "EUR" })),
    );
    const detail = await as(owner, () => groups.detail(owner, groupId));
    expect(detail.balances.totalExpenses).toBeNull();
    expect(detail.balances.suggestions).toEqual([]);
  });

  it("enforces allocation conservation in PostgreSQL independently of the service", async () => {
    const saved = await as(owner, () =>
      entries.save(owner, groupId, expense()),
    );
    await expect(
      as(owner, () =>
        withScopedDb(harness.app, async (m) => {
          await m.query(
            "UPDATE shared_allocations SET original_amount = original_amount + 1 WHERE entry_id = $1 AND participant_id = $2 AND kind = 'SHARE'",
            [saved.id, anna],
          );
        }),
      ),
    ).rejects.toThrow("preserve the entry total");
    expect(
      (
        await as(owner, () => entries.get(owner, groupId, saved.id))
      ).allocations.find((a) => a.participantId === anna)?.originalAmount,
    ).toBe("100.0000");
  });

  it("revokes access immediately while preserving the participant's balances", async () => {
    await join();
    await as(owner, () => entries.save(owner, groupId, expense()));
    const detail = await as(owner, () => groups.detail(owner, groupId));
    await as(owner, () =>
      memberships.change(owner, groupId, anna, {
        operationId: randomUUID(),
        expectedRevision: detail.revision,
        action: "REVOKE",
      }),
    );
    await expect(
      as(guest, () => groups.detail(guest, groupId)),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(
      (
        await as(owner, () => groups.detail(owner, groupId))
      ).balances.positions.find((p) => p.participantId === anna)?.balance,
    ).toBe("-100.0000");
  });

  async function financeFixture(bankAmount = "-300.0000") {
    const account = await createTestAccount(harness.owner, owner, {
      name: "Bank",
      currencyCode: "PLN",
      openingBalance: 1000,
      currentBalance: 1000 + Number(bankAmount),
    });
    const category = await createTestCategory(harness.owner, owner, {
      name: "Food",
    });
    const bankId = randomUUID();
    await harness.owner.query(
      "INSERT INTO transactions (id,user_id,account_id,transaction_date,amount,currency_code,category_id,external_id) VALUES ($1,$2,$3,'2026-01-10',$4,'PLN',$5,'bank:immutable-import-id')",
      [bankId, owner, account.id, bankAmount, category.id],
    );
    const detail = await as(owner, () => groups.detail(owner, groupId));
    const integration = await as(owner, () =>
      finance.enable(owner, groupId, {
        operationId: randomUUID(),
        expectedRevision: detail.revision,
        accountName: "Weekend settlement",
      }),
    );
    return { account, category, bankId, integration };
  }
  async function book(entryId: string, dto: BookSharedEntryDto) {
    const preview = await as(owner, () =>
      finance.preview(owner, groupId, entryId, dto),
    );
    return as(owner, () =>
      finance.book(owner, groupId, entryId, {
        ...dto,
        previewFingerprint: preview.fingerprint,
      }),
    );
  }
  async function balance(accountId: string) {
    const [row] = await harness.owner.query(
      "SELECT current_balance FROM accounts WHERE id = $1",
      [accountId],
    );
    return row.current_balance as string;
  }

  it("rolls back the journal, posting, bank source and balance after an injected mid-booking failure", async () => {
    const f = await financeFixture();
    const group = await as(owner, () => groups.detail(owner, groupId));
    const combined = harness.module.get(SharedEntryFinanceService);
    const dto = {
      operationId: randomUUID(),
      expectedRevision: group.revision,
      entry: expense(),
      finance: {
        operationId: randomUUID(),
        expectedRevision: 1,
        categoryId: f.category.id,
        bankTransactionId: f.bankId,
      },
    };
    const preview = await as(owner, () =>
      combined.preview(owner, groupId, dto),
    );
    const beforeBank = await harness.owner.query(
      "SELECT * FROM transactions WHERE id=$1",
      [f.bankId],
    );
    const accounts = harness.module.get(AccountsService);
    const updateBalance = accounts.updateBalance.bind(accounts);
    const failpoint = jest
      .spyOn(accounts, "updateBalance")
      .mockImplementationOnce(async (...args) => {
        await updateBalance(...args);
        await withScopedDb(harness.app, async (m) => {
          expect(
            await m.query(
              "SELECT count(*)::int AS n FROM shared_entries WHERE group_id=$1",
              [groupId],
            ),
          ).toEqual([{ n: 1 }]);
          expect(
            await m.query(
              "SELECT count(*)::int AS n FROM shared_postings WHERE group_id=$1",
              [groupId],
            ),
          ).toEqual([{ n: 1 }]);
        });
        throw new Error("Injected mid-booking failure");
      });
    try {
      await expect(
        as(owner, () =>
          combined.save(owner, groupId, {
            ...dto,
            previewFingerprint: preview.fingerprint,
          }),
        ),
      ).rejects.toThrow("Injected mid-booking failure");
      expect(failpoint).toHaveBeenCalledTimes(1);
    } finally {
      failpoint.mockRestore();
    }
    expect(await balance(f.account.id)).toBe("700.0000");
    expect(await balance(f.integration.accountId)).toBe("0.0000");
    expect(
      await harness.owner.query("SELECT * FROM transactions WHERE id=$1", [
        f.bankId,
      ]),
    ).toEqual(beforeBank);
    expect(
      await harness.owner.query(
        "SELECT id FROM shared_entries WHERE group_id=$1",
        [groupId],
      ),
    ).toEqual([]);
    expect(
      await harness.owner.query(
        "SELECT id FROM shared_postings WHERE group_id=$1",
        [groupId],
      ),
    ).toEqual([]);
    expect(
      await harness.owner.query(
        "SELECT id FROM shared_commands WHERE id=ANY($1::uuid[])",
        [[dto.operationId, dto.entry.operationId]],
      ),
    ).toEqual([]);
  });

  it("matches an imported 300 debit without a second bank movement and restores it when unlinked", async () => {
    const saved = await as(owner, () =>
      entries.save(owner, groupId, expense()),
    );
    const f = await financeFixture();
    await book(saved.id, {
      operationId: randomUUID(),
      expectedRevision: 1,
      bankTransactionId: f.bankId,
      categoryId: f.category.id,
    });
    expect(await balance(f.account.id)).toBe("700.0000");
    expect(await balance(f.integration.accountId)).toBe("200.0000");
    const [bank] = await harness.owner.query(
      "SELECT external_id, amount, is_transfer FROM transactions WHERE id = $1",
      [f.bankId],
    );
    expect(bank).toEqual({
      external_id: "bank:immutable-import-id",
      amount: "-300.0000",
      is_transfer: true,
    });
    const [cost] = await harness.owner.query(
      "SELECT sum(amount) AS amount FROM transactions WHERE account_id = $1 AND NOT is_transfer",
      [f.integration.accountId],
    );
    expect(cost.amount).toBe("-100.0000");
    await as(owner, () =>
      finance.unlink(owner, groupId, saved.id, {
        operationId: randomUUID(),
        expectedRevision: 1,
      }),
    );
    expect(await balance(f.account.id)).toBe("700.0000");
    expect(await balance(f.integration.accountId)).toBe("0.0000");
    const [restored] = await harness.owner.query(
      "SELECT category_id, is_transfer, shared_expense_posting_id FROM transactions WHERE id = $1",
      [f.bankId],
    );
    expect(restored).toEqual({
      category_id: f.category.id,
      is_transfer: false,
      shared_expense_posting_id: null,
    });
  });

  it("keeps the private 50 in a mixed basket and books only the personal 100 share", async () => {
    const saved = await as(owner, () =>
      entries.save(owner, groupId, expense()),
    );
    const f = await financeFixture("-350.0000");
    await book(saved.id, {
      operationId: randomUUID(),
      expectedRevision: 1,
      bankTransactionId: f.bankId,
      sharedBankAmount: "300",
      categoryId: f.category.id,
    });
    expect(await balance(f.account.id)).toBe("650.0000");
    expect(await balance(f.integration.accountId)).toBe("200.0000");
    const splits = await harness.owner.query(
      "SELECT kind, amount FROM transaction_splits WHERE transaction_id = $1 ORDER BY kind",
      [f.bankId],
    );
    expect(splits).toEqual([
      { kind: "category", amount: "-50.0000" },
      { kind: "transfer", amount: "-300.0000" },
    ]);
  });

  it("blocks generic money edits and leaves a previously accepted private position unchanged after a peer edit", async () => {
    await join();
    const dto = expense({
      contributions: [{ participantId: me, value: "300" }],
    });
    const saved = await as(guest, () => entries.save(guest, groupId, dto));
    const f = await financeFixture();
    await book(saved.id, {
      operationId: randomUUID(),
      expectedRevision: 1,
      bankTransactionId: f.bankId,
      categoryId: f.category.id,
    });
    await expect(
      as(owner, () =>
        withScopedDb(harness.app, async (m) => {
          await m.query("UPDATE transactions SET amount = -400 WHERE id = $1", [
            f.bankId,
          ]);
        }),
      ),
    ).rejects.toMatchObject({ driverError: { code: "PSE01" } });
    await expect(
      as(owner, () =>
        withScopedDb(harness.app, async (m) => {
          await m.query("DELETE FROM transactions WHERE id = $1", [f.bankId]);
        }),
      ),
    ).rejects.toThrow();
    await as(guest, () =>
      entries.save(
        guest,
        groupId,
        {
          ...dto,
          operationId: randomUUID(),
          expectedRevision: 1,
          splitMode: "EXACT",
          shares: [
            { participantId: me, value: "80" },
            { participantId: anna, value: "110" },
            { participantId: ben, value: "110" },
          ],
        },
        saved.id,
      ),
    );
    expect(await balance(f.integration.accountId)).toBe("200.0000");
    const overview = await as(owner, () => finance.overview(owner, groupId));
    expect(overview.pendingCount).toBe(1);
    expect(overview.entries[0].effect?.position).toBe("220.0000");
    expect(overview.entries[0].posting?.snapshot.effect.position).toBe(
      "200.0000",
    );
    await book(saved.id, {
      operationId: randomUUID(),
      expectedRevision: 2,
      bankTransactionId: f.bankId,
      categoryId: f.category.id,
    });
    expect(await balance(f.integration.accountId)).toBe("220.0000");
    expect(await balance(f.account.id)).toBe("700.0000");
  });

  it("refuses a changed bank preview before booking any ledger row", async () => {
    const saved = await as(owner, () =>
      entries.save(owner, groupId, expense()),
    );
    const f = await financeFixture();
    const dto = {
      operationId: randomUUID(),
      expectedRevision: 1,
      bankTransactionId: f.bankId,
      categoryId: f.category.id,
    };
    const preview = await as(owner, () =>
      finance.preview(owner, groupId, saved.id, dto),
    );
    await harness.owner.query(
      "UPDATE transactions SET description = 'Changed before booking' WHERE id = $1",
      [f.bankId],
    );
    await expect(
      as(owner, () =>
        finance.book(owner, groupId, saved.id, {
          ...dto,
          previewFingerprint: preview.fingerprint,
        }),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(await balance(f.integration.accountId)).toBe("0.0000");
    expect(
      await harness.owner.query(
        "SELECT count(*)::int AS n FROM shared_postings WHERE user_id = $1",
        [owner],
      ),
    ).toEqual([{ n: 0 }]);
  });
  it("requires recipient-written consent for ownership; an owner cannot forge it, and a replaced request invalidates it", async () => {
    await join();
    const current = () => as(owner, () => groups.detail(owner, groupId));
    const change = async (action: "REQUEST_OWNER" | "TRANSFER_OWNER") =>
      as(owner, async () =>
        memberships.change(owner, groupId, anna, {
          operationId: randomUUID(),
          expectedRevision: (await current()).revision,
          action,
        }),
      );
    await expect(change("TRANSFER_OWNER")).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(
      as(owner, () =>
        withScopedDb(harness.app, (manager) =>
          manager.query(
            "UPDATE shared_groups SET owner_user_id = $2 WHERE id = $1",
            [groupId, guest],
          ),
        ),
      ),
    ).rejects.toThrow("recipient consent");
    await change("REQUEST_OWNER");
    const request = (await current()).ownershipTransfer!;
    await expect(
      as(owner, () =>
        withScopedDb(harness.app, async (manager) => {
          await manager.query(
            "UPDATE shared_memberships SET ownership_accepted_request_id = $3 WHERE group_id=$1 AND participant_id=$2",
            [groupId, anna, request.requestId],
          );
        }),
      ),
    ).rejects.toThrow("Only the recipient");
    const requestedRevision = (await current()).revision;
    await as(guest, () =>
      memberships.acceptOwnership(guest, groupId, request.requestId, {
        operationId: randomUUID(),
        expectedRevision: requestedRevision,
      }),
    );
    expect((await current()).ownershipTransfer?.accepted).toBe(true);
    await change("REQUEST_OWNER");
    await expect(change("TRANSFER_OWNER")).rejects.toBeInstanceOf(
      BadRequestException,
    );
    const refreshed = await current();
    await as(guest, () =>
      memberships.acceptOwnership(
        guest,
        groupId,
        refreshed.ownershipTransfer!.requestId,
        { operationId: randomUUID(), expectedRevision: refreshed.revision },
      ),
    );
    await change("TRANSFER_OWNER");
    expect((await as(guest, () => groups.detail(guest, groupId))).role).toBe(
      "OWNER",
    );
    expect((await current()).role).toBe("EDITOR");
    expect((await current()).ownershipTransfer).toBeNull();
  });
});
