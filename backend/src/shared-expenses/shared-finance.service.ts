import { publicSharedFinancePlan } from "./shared-finance-preview";
import { SharedFinanceOverview } from "./shared-finance-types";
import { randomUUID } from "crypto";
import { Injectable } from "@nestjs/common";
import { DataSource } from "typeorm";
import { AccountsService } from "../accounts/accounts.service";
import { CurrenciesService } from "../currencies/currencies.service";
import { ExchangeRateService } from "../currencies/exchange-rate.service";
import { NetWorthService } from "../net-worth/net-worth.service";
import { withScopedDb } from "../common/db/scoped-db";
import {
  lockAccountsForBalanceWrite,
  lockTransactionRows,
} from "../common/db/locks";
import {
  BookSharedEntryDto,
  EnableSharedFinanceDto,
} from "./dto/shared-finance.dto";
import { SharedCommandDto } from "./dto/shared-command.dto";
import {
  assertSharedPrincipal,
  lockSharedGroup,
  requireRevision,
  requireSharedGroup,
  sharedCommand,
} from "./shared-db";
import { sharedError } from "./shared-errors";
import { readSharedJournal } from "./shared-journal";
import {
  sharedBankRows,
  sharedIntegration,
  sharedPostingLinks,
  sharedPostings,
} from "./shared-finance-read";
import { readSharedFinanceOverview } from "./shared-finance-overview";
import { planSharedFinance } from "./shared-finance-plan";
import { undoSharedPosting, writeSharedFinance } from "./shared-finance-write";

@Injectable()
export class SharedFinanceService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly accounts: AccountsService,
    private readonly currencies: CurrenciesService,
    private readonly rates: ExchangeRateService,
    private readonly netWorth: NetWorthService,
  ) {}

  async enable(userId: string, groupId: string, dto: EnableSharedFinanceDto) {
    const result = await withScopedDb(this.dataSource, async (manager) => {
      await lockSharedGroup(manager, groupId);
      const group = await requireSharedGroup(manager, userId, groupId);
      return sharedCommand(
        manager,
        userId,
        groupId,
        dto.operationId,
        dto,
        async () => {
          requireRevision(group.revision, dto.expectedRevision);
          if (!group.myParticipantId) sharedError("financeConnected");
          if (!dto.accountName.trim()) sharedError("financeBank");
          const integration = await sharedIntegration(manager, userId, groupId);
          if (integration)
            return { id: integration.id, accountId: integration.accountId };
          await this.currencies.ensureCurrencyForUser(
            userId,
            group.currencyCode,
          );
          const id = randomUUID();
          const accountId = randomUUID();
          await manager.query(
            "SELECT set_config('app.shared_group_id', $1, true)",
            [groupId],
          );
          await manager.query(
            `INSERT INTO accounts (id,user_id,account_type,name,currency_code,opening_balance,current_balance,managed_purpose,shared_expense_group_id)
          VALUES ($1,$2,'OTHER',$3,$4,0,0,'SHARED_SETTLEMENT',$5)`,
            [
              accountId,
              userId,
              dto.accountName.trim(),
              group.currencyCode,
              groupId,
            ],
          );
          await manager.query(
            "INSERT INTO shared_integrations (id,user_id,group_id,participant_id,account_id) VALUES ($1,$2,$3,$4,$5)",
            [id, userId, groupId, group.myParticipantId, accountId],
          );
          return { id, accountId };
        },
      );
    });
    this.netWorth.triggerDebouncedRecalc(result.accountId, userId);
    return result;
  }

  async privateGroups(userId: string) {
    assertSharedPrincipal(userId);
    return withScopedDb(this.dataSource, (manager) =>
      manager.query(
        `SELECT i.group_id AS "groupId", a.id AS "accountId", a.name, a.currency_code AS "currencyCode"
       FROM shared_integrations i JOIN accounts a ON a.id = i.account_id AND a.user_id = i.user_id
       WHERE i.user_id = $1 ORDER BY a.name, a.id`,
        [userId],
      ),
    );
  }

  async postingLocation(userId: string, postingId: string) {
    assertSharedPrincipal(userId);
    return withScopedDb(this.dataSource, async (manager) => {
      const rows: { groupId: string; entryId: string }[] = await manager.query(
        'SELECT group_id AS "groupId", entry_id AS "entryId" FROM shared_postings WHERE id = $1 AND user_id = $2',
        [postingId, userId],
      );
      if (!rows[0]) sharedError("notFound");
      return rows[0];
    });
  }

  async overview(
    userId: string,
    groupId: string,
  ): Promise<SharedFinanceOverview> {
    return withScopedDb<SharedFinanceOverview>(
      this.dataSource,
      (manager) => readSharedFinanceOverview(manager, userId, groupId),
      "REPEATABLE READ",
    );
  }

  async preview(
    userId: string,
    groupId: string,
    entryId: string,
    dto: BookSharedEntryDto,
  ) {
    await this.prepareBankRates(userId, groupId, entryId, dto);
    return withScopedDb(this.dataSource, async (manager) => {
      await lockSharedGroup(manager, groupId);
      await requireSharedGroup(manager, userId, groupId);
      const plan = await planSharedFinance(
        manager,
        this.rates,
        userId,
        groupId,
        entryId,
        dto,
      );
      return publicSharedFinancePlan(plan);
    });
  }

  async book(
    userId: string,
    groupId: string,
    entryId: string,
    dto: BookSharedEntryDto,
  ) {
    await this.prepareBankRates(userId, groupId, entryId, dto);
    const result = await withScopedDb(this.dataSource, async (manager) => {
      await lockSharedGroup(manager, groupId);
      await requireSharedGroup(manager, userId, groupId);
      return sharedCommand(
        manager,
        userId,
        groupId,
        dto.operationId,
        { ...dto, entryId, action: "BOOK" },
        async () => {
          const plan = await planSharedFinance(
            manager,
            this.rates,
            userId,
            groupId,
            entryId,
            dto,
          );
          if (dto.previewFingerprint !== plan.fingerprint)
            sharedError("financePreview");
          const {
            previewFingerprint: _fingerprint,
            operationId: _operation,
            ...input
          } = dto;
          return writeSharedFinance(
            manager,
            this.accounts,
            userId,
            plan,
            input,
          );
        },
      );
    });
    for (const id of result.affectedAccountIds)
      this.netWorth.triggerDebouncedRecalc(id, userId);
    return { id: result.id };
  }

  async unlink(
    userId: string,
    groupId: string,
    entryId: string,
    dto: SharedCommandDto,
  ) {
    const result = await withScopedDb(this.dataSource, async (manager) => {
      await lockSharedGroup(manager, groupId);
      assertSharedPrincipal(userId);
      if (!(await sharedIntegration(manager, userId, groupId)))
        sharedError("notFound");
      return sharedCommand(
        manager,
        userId,
        groupId,
        dto.operationId,
        { ...dto, entryId, action: "UNLINK" },
        async () => {
          const existing = (
            await sharedPostings(manager, userId, groupId)
          ).find((p) => p.entryId === entryId);
          if (!existing) sharedError("notFound");
          requireRevision(existing.acceptedRevision, dto.expectedRevision);
          const sourceLinks = await sharedPostingLinks(
            manager,
            userId,
            existing.id,
          );
          const ids = sourceLinks.map((l) => l.transactionId);
          const before = await sharedBankRows(manager, userId, ids);
          await lockAccountsForBalanceWrite(
            manager,
            before.map((r) => r.accountId),
            userId,
          );
          await lockTransactionRows(manager, ids, userId);
          const sourceRows = await sharedBankRows(manager, userId, ids);
          if (
            sourceRows.length !== ids.length ||
            sourceRows.some(
              (r) =>
                r.accountId !== before.find((b) => b.id === r.id)?.accountId,
            )
          )
            sharedError("financePreview");
          if (sourceRows.some((r) => r.status === "RECONCILED"))
            sharedError("financeReconciled");
          const affectedAccountIds = await undoSharedPosting(
            manager,
            this.accounts,
            userId,
            { existing, sourceLinks, sourceRows },
          );
          await manager.query(
            "DELETE FROM shared_postings WHERE id = $1 AND user_id = $2",
            [existing.id, userId],
          );
          return { id: existing.id, affectedAccountIds };
        },
      );
    });
    for (const id of result.affectedAccountIds)
      this.netWorth.triggerDebouncedRecalc(id, userId);
    return { id: result.id };
  }

  async prepareBankRates(
    userId: string,
    groupId: string,
    entryId: string,
    dto: BookSharedEntryDto,
    proposedEntry?: import("./shared-journal").SharedJournalEntry,
  ): Promise<void> {
    if (dto.payments) {
      for (const payment of dto.payments)
        await this.prepareBankRates(
          userId,
          groupId,
          entryId,
          {
            ...payment,
            operationId: dto.operationId,
            expectedRevision: dto.expectedRevision,
          },
          proposedEntry,
        );
      return;
    }
    if (dto.bankRate || (!dto.bankTransactionId && !dto.bankAccountId)) return;
    const pair = await withScopedDb(this.dataSource, async (manager) => {
      const group = await requireSharedGroup(manager, userId, groupId);
      const entry =
        proposedEntry ??
        (await readSharedJournal(manager, groupId)).find(
          (e) => e.id === entryId,
        );
      if (!entry || entry.state !== "POSTED") return null;
      const bank = dto.bankTransactionId
        ? (await sharedBankRows(manager, userId, [dto.bankTransactionId]))[0]
        : null;
      const rows: { currency_code: string }[] = await manager.query(
        "SELECT currency_code FROM accounts WHERE id = $1 AND user_id = $2 AND managed_purpose IS NULL",
        [bank?.accountId ?? dto.bankAccountId, userId],
      );
      const currency = rows[0]?.currency_code;
      return !currency ||
        currency === group.currencyCode ||
        currency === entry.currencyCode
        ? null
        : {
            from: group.currencyCode,
            to: currency,
            date: bank?.date ?? entry.date,
          };
    });
    if (pair) await this.rates.getRateForDate(pair.from, pair.to, pair.date);
  }
}
