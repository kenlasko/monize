import {
  EmbeddedSeriesCarry,
  readEmbeddedSeriesCarry,
  takeCarriedSeries,
} from "../bonds/embedded-series-carry";
import {
  Injectable,
  BadRequestException,
  ConflictException,
  NotFoundException,
  Inject,
  forwardRef,
} from "@nestjs/common";
import { DataSource, EntityManager, In } from "typeorm";
import {
  BondWriteGuard,
  createBondWriteGuard,
} from "../bonds/bond-write-guard";
import { Transaction, TransactionStatus } from "./entities/transaction.entity";
import { TransactionSplit } from "./entities/transaction-split.entity";
import { SplitKind } from "./entities/split-kind.enum";
import { Category } from "../categories/entities/category.entity";
import { CreateTransactionSplitDto } from "./dto/create-transaction-split.dto";
import { AccountsService } from "../accounts/accounts.service";
import { AccountSubType } from "../accounts/entities/account.entity";
import { isTransactionInFuture } from "../common/date-utils";
import { InvestmentTransactionsService } from "../securities/investment-transactions.service";
import {
  computeInvestmentCashImpact,
  isInvestmentActionAllowedInSplit,
} from "../securities/cash-impact.util";
import { NetWorthService } from "../net-worth/net-worth.service";
import { moneyDecimalsFor, roundMoney, sumMoney } from "../common/round.util";
import {
  applyFxConversion,
  resolveFxRateOrNull,
  roundFxRate,
} from "../common/fx-entry.util";
import {
  AmountPrecisionCurrency,
  assertAmountPrecision,
} from "../common/amount-precision.util";
import {
  loadCurrencyPlaces,
  loadCurrencyPlacesForRead,
  moneyDecimalsForCode,
  precisionCurrencyFor,
} from "../common/currency-places.util";
import { ExchangeRateService } from "../currencies/exchange-rate.service";
import { validateSplitAmountSum } from "../common/split-amount.util";
import { tr } from "../i18n/translate";
import { withScopedDb } from "../common/db/scoped-db";
import {
  lockTransactionRow,
  lockTransactionRows,
  LockedTransactionRow,
} from "../common/db/locks";
import { assertReconciledRowsMutable } from "./reconciled-lock.util";
import { removeLockedTransactionLeg } from "./remove-transaction-leg";
import { retotalSplitParent } from "./split-parent-total";
import { carryRecordedReceivedAmounts } from "./split-received-amount.util";

function inferSplitKind(split: CreateTransactionSplitDto): SplitKind {
  if (split.splitKind) return split.splitKind;
  if (split.investment) return SplitKind.INVESTMENT;
  if (split.transferAccountId) return SplitKind.TRANSFER;
  return SplitKind.CATEGORY;
}

/**
 * A received amount describes a transfer's other leg; on any other line there
 * is no leg for it to land on, so it is refused rather than dropped.
 */
function assertTargetAmountOnTransfer(split: CreateTransactionSplitDto): void {
  if (
    split.transferTargetAmount === undefined ||
    split.transferTargetAmount === null
  ) {
    return;
  }
  if (inferSplitKind(split) === SplitKind.TRANSFER && split.transferAccountId) {
    return;
  }
  throw new BadRequestException(
    tr(
      "errors.transactions.splitTransferTargetAmountRequiresTransfer",
      "Only a transfer split can carry a received amount",
    ),
  );
}

/**
 * The places an operation has loaded, plus the codes it has already asked for.
 * A code with no `currencies` row is absent from the map yet asked for, so it
 * is never queried a second time (it reads as the column default).
 */
class LoadedCurrencyPlaces extends Map<string, number> {
  constructor(
    entries: Iterable<readonly [string, number]>,
    readonly queried: ReadonlySet<string>,
  ) {
    super(entries);
  }
}

/**
 * `known` with the `decimal_places` of every one of `codes` it has not asked
 * for yet, read in one query on `m`: a split write meets its target currencies
 * one line at a time, and each code is queried at most once per operation,
 * whether or not it has a row, never once per line.
 */
async function withCurrencyPlaces(
  m: EntityManager,
  known: ReadonlyMap<string, number>,
  codes: readonly string[],
): Promise<ReadonlyMap<string, number>> {
  const queried: ReadonlySet<string> =
    known instanceof LoadedCurrencyPlaces
      ? known.queried
      : new Set(known.keys());
  const missing = [
    ...new Set(
      codes
        .map((code) => code.toUpperCase())
        .filter((code) => !known.has(code) && !queried.has(code)),
    ),
  ];
  if (missing.length === 0) return known;
  const loaded = await loadCurrencyPlaces(m, missing);
  return new LoadedCurrencyPlaces(
    [...known, ...loaded],
    new Set([...queried, ...missing]),
  );
}

@Injectable()
export class TransactionSplitService {
  constructor(
    @Inject(forwardRef(() => AccountsService))
    private accountsService: AccountsService,
    @Inject(forwardRef(() => InvestmentTransactionsService))
    private investmentTransactionsService: InvestmentTransactionsService,
    @Inject(forwardRef(() => NetWorthService))
    private netWorthService: NetWorthService,
    private dataSource: DataSource,
    private exchangeRateService: ExchangeRateService,
  ) {}

  /**
   * The counterpart amount for a transfer child, in the TARGET account's
   * currency, plus the rate used.
   *
   * A split's amounts are denominated in the parent account's currency. The
   * counterpart used to be created at exactly `-split.amount` with
   * `exchangeRate: 1` while being labelled with the target account's currency,
   * so a 40 USD transfer child into a EUR account credited 40 EUR and recorded
   * the pair as if the currencies were at par. That is the transfer-split half of
   * audit P5-002, and it is the same silent 1:1 as the rest of that finding.
   *
   * Refuses rather than posting at par when the pair has no determinable rate.
   *
   * `suppliedTargetAmount` is the split's `transferTargetAmount`: what the
   * user says arrived, unsigned, in the target currency. Across currencies it
   * wins over the market rate and its implied rate is stored, exactly as a
   * plain transfer's `toAmount` does (`TransactionTransferService.resolveTransferFx`);
   * between two accounts in one currency it must equal the split amount.
   *
   * Each side is in its own currency and rounds at that currency's money
   * precision (`places`, loaded once by the caller): a stated received amount
   * is refused when it carries more places than the target currency does, and
   * is otherwise stored as given (INV-SPLITFX-001); a converted one rounds at
   * the target's precision, so a CAD line into a BTC wallet keeps its eighth
   * place (INV-MONEY-001).
   */
  private async resolveSplitTransferAmount(
    amount: number,
    sourceCurrencyCode: string,
    targetCurrencyCode: string,
    transactionDate: string,
    suppliedTargetAmount: number | undefined,
    places: ReadonlyMap<string, number>,
  ): Promise<{ amount: number; exchangeRate: number }> {
    const sourceDecimals = moneyDecimalsForCode(places, sourceCurrencyCode);
    const targetDecimals = moneyDecimalsForCode(places, targetCurrencyCode);
    const sent = Math.abs(roundMoney(amount, sourceDecimals));
    const stated =
      suppliedTargetAmount !== undefined && suppliedTargetAmount !== null;
    if (stated) {
      assertAmountPrecision(
        suppliedTargetAmount,
        precisionCurrencyFor(places, targetCurrencyCode),
        "transferTargetAmount",
      );
    }
    if (sourceCurrencyCode === targetCurrencyCode) {
      if (stated && roundMoney(suppliedTargetAmount, targetDecimals) !== sent) {
        throw new BadRequestException(
          tr(
            "errors.transactions.transferSameCurrencyMustConserve",
            `A transfer between two ${targetCurrencyCode} accounts must move the same amount on both sides (received ${roundMoney(suppliedTargetAmount, targetDecimals)} against ${sent})`,
            { currency: targetCurrencyCode, amount: sent },
          ),
        );
      }
      return { amount: roundMoney(-amount, sourceDecimals), exchangeRate: 1 };
    }

    if (stated) {
      const received = roundMoney(suppliedTargetAmount, targetDecimals);
      // Zero on one side only is value created or destroyed, not a rate.
      if ((sent === 0) !== (received === 0)) {
        throw new BadRequestException(
          tr(
            "errors.transactions.transferAmountsMustAgreeOnZero",
            `A transfer must move a non-zero amount on both sides, or zero on both (received ${sent} against ${received})`,
            { amount: sent, toAmount: received },
          ),
        );
      }
      if (sent !== 0) {
        const impliedRate = roundFxRate(received / sent);
        if (!Number.isFinite(impliedRate) || impliedRate <= 0) {
          throw new BadRequestException(
            tr(
              "errors.transactions.transferImpliedRateInvalid",
              `The destination amount ${received} implies an unusable exchange rate against the source amount ${sent}`,
              { amount: sent, toAmount: received },
            ),
          );
        }
        // The counterpart moves the other way from the split line: a line
        // taking money out of the parent's account puts it into the target.
        return {
          amount: amount < 0 ? received : -received,
          exchangeRate: impliedRate,
        };
      }
      // Zero on both sides moves nothing; the market path below records the
      // pair's rate for it as it always has.
    }

    const rate = await resolveFxRateOrNull(
      this.exchangeRateService,
      sourceCurrencyCode,
      targetCurrencyCode,
      transactionDate || null,
    );
    if (rate === null) {
      throw new BadRequestException(
        tr(
          "errors.transactions.transferRateUnavailable",
          `Could not determine an exchange rate for ${sourceCurrencyCode} -> ${targetCurrencyCode}. Supply an exchangeRate or a destination amount so the transfer posts correctly.`,
          { from: sourceCurrencyCode, to: targetCurrencyCode },
        ),
      );
    }

    const exchangeRate = rate;
    return {
      amount: applyFxConversion(-amount, exchangeRate, null, {
        toDecimals: targetDecimals,
      }).amount,
      exchangeRate,
    };
  }

  /**
   * Resolve -- and thereby store -- the market rate for every cross-currency
   * transfer child BEFORE the caller opens its write transaction.
   *
   * A missing rate makes `getRateForDate` fetch a provider window over HTTP
   * and persist it. Done lazily inside `createSplits`, that happened while
   * holding the locked parent row, keeping the lock and the transaction's
   * connection open for the provider's latency and serializing every
   * concurrent writer of that split set. After this warm-up the
   * in-transaction resolution is a plain database read.
   *
   * Best-effort by design: failures are swallowed because the transactional
   * resolver remains authoritative -- it re-resolves and refuses with the
   * proper error when the pair is genuinely unresolvable.
   */
  async prewarmSplitTransferRates(
    userId: string,
    splits: Pick<
      CreateTransactionSplitDto,
      "transferAccountId" | "transferTargetAmount"
    >[],
    sourceAccountId: string,
    transactionDate: string | Date | null | undefined,
  ): Promise<void> {
    // A line that states what arrived converts at its own implied rate and
    // needs no market rate.
    const transferSplits = splits.filter(
      (s) =>
        s.transferAccountId &&
        (s.transferTargetAmount === undefined ||
          s.transferTargetAmount === null),
    );
    if (transferSplits.length === 0) return;
    const dateStr = !transactionDate
      ? null
      : typeof transactionDate === "string"
        ? transactionDate.substring(0, 10)
        : transactionDate.toISOString().substring(0, 10);
    try {
      const source = await this.accountsService.findOne(
        userId,
        sourceAccountId,
      );
      for (const split of transferSplits) {
        const target = await this.accountsService.findOne(
          userId,
          split.transferAccountId!,
        );
        if (target.currencyCode === source.currencyCode) continue;
        await resolveFxRateOrNull(
          this.exchangeRateService,
          source.currencyCode,
          target.currencyCode,
          dateStr,
        );
      }
    } catch {
      // Ownership and rate errors surface from the transactional path.
    }
  }

  private async validateCategoryOwnership(
    userId: string,
    categoryId: string,
  ): Promise<void> {
    const category = await withScopedDb(this.dataSource, (m) =>
      m.getRepository(Category).findOne({
        where: { id: categoryId, userId },
      }),
    );
    if (!category) {
      throw new NotFoundException(
        tr("errors.transactions.categoryNotFound", "Category not found"),
      );
    }
  }

  /**
   * Refuse a split set that cannot be written: too few lines, lines that do
   * not sum to the parent, a line with more places than the parent's currency
   * carries, a received amount off a transfer line, an inconsistent investment
   * payload.
   *
   * `currency` is the parent account's (code and `decimal_places`, from
   * `loadCurrencyPlaces` inside the caller's write transaction): every line is
   * in it, so every line is held to its money precision and the sum is
   * compared at it (INV-MONEY-001). Without it the fiat four is assumed and no
   * line is refused for its places; every caller that writes the set passes it.
   */
  validateSplits(
    splits: CreateTransactionSplitDto[],
    transactionAmount: number,
    currency?: AmountPrecisionCurrency,
  ): void {
    const decimals = moneyDecimalsFor(currency?.decimalPlaces);
    if (currency) {
      for (const [index, split] of splits.entries()) {
        assertAmountPrecision(
          split.amount,
          currency,
          `splits[${index}].amount`,
        );
      }
    }
    validateSplitAmountSum(splits, transactionAmount, {
      allowSinglePassthrough: true,
      isPassthrough: (s) => {
        const split = s as CreateTransactionSplitDto;
        return Boolean(split.transferAccountId || split.investment);
      },
      decimals,
    });

    for (const split of splits) {
      const kind = inferSplitKind(split);
      assertTargetAmountOnTransfer(split);
      if (kind !== SplitKind.INVESTMENT) continue;

      const inv = split.investment;
      if (!inv) {
        throw new BadRequestException(
          tr(
            "errors.transactions.investmentSplitRequiresPayload",
            "Investment split requires an investment payload",
          ),
        );
      }
      if (!isInvestmentActionAllowedInSplit(inv.action)) {
        throw new BadRequestException(
          tr(
            "errors.transactions.investmentActionNotAllowedInSplit",
            `Investment action ${inv.action} is not allowed inside a split transaction`,
            { action: inv.action },
          ),
        );
      }
      if (split.categoryId || split.transferAccountId) {
        throw new BadRequestException(
          tr(
            "errors.transactions.investmentSplitCannotSetCategoryOrTransfer",
            "Investment splits cannot also set categoryId or transferAccountId",
          ),
        );
      }

      const cashImpactInSecurity = computeInvestmentCashImpact(
        inv.action,
        Number(inv.quantity ?? 0),
        Number(inv.price ?? 0),
        Number(inv.commission ?? 0),
      );
      // Only an internal-consistency check on the payload, and only when the
      // payload states a rate. It used to default to 1 and demand that the
      // split's cash amount equal the UNCONVERTED cash impact -- so for a USD
      // security in a CAD account it required the wrong number and rejected the
      // right one, while `createEmbeddedForSplit` went on to store the investment
      // row at the properly resolved rate. The two halves of one split then
      // disagreed by the whole FX spread. The authoritative check lives where the
      // rate is resolved (`createEmbeddedForSplit`), against the rate actually
      // stored.
      if (inv.exchangeRate === undefined || inv.exchangeRate === null) continue;
      const exchangeRate = Number(inv.exchangeRate);
      const expectedAmount = cashImpactInSecurity * exchangeRate;

      const expectedRounded = roundMoney(expectedAmount, decimals);
      const actualRounded = roundMoney(Number(split.amount), decimals);

      if (expectedRounded !== actualRounded) {
        throw new BadRequestException(
          tr(
            "errors.transactions.investmentSplitAmountMismatch",
            `Investment split amount (${split.amount}) does not match the cash impact ` +
              `of ${inv.action} ${inv.quantity ?? 0} @ ${inv.price ?? 0} ` +
              `(expected ${expectedAmount.toFixed(decimals)})`,
            {
              amount: split.amount,
              action: inv.action,
              quantity: inv.quantity ?? 0,
              price: inv.price ?? 0,
              expected: expectedAmount.toFixed(decimals),
            },
          ),
        );
      }
    }
  }

  /**
   * `validateSplits` for a set in `currencyCode`, reading that currency's
   * places itself: for a preview that writes nothing (the AI and MCP tool
   * preparation), so its refusals are the commit's.
   */
  async validateSplitsInCurrency(
    splits: CreateTransactionSplitDto[],
    transactionAmount: number,
    currencyCode: string,
  ): Promise<void> {
    const places = await withScopedDb(this.dataSource, (m) =>
      loadCurrencyPlacesForRead(m, [currencyCode]),
    );
    this.validateSplits(
      splits,
      transactionAmount,
      precisionCurrencyFor(places, currencyCode),
    );
  }

  /**
   * Create the split rows (and their transfer counterparts / embedded
   * investment rows). Runs in its own transaction when called standalone;
   * called from inside a caller's `withScopedDb` (transaction create/update,
   * updateSplits) it joins that transaction via re-entrancy.
   */
  async createSplits(
    transactionId: string,
    splits: CreateTransactionSplitDto[],
    userId?: string,
    sourceAccountId?: string,
    transactionDate?: Date,
    parentPayeeName?: string | null,
    parentPayeeId?: string | null,
    /**
     * The parent's status. A VOID parent describes something that did not
     * happen, so its transfer counterpart must be VOID too and must move no
     * balance -- this used to be unknown here, so a void split still credited
     * the target account and left an ACTIVE counterpart leg behind it.
     */
    options?: {
      parentStatus?: TransactionStatus;
      /**
       * The embedded investment rows this parent had before an edit rebuilt
       * them (`readEmbeddedSeriesCarry`): a recreated row that names no bond
       * series keeps its predecessor's (INV-BOND-007).
       */
      carriedSeries?: readonly EmbeddedSeriesCarry[];
      /**
       * Collects the securities of the embedded investment rows this created,
       * for the caller's bond price recompute after the commit (INV-BOND-005).
       */
      touchedSecurityIds?: Set<string>;
    },
    /**
     * Every account this touched besides the parent's, so the caller can
     * invalidate their balance-derived state after commit. A transfer child
     * creates a counterpart in an account the parent never named, and an
     * investment child moves the brokerage account -- both went stale in
     * net worth because only the parent account was invalidated (recheck
     * RR5-002). Populated, never triggered from in here: the recalculation must
     * wait for the caller's commit.
     */
    affectedAccountIds?: Set<string>,
  ): Promise<TransactionSplit[]> {
    return withScopedDb(this.dataSource, (m) =>
      this.createSplitsInternal(
        m,
        transactionId,
        splits,
        userId,
        sourceAccountId,
        transactionDate,
        parentPayeeName,
        parentPayeeId,
        options,
        affectedAccountIds,
      ),
    );
  }

  private async createSplitsInternal(
    m: EntityManager,
    transactionId: string,
    splits: CreateTransactionSplitDto[],
    userId?: string,
    sourceAccountId?: string,
    transactionDate?: Date,
    parentPayeeName?: string | null,
    parentPayeeId?: string | null,
    options?: {
      parentStatus?: TransactionStatus;
      carriedSeries?: readonly EmbeddedSeriesCarry[];
      touchedSecurityIds?: Set<string>;
    },
    affectedAccountIds?: Set<string>,
  ): Promise<TransactionSplit[]> {
    if (userId) {
      const categoryIds = [
        ...new Set(
          splits.map((s) => s.categoryId).filter((id): id is string => !!id),
        ),
      ];
      if (categoryIds.length > 0) {
        const found = await m.find(Category, {
          where: { id: In(categoryIds), userId },
          select: ["id"],
        });
        const foundIds = new Set(found.map((c) => c.id));
        const invalid = categoryIds.filter((id) => !foundIds.has(id));
        if (invalid.length > 0) {
          throw new NotFoundException(
            tr(
              "errors.transactions.categoriesNotFound",
              `Categories not found: ${invalid.join(", ")}`,
              { ids: invalid.join(", ") },
            ),
          );
        }
      }
    }

    const hasInvestment = splits.some(
      (s) => inferSplitKind(s) === SplitKind.INVESTMENT,
    );
    let brokerageAccountId: string | null = null;
    let parentDateStr = "";

    if (hasInvestment) {
      if (!userId || !sourceAccountId) {
        throw new BadRequestException(
          tr(
            "errors.transactions.investmentSplitRequiresSourceAccount",
            "Investment splits require a known source account",
          ),
        );
      }
      const sourceAccount = await this.accountsService.findOne(
        userId,
        sourceAccountId,
      );
      if (sourceAccount.accountSubType !== AccountSubType.INVESTMENT_CASH) {
        throw new BadRequestException(
          tr(
            "errors.transactions.investmentSplitRequiresInvestmentCashAccount",
            "Investment splits require the parent transaction to be on an INVESTMENT_CASH account",
          ),
        );
      }
      if (!sourceAccount.linkedAccountId) {
        throw new BadRequestException(
          tr(
            "errors.transactions.investmentCashAccountNotLinked",
            "Source INVESTMENT_CASH account is not linked to a brokerage account",
          ),
        );
      }
      brokerageAccountId = sourceAccount.linkedAccountId;
      parentDateStr = transactionDate
        ? transactionDate.toISOString().substring(0, 10)
        : "";
    }

    // Saved rows are placed back at their original input position so callers
    // that pair splits[i] with the result (e.g. split-level tag assignment) stay
    // aligned regardless of the batched/looped save ordering below.
    const savedSplits: TransactionSplit[] = new Array(splits.length);

    // Plain category splits (and transfers without userId/sourceAccountId
    // context, e.g. import flows) are batch-saved together. Each bucket keeps
    // the split's original index.
    const regularSplits: { split: CreateTransactionSplitDto; index: number }[] =
      [];
    const transferSplits: {
      split: CreateTransactionSplitDto;
      index: number;
    }[] = [];
    const investmentSplits: {
      split: CreateTransactionSplitDto;
      index: number;
    }[] = [];
    splits.forEach((split, index) => {
      const k = inferSplitKind(split);
      if (k === SplitKind.INVESTMENT) {
        investmentSplits.push({ split, index });
      } else if (
        k === SplitKind.TRANSFER &&
        split.transferAccountId &&
        userId &&
        sourceAccountId
      ) {
        transferSplits.push({ split, index });
      } else {
        regularSplits.push({ split, index });
      }
    });

    if (regularSplits.length > 0) {
      const regularEntities = regularSplits.map(({ split }) => {
        const kind = split.transferAccountId
          ? SplitKind.TRANSFER
          : SplitKind.CATEGORY;
        return m.create(TransactionSplit, {
          transactionId,
          kind,
          categoryId: split.categoryId || null,
          transferAccountId: split.transferAccountId || null,
          amount: split.amount,
          memo: split.memo || null,
        });
      });
      const batchSaved = await m.save(regularEntities);
      batchSaved.forEach((saved, j) => {
        savedSplits[regularSplits[j].index] = saved;
      });
    }

    // Each currency's places are read once for the whole set, as the lines
    // name them (`withCurrencyPlaces`).
    let places: ReadonlyMap<string, number> = new Map();
    for (const { split, index } of transferSplits) {
      const splitEntity = m.create(TransactionSplit, {
        transactionId,
        kind: SplitKind.TRANSFER,
        categoryId: null,
        transferAccountId: split.transferAccountId,
        amount: split.amount,
        memo: split.memo || null,
      });

      const savedSplit = await m.save(splitEntity);

      const targetAccount = await this.accountsService.findOne(
        userId!,
        split.transferAccountId!,
      );
      const sourceAccount = await this.accountsService.findOne(
        userId!,
        sourceAccountId!,
      );

      // Persist the transfer counterpart's date as a plain yyyy-MM-dd string,
      // not the Date object. The Date arrives as UTC midnight
      // (new Date("2024-01-05")), so saving it directly lets node-postgres
      // serialize it in the server's local time and Postgres truncates it to
      // the previous calendar day west of UTC -- shifting every split transfer
      // (e.g. loan payments) a day earlier than its parent. The ISO date part
      // recovers the intended day and matches the parent transaction.
      const dateStr = transactionDate
        ? transactionDate.toISOString().substring(0, 10)
        : "";

      // The counterpart is denominated in the TARGET account's currency, so a
      // split amount in the parent's currency has to be converted rather than
      // copied across with `exchangeRate: 1` (audit P5-002, transfer-split half).
      places = await withCurrencyPlaces(m, places, [
        sourceAccount.currencyCode,
        targetAccount.currencyCode,
      ]);
      const counterpart = await this.resolveSplitTransferAmount(
        split.amount,
        sourceAccount.currencyCode,
        targetAccount.currencyCode,
        dateStr,
        split.transferTargetAmount,
        places,
      );

      // A VOID parent's counterpart is VOID: the two rows describe one movement
      // of money, and every balance and report predicate excludes a VOID row, so
      // an active counterpart under a void parent is money from nowhere.
      const parentIsVoid = options?.parentStatus === TransactionStatus.VOID;

      const linkedTransaction = m.create(Transaction, {
        userId,
        accountId: split.transferAccountId,
        transactionDate: (dateStr || null) as any,
        amount: counterpart.amount,
        currencyCode: targetAccount.currencyCode,
        exchangeRate: counterpart.exchangeRate,
        description: split.memo || null,
        isTransfer: true,
        status: options?.parentStatus,
        payeeId: parentPayeeId || null,
        // A blank payee is persisted blank (issue #1214): the display resolves
        // "Transfer from <source>" from the linked parent's account at read
        // time, so it follows renames and the reader's language.
        payeeName: parentPayeeName || null,
      });

      const savedLinkedTransaction = await m.save(linkedTransaction);
      affectedAccountIds?.add(split.transferAccountId!);

      await m.update(TransactionSplit, savedSplit.id, {
        linkedTransactionId: savedLinkedTransaction.id,
      });

      await m.update(Transaction, savedLinkedTransaction.id, {
        linkedTransactionId: transactionId,
      });

      if (parentIsVoid) {
        // Recorded, not applied.
      } else if (dateStr && isTransactionInFuture(dateStr)) {
        // The transfer counterpart is created under `userId` above, so its
        // account is the caller's -- scope the balance-write lock to that owner.
        await this.accountsService.recalculateCurrentBalance(
          userId!,
          split.transferAccountId!,
        );
      } else {
        await this.accountsService.updateBalance(
          split.transferAccountId!,
          counterpart.amount,
        );
      }

      savedSplit.linkedTransactionId = savedLinkedTransaction.id;
      savedSplits[index] = savedSplit;
    }

    const carriedPool = [...(options?.carriedSeries ?? [])];
    for (const { split, index } of investmentSplits) {
      const splitEntity = m.create(TransactionSplit, {
        transactionId,
        kind: SplitKind.INVESTMENT,
        categoryId: null,
        transferAccountId: null,
        amount: split.amount,
        memo: split.memo || null,
      });
      const savedSplit = await m.save(splitEntity);

      const embedded =
        await this.investmentTransactionsService.createEmbeddedForSplit(
          m,
          userId!,
          parentDateStr,
          savedSplit.id,
          brokerageAccountId!,
          sourceAccountId!,
          split.investment!,
          // Checked against the resolved rate there: this amount and the
          // investment row have to describe the same money.
          Number(split.amount),
          // A VOID parent's embedded investment row is created VOID (no
          // holdings), for the same reason its transfer counterparts are.
          options?.parentStatus,
          takeCarriedSeries(carriedPool, {
            securityId: split.investment!.securityId,
            action: split.investment!.action,
            quantity: split.investment!.quantity,
            transactionDate: parentDateStr,
          }),
        );
      if (embedded?.securityId) {
        options?.touchedSecurityIds?.add(embedded.securityId);
      }

      savedSplits[index] = savedSplit;
    }

    if (hasInvestment && userId && brokerageAccountId) {
      if (affectedAccountIds) {
        // Collected for the caller to invalidate after commit; see the param doc.
        affectedAccountIds.add(brokerageAccountId);
      } else {
        // No collector supplied (a caller that owns no post-commit hook): keep
        // the original best-effort trigger rather than dropping the invalidation.
        this.netWorthService.triggerDebouncedRecalc(brokerageAccountId, userId);
      }
    }

    return savedSplits;
  }

  /**
   * Recategorize the category-kind lines of a set of split parents in one
   * statement, returning what each changed line held before the write so the
   * caller can record an undoable snapshot.
   *
   * Invariants owned here (docs/specs/split-bulk-update.md):
   * - I2: only `kind = 'category'` rows are written; transfer and investment
   *   lines are never touched.
   * - I3: the pre-read joins back to `transactions` on `user_id`; the UPDATE
   *   then writes only ids that pre-read proved (join is defense-in-depth).
   * - I6: the parent rows are locked first (`lockTransactionRows`), the same
   *   lock `updateSplits`/`addSplit` take, so split-set writers serialize.
   *
   * `restrictToCategoryIds` is the descendant-expanded category filter set;
   * `undefined` means all category-kind lines. Joins the caller's ambient
   * transaction when called from inside one (bulk update).
   */
  async bulkRecategorizeCategorySplits(
    userId: string,
    parentIds: string[],
    newCategoryId: string | null,
    restrictToCategoryIds?: string[],
  ): Promise<
    {
      splitId: string;
      transactionId: string;
      previousCategoryId: string | null;
    }[]
  > {
    if (parentIds.length === 0) return [];
    if (
      restrictToCategoryIds !== undefined &&
      restrictToCategoryIds.length === 0
    )
      return [];

    return withScopedDb(this.dataSource, async (m) => {
      // Parents only, never the full eligible set: locking a parent together
      // with its own counterpart leg is refused by lockTransactionRows.
      await lockTransactionRows(m, parentIds, userId);

      const params: unknown[] = [userId, parentIds];
      let restrictClause = "";
      if (restrictToCategoryIds !== undefined) {
        params.push(restrictToCategoryIds);
        restrictClause = " AND s.category_id = ANY($3)";
      }

      const rows: {
        id: string;
        transaction_id: string;
        category_id: string | null;
      }[] = await m.query(
        `SELECT s.id, s.transaction_id, s.category_id
           FROM transaction_splits s
           JOIN transactions t ON t.id = s.transaction_id
          WHERE t.user_id = $1
            AND s.transaction_id = ANY($2)
            AND s.kind = 'category'${restrictClause}
          ORDER BY s.id
            FOR UPDATE OF s`,
        params,
      );

      if (rows.length === 0) return [];

      await m.query(
        `UPDATE transaction_splits SET category_id = $1 WHERE id = ANY($2)`,
        [newCategoryId, rows.map((r) => r.id)],
      );

      return rows.map((r) => ({
        splitId: r.id,
        transactionId: r.transaction_id,
        previousCategoryId: r.category_id,
      }));
    });
  }

  /**
   * Reverse a split transaction's side effects (embedded investment holdings,
   * transfer counterpart rows and their balance impact) ahead of deleting or
   * rebuilding its splits. Joins the caller's ambient transaction; every call
   * site runs inside one (transaction update/remove, updateSplits).
   */
  /**
   * Apply a split parent's inclusion status to every transfer counterpart its
   * children created, moving each counterpart's balance exactly once.
   *
   * A split parent and the counterparts created from its transfer children are
   * one economic event. `parentStatus` reaches the counterpart when children are
   * created or rebuilt, but a status-only edit does not rebuild them -- so
   * voiding a mixed category/transfer split restored the source balance and left
   * the target holding the transferred amount, with an ACTIVE counterpart row
   * under a VOID parent (review finding FR-002).
   *
   * Runs inside the caller's transaction so the parent's own status change and
   * every counterpart's move commit together.
   */
  /**
   * Take the holdings advisory lock for every brokerage account an embedded
   * investment row of these split parents sits in.
   *
   * A path that writes a split parent calls this as the first statement of its
   * transaction, before it row-locks the parent and before the parent's balance
   * write row-locks `accounts`. The embedded rows' rebuild takes the advisory
   * lock afterwards, and `InvestmentTransactionsService.update()` reaches the
   * same parent the other way round -- advisory lock first, then that parent's
   * `FOR UPDATE` -- so an advisory lock taken after either row lock is a
   * deadlock for both (`common/db/locks.ts`, 40P01).
   *
   * The read inside it is unlocked, so it may precede the advisory lock, and
   * `pg_advisory_xact_lock` is re-entrant, so a path that cannot know in advance
   * whether the row is a split parent calls this unconditionally: a row with no
   * embedded investment legs locks nothing.
   */
  lockEmbeddedInvestmentScopes(
    m: EntityManager,
    userId: string,
    parentTransactionIds: readonly string[],
  ): Promise<void> {
    return this.investmentTransactionsService.lockEmbeddedHoldingScopes(
      m,
      userId,
      parentTransactionIds,
    );
  }

  async applyParentStatusToTransferCounterparts(
    m: EntityManager,
    transactionId: string,
    userId: string,
    newStatus: TransactionStatus,
    /**
     * Collects the securities whose lots a crossing of the VOID boundary moved,
     * for the caller's bond price recompute after the commit (INV-BOND-005).
     */
    touchedSecurityIds?: Set<string>,
  ): Promise<Set<string>> {
    const splits = await m.getRepository(TransactionSplit).find({
      where: { transactionId },
      select: ["id", "transferAccountId", "linkedTransactionId"],
    });
    const counterpartIds = splits
      .filter((split) => split.transferAccountId)
      .map((split) => split.linkedTransactionId)
      .filter((id): id is string => id !== null);

    // Returned so the caller can invalidate the balance-derived state of every
    // account this touched. Returning `void` left the caller invalidating only the
    // accounts it already knew about -- the parent's -- so a target account came
    // out with a corrected live balance beside a stale net-worth snapshot, and it
    // stayed stale until something unrelated wrote to that account (recheck
    // RR4-003). The recalculation is deliberately NOT dispatched from in here: this
    // runs inside the caller's transaction, and a rollback must not leave a
    // recompute queued for state that was never committed.
    const affectedAccountIds = new Set<string>();

    // Embedded investment rows are the parent's event too: their holdings
    // effect follows the parent across the VOID boundary exactly as a transfer
    // counterpart's balance does. Same transaction, same rollback.
    const embeddedAffected =
      await this.investmentTransactionsService.applyParentStatusToEmbeddedRows(
        m,
        userId,
        transactionId,
        newStatus,
        touchedSecurityIds,
      );
    for (const accountId of embeddedAffected) {
      affectedAccountIds.add(accountId);
    }

    if (counterpartIds.length === 0) return affectedAccountIds;

    // The status the transition is decided from and the amount the balance
    // moves by are read under the row lock, like every other delta in this
    // codebase (P4-003/FV4-002): an unlocked relation read raced a concurrent
    // leg edit, so propagation subtracted an amount the edit had already
    // replaced and the stored balance drifted from the recomputable one. A
    // counterpart that does not lock is not this user's row and is skipped --
    // inclusion there is per ledger.
    const lockedCounterparts = await lockTransactionRows(
      m,
      counterpartIds,
      userId,
    );

    for (const counterpart of lockedCounterparts.values()) {
      const wasVoid = counterpart.status === TransactionStatus.VOID;
      const isVoid = newStatus === TransactionStatus.VOID;
      if (wasVoid === isVoid) continue;

      await m.update(Transaction, counterpart.id, { status: newStatus });
      affectedAccountIds.add(counterpart.accountId);

      if (isTransactionInFuture(counterpart.transactionDate)) {
        await this.accountsService.recalculateCurrentBalance(
          userId,
          counterpart.accountId,
        );
      } else {
        await this.accountsService.updateBalance(
          counterpart.accountId,
          isVoid ? -counterpart.amount : counterpart.amount,
        );
      }
    }

    return affectedAccountIds;
  }

  /**
   * Returns every account whose balance this reversed, besides the parent's, so
   * the caller can invalidate their derived state after commit -- a transfer
   * child's counterpart account and an investment child's brokerage account both
   * went stale in net worth because only the parent account was invalidated
   * (recheck RR5-002).
   */
  async deleteSplitSideEffects(
    transactionId: string,
    userId: string,
    bond?: {
      /** Collects the securities of the removed embedded rows (INV-BOND-005). */
      touchedSecurityIds?: Set<string>;
      /**
       * The caller recreates the embedded rows and verifies once at the end
       * (a split replacement): it is tracked here, before the first removal.
       */
      bondGuard?: BondWriteGuard;
    },
  ): Promise<Set<string>> {
    return withScopedDb(this.dataSource, async (m) => {
      const affectedAccountIds = new Set<string>();
      const splits = await m.getRepository(TransactionSplit).find({
        where: { transactionId },
        relations: ["linkedTransaction", "investmentTransaction"],
      });

      // The transfer legs first, before anything is written: locked, re-read
      // and conditionally deleted below, exactly like the single-leg path. An
      // unlocked `find` followed by `remove(entity)` reversed whatever amount
      // the snapshot happened to hold and reversed it whether or not this call
      // was the one that removed the row -- a split replacement racing a
      // counterpart edit, or racing another replacement, each moved the target
      // account's balance once for one deleted row (audit FV4-002).
      //
      // Each leg is a row in another account that this deletes, so it answers
      // the strict reconciled lock its parent answered (issue #2039): a
      // replacement, an edit with splits, a delete or a conversion of the
      // parent no longer takes a reconciled counterpart with it.
      const linkedTxIds = splits
        .filter((s) => s.linkedTransactionId && s.transferAccountId)
        .map((s) => s.linkedTransactionId!);
      const linked =
        linkedTxIds.length > 0
          ? await lockTransactionRows(m, linkedTxIds, userId)
          : new Map<string, LockedTransactionRow>();
      await assertReconciledRowsMutable(m, userId, [...linked.values()]);

      // One guard for every embedded row of the parent, verified after the last
      // one is gone: a parent holding both the BUY and the SELL it covers is not
      // refused because one was removed before the other (INV-BOND-007).
      const bondGuard = bond?.bondGuard ?? createBondWriteGuard(m, userId);
      await bondGuard.track(
        splits.map((s) => s.investmentTransaction?.securityId),
      );

      // Reverse investment splits' holdings effects before the split rows are
      // deleted.
      for (const s of splits) {
        if (s.kind === SplitKind.INVESTMENT && s.investmentTransaction) {
          if (s.investmentTransaction.accountId) {
            affectedAccountIds.add(s.investmentTransaction.accountId);
          }
          await this.investmentTransactionsService.reverseAndRemoveEmbedded(
            m,
            userId,
            s.investmentTransaction,
            { touchedSecurityIds: bond?.touchedSecurityIds, bondGuard },
          );
        }
      }
      if (!bond?.bondGuard) await bondGuard.verify();

      // Each locked leg's account is collected so the caller can invalidate its
      // net-worth state after commit -- the counterpart lives in an account the
      // parent never named (recheck RR5-002).
      for (const leg of linked.values()) {
        affectedAccountIds.add(leg.accountId);
        await removeLockedTransactionLeg(m, leg, userId, this.accountsService);
      }

      return affectedAccountIds;
    });
  }

  /**
   * Find the split that owns a given transfer counterpart (the leg living in the
   * target account), or null if the transaction is not a split-transfer leg.
   * Used to mirror edits made on the counterpart back onto its split.
   */
  async getTransferSplitByLinkedTransaction(
    linkedTransactionId: string,
  ): Promise<TransactionSplit | null> {
    return withScopedDb(this.dataSource, (m) =>
      m.getRepository(TransactionSplit).findOne({
        where: { linkedTransactionId },
      }),
    );
  }

  async getSplits(transactionId: string): Promise<TransactionSplit[]> {
    return withScopedDb(this.dataSource, (m) =>
      m.getRepository(TransactionSplit).find({
        where: { transactionId },
        relations: ["category", "transferAccount", "investmentTransaction"],
        order: { createdAt: "ASC" },
      }),
    );
  }

  async updateSplits(
    transaction: Transaction,
    splits: CreateTransactionSplitDto[],
    userId: string,
  ): Promise<TransactionSplit[]> {
    // Provider rate lookups happen out here, never while holding the parent
    // lock below; see prewarmSplitTransferRates.
    await this.prewarmSplitTransferRates(
      userId,
      splits,
      transaction.accountId,
      transaction.transactionDate,
    );
    // Every transfer target and brokerage account this replace touched besides
    // the parent's, invalidated after the commit so a rollback leaves nothing
    // queued (recheck RR5-002).
    const affectedAccountIds = new Set<string>();
    // The securities of the embedded rows torn down and recreated, repriced by
    // the bond engine after the commit (INV-BOND-005, INV-CACHE-001).
    const touchedSecurityIds = new Set<string>();
    const newSplits = await withScopedDb(this.dataSource, async (m) => {
      // First statement of the transaction: advisory before row locks
      // (`common/db/locks.ts`). A replacement tears the parent's existing
      // embedded investment rows down (`deleteSplitSideEffects` ->
      // `reverseAndRemoveEmbedded` -> the rebuild) and builds the new ones
      // (`createEmbeddedForSplit`), both under the holdings advisory lock, while
      // `InvestmentTransactionsService.update()` reaches the same parent the
      // other way round -- advisory lock first, then
      // `updateEmbeddedSplitParent`'s `lockTransactionRow` on that parent.
      // Taking the advisory lock after the parent's row lock below left the two
      // paths each holding the other's next lock (40P01).
      //
      // Unconditional: a parent with no embedded investment legs locks nothing,
      // and the helper's own `SELECT` is unlocked so it may precede the advisory
      // lock. A brokerage account only the incoming splits name needs no lock
      // here -- no committed embedded row of this parent sits in it, so nothing
      // can hold it while waiting for this parent's row.
      await this.lockEmbeddedInvestmentScopes(m, userId, [transaction.id]);

      // Same parent lock as addSplit, so full replacement and incremental
      // addition serialize against each other, and validated against the
      // parent's committed amount rather than the caller's snapshot of it.
      const parent = await lockTransactionRow(m, transaction.id, userId);
      if (!parent) {
        throw new NotFoundException(
          tr(
            "errors.transactions.notFoundById",
            `Transaction with ID ${transaction.id} not found`,
            { id: transaction.id },
          ),
        );
      }
      // Strict reconciled lock: replacing a reconciled parent's split set
      // rewrites the row the statement was matched against.
      await assertReconciledRowsMutable(m, userId, [parent]);

      // Every line is in the parent account's currency, held to its places.
      const places = await loadCurrencyPlaces(m, [transaction.currencyCode]);
      const currency = precisionCurrencyFor(places, transaction.currencyCode);
      this.validateSplits(splits, parent.amount, currency);

      // Read before the embedded rows are torn down: the recreated rows keep
      // the bond series of the rows they replace.
      const carriedSeries = await readEmbeddedSeriesCarry(
        m,
        userId,
        transaction.id,
      );
      // Likewise before the counterparts go: a line that continues a recorded
      // one keeps what arrived rather than being re-converted.
      const replacement = await this.withRecordedReceivedAmounts(
        m,
        userId,
        parent,
        parent.accountId,
        splits,
        moneyDecimalsFor(currency.decimalPlaces),
      );

      // One guard for the whole replacement: the old embedded rows are removed
      // and their successors written before it verifies, so a replacement that
      // leaves the lots as they were is not refused half way, and one that
      // leaves a removal uncovered rolls everything back (INV-BOND-007).
      const bondGuard: BondWriteGuard = createBondWriteGuard(m, userId);
      for (const acc of await this.deleteSplitSideEffects(
        transaction.id,
        userId,
        { touchedSecurityIds, bondGuard },
      )) {
        affectedAccountIds.add(acc);
      }

      await m.delete(TransactionSplit, {
        transactionId: transaction.id,
      });

      // Every field the new splits are built from comes off the locked parent,
      // not off the caller's copy of it. The counterpart rows and embedded
      // investment rows *describe* the parent -- its account, its date, its payee
      // -- so a concurrent parent edit that committed after the caller read it
      // would otherwise be written into rows claiming the old values, with no
      // error and nothing to reconcile against (audit FV4-002).
      const created = await this.createSplits(
        parent.id,
        replacement,
        userId,
        parent.accountId,
        new Date(parent.transactionDate),
        parent.payeeName,
        parent.payeeId,
        // The parent's status reaches the recreated counterparts, exactly as it
        // does on the create and update paths in `TransactionsService`. This was
        // the third route into a VOID parent with ACTIVE counterparts (the
        // FR-002 family): replacing the split set of a voided transaction --
        // reachable from `PUT /transactions/:id/splits`, the AI action and the
        // MCP tool -- deleted the VOID legs and recreated them active, so the
        // target account was credited money the source still showed as not sent.
        //
        // The status is the LOCKED parent's: the caller's copy was read before
        // this transaction, and a VOID that committed in between would recreate
        // the counterparts active against a VOID parent (A26-M09).
        {
          parentStatus: parent.status as TransactionStatus,
          carriedSeries,
          touchedSecurityIds,
        },
        affectedAccountIds,
      );

      await bondGuard.verify();

      await m.update(Transaction, transaction.id, {
        isSplit: true,
        categoryId: null,
      });

      return created;
    });

    // After the commit, so a rollback leaves nothing queued: every transfer
    // target and brokerage account this replace touched had its net-worth state
    // invalidated (recheck RR5-002), not only the parent account the caller knows.
    this.invalidateNetWorth(affectedAccountIds, userId);
    await this.recomputeBondPricesAfterWrite(userId, touchedSecurityIds);
    return newSplits;
  }

  /**
   * `splits` with each continuing cross-currency transfer line's recorded
   * received amount filled in where the caller sent none
   * (`carryRecordedReceivedAmounts`). Reads the parent's current lines and
   * their counterparts, so it runs inside the replacement's transaction,
   * before those counterparts are deleted.
   */
  async withRecordedReceivedAmounts(
    m: EntityManager,
    userId: string,
    parent: { id: string; accountId: string },
    nextAccountId: string,
    splits: CreateTransactionSplitDto[],
    /** The parent currency's money precision, which line amounts are compared at. */
    sourceDecimals: number,
  ): Promise<CreateTransactionSplitDto[]> {
    const wantsCarry = splits.some(
      (split) =>
        split.transferAccountId &&
        (split.transferTargetAmount === undefined ||
          split.transferTargetAmount === null),
    );
    if (!wantsCarry || nextAccountId !== parent.accountId) return splits;
    const current = await m.getRepository(TransactionSplit).find({
      where: { transactionId: parent.id },
      relations: ["linkedTransaction"],
    });
    if (!current.some((split) => split.linkedTransaction)) return splits;
    const source = await this.accountsService.findOne(userId, parent.accountId);
    return carryRecordedReceivedAmounts(
      current.map((split) => ({
        transferAccountId: split.transferAccountId,
        amount: split.amount,
        counterpartAmount: split.linkedTransaction?.amount ?? null,
        counterpartCurrencyCode: split.linkedTransaction?.currencyCode ?? null,
      })),
      splits,
      {
        sourceCurrencyCode: source.currencyCode,
        sourceDecimals,
        parentAccountUnchanged: nextAccountId === parent.accountId,
      },
    );
  }

  /**
   * Reprice the bond-linked securities among these after a split write's
   * commit: its embedded investment rows changed their lots. Never called from
   * inside a transaction (INV-CACHE-001); a failure is logged by the bond
   * price service, not thrown, so it cannot contradict the committed write.
   */
  async recomputeBondPricesAfterWrite(
    userId: string,
    securityIds: Iterable<string>,
  ): Promise<void> {
    const ids = [...securityIds];
    if (ids.length === 0) return;
    await this.investmentTransactionsService.recomputeBondPricesAfterSplitWrite(
      userId,
      ids,
    );
  }

  /**
   * Queue a net-worth recompute for each account, for use after a split
   * mutation's transaction has committed.
   */
  private invalidateNetWorth(accountIds: Set<string>, userId: string): void {
    for (const accountId of accountIds) {
      this.netWorthService.triggerDebouncedRecalc(accountId, userId);
    }
  }

  async addSplit(
    transaction: Transaction,
    splitDto: CreateTransactionSplitDto,
    userId: string,
  ): Promise<TransactionSplit> {
    if (splitDto.investment) {
      throw new BadRequestException(
        tr(
          "errors.transactions.investmentSplitNoIncremental",
          "Investment splits cannot be added incrementally; replace the full split set instead.",
        ),
      );
    }
    assertTargetAmountOnTransfer(splitDto);
    if (splitDto.categoryId) {
      await this.validateCategoryOwnership(userId, splitDto.categoryId);
    }

    // Provider rate lookups happen out here, never while holding the parent
    // lock below; see prewarmSplitTransferRates.
    await this.prewarmSplitTransferRates(
      userId,
      [splitDto],
      transaction.accountId,
      transaction.transactionDate,
    );

    // The target account of a transfer child added here, so its net-worth state
    // is invalidated after commit -- the counterpart lives in an account this
    // transaction's parent never named (recheck RR5-002) -- and the parent's
    // own account once the line re-totals it.
    const affectedAccountIds = new Set<string>();
    const savedSplitId = await withScopedDb(this.dataSource, async (m) => {
      // The aggregate check and the insert are one serialized unit.
      //
      // Reading the split set, validating in application code, and inserting in
      // a later transaction is a check-then-act with nothing under it: the schema
      // has no aggregate constraint, and two inserts against the same parent hold
      // compatible foreign-key key-share locks, so both commit. Parent -100.00
      // with -60.00 already split, two concurrent -30.00 additions each
      // validating -90.00, and the splits total -120.00 (audit P4-009).
      //
      // The parent row lock is what serializes them. Every other writer of this
      // split set -- full replacement included -- takes the same lock, so the
      // second request re-reads the set the first one committed and refuses.
      const parent = await lockTransactionRow(m, transaction.id, userId);
      if (!parent) {
        throw new NotFoundException(
          tr(
            "errors.transactions.notFoundById",
            `Transaction with ID ${transaction.id} not found`,
            { id: transaction.id },
          ),
        );
      }

      // Strict reconciled lock, before the split set is read or written.
      await assertReconciledRowsMutable(m, userId, [parent]);

      // The line is in the parent account's currency, held to its places.
      let places = await withCurrencyPlaces(m, new Map(), [
        transaction.currencyCode,
      ]);
      assertAmountPrecision(
        splitDto.amount,
        precisionCurrencyFor(places, transaction.currencyCode),
        "amount",
      );
      const decimals = moneyDecimalsForCode(places, transaction.currencyCode);

      const existingSplits = await m.getRepository(TransactionSplit).find({
        where: { transactionId: transaction.id },
      });
      const existingTotal = sumMoney(
        existingSplits.map((s) => Number(s.amount)),
        decimals,
      );
      const newTotal = sumMoney(
        [existingTotal, Number(splitDto.amount)],
        decimals,
      );
      const transactionAmount = roundMoney(parent.amount, decimals);

      // A whole set -- a parent flagged a split whose lines add up to it --
      // grows by the line, the mirror of `removeSplit` (issue #2039): the
      // parent's amount becomes the new total and its account moves by the
      // line, so the lines still add up to the parent afterwards. Before, the
      // line was refused as exceeding the parent when it shared the parent's
      // sign, and accepted when it did not: a +10.00 line on a -100.00 set left
      // lines of -90.00 under a -100.00 parent. A parent that is not a whole
      // set keeps the incremental rule below: its lines fill it without moving
      // its amount or its account.
      const growsWholeSet =
        parent.isSplit &&
        existingSplits.length > 0 &&
        existingTotal === transactionAmount;

      if (!growsWholeSet && Math.abs(newTotal) > Math.abs(transactionAmount)) {
        throw new BadRequestException(
          tr(
            "errors.transactions.splitExceedsTransactionAmount",
            `Adding this split would exceed the transaction amount. ` +
              `Current total: ${existingTotal}, New split: ${splitDto.amount}, ` +
              `Transaction amount: ${transactionAmount}`,
            {
              existingTotal,
              newSplit: splitDto.amount,
              transactionAmount,
            },
          ),
        );
      }

      const splitKind = splitDto.transferAccountId
        ? SplitKind.TRANSFER
        : SplitKind.CATEGORY;
      const split = m.create(TransactionSplit, {
        transactionId: transaction.id,
        kind: splitKind,
        categoryId: splitDto.categoryId || null,
        transferAccountId: splitDto.transferAccountId || null,
        amount: splitDto.amount,
        memo: splitDto.memo || null,
      });

      const savedSplit = await m.save(split);

      if (splitDto.transferAccountId) {
        const targetAccount = await this.accountsService.findOne(
          userId,
          splitDto.transferAccountId,
        );
        // Built from the locked parent, not the caller's snapshot: see the note
        // in `updateSplits` (audit FV4-002).
        const sourceAccount = await this.accountsService.findOne(
          userId,
          parent.accountId,
        );

        places = await withCurrencyPlaces(m, places, [
          sourceAccount.currencyCode,
          targetAccount.currencyCode,
        ]);
        const counterpart = await this.resolveSplitTransferAmount(
          splitDto.amount,
          sourceAccount.currencyCode,
          targetAccount.currencyCode,
          String(transaction.transactionDate),
          splitDto.transferTargetAmount,
          places,
        );

        const linkedTransaction = m.create(Transaction, {
          userId,
          accountId: splitDto.transferAccountId,
          // Date from the locked row (04-02 concurrency convention); amount is the
          // cross-currency-converted counterpart, not a raw negation (audit P5-002).
          transactionDate: parent.transactionDate,
          amount: counterpart.amount,
          currencyCode: targetAccount.currencyCode,
          exchangeRate: counterpart.exchangeRate,
          description: splitDto.memo || null,
          isTransfer: true,
          // A VOID parent's counterpart is VOID and moves no balance, exactly as
          // on the bulk creation path (FR-002 family). The status and the payee
          // come off the locked parent, not the caller's snapshot (FV4-002): a
          // VOID committed between the caller's read and this lock otherwise
          // wrote an active leg under a VOID parent (A26-M09).
          status: parent.status as TransactionStatus,
          payeeId: parent.payeeId || null,
          // Blank stays blank (issue #1214): the label resolves at read time.
          payeeName: parent.payeeName || null,
        });

        const savedLinkedTransaction = await m.save(linkedTransaction);
        affectedAccountIds.add(splitDto.transferAccountId);

        await m.update(TransactionSplit, savedSplit.id, {
          linkedTransactionId: savedLinkedTransaction.id,
        });

        // Same two rules as the bulk creation path above: a VOID parent's
        // counterpart moves no balance, and the amount is the converted one.
        if (parent.status === TransactionStatus.VOID) {
          // Recorded, not applied.
        } else if (isTransactionInFuture(parent.transactionDate)) {
          await this.accountsService.recalculateCurrentBalance(
            userId,
            splitDto.transferAccountId,
          );
        } else {
          await this.accountsService.updateBalance(
            splitDto.transferAccountId,
            counterpart.amount,
          );
        }
      }

      if (
        growsWholeSet &&
        (await retotalSplitParent(
          m,
          userId,
          parent,
          newTotal,
          decimals,
          this.accountsService,
        ))
      ) {
        affectedAccountIds.add(parent.accountId);
      }

      const totalSplits = existingSplits.length + 1;
      if (totalSplits >= 2 && !parent.isSplit) {
        await m.update(Transaction, transaction.id, {
          isSplit: true,
          categoryId: null,
        });
      }

      return savedSplit.id;
    });

    const splitWithRelations = await withScopedDb(this.dataSource, (m) =>
      m.getRepository(TransactionSplit).findOne({
        where: { id: savedSplitId },
        relations: ["category", "transferAccount"],
      }),
    );

    if (!splitWithRelations) {
      throw new NotFoundException(
        tr(
          "errors.transactions.splitNotFoundById",
          `Split with ID ${savedSplitId} not found`,
          { id: savedSplitId },
        ),
      );
    }

    this.invalidateNetWorth(affectedAccountIds, userId);
    return splitWithRelations;
  }

  async removeSplit(
    transaction: Transaction,
    splitId: string,
    userId: string,
  ): Promise<void> {
    // Accounts this removal moved, the parent's included once its amount
    // changes, invalidated after commit (recheck RR5-002).
    const affectedAccountIds = new Set<string>();
    const touchedSecurityIds = new Set<string>();
    await withScopedDb(this.dataSource, async (m) => {
      // The parent first, so a concurrent split mutation on the same parent
      // serializes behind this one, and so the split below is read from a state
      // that cannot change under us. The old code read the split in its own
      // autocommit transaction before opening this one, then reversed a balance
      // from that snapshot -- two concurrent removals of the same transfer split
      // each applied the reversal while only one row went away (audit FV4-002).
      const lockedParent = await lockTransactionRow(m, transaction.id, userId);
      if (!lockedParent) {
        throw new NotFoundException(
          tr(
            "errors.transactions.notFoundById",
            `Transaction with ID ${transaction.id} not found`,
            { id: transaction.id },
          ),
        );
      }

      // Strict reconciled lock, before the split is read or removed.
      await assertReconciledRowsMutable(m, userId, [lockedParent]);

      const split = await m.getRepository(TransactionSplit).findOne({
        where: { id: splitId, transactionId: transaction.id },
        relations: ["investmentTransaction"],
      });

      if (!split) {
        // Either it never existed or another request removed it while this one
        // waited for the parent lock. Both are "not found", and neither has left
        // a balance for this call to reverse.
        throw new NotFoundException(
          tr(
            "errors.transactions.splitNotFoundById",
            `Split with ID ${splitId} not found`,
            { id: splitId },
          ),
        );
      }

      // Everything this removal decides is decided here, before its first
      // write, so a refusal below leaves nothing to roll back (issue #2039).
      const remainingSplits = (
        await m.find(TransactionSplit, {
          where: { transactionId: transaction.id },
          relations: ["investmentTransaction"],
          order: { createdAt: "ASC" },
        })
      ).filter((s) => s.id !== split.id);

      // The line's money leaves the parent with it (issue #2025), when the
      // lines added up to the parent before the removal: removing a -60.00 line
      // from a -100.00 parent leaves -40.00, and the parent's account gets back
      // exactly what the line accounted for. Taken off the locked parent, not
      // the caller's copy, through the re-total the edit of a split-transfer
      // leg uses (`retotalSplitParent`).
      //
      // A set that did not add up to the parent was built line by line through
      // `addSplit`, which moves neither the parent's amount nor its account, so
      // its removal moves neither back: the parent's money was never the
      // lines', and taking a line off a plain -100.00 row that had one -30.00
      // line added would otherwise shrink it to -70.00 and credit 30.00 that
      // never left the account. The same holds for a first `addSplit` line
      // equal to the whole parent: `addSplit` flags the parent a split only at
      // its second line, so the lines are the parent's money only once the
      // locked row says it is a split (every path that writes a whole set --
      // create, `updateSplits`, the update with splits -- sets the flag).
      // Judged at the parent currency's precision, so a coin parent keeps the
      // satoshis of every line (INV-MONEY-001).
      const decimals = moneyDecimalsForCode(
        await loadCurrencyPlaces(m, [transaction.currencyCode]),
        transaction.currencyCode,
      );
      const parentAmount = roundMoney(Number(lockedParent.amount), decimals);
      const linesCoveredParent =
        lockedParent.isSplit &&
        sumMoney(
          [
            ...remainingSplits.map((s) => Number(s.amount)),
            Number(split.amount),
          ],
          decimals,
        ) === parentAmount;
      const removedAmount = roundMoney(Number(split.amount), decimals);
      const newParentAmount = linesCoveredParent
        ? roundMoney(parentAmount - removedAmount, decimals)
        : parentAmount;

      // The parent collapses into its last line when that line accounts for
      // the whole re-totalled parent. Not into an investment line, whose
      // representation only makes sense as part of a split parent; nor into a
      // line that does not cover the parent (a set built line by line through
      // `addSplit`, above), which would hand the parent a category or transfer
      // for money the line never held.
      const lastSplit =
        remainingSplits.length === 1 ? remainingSplits[0] : undefined;
      const collapseInto =
        lastSplit &&
        lastSplit.kind !== SplitKind.INVESTMENT &&
        roundMoney(Number(lastSplit.amount), decimals) === newParentAmount
          ? lastSplit
          : undefined;

      const removedLegId =
        split.kind !== SplitKind.INVESTMENT &&
        split.linkedTransactionId &&
        split.transferAccountId
          ? split.linkedTransactionId
          : null;
      const keptLegId =
        collapseInto?.linkedTransactionId && collapseInto.transferAccountId
          ? collapseInto.linkedTransactionId
          : null;

      // Both legs in one ascending batch, after the parent: the by-role order
      // of `common/db/locks.ts`. The removed line's leg is deleted and the kept
      // one is relinked, so both are writes in another account and both answer
      // the strict reconciled lock the parent already answered (issue #2039).
      const legs = await lockTransactionRows(
        m,
        [removedLegId, keptLegId].filter((id): id is string => id !== null),
        userId,
      );
      await assertReconciledRowsMutable(m, userId, [...legs.values()]);
      const keptLeg = keptLegId ? legs.get(keptLegId) : undefined;
      if (keptLegId && !keptLeg) {
        throw new ConflictException(
          tr(
            "errors.transactions.transferChangedConcurrently",
            "This transfer was changed by another request. Reload it and try again.",
          ),
        );
      }

      if (split.kind === SplitKind.INVESTMENT && split.investmentTransaction) {
        if (split.investmentTransaction.accountId) {
          affectedAccountIds.add(split.investmentTransaction.accountId);
        }
        await this.investmentTransactionsService.reverseAndRemoveEmbedded(
          m,
          userId,
          split.investmentTransaction,
          { touchedSecurityIds },
        );
      } else if (removedLegId) {
        // Absent when another request already removed the leg: nothing is
        // reversed for it here (audit FV4-002).
        const removedLeg = legs.get(removedLegId);
        if (removedLeg) {
          affectedAccountIds.add(removedLeg.accountId);
          await removeLockedTransactionLeg(
            m,
            removedLeg,
            userId,
            this.accountsService,
          );
        }
      }

      await m.remove(split);

      if (
        await retotalSplitParent(
          m,
          userId,
          lockedParent,
          newParentAmount,
          decimals,
          this.accountsService,
        )
      ) {
        affectedAccountIds.add(lockedParent.accountId);
      }

      if (remainingSplits.length >= 2) return;
      if (remainingSplits.length === 0) {
        await m.update(Transaction, transaction.id, { isSplit: false });
        return;
      }
      if (!collapseInto) return;

      // The parent becomes the line, so what the line carried moves onto it
      // before the line's row goes (issue #2039): its tags join the parent's
      // (a line's tags are cumulative with its parent's), and its memo fills a
      // parent description that is blank.
      await this.moveLineOntoParent(m, userId, lockedParent.id, collapseInto);

      if (keptLeg) {
        // The last line is a transfer, so the parent becomes that transfer and
        // its counterpart stays where it is. The old path deleted the
        // counterpart -- money recorded as arriving in another account, on a
        // request that never named that line -- and left the parent a plain
        // transaction with no category and no transfer (issue #2025).
        await m.remove(collapseInto);
        // The pair links both ways, as a created transfer's legs do; the
        // parent keeps its own currency at rate 1 and the leg its own
        // converted amount and rate, which is the plain transfer's shape.
        await m.update(Transaction, transaction.id, {
          isSplit: false,
          isTransfer: true,
          categoryId: null,
          linkedTransactionId: keptLeg.id,
        });
        await m.update(Transaction, keptLeg.id, {
          linkedTransactionId: transaction.id,
        });
        return;
      }

      await m.update(Transaction, transaction.id, {
        isSplit: false,
        categoryId: collapseInto.categoryId,
      });
      await m.remove(collapseInto);
    });

    this.invalidateNetWorth(affectedAccountIds, userId);
    await this.recomputeBondPricesAfterWrite(userId, touchedSecurityIds);
  }

  /**
   * Carry a split line's tags and memo onto its parent, for the collapse of a
   * parent into its one remaining line, so they do not go with the line's row.
   *
   * The tags join the parent's in one statement (the pair is the primary key,
   * so a tag both already carry stays one link). The memo becomes the parent's
   * description only where that is blank: a description the person wrote for
   * the whole transaction is not overwritten by one line's note.
   */
  private async moveLineOntoParent(
    m: EntityManager,
    userId: string,
    parentId: string,
    line: TransactionSplit,
  ): Promise<void> {
    await m.query(
      `INSERT INTO transaction_tags (transaction_id, tag_id)
       SELECT $1, st.tag_id
         FROM transaction_split_tags st
         JOIN tags t ON t.id = st.tag_id AND t.user_id = $3
        WHERE st.transaction_split_id = $2
       ON CONFLICT DO NOTHING`,
      [parentId, line.id, userId],
    );
    const memo = line.memo?.trim();
    if (!memo) return;
    await m.query(
      `UPDATE transactions SET description = $3
        WHERE id = $1 AND user_id = $2
          AND COALESCE(TRIM(description), '') = ''`,
      [parentId, userId, memo],
    );
  }
}
