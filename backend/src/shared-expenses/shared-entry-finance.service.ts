import { tokenHashesEqual } from "../auth/crypto.util";
import { Injectable } from "@nestjs/common";
import { DataSource } from "typeorm";
import { withScopedDb } from "../common/db/scoped-db";
import { AccountsService } from "../accounts/accounts.service";
import { ExchangeRateService } from "../currencies/exchange-rate.service";
import { NetWorthService } from "../net-worth/net-worth.service";
import { SharedEntriesService } from "./shared-entries.service";
import { SharedFinanceService } from "./shared-finance.service";
import { SaveSharedEntryFinanceDto } from "./dto/shared-entry-finance.dto";
import {
  lockSharedGroup,
  requireRevision,
  requireSharedGroup,
  sharedCommand,
  sharedFingerprint,
} from "./shared-db";
import { planSharedFinance } from "./shared-finance-plan";
import { publicSharedFinancePlan } from "./shared-finance-preview";
import { writeSharedFinance } from "./shared-finance-write";
import { sharedError } from "./shared-errors";

/** Optional group entry and own posting, under one scoped transaction and group lock. */
@Injectable()
export class SharedEntryFinanceService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly entries: SharedEntriesService,
    private readonly finance: SharedFinanceService,
    private readonly rates: ExchangeRateService,
    private readonly accounts: AccountsService,
    private readonly netWorth: NetWorthService,
  ) {}

  private async prepare(
    userId: string,
    groupId: string,
    dto: SaveSharedEntryFinanceDto,
  ) {
    if (dto.operationId === dto.entry.operationId) sharedError("retryChanged");
    const proposal = await this.entries.preview(
      userId,
      groupId,
      dto.entry,
      dto.entryId,
    );
    await this.finance.prepareBankRates(
      userId,
      groupId,
      proposal.id,
      dto.finance,
      { ...proposal, createdByUserId: userId },
    );
  }

  async preview(
    userId: string,
    groupId: string,
    dto: SaveSharedEntryFinanceDto,
  ) {
    await this.prepare(userId, groupId, dto);
    return withScopedDb(this.dataSource, async (manager) => {
      await lockSharedGroup(manager, groupId);
      const group = await requireSharedGroup(manager, userId, groupId, "WRITE");
      requireRevision(group.revision, dto.expectedRevision);
      const entry = await this.entries.preview(
        userId,
        groupId,
        dto.entry,
        dto.entryId,
        true,
      );
      const plan = await planSharedFinance(
        manager,
        this.rates,
        userId,
        groupId,
        entry.id,
        dto.finance,
        { ...entry, createdByUserId: userId },
      );
      return {
        entry,
        finance: publicSharedFinancePlan(plan),
        fingerprint: sharedFingerprint({
          entry: entry.previewFingerprint,
          finance: plan.fingerprint,
        }),
      };
    });
  }

  async save(userId: string, groupId: string, dto: SaveSharedEntryFinanceDto) {
    const payload = { ...dto, action: "ENTRY_AND_FINANCE" };
    const replay = await withScopedDb(this.dataSource, async (manager) => {
      await lockSharedGroup(manager, groupId);
      await requireSharedGroup(manager, userId, groupId, "WRITE");
      const rows: {
        payload_hash: string;
        result: Awaited<ReturnType<SharedEntryFinanceService["commit"]>>;
      }[] = await manager.query(
        "SELECT payload_hash, result FROM shared_commands WHERE id = $1 AND user_id = $2 AND group_id = $3",
        [dto.operationId, userId, groupId],
      );
      if (
        rows[0] &&
        !tokenHashesEqual(rows[0].payload_hash, sharedFingerprint(payload))
      )
        sharedError("retryChanged");
      return rows[0]?.result ?? null;
    });
    const result = replay ?? (await this.commit(userId, groupId, dto));
    for (const accountId of result.affectedAccountIds)
      this.netWorth.triggerDebouncedRecalc(accountId, userId);
    return { entry: result.entry, postingId: result.id };
  }

  private async commit(
    userId: string,
    groupId: string,
    dto: SaveSharedEntryFinanceDto,
  ) {
    await this.prepare(userId, groupId, dto);
    return withScopedDb(this.dataSource, async (manager) => {
      await lockSharedGroup(manager, groupId);
      const group = await requireSharedGroup(manager, userId, groupId, "WRITE");
      return sharedCommand(
        manager,
        userId,
        groupId,
        dto.operationId,
        { ...dto, action: "ENTRY_AND_FINANCE" },
        async () => {
          requireRevision(group.revision, dto.expectedRevision);
          const reused: { id: string }[] = await manager.query(
            "SELECT id FROM shared_commands WHERE id = $1 AND user_id = $2",
            [dto.entry.operationId, userId],
          );
          if (reused.length) sharedError("retryChanged");
          const proposal = await this.entries.preview(
            userId,
            groupId,
            dto.entry,
            dto.entryId,
            true,
          );
          const plan = await planSharedFinance(
            manager,
            this.rates,
            userId,
            groupId,
            proposal.id,
            dto.finance,
            { ...proposal, createdByUserId: userId },
          );
          if (
            dto.previewFingerprint !==
            sharedFingerprint({
              entry: proposal.previewFingerprint,
              finance: plan.fingerprint,
            })
          )
            sharedError("financePreview");
          // Both previews have checked revision, ownership, bank identity, categories and sums before any financial row is written.
          const entry = await this.entries.save(
            userId,
            groupId,
            dto.entry,
            dto.entryId,
            true,
          );
          const {
            operationId: _operation,
            previewFingerprint: _preview,
            ...input
          } = dto.finance;
          const posting = await writeSharedFinance(
            manager,
            this.accounts,
            userId,
            plan,
            input,
          );
          return { entry, ...posting };
        },
      );
    });
  }
}
