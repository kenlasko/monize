import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from "@nestjs/common";
import { categoryTypeOfOrUndefined } from "../categories/category-type.util";
import { tr } from "../i18n/translate";
import { Brackets, DataSource, Repository } from "typeorm";
import { withScopedDb } from "../common/db/scoped-db";
import {
  brokerageExclusionForEntity,
  investmentLinkedTransactionExclusion,
  ordinarySplitLines,
} from "../common/investment-filter.util";
import {
  applyParsedSearch,
  applyTransactionSearch,
  resolveTransactionSearch,
  searchNarrows,
} from "../transactions/apply-transaction-search";
import { uncategorizedSql } from "../transactions/transaction-search.util";
import { ParsedSearch } from "../transactions/transaction-search-query.util";
import {
  createNetCells,
  isSignedMoney,
  netLinesOf,
  shareDenominator,
  type NetGroup,
} from "./report-net-cells";
import {
  convertAtTransferAmounts,
  transferCounterpartOf,
} from "./transfer-counterpart";
import {
  CustomReport,
  TimeframeType,
  GroupByType,
  MetricType,
  DirectionFilter,
  ReportConfig,
  ReportCategoryType,
  ReportFilters,
  TableColumn,
  SortDirection,
  TransferMeasure,
} from "./entities/custom-report.entity";
import { aggregationConfig, resolveReportConfig } from "./report-config";
import { Transaction } from "../transactions/entities/transaction.entity";
import { TransactionSplit } from "../transactions/entities/transaction-split.entity";
import { Category } from "../categories/entities/category.entity";
import { Payee } from "../payees/entities/payee.entity";
import { Tag } from "../tags/entities/tag.entity";
import { CreateCustomReportDto } from "./dto/create-custom-report.dto";
import { UpdateCustomReportDto } from "./dto/update-custom-report.dto";
import {
  AggregatedDataPoint,
  ExecuteReportDto,
  ReportResult,
  ReportSummary,
} from "./dto/execute-report.dto";
import { reportFigure, reportFigureOrNull } from "../common/report-figure";
import { FxAggregate, shareOf } from "../common/fx-aggregate";
import {
  mergedSum,
  metricValue,
  ReportRow,
  sumOf,
  summarizeRows,
} from "./report-rows";
import {
  ConversionGaps,
  ReportCurrencyService,
  transactionRateBasis,
} from "../built-in-reports/report-currency.service";
import { transferPayeeLabel } from "../transactions/transfer-payee-label.util";
import { applyRegisterOrder } from "../transactions/register-order";
import { BudgetsService } from "../budgets/budgets.service";
import { BudgetType } from "../budgets/entities/budget.entity";
import { LOAN_PERIODS_PER_YEAR } from "../accounts/payment-frequency.util";
import { ActionHistoryService } from "../action-history/action-history.service";
import {
  subDays,
  subMonths,
  subYears,
  startOfYear,
  endOfYear,
  startOfMonth,
  endOfMonth,
  startOfWeek,
  startOfDay,
  format,
  parseISO,
} from "date-fns";

/** Rows one execution reads; past it the report is truncated, never complete. */
const REPORT_ROW_LIMIT = 50000;

/**
 * The one conversion door of a single report execution: the reporting currency
 * and the rate history the rows need are resolved once, and every row is
 * converted through {@link RowConverter.convert} at its own rate, or the market
 * rate on its own date (issue #2106), which records a row it cannot convert
 * instead of letting it join a sum in its own units (INV-FX-001). A transfer
 * leg whose other side posted in the reporting currency converts at the two
 * amounts the transfer moved (`transfer-counterpart.ts`, discussion #2139).
 */
interface RowConverter {
  readonly currency: string;
  /**
   * The places every money figure of the report leaves at, the reporting
   * currency's own (`ReportCurrencyService.getReportPlaces`): each is rounded
   * once there (docs/specs/report-rounding-and-aggregation.md section 6).
   */
  readonly places: number;
  readonly gaps: ConversionGaps;
  /**
   * The provisional transfer legs (`amountIsProvisional`) whose converted
   * amounts are inside the report's figures, by id: a row with no rate is in
   * none of them, so it is not here (design section 8).
   */
  readonly provisionalRows: Set<string>;
  /**
   * `amount` of `row`, or of its `split` line when given, in the reporting
   * currency; `null` when it has no rate into it on its date.
   */
  convert(
    amount: number,
    row: Transaction,
    split?: TransactionSplit,
  ): number | null;
}

interface ReportGroups {
  rows: ReportRow[];
  /** When tag groups overlap, the signed headline counts the population once. */
  uniquePopulation?: NetGroup;
}

/**
 * The window as a fraction of calendar months: for each month it touches, the
 * days inside the window over that month's days (1-10 of a 30-day month is
 * 1/3). A rounded month count compared ten days of actuals to a full month's
 * budget and 45 days to one month.
 */
export function windowMonthFraction(
  startDate: string,
  endDate: string,
): number {
  const [startYear, startMonth, startDay] = startDate.split("-").map(Number);
  const [endYear, endMonth, endDay] = endDate.split("-").map(Number);
  let fraction = 0;
  for (
    let year = startYear, month = startMonth;
    year < endYear || (year === endYear && month <= endMonth);
    month === 12 ? ((month = 1), year++) : month++
  ) {
    const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
    const first = year === startYear && month === startMonth ? startDay : 1;
    const last = year === endYear && month === endMonth ? endDay : daysInMonth;
    fraction += (last - first + 1) / daysInMonth;
  }
  return fraction;
}

/** Rows by their figure, largest first (every grouped row has one). */
function byValueDescending(rows: ReportRow[]): ReportRow[] {
  return rows.sort((a, b) => (b.point.value ?? 0) - (a.point.value ?? 0));
}

@Injectable()
export class ReportsService {
  constructor(
    private dataSource: DataSource,
    private budgetsService: BudgetsService,
    private actionHistoryService: ActionHistoryService,
    private currencyService: ReportCurrencyService,
  ) {}

  private async createConverter(
    userId: string,
    transactions: readonly Transaction[],
  ): Promise<RowConverter> {
    const currency = await this.currencyService.getDefaultCurrency(userId);
    const places = await this.currencyService.getReportPlaces(currency);
    const atTransferAmounts = (
      amount: number,
      row: Transaction,
      split?: TransactionSplit,
    ): number | null =>
      convertAtTransferAmounts(
        amount,
        {
          amount: Number(split ? split.amount : row.amount),
          currencyCode: row.currencyCode,
        },
        transferCounterpartOf(row, split),
        currency,
      );
    // A row whose every line converts at its transfer's own amounts needs no
    // rate history, so it does not widen the span the index loads.
    const needsMarketRate = (tx: Transaction): boolean =>
      tx.isSplit && tx.splits && tx.splits.length > 0
        ? tx.splits.some(
            (split) =>
              atTransferAmounts(Number(split.amount), tx, split) === null,
          )
        : atTransferAmounts(Number(tx.amount), tx) === null;
    const convertRow = await this.currencyService.buildConverter(
      transactions
        .filter(needsMarketRate)
        .map((tx) => transactionRateBasis(tx, currency)),
      currency,
    );
    const gaps = new ConversionGaps();
    return {
      currency,
      places,
      gaps,
      provisionalRows: new Set<string>(),
      convert: (amount, row, split) => {
        // Zero converts to zero at any rate, so an empty row records no gap.
        if (amount === 0) return 0;
        const converted =
          atTransferAmounts(amount, row, split) ??
          convertRow(amount, transactionRateBasis(row, currency));
        if (converted === null) gaps.record(row.currencyCode);
        return converted;
      },
    };
  }

  /**
   * Whether a row that could not be converted still belongs in a group. A count
   * needs no rate, so the count metric keeps every row; every money figure
   * leaves the row out of the group's sum and its row count alike.
   */
  private keepsUnconverted(metric: MetricType): boolean {
    return metric === MetricType.COUNT;
  }

  /**
   * Counts a row (or split line) that converted but was left out with a part
   * that holds one with no rate (issue #2130), once however many groups it
   * sits in, so `excludedCount` is every row the figures leave out.
   */
  private leftOutWithItsPart(
    conv: RowConverter,
  ): (currency: string, unit: string) => void {
    return (currency, unit) => conv.gaps.record(currency, `left-out:${unit}`);
  }

  /** Records a provisional row whose amount a kept group summed. */
  private inAFigure(conv: RowConverter): (row: string) => void {
    return (row) => conv.provisionalRows.add(row);
  }

  /**
   * How many provisional amounts the report's figures hold (design section 6,
   * P5). A count metric sums no amount, so an estimate is in none of its
   * figures; every other metric, a transaction list included, counts each
   * provisional row whose amount converted into a figure once.
   */
  private provisionalCount(conv: RowConverter, metric: MetricType): number {
    return metric === MetricType.COUNT ? 0 : conv.provisionalRows.size;
  }

  async create(
    userId: string,
    dto: CreateCustomReportDto,
  ): Promise<CustomReport> {
    this.validateCustomTimeframe(dto.timeframeType, dto.config);
    this.validateTransferMeasure(dto.config);

    const saved = await withScopedDb(this.dataSource, (m) => {
      const repo = m.getRepository(CustomReport);
      // Use the stored layout default for API callers that omit groupBy.
      const groupBy = dto.groupBy ?? GroupByType.CATEGORY;
      const report = repo.create({
        ...dto,
        userId,
        groupBy,
        config: resolveReportConfig(groupBy, dto.config),
        filters: dto.filters || {},
      });
      return repo.save(report);
    });

    this.actionHistoryService.record(userId, {
      entityType: "custom_report",
      entityId: saved.id,
      action: "create",
      afterData: { ...saved },
      description: `Created report "${saved.name}"`,
      descriptionKey: "createdReport",
      descriptionParams: { name: saved.name },
    });

    return saved;
  }

  async findAll(userId: string): Promise<CustomReport[]> {
    const reports = await withScopedDb(this.dataSource, (m) =>
      m.getRepository(CustomReport).find({
        where: { userId },
        order: { sortOrder: "ASC", createdAt: "DESC" },
      }),
    );
    return reports.map((report) => ({
      ...report,
      config: resolveReportConfig(report.groupBy, report.config),
    }));
  }

  async findOne(userId: string, id: string): Promise<CustomReport> {
    const report = await withScopedDb(this.dataSource, (m) =>
      m.getRepository(CustomReport).findOne({
        where: { id, userId },
      }),
    );

    if (!report) {
      throw new NotFoundException(
        tr("errors.reports.notFound", `Report with ID ${id} not found`, { id }),
      );
    }

    return {
      ...report,
      config: resolveReportConfig(report.groupBy, report.config),
    };
  }

  async update(
    userId: string,
    id: string,
    dto: UpdateCustomReportDto,
  ): Promise<CustomReport> {
    const report = await this.findOne(userId, id);
    const beforeData = { ...report };

    // Validate custom timeframe using the effective values after merge
    const effectiveTimeframe = dto.timeframeType ?? report.timeframeType;
    const effectiveConfig = dto.config
      ? { ...report.config, ...dto.config }
      : report.config;
    this.validateCustomTimeframe(effectiveTimeframe, effectiveConfig);
    this.validateTransferMeasure(effectiveConfig);

    // SECURITY: Explicit property mapping instead of Object.assign to prevent mass assignment
    if (dto.name !== undefined) report.name = dto.name;
    if (dto.description !== undefined) report.description = dto.description;
    if (dto.icon !== undefined) report.icon = dto.icon;
    if (dto.backgroundColor !== undefined)
      report.backgroundColor = dto.backgroundColor;
    if (dto.viewType !== undefined) report.viewType = dto.viewType;
    if (dto.timeframeType !== undefined)
      report.timeframeType = dto.timeframeType;
    if (dto.groupBy !== undefined) report.groupBy = dto.groupBy;
    if (dto.isFavourite !== undefined) report.isFavourite = dto.isFavourite;
    if (dto.sortOrder !== undefined) report.sortOrder = dto.sortOrder;

    // Replace config if provided (full replacement so cleared fields take effect)
    if (dto.config) {
      report.config = resolveReportConfig(report.groupBy, {
        ...report.config,
        ...dto.config,
      });
    }

    // Replace filters if provided (full replacement so cleared filters take effect)
    if (dto.filters) {
      report.filters = dto.filters as ReportFilters;
    }

    const saved = await withScopedDb(this.dataSource, (m) =>
      m.getRepository(CustomReport).save(report),
    );

    this.actionHistoryService.record(userId, {
      entityType: "custom_report",
      entityId: id,
      action: "update",
      beforeData,
      afterData: { ...saved },
      description: `Updated report "${saved.name}"`,
      descriptionKey: "updatedReport",
      descriptionParams: { name: saved.name },
    });

    return saved;
  }

  async remove(userId: string, id: string): Promise<void> {
    const report = await this.findOne(userId, id);
    const beforeData = { ...report };
    await withScopedDb(this.dataSource, (m) =>
      m.getRepository(CustomReport).remove(report),
    );

    this.actionHistoryService.record(userId, {
      entityType: "custom_report",
      entityId: beforeData.id,
      action: "delete",
      beforeData,
      description: `Deleted report "${beforeData.name}"`,
      descriptionKey: "deletedReport",
      descriptionParams: { name: beforeData.name },
    });
  }

  async execute(
    userId: string,
    id: string,
    overrides?: ExecuteReportDto,
  ): Promise<ReportResult> {
    const stored = await this.findOne(userId, id);
    this.validateTransferMeasure(stored.config);
    // Under a transfer measure the aggregation reads legs only, the measure in
    // the direction's place (`aggregationConfig`); the SQL reads the measure
    // itself. Without one this is the stored configuration.
    const report = {
      ...stored,
      config: aggregationConfig(stored.groupBy, stored.config),
    };

    // Use override timeframe if provided, otherwise use saved report timeframe
    const effectiveTimeframe = overrides?.timeframeType || report.timeframeType;

    // Calculate date range
    const {
      startDate,
      endDate,
      label: timeframeLabel,
    } = this.getDateRange(
      effectiveTimeframe,
      overrides?.startDate || report.config.customStartDate,
      overrides?.endDate || report.config.customEndDate,
    );

    // Query transactions with filters
    const { transactions: selected, truncated } =
      await this.getFilteredTransactions(
        userId,
        startDate,
        endDate,
        report.filters,
        report.config,
      );
    // A split parent reached the aggregators whatever its own sign, so its lines
    // are narrowed here, where each line's own amount and kind are readable.
    const transactions = this.narrowSplitLines(selected, report.config);

    // Only fetch category/payee maps when the report groups by them (avoid over-fetching)
    const categoryMap = new Map<string, Category>();
    const payeeMap = new Map<string, Payee>();

    if (report.groupBy === GroupByType.CATEGORY) {
      const categories = await withScopedDb(this.dataSource, (m) =>
        m.getRepository(Category).find({
          where: { userId },
        }),
      );
      for (const c of categories) categoryMap.set(c.id, c);
    } else if (report.groupBy === GroupByType.PAYEE) {
      const payees = await withScopedDb(this.dataSource, (m) =>
        m.getRepository(Payee).find({ where: { userId } }),
      );
      for (const p of payees) payeeMap.set(p.id, p);
    }

    const converter = await this.createConverter(userId, transactions);

    const groups: ReportGroups =
      report.groupBy === GroupByType.TAG
        ? this.aggregateByTag(transactions, report.config, converter)
        : {
            rows: this.aggregateDisjointGroups(
              transactions,
              report.groupBy,
              report.config,
              categoryMap,
              payeeMap,
              converter,
            ),
          };
    let rows = groups.rows;
    // For BUDGET_VARIANCE metric with CATEGORY grouping, enrich with budget data
    if (
      report.config.metric === MetricType.BUDGET_VARIANCE &&
      report.groupBy === GroupByType.CATEGORY
    ) {
      rows = await this.enrichWithBudgetVariance(
        userId,
        rows,
        startDate,
        endDate,
        categoryMap,
        converter,
        report,
      );
    }

    const signedMeasure =
      !(
        report.groupBy === GroupByType.NONE &&
        report.config.metric === MetricType.NONE
      ) && isSignedMoney(report.config.direction, report.config.metric);

    // Apply custom sorting if configured
    if (report.config.sortBy) {
      // A saved percentage sort keeps its direction after signed totals stop
      // exposing shares. Rank by the monetary value those shares used to order.
      const sortBy =
        report.config.sortBy === TableColumn.PERCENTAGE && signedMeasure
          ? TableColumn.VALUE
          : report.config.sortBy;
      rows = this.sortData(
        rows,
        sortBy,
        report.config.sortDirection || SortDirection.DESC,
      );
    }

    // Calculate summary
    const summary = this.calculateSummary(
      rows,
      converter,
      report.config.metric,
      truncated,
      groups.uniquePopulation,
    );
    const data = rows.map((row) => row.point);

    return {
      reportId: report.id,
      ...(signedMeasure ? { signedTotal: true as const } : {}),
      name: report.name,
      viewType: report.viewType,
      groupBy: report.groupBy,
      timeframe: {
        startDate,
        endDate,
        label: timeframeLabel,
      },
      data,
      summary,
      currency: converter.currency,
      missingCurrencies: converter.gaps.missingCurrencies,
      excludedCount: converter.gaps.excludedCount,
      provisionalCount: summary.provisionalCount,
      truncated,
      tableColumns: report.config.tableColumns,
    };
  }

  /**
   * A transfer measure reads transfer legs, which no budget plans: a budget
   * variance under one is refused (docs/specs/transfer-categories.md section
   * 8.2).
   */
  private validateTransferMeasure(config?: Partial<ReportConfig> | null): void {
    if (
      config?.transferMeasure &&
      config.metric === MetricType.BUDGET_VARIANCE
    ) {
      throw new BadRequestException(
        tr(
          "errors.reports.transferMeasureBudgetVariance",
          "A transfer measure cannot be combined with a budget variance",
        ),
      );
    }
  }

  private validateCustomTimeframe(
    timeframeType?: TimeframeType,
    config?: Partial<ReportConfig>,
  ): void {
    if (timeframeType !== TimeframeType.CUSTOM) {
      return;
    }
    if (!config?.customStartDate || !config?.customEndDate) {
      throw new BadRequestException(
        tr(
          "errors.reports.customTimeframeMissingDates",
          "Custom timeframe requires both start and end dates",
        ),
      );
    }
  }

  private getDateRange(
    timeframeType: TimeframeType,
    customStart?: string,
    customEnd?: string,
  ): { startDate: string; endDate: string; label: string } {
    const today = new Date();
    const endDate = format(today, "yyyy-MM-dd");
    let startDate: string;
    let label: string;

    switch (timeframeType) {
      case TimeframeType.LAST_7_DAYS:
        startDate = format(subDays(today, 7), "yyyy-MM-dd");
        label = "Last 7 Days";
        break;
      case TimeframeType.LAST_30_DAYS:
        startDate = format(subDays(today, 30), "yyyy-MM-dd");
        label = "Last 30 Days";
        break;
      case TimeframeType.LAST_MONTH: {
        const lastMonth = subMonths(today, 1);
        startDate = format(startOfMonth(lastMonth), "yyyy-MM-dd");
        const lastMonthEnd = format(endOfMonth(lastMonth), "yyyy-MM-dd");
        label = format(lastMonth, "MMMM yyyy");
        return { startDate, endDate: lastMonthEnd, label };
      }
      case TimeframeType.LAST_3_MONTHS:
        startDate = format(subMonths(today, 3), "yyyy-MM-dd");
        label = "Last 3 Months";
        break;
      case TimeframeType.LAST_6_MONTHS:
        startDate = format(subMonths(today, 6), "yyyy-MM-dd");
        label = "Last 6 Months";
        break;
      case TimeframeType.LAST_12_MONTHS:
        startDate = format(subMonths(today, 12), "yyyy-MM-dd");
        label = "Last 12 Months";
        break;
      case TimeframeType.LAST_YEAR: {
        const lastYear = subYears(today, 1);
        startDate = format(startOfYear(lastYear), "yyyy-MM-dd");
        const lastYearEnd = format(endOfYear(lastYear), "yyyy-MM-dd");
        label = format(lastYear, "yyyy");
        return { startDate, endDate: lastYearEnd, label };
      }
      case TimeframeType.YEAR_TO_DATE:
        startDate = format(startOfYear(today), "yyyy-MM-dd");
        label = "Year to Date";
        break;
      case TimeframeType.CUSTOM:
        if (!customStart || !customEnd) {
          throw new BadRequestException(
            tr(
              "errors.reports.customTimeframeMissingDates",
              "Custom timeframe requires both start and end dates",
            ),
          );
        }
        startDate = customStart;
        label = "Custom Range";
        return { startDate, endDate: customEnd, label };
      default:
        startDate = format(subMonths(today, 3), "yyyy-MM-dd");
        label = "Last 3 Months";
    }

    return { startDate, endDate, label };
  }

  /**
   * Narrows each split parent to the lines this report asked for, and drops a
   * parent left with none.
   *
   * Two decisions the SQL could only make about the PARENT, and a split parent
   * is not its lines:
   *
   * - **Direction** (the NONE metric's list of transactions only; every other
   *   metric nets both signs, see `report-net-cells.ts`). `transaction.amount`
   *   is the sum of every line, so its sign is nobody's direction: a -60
   *   expense beside a +500 embedded SELL is a +440 parent (audit
   *   F-CUSTOM-DIR-001).
   * - **Transfers.** `transaction.isTransfer` is false on a split parent that
   *   carries a transfer LINE, so `includeTransfers: false` counted a -200
   *   transfer inside a -260 parent as 260 of spending.
   *
   * Both are the user's own configuration, applied to the representation the
   * decision belongs to -- which is what the built-in split-row-granular reports
   * have always done with the same rows. Investment provenance is NOT decided
   * here: the aggregators ask `ordinarySplitLines` for that, because it is a
   * property of the data rather than of the report.
   */
  private narrowSplitLines(
    transactions: Transaction[],
    config: ReportConfig,
  ): Transaction[] {
    // A transfer measure reads a split's transfer lines only (the query
    // selected them; this holds the parent to them whatever it hydrated).
    if (config.transferMeasure) {
      return transactions.flatMap((tx) => {
        if (!tx.isSplit || !tx.splits || tx.splits.length === 0) return [tx];
        const lines = tx.splits.filter(
          (split) => split.transferAccountId != null,
        );
        return lines.length === 0
          ? []
          : [{ ...tx, splits: lines } as Transaction];
      });
    }
    // The query selects direction and category on the joined posting. Transfer
    // splits still require their own eligibility check before aggregation.
    if (config.includeTransfers) return transactions;

    return transactions.flatMap((tx) => {
      if (!tx.isSplit || !tx.splits || tx.splits.length === 0) return [tx];

      const splits = tx.splits.filter(
        (split) => split.transferAccountId == null,
      );
      if (splits.length === 0) return [];

      // A shallow copy: the entity is not re-saved, and the aggregators read
      // only `splits` plus the parent's own scalar fields.
      return [{ ...tx, splits } as Transaction];
    });
  }

  /**
   * The accounts this report explicitly names.
   *
   * Not "does the report restrict itself to accounts": a boolean cannot express
   * a mixed OR group, and both of its answers are wrong for one shape.
   * Conditions WITHIN a group are OR'd, groups are AND'ed, so
   * `[account = Brokerage, category = Salary]` explicitly asks for Brokerage
   * rows while `[account = Chequing, payee = Acme]` asks for none -- and a single
   * boolean that admits the first also admits the second (or refuses both).
   * The ids let the caller ask the question per row instead.
   *
   * Advanced filter groups REPLACE the legacy filters in
   * `getFilteredTransactions`, so a report holding groups and a stale
   * `accountIds` names nothing; and a condition carrying no values (what the
   * filter builder saves for a half-finished one) adds no SQL, so it names
   * nothing either.
   */
  private explicitAccountIds(filters: CustomReport["filters"]): string[] {
    const groups = filters.filterGroups ?? [];
    const named =
      groups.length > 0
        ? groups.flatMap((group) =>
            (group.conditions ?? [])
              .filter((condition) => condition.field === "account")
              .flatMap((condition) =>
                Array.isArray(condition.value)
                  ? condition.value.filter(Boolean)
                  : condition.value
                    ? [condition.value]
                    : [],
              ),
          )
        : (filters.accountIds ?? []);
    return [...new Set(named)];
  }

  private async getFilteredTransactions(
    userId: string,
    startDate: string,
    endDate: string,
    filters: CustomReport["filters"],
    config: ReportConfig,
  ): Promise<{ transactions: Transaction[]; truncated: boolean }> {
    return withScopedDb(this.dataSource, async (m) => {
      const queryBuilder = m
        .getRepository(Transaction)
        .createQueryBuilder("transaction")
        .leftJoinAndSelect("transaction.account", "account")
        .leftJoinAndSelect("transaction.category", "category")
        .leftJoinAndSelect("category.parent", "categoryParent")
        .leftJoinAndSelect("transaction.payee", "payee")
        .leftJoinAndSelect("transaction.tags", "tags")
        .leftJoinAndSelect("transaction.splits", "splits")
        // Hydrated so an embedded investment line is recognisable by BOTH of its
        // representations, exactly as the raw-SQL reports recognise it.
        .leftJoinAndSelect("splits.investmentTransaction", "splitInvestmentTx")
        .leftJoinAndSelect("splits.category", "splitCategory")
        .leftJoinAndSelect("splitCategory.parent", "splitCategoryParent")
        .leftJoinAndSelect("splits.tags", "splitTags")
        // For a blank-payee transfer the row label resolves from the
        // counterpart account (issue #1214). Restricted to same-owner legs in
        // SQL: reports have no delegation mask, and an unrestricted join
        // would leak a cross-owner counterpart's live account name after
        // unshare. A cross-owner transfer simply falls back to its
        // description here.
        .leftJoinAndSelect(
          "transaction.linkedTransaction",
          "linkedTransaction",
          "linkedTransaction.userId = transaction.userId",
        )
        .leftJoinAndSelect("linkedTransaction.account", "linkedAccount")
        // A transfer leg in a foreign currency converts at the amounts its
        // transfer moved (discussion #2139), read off the other side whether
        // or not the filters keep it: the parent's line that links back to a
        // split transfer's counterpart, and a split line's own counterpart,
        // both restricted to the reader's ledger like the join above. Context
        // for the conversion only, never a row of the report, so only the
        // columns `transferCounterpartOf` reads are selected: this query
        // already multiplies tags by splits by split tags, and a whole
        // transaction hydrated per joined row is weight the report never reads.
        .leftJoin(
          "linkedTransaction.splits",
          "linkedSplits",
          "linkedSplits.linkedTransactionId = transaction.id",
        )
        .addSelect([
          "linkedSplits.id",
          "linkedSplits.amount",
          "linkedSplits.linkedTransactionId",
          "linkedSplits.transferAccountId",
        ])
        .leftJoin(
          "splits.linkedTransaction",
          "splitLinkedTransaction",
          "splitLinkedTransaction.userId = transaction.userId",
        )
        .addSelect([
          "splitLinkedTransaction.id",
          "splitLinkedTransaction.amount",
          "splitLinkedTransaction.currencyCode",
          "splitLinkedTransaction.linkedTransactionId",
          "splitLinkedTransaction.amountIsProvisional",
        ])
        .where("transaction.userId = :userId", { userId })
        .andWhere("transaction.transactionDate >= :startDate", { startDate })
        .andWhere("transaction.transactionDate <= :endDate", { endDate })
        .andWhere("transaction.status != 'VOID'");

      // INV-REPORT-001: a custom report reads the same ledger as the built-in
      // ones, so it owes the same answer. The cash leg a free-standing trade
      // generated is never ordinary cash -- including when an explicit funding
      // account put that leg in an ordinary account, where no account-type
      // predicate could see it.
      queryBuilder.andWhere(
        investmentLinkedTransactionExclusion("transaction"),
      );
      // The securities sleeve is noise in a whole-ledger figure -- built-in
      // reports have no account picker, so they always drop it -- but here the
      // user may have named that very account, and answering an explicitly
      // scoped report with nothing is worse than showing the rows they asked to
      // see. The exception is per ROW, not per report: a filter group reading
      // `account = Brokerage OR category = Salary` names Brokerage, while
      // `account = Chequing OR payee = Acme` does not name it, and a
      // whole-report boolean cannot tell those apart (audit F-CUSTOM-OR-001).
      const explicitAccountIds = this.explicitAccountIds(filters);
      if (explicitAccountIds.length === 0) {
        queryBuilder.andWhere(brokerageExclusionForEntity("account"));
      } else {
        queryBuilder.andWhere(
          new Brackets((scope) => {
            scope
              .where(brokerageExclusionForEntity("account"))
              .orWhere(
                "transaction.accountId IN (:...explicitReportAccountIds)",
                { explicitReportAccountIds: explicitAccountIds },
              );
          }),
        );
      }
      // The embedded-investment half cannot be expressed here at all: the parent
      // is a real row carrying real ordinary cash beside the investment line, so
      // it is classified per line during aggregation.

      // Advanced filter groups take precedence over legacy filters
      if (filters.filterGroups && filters.filterGroups.length > 0) {
        // Resolved once per text condition, in the user's number and date
        // formats, so the Brackets below stay synchronous.
        const textSearches = new Map<string, ParsedSearch | undefined>();
        for (const [gi, group] of filters.filterGroups.entries()) {
          for (const [ci, condition] of (group.conditions ?? []).entries()) {
            if (condition.field !== "text") continue;
            const raw = Array.isArray(condition.value)
              ? condition.value[0] || ""
              : condition.value;
            textSearches.set(
              `${gi}:${ci}`,
              await resolveTransactionSearch(m, userId, raw),
            );
          }
        }
        this.applyFilterGroups(
          queryBuilder,
          filters.filterGroups,
          textSearches,
        );
      } else {
        // Legacy simple filters (backward compat)
        if (filters.accountIds && filters.accountIds.length > 0) {
          queryBuilder.andWhere("transaction.accountId IN (:...accountIds)", {
            accountIds: filters.accountIds,
          });
        }

        if (filters.categoryIds && filters.categoryIds.length > 0) {
          queryBuilder.andWhere(
            "(transaction.categoryId IN (:...categoryIds) OR splits.categoryId IN (:...categoryIds))",
            { categoryIds: filters.categoryIds },
          );
        }

        if (filters.payeeIds && filters.payeeIds.length > 0) {
          queryBuilder.andWhere("transaction.payeeId IN (:...payeeIds)", {
            payeeIds: filters.payeeIds,
          });
        }

        // INV-SEARCH-001 (audit A26-L12): the one search door, so `%` and `_`
        // are literals and the report reads the string as the register does.
        await applyTransactionSearch(m, queryBuilder, filters.searchText, {
          userId,
          transaction: "transaction",
          splits: "splits",
          grain: "split",
          paramPrefix: "rsrch",
        });
      }

      // Select the posting that supplies the amount. A split parent can carry
      // both directions and both category types in the same transaction.
      const amount =
        "CASE WHEN transaction.isSplit THEN splits.amount ELSE transaction.amount END";
      const measure = config.transferMeasure;
      if (measure) {
        // Transfer legs only, whatever category they hold: a whole leg or a
        // split's transfer line (INV-REPORT-006). The measure, not the
        // direction, picks the sign, and Include transfers does not apply
        // (docs/specs/transfer-categories.md section 8.2).
        queryBuilder.andWhere(
          "(transaction.isTransfer = true OR splits.transferAccountId IS NOT NULL)",
        );
        if (measure === TransferMeasure.OUTGOING)
          queryBuilder.andWhere(`${amount} < 0`);
        if (measure === TransferMeasure.INCOMING)
          queryBuilder.andWhere(`${amount} > 0`);
      }
      if (!measure && config.direction === DirectionFilter.INCOMING)
        queryBuilder.andWhere(`${amount} > 0`);
      if (!measure && config.direction === DirectionFilter.OUTGOING)
        queryBuilder.andWhere(`${amount} < 0`);
      const categoryType = measure ? undefined : config.categoryType;
      if (
        categoryType === ReportCategoryType.INCOME ||
        categoryType === ReportCategoryType.EXPENSE
      ) {
        queryBuilder.andWhere(
          "CASE WHEN transaction.isSplit THEN splitCategory.categoryType ELSE category.categoryType END = :reportCategoryType",
          {
            reportCategoryType:
              categoryType === ReportCategoryType.INCOME ? "income" : "expense",
          },
        );
      } else if (categoryType === ReportCategoryType.UNCATEGORIZED) {
        queryBuilder.andWhere(
          uncategorizedSql({
            transaction: "transaction",
            splits: "splits",
            grain: "split",
          }),
        );
      }

      // Filter transfers
      if (!measure && !config.includeTransfers) {
        queryBuilder.andWhere("transaction.isTransfer = false");
      }

      // M29: Limit result set to prevent unbounded memory consumption. One row
      // past the limit proves rows were dropped (the newest, by the order), so
      // the report says it is truncated instead of presenting a short total.
      // The register's order, so same-day rows of a list read as they do in
      // the register and the cut at the limit is the same on every run.
      const rows = await applyRegisterOrder(queryBuilder, "transaction", "ASC")
        .take(REPORT_ROW_LIMIT + 1)
        .getMany();
      return {
        transactions: rows.slice(0, REPORT_ROW_LIMIT),
        truncated: rows.length > REPORT_ROW_LIMIT,
      };
    });
  }

  private applyFilterGroups(
    queryBuilder: ReturnType<Repository<Transaction>["createQueryBuilder"]>,
    filterGroups: Array<{
      conditions: Array<{ field: string; value: string | string[] }>;
    }>,
    textSearches: Map<string, ParsedSearch | undefined>,
  ): void {
    for (let gi = 0; gi < filterGroups.length; gi++) {
      const group = filterGroups[gi];
      if (!group.conditions || group.conditions.length === 0) continue;

      queryBuilder.andWhere(
        new Brackets((qb) => {
          for (let ci = 0; ci < group.conditions.length; ci++) {
            const condition = group.conditions[ci];
            const param = `p_g${gi}_c${ci}`;
            const method = ci === 0 ? "where" : "orWhere";

            switch (condition.field) {
              case "account": {
                const values = Array.isArray(condition.value)
                  ? condition.value
                  : [condition.value];
                if (values.length === 1) {
                  qb[method](`transaction.accountId = :${param}`, {
                    [param]: values[0],
                  });
                } else if (values.length > 1) {
                  qb[method](`transaction.accountId IN (:...${param})`, {
                    [param]: values,
                  });
                }
                break;
              }
              case "category": {
                const values = Array.isArray(condition.value)
                  ? condition.value
                  : [condition.value];
                if (values.length === 1) {
                  qb[method](
                    new Brackets((inner) => {
                      inner
                        .where(`transaction.categoryId = :${param}`, {
                          [param]: values[0],
                        })
                        .orWhere(`splits.categoryId = :${param}`, {
                          [param]: values[0],
                        });
                    }),
                  );
                } else if (values.length > 1) {
                  qb[method](
                    new Brackets((inner) => {
                      inner
                        .where(`transaction.categoryId IN (:...${param})`, {
                          [param]: values,
                        })
                        .orWhere(`splits.categoryId IN (:...${param})`, {
                          [param]: values,
                        });
                    }),
                  );
                }
                break;
              }
              case "payee": {
                const values = Array.isArray(condition.value)
                  ? condition.value
                  : [condition.value];
                if (values.length === 1) {
                  qb[method](`transaction.payeeId = :${param}`, {
                    [param]: values[0],
                  });
                } else if (values.length > 1) {
                  qb[method](`transaction.payeeId IN (:...${param})`, {
                    [param]: values,
                  });
                }
                break;
              }
              case "tag": {
                const values = Array.isArray(condition.value)
                  ? condition.value
                  : [condition.value];
                if (values.length === 1) {
                  qb[method](
                    new Brackets((inner) => {
                      inner
                        .where(`tags.id = :${param}`, {
                          [param]: values[0],
                        })
                        .orWhere(`splitTags.id = :${param}`, {
                          [param]: values[0],
                        });
                    }),
                  );
                } else if (values.length > 1) {
                  qb[method](
                    new Brackets((inner) => {
                      inner
                        .where(`tags.id IN (:...${param})`, {
                          [param]: values,
                        })
                        .orWhere(`splitTags.id IN (:...${param})`, {
                          [param]: values,
                        });
                    }),
                  );
                }
                break;
              }
              case "text": {
                // Through the search door (audit A26-L12). A blank value, or one
                // holding only empty terms, adds no condition: an empty
                // Brackets would render `()`.
                const parsed = textSearches.get(`${gi}:${ci}`);
                if (!searchNarrows(parsed)) break;
                qb[method](
                  new Brackets((inner) =>
                    applyParsedSearch(inner, parsed, {
                      transaction: "transaction",
                      splits: "splits",
                      grain: "split",
                      paramPrefix: `rsrch_g${gi}_c${ci}_`,
                    }),
                  ),
                );
                break;
              }
            }
          }
        }),
      );
    }
  }

  private aggregateDisjointGroups(
    transactions: Transaction[],
    groupBy: Exclude<GroupByType, GroupByType.TAG>,
    config: ReportConfig,
    categoryMap: Map<string, Category>,
    payeeMap: Map<string, Payee>,
    conv: RowConverter,
  ): ReportRow[] {
    const metric = config.metric;
    switch (groupBy) {
      case GroupByType.NONE:
        return this.aggregateNoGrouping(transactions, metric, config, conv);
      case GroupByType.CATEGORY:
        return this.aggregateByCategory(
          transactions,
          metric,
          config,
          categoryMap,
          conv,
        );
      case GroupByType.PAYEE:
        return this.aggregateByPayee(
          transactions,
          metric,
          config,
          payeeMap,
          conv,
        );
      case GroupByType.YEAR:
        return this.aggregateByTime(transactions, metric, config, "year", conv);
      case GroupByType.MONTH:
        return this.aggregateByTime(
          transactions,
          metric,
          config,
          "month",
          conv,
        );
      case GroupByType.WEEK:
        return this.aggregateByTime(transactions, metric, config, "week", conv);
      case GroupByType.DAY:
        return this.aggregateByTime(transactions, metric, config, "day", conv);
      default:
        return this.aggregateNoGrouping(transactions, metric, config, conv);
    }
  }

  /**
   * A group's figure. Under a transfer measure a group a part was left out of
   * for want of a rate says so (`incomplete`): a net missing a side is never
   * shown as the net, so its value is withheld and its known part named, and
   * a group none of whose parts converted is unknown under every measure
   * (docs/specs/transfer-categories.md section 10, INV-DISPLAY-002).
   */
  private groupFigure(
    data: NetGroup,
    metric: MetricType,
    conv: RowConverter,
    config: ReportConfig,
  ): Pick<AggregatedDataPoint, "value" | "incomplete" | "knownValue"> {
    const value = metricValue(data.agg, data.count, metric, conv.places);
    if (!config.transferMeasure || !data.incomplete) return { value };
    const withheld =
      data.known === false ||
      (config.transferMeasure === TransferMeasure.NET &&
        metric !== MetricType.COUNT);
    // A group none of whose parts converted has no known part to name: an
    // empty aggregate's 0 is not one.
    if (data.known === false) return { value: null, incomplete: true };
    return withheld
      ? { value: null, knownValue: value, incomplete: true }
      : { value, incomplete: true };
  }

  private formatCategoryLabel(
    category: Category | null | undefined,
  ): string | undefined {
    if (!category) return undefined;
    if (category.parent) return `${category.parent.name}: ${category.name}`;
    return category.name;
  }

  // A split line sits under its own tags plus the parent's, the same merge
  // `aggregateByTag` applies when it groups lines by tag.
  private formatLineTags(
    tx: Transaction,
    splitTags?: Tag[],
  ): string | undefined {
    const tags = [...(tx.tags || [])];
    for (const tag of splitTags ?? []) {
      if (!tags.some((t) => t.id === tag.id)) tags.push(tag);
    }
    if (tags.length === 0) return undefined;
    return tags.map((tag) => tag.name).join(", ");
  }

  private aggregateNoGrouping(
    transactions: Transaction[],
    metric: MetricType,
    config: ReportConfig,
    conv: RowConverter,
  ): ReportRow[] {
    // For NONE metric, return individual transactions as data points
    if (metric === MetricType.NONE) {
      const result: ReportRow[] = [];
      // Preserve each posting's sign in the reporting, account and original currencies.
      for (const tx of transactions) {
        // A blank-payee transfer leg reads "Transfer to/from <account>"
        // resolved from its (same-owner) linked leg, exactly as the register
        // shows it (issue #1214). Only that fallback is new: a stored payee
        // (or, for the label, the description) still wins as before.
        const transferLabel =
          !tx.payeeName &&
          !tx.payee?.name &&
          tx.isTransfer &&
          tx.linkedTransaction?.account?.name
            ? transferPayeeLabel(tx.amount, tx.linkedTransaction.account.name)
            : undefined;
        if (tx.isSplit && tx.splits && tx.splits.length > 0) {
          // Only the lines that are ordinary cash: an embedded investment line
          // is the trade's own cash side, not a row of this report.
          for (const split of ordinarySplitLines(tx)) {
            const accountAmount = Number(split.amount);
            // A line with no rate stays listed, its converted value unknown,
            // so it can still be matched against a statement (issue #2342).
            const value = conv.convert(accountAmount, tx, split);
            result.push({
              // The headline folds the unrounded conversion (rule 2); the
              // row shows it rounded once, at the currency's places.
              sum: sumOf(value),
              point: {
                id: tx.id,
                label:
                  split.memo ||
                  tx.payeeName ||
                  transferLabel ||
                  tx.description ||
                  "Transaction",
                value: reportFigureOrNull(value, conv.places),
                count: 1,
                // Transaction-specific fields
                date: tx.transactionDate,
                payee: tx.payeeName || tx.payee?.name || transferLabel,
                description: tx.description || undefined,
                memo: split.memo || undefined,
                category: this.formatCategoryLabel(split.category),
                account: tx.account?.name || undefined,
                tags: this.formatLineTags(tx, split.tags),
                accountAmount,
                accountCurrency: tx.currencyCode,
              },
            });
          }
        } else {
          const accountAmount = Number(tx.amount);
          const value = conv.convert(accountAmount, tx);
          // A listed row with no rate is in no total, so not counted either.
          if (value !== null && tx.amountIsProvisional === true) {
            conv.provisionalRows.add(tx.id);
          }
          result.push({
            sum: sumOf(value),
            point: {
              id: tx.id,
              label:
                tx.payeeName ||
                transferLabel ||
                tx.description ||
                "Transaction",
              value: reportFigureOrNull(value, conv.places),
              count: 1,
              // Transaction-specific fields
              date: tx.transactionDate,
              payee: tx.payeeName || tx.payee?.name || transferLabel,
              description: tx.description || undefined,
              memo: undefined, // Transactions don't have memo, only splits do
              category: this.formatCategoryLabel(tx.category),
              account: tx.account?.name || undefined,
              tags: this.formatLineTags(tx),
              accountAmount,
              accountCurrency: tx.currencyCode,
              // Only a row entered in a foreign currency has one; it is stored
              // with the amount's sign, so it is signed as the amount is. A split
              // line has none: only the whole transaction was entered in it.
              ...(tx.originalAmount !== null &&
              tx.originalAmount !== undefined &&
              tx.originalCurrencyCode
                ? {
                    originalAmount: Number(tx.originalAmount),
                    originalCurrency: tx.originalCurrencyCode,
                  }
                : {}),
            },
          });
        }
      }

      // A one-direction list's rows are shares of their own sum, divided here
      // from the unrounded conversions: two 1.2474 rows read 1.25 each under a
      // 2.49 headline and are 50% each, never 1.25 / 2.49 (rule 8, issue
      // #2413). A signed (BOTH) list is no share of its net and gets none; a
      // row with no rate has no share, and the whole is what converted.
      if (config.direction === DirectionFilter.BOTH) return result;
      const whole = mergedSum(result);
      return result.map((row) =>
        row.sum === null
          ? row
          : {
              ...row,
              point: {
                ...row.point,
                percentage:
                  whole.sign === 0
                    ? 0
                    : (row.sum.unroundedSubtotal / whole.unroundedSubtotal) *
                      100,
              },
            },
      );
    }

    // For other metrics, aggregate into a single total
    const cells = createNetCells(
      config.direction,
      metric,
      this.leftOutWithItsPart(conv),
      this.inAFigure(conv),
      !!config.transferMeasure,
    );
    for (const tx of transactions) {
      for (const line of netLinesOf(tx, false, !!config.transferMeasure)) {
        cells.add("total", line, conv.convert(line.amount, tx, line.split));
      }
    }

    const bucket = cells.settle().get("total");
    // A transfer measure keeps a total none of whose parts converted, marked
    // incomplete, as a grouped report keeps the group (section 10).
    if (!bucket || (bucket.count === 0 && !bucket.incomplete)) return [];

    return [
      {
        point: {
          id: "total",
          label: "Total",
          ...this.groupFigure(bucket, metric, conv, config),
          percentage: isSignedMoney(config.direction, metric) ? undefined : 100,
          count: bucket.count,
        },
        sum: bucket.agg,
      },
    ];
  }

  private aggregateByCategory(
    transactions: Transaction[],
    metric: MetricType,
    config: ReportConfig,
    categoryMap: Map<string, Category>,
    conv: RowConverter,
  ): ReportRow[] {
    const cells = createNetCells(
      config.direction,
      metric,
      this.leftOutWithItsPart(conv),
      this.inAFigure(conv),
      !!config.transferMeasure,
    );
    // An embedded investment line carries no category by definition, so
    // `netLinesOf` leaves it out: counting it here filed a securities purchase
    // under "Uncategorized" spending (re-audit F-CUSTOM-001).
    for (const tx of transactions) {
      for (const line of netLinesOf(tx, true, !!config.transferMeasure)) {
        cells.add(
          line.category,
          line,
          conv.convert(line.amount, tx, line.split),
        );
      }
    }
    const dataMap = cells.settle(
      metric === MetricType.BUDGET_VARIANCE
        ? (id) => {
            const type = categoryTypeOfOrUndefined(categoryMap.get(id));
            return type === undefined ? undefined : type === "income";
          }
        : undefined,
    );

    // Shares of what converted: an excluded row is in no group's sum and in no
    // percentage, the same rule Spending by Category follows.
    const whole = shareDenominator(dataMap, config);

    const result: ReportRow[] = [];
    for (const [categoryId, data] of dataMap) {
      const category = categoryMap.get(categoryId);
      const parent = category?.parentId
        ? categoryMap.get(category.parentId)
        : null;
      const label = category
        ? parent
          ? `${parent.name}: ${category.name}`
          : category.name
        : config.transferMeasure
          ? // Legs holding no category, never ordinary uncategorized rows.
            "No category"
          : "Uncategorized";
      result.push({
        point: {
          id: categoryId,
          label,
          ...this.groupFigure(data, metric, conv, config),
          color: category?.color || undefined,
          percentage: whole && shareOf(data.agg, whole),
          count: data.count,
        },
        sum: data.agg,
      });
    }

    return byValueDescending(result);
  }

  private aggregateByPayee(
    transactions: Transaction[],
    metric: MetricType,
    config: ReportConfig,
    payeeMap: Map<string, Payee>,
    conv: RowConverter,
  ): ReportRow[] {
    const cells = createNetCells(
      config.direction,
      metric,
      this.leftOutWithItsPart(conv),
      this.inAFigure(conv),
      !!config.transferMeasure,
    );
    const payeeNames = new Map<string, string>();

    for (const tx of transactions) {
      // `tx.amount` on a split parent is the sum of EVERY line, so a payee's
      // cells are read per ordinary line; a parent with none adds nothing.
      const lines = netLinesOf(tx, false, !!config.transferMeasure);
      if (lines.length === 0) continue;
      const groupKey =
        tx.payeeId ?? (tx.payeeName ? `name:${tx.payeeName}` : "unknown");
      for (const line of lines) {
        cells.add(groupKey, line, conv.convert(line.amount, tx, line.split));
      }
      if (!payeeNames.has(groupKey) && tx.payeeName) {
        payeeNames.set(groupKey, tx.payeeName);
      }
    }
    const dataMap = cells.settle();

    // Shares of what converted: an excluded row is in no group's sum and in no
    // percentage, the same rule Spending by Category follows.
    const whole = shareDenominator(dataMap, config);

    const result: ReportRow[] = [];
    for (const [groupKey, data] of dataMap) {
      const payee = payeeMap.get(groupKey);
      result.push({
        point: {
          id: groupKey,
          label: payee?.name || payeeNames.get(groupKey) || "Unknown",
          ...this.groupFigure(data, metric, conv, config),
          percentage: whole && shareOf(data.agg, whole),
          count: data.count,
        },
        sum: data.agg,
      });
    }

    return byValueDescending(result);
  }

  private aggregateByTag(
    transactions: Transaction[],
    config: ReportConfig,
    conv: RowConverter,
  ): ReportGroups {
    const metric = config.metric;
    // A tagged line is one financial component even if several tag rows show it.
    // Settle the same population as the ungrouped total, with its FX-gap policy.
    const uniqueCells =
      metric !== MetricType.AVERAGE && isSignedMoney(config.direction, metric)
        ? createNetCells(
            config.direction,
            metric,
            this.leftOutWithItsPart(conv),
          )
        : undefined;
    const cells = createNetCells(
      config.direction,
      metric,
      uniqueCells ? undefined : this.leftOutWithItsPart(conv),
      this.inAFigure(conv),
      !!config.transferMeasure,
    );
    const tagInfo = new Map<string, { tagName: string; color?: string }>();

    for (const tx of transactions) {
      const lines = netLinesOf(tx, false, !!config.transferMeasure);
      if (lines.length === 0) continue;
      // Converted once per line, so a row under several tags records one gap.
      const converted = lines.map((line) => ({
        line,
        value: conv.convert(line.amount, tx, line.split),
      }));
      // A line sits under its own tags plus the parent's, never under a tag
      // that only a sibling line carries. `netLinesOf` maps `ordinarySplitLines`
      // in order for a split parent, so the index pairs a line with its split.
      const splitLines =
        tx.isSplit && tx.splits ? ordinarySplitLines(tx) : undefined;
      for (const [index, { line, value }] of converted.entries()) {
        const lineTags = [...(tx.tags || [])];
        for (const tag of splitLines?.[index]?.tags ?? []) {
          if (!lineTags.some((t) => t.id === tag.id)) lineTags.push(tag);
        }
        const groups =
          lineTags.length === 0
            ? ["untagged"]
            : lineTags.map((tag) => {
                if (!tagInfo.has(tag.id)) {
                  tagInfo.set(tag.id, {
                    tagName: tag.name,
                    color: tag.color ?? undefined,
                  });
                }
                return tag.id;
              });
        uniqueCells?.add("total", line, value);
        for (const group of groups) cells.add(group, line, value);
      }
    }
    const dataMap = cells.settle();

    // Shares of what converted: an excluded row is in no group's sum and in no
    // percentage, the same rule Spending by Category follows.
    const whole = shareDenominator(dataMap, config);

    const result: ReportRow[] = [];
    for (const [tagId, data] of dataMap) {
      const info = tagInfo.get(tagId);
      result.push({
        point: {
          id: tagId,
          label: info?.tagName ?? "Untagged",
          ...this.groupFigure(data, metric, conv, config),
          color: info?.color,
          percentage: whole && shareOf(data.agg, whole),
          count: data.count,
        },
        sum: data.agg,
      });
    }

    return {
      rows: byValueDescending(result),
      uniquePopulation: uniqueCells
        ? (uniqueCells.settle().get("total") ?? {
            agg: new FxAggregate(),
            count: 0,
          })
        : undefined,
    };
  }

  private aggregateByTime(
    transactions: Transaction[],
    metric: MetricType,
    config: ReportConfig,
    period: "year" | "month" | "week" | "day",
    conv: RowConverter,
  ): ReportRow[] {
    const cells = createNetCells(
      config.direction,
      metric,
      this.leftOutWithItsPart(conv),
      this.inAFigure(conv),
      !!config.transferMeasure,
    );
    const labels = new Map<string, string>();

    for (const tx of transactions) {
      const lines = netLinesOf(tx, false, !!config.transferMeasure);
      if (lines.length === 0) continue;
      const date = parseISO(tx.transactionDate);
      let key: string;
      let label: string;

      switch (period) {
        case "year":
          key = format(startOfYear(date), "yyyy");
          label = format(date, "yyyy");
          break;
        case "month":
          key = format(startOfMonth(date), "yyyy-MM");
          label = format(date, "MMM yyyy");
          break;
        case "week":
          key = format(startOfWeek(date), "yyyy-MM-dd");
          label = `Week of ${format(startOfWeek(date), "MMM d")}`;
          break;
        case "day":
          key = format(startOfDay(date), "yyyy-MM-dd");
          label = format(date, "MMM d, yyyy");
          break;
      }

      labels.set(key, label);
      for (const line of lines) {
        cells.add(key, line, conv.convert(line.amount, tx, line.split));
      }
    }
    const dataMap = cells.settle();

    const result: ReportRow[] = [];
    for (const [key, data] of dataMap) {
      result.push({
        point: {
          id: key,
          label: labels.get(key) ?? key,
          ...this.groupFigure(data, metric, conv, config),
          count: data.count,
        },
        sum: data.agg,
      });
    }

    // Sort by date key for time-based groupings
    return result.sort((a, b) => a.point.id!.localeCompare(b.point.id!));
  }

  private async enrichWithBudgetVariance(
    userId: string,
    data: ReportRow[],
    startDate: string,
    endDate: string,
    categoryMap: Map<string, Category>,
    conv: RowConverter,
    { config, filters }: Pick<CustomReport, "config" | "filters">,
  ): Promise<ReportRow[]> {
    try {
      const budgets = await this.budgetsService.findAll(userId);
      const activeBudget = budgets.find((b) => b.isActive) || budgets[0];
      if (!activeBudget) return data;

      const budget = await this.budgetsService.findOne(userId, activeBudget.id);
      // A budget amount is one month's; the actuals span the whole window, so
      // the budget is scaled by the exact months of the window (see below).
      const months = windowMonthFraction(startDate, endDate);
      // Budget amounts are per budget period: a month, a year, or a pay period
      // (cadence from the budget's `payFrequency`, monthly when unset).
      const periodsInWindow =
        budget.budgetType === BudgetType.ANNUAL
          ? months / 12
          : budget.budgetType === BudgetType.PAY_PERIOD
            ? (LOAN_PERIODS_PER_YEAR[budget.config?.payFrequency ?? "MONTHLY"] *
                months) /
              12
            : months;
      // In the reporting currency at the rate on the window's last day: a plan
      // has no date of its own, and the actuals it is set against are each
      // converted at theirs. A budget currency with no rate leaves its
      // categories unenriched and records the gap in the report's own gaps.
      const budgetBasis = transactionRateBasis(
        { currencyCode: budget.currencyCode, transactionDate: endDate },
        conv.currency,
      );
      const convertBudget = await this.currencyService.buildConverter(
        [budgetBasis],
        conv.currency,
      );
      const budgetMap = new Map<string, number>();
      const unconvertible = new Set<string>();
      const narrowed =
        config.direction !== DirectionFilter.BOTH ||
        (filters?.accountIds?.length ?? 0) > 0 ||
        (filters?.payeeIds?.length ?? 0) > 0 ||
        !!filters?.searchText ||
        (filters?.filterGroups?.length ?? 0) > 0;
      const inScope = new Set(filters?.categoryIds ?? []);
      const seen = new Set(data.map((row) => row.point.id));
      for (const bc of budget.categories || []) {
        if (
          bc.categoryId &&
          !bc.isIncome &&
          config.categoryType !== ReportCategoryType.INCOME &&
          config.categoryType !== ReportCategoryType.UNCATEGORIZED &&
          (!narrowed || seen.has(bc.categoryId)) &&
          (!inScope.size || inScope.has(bc.categoryId))
        ) {
          const amount = (Number(bc.amount) || 0) * periodsInWindow;
          // Zero converts to zero at any rate, so it records no gap.
          const converted =
            amount === 0 ? 0 : convertBudget(amount, budgetBasis);
          if (converted === null) {
            conv.gaps.record(budget.currencyCode);
            unconvertible.add(bc.categoryId);
          } else budgetMap.set(bc.categoryId, converted);
        }
      }

      // The variance is the actual's unrounded sum less the plan, rounded
      // once, so the headline folds the same figure the row shows (rule 2).
      const enriched = data.map((row): ReportRow => {
        const { point, sum } = row;
        const id = point.id || "";
        if (unconvertible.has(id) || point.value === null || sum === null) {
          return row;
        }
        const budgeted = budgetMap.get(id) ?? 0;
        const variance = new FxAggregate();
        variance.merge(sum);
        variance.addConverted(-budgeted);
        return {
          point: {
            ...point,
            value: variance.knownSubtotalAt(conv.places),
            budgeted: reportFigure(budgeted, conv.places),
            actual: point.value,
          },
          sum: variance,
        };
      });

      // A budgeted category with no spending is a full under-spend, not absent.
      // Only where nothing but the category filter narrowed the rows: under an
      // account, payee, search or advanced-group filter a zero means "filtered
      // out", not "unspent", and would enter the headline as an invented gap.
      const zeroShare = data.every(
        ({ point }) => point.percentage !== undefined,
      )
        ? 0
        : undefined;
      for (const [categoryId, budgeted] of budgetMap) {
        const category = categoryMap.get(categoryId);
        if (seen.has(categoryId) || !category) continue;
        const sum = new FxAggregate();
        sum.addConverted(-budgeted);
        enriched.push({
          point: {
            id: categoryId,
            label: this.formatCategoryLabel(
              category.parentId
                ? {
                    ...category,
                    parent: categoryMap.get(category.parentId) ?? null,
                  }
                : category,
            ) as string,
            value: sum.knownSubtotalAt(conv.places),
            color: category.color || undefined,
            percentage: zeroShare,
            count: 0,
            budgeted: reportFigure(budgeted, conv.places),
            actual: 0,
          },
          sum,
        });
      }
      return enriched;
    } catch {
      return data;
    }
  }

  /** The headline figures (`summarizeRows`), complete unless a row was left out. */
  private calculateSummary(
    rows: ReportRow[],
    conv: RowConverter,
    metric: MetricType,
    truncated: boolean,
    uniquePopulation?: NetGroup,
  ): ReportSummary {
    // A listed row with no rate counts as listed but adds to no sum; its gap
    // is already in `gaps`, so the total is withheld.
    const complete =
      !truncated && (this.keepsUnconverted(metric) || conv.gaps.isComplete);
    return {
      ...summarizeRows(rows, metric, complete, conv.places, uniquePopulation),
      provisionalCount: this.provisionalCount(conv, metric),
    };
  }

  private sortData(
    rows: ReportRow[],
    sortBy: TableColumn,
    sortDirection: SortDirection,
  ): ReportRow[] {
    const multiplier = sortDirection === SortDirection.ASC ? 1 : -1;

    return [...rows].sort(({ point: a }, { point: b }) => {
      switch (sortBy) {
        case TableColumn.LABEL:
          return multiplier * a.label.localeCompare(b.label);
        // A row with no rate has no value to rank: it sorts after every row
        // that has one, in either direction.
        case TableColumn.VALUE:
          if (a.value === null || b.value === null)
            return Number(a.value === null) - Number(b.value === null);
          return multiplier * (a.value - b.value);
        case TableColumn.COUNT:
          return multiplier * ((a.count || 0) - (b.count || 0));
        case TableColumn.PERCENTAGE:
          return multiplier * ((a.percentage || 0) - (b.percentage || 0));
        // Transaction-specific columns
        case TableColumn.DATE:
          return multiplier * (a.date || "").localeCompare(b.date || "");
        case TableColumn.PAYEE:
          return multiplier * (a.payee || "").localeCompare(b.payee || "");
        case TableColumn.DESCRIPTION:
          return (
            multiplier *
            (a.description || "").localeCompare(b.description || "")
          );
        case TableColumn.MEMO:
          return multiplier * (a.memo || "").localeCompare(b.memo || "");
        case TableColumn.CATEGORY:
          return (
            multiplier * (a.category || "").localeCompare(b.category || "")
          );
        case TableColumn.ACCOUNT:
          return multiplier * (a.account || "").localeCompare(b.account || "");
        case TableColumn.TAG:
          return multiplier * (a.tags || "").localeCompare(b.tags || "");
        // Amounts in different currencies do not compare: rows are ordered by
        // currency first and by amount within one.
        case TableColumn.ACCOUNT_AMOUNT:
          return (
            multiplier *
            ((a.accountCurrency || "").localeCompare(b.accountCurrency || "") ||
              (a.accountAmount || 0) - (b.accountAmount || 0))
          );
        case TableColumn.ORIGINAL_AMOUNT:
          return (
            multiplier *
            ((a.originalCurrency || "").localeCompare(
              b.originalCurrency || "",
            ) || (a.originalAmount || 0) - (b.originalAmount || 0))
          );
        default:
          return 0;
      }
    });
  }
}
