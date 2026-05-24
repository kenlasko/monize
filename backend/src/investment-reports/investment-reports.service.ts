import { Injectable, NotFoundException } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import {
  InvestmentReport,
  InvestmentReportConfig,
  InvestmentGroupBy,
  InvestmentSortDirection,
} from "./entities/investment-report.entity";
import { CreateInvestmentReportDto } from "./dto/create-investment-report.dto";
import { UpdateInvestmentReportDto } from "./dto/update-investment-report.dto";
import {
  ExecuteInvestmentReportDto,
  InvestmentReportResult,
  InvestmentReportRow,
  InvestmentReportGroup,
  InvestmentCellValue,
} from "./dto/execute-investment-report.dto";
import {
  InvestmentReportDataService,
  ComputedHolding,
} from "./investment-report-data.service";
import {
  Account,
  AccountType,
  AccountSubType,
} from "../accounts/entities/account.entity";
import { UserPreference } from "../users/entities/user-preference.entity";
import { ActionHistoryService } from "../action-history/action-history.service";
import { ALWAYS_INCLUDED_COLUMN } from "./investment-report-columns";

@Injectable()
export class InvestmentReportsService {
  constructor(
    @InjectRepository(InvestmentReport)
    private reportsRepository: Repository<InvestmentReport>,
    @InjectRepository(Account)
    private accountsRepository: Repository<Account>,
    @InjectRepository(UserPreference)
    private prefRepository: Repository<UserPreference>,
    private dataService: InvestmentReportDataService,
    private actionHistoryService: ActionHistoryService,
  ) {}

  async create(
    userId: string,
    dto: CreateInvestmentReportDto,
  ): Promise<InvestmentReport> {
    const config = this.buildConfig(dto.config);
    const report = this.reportsRepository.create({
      name: dto.name,
      description: dto.description ?? null,
      icon: dto.icon ?? null,
      backgroundColor: dto.backgroundColor ?? null,
      groupBy: dto.groupBy ?? InvestmentGroupBy.NONE,
      config,
      isFavourite: dto.isFavourite ?? false,
      sortOrder: dto.sortOrder ?? 0,
      userId,
    });
    const saved = await this.reportsRepository.save(report);

    this.actionHistoryService.record(userId, {
      entityType: "investment_report",
      entityId: saved.id,
      action: "create",
      afterData: { ...saved },
      description: `Created investment report "${saved.name}"`,
    });

    return saved;
  }

  async findAll(userId: string): Promise<InvestmentReport[]> {
    return this.reportsRepository.find({
      where: { userId },
      order: { sortOrder: "ASC", createdAt: "DESC" },
    });
  }

  async findOne(userId: string, id: string): Promise<InvestmentReport> {
    const report = await this.reportsRepository.findOne({
      where: { id, userId },
    });
    if (!report) {
      throw new NotFoundException(`Investment report with ID ${id} not found`);
    }
    return report;
  }

  async update(
    userId: string,
    id: string,
    dto: UpdateInvestmentReportDto,
  ): Promise<InvestmentReport> {
    const report = await this.findOne(userId, id);
    const beforeData = { ...report };

    if (dto.name !== undefined) report.name = dto.name;
    if (dto.description !== undefined)
      report.description = dto.description ?? null;
    if (dto.icon !== undefined) report.icon = dto.icon ?? null;
    if (dto.backgroundColor !== undefined)
      report.backgroundColor = dto.backgroundColor ?? null;
    if (dto.groupBy !== undefined) report.groupBy = dto.groupBy;
    if (dto.isFavourite !== undefined) report.isFavourite = dto.isFavourite;
    if (dto.sortOrder !== undefined) report.sortOrder = dto.sortOrder;
    if (dto.config !== undefined) {
      report.config = this.buildConfig(dto.config, report.config);
    }

    const saved = await this.reportsRepository.save(report);

    this.actionHistoryService.record(userId, {
      entityType: "investment_report",
      entityId: id,
      action: "update",
      beforeData,
      afterData: { ...saved },
      description: `Updated investment report "${saved.name}"`,
    });

    return saved;
  }

  async remove(userId: string, id: string): Promise<void> {
    const report = await this.findOne(userId, id);
    const beforeData = { ...report };
    await this.reportsRepository.remove(report);

    this.actionHistoryService.record(userId, {
      entityType: "investment_report",
      entityId: beforeData.id,
      action: "delete",
      beforeData,
      description: `Deleted investment report "${beforeData.name}"`,
    });
  }

  async execute(
    userId: string,
    id: string,
    overrides?: ExecuteInvestmentReportDto,
  ): Promise<InvestmentReportResult> {
    const report = await this.findOne(userId, id);
    const accountIds = await this.resolveAccountIds(
      userId,
      report.config.accountIds ?? [],
    );

    const asOfDate =
      overrides?.asOfDate ||
      report.config.asOfDate ||
      (await this.dataService.getLatestMarketDay(userId, accountIds));

    const pref = await this.prefRepository.findOne({ where: { userId } });
    const baseCurrency = pref?.defaultCurrency || "CAD";

    // Combining duplicate securities across accounts is available everywhere
    // except when rows are already keyed by account.
    const groupsAcross =
      report.groupBy === InvestmentGroupBy.SYMBOL ||
      report.groupBy === InvestmentGroupBy.CURRENCY;
    const mergeAccounts =
      report.groupBy !== InvestmentGroupBy.ACCOUNT &&
      overrides?.mergeAccounts === true;

    const holdings = await this.dataService.computeHoldings(
      userId,
      accountIds,
      asOfDate,
      baseCurrency,
      mergeAccounts,
    );

    let columns = [...report.config.columns];
    // When securities from multiple accounts are listed separately, lead with
    // the account column so the user can tell the holdings apart.
    if (groupsAcross && !mergeAccounts) {
      columns = [
        "account",
        ...columns.filter((c) => c !== "account"),
      ];
    }
    const groups = this.buildGroups(
      holdings,
      report.groupBy,
      columns,
      report.config,
    );

    const rowCount = groups.reduce((sum, g) => sum + g.rows.length, 0);

    return {
      reportId: report.id,
      name: report.name,
      asOfDate,
      baseCurrency,
      groupBy: report.groupBy,
      columns,
      groups,
      rowCount,
    };
  }

  // ---------------------------------------------------------------------------

  private buildConfig(
    dto: CreateInvestmentReportDto["config"],
    existing?: InvestmentReportConfig,
  ): InvestmentReportConfig {
    return {
      columns: dto.columns ?? existing?.columns ?? [],
      accountIds: dto.accountIds ?? [],
      sortColumn: dto.sortColumn ?? null,
      sortDirection: dto.sortDirection ?? InvestmentSortDirection.ASC,
      asOfDate: dto.asOfDate ?? null,
    };
  }

  /**
   * Restrict the requested account IDs to the user's open holdings accounts
   * (brokerage + standalone, excluding cash siblings). An empty request means
   * "all holdings accounts".
   */
  private async resolveAccountIds(
    userId: string,
    requested: string[],
  ): Promise<string[]> {
    const accounts = await this.accountsRepository.find({
      where: { userId, accountType: AccountType.INVESTMENT, isClosed: false },
    });
    const holdingsIds = accounts
      .filter(
        (a) =>
          a.accountSubType === AccountSubType.INVESTMENT_BROKERAGE ||
          a.accountSubType === null ||
          a.accountSubType === undefined,
      )
      .map((a) => a.id);
    if (requested.length === 0) return holdingsIds;
    const allowed = new Set(holdingsIds);
    return requested.filter((id) => allowed.has(id));
  }

  private buildGroups(
    holdings: ComputedHolding[],
    groupBy: InvestmentGroupBy,
    columns: string[],
    config: InvestmentReportConfig,
  ): InvestmentReportGroup[] {
    const buckets = new Map<
      string,
      { label: string; holdings: ComputedHolding[] }
    >();

    for (const h of holdings) {
      const { key, label } = this.groupKey(h, groupBy);
      let bucket = buckets.get(key);
      if (!bucket) {
        bucket = { label, holdings: [] };
        buckets.set(key, bucket);
      }
      bucket.holdings.push(h);
    }

    const groups: InvestmentReportGroup[] = [];
    for (const [key, bucket] of buckets) {
      const sorted = this.sortHoldings(
        bucket.holdings,
        config.sortColumn,
        config.sortDirection,
      );
      const rows: InvestmentReportRow[] = sorted.map((h) => ({
        id: `${h.accountId}:${h.securityId}`,
        currency: h.currencyCode,
        baseExchangeRate: h.exchangeRate,
        values: this.pickColumns(h.values, columns),
      }));
      groups.push({ key, label: bucket.label, rows });
    }

    // Order groups alphabetically by label (single group when NONE).
    groups.sort((a, b) => a.label.localeCompare(b.label));
    return groups;
  }

  private groupKey(
    h: ComputedHolding,
    groupBy: InvestmentGroupBy,
  ): { key: string; label: string } {
    switch (groupBy) {
      case InvestmentGroupBy.ACCOUNT:
        return { key: h.accountId, label: h.accountName };
      case InvestmentGroupBy.SYMBOL:
        return { key: h.securityId, label: h.symbol };
      case InvestmentGroupBy.CURRENCY:
        return { key: h.currencyCode, label: h.currencyCode };
      default:
        return { key: "all", label: "" };
    }
  }

  private pickColumns(
    values: Record<string, InvestmentCellValue>,
    columns: string[],
  ): Record<string, InvestmentCellValue> {
    const picked: Record<string, InvestmentCellValue> = {};
    for (const col of columns) {
      picked[col] = values[col] ?? null;
    }
    return picked;
  }

  private sortHoldings(
    holdings: ComputedHolding[],
    sortColumn: string | null,
    direction: InvestmentSortDirection,
  ): ComputedHolding[] {
    const column = sortColumn ?? ALWAYS_INCLUDED_COLUMN;
    const sign = direction === InvestmentSortDirection.DESC ? -1 : 1;
    return [...holdings].sort((a, b) => {
      const av = a.values[column];
      const bv = b.values[column];
      // Nulls always sort last, independent of the chosen direction.
      if (av === null && bv === null) return 0;
      if (av === null) return 1;
      if (bv === null) return -1;
      return sign * compareNonNull(av, bv);
    });
  }
}

/** Compare two non-null cell values (numbers numerically, otherwise as text). */
function compareNonNull(
  a: Exclude<InvestmentCellValue, null>,
  b: Exclude<InvestmentCellValue, null>,
): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a).localeCompare(String(b));
}
