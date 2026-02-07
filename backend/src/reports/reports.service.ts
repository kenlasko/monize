import { Injectable, NotFoundException, ForbiddenException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Brackets } from 'typeorm';
import {
  CustomReport,
  ReportViewType,
  TimeframeType,
  GroupByType,
  MetricType,
  DirectionFilter,
  ReportConfig,
  TableColumn,
  SortDirection,
} from './entities/custom-report.entity';
import { Transaction } from '../transactions/entities/transaction.entity';
import { Category } from '../categories/entities/category.entity';
import { Payee } from '../payees/entities/payee.entity';
import { CreateCustomReportDto } from './dto/create-custom-report.dto';
import { UpdateCustomReportDto } from './dto/update-custom-report.dto';
import {
  ExecuteReportDto,
  ReportResult,
  AggregatedDataPoint,
  ReportSummary,
} from './dto/execute-report.dto';
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
} from 'date-fns';

@Injectable()
export class ReportsService {
  constructor(
    @InjectRepository(CustomReport)
    private reportsRepository: Repository<CustomReport>,
    @InjectRepository(Transaction)
    private transactionsRepository: Repository<Transaction>,
    @InjectRepository(Category)
    private categoriesRepository: Repository<Category>,
    @InjectRepository(Payee)
    private payeesRepository: Repository<Payee>,
  ) {}

  async create(userId: string, dto: CreateCustomReportDto): Promise<CustomReport> {
    // Set default config values if not provided
    const config: ReportConfig = {
      metric: dto.config?.metric || MetricType.TOTAL_AMOUNT,
      includeTransfers: dto.config?.includeTransfers ?? false,
      direction: dto.config?.direction || DirectionFilter.EXPENSES_ONLY,
      customStartDate: dto.config?.customStartDate,
      customEndDate: dto.config?.customEndDate,
      tableColumns: dto.config?.tableColumns,
      sortBy: dto.config?.sortBy,
      sortDirection: dto.config?.sortDirection,
    };

    const report = this.reportsRepository.create({
      ...dto,
      userId,
      config,
      filters: dto.filters || {},
    });

    return this.reportsRepository.save(report);
  }

  async findAll(userId: string): Promise<CustomReport[]> {
    return this.reportsRepository.find({
      where: { userId },
      order: { sortOrder: 'ASC', createdAt: 'DESC' },
    });
  }

  async findOne(userId: string, id: string): Promise<CustomReport> {
    const report = await this.reportsRepository.findOne({ where: { id } });

    if (!report) {
      throw new NotFoundException(`Report with ID ${id} not found`);
    }

    if (report.userId !== userId) {
      throw new ForbiddenException('You do not have access to this report');
    }

    return report;
  }

  async update(userId: string, id: string, dto: UpdateCustomReportDto): Promise<CustomReport> {
    const report = await this.findOne(userId, id);

    // SECURITY: Explicit property mapping instead of Object.assign to prevent mass assignment
    if (dto.name !== undefined) report.name = dto.name;
    if (dto.description !== undefined) report.description = dto.description;
    if (dto.icon !== undefined) report.icon = dto.icon;
    if (dto.backgroundColor !== undefined) report.backgroundColor = dto.backgroundColor;
    if (dto.viewType !== undefined) report.viewType = dto.viewType;
    if (dto.timeframeType !== undefined) report.timeframeType = dto.timeframeType;
    if (dto.groupBy !== undefined) report.groupBy = dto.groupBy;
    if (dto.isFavourite !== undefined) report.isFavourite = dto.isFavourite;
    if (dto.sortOrder !== undefined) report.sortOrder = dto.sortOrder;

    // Replace config if provided (full replacement so cleared fields take effect)
    if (dto.config) {
      report.config = dto.config;
    }

    // Replace filters if provided (full replacement so cleared filters take effect)
    if (dto.filters) {
      report.filters = dto.filters;
    }

    return this.reportsRepository.save(report);
  }

  async remove(userId: string, id: string): Promise<void> {
    const report = await this.findOne(userId, id);
    await this.reportsRepository.remove(report);
  }

  async execute(
    userId: string,
    id: string,
    overrides?: ExecuteReportDto,
  ): Promise<ReportResult> {
    const report = await this.findOne(userId, id);

    // Use override timeframe if provided, otherwise use saved report timeframe
    const effectiveTimeframe = overrides?.timeframeType || report.timeframeType;

    // Calculate date range
    const { startDate, endDate, label: timeframeLabel } = this.getDateRange(
      effectiveTimeframe,
      overrides?.startDate || report.config.customStartDate,
      overrides?.endDate || report.config.customEndDate,
    );

    // Query transactions with filters
    const transactions = await this.getFilteredTransactions(
      userId,
      startDate,
      endDate,
      report.filters,
      report.config,
    );

    // Get category and payee maps for labeling
    const [categories, payees] = await Promise.all([
      this.categoriesRepository.find({ where: { userId } }),
      this.payeesRepository.find({ where: { userId } }),
    ]);

    const categoryMap = new Map(categories.map((c) => [c.id, c]));
    const payeeMap = new Map(payees.map((p) => [p.id, p]));

    // Aggregate data based on groupBy type
    let data = this.aggregateData(
      transactions,
      report.groupBy,
      report.config.metric,
      categoryMap,
      payeeMap,
    );

    // Apply custom sorting if configured
    if (report.config.sortBy) {
      data = this.sortData(data, report.config.sortBy, report.config.sortDirection || SortDirection.DESC);
    }

    // Calculate summary
    const summary = this.calculateSummary(data);

    return {
      reportId: report.id,
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
      tableColumns: report.config.tableColumns,
    };
  }

  private getDateRange(
    timeframeType: TimeframeType,
    customStart?: string,
    customEnd?: string,
  ): { startDate: string; endDate: string; label: string } {
    const today = new Date();
    const endDate = format(today, 'yyyy-MM-dd');
    let startDate: string;
    let label: string;

    switch (timeframeType) {
      case TimeframeType.LAST_7_DAYS:
        startDate = format(subDays(today, 7), 'yyyy-MM-dd');
        label = 'Last 7 Days';
        break;
      case TimeframeType.LAST_30_DAYS:
        startDate = format(subDays(today, 30), 'yyyy-MM-dd');
        label = 'Last 30 Days';
        break;
      case TimeframeType.LAST_MONTH: {
        const lastMonth = subMonths(today, 1);
        startDate = format(startOfMonth(lastMonth), 'yyyy-MM-dd');
        const lastMonthEnd = format(endOfMonth(lastMonth), 'yyyy-MM-dd');
        label = format(lastMonth, 'MMMM yyyy');
        return { startDate, endDate: lastMonthEnd, label };
      }
      case TimeframeType.LAST_3_MONTHS:
        startDate = format(subMonths(today, 3), 'yyyy-MM-dd');
        label = 'Last 3 Months';
        break;
      case TimeframeType.LAST_6_MONTHS:
        startDate = format(subMonths(today, 6), 'yyyy-MM-dd');
        label = 'Last 6 Months';
        break;
      case TimeframeType.LAST_12_MONTHS:
        startDate = format(subMonths(today, 12), 'yyyy-MM-dd');
        label = 'Last 12 Months';
        break;
      case TimeframeType.LAST_YEAR: {
        const lastYear = subYears(today, 1);
        startDate = format(startOfYear(lastYear), 'yyyy-MM-dd');
        const lastYearEnd = format(endOfYear(lastYear), 'yyyy-MM-dd');
        label = format(lastYear, 'yyyy');
        return { startDate, endDate: lastYearEnd, label };
      }
      case TimeframeType.YEAR_TO_DATE:
        startDate = format(startOfYear(today), 'yyyy-MM-dd');
        label = 'Year to Date';
        break;
      case TimeframeType.CUSTOM:
        if (!customStart || !customEnd) {
          throw new Error('Custom timeframe requires start and end dates');
        }
        startDate = customStart;
        label = 'Custom Range';
        return { startDate, endDate: customEnd, label };
      default:
        startDate = format(subMonths(today, 3), 'yyyy-MM-dd');
        label = 'Last 3 Months';
    }

    return { startDate, endDate, label };
  }

  private async getFilteredTransactions(
    userId: string,
    startDate: string,
    endDate: string,
    filters: CustomReport['filters'],
    config: ReportConfig,
  ): Promise<Transaction[]> {
    const queryBuilder = this.transactionsRepository
      .createQueryBuilder('transaction')
      .leftJoinAndSelect('transaction.account', 'account')
      .leftJoinAndSelect('transaction.category', 'category')
      .leftJoinAndSelect('transaction.payee', 'payee')
      .leftJoinAndSelect('transaction.splits', 'splits')
      .leftJoinAndSelect('splits.category', 'splitCategory')
      .where('transaction.userId = :userId', { userId })
      .andWhere('transaction.transactionDate >= :startDate', { startDate })
      .andWhere('transaction.transactionDate <= :endDate', { endDate })
      .andWhere("transaction.status != 'VOID'");

    // Advanced filter groups take precedence over legacy filters
    if (filters.filterGroups && filters.filterGroups.length > 0) {
      this.applyFilterGroups(queryBuilder, filters.filterGroups);
    } else {
      // Legacy simple filters (backward compat)
      if (filters.accountIds && filters.accountIds.length > 0) {
        queryBuilder.andWhere('transaction.accountId IN (:...accountIds)', {
          accountIds: filters.accountIds,
        });
      }

      if (filters.categoryIds && filters.categoryIds.length > 0) {
        queryBuilder.andWhere(
          '(transaction.categoryId IN (:...categoryIds) OR splits.categoryId IN (:...categoryIds))',
          { categoryIds: filters.categoryIds },
        );
      }

      if (filters.payeeIds && filters.payeeIds.length > 0) {
        queryBuilder.andWhere('transaction.payeeId IN (:...payeeIds)', {
          payeeIds: filters.payeeIds,
        });
      }

      if (filters.searchText && filters.searchText.trim()) {
        const searchTerm = `%${filters.searchText.trim().toLowerCase()}%`;
        queryBuilder.andWhere(
          '(LOWER(transaction.payeeName) LIKE :searchTerm OR LOWER(transaction.description) LIKE :searchTerm)',
          { searchTerm },
        );
      }
    }

    // Filter by direction
    if (config.direction === DirectionFilter.INCOME_ONLY) {
      queryBuilder.andWhere('transaction.amount > 0');
    } else if (config.direction === DirectionFilter.EXPENSES_ONLY) {
      queryBuilder.andWhere('transaction.amount < 0');
    }

    // Filter transfers
    if (!config.includeTransfers) {
      queryBuilder.andWhere('transaction.isTransfer = false');
    }

    return queryBuilder.orderBy('transaction.transactionDate', 'ASC').getMany();
  }

  private applyFilterGroups(
    queryBuilder: ReturnType<Repository<Transaction>['createQueryBuilder']>,
    filterGroups: Array<{ conditions: Array<{ field: string; value: string }> }>,
  ): void {
    for (let gi = 0; gi < filterGroups.length; gi++) {
      const group = filterGroups[gi];
      if (!group.conditions || group.conditions.length === 0) continue;

      queryBuilder.andWhere(
        new Brackets((qb) => {
          for (let ci = 0; ci < group.conditions.length; ci++) {
            const condition = group.conditions[ci];
            const param = `p_g${gi}_c${ci}`;
            const method = ci === 0 ? 'where' : 'orWhere';

            switch (condition.field) {
              case 'account':
                qb[method](`transaction.accountId = :${param}`, {
                  [param]: condition.value,
                });
                break;
              case 'category':
                qb[method](
                  new Brackets((inner) => {
                    inner
                      .where(`transaction.categoryId = :${param}`, {
                        [param]: condition.value,
                      })
                      .orWhere(`splits.categoryId = :${param}`, {
                        [param]: condition.value,
                      });
                  }),
                );
                break;
              case 'payee':
                qb[method](`transaction.payeeId = :${param}`, {
                  [param]: condition.value,
                });
                break;
              case 'text': {
                const textParam = `%${condition.value.trim().toLowerCase()}%`;
                qb[method](
                  new Brackets((inner) => {
                    inner
                      .where(`LOWER(transaction.payeeName) LIKE :${param}`, {
                        [param]: textParam,
                      })
                      .orWhere(`LOWER(transaction.description) LIKE :${param}`, {
                        [param]: textParam,
                      });
                  }),
                );
                break;
              }
            }
          }
        }),
      );
    }
  }

  private aggregateData(
    transactions: Transaction[],
    groupBy: GroupByType,
    metric: MetricType,
    categoryMap: Map<string, Category>,
    payeeMap: Map<string, Payee>,
  ): AggregatedDataPoint[] {
    switch (groupBy) {
      case GroupByType.NONE:
        return this.aggregateNoGrouping(transactions, metric);
      case GroupByType.CATEGORY:
        return this.aggregateByCategory(transactions, metric, categoryMap);
      case GroupByType.PAYEE:
        return this.aggregateByPayee(transactions, metric, payeeMap);
      case GroupByType.MONTH:
        return this.aggregateByTime(transactions, metric, 'month');
      case GroupByType.WEEK:
        return this.aggregateByTime(transactions, metric, 'week');
      case GroupByType.DAY:
        return this.aggregateByTime(transactions, metric, 'day');
      default:
        return this.aggregateNoGrouping(transactions, metric);
    }
  }

  private aggregateNoGrouping(
    transactions: Transaction[],
    metric: MetricType,
  ): AggregatedDataPoint[] {
    // For NONE metric, return individual transactions as data points
    if (metric === MetricType.NONE) {
      const result: AggregatedDataPoint[] = [];

      for (const tx of transactions) {
        if (tx.isSplit && tx.splits && tx.splits.length > 0) {
          for (const split of tx.splits) {
            result.push({
              id: tx.id,
              label: split.memo || tx.payeeName || tx.description || 'Transaction',
              value: Math.abs(Number(split.amount)),
              count: 1,
              // Transaction-specific fields
              date: tx.transactionDate,
              payee: tx.payeeName || tx.payee?.name || undefined,
              description: tx.description || undefined,
              memo: split.memo || undefined,
              category: split.category?.name || undefined,
              account: tx.account?.name || undefined,
            });
          }
        } else {
          result.push({
            id: tx.id,
            label: tx.payeeName || tx.description || 'Transaction',
            value: Math.abs(Number(tx.amount)),
            count: 1,
            // Transaction-specific fields
            date: tx.transactionDate,
            payee: tx.payeeName || tx.payee?.name || undefined,
            description: tx.description || undefined,
            memo: undefined, // Transactions don't have memo, only splits do
            category: tx.category?.name || undefined,
            account: tx.account?.name || undefined,
          });
        }
      }

      return result;
    }

    // For other metrics, aggregate into a single total
    let sum = 0;
    let count = 0;

    for (const tx of transactions) {
      if (tx.isSplit && tx.splits && tx.splits.length > 0) {
        for (const split of tx.splits) {
          sum += Math.abs(Number(split.amount));
          count += 1;
        }
      } else {
        sum += Math.abs(Number(tx.amount));
        count += 1;
      }
    }

    if (count === 0) {
      return [];
    }

    return [{
      id: 'total',
      label: 'Total',
      value: this.calculateMetricValue(sum, count, metric),
      percentage: 100,
      count,
    }];
  }

  private aggregateByCategory(
    transactions: Transaction[],
    metric: MetricType,
    categoryMap: Map<string, Category>,
  ): AggregatedDataPoint[] {
    const dataMap = new Map<string, { sum: number; count: number }>();

    for (const tx of transactions) {
      if (tx.isSplit && tx.splits && tx.splits.length > 0) {
        // Handle split transactions
        for (const split of tx.splits) {
          const categoryId = split.categoryId || 'uncategorized';
          const existing = dataMap.get(categoryId) || { sum: 0, count: 0 };
          existing.sum += Math.abs(Number(split.amount));
          existing.count += 1;
          dataMap.set(categoryId, existing);
        }
      } else {
        // Regular transaction
        const categoryId = tx.categoryId || 'uncategorized';
        const existing = dataMap.get(categoryId) || { sum: 0, count: 0 };
        existing.sum += Math.abs(Number(tx.amount));
        existing.count += 1;
        dataMap.set(categoryId, existing);
      }
    }

    const totalSum = Array.from(dataMap.values()).reduce((acc, v) => acc + v.sum, 0);

    const result: AggregatedDataPoint[] = [];
    for (const [categoryId, data] of dataMap) {
      const category = categoryMap.get(categoryId);
      result.push({
        id: categoryId,
        label: category?.name || 'Uncategorized',
        value: this.calculateMetricValue(data.sum, data.count, metric),
        color: category?.color || undefined,
        percentage: totalSum > 0 ? (data.sum / totalSum) * 100 : 0,
        count: data.count,
      });
    }

    return result.sort((a, b) => b.value - a.value);
  }

  private aggregateByPayee(
    transactions: Transaction[],
    metric: MetricType,
    payeeMap: Map<string, Payee>,
  ): AggregatedDataPoint[] {
    const dataMap = new Map<string, { sum: number; count: number; payeeName?: string }>();

    for (const tx of transactions) {
      const payeeId = tx.payeeId || 'unknown';
      const existing = dataMap.get(payeeId) || { sum: 0, count: 0, payeeName: tx.payeeName ?? undefined };
      existing.sum += Math.abs(Number(tx.amount));
      existing.count += 1;
      if (!existing.payeeName && tx.payeeName) {
        existing.payeeName = tx.payeeName;
      }
      dataMap.set(payeeId, existing);
    }

    const totalSum = Array.from(dataMap.values()).reduce((acc, v) => acc + v.sum, 0);

    const result: AggregatedDataPoint[] = [];
    for (const [payeeId, data] of dataMap) {
      const payee = payeeMap.get(payeeId);
      result.push({
        id: payeeId,
        label: payee?.name || data.payeeName || 'Unknown',
        value: this.calculateMetricValue(data.sum, data.count, metric),
        percentage: totalSum > 0 ? (data.sum / totalSum) * 100 : 0,
        count: data.count,
      });
    }

    return result.sort((a, b) => b.value - a.value);
  }

  private aggregateByTime(
    transactions: Transaction[],
    metric: MetricType,
    period: 'month' | 'week' | 'day',
  ): AggregatedDataPoint[] {
    const dataMap = new Map<string, { sum: number; count: number; label: string }>();

    for (const tx of transactions) {
      const date = parseISO(tx.transactionDate);
      let key: string;
      let label: string;

      switch (period) {
        case 'month':
          key = format(startOfMonth(date), 'yyyy-MM');
          label = format(date, 'MMM yyyy');
          break;
        case 'week':
          key = format(startOfWeek(date), 'yyyy-MM-dd');
          label = `Week of ${format(startOfWeek(date), 'MMM d')}`;
          break;
        case 'day':
          key = format(startOfDay(date), 'yyyy-MM-dd');
          label = format(date, 'MMM d, yyyy');
          break;
      }

      const existing = dataMap.get(key) || { sum: 0, count: 0, label };
      existing.sum += Math.abs(Number(tx.amount));
      existing.count += 1;
      dataMap.set(key, existing);
    }

    const result: AggregatedDataPoint[] = [];
    for (const [key, data] of dataMap) {
      result.push({
        id: key,
        label: data.label,
        value: this.calculateMetricValue(data.sum, data.count, metric),
        count: data.count,
      });
    }

    // Sort by date key for time-based groupings
    return result.sort((a, b) => a.id!.localeCompare(b.id!));
  }

  private calculateMetricValue(sum: number, count: number, metric: MetricType): number {
    switch (metric) {
      case MetricType.NONE:
        return Math.round(sum * 100) / 100;
      case MetricType.TOTAL_AMOUNT:
        return Math.round(sum * 100) / 100;
      case MetricType.COUNT:
        return count;
      case MetricType.AVERAGE:
        return count > 0 ? Math.round((sum / count) * 100) / 100 : 0;
      default:
        return sum;
    }
  }

  private calculateSummary(data: AggregatedDataPoint[]): ReportSummary {
    const total = data.reduce((acc, d) => acc + d.value, 0);
    const count = data.reduce((acc, d) => acc + (d.count || 1), 0);
    const average = count > 0 ? total / count : 0;

    return {
      total: Math.round(total * 100) / 100,
      count,
      average: Math.round(average * 100) / 100,
    };
  }

  private sortData(
    data: AggregatedDataPoint[],
    sortBy: TableColumn,
    sortDirection: SortDirection,
  ): AggregatedDataPoint[] {
    const multiplier = sortDirection === SortDirection.ASC ? 1 : -1;

    return [...data].sort((a, b) => {
      switch (sortBy) {
        case TableColumn.LABEL:
          return multiplier * a.label.localeCompare(b.label);
        case TableColumn.VALUE:
          return multiplier * (a.value - b.value);
        case TableColumn.COUNT:
          return multiplier * ((a.count || 0) - (b.count || 0));
        case TableColumn.PERCENTAGE:
          return multiplier * ((a.percentage || 0) - (b.percentage || 0));
        // Transaction-specific columns
        case TableColumn.DATE:
          return multiplier * (a.date || '').localeCompare(b.date || '');
        case TableColumn.PAYEE:
          return multiplier * (a.payee || '').localeCompare(b.payee || '');
        case TableColumn.DESCRIPTION:
          return multiplier * (a.description || '').localeCompare(b.description || '');
        case TableColumn.MEMO:
          return multiplier * (a.memo || '').localeCompare(b.memo || '');
        case TableColumn.CATEGORY:
          return multiplier * (a.category || '').localeCompare(b.category || '');
        case TableColumn.ACCOUNT:
          return multiplier * (a.account || '').localeCompare(b.account || '');
        default:
          return 0;
      }
    });
  }
}
