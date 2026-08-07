import {
  Injectable,
  ConflictException,
  NotFoundException,
  BadRequestException,
  Inject,
  forwardRef,
  Logger,
} from "@nestjs/common";
import { LessThanOrEqual, DataSource, EntityManager, In } from "typeorm";
import { Cron } from "@nestjs/schedule";
import {
  ScheduledTransaction,
  FrequencyType,
} from "./entities/scheduled-transaction.entity";
import { ScheduledTransactionSplit } from "./entities/scheduled-transaction-split.entity";
import { SplitKind } from "../transactions/entities/split-kind.enum";
import { ScheduledTransactionOverride } from "./entities/scheduled-transaction-override.entity";
import { CreateScheduledTransactionDto } from "./dto/create-scheduled-transaction.dto";
import { UpdateScheduledTransactionDto } from "./dto/update-scheduled-transaction.dto";
import { CreateScheduledTransactionSplitDto } from "./dto/create-scheduled-transaction-split.dto";
import {
  CreateScheduledTransactionOverrideDto,
  UpdateScheduledTransactionOverrideDto,
} from "./dto/scheduled-transaction-override.dto";
import { PostScheduledTransactionDto } from "./dto/post-scheduled-transaction.dto";
import { Tag } from "../tags/entities/tag.entity";
import { AccountsService } from "../accounts/accounts.service";
import { TransactionsService } from "../transactions/transactions.service";
import { InvestmentTransactionsService } from "../securities/investment-transactions.service";
import { InvestmentAction } from "../securities/entities/investment-transaction.entity";
import { AccountSubType } from "../accounts/entities/account.entity";
import { ScheduledTransactionOverrideService } from "./scheduled-transaction-override.service";
import { ScheduledTransactionLoanService } from "./scheduled-transaction-loan.service";
import { todayInTimezone, todayYMD } from "../common/date-utils";
import {
  calculateNextDueDate as calcNextDueDate,
  ensureYMD,
} from "../common/recurrence";
import { ActionHistoryService } from "../action-history/action-history.service";
import { getUsersByEffectiveTimezone } from "../common/users-by-timezone.util";
import { withSystemContext, withUserContext } from "../common/db/with-context";
import { withScopedDb } from "../common/db/scoped-db";
import { affectedRowCount } from "../common/db/query-result";
import { validateSplitAmountSum } from "../common/split-amount.util";
import { roundMoney, sumMoney } from "../common/round.util";
import {
  applyFxConversion,
  normalizeFxEntry,
  roundFxRate,
} from "../common/fx-entry.util";
import { ExchangeRateService } from "../currencies/exchange-rate.service";
import { tr } from "../i18n/translate";

export type LlmScheduledKind = "bill" | "deposit" | "transfer" | "investment";

export interface LlmScheduledItem {
  id: string;
  name: string;
  accountId: string;
  accountName: string;
  payeeName: string | null;
  categoryName: string | null;
  amount: number;
  currency: string;
  frequency: FrequencyType;
  nextDueDate: string;
  daysUntilDue: number;
  isActive: boolean;
  autoPost: boolean;
  kind: LlmScheduledKind;
  description: string | null;
}

export interface LlmUpcomingScheduledResult {
  daysWindow: number;
  itemCount: number;
  overdueCount: number;
  totalUpcomingBills: number;
  totalUpcomingDeposits: number;
  items: LlmScheduledItem[];
}

export interface LlmScheduledFilter {
  kind?: LlmScheduledKind | "all";
  accountIds?: string[];
  isActive?: boolean;
}

export interface LlmUpcomingFilter extends LlmScheduledFilter {
  days?: number;
}

const INVESTMENT_RELATIONS = [
  "account",
  "payee",
  "category",
  "transferAccount",
  "investmentSecurity",
  "investmentFundingAccount",
  "splits",
  "splits.category",
  "splits.transferAccount",
  "splits.tags",
  "splits.investmentSecurity",
];

const SECURITY_REQUIRED_ACTIONS = new Set<InvestmentAction>([
  InvestmentAction.BUY,
  InvestmentAction.SELL,
  InvestmentAction.DIVIDEND,
  InvestmentAction.CAPITAL_GAIN,
  InvestmentAction.SPLIT,
  InvestmentAction.REINVEST,
  InvestmentAction.ADD_SHARES,
  InvestmentAction.REMOVE_SHARES,
]);

const QUANTITY_PRICE_ACTIONS = new Set<InvestmentAction>([
  InvestmentAction.BUY,
  InvestmentAction.SELL,
  InvestmentAction.REINVEST,
]);

const QUANTITY_ONLY_ACTIONS = new Set<InvestmentAction>([
  InvestmentAction.ADD_SHARES,
  InvestmentAction.REMOVE_SHARES,
  InvestmentAction.SPLIT,
]);

const AMOUNT_ONLY_ACTIONS = new Set<InvestmentAction>([
  InvestmentAction.DIVIDEND,
  InvestmentAction.INTEREST,
  InvestmentAction.CAPITAL_GAIN,
]);

@Injectable()
export class ScheduledTransactionsService {
  private readonly logger = new Logger(ScheduledTransactionsService.name);

  constructor(
    @Inject(forwardRef(() => AccountsService))
    private accountsService: AccountsService,
    private transactionsService: TransactionsService,
    private investmentTransactionsService: InvestmentTransactionsService,
    private overrideService: ScheduledTransactionOverrideService,
    private loanService: ScheduledTransactionLoanService,
    private dataSource: DataSource,
    private actionHistoryService: ActionHistoryService,
    @Inject(forwardRef(() => ExchangeRateService))
    private exchangeRateService: ExchangeRateService,
  ) {}

  @Cron("5 * * * *")
  async processAutoPostTransactions(): Promise<void> {
    this.logger.log("Starting auto-post processing for scheduled transactions");
    // RLS (task C2): the timezone/candidate fan-out queries span users, so the
    // body runs under a system context; each per-user post() re-enters a user
    // context below so it keeps the owner's RLS net.
    return withSystemContext(() => this.processAutoPostWithinContext());
  }

  private async processAutoPostWithinContext(): Promise<void> {
    try {
      const userIdsByTz = await getUsersByEffectiveTimezone(this.dataSource);
      if (userIdsByTz.size === 0) return;

      let totalSuccess = 0;
      let totalError = 0;
      let totalSkipped = 0;

      for (const [tz, userIds] of userIdsByTz) {
        const today = todayInTimezone(tz);
        if (!today) {
          this.logger.warn(
            `Skipping ${userIds.length} user(s) with invalid timezone "${tz}"`,
          );
          continue;
        }

        // One read block per timezone bucket. It must COMMIT before the
        // per-user posting loop below: each post() runs its own user-context
        // transactions, which would otherwise join this system-context one.
        const dueTransactions = await withScopedDb(
          this.dataSource,
          async (m) => {
            const candidates = await m
              .getRepository(ScheduledTransaction)
              .find({
                where: {
                  userId: In(userIds),
                  isActive: true,
                  autoPost: true,
                  nextDueDate: LessThanOrEqual(today) as any,
                },
                relations: INVESTMENT_RELATIONS,
                order: { nextDueDate: "ASC" },
              });

            const postponedIds = await this.findPostponedIds(
              candidates.map((t) => t.id),
              today,
            );
            const dueByDate = candidates.filter((t) => !postponedIds.has(t.id));

            const overrideDueIds = await m
              .getRepository(ScheduledTransactionOverride)
              .createQueryBuilder("o")
              .innerJoin("o.scheduledTransaction", "st")
              .where("st.userId IN (:...userIds)", { userIds })
              .andWhere("o.overrideDate <= :today", { today })
              .andWhere("o.originalDate = st.nextDueDate")
              .andWhere("st.isActive = :active", { active: true })
              .andWhere("st.autoPost = :autoPost", { autoPost: true })
              .select("st.id", "id")
              .distinct(true)
              .getRawMany();

            const dueByDateIds = new Set(dueByDate.map((t) => t.id));
            const overrideOnlyIds = overrideDueIds
              .map((r) => r.id as string)
              .filter((id) => !dueByDateIds.has(id));

            let overrideDueTransactions: ScheduledTransaction[] = [];
            if (overrideOnlyIds.length > 0) {
              overrideDueTransactions = await m
                .getRepository(ScheduledTransaction)
                .find({
                  where: overrideOnlyIds.map((id) => ({ id })),
                  relations: INVESTMENT_RELATIONS,
                });
            }

            return [...dueByDate, ...overrideDueTransactions];
          },
        );
        if (dueTransactions.length === 0) continue;

        for (const scheduled of dueTransactions) {
          try {
            await withUserContext(scheduled.userId, () =>
              this.post(scheduled.userId, scheduled.id),
            );
            totalSuccess++;
          } catch (error) {
            if (error instanceof ConflictException) {
              // Another replica -- or a manual post -- claimed this occurrence
              // first. Every backend replica fires this cron, so losing the
              // claim is the normal outcome for all but one of them, not a
              // failure: the money was posted exactly once, by the winner.
              totalSkipped++;
              continue;
            }
            totalError++;
            this.logger.error(
              `Failed to auto-post "${scheduled.name}" (ID: ${scheduled.id}): ${error.message}`,
              error.stack,
            );
          }
        }
      }

      this.logger.log(
        `Auto-post processing complete: ${totalSuccess} succeeded, ` +
          `${totalSkipped} already claimed elsewhere, ${totalError} failed`,
      );
    } catch (error) {
      this.logger.error("Auto-post processing failed", error.stack);
    }
  }

  /**
   * Re-derive the account-currency estimate held in `amount` for every
   * foreign-currency schedule, from the latest stored rate.
   *
   * A scheduled transaction is by definition future-dated, so there is no rate
   * for its due date yet -- the best available answer is today's. Everything
   * that reads `amount` (the bills list, the cash-flow forecast chart, budgets,
   * the upcoming-bills widgets) therefore shows a figure that tracks the market
   * instead of the rate that happened to apply the day the schedule was
   * created. The rate actually used is looked up again for the posting date
   * when the occurrence posts, so this estimate never decides what is booked.
   *
   * Runs 20 minutes past the exchange-rate refresh (5:05 PM New York,
   * Monday-Friday) so it reads rates the same run just stored; on a day the
   * markets are shut it simply does not fire.
   */
  @Cron("25 17 * * 1-5", { timeZone: "America/New_York" })
  async refreshForeignCurrencyEstimates(): Promise<void> {
    // RLS: the sweep spans every user, so the discovery read runs under a
    // system context and each per-user write re-enters that user's context.
    await withSystemContext(() =>
      this.refreshForeignCurrencyEstimatesWithinContext(),
    );
  }

  private async refreshForeignCurrencyEstimatesWithinContext(): Promise<void> {
    try {
      const rows = await withScopedDb(this.dataSource, (m) =>
        m.getRepository(ScheduledTransaction).find({
          where: { isActive: true },
          relations: ["account"],
        }),
      );
      const foreign = rows.filter(
        (r) => r.originalCurrencyCode && r.originalAmount !== null,
      );
      if (foreign.length === 0) return;

      // One lookup per currency pair, not per schedule -- a user with a dozen
      // USD subscriptions on the same card needs exactly one.
      const rateCache = new Map<string, number | null>();
      let updated = 0;

      for (const row of foreign) {
        const pair = `${row.originalCurrencyCode}->${row.currencyCode}`;
        if (!rateCache.has(pair)) {
          rateCache.set(
            pair,
            await this.exchangeRateService.getLatestRate(
              row.originalCurrencyCode as string,
              row.currencyCode,
            ),
          );
        }
        const rate = rateCache.get(pair);
        if (rate === null || rate === undefined || !(rate > 0)) continue;

        const converted = applyFxConversion(
          Number(row.originalAmount),
          rate,
          row.account?.fxFeePercent ?? null,
        );
        const nextRate = roundFxRate(rate);
        if (
          converted.amount === roundMoney(Number(row.amount)) &&
          nextRate === roundFxRate(Number(row.exchangeRate))
        ) {
          continue;
        }

        try {
          await withUserContext(row.userId, () =>
            withScopedDb(this.dataSource, (m) =>
              m.update(ScheduledTransaction, row.id, {
                amount: converted.amount,
                exchangeRate: nextRate,
              }),
            ),
          );
          updated++;
        } catch (error) {
          this.logger.error(
            `Failed to refresh the ${pair} estimate for "${row.name}" (ID: ${row.id}): ${error.message}`,
          );
        }
      }

      this.logger.log(
        `Foreign-currency schedule estimates refreshed: ${updated} of ${foreign.length} updated`,
      );
    } catch (error) {
      this.logger.error(
        "Foreign-currency schedule estimate refresh failed",
        error.stack,
      );
    }
  }

  private async findPostponedIds(
    candidateIds: string[],
    today: string,
  ): Promise<Set<string>> {
    if (candidateIds.length === 0) {
      return new Set();
    }

    const rows = await withScopedDb(this.dataSource, (m) =>
      m
        .getRepository(ScheduledTransactionOverride)
        .createQueryBuilder("o")
        .innerJoin("o.scheduledTransaction", "st")
        .where("o.scheduledTransactionId IN (:...ids)", { ids: candidateIds })
        .andWhere("o.originalDate = st.nextDueDate")
        .andWhere("o.overrideDate > :today", { today })
        .select("o.scheduledTransactionId", "id")
        .distinct(true)
        .getRawMany(),
    );

    return new Set(rows.map((r) => r.id as string));
  }

  async create(
    userId: string,
    createDto: CreateScheduledTransactionDto,
  ): Promise<ScheduledTransaction> {
    if (createDto.isInvestment && createDto.isTransfer) {
      throw new BadRequestException(
        tr(
          "errors.scheduled.notTransferAndInvestment",
          "A scheduled transaction cannot be both a transfer and an investment",
        ),
      );
    }

    const account = await this.accountsService.findOne(
      userId,
      createDto.accountId,
    );

    if (createDto.isTransfer && createDto.transferAccountId) {
      await this.accountsService.findOne(userId, createDto.transferAccountId);
      if (createDto.transferAccountId === createDto.accountId) {
        throw new BadRequestException(
          tr(
            "errors.scheduled.sameSourceAndDestination",
            "Source and destination accounts must be different",
          ),
        );
      }
    }

    if (createDto.isInvestment) {
      if (account.accountSubType !== AccountSubType.INVESTMENT_BROKERAGE) {
        throw new BadRequestException(
          tr(
            "errors.scheduled.requiresBrokerageAccount",
            "Scheduled investment transactions require a brokerage account",
          ),
        );
      }
      this.validateInvestmentFields(createDto);
      if (createDto.investmentFundingAccountId) {
        await this.accountsService.findOne(
          userId,
          createDto.investmentFundingAccountId,
        );
      }
    }

    const {
      splits,
      isTransfer,
      transferAccountId,
      isInvestment,
      ...transactionData
    } = createDto;
    const hasSplits = !isInvestment && splits && splits.length > 0;

    if (hasSplits && !isTransfer) {
      this.validateSplits(splits, createDto.amount);
    }

    const fx = this.resolveScheduleFx(createDto, account.currencyCode, {
      isSplit: !!(hasSplits && !isTransfer),
      isTransfer: !!isTransfer,
      isInvestment: !!isInvestment,
    });

    const saved = await withScopedDb(this.dataSource, async (m) => {
      const repo = m.getRepository(ScheduledTransaction);
      const scheduledTransaction = repo.create({
        ...transactionData,
        userId,
        startDate: transactionData.startDate || transactionData.nextDueDate,
        totalOccurrences: transactionData.occurrencesRemaining,
        // A transfer may carry an optional spending category (see #743): it is
        // stored on the schedule and applied to both legs when posted, surfacing
        // the transfer in the monthly category breakdown. Only splits (category
        // lives on each split) and investments null it out here.
        categoryId:
          hasSplits || isInvestment ? null : transactionData.categoryId,
        originalAmount: fx.originalAmount,
        originalCurrencyCode: fx.originalCurrencyCode,
        exchangeRate: fx.exchangeRate,
        isSplit: hasSplits && !isTransfer,
        isTransfer: isTransfer || false,
        transferAccountId: isTransfer ? transferAccountId : null,
        isInvestment: isInvestment || false,
        investmentAction: isInvestment
          ? (transactionData.investmentAction as InvestmentAction)
          : null,
        investmentSecurityId: isInvestment
          ? transactionData.investmentSecurityId || null
          : null,
        investmentFundingAccountId: isInvestment
          ? transactionData.investmentFundingAccountId || null
          : null,
        investmentQuantity:
          isInvestment && transactionData.investmentQuantity !== undefined
            ? transactionData.investmentQuantity
            : null,
        investmentPrice:
          isInvestment && transactionData.investmentPrice !== undefined
            ? transactionData.investmentPrice
            : null,
        investmentCommission:
          isInvestment && transactionData.investmentCommission !== undefined
            ? transactionData.investmentCommission
            : null,
        investmentTotalAmount:
          isInvestment && transactionData.investmentTotalAmount !== undefined
            ? transactionData.investmentTotalAmount
            : null,
        investmentExchangeRate:
          isInvestment && transactionData.investmentExchangeRate !== undefined
            ? transactionData.investmentExchangeRate
            : null,
      });

      const savedRow = await repo.save(scheduledTransaction);

      if (hasSplits && !isTransfer) {
        await this.createSplits(savedRow.id, splits, m);
      }

      return savedRow;
    });

    const result = await this.findOne(userId, saved.id);

    this.actionHistoryService.record(userId, {
      entityType: "scheduled_transaction",
      entityId: result.id,
      action: "create",
      afterData: { ...result },
      description: `Created scheduled transaction "${result.name}"`,
      descriptionKey: "createdScheduledTransaction",
      descriptionParams: { name: result.name },
    });

    return result;
  }

  /**
   * Normalize the foreign-currency entry on a create/update payload against the
   * account currency, and return the trio to persist alongside `amount`.
   *
   * Foreign-currency entry is offered on a plain scheduled transaction only.
   * A transfer already has its own cross-currency handling (each leg is in its
   * own account's currency), an investment carries its own
   * `investmentExchangeRate`, and a split stores per-split amounts in the
   * account currency that could not be re-derived when the rate moves -- so
   * each of those rejects the fields rather than silently dropping them.
   */
  private resolveScheduleFx(
    dto: {
      amount?: number;
      originalAmount?: number | null;
      originalCurrencyCode?: string | null;
      exchangeRate?: number | null;
    },
    accountCurrencyCode: string,
    kind: { isSplit: boolean; isTransfer: boolean; isInvestment: boolean },
  ): {
    originalAmount: number | null;
    originalCurrencyCode: string | null;
    exchangeRate: number;
  } {
    const fx = normalizeFxEntry(
      {
        originalAmount: dto.originalAmount,
        originalCurrencyCode: dto.originalCurrencyCode,
        exchangeRate: dto.exchangeRate,
        amount: Number(dto.amount ?? 0),
      },
      accountCurrencyCode,
    );

    if (
      fx.originalCurrencyCode &&
      (kind.isSplit || kind.isTransfer || kind.isInvestment)
    ) {
      throw new BadRequestException(
        tr(
          "errors.scheduled.fxPlainOnly",
          "A different currency can only be used on a plain scheduled transaction, not a split, transfer or investment",
        ),
      );
    }

    return {
      ...fx,
      exchangeRate: fx.originalCurrencyCode
        ? roundFxRate(Number(dto.exchangeRate))
        : 1,
    };
  }

  private validateInvestmentFields(dto: {
    investmentAction?: InvestmentAction;
    investmentSecurityId?: string | null;
    investmentQuantity?: number | null;
    investmentPrice?: number | null;
    investmentTotalAmount?: number | null;
  }): void {
    const action = dto.investmentAction;
    if (!action) {
      throw new BadRequestException(
        tr(
          "errors.scheduled.investmentActionRequired",
          "Investment action is required for scheduled investment transactions",
        ),
      );
    }
    if (SECURITY_REQUIRED_ACTIONS.has(action) && !dto.investmentSecurityId) {
      throw new BadRequestException(
        tr(
          "errors.scheduled.actionRequiresSecurity",
          `Action ${action} requires a security`,
          { action },
        ),
      );
    }
    if (QUANTITY_PRICE_ACTIONS.has(action)) {
      if (
        dto.investmentQuantity === undefined ||
        dto.investmentQuantity === null ||
        Number(dto.investmentQuantity) <= 0
      ) {
        throw new BadRequestException(
          tr(
            "errors.scheduled.actionRequiresPositiveQuantity",
            `Action ${action} requires a positive quantity`,
            { action },
          ),
        );
      }
      if (
        dto.investmentPrice === undefined ||
        dto.investmentPrice === null ||
        Number(dto.investmentPrice) <= 0
      ) {
        throw new BadRequestException(
          tr(
            "errors.scheduled.actionRequiresPositivePrice",
            `Action ${action} requires a positive price`,
            { action },
          ),
        );
      }
    } else if (QUANTITY_ONLY_ACTIONS.has(action)) {
      if (
        dto.investmentQuantity === undefined ||
        dto.investmentQuantity === null ||
        Number(dto.investmentQuantity) <= 0
      ) {
        throw new BadRequestException(
          tr(
            "errors.scheduled.actionRequiresPositiveQuantity",
            `Action ${action} requires a positive quantity`,
            { action },
          ),
        );
      }
    } else if (AMOUNT_ONLY_ACTIONS.has(action)) {
      if (
        dto.investmentTotalAmount === undefined ||
        dto.investmentTotalAmount === null
      ) {
        throw new BadRequestException(
          tr(
            "errors.scheduled.actionRequiresTotalAmount",
            `Action ${action} requires a total amount`,
            { action },
          ),
        );
      }
    }
  }

  private validateSplits(
    splits: CreateScheduledTransactionSplitDto[],
    transactionAmount: number,
  ): void {
    validateSplitAmountSum(splits, transactionAmount, {
      allowSinglePassthrough: true,
      isPassthrough: (s) => {
        const split = s as CreateScheduledTransactionSplitDto;
        return Boolean(split.transferAccountId || split.investment);
      },
    });
  }

  private async createSplits(
    scheduledTransactionId: string,
    splits: CreateScheduledTransactionSplitDto[],
    manager: EntityManager,
  ): Promise<ScheduledTransactionSplit[]> {
    const savedSplits: ScheduledTransactionSplit[] = [];

    // Batch-fetch every tag referenced across all splits so the per-split
    // tag assignment doesn't trigger one `findBy(Tag, ...)` query per row
    // (the prior N+1 pattern).
    const allTagIds = Array.from(
      new Set(splits.flatMap((s) => s.tagIds ?? [])),
    );
    const tagsById =
      allTagIds.length > 0
        ? new Map(
            (await manager.findBy(Tag, { id: In(allTagIds) })).map((t) => [
              t.id,
              t,
            ]),
          )
        : new Map<string, Tag>();

    for (const split of splits) {
      const inferredKind: SplitKind = split.splitKind
        ? split.splitKind
        : split.investment
          ? SplitKind.INVESTMENT
          : split.transferAccountId
            ? SplitKind.TRANSFER
            : SplitKind.CATEGORY;

      const entity = manager.create(ScheduledTransactionSplit, {
        scheduledTransactionId,
        kind: inferredKind,
        categoryId:
          inferredKind === SplitKind.CATEGORY ? split.categoryId || null : null,
        transferAccountId:
          inferredKind === SplitKind.TRANSFER
            ? split.transferAccountId || null
            : null,
        amount: split.amount,
        memo: split.memo || null,
        investmentAction:
          inferredKind === SplitKind.INVESTMENT && split.investment
            ? split.investment.action
            : null,
        investmentSecurityId:
          inferredKind === SplitKind.INVESTMENT && split.investment
            ? split.investment.securityId || null
            : null,
        investmentQuantity:
          inferredKind === SplitKind.INVESTMENT && split.investment
            ? (split.investment.quantity ?? null)
            : null,
        investmentPrice:
          inferredKind === SplitKind.INVESTMENT && split.investment
            ? (split.investment.price ?? null)
            : null,
        investmentCommission:
          inferredKind === SplitKind.INVESTMENT && split.investment
            ? (split.investment.commission ?? null)
            : null,
        investmentExchangeRate:
          inferredKind === SplitKind.INVESTMENT && split.investment
            ? (split.investment.exchangeRate ?? null)
            : null,
      });

      const saved = await manager.save(entity);

      if (split.tagIds && split.tagIds.length > 0) {
        saved.tags = split.tagIds
          .map((id) => tagsById.get(id))
          .filter((t): t is Tag => t != null);
        await manager.save(saved);
      }

      savedSplits.push(saved);
    }

    return savedSplits;
  }

  async findAll(userId: string): Promise<
    (ScheduledTransaction & {
      overrideCount?: number;
      nextOverride?: ScheduledTransactionOverride | null;
      futureOverrides?: ScheduledTransactionOverride[];
    })[]
  > {
    return withScopedDb(this.dataSource, async (m) => {
      const transactions = await m
        .getRepository(ScheduledTransaction)
        .createQueryBuilder("st")
        .leftJoinAndSelect("st.account", "account")
        .leftJoinAndSelect("st.payee", "payee")
        .leftJoinAndSelect("st.category", "category")
        .leftJoinAndSelect("st.transferAccount", "transferAccount")
        .leftJoinAndSelect("st.investmentSecurity", "investmentSecurity")
        .leftJoinAndSelect(
          "st.investmentFundingAccount",
          "investmentFundingAccount",
        )
        .leftJoinAndSelect("st.splits", "splits")
        .leftJoinAndSelect("splits.category", "splitCategory")
        .leftJoinAndSelect("splits.transferAccount", "splitTransferAccount")
        .leftJoinAndSelect("splits.tags", "splitTags")
        .leftJoinAndSelect(
          "splits.investmentSecurity",
          "splitInvestmentSecurity",
        )
        .where("st.userId = :userId", { userId })
        .orderBy("st.nextDueDate", "ASC")
        .getMany();

      if (transactions.length === 0) {
        return [];
      }

      const txDueDates = new Map<string, string>();
      const txIds = transactions.map((t) => {
        const d = ensureYMD(t.nextDueDate);
        txDueDates.set(t.id, d);
        return t.id;
      });

      const nextOverridesQuery = m
        .getRepository(ScheduledTransactionOverride)
        .createQueryBuilder("override")
        .leftJoinAndSelect("override.category", "category");

      const orConditions: string[] = [];
      const params: Record<string, string> = {};
      txIds.forEach((id, i) => {
        orConditions.push(
          `(override.scheduledTransactionId = :id${i} AND override.originalDate = :date${i})`,
        );
        params[`id${i}`] = id;
        params[`date${i}`] = txDueDates.get(id)!;
      });
      nextOverridesQuery.where(orConditions.join(" OR "), params);

      const allNextOverrides = await nextOverridesQuery.getMany();
      const nextOverrideMap = new Map<string, ScheduledTransactionOverride>();
      for (const o of allNextOverrides) {
        nextOverrideMap.set(o.scheduledTransactionId, o);
      }

      // Fetch ALL future overrides (on or after each transaction's nextDueDate)
      const allFutureOverrides = await m
        .getRepository(ScheduledTransactionOverride)
        .createQueryBuilder("override")
        .leftJoinAndSelect("override.category", "category")
        .where("override.scheduledTransactionId IN (:...txIds)", { txIds })
        .orderBy("override.originalDate", "ASC")
        .getMany();

      // Group overrides by transaction and filter to future-only
      const futureOverridesMap = new Map<
        string,
        ScheduledTransactionOverride[]
      >();
      const countMap = new Map<string, number>();
      for (const o of allFutureOverrides) {
        const dueDate = txDueDates.get(o.scheduledTransactionId);
        if (!dueDate) continue;
        const origDate = String(o.originalDate).split("T")[0];
        if (origDate >= dueDate) {
          const list = futureOverridesMap.get(o.scheduledTransactionId) || [];
          list.push(o);
          futureOverridesMap.set(o.scheduledTransactionId, list);
          countMap.set(
            o.scheduledTransactionId,
            (countMap.get(o.scheduledTransactionId) || 0) + 1,
          );
        }
      }

      return transactions.map((transaction) => ({
        ...transaction,
        overrideCount: countMap.get(transaction.id) || 0,
        nextOverride: nextOverrideMap.get(transaction.id) || null,
        futureOverrides: futureOverridesMap.get(transaction.id) || [],
      }));
    });
  }

  async findOne(userId: string, id: string): Promise<ScheduledTransaction> {
    const scheduled = await withScopedDb(this.dataSource, (m) =>
      m.getRepository(ScheduledTransaction).findOne({
        where: { id, userId },
        relations: INVESTMENT_RELATIONS,
      }),
    );

    if (!scheduled) {
      throw new NotFoundException(
        tr(
          "errors.scheduled.notFound",
          `Scheduled transaction with ID ${id} not found`,
          { id },
        ),
      );
    }

    return scheduled;
  }

  async findDue(userId: string): Promise<ScheduledTransaction[]> {
    const today = todayYMD();

    return withScopedDb(this.dataSource, async (m) => {
      const candidates = await m.getRepository(ScheduledTransaction).find({
        where: {
          userId,
          isActive: true,
          nextDueDate: LessThanOrEqual(today) as any,
        },
        relations: INVESTMENT_RELATIONS,
        order: { nextDueDate: "ASC" },
      });

      // Defer candidates whose next occurrence has an override pushing the
      // effective date past today.
      const postponedIds = await this.findPostponedIds(
        candidates.map((t) => t.id),
        today,
      );
      const dueByDate = candidates.filter((t) => !postponedIds.has(t.id));

      // Also find transactions with overrides that moved the date earlier
      const overrideDueIds = await m
        .getRepository(ScheduledTransactionOverride)
        .createQueryBuilder("o")
        .innerJoin("o.scheduledTransaction", "st")
        .where("o.overrideDate <= :today", { today })
        .andWhere("o.originalDate = st.nextDueDate")
        .andWhere("st.userId = :userId", { userId })
        .andWhere("st.isActive = :active", { active: true })
        .select("st.id", "id")
        .distinct(true)
        .getRawMany();

      const dueByDateIds = new Set(dueByDate.map((t) => t.id));
      const overrideOnlyIds = overrideDueIds
        .map((r) => r.id as string)
        .filter((id) => !dueByDateIds.has(id));

      if (overrideOnlyIds.length === 0) {
        return dueByDate;
      }

      const overrideDueTransactions = await m
        .getRepository(ScheduledTransaction)
        .find({
          where: overrideOnlyIds.map((id) => ({ id })),
          relations: INVESTMENT_RELATIONS,
        });

      return [...dueByDate, ...overrideDueTransactions];
    });
  }

  async findUpcoming(
    userId: string,
    days: number = 30,
  ): Promise<ScheduledTransaction[]> {
    const futureDate = new Date();
    futureDate.setDate(futureDate.getDate() + days);

    return withScopedDb(this.dataSource, (m) =>
      m
        .getRepository(ScheduledTransaction)
        .createQueryBuilder("st")
        .leftJoinAndSelect("st.account", "account")
        .leftJoinAndSelect("st.payee", "payee")
        .leftJoinAndSelect("st.category", "category")
        .leftJoinAndSelect("st.transferAccount", "transferAccount")
        .leftJoinAndSelect("st.investmentSecurity", "investmentSecurity")
        .leftJoinAndSelect(
          "st.investmentFundingAccount",
          "investmentFundingAccount",
        )
        .leftJoinAndSelect("st.splits", "splits")
        .leftJoinAndSelect("splits.category", "splitCategory")
        .leftJoinAndSelect("splits.transferAccount", "splitTransferAccount")
        .leftJoinAndSelect("splits.tags", "splitTags")
        .leftJoinAndSelect(
          "splits.investmentSecurity",
          "splitInvestmentSecurity",
        )
        .where("st.userId = :userId", { userId })
        .andWhere("st.isActive = :isActive", { isActive: true })
        .andWhere("st.nextDueDate <= :futureDate", { futureDate })
        .orderBy("st.nextDueDate", "ASC")
        .getMany(),
    );
  }

  /**
   * Curated upcoming bills/deposits payload for AI Assistant and MCP. Both
   * surfaces must return the same shape; the executor and MCP tool are thin
   * adapters around this method.
   *
   * Items are classified by `kind` (bill / deposit / transfer / investment)
   * so the LLM can answer "what bills are due" or "what deposits are coming
   * in" without re-deriving sign or transfer/investment flags.
   */
  async getLlmUpcomingBillsAndDeposits(
    userId: string,
    filter: LlmUpcomingFilter = {},
  ): Promise<LlmUpcomingScheduledResult> {
    const days = filter.days ?? 30;
    const rows = await this.findUpcoming(userId, days);
    const today = todayYMD();
    const items = rows
      .map((r) => toLlmScheduledItem(r, today))
      .filter((item) => matchesScheduledFilter(item, filter));

    const billAmounts = items
      .filter((i) => i.kind === "bill")
      .map((i) => Math.abs(i.amount));
    const depositAmounts = items
      .filter((i) => i.kind === "deposit")
      .map((i) => i.amount);

    return {
      daysWindow: days,
      itemCount: items.length,
      overdueCount: items.filter((i) => i.daysUntilDue < 0).length,
      totalUpcomingBills: sumMoney(billAmounts),
      totalUpcomingDeposits: sumMoney(depositAmounts),
      items,
    };
  }

  async update(
    userId: string,
    id: string,
    updateDto: UpdateScheduledTransactionDto,
  ): Promise<ScheduledTransaction> {
    const scheduled = await this.findOne(userId, id);
    const beforeData = { ...scheduled };

    const effectiveIsInvestment =
      updateDto.isInvestment !== undefined
        ? updateDto.isInvestment
        : scheduled.isInvestment;
    const effectiveIsTransfer =
      updateDto.isTransfer !== undefined
        ? updateDto.isTransfer
        : scheduled.isTransfer;
    if (effectiveIsInvestment && effectiveIsTransfer) {
      throw new BadRequestException(
        tr(
          "errors.scheduled.notTransferAndInvestment",
          "A scheduled transaction cannot be both a transfer and an investment",
        ),
      );
    }

    let accountCurrencyCode = scheduled.currencyCode;
    if (updateDto.accountId && updateDto.accountId !== scheduled.accountId) {
      const nextAccount = await this.accountsService.findOne(
        userId,
        updateDto.accountId,
      );
      accountCurrencyCode = nextAccount.currencyCode;
    }

    if (updateDto.isTransfer && updateDto.transferAccountId) {
      await this.accountsService.findOne(userId, updateDto.transferAccountId);
      const accountId = updateDto.accountId || scheduled.accountId;
      if (updateDto.transferAccountId === accountId) {
        throw new BadRequestException(
          tr(
            "errors.scheduled.sameSourceAndDestination",
            "Source and destination accounts must be different",
          ),
        );
      }
    }

    if (effectiveIsInvestment) {
      const accountId = updateDto.accountId || scheduled.accountId;
      const account = await this.accountsService.findOne(userId, accountId);
      if (account.accountSubType !== AccountSubType.INVESTMENT_BROKERAGE) {
        throw new BadRequestException(
          tr(
            "errors.scheduled.requiresBrokerageAccount",
            "Scheduled investment transactions require a brokerage account",
          ),
        );
      }
      const merged = {
        investmentAction:
          updateDto.investmentAction ??
          (scheduled.investmentAction as InvestmentAction | undefined),
        investmentSecurityId:
          updateDto.investmentSecurityId ?? scheduled.investmentSecurityId,
        investmentQuantity:
          updateDto.investmentQuantity ?? scheduled.investmentQuantity,
        investmentPrice: updateDto.investmentPrice ?? scheduled.investmentPrice,
        investmentTotalAmount:
          updateDto.investmentTotalAmount ?? scheduled.investmentTotalAmount,
      };
      this.validateInvestmentFields(merged);
      if (updateDto.investmentFundingAccountId) {
        await this.accountsService.findOne(
          userId,
          updateDto.investmentFundingAccountId,
        );
      }
    }

    const {
      splits,
      isTransfer,
      transferAccountId,
      isInvestment,
      ...updateData
    } = updateDto;

    // Validate splits before opening the transaction so user errors fail fast
    // without holding a connection.
    if (splits !== undefined && Array.isArray(splits) && splits.length > 0) {
      const amount = updateData.amount ?? scheduled.amount;
      this.validateSplits(splits, amount);
    }

    const fieldsToUpdate: Record<string, any> = {};
    // Set when switching to transfer/investment mode, which clears any splits.
    let clearSplitsForModeSwitch = false;

    if (updateData.accountId !== undefined)
      fieldsToUpdate.accountId = updateData.accountId;
    if (updateData.name !== undefined) fieldsToUpdate.name = updateData.name;
    if (updateData.payeeId !== undefined)
      fieldsToUpdate.payeeId = updateData.payeeId || null;
    if (updateData.payeeName !== undefined)
      fieldsToUpdate.payeeName = updateData.payeeName || null;
    if (updateData.categoryId !== undefined)
      fieldsToUpdate.categoryId = updateData.categoryId || null;
    if (updateData.amount !== undefined)
      fieldsToUpdate.amount = updateData.amount;
    if (updateData.currencyCode !== undefined)
      fieldsToUpdate.currencyCode = updateData.currencyCode;

    // Foreign-currency entry. Only a plain schedule can carry one, so switching
    // an existing foreign-currency schedule to split/transfer/investment clears
    // the trio rather than leaving an amount nothing re-derives.
    const effectiveIsSplit =
      splits !== undefined
        ? Array.isArray(splits) && splits.length > 0 && !effectiveIsTransfer
        : scheduled.isSplit;
    const fxKind = {
      isSplit: effectiveIsSplit,
      isTransfer: effectiveIsTransfer,
      isInvestment: effectiveIsInvestment,
    };

    if (effectiveIsSplit || effectiveIsTransfer || effectiveIsInvestment) {
      // Throws when the payload actually supplied a foreign entry.
      this.resolveScheduleFx(updateData, accountCurrencyCode, fxKind);
      if (scheduled.originalCurrencyCode) {
        fieldsToUpdate.originalAmount = null;
        fieldsToUpdate.originalCurrencyCode = null;
        fieldsToUpdate.exchangeRate = 1;
      }
    } else if (
      updateData.originalAmount !== undefined ||
      updateData.originalCurrencyCode !== undefined ||
      updateData.exchangeRate !== undefined
    ) {
      const fx = this.resolveScheduleFx(
        {
          amount: updateData.amount ?? Number(scheduled.amount),
          originalAmount:
            updateData.originalAmount !== undefined
              ? updateData.originalAmount
              : scheduled.originalAmount,
          originalCurrencyCode:
            updateData.originalCurrencyCode !== undefined
              ? updateData.originalCurrencyCode
              : scheduled.originalCurrencyCode,
          exchangeRate:
            updateData.exchangeRate !== undefined
              ? updateData.exchangeRate
              : scheduled.exchangeRate,
        },
        accountCurrencyCode,
        fxKind,
      );
      fieldsToUpdate.originalAmount = fx.originalAmount;
      fieldsToUpdate.originalCurrencyCode = fx.originalCurrencyCode;
      fieldsToUpdate.exchangeRate = fx.exchangeRate;
    }
    if (updateData.description !== undefined)
      fieldsToUpdate.description = updateData.description || null;
    if (updateData.frequency !== undefined)
      fieldsToUpdate.frequency = updateData.frequency;
    if (updateData.nextDueDate !== undefined)
      fieldsToUpdate.nextDueDate = updateData.nextDueDate;
    if (updateData.startDate !== undefined)
      fieldsToUpdate.startDate = updateData.startDate;
    if (updateData.endDate !== undefined)
      fieldsToUpdate.endDate = updateData.endDate || null;
    if (updateData.occurrencesRemaining !== undefined)
      fieldsToUpdate.occurrencesRemaining =
        updateData.occurrencesRemaining ?? null;
    if (updateData.isActive !== undefined)
      fieldsToUpdate.isActive = updateData.isActive;
    if (updateData.autoPost !== undefined)
      fieldsToUpdate.autoPost = updateData.autoPost;
    if (updateData.reminderDaysBefore !== undefined)
      fieldsToUpdate.reminderDaysBefore = updateData.reminderDaysBefore;
    if (updateData.tagIds !== undefined)
      fieldsToUpdate.tagIds = updateData.tagIds;

    if (isTransfer !== undefined) {
      fieldsToUpdate.isTransfer = isTransfer;
      if (isTransfer) {
        fieldsToUpdate.isSplit = false;
        // Keep categoryId: a transfer may carry an optional category (#743). It
        // is controlled by updateData.categoryId above, not cleared here.
        fieldsToUpdate.isInvestment = false;
        fieldsToUpdate.investmentAction = null;
        fieldsToUpdate.investmentSecurityId = null;
        fieldsToUpdate.investmentFundingAccountId = null;
        fieldsToUpdate.investmentQuantity = null;
        fieldsToUpdate.investmentPrice = null;
        fieldsToUpdate.investmentCommission = null;
        fieldsToUpdate.investmentTotalAmount = null;
        fieldsToUpdate.investmentExchangeRate = null;
        clearSplitsForModeSwitch = true;
      }
    }
    if (transferAccountId !== undefined) {
      fieldsToUpdate.transferAccountId = transferAccountId || null;
    }

    if (isInvestment !== undefined) {
      fieldsToUpdate.isInvestment = isInvestment;
      if (isInvestment) {
        fieldsToUpdate.isSplit = false;
        fieldsToUpdate.isTransfer = false;
        fieldsToUpdate.categoryId = null;
        fieldsToUpdate.transferAccountId = null;
        clearSplitsForModeSwitch = true;
      } else {
        fieldsToUpdate.investmentAction = null;
        fieldsToUpdate.investmentSecurityId = null;
        fieldsToUpdate.investmentFundingAccountId = null;
        fieldsToUpdate.investmentQuantity = null;
        fieldsToUpdate.investmentPrice = null;
        fieldsToUpdate.investmentCommission = null;
        fieldsToUpdate.investmentTotalAmount = null;
        fieldsToUpdate.investmentExchangeRate = null;
      }
    }
    if (effectiveIsInvestment) {
      if (updateData.investmentAction !== undefined)
        fieldsToUpdate.investmentAction = updateData.investmentAction;
      if (updateData.investmentSecurityId !== undefined)
        fieldsToUpdate.investmentSecurityId =
          updateData.investmentSecurityId || null;
      if (updateData.investmentFundingAccountId !== undefined)
        fieldsToUpdate.investmentFundingAccountId =
          updateData.investmentFundingAccountId || null;
      if (updateData.investmentQuantity !== undefined)
        fieldsToUpdate.investmentQuantity =
          updateData.investmentQuantity ?? null;
      if (updateData.investmentPrice !== undefined)
        fieldsToUpdate.investmentPrice = updateData.investmentPrice ?? null;
      if (updateData.investmentCommission !== undefined)
        fieldsToUpdate.investmentCommission =
          updateData.investmentCommission ?? null;
      if (updateData.investmentTotalAmount !== undefined)
        fieldsToUpdate.investmentTotalAmount =
          updateData.investmentTotalAmount ?? null;
      if (updateData.investmentExchangeRate !== undefined)
        fieldsToUpdate.investmentExchangeRate =
          updateData.investmentExchangeRate ?? null;
    }

    // Apply the split rewrite, any mode-switch split clearing, and the main
    // row update atomically so a partial failure cannot leave the row and its
    // splits in an inconsistent state.
    await withScopedDb(this.dataSource, async (m) => {
      if (splits !== undefined) {
        if (Array.isArray(splits) && splits.length > 0) {
          await m.delete(ScheduledTransactionSplit, {
            scheduledTransactionId: id,
          });
          await this.createSplits(id, splits, m);
          await m.update(ScheduledTransaction, id, {
            isSplit: true,
            categoryId: null,
          });
        } else if (Array.isArray(splits) && splits.length === 0) {
          await m.delete(ScheduledTransactionSplit, {
            scheduledTransactionId: id,
          });
          await m.update(ScheduledTransaction, id, {
            isSplit: false,
          });
        }
      }

      if (clearSplitsForModeSwitch) {
        await m.delete(ScheduledTransactionSplit, {
          scheduledTransactionId: id,
        });
      }

      if (Object.keys(fieldsToUpdate).length > 0) {
        await m.update(ScheduledTransaction, id, fieldsToUpdate);
      }
    });

    const result = await this.findOne(userId, id);

    this.actionHistoryService.record(userId, {
      entityType: "scheduled_transaction",
      entityId: id,
      action: "update",
      beforeData,
      afterData: { ...result },
      description: `Updated scheduled transaction "${result.name}"`,
      descriptionKey: "updatedScheduledTransaction",
      descriptionParams: { name: result.name },
    });

    return result;
  }

  async remove(userId: string, id: string): Promise<void> {
    const scheduled = await this.findOne(userId, id);
    const beforeData = { ...scheduled };
    await withScopedDb(this.dataSource, (m) =>
      m.getRepository(ScheduledTransaction).remove(scheduled),
    );

    this.actionHistoryService.record(userId, {
      entityType: "scheduled_transaction",
      entityId: beforeData.id,
      action: "delete",
      beforeData,
      description: `Deleted scheduled transaction "${beforeData.name}"`,
      descriptionKey: "deletedScheduledTransaction",
      descriptionParams: { name: beforeData.name },
    });
  }

  async skip(userId: string, id: string): Promise<ScheduledTransaction> {
    const scheduled = await this.findOne(userId, id);

    const nextDueDateStr = ensureYMD(scheduled.nextDueDate);

    const newNextDueDateStr = calcNextDueDate(
      nextDueDateStr,
      scheduled.frequency,
    );

    const updateFields: Record<string, any> = {
      nextDueDate: newNextDueDateStr,
    };

    if (
      scheduled.occurrencesRemaining !== null &&
      scheduled.occurrencesRemaining > 0
    ) {
      const newRemaining = scheduled.occurrencesRemaining - 1;
      updateFields.occurrencesRemaining = newRemaining;
      if (newRemaining === 0) {
        updateFields.isActive = false;
      }
    }

    if (scheduled.endDate && newNextDueDateStr > ensureYMD(scheduled.endDate)) {
      updateFields.isActive = false;
    }

    await withScopedDb(this.dataSource, async (m) => {
      await m.getRepository(ScheduledTransactionOverride).delete({
        scheduledTransactionId: id,
        originalDate: nextDueDateStr,
      });
      await m.getRepository(ScheduledTransaction).update(id, updateFields);
    });
    return this.findOne(userId, id);
  }

  /**
   * Work out the foreign amount, rate and account-currency total for one
   * posting of a foreign-currency schedule. Returns null for an ordinary
   * schedule, leaving the existing amount precedence untouched.
   *
   * Precedence, highest first:
   *   1. `postDto.amount`, else the occurrence override's amount -- both are
   *      account-currency totals. An override deliberately stays in the account
   *      currency (it means "this month the bank actually took $X"), which is
   *      also what every reader of `override.amount` already assumes: the bills
   *      list, the forecast, the budget and dashboard widgets. The fee is
   *      backed out and the rate derived from the base so the posted row still
   *      round-trips (originalAmount x exchangeRate ~ base).
   *   2. `postDto.exchangeRate` -- an explicit rate for this posting.
   *   3. The stored rate for the posting date (`getRateForDate`, which
   *      carry-forwards over weekends and backfills from the quote provider).
   *
   * The foreign amount comes from `postDto.originalAmount`, else the schedule's
   * own `originalAmount`.
   */
  private async resolveFxForPosting(
    scheduled: ScheduledTransaction,
    postDto: PostScheduledTransactionDto | undefined,
    context: { postDate: string; overrideAmount: number | null },
  ): Promise<{
    originalAmount: number;
    exchangeRate: number;
    amount: number;
  } | null> {
    if (!scheduled.originalCurrencyCode || scheduled.originalAmount === null) {
      return null;
    }

    const originalAmount =
      postDto?.originalAmount !== undefined && postDto?.originalAmount !== null
        ? Number(postDto.originalAmount)
        : Number(scheduled.originalAmount);

    const fxFeePercent = scheduled.account?.fxFeePercent ?? null;

    // 1. An explicit account-currency total wins; derive the rate from it.
    const pinnedTotal =
      postDto?.amount !== undefined && postDto?.amount !== null
        ? Number(postDto.amount)
        : context.overrideAmount !== null
          ? Number(context.overrideAmount)
          : null;
    if (pinnedTotal !== null) {
      let base = pinnedTotal;
      if (fxFeePercent && fxFeePercent > 0) {
        // total = base - |base| x p; solve for base by its (matching) sign.
        const p = fxFeePercent / 100;
        base = roundMoney(
          pinnedTotal >= 0 ? pinnedTotal / (1 - p) : pinnedTotal / (1 + p),
        );
      }
      return {
        originalAmount,
        exchangeRate:
          originalAmount === 0 ? 1 : roundFxRate(base / originalAmount),
        amount: roundMoney(pinnedTotal),
      };
    }

    // 2/3. An explicit rate, else the rate that applied on the posting date.
    const rate =
      postDto?.exchangeRate !== undefined && postDto?.exchangeRate !== null
        ? Number(postDto.exchangeRate)
        : await this.exchangeRateService.getRateForDate(
            scheduled.originalCurrencyCode,
            scheduled.currencyCode,
            context.postDate,
          );

    if (rate === null || !isFinite(rate) || rate <= 0) {
      throw new BadRequestException(
        tr(
          "errors.scheduled.fxRateUnavailable",
          `No exchange rate is available for ${scheduled.originalCurrencyCode} to ${scheduled.currencyCode} on ${context.postDate}. Enter the amount in ${scheduled.currencyCode} to post it.`,
          {
            from: scheduled.originalCurrencyCode,
            to: scheduled.currencyCode,
            date: context.postDate,
          },
        ),
      );
    }

    const converted = applyFxConversion(originalAmount, rate, fxFeePercent);
    return {
      originalAmount,
      exchangeRate: roundFxRate(rate),
      amount: converted.amount,
    };
  }

  async post(
    userId: string,
    id: string,
    postDto?: PostScheduledTransactionDto,
  ): Promise<ScheduledTransaction | null> {
    const scheduled = await this.findOne(userId, id);

    const nextDueDateStr = ensureYMD(scheduled.nextDueDate);

    const storedOverride = await withScopedDb(this.dataSource, (m) =>
      m
        .getRepository(ScheduledTransactionOverride)
        .createQueryBuilder("override")
        .where("override.scheduledTransactionId = :id", { id })
        .andWhere("override.originalDate = :nextDueDateStr", { nextDueDateStr })
        .getOne(),
    );

    const postDate =
      postDto?.transactionDate ||
      storedOverride?.overrideDate ||
      nextDueDateStr;

    const hasInlineAmount =
      postDto?.amount !== undefined && postDto?.amount !== null;
    const hasInlineCategoryId = postDto?.categoryId !== undefined;
    const hasInlineDescription = postDto?.description !== undefined;
    const hasInlineIsSplit =
      postDto?.isSplit !== undefined && postDto?.isSplit !== null;
    const hasInlineSplits = postDto?.splits && postDto.splits.length > 0;

    // A foreign-currency schedule holds its fixed amount in the entry currency,
    // so every per-occurrence amount -- the schedule's own, a stored override,
    // an inline `originalAmount` -- is read in that currency and converted at
    // the rate for the posting date. That is what makes a back-dated or
    // future-dated posting use that day's rate rather than the estimate the
    // bills list was showing.
    const fx = await this.resolveFxForPosting(scheduled, postDto, {
      postDate,
      overrideAmount: storedOverride?.amount ?? null,
    });

    const finalAmount = fx
      ? fx.amount
      : hasInlineAmount
        ? Number(postDto.amount)
        : storedOverride?.amount !== null &&
            storedOverride?.amount !== undefined
          ? Number(storedOverride.amount)
          : Number(scheduled.amount);

    const finalDescription = hasInlineDescription
      ? postDto.description
      : storedOverride?.description !== null &&
          storedOverride?.description !== undefined
        ? storedOverride.description
        : scheduled.description || undefined;

    const transactionPayload: any = {
      accountId: scheduled.accountId,
      transactionDate: postDate,
      payeeId: scheduled.payeeId || undefined,
      payeeName: scheduled.payeeName || undefined,
      amount: finalAmount,
      currencyCode: scheduled.currencyCode,
      description: finalDescription,
      referenceNumber: postDto?.referenceNumber || undefined,
      isCleared: false,
      tagIds:
        scheduled.tagIds && scheduled.tagIds.length > 0
          ? scheduled.tagIds
          : undefined,
      ...(fx
        ? {
            originalAmount: fx.originalAmount,
            originalCurrencyCode: scheduled.originalCurrencyCode,
            exchangeRate: fx.exchangeRate,
          }
        : {}),
    };

    const useSplits = hasInlineIsSplit
      ? postDto.isSplit
      : storedOverride?.isSplit !== null &&
          storedOverride?.isSplit !== undefined
        ? storedOverride.isSplit
        : scheduled.isSplit;

    if (useSplits) {
      if (hasInlineSplits && postDto?.splits) {
        transactionPayload.splits = postDto.splits.map((split) => ({
          splitKind: split.splitKind,
          categoryId: split.categoryId || undefined,
          transferAccountId: split.transferAccountId || undefined,
          investment: split.investment,
          amount: Number(split.amount),
          memo: split.memo || undefined,
        }));
      } else if (storedOverride?.splits && storedOverride.splits.length > 0) {
        transactionPayload.splits = storedOverride.splits.map((split: any) => ({
          splitKind: split.splitKind,
          categoryId: split.categoryId || undefined,
          transferAccountId: split.transferAccountId || undefined,
          investment: split.investment,
          amount: Number(split.amount),
          memo: split.memo || undefined,
        }));
      } else if (scheduled.splits && scheduled.splits.length > 0) {
        transactionPayload.splits = scheduled.splits.map((split) => ({
          splitKind: split.kind,
          categoryId: split.categoryId || undefined,
          transferAccountId: split.transferAccountId || undefined,
          investment:
            split.kind === SplitKind.INVESTMENT && split.investmentAction
              ? {
                  action: split.investmentAction,
                  securityId: split.investmentSecurityId || undefined,
                  quantity:
                    split.investmentQuantity !== null &&
                    split.investmentQuantity !== undefined
                      ? Number(split.investmentQuantity)
                      : undefined,
                  price:
                    split.investmentPrice !== null &&
                    split.investmentPrice !== undefined
                      ? Number(split.investmentPrice)
                      : undefined,
                  commission:
                    split.investmentCommission !== null &&
                    split.investmentCommission !== undefined
                      ? Number(split.investmentCommission)
                      : undefined,
                  exchangeRate:
                    split.investmentExchangeRate !== null &&
                    split.investmentExchangeRate !== undefined
                      ? Number(split.investmentExchangeRate)
                      : undefined,
                }
              : undefined,
          amount: Number(split.amount),
          memo: split.memo || undefined,
          tagIds:
            split.tags && split.tags.length > 0
              ? split.tags.map((t) => t.id)
              : undefined,
        }));
      }
    } else {
      const finalCategoryId = hasInlineCategoryId
        ? postDto.categoryId
        : storedOverride?.categoryId !== null &&
            storedOverride?.categoryId !== undefined
          ? storedOverride.categoryId
          : scheduled.categoryId || undefined;
      transactionPayload.categoryId = finalCategoryId || undefined;
    }

    // ONE transaction from here down: the occurrence claim, the money it
    // creates, the override it consumes and the schedule advancement.
    //
    // Before this, the financial transaction committed in its own transaction
    // and `nextDueDate` advanced in a second one. Every way of getting between
    // the two produced the same bill paid twice -- two replicas firing the same
    // hourly cron, a manual post racing it, or a crash after the money
    // committed. Opening balance 100.00 and one due -50.00: the account ends at
    // 0.00 instead of 50.00 (audit P4-004).
    //
    // Nested service calls join this transaction, so a refusal below rolls the
    // money back with it. Everything that reaches outside PostgreSQL -- the FX
    // rate lookup in particular -- has already run above.
    const removedAfterOnce = await withScopedDb(this.dataSource, async (m) => {
      // Lock the schedule and confirm this occurrence is still the due one. A
      // poster that lost the race finds next_due_date already advanced.
      const current = await m.findOne(ScheduledTransaction, {
        where: { id, userId },
        lock: { mode: "pessimistic_write" },
      });
      if (!current) {
        throw new NotFoundException(
          tr(
            "errors.scheduled.notFound",
            `Scheduled transaction with ID ${id} not found`,
            { id },
          ),
        );
      }
      if (ensureYMD(current.nextDueDate) !== nextDueDateStr) {
        throw new ConflictException(
          tr(
            "errors.scheduled.occurrenceAlreadyPosted",
            "This occurrence has already been posted.",
          ),
        );
      }

      // Claim the occurrence. The unique key on
      // (scheduled_transaction_id, original_due_date) is what makes the claim
      // the serialization point rather than the lock alone: it survives a
      // crash, and manual and automatic posting both go through it.
      const claim: unknown = await m.query(
        `INSERT INTO scheduled_transaction_postings
           (scheduled_transaction_id, original_due_date, posted_date)
         VALUES ($1, $2, $3)
         ON CONFLICT (scheduled_transaction_id, original_due_date) DO NOTHING
         RETURNING id`,
        [id, nextDueDateStr, postDate],
      );
      if (affectedRowCount(claim) === 0) {
        throw new ConflictException(
          tr(
            "errors.scheduled.occurrenceAlreadyPosted",
            "This occurrence has already been posted.",
          ),
        );
      }

      if (scheduled.isInvestment) {
        await this.postInvestment(
          userId,
          scheduled,
          postDto,
          postDate,
          storedOverride,
        );
      } else if (scheduled.isTransfer && scheduled.transferAccountId) {
        // Carry the schedule's category onto the posted transfer (both legs),
        // so a categorized scheduled transfer behaves like a one-off one
        // (#743). Same precedence as the non-transfer branch: inline override >
        // stored occurrence override > the schedule's own category.
        const transferCategoryId = hasInlineCategoryId
          ? postDto.categoryId
          : storedOverride?.categoryId !== null &&
              storedOverride?.categoryId !== undefined
            ? storedOverride.categoryId
            : scheduled.categoryId || undefined;
        await this.transactionsService.createTransfer(userId, {
          fromAccountId: scheduled.accountId,
          toAccountId: scheduled.transferAccountId,
          amount: Math.abs(finalAmount),
          transactionDate: postDate,
          fromCurrencyCode: scheduled.currencyCode,
          description: finalDescription || undefined,
          referenceNumber: postDto?.referenceNumber || undefined,
          payeeId: scheduled.payeeId || undefined,
          payeeName: scheduled.payeeName || undefined,
          categoryId: transferCategoryId || undefined,
          tagIds:
            scheduled.tagIds && scheduled.tagIds.length > 0
              ? scheduled.tagIds
              : undefined,
        });
      } else {
        await this.transactionsService.create(userId, transactionPayload);
      }

      if (storedOverride) {
        await m.remove(storedOverride);
      }

      if (current.frequency === "ONCE") {
        // One-time bill or deposit: remove the scheduled transaction entirely
        // after posting so it disappears from the Bills & Deposits page.
        // Splits, overrides and the posting claim are cleaned up via
        // ON DELETE CASCADE.
        await m.delete(ScheduledTransaction, id);
        return true;
      }

      // Recurring frequency: advance nextDueDate, prune stale overrides,
      // decrement occurrencesRemaining, deactivate if past endDate.
      //
      // Read from `current`, the locked row, not from the `scheduled` snapshot
      // taken before the transaction: a concurrent edit to occurrencesRemaining
      // or endDate would otherwise be reverted by this advancement.
      const newNextDueDateStr = calcNextDueDate(
        nextDueDateStr,
        current.frequency,
      );

      await m
        .createQueryBuilder()
        .delete()
        .from(ScheduledTransactionOverride)
        .where("scheduledTransactionId = :id", { id })
        .andWhere("originalDate < :newNextDueDate", {
          newNextDueDate: newNextDueDateStr,
        })
        .execute();

      const updateFields: Record<string, any> = {
        lastPostedDate: todayYMD(),
        nextDueDate: newNextDueDateStr,
      };

      if (
        current.occurrencesRemaining !== null &&
        current.occurrencesRemaining > 0
      ) {
        const newRemaining = current.occurrencesRemaining - 1;
        updateFields.occurrencesRemaining = newRemaining;
        if (newRemaining === 0) {
          updateFields.isActive = false;
        }
      }

      if (current.endDate && newNextDueDateStr > ensureYMD(current.endDate)) {
        updateFields.isActive = false;
      }

      await m.update(ScheduledTransaction, id, updateFields);
      return false;
    });

    if (removedAfterOnce) {
      return null;
    }

    if (scheduled.splits && scheduled.splits.length > 0) {
      const loanAccountId = await this.loanService.findLoanAccountFromSplits(
        scheduled.splits,
      );
      if (loanAccountId) {
        await this.loanService.recalculateLoanPaymentSplits(id, loanAccountId);
      }
    }

    return this.findOne(userId, id);
  }

  private async postInvestment(
    userId: string,
    scheduled: ScheduledTransaction,
    postDto: PostScheduledTransactionDto | undefined,
    postDate: string,
    storedOverride: ScheduledTransactionOverride | null,
  ): Promise<void> {
    const action = scheduled.investmentAction as InvestmentAction | null;
    if (!action) {
      throw new BadRequestException(
        tr(
          "errors.scheduled.missingInvestmentAction",
          "Scheduled investment transaction is missing an action",
        ),
      );
    }

    // Precedence for investment fields at post time: explicit postDto value
    // (one-time tweak entered in the Post dialog) > stored per-occurrence
    // override (saved on a future occurrence) > base scheduled transaction.
    const pickInvestmentValue = (
      inline: number | null | undefined,
      override: number | null | undefined,
      base: number | null | undefined,
    ): number | undefined => {
      if (inline !== undefined && inline !== null) return Number(inline);
      if (override !== undefined && override !== null) return Number(override);
      if (base !== undefined && base !== null) return Number(base);
      return undefined;
    };

    const quantity = pickInvestmentValue(
      postDto?.investmentQuantity,
      storedOverride?.investmentQuantity,
      scheduled.investmentQuantity,
    );

    const price = pickInvestmentValue(
      postDto?.investmentPrice,
      storedOverride?.investmentPrice,
      scheduled.investmentPrice,
    );

    const totalAmount = pickInvestmentValue(
      postDto?.investmentTotalAmount,
      storedOverride?.investmentTotalAmount,
      scheduled.investmentTotalAmount,
    );

    const commission =
      scheduled.investmentCommission !== null &&
      scheduled.investmentCommission !== undefined
        ? Number(scheduled.investmentCommission)
        : undefined;

    const exchangeRate =
      scheduled.investmentExchangeRate !== null &&
      scheduled.investmentExchangeRate !== undefined
        ? Number(scheduled.investmentExchangeRate)
        : undefined;

    const description =
      postDto?.description !== undefined
        ? postDto.description || undefined
        : scheduled.description || undefined;

    const dto: any = {
      accountId: scheduled.accountId,
      action,
      transactionDate: postDate,
      securityId: scheduled.investmentSecurityId || undefined,
      fundingAccountId: scheduled.investmentFundingAccountId || undefined,
      description,
    };

    if (QUANTITY_PRICE_ACTIONS.has(action)) {
      dto.quantity = quantity;
      dto.price = price;
      if (commission !== undefined) dto.commission = commission;
    } else if (QUANTITY_ONLY_ACTIONS.has(action)) {
      dto.quantity = quantity;
    } else if (AMOUNT_ONLY_ACTIONS.has(action)) {
      // InvestmentTransactionsService computes total_amount from price * quantity
      // for these amount-only actions; pass the desired total via price with
      // quantity=1 if no quantity/price is set, or honour the stored values.
      if (
        quantity !== undefined &&
        price !== undefined &&
        totalAmount === undefined
      ) {
        dto.quantity = quantity;
        dto.price = price;
      } else if (totalAmount !== undefined) {
        dto.quantity = 1;
        dto.price = totalAmount;
      }
    }

    if (exchangeRate !== undefined) dto.exchangeRate = exchangeRate;

    await this.investmentTransactionsService.create(userId, dto);
  }

  private calculateNextDueDate(
    currentDate: Date | string,
    frequency: FrequencyType,
  ): Date {
    const ymd = ensureYMD(currentDate);
    const next = calcNextDueDate(ymd, frequency);
    return new Date(`${next}T00:00:00.000Z`);
  }

  // Delegated override methods

  async createOverride(
    userId: string,
    scheduledTransactionId: string,
    createDto: CreateScheduledTransactionOverrideDto,
  ): Promise<ScheduledTransactionOverride> {
    await this.findOne(userId, scheduledTransactionId);
    return this.overrideService.createOverride(
      scheduledTransactionId,
      createDto,
    );
  }

  async findOverrides(
    userId: string,
    scheduledTransactionId: string,
  ): Promise<ScheduledTransactionOverride[]> {
    await this.findOne(userId, scheduledTransactionId);
    return this.overrideService.findOverrides(scheduledTransactionId);
  }

  async findOverride(
    userId: string,
    scheduledTransactionId: string,
    overrideId: string,
  ): Promise<ScheduledTransactionOverride> {
    await this.findOne(userId, scheduledTransactionId);
    return this.overrideService.findOverride(
      scheduledTransactionId,
      overrideId,
    );
  }

  async findOverrideByDate(
    userId: string,
    scheduledTransactionId: string,
    date: string,
  ): Promise<ScheduledTransactionOverride | null> {
    await this.findOne(userId, scheduledTransactionId);
    return this.overrideService.findOverrideByDate(
      scheduledTransactionId,
      date,
    );
  }

  async updateOverride(
    userId: string,
    scheduledTransactionId: string,
    overrideId: string,
    updateDto: UpdateScheduledTransactionOverrideDto,
  ): Promise<ScheduledTransactionOverride> {
    await this.findOne(userId, scheduledTransactionId);
    return this.overrideService.updateOverride(
      scheduledTransactionId,
      overrideId,
      updateDto,
    );
  }

  async removeOverride(
    userId: string,
    scheduledTransactionId: string,
    overrideId: string,
  ): Promise<void> {
    await this.findOne(userId, scheduledTransactionId);
    return this.overrideService.removeOverride(
      scheduledTransactionId,
      overrideId,
    );
  }

  async removeAllOverrides(
    userId: string,
    scheduledTransactionId: string,
  ): Promise<number> {
    await this.findOne(userId, scheduledTransactionId);
    return this.overrideService.removeAllOverrides(scheduledTransactionId);
  }

  async hasOverrides(
    userId: string,
    scheduledTransactionId: string,
  ): Promise<{ hasOverrides: boolean; count: number }> {
    await this.findOne(userId, scheduledTransactionId);
    return this.overrideService.hasOverrides(scheduledTransactionId);
  }

  async recalculateLoanPaymentSplits(
    scheduledTransactionId: string,
    loanAccountId: string,
  ): Promise<void> {
    return this.loanService.recalculateLoanPaymentSplits(
      scheduledTransactionId,
      loanAccountId,
    );
  }
}

function classifyScheduledKind(row: ScheduledTransaction): LlmScheduledKind {
  if (row.isTransfer) return "transfer";
  if (row.isInvestment) return "investment";
  return Number(row.amount) < 0 ? "bill" : "deposit";
}

function daysBetweenYMD(fromYMD: string, toYMD: string): number {
  const from = new Date(`${fromYMD}T00:00:00.000Z`).getTime();
  const to = new Date(`${toYMD}T00:00:00.000Z`).getTime();
  return Math.round((to - from) / (1000 * 60 * 60 * 24));
}

function toLlmScheduledItem(
  row: ScheduledTransaction,
  todayYMDStr: string,
): LlmScheduledItem {
  const nextDueDate = ensureYMD(row.nextDueDate);
  return {
    id: row.id,
    name: row.name,
    accountId: row.accountId,
    accountName: row.account?.name ?? "",
    payeeName: row.payee?.name ?? row.payeeName ?? null,
    categoryName: row.category?.name ?? null,
    amount: roundMoney(Number(row.amount)),
    currency: row.currencyCode,
    frequency: row.frequency,
    nextDueDate,
    daysUntilDue: daysBetweenYMD(todayYMDStr, nextDueDate),
    isActive: row.isActive,
    autoPost: row.autoPost,
    kind: classifyScheduledKind(row),
    description: row.description ?? null,
  };
}

function matchesScheduledFilter(
  item: LlmScheduledItem,
  filter: LlmScheduledFilter,
): boolean {
  if (filter.kind && filter.kind !== "all" && item.kind !== filter.kind) {
    return false;
  }
  if (filter.isActive !== undefined && item.isActive !== filter.isActive) {
    return false;
  }
  if (
    filter.accountIds &&
    filter.accountIds.length > 0 &&
    !filter.accountIds.includes(item.accountId)
  ) {
    return false;
  }
  return true;
}
