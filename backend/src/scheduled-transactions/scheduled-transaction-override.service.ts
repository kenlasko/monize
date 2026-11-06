import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Logger,
} from "@nestjs/common";
import { randomUUID } from "crypto";
import { DataSource, EntityManager, QueryFailedError } from "typeorm";
import {
  ScheduledTransactionOverride,
  OverrideSplit,
} from "./entities/scheduled-transaction-override.entity";
import {
  CreateScheduledTransactionOverrideDto,
  UpdateScheduledTransactionOverrideDto,
  OverrideSplitDto,
} from "./dto/scheduled-transaction-override.dto";

/**
 * Currency-pair provenance for an override's investment splits (issue #1167),
 * keyed by split index. Derived by the scheduled service, which owns the
 * settlement account; the override service just merges it into the stored jsonb.
 */
export type OverrideInvestmentProvenance = Map<
  number,
  { from: string | null; to: string | null }
>;
import { validateSplitAmountSum } from "../common/split-amount.util";
import { withScopedDb } from "../common/db/scoped-db";
import { assertAmountPrecision } from "../common/amount-precision.util";
import {
  loadCurrencyPlaces,
  moneyDecimalsForCode,
  precisionCurrencyFor,
} from "../common/currency-places.util";
import { FIAT_MONEY_DECIMALS } from "../common/round.util";
import { tr } from "../i18n/translate";

/** PostgreSQL's unique-violation SQLSTATE. */
const UNIQUE_VIOLATION = "23505";

/**
 * The constraint that names an occurrence: one override per recurrence slot
 * (migration 168). Matched by name, so a violation of some OTHER unique
 * constraint on this table is not reported as "you already have an override for
 * that occurrence" -- a message about the wrong thing sends the caller to fix
 * something that is not broken.
 */
const OCCURRENCE_IDENTITY_CONSTRAINT = "uq_sched_txn_overrides_occurrence";

/**
 * Lock, and so prove, every account an override's split lines transfer into.
 * Those ids live in the `splits` JSONB, which no foreign key guards, so nothing
 * else stops a line naming another user's account or one being deleted. The
 * share lock conflicts with the delete's `lockAccountsForBalanceWrite`: an
 * account delete either sees this override in its count or this write waits
 * and then finds the account gone (INV-ACCOUNTDELETE-001).
 */
async function lockOverrideTransferAccounts(
  m: EntityManager,
  scheduledTransactionId: string,
  splits:
    ReadonlyArray<{ transferAccountId?: string | null }> | null | undefined,
): Promise<void> {
  const wanted = [
    ...new Set(
      (splits ?? [])
        .map((s) => s.transferAccountId?.toLowerCase())
        .filter((id): id is string => !!id),
    ),
  ];
  if (wanted.length === 0) return;
  const found: Array<{ id: string }> = await m.query(
    `SELECT a.id
     FROM accounts a
     JOIN scheduled_transactions st
       ON st.id = $2 AND st.user_id = a.user_id
     WHERE a.id = ANY($1::uuid[])
     ORDER BY a.id
     FOR SHARE OF a`,
    [wanted, scheduledTransactionId],
  );
  if (found.length < wanted.length) {
    throw new NotFoundException(
      tr("errors.accounts.notFound", "Account not found"),
    );
  }
}

function isOccurrenceAlreadyOverridden(error: unknown): boolean {
  if (!(error instanceof QueryFailedError)) return false;
  const driver = error.driverError as
    { code?: string; constraint?: string } | undefined;
  return (
    driver?.code === UNIQUE_VIOLATION &&
    driver?.constraint === OCCURRENCE_IDENTITY_CONSTRAINT
  );
}

@Injectable()
export class ScheduledTransactionOverrideService {
  private readonly logger = new Logger(
    ScheduledTransactionOverrideService.name,
  );

  constructor(private dataSource: DataSource) {}

  /**
   * Reshape override split DTOs into the stored jsonb, merging in the
   * currency-pair provenance for any investment split that carries a rate
   * (issue #1167). The pair travels inside the split's `investment` object so
   * the posting path can tell a still-valid stored rate from a stale one.
   */
  private buildOverrideSplits(
    splits: OverrideSplitDto[] | null | undefined,
    investmentProvenance?: OverrideInvestmentProvenance,
  ): OverrideSplit[] | null {
    return (
      splits?.map((s, index) => {
        const pair = investmentProvenance?.get(index);
        // When the service decided a pair for this split, apply it -- including a
        // deliberate null (a legacy or unverifiable rate the server refuses to
        // bless, #1167 R7-F2), which overwrites any stale pair the client echoed
        // with "unprovenanced" (undefined) so posting re-resolves it.
        const investment =
          s.investment && pair
            ? {
                ...s.investment,
                exchangeRateFromCurrency: pair.from ?? undefined,
                exchangeRateToCurrency: pair.to ?? undefined,
              }
            : s.investment;
        return {
          // Preserve the stable id a continuing split echoes (sourceSplitId), or
          // mint one for a new split, so identity survives across edits (#1167 F4).
          id: s.sourceSplitId ?? randomUUID(),
          splitKind: s.splitKind,
          categoryId: s.categoryId ?? null,
          transferAccountId: s.transferAccountId ?? null,
          investment,
          amount: s.amount,
          memo: s.memo ?? null,
        };
      }) ?? null
    );
  }

  async createOverride(
    scheduledTransactionId: string,
    createDto: CreateScheduledTransactionOverrideDto,
    investmentProvenance?: OverrideInvestmentProvenance,
    amountCurrencyCode?: string,
  ): Promise<ScheduledTransactionOverride> {
    return withScopedDb(this.dataSource, async (m) => {
      const decimals = await this.assertOverrideAmountsPrecision(
        m,
        amountCurrencyCode,
        createDto,
      );
      const repo = m.getRepository(ScheduledTransactionOverride);
      // The friendly refusal, for the ordinary case. It is NOT what makes one
      // override per occurrence true: a SELECT is not a lock, so two concurrent
      // creates for one slot both read no existing row and both proceed. The
      // database's `uq_sched_txn_overrides_occurrence` is the mechanism
      // (migration 168); this read exists so the common case gets a 400 naming
      // the date instead of a driver error, and the catch below turns the
      // constraint's own refusal into the same message.
      const existing = await repo
        .createQueryBuilder("override")
        .where("override.scheduledTransactionId = :scheduledTransactionId", {
          scheduledTransactionId,
        })
        .andWhere("override.originalDate = :date", {
          date: createDto.originalDate,
        })
        .getOne();

      if (existing) {
        throw this.occurrenceAlreadyOverridden(createDto.originalDate);
      }

      if (
        createDto.isSplit &&
        createDto.splits &&
        createDto.splits.length > 0
      ) {
        if (createDto.amount === undefined || createDto.amount === null) {
          throw new BadRequestException(
            tr(
              "errors.scheduled.splitOverrideRequiresAmount",
              "Amount is required when creating split override",
            ),
          );
        }
        this.validateOverrideSplits(
          createDto.splits,
          createDto.amount,
          decimals,
        );
      }

      await lockOverrideTransferAccounts(
        m,
        scheduledTransactionId,
        createDto.splits,
      );

      const override = repo.create({
        scheduledTransactionId,
        originalDate: createDto.originalDate,
        overrideDate: createDto.overrideDate,
        amount: createDto.amount ?? null,
        categoryId: createDto.categoryId ?? null,
        description: createDto.description ?? null,
        isSplit: createDto.isSplit ?? null,
        splits: this.buildOverrideSplits(
          createDto.splits,
          investmentProvenance,
        ),
        investmentQuantity: createDto.investmentQuantity ?? null,
        investmentPrice: createDto.investmentPrice ?? null,
        investmentTotalAmount: createDto.investmentTotalAmount ?? null,
      });

      try {
        return await repo.save(override);
      } catch (error) {
        // The loser of a concurrent create. Rejected by the constraint before
        // anything committed, and reported as the same 400 the pre-check gives
        // -- a caller must not have to tell the two apart.
        if (isOccurrenceAlreadyOverridden(error)) {
          throw this.occurrenceAlreadyOverridden(createDto.originalDate);
        }
        throw error;
      }
    });
  }

  /** One message for both routes to the same refusal. */
  private occurrenceAlreadyOverridden(
    originalDate: string,
  ): BadRequestException {
    return new BadRequestException(
      tr(
        "errors.scheduled.overrideAlreadyExists",
        `An override already exists for the ${originalDate} occurrence. Use update instead.`,
        { originalDate },
      ),
    );
  }

  async findOverrides(
    scheduledTransactionId: string,
  ): Promise<ScheduledTransactionOverride[]> {
    return withScopedDb(this.dataSource, (m) =>
      m.getRepository(ScheduledTransactionOverride).find({
        where: { scheduledTransactionId },
        relations: ["category"],
        order: { overrideDate: "ASC" },
      }),
    );
  }

  async findOverride(
    scheduledTransactionId: string,
    overrideId: string,
  ): Promise<ScheduledTransactionOverride> {
    const override = await withScopedDb(this.dataSource, (m) =>
      m.getRepository(ScheduledTransactionOverride).findOne({
        where: { id: overrideId, scheduledTransactionId },
        relations: ["category"],
      }),
    );

    if (!override) {
      throw new NotFoundException(
        tr(
          "errors.scheduled.overrideNotFound",
          `Override with ID ${overrideId} not found`,
          { overrideId },
        ),
      );
    }

    return override;
  }

  async findOverrideByDate(
    scheduledTransactionId: string,
    date: string,
  ): Promise<ScheduledTransactionOverride | null> {
    const normalizedDate = date.split("T")[0];

    this.logger.debug(
      `findOverrideByDate: Looking for override with scheduledTransactionId=${scheduledTransactionId}, date=${normalizedDate}`,
    );

    const allOverrides = await withScopedDb(this.dataSource, (m) =>
      m.getRepository(ScheduledTransactionOverride).find({
        where: { scheduledTransactionId },
        relations: ["category"],
      }),
    );

    this.logger.debug(
      `findOverrideByDate: Found ${allOverrides.length} total overrides for transaction`,
    );

    const override = allOverrides.find((o) => {
      const originalDate = String(o.originalDate).split("T")[0];
      this.logger.debug(
        `findOverrideByDate: Comparing originalDate ${originalDate} with ${normalizedDate}`,
      );
      return originalDate === normalizedDate;
    });

    this.logger.debug(
      `findOverrideByDate: Result = ${override ? `found id=${override.id}` : "null"}`,
    );

    return override || null;
  }

  async updateOverride(
    scheduledTransactionId: string,
    overrideId: string,
    updateDto: UpdateScheduledTransactionOverrideDto,
    investmentProvenance?: OverrideInvestmentProvenance,
    amountCurrencyCode?: string,
  ): Promise<ScheduledTransactionOverride> {
    const override = await this.findOverride(
      scheduledTransactionId,
      overrideId,
    );

    const splitAmount =
      updateDto.isSplit && updateDto.splits && updateDto.splits.length > 0
        ? (updateDto.amount ?? override.amount)
        : undefined;
    if (splitAmount === null) {
      throw new BadRequestException(
        tr(
          "errors.scheduled.updateSplitOverrideRequiresAmount",
          "Amount is required for split override",
        ),
      );
    }

    // Moving the occurrence's date is an in-place update, so the row (and its
    // split identities / FX provenance) survives (issue #1167 R10-F3).
    if (updateDto.overrideDate !== undefined)
      override.overrideDate = updateDto.overrideDate;
    if (updateDto.amount !== undefined) override.amount = updateDto.amount;
    if (updateDto.categoryId !== undefined)
      override.categoryId = updateDto.categoryId ?? null;
    if (updateDto.description !== undefined)
      override.description = updateDto.description;
    if (updateDto.isSplit !== undefined) override.isSplit = updateDto.isSplit;
    if (updateDto.splits !== undefined) {
      override.splits = this.buildOverrideSplits(
        updateDto.splits,
        investmentProvenance,
      );
    }
    if (updateDto.investmentQuantity !== undefined)
      override.investmentQuantity = updateDto.investmentQuantity;
    if (updateDto.investmentPrice !== undefined)
      override.investmentPrice = updateDto.investmentPrice;
    if (updateDto.investmentTotalAmount !== undefined)
      override.investmentTotalAmount = updateDto.investmentTotalAmount;

    return withScopedDb(this.dataSource, async (m) => {
      const decimals = await this.assertOverrideAmountsPrecision(
        m,
        amountCurrencyCode,
        updateDto,
      );
      // The lines sum to the override amount at the schedule currency's
      // precision, judged before the write with the currency read above.
      if (splitAmount !== undefined && updateDto.splits) {
        this.validateOverrideSplits(updateDto.splits, splitAmount, decimals);
      }
      // The lines the saved override will post: an update that only switches
      // `isSplit` back on (false -> true or NULL) revives the stored ones, so
      // they are proved again, not just the ones this request sent.
      await lockOverrideTransferAccounts(
        m,
        scheduledTransactionId,
        override.isSplit !== false ? override.splits : updateDto.splits,
      );
      return m.getRepository(ScheduledTransactionOverride).save(override);
    });
  }

  /**
   * Refuse an override amount, or a split line of one, with more places than
   * the schedule's currency carries (INV-MONEY-001), inside the write's
   * transaction and before it, and return that currency's money precision.
   * No currency named, nothing is judged and the precision is the fiat four.
   */
  private async assertOverrideAmountsPrecision(
    m: EntityManager,
    currencyCode: string | undefined,
    dto: {
      amount?: number | null;
      splits?: { amount: number }[] | null;
    },
  ): Promise<number> {
    if (!currencyCode) return FIAT_MONEY_DECIMALS;
    const places = await loadCurrencyPlaces(m, [currencyCode]);
    const currency = precisionCurrencyFor(places, currencyCode);
    if (dto.amount !== undefined && dto.amount !== null) {
      assertAmountPrecision(dto.amount, currency, "amount");
    }
    for (const [index, split] of (dto.splits ?? []).entries()) {
      assertAmountPrecision(split.amount, currency, `splits[${index}].amount`);
    }
    return moneyDecimalsForCode(places, currencyCode);
  }

  async removeOverride(
    scheduledTransactionId: string,
    overrideId: string,
  ): Promise<void> {
    const override = await this.findOverride(
      scheduledTransactionId,
      overrideId,
    );
    await withScopedDb(this.dataSource, (m) =>
      m.getRepository(ScheduledTransactionOverride).remove(override),
    );
  }

  async removeAllOverrides(scheduledTransactionId: string): Promise<number> {
    const result = await withScopedDb(this.dataSource, (m) =>
      m.getRepository(ScheduledTransactionOverride).delete({
        scheduledTransactionId,
      }),
    );
    return result.affected || 0;
  }

  async hasOverrides(
    scheduledTransactionId: string,
  ): Promise<{ hasOverrides: boolean; count: number }> {
    const count = await withScopedDb(this.dataSource, (m) =>
      m.getRepository(ScheduledTransactionOverride).count({
        where: { scheduledTransactionId },
      }),
    );

    return { hasOverrides: count > 0, count };
  }

  private validateOverrideSplits(
    splits: {
      categoryId?: string | null;
      amount: number;
      memo?: string | null;
    }[],
    transactionAmount: number,
    decimals: number,
  ): void {
    validateSplitAmountSum(splits, transactionAmount, { decimals });
  }
}
