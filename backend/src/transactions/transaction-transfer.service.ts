import {
  Injectable,
  BadRequestException,
  ConflictException,
  Inject,
  NotFoundException,
  forwardRef,
  Logger,
} from "@nestjs/common";
import { DataSource, EntityManager } from "typeorm";
import { Transaction, TransactionStatus } from "./entities/transaction.entity";
import { TransactionSplit } from "./entities/transaction-split.entity";
import { Category } from "../categories/entities/category.entity";
import { CreateTransferDto } from "./dto/create-transfer.dto";
import { UpdateTransferDto } from "./dto/update-transfer.dto";
import { AccountsService } from "../accounts/accounts.service";
import { Account } from "../accounts/entities/account.entity";
import { PayeesService } from "../payees/payees.service";
import { NetWorthService } from "../net-worth/net-worth.service";
import { isTransactionInFuture } from "../common/date-utils";
import { ActionHistoryService } from "../action-history/action-history.service";
import { CrossOwnerAccessService } from "../delegation/cross-owner-access.service";
import { ExchangeRateService } from "../currencies/exchange-rate.service";
import { formatCurrency } from "../common/format-currency.util";
import { roundMoney } from "../common/round.util";
import {
  assertTransactionCurrencyMatchesAccount,
  roundFxRate,
  resolveFxRateOrNull,
} from "../common/fx-entry.util";
import { stripHtml } from "../common/sanitization.util";
import { tr } from "../i18n/translate";
import { withScopedDb } from "../common/db/scoped-db";
import { lockTransactionRow, lockTransactionRows } from "../common/db/locks";
import { assertReconciledRowsMutable } from "./reconciled-lock.util";
import { removeLockedTransactionLeg } from "./remove-transaction-leg";
import { autoTransferPayeeName } from "./transfer-payee-label.util";
import { withSystemContext } from "../common/db/with-context";
import {
  RuleEffectsPreview,
  TransactionRulesApplierService,
} from "../transaction-rules/transaction-rules-applier.service";

export interface TransferResult {
  fromTransaction: Transaction;
  toTransaction: Transaction;
}

/**
 * Who is performing a transfer operation. `effectiveUserId` is the ledger the
 * request runs against (the owner's id while a delegate is acting);
 * `realUserId` is the authenticated human, whose delegations decide
 * cross-owner access. Non-HTTP callers (scheduled posting, AI prep) omit it
 * and both ids default to `userId` -- identical to pre-cross-owner behavior.
 */
export interface TransferActor {
  effectiveUserId: string;
  realUserId: string;
}

/**
 * A transfer that has been validated and fully authorized but not yet written.
 *
 * The product of `prepareTransfer`, consumed by `writeTransferLegs` and
 * `completeTransfer`. It exists so authorization -- which reads foreign account
 * rows under a system context -- happens before a caller's transaction opens,
 * rather than nesting an identity that `withScopedDb` will refuse to join.
 */
export interface PreparedTransfer {
  /** The user the transfer is filed under; for a delegate, the owner. */
  effectiveUserId: string;
  /** The authenticated user, which differs from the above under delegation. */
  realUserId: string;
  dto: CreateTransferDto;
  fromAccount: Account;
  toAccount: Account;
  fromOwnerId: string;
  toOwnerId: string;
  /** True when either leg belongs to somebody other than the effective user. */
  hasForeignLeg: boolean;
  toAmount: number;
  /**
   * Derived by `resolveTransferFx` from the accounts, not echoed from the
   * request: these are the values the legs are actually written with.
   */
  sourceCurrency: string;
  destinationCurrency: string;
  effectiveExchangeRate: number;
  /**
   * The caller's custom payee label, or null. A blank payee is PERSISTED blank
   * (issue #1214): the display label ("Transfer to Savings") is resolved at
   * read time from the counterpart account's current name, never stamped into
   * the row. See transfer-payee-label.util.ts.
   */
  fromPayeeName: string | null;
  toPayeeName: string | null;
}

/**
 * Resolved, sanitized preview of a transfer the assistant proposes to create.
 * Carries the resulting state of both legs (resolved account ids/names, derived
 * currencies, and the computed destination amount) so the signed descriptor can
 * reproduce it on confirm. Shared by the AI Assistant tool executor and the MCP
 * tool via the transaction-tool prep service.
 */
export interface CreateTransferPreview {
  fromAccountId: string;
  fromAccountName: string;
  fromCurrencyCode: string;
  toAccountId: string;
  toAccountName: string;
  toCurrencyCode: string;
  amount: number;
  toAmount: number;
  exchangeRate: number;
  transactionDate: string;
  description: string | null;
  /** Existing payee the custom label resolved to, or null to record free text. */
  payeeId: string | null;
  payeeName: string | null;
  /** True when the custom label matched an existing payee. */
  payeeMatched: boolean;
  /** True when approving will create a new payee from an unmatched label. */
  payeeWillBeCreated: boolean;
  /** Spending category applied to both legs on create (null = none). */
  categoryId: string | null;
  categoryName: string | null;
  /**
   * What the user's `create` rules will do to the transfer's legs on approval
   * (display-only, not signed). Absent when no rule matches.
   */
  ruleEffects?: RuleEffectsPreview;
}

/** Resolved, sanitized preview of an edit the assistant proposes to a transfer. */
export interface UpdateTransferPreview {
  transactionId: string;
  fromAccountId: string;
  fromAccountName: string;
  fromCurrencyCode: string;
  toAccountId: string;
  toAccountName: string;
  toCurrencyCode: string;
  amount: number;
  toAmount: number;
  exchangeRate: number;
  transactionDate: string;
  description: string | null;
  payeeId: string | null;
  payeeName: string | null;
  payeeMatched: boolean;
  payeeWillBeCreated: boolean;
  /** Spending category applied to both legs after the edit (null = none). */
  categoryId: string | null;
  categoryName: string | null;
}

@Injectable()
export class TransactionTransferService {
  private readonly logger = new Logger(TransactionTransferService.name);

  constructor(
    @Inject(forwardRef(() => AccountsService))
    private accountsService: AccountsService,
    private payeesService: PayeesService,
    @Inject(forwardRef(() => NetWorthService))
    private netWorthService: NetWorthService,
    private dataSource: DataSource,
    private actionHistoryService: ActionHistoryService,
    private crossOwnerAccess: CrossOwnerAccessService,
    private exchangeRateService: ExchangeRateService,
    // forwardRef: the applier reaches this file back through its imports.
    @Inject(forwardRef(() => TransactionRulesApplierService))
    private rulesApplier: TransactionRulesApplierService,
  ) {}

  /**
   * Resolve the two currency codes and the destination amount for a transfer
   * from the accounts themselves.
   *
   * All three used to be client-authoritative (audit P5-002). The service loaded
   * both accounts and then trusted the request's `fromCurrencyCode`,
   * `toCurrencyCode`, `exchangeRate` (validated only `@Min(0)`) and `toAmount`:
   *
   * - A cross-currency transfer with no rate defaulted to 1, so 100 USD landed
   *   as 100 EUR. Scheduled transfers hit this every time: the schedule carries
   *   only the source currency, so it supplied no target currency, no rate and
   *   no destination amount.
   * - The destination row was labelled with the source currency, contaminating
   *   every later conversion that read it.
   * - An explicit `toAmount` overrode everything with no conservation check, so
   *   `amount=100, toAmount=80` between two same-currency accounts destroyed 20.
   *
   * The rules now:
   * - Currency codes come from the accounts. A request that names a different
   *   one is rejected rather than persisted.
   * - Same currency: the destination amount equals the source amount. An
   *   explicit `toAmount` that disagrees is a rejection, not an override --
   *   there is no rate or fee that can make a same-currency transfer unequal.
   * - Different currencies: an explicit `toAmount` is honoured (a bank's actual
   *   settlement figure, which legitimately differs from spot by fees), and
   *   otherwise the rate is resolved server-side -- the supplied one if it is
   *   strictly positive, else the market rate for the transfer date, else the
   *   latest stored rate. If none can be found the transfer is refused rather
   *   than posted at 1:1.
   *
   * Direction is destination-currency units per one source-currency unit.
   */
  private async resolveTransferFx(input: {
    fromAccount: Account;
    toAccount: Account;
    amount: number;
    transactionDate: string;
    suppliedFromCurrencyCode?: string;
    suppliedToCurrencyCode?: string;
    suppliedExchangeRate?: number;
    suppliedToAmount?: number;
  }): Promise<{
    fromCurrencyCode: string;
    toCurrencyCode: string;
    exchangeRate: number;
    toAmount: number;
  }> {
    const fromCurrencyCode = assertTransactionCurrencyMatchesAccount(
      input.suppliedFromCurrencyCode,
      input.fromAccount.currencyCode,
    );
    const toCurrencyCode = assertTransactionCurrencyMatchesAccount(
      input.suppliedToCurrencyCode,
      input.toAccount.currencyCode,
    );

    const amount = roundMoney(input.amount);

    if (fromCurrencyCode === toCurrencyCode) {
      if (
        input.suppliedToAmount !== undefined &&
        roundMoney(input.suppliedToAmount) !== amount
      ) {
        throw new BadRequestException(
          tr(
            "errors.transactions.transferSameCurrencyMustConserve",
            `A transfer between two ${toCurrencyCode} accounts must move the same amount on both sides (received ${roundMoney(input.suppliedToAmount)} against ${amount})`,
            { currency: toCurrencyCode, amount },
          ),
        );
      }
      if (
        input.suppliedExchangeRate !== undefined &&
        Number(input.suppliedExchangeRate) !== 1
      ) {
        throw new BadRequestException(
          tr(
            "errors.transactions.transferSameCurrencyRateMustBeOne",
            `A transfer between two ${toCurrencyCode} accounts cannot have an exchange rate other than 1`,
            { currency: toCurrencyCode },
          ),
        );
      }
      return {
        fromCurrencyCode,
        toCurrencyCode,
        exchangeRate: 1,
        toAmount: amount,
      };
    }

    // Cross-currency. An explicit settlement amount wins, and its implied rate
    // is stored so the destination row still records how the two sides relate.
    if (input.suppliedToAmount !== undefined) {
      const toAmount = roundMoney(input.suppliedToAmount);

      // A settlement amount still has to settle *this* transfer. Both DTO
      // fields allow zero and this branch used to return before checking
      // anything: `amount=100, toAmount=0` destroyed 100 of value and stored a
      // rate of 0, while `amount=0, toAmount=100` created 100 out of nothing
      // and stored a rate of 1 because the divisor was zero. Neither is a rate,
      // and neither is a transfer.
      if ((amount === 0) !== (toAmount === 0)) {
        throw new BadRequestException(
          tr(
            "errors.transactions.transferAmountsMustAgreeOnZero",
            `A transfer must move a non-zero amount on both sides, or zero on both (received ${amount} against ${toAmount})`,
            { amount, toAmount },
          ),
        );
      }

      if (amount === 0) {
        // Zero on both sides: nothing moves, and there is no rate to imply.
        return {
          fromCurrencyCode,
          toCurrencyCode,
          exchangeRate: 1,
          toAmount: 0,
        };
      }

      const impliedRate = roundFxRate(toAmount / amount);
      if (!Number.isFinite(impliedRate) || impliedRate <= 0) {
        throw new BadRequestException(
          tr(
            "errors.transactions.transferImpliedRateInvalid",
            `The destination amount ${toAmount} implies an unusable exchange rate against the source amount ${amount}`,
            { amount, toAmount },
          ),
        );
      }

      return {
        fromCurrencyCode,
        toCurrencyCode,
        exchangeRate: impliedRate,
        toAmount,
      };
    }

    // Zero moves nothing on either side, so it needs no rate ("zero needs no
    // rate", `AGENTS.md`): a zero-amount scheduled placeholder between two
    // currencies posts as 0 -> 0, and demanding a resolvable pair here refused
    // a transfer that moves nothing. Mirrors the zero-on-both-sides return in
    // the explicit-toAmount branch above.
    if (amount === 0) {
      return {
        fromCurrencyCode,
        toCurrencyCode,
        exchangeRate: 1,
        toAmount: 0,
      };
    }

    const supplied = input.suppliedExchangeRate;
    let rate: number | null =
      supplied !== undefined && Number(supplied) > 0
        ? roundFxRate(Number(supplied))
        : null;

    if (rate === null) {
      rate = await resolveFxRateOrNull(
        this.exchangeRateService,
        fromCurrencyCode,
        toCurrencyCode,
        input.transactionDate,
      );
    }
    if (rate === null) {
      throw new BadRequestException(
        tr(
          "errors.transactions.transferRateUnavailable",
          `Could not determine an exchange rate for ${fromCurrencyCode} -> ${toCurrencyCode}. Supply an exchangeRate or a destination amount so the transfer posts correctly.`,
          { from: fromCurrencyCode, to: toCurrencyCode },
        ),
      );
    }

    const exchangeRate = rate;
    return {
      fromCurrencyCode,
      toCurrencyCode,
      exchangeRate,
      toAmount: roundMoney(amount * exchangeRate),
    };
  }

  /**
   * FX for an *edit*, which is not the same question as FX for a creation.
   *
   * `resolveTransferFx` answers "what does this transfer settle at", and calling
   * it on every edit made two things go wrong (recheck RR2-003 and RR2-004):
   *
   * - A presentation-only edit re-resolved the rate. Changing a description on a
   *   100 USD -> 90 EUR transfer resolved today's rate, and since the FR-007 fix
   *   writes a resolved rate whenever it differs from the row's, the row became
   *   90 EUR at 0.80 -- an internally inconsistent pair, from an edit that touched
   *   no money. Worse, the same edit was *refused* when no current rate existed,
   *   even though the transfer already held a perfectly good settlement.
   * - When resolution genuinely applied, only part of the tuple was persisted.
   *   Moving the destination leg to a GBP account with no explicit amount wrote
   *   the account, the currency and the rate, and left the old EUR *number* on the
   *   row: 90 GBP at 0.80 against a 100 USD source, with the balance already moved
   *   by 80. The next recompute silently changed the account by the difference.
   *
   * So: re-price only when the financial structure changed -- either account, the
   * source amount, an explicit destination amount, or an explicit rate -- and when
   * it did, `repriced` tells the builders to write the whole resolved tuple.
   *
   * A date change deliberately does *not* re-price. The rate a transfer settled at
   * is a fact about the transfer, not a function of the date field, and correcting
   * a mistyped date should not restate what the bank actually paid -- nor be
   * refused because that day has no stored rate. A user who wants the new date's
   * rate supplies a rate or a destination amount, which does re-price.
   *
   * A supplied currency code is still validated against its account either way, so
   * a mismatched code cannot ride in on a presentation-only edit.
   */
  private async resolveTransferFxForUpdate(input: {
    fromAccount: Account;
    toAccount: Account;
    amount: number;
    transactionDate: string;
    existingFromAccountId: string;
    existingToAccountId: string;
    existingFromAmount: number;
    existingToAmount: number;
    existingExchangeRate: number | null;
    updateDto: Partial<UpdateTransferDto>;
  }): Promise<{
    fromCurrencyCode: string;
    toCurrencyCode: string;
    exchangeRate: number;
    toAmount: number;
    repriced: boolean;
  }> {
    const { updateDto } = input;

    // A *value* difference, not the presence of a field. The transfer form
    // resends the current accounts, amount and rate on every save -- the frozen
    // cross-owner path in this same service already compares values for exactly
    // that reason -- so keying off presence made an idempotent full-form payload
    // re-price a settled transfer (recheck RR3-002): the same request that only
    // changed a description re-resolved today's rate, restated a 90 EUR
    // destination as 80, and moved the balance with it. Presence is what the
    // client happened to send; a difference is what the user changed.
    const differs = (supplied: number | undefined, existing: number): boolean =>
      supplied !== undefined && roundMoney(supplied) !== roundMoney(existing);

    const financialStructureChanged =
      (updateDto.fromAccountId !== undefined &&
        updateDto.fromAccountId !== input.existingFromAccountId) ||
      (updateDto.toAccountId !== undefined &&
        updateDto.toAccountId !== input.existingToAccountId) ||
      differs(updateDto.amount, input.existingFromAmount) ||
      differs(updateDto.toAmount, input.existingToAmount) ||
      (updateDto.exchangeRate !== undefined &&
        roundFxRate(Number(updateDto.exchangeRate)) !==
          roundFxRate(Number(input.existingExchangeRate ?? 1)));

    if (financialStructureChanged) {
      const fx = await this.resolveTransferFx({
        fromAccount: input.fromAccount,
        toAccount: input.toAccount,
        amount: input.amount,
        transactionDate: input.transactionDate,
        suppliedFromCurrencyCode: updateDto.fromCurrencyCode,
        suppliedToCurrencyCode: updateDto.toCurrencyCode,
        suppliedExchangeRate: updateDto.exchangeRate,
        suppliedToAmount: updateDto.toAmount,
      });
      return { ...fx, repriced: true };
    }

    // Nothing financial changed: keep the settlement the transfer already has.
    // The currencies are still derived from the accounts and still validated.
    const storedRate = Number(input.existingExchangeRate);
    return {
      fromCurrencyCode: assertTransactionCurrencyMatchesAccount(
        updateDto.fromCurrencyCode,
        input.fromAccount.currencyCode,
      ),
      toCurrencyCode: assertTransactionCurrencyMatchesAccount(
        updateDto.toCurrencyCode,
        input.toAccount.currencyCode,
      ),
      exchangeRate:
        Number.isFinite(storedRate) && storedRate > 0 ? storedRate : 1,
      toAmount: input.existingToAmount,
      repriced: false,
    };
  }

  private triggerNetWorthRecalc(accountId: string, userId: string): void {
    this.netWorthService.triggerDebouncedRecalc(accountId, userId);
  }

  /**
   * Ensure a category belongs to the user before it is stored on a transfer
   * leg. Mirrors the check in transactions.service.create(). A null/undefined
   * id is allowed (no category / clearing it).
   */
  private async assertCategoryOwned(
    userId: string,
    categoryId: string | null | undefined,
  ): Promise<void> {
    if (!categoryId) return;
    const category = await withScopedDb(this.dataSource, (m) =>
      m.getRepository(Category).findOne({
        where: { id: categoryId, userId },
      }),
    );
    if (!category) {
      throw new BadRequestException(
        tr("errors.transactions.categoryNotFound", "Category not found"),
      );
    }
  }

  async createTransfer(
    userId: string,
    createTransferDto: CreateTransferDto,
    findOne: (userId: string, id: string) => Promise<Transaction>,
    actor?: TransferActor,
  ): Promise<TransferResult> {
    const prepared = await this.prepareTransfer(
      userId,
      createTransferDto,
      actor,
    );
    const { savedFromId, savedToId } = await this.writeTransferLegs(prepared);
    return this.completeTransfer(prepared, savedFromId, savedToId, findOne);
  }

  /**
   * Validate and authorize a transfer without writing anything.
   *
   * Split out of `createTransfer` so a caller that already holds a transaction
   * can decide authorization *before* opening it. Both halves of that decision
   * read rows the caller is not guaranteed to own -- `accountAccessFor` loads
   * the account by id under `withSystemContext` precisely because learning a
   * foreign account's owner is the decision input -- and a system-identity
   * `withScopedDb` cannot join a user-identity transaction: it throws
   * `IDENTITY_MISMATCH_MESSAGE` rather than silently running under the outer
   * GUCs. Deciding first is also the rule in docs/backend/database-access-and-tenancy.md ("Decide
   * authorization first, under scoped(), and let only the minimum out").
   *
   * Everything here is a read or a pure computation, so it is safe to run
   * outside the caller's transaction: account ownership and delegation grants
   * are not written by the posting that follows.
   */
  async prepareTransfer(
    userId: string,
    createTransferDto: CreateTransferDto,
    actor?: TransferActor,
  ): Promise<PreparedTransfer> {
    const realUserId = actor?.realUserId ?? userId;
    // Only the fields this half needs. The rest of the payload is carried on
    // `PreparedTransfer.dto` and destructured by `writeTransferLegs`, which is
    // where the columns are actually written.
    const {
      fromAccountId,
      toAccountId,
      transactionDate,
      amount,
      fromCurrencyCode,
      toCurrencyCode,
      // The rate is not destructured with a default of 1 any more: defaulting it
      // here is what let a cross-currency transfer post at par. It is read from
      // the DTO inside resolveTransferFx, which resolves a real rate or refuses.
      toAmount: explicitToAmount,
      payeeName: customPayeeName,
      categoryId,
    } = createTransferDto;

    if (fromAccountId === toAccountId) {
      throw new BadRequestException(
        tr(
          "errors.transactions.transferSameAccount",
          "Source and destination accounts must be different",
        ),
      );
    }

    if (amount < 0) {
      throw new BadRequestException(
        tr(
          "errors.transactions.transferAmountNegative",
          "Transfer amount must not be negative",
        ),
      );
    }

    await this.assertCategoryOwned(userId, categoryId);

    // The authoritative per-leg authorization: the REAL user must own each
    // account or hold an active delegation with the create grant on it. For a
    // normal user this reduces to today's ownership check (foreign -> 404).
    const { account: fromAccount } =
      await this.crossOwnerAccess.accountAccessFor(
        realUserId,
        fromAccountId,
        "create",
      );
    const { account: toAccount } = await this.crossOwnerAccess.accountAccessFor(
      realUserId,
      toAccountId,
      "create",
    );
    const fromOwnerId = fromAccount.userId;
    const toOwnerId = toAccount.userId;
    // A leg not owned by the effective user makes this a cross-owner write:
    // per-leg user_id, gated reference data, and a system-context transaction
    // (the transactions WITH CHECK stays owner-only under RLS). Authorization
    // is fully decided above, before the bypass window opens.
    const hasForeignLeg = fromOwnerId !== userId || toOwnerId !== userId;

    // Currencies, rate and destination amount all derived from the accounts.
    const fx = await this.resolveTransferFx({
      fromAccount,
      toAccount,
      amount,
      transactionDate,
      suppliedFromCurrencyCode: fromCurrencyCode,
      suppliedToCurrencyCode: toCurrencyCode,
      suppliedExchangeRate: createTransferDto.exchangeRate,
      suppliedToAmount: explicitToAmount,
    });
    const toAmount = fx.toAmount;
    const sourceCurrency = fx.fromCurrencyCode;
    const destinationCurrency = fx.toCurrencyCode;
    const effectiveExchangeRate = fx.exchangeRate;

    // A blank payee stays blank: the register and every other read surface
    // resolve "Transfer to/from <account>" from the linked leg's account at
    // display time, so a rename or a language change is reflected everywhere.
    const fromPayeeName = customPayeeName || null;
    const toPayeeName = customPayeeName || null;

    return {
      effectiveUserId: userId,
      realUserId,
      dto: createTransferDto,
      fromAccount,
      toAccount,
      fromOwnerId,
      toOwnerId,
      hasForeignLeg,
      toAmount,
      sourceCurrency,
      destinationCurrency,
      effectiveExchangeRate,
      fromPayeeName,
      toPayeeName,
    };
  }

  /**
   * Write both legs, their linkage and the balance updates.
   *
   * `manager` joins the caller's transaction instead of opening one, so a
   * scheduled posting can make the occurrence claim, the money and the schedule
   * advancement one unit. A cross-owner transfer cannot be written that way --
   * the foreign leg fails the owner-only policies and needs the audited system
   * bypass, which is a different identity and therefore a different transaction
   * -- so it is refused rather than silently written under the caller's.
   */
  async writeTransferLegs(
    prepared: PreparedTransfer,
    manager?: EntityManager,
  ): Promise<{ savedFromId: string; savedToId: string }> {
    const {
      effectiveUserId: userId,
      dto,
      fromOwnerId,
      toOwnerId,
      hasForeignLeg,
      toAmount,
      sourceCurrency,
      destinationCurrency,
      effectiveExchangeRate,
      fromPayeeName,
      toPayeeName,
    } = prepared;
    const {
      fromAccountId,
      toAccountId,
      transactionDate,
      amount,
      description,
      payeeId,
      referenceNumber,
      status = TransactionStatus.UNRECONCILED,
      categoryId,
    } = dto;

    // Both legs, their linkage, and the balance updates commit atomically.
    // Each leg is owned by ITS account's owner; per-user reference data
    // (category, payee link) is only written onto effective-user legs.
    const writeLegsAtomically = async (m: EntityManager) => {
      const fromTransaction = m.create(Transaction, {
        userId: fromOwnerId,
        accountId: fromAccountId,
        transactionDate: transactionDate as any,
        amount: -amount,
        currencyCode: sourceCurrency,
        exchangeRate: 1,
        description: description || null,
        referenceNumber,
        status,
        isTransfer: true,
        payeeId: fromOwnerId === userId ? payeeId || null : null,
        payeeName: fromPayeeName,
        categoryId: fromOwnerId === userId ? categoryId || null : null,
      });

      const toTransaction = m.create(Transaction, {
        userId: toOwnerId,
        accountId: toAccountId,
        transactionDate: transactionDate as any,
        amount: toAmount,
        currencyCode: destinationCurrency,
        exchangeRate: effectiveExchangeRate,
        description: description || null,
        referenceNumber,
        status,
        isTransfer: true,
        payeeId: toOwnerId === userId ? payeeId || null : null,
        payeeName: toPayeeName,
        categoryId: toOwnerId === userId ? categoryId || null : null,
      });

      const savedFromTransaction = await m.save(fromTransaction);
      const savedToTransaction = await m.save(toTransaction);

      const fromId = savedFromTransaction.id;
      const toId = savedToTransaction.id;

      await m.update(Transaction, fromId, {
        linkedTransactionId: toId,
      });
      await m.update(Transaction, toId, {
        linkedTransactionId: fromId,
      });

      // Transaction rules (design 6.3): after both legs and their linkage are
      // written, before the balances and the commit, on this manager, so a
      // rollback drops the rule effects with the legs. They change payee and
      // tags only; a VOID transfer is still a row the rules may tag.
      await this.rulesApplier.applyToNewTransfer(m, {
        fromLegId: fromId,
        toLegId: toId,
        fromOwnerId,
        toOwnerId,
      });

      // A VOID transfer is a ledger record of something that did not happen, so
      // neither leg may move a balance -- exactly as an ordinary VOID
      // transaction skips its balance update (transactions.service create()).
      //
      // Without this the pair posted its balances anyway while both rows said
      // VOID, and `recalculateCurrentBalance` -- which excludes VOID rows --
      // then silently "corrected" the accounts the next time anything triggered
      // a recompute. Money appeared to move and then unmove (audit P5-001).
      if (status === TransactionStatus.VOID) {
        return { savedFromId: fromId, savedToId: toId };
      }

      if (isTransactionInFuture(transactionDate)) {
        // Each leg's account is owned by ITS account's owner, which for a
        // cross-owner transfer differs from the acting user -- scope each lock
        // to that owner, never to the caller (maintainer review, PR #1095).
        await this.accountsService.recalculateCurrentBalance(
          fromOwnerId,
          fromAccountId,
        );
        await this.accountsService.recalculateCurrentBalance(
          toOwnerId,
          toAccountId,
        );
      } else {
        await this.accountsService.updateBalance(fromAccountId, -amount);
        await this.accountsService.updateBalance(toAccountId, toAmount);
      }

      return { savedFromId: fromId, savedToId: toId };
    };

    if (manager) {
      if (hasForeignLeg) {
        throw new BadRequestException(
          tr(
            "errors.transactions.transferCrossOwnerNotAtomic",
            "A transfer involving another owner's account cannot be written inside the caller's transaction",
          ),
        );
      }
      return writeLegsAtomically(manager);
    }

    return hasForeignLeg
      ? // Cross-owner: the foreign leg insert and foreign balance update fail
        // the owner-only policies, so the (already fully authorized) atomic
        // block runs under the audited system bypass. No-op at RLS_MODE=off.
        withSystemContext(() =>
          withScopedDb(this.dataSource, writeLegsAtomically),
        )
      : withScopedDb(this.dataSource, writeLegsAtomically);
  }

  /**
   * The post-commit half of a transfer: derived recalculation, the read-back
   * the caller returns, and the action-history record.
   *
   * Deliberately not part of `writeTransferLegs`. `recordCreateTransferHistory`
   * opens a `withSystemContext` for cross-owner records and the recorder
   * swallows its own failures by design -- inside the caller's transaction that
   * is either a `25P02` abort of the posting or a silently dropped undo entry,
   * so it runs after the commit like every other external side effect.
   */
  async completeTransfer(
    prepared: PreparedTransfer,
    savedFromId: string,
    savedToId: string,
    findOne: (userId: string, id: string) => Promise<Transaction>,
  ): Promise<TransferResult> {
    const {
      effectiveUserId,
      realUserId,
      dto,
      fromAccount,
      toAccount,
      fromOwnerId,
      toOwnerId,
    } = prepared;

    this.triggerNetWorthRecalc(dto.fromAccountId, fromOwnerId);
    this.triggerNetWorthRecalc(dto.toAccountId, toOwnerId);

    const result = {
      fromTransaction: await findOne(fromOwnerId, savedFromId),
      toTransaction: await findOne(toOwnerId, savedToId),
    };

    await this.recordCreateTransferHistory({
      effectiveUserId,
      realUserId,
      savedFromId,
      savedToId,
      fromAccount,
      toAccount,
      amount: dto.amount,
      // The derived code, not the request's: it is the one actually stored.
      currencyCode: prepared.sourceCurrency,
    });

    return result;
  }

  /**
   * Action history for a created transfer. Same-owner (both legs the effective
   * user's) keeps producing exactly today's single record. Cross-owner writes
   * one record per leg owner; an account name foreign to that owner is
   * replaced with the "Shared account" label -- an owner must not learn the
   * other party's account name from history. The actor's own entry may name
   * both accounts, since the actor could read both at that moment.
   */
  private async recordCreateTransferHistory(args: {
    effectiveUserId: string;
    realUserId: string;
    savedFromId: string;
    savedToId: string;
    fromAccount: Account;
    toAccount: Account;
    amount: number;
    currencyCode: string;
  }): Promise<void> {
    const {
      effectiveUserId,
      realUserId,
      savedFromId,
      savedToId,
      fromAccount,
      toAccount,
      amount,
      currencyCode,
    } = args;
    const formattedAmount = formatCurrency(amount, currencyCode);
    const afterData = {
      fromTransactionId: savedFromId,
      toTransactionId: savedToId,
      fromAccountId: fromAccount.id,
      toAccountId: toAccount.id,
    };

    if (
      fromAccount.userId === effectiveUserId &&
      toAccount.userId === effectiveUserId
    ) {
      // Same-owner: fire-and-forget, exactly today's behavior.
      void this.actionHistoryService.record(effectiveUserId, {
        entityType: "transfer",
        entityId: savedFromId,
        action: "create",
        afterData,
        description: `Created transfer ${formattedAmount} from ${fromAccount.name} to ${toAccount.name}`,
        descriptionKey: "createdTransfer",
        descriptionParams: {
          // English fallback plus the structured pair the reader's client
          // formats in their own number locale (issue #1316): a stored string
          // outlives the request that wrote it and cannot be re-formatted.
          amount: formattedAmount,
          amountValue: amount,
          amountCurrency: currencyCode,
          from: fromAccount.name,
          to: toAccount.name,
        },
      });
      return;
    }

    const sharedLabel = tr("common.sharedAccountLabel", "Shared account");
    for (const ownerId of new Set([fromAccount.userId, toAccount.userId])) {
      const nameFor = (account: Account) =>
        ownerId === realUserId || account.userId === ownerId
          ? account.name
          : sharedLabel;
      const record = () =>
        this.actionHistoryService.record(ownerId, {
          entityType: "transfer",
          entityId: ownerId === fromAccount.userId ? savedFromId : savedToId,
          action: "create",
          afterData,
          description: `Created transfer ${formattedAmount} from ${nameFor(fromAccount)} to ${nameFor(toAccount)}`,
          descriptionKey: "createdTransfer",
          descriptionParams: {
            // See above: English fallback plus the structured pair.
            amount: formattedAmount,
            amountValue: amount,
            amountCurrency: currencyCode,
            from: nameFor(fromAccount),
            to: nameFor(toAccount),
          },
        });
      if (ownerId === effectiveUserId) {
        await record();
      } else {
        // The counterpart owner's history row carries THEIR user_id; writing
        // it from this request's identity needs the audited bypass under RLS.
        await withSystemContext(record);
      }
    }
  }

  async getLinkedTransaction(
    userId: string,
    transactionId: string,
    findOne: (userId: string, id: string) => Promise<Transaction>,
    actor?: TransferActor,
  ): Promise<Transaction | null> {
    const realUserId = actor?.realUserId ?? userId;
    const transaction = await findOne(userId, transactionId);

    if (!transaction.isTransfer || !transaction.linkedTransactionId) {
      return null;
    }

    try {
      return await findOne(userId, transaction.linkedTransactionId);
    } catch (err) {
      if (!(err instanceof NotFoundException)) {
        this.logger.warn(
          `Failed to load linked transaction ${transaction.linkedTransactionId}: ${err instanceof Error ? err.message : err}`,
        );
        return null;
      }
      // Cross-owner counterpart: return it when the real user can read its
      // account; anything unreadable stays null (never confirm existence).
      const counterpart = await this.loadLegById(
        transaction.linkedTransactionId,
      );
      if (!counterpart) return null;
      try {
        await this.crossOwnerAccess.accountAccessFor(
          realUserId,
          counterpart.accountId,
          "read",
        );
        return counterpart;
      } catch {
        return null;
      }
    }
  }

  /**
   * Load a transfer leg by id with NO user filter. Used only after the
   * owner-scoped findOne misses (a cross-owner counterpart); the caller then
   * decides access via accountAccessFor before anything derived from the row
   * reaches a response. Authorization-decision read under the audited bypass.
   */
  private loadLegById(id: string): Promise<Transaction | null> {
    return withSystemContext(() =>
      withScopedDb(this.dataSource, (m) =>
        m.getRepository(Transaction).findOne({
          where: { id },
          relations: ["account"],
        }),
      ),
    );
  }

  /**
   * Route a transfer mutation whose counterpart the effective user cannot see:
   * connected (real user holds `op` on the counterpart account) -> full
   * cross-leg behavior; readable but not granted `op` -> 403; unreadable ->
   * frozen (null), where only presentational own-leg edits are allowed.
   */
  private async resolveCounterpartAccess(
    realUserId: string,
    counterpart: Transaction,
    op: "edit" | "delete",
  ): Promise<"connected" | "frozen"> {
    try {
      await this.crossOwnerAccess.accountAccessFor(
        realUserId,
        counterpart.accountId,
        op,
      );
      return "connected";
    } catch (err) {
      if (err instanceof NotFoundException) return "frozen";
      throw err; // ForbiddenException: readable but the op is not granted
    }
  }

  /**
   * Detect whether a loaded transaction is a transfer leg. Usable by the prep
   * service to route an update/delete to the transfer-aware flow.
   */
  isTransfer(transaction: Transaction): boolean {
    return transaction.isTransfer === true;
  }

  /**
   * Validate and resolve a proposed transfer WITHOUT persisting it. Resolves the
   * from/to accounts (by id), derives their currencies, computes the destination
   * amount from an explicit toAmount or the exchange rate (via roundMoney), and
   * sanitizes the description. Mirrors the resulting state createTransfer writes.
   */
  async previewCreateTransfer(
    userId: string,
    input: {
      fromAccountId: string;
      toAccountId: string;
      amount: number;
      transactionDate: string;
      exchangeRate?: number;
      toAmount?: number;
      description?: string;
      payeeName?: string;
      /** Auto-create a payee for an unmatched custom label. Defaults to true. */
      createPayeeIfMissing?: boolean;
      /** Spending category id applied to both legs (null/undefined = none). */
      categoryId?: string | null;
      /** Stored on both legs as given by createTransfer; absent stores null. */
      referenceNumber?: string;
      /** Stored as given by createTransfer; absent stores UNRECONCILED. */
      status?: TransactionStatus;
    },
  ): Promise<CreateTransferPreview> {
    if (input.fromAccountId === input.toAccountId) {
      throw new BadRequestException(
        tr(
          "errors.transactions.transferSameAccount",
          "Source and destination accounts must be different",
        ),
      );
    }
    if (input.amount < 0) {
      throw new BadRequestException(
        tr(
          "errors.transactions.transferAmountNegative",
          "Transfer amount must not be negative",
        ),
      );
    }

    const fromAccount = await this.accountsService.findOne(
      userId,
      input.fromAccountId,
    );
    const toAccount = await this.accountsService.findOne(
      userId,
      input.toAccountId,
    );

    // The preview resolves the rate exactly as the commit does. `?? 1` here
    // would show a same-amount destination for a cross-currency transfer that
    // the commit then posts at a real rate -- the user approving one number and
    // receiving another, which is the divergence audit P5-005 describes for
    // investment previews.
    const previewFx = await this.resolveTransferFx({
      fromAccount,
      toAccount,
      amount: input.amount,
      transactionDate: input.transactionDate,
      suppliedExchangeRate: input.exchangeRate,
      suppliedToAmount: input.toAmount,
    });
    const toAmount = previewFx.toAmount;

    // Resolve the custom label to an existing payee exactly like a normal cash
    // transaction (previewCreate): on a match link the payee and adopt its
    // canonical name; an unmatched name becomes a new payee on confirm unless
    // the caller opted out. Transfers have no category, so the matched payee's
    // default category is deliberately NOT inherited (a transfer's optional
    // spending category is set explicitly by the caller).
    const inputPayeeName = stripHtml(input.payeeName) || null;
    let payeeId: string | null = null;
    let payeeName: string | null = inputPayeeName;
    let payeeMatched = false;
    if (inputPayeeName) {
      const payee = await this.payeesService.resolveByName(
        userId,
        inputPayeeName,
      );
      if (payee) {
        payeeId = payee.id;
        payeeMatched = true;
        payeeName = payee.name;
      }
    }
    const payeeWillBeCreated =
      !!payeeName && !payeeMatched && input.createPayeeIfMissing !== false;

    // Resolve an optional spending category to apply to both legs, validating
    // ownership so the confirm step re-applies the same id (mirrors
    // previewUpdateTransfer and the standard create path).
    let categoryId: string | null = null;
    let categoryName: string | null = null;
    if (input.categoryId) {
      const inputCategoryId = input.categoryId;
      const category = await withScopedDb(this.dataSource, (m) =>
        m.getRepository(Category).findOne({
          where: { id: inputCategoryId, userId },
        }),
      );
      if (!category) {
        throw new BadRequestException(
          tr("errors.transactions.categoryNotFound", "Category not found"),
        );
      }
      categoryId = category.id;
      categoryName = category.name;
    }

    // The same planner the commit runs (design I3), over the outgoing leg's
    // facts, which is what `applyToNewTransfer` evaluates for a same-owner
    // transfer (both accounts were resolved under this user above).
    const description = stripHtml(input.description) || null;
    const ruleEffects = await withScopedDb(this.dataSource, (m) =>
      this.rulesApplier.previewForRow(m, userId, {
        accountId: fromAccount.id,
        currencyCode: fromAccount.currencyCode,
        amount: -input.amount,
        isTransfer: true,
        fromAccountId: fromAccount.id,
        toAccountId: toAccount.id,
        payeeId,
        payeeText: inputPayeeName,
        categoryId,
        description,
        tagIds: [],
        hasSplits: false,
        // The values writeTransferLegs stores on the outgoing leg: the date is
        // the stored calendar date, the status defaults to UNRECONCILED, and a
        // new row has no attachment.
        referenceNumber: input.referenceNumber ?? null,
        transactionDate: input.transactionDate.slice(0, 10),
        status: input.status ?? TransactionStatus.UNRECONCILED,
        hasAttachment: false,
      }),
    );

    return {
      fromAccountId: fromAccount.id,
      fromAccountName: fromAccount.name,
      fromCurrencyCode: fromAccount.currencyCode,
      toAccountId: toAccount.id,
      toAccountName: toAccount.name,
      toCurrencyCode: toAccount.currencyCode,
      amount: roundMoney(input.amount),
      toAmount,
      exchangeRate: previewFx.exchangeRate,
      transactionDate: input.transactionDate,
      description,
      payeeId,
      payeeName,
      payeeMatched,
      payeeWillBeCreated,
      categoryId,
      categoryName,
      ...(ruleEffects ? { ruleEffects } : {}),
    };
  }

  /**
   * Validate and resolve a proposed edit to an existing transfer WITHOUT
   * persisting it. Loads the transaction (requiring it to be a transfer),
   * determines the canonical from/to legs (the from leg has the negative
   * amount, mirroring updateTransfer), and returns the resulting state.
   */
  async previewUpdateTransfer(
    userId: string,
    transactionId: string,
    input: {
      amount?: number;
      transactionDate?: string;
      description?: string;
      payeeName?: string;
      /** Auto-create a payee for an unmatched custom label. Defaults to true. */
      createPayeeIfMissing?: boolean;
      /**
       * Resolved spending category id to apply to both legs. Undefined keeps the
       * existing category; null clears it; a string sets it (ownership checked).
       */
      categoryId?: string | null;
    },
    findOne: (userId: string, id: string) => Promise<Transaction>,
  ): Promise<UpdateTransferPreview> {
    const transaction = await findOne(userId, transactionId);

    if (!transaction.isTransfer || !transaction.linkedTransactionId) {
      throw new BadRequestException(
        tr("errors.transactions.notATransfer", "Transaction is not a transfer"),
      );
    }

    const linkedTransaction = await findOne(
      userId,
      transaction.linkedTransactionId,
    );

    const isFromTransaction = Number(transaction.amount) < 0;
    const fromTransaction = isFromTransaction ? transaction : linkedTransaction;
    const toTransaction = isFromTransaction ? linkedTransaction : transaction;

    const oldFromAmount = Math.abs(Number(fromTransaction.amount));
    const oldToAmount = Number(toTransaction.amount);
    const exchangeRate = Number(toTransaction.exchangeRate) || 1;

    const newAmount =
      input.amount !== undefined ? roundMoney(input.amount) : oldFromAmount;
    // When only the amount changes, scale the destination leg by the stored
    // exchange rate; when nothing money-related changes, keep the stored toAmount.
    const newToAmount =
      input.amount !== undefined
        ? roundMoney(newAmount * exchangeRate)
        : roundMoney(oldToAmount);

    const newDate = input.transactionDate ?? fromTransaction.transactionDate;
    const description =
      input.description !== undefined
        ? stripHtml(input.description) || null
        : (fromTransaction.description ?? null);

    // Re-resolve the payee only when a new label is provided, mirroring
    // previewUpdate for a normal transaction. When the label is unchanged, keep
    // the canonical from-leg payee link untouched (matched, no new creation).
    let payeeId: string | null = fromTransaction.payeeId ?? null;
    let payeeName: string | null = fromTransaction.payeeName ?? null;
    let payeeMatched = true;
    let payeeWillBeCreated = false;
    if (input.payeeName !== undefined) {
      const inputPayeeName = stripHtml(input.payeeName) || null;
      payeeId = null;
      payeeName = inputPayeeName;
      payeeMatched = false;
      if (inputPayeeName) {
        const payee = await this.payeesService.resolveByName(
          userId,
          inputPayeeName,
        );
        if (payee) {
          payeeId = payee.id;
          payeeMatched = true;
          payeeName = payee.name;
        }
      }
      payeeWillBeCreated =
        !!payeeName && !payeeMatched && input.createPayeeIfMissing !== false;
    }

    // Category: validate ownership of a changed category; otherwise keep the
    // transfer's existing (from-leg) category. Mirrors previewUpdate so the
    // confirm step re-applies the resolved id to both legs.
    let categoryId: string | null = fromTransaction.categoryId ?? null;
    let categoryName: string | null = fromTransaction.category?.name ?? null;
    if (input.categoryId !== undefined) {
      if (input.categoryId) {
        const inputCategoryId = input.categoryId;
        const category = await withScopedDb(this.dataSource, (m) =>
          m.getRepository(Category).findOne({
            where: { id: inputCategoryId, userId },
          }),
        );
        if (!category) {
          throw new BadRequestException(
            tr("errors.transactions.categoryNotFound", "Category not found"),
          );
        }
        categoryId = category.id;
        categoryName = category.name;
      } else {
        categoryId = null;
        categoryName = null;
      }
    }

    return {
      transactionId,
      fromAccountId: fromTransaction.accountId,
      fromAccountName: fromTransaction.account?.name ?? "",
      fromCurrencyCode: fromTransaction.currencyCode,
      toAccountId: toTransaction.accountId,
      toAccountName: toTransaction.account?.name ?? "",
      toCurrencyCode: toTransaction.currencyCode,
      amount: newAmount,
      toAmount: newToAmount,
      exchangeRate,
      transactionDate: newDate,
      description,
      payeeId,
      payeeName,
      payeeMatched,
      payeeWillBeCreated,
      categoryId,
      categoryName,
    };
  }

  async removeTransfer(
    userId: string,
    transactionId: string,
    findOne: (userId: string, id: string) => Promise<Transaction>,
    actor?: TransferActor,
  ): Promise<void> {
    const realUserId = actor?.realUserId ?? userId;
    const transaction = await findOne(userId, transactionId);

    if (!transaction.isTransfer) {
      throw new BadRequestException(
        tr("errors.transactions.notATransfer", "Transaction is not a transfer"),
      );
    }

    const parentSplit = await withScopedDb(this.dataSource, (m) =>
      m.getRepository(TransactionSplit).findOne({
        where: { linkedTransactionId: transactionId },
      }),
    );

    // Cross-owner pair: the owner-scoped read of the linked leg misses. Route
    // to connected (delete both) / frozen (own leg only) / 403 before any
    // deletion; the same-owner path below is untouched.
    if (!parentSplit && transaction.linkedTransactionId) {
      let scopedLinked: Transaction | null = null;
      try {
        scopedLinked = await findOne(userId, transaction.linkedTransactionId);
      } catch (err) {
        if (!(err instanceof NotFoundException)) throw err;
      }
      if (!scopedLinked) {
        return this.removeCrossOwnerTransfer(realUserId, transaction);
      }
    }

    const affectedAccountIds = new Set<string>();

    // Both legs (or the whole split parent) and their balance adjustments are
    // removed atomically.
    await withScopedDb(this.dataSource, async (m) => {
      if (parentSplit) {
        await this.removeTransferFromSplitInTransaction(
          m,
          parentSplit,
          transaction,
          transactionId,
          affectedAccountIds,
        );
      } else {
        // Both legs are locked here, in ascending id order, and their amounts
        // re-read: the delta each leg reverses must be the version the delete
        // actually removes, and a fixed lock order is what keeps two concurrent
        // transfer deletions from holding one another's second leg. A snapshot
        // taken before the transaction let two deletions each reverse the same
        // pair of amounts while only one pair of rows went away (P4-003).
        const legIds = [transactionId];
        if (transaction.linkedTransactionId) {
          legIds.push(transaction.linkedTransactionId);
        }
        const locked = await lockTransactionRows(m, legIds, userId);

        const ownLeg = locked.get(transactionId);
        if (!ownLeg) {
          throw new NotFoundException(
            tr(
              "errors.transactions.notFoundById",
              `Transaction with ID ${transactionId} not found`,
              { id: transactionId },
            ),
          );
        }
        const linkedLeg = transaction.linkedTransactionId
          ? locked.get(transaction.linkedTransactionId)
          : undefined;

        // Strict reconciled lock. Both legs are one movement of money, so a
        // reconciled leg refuses the deletion of the pair -- deleting only the
        // unreconciled half is the divergent state the transfer routes exist
        // to prevent.
        await assertReconciledRowsMutable(
          m,
          userId,
          [linkedLeg, ownLeg].filter((leg) => leg !== undefined),
        );

        for (const leg of [linkedLeg, ownLeg]) {
          if (!leg) continue;
          affectedAccountIds.add(leg.accountId);
          // Conditional delete, reverse only what this call removed, VOID rows
          // reverse nothing, future-dated rows recompute. Shared with split
          // removal so the sequence exists once (see remove-transaction-leg.ts).
          await removeLockedTransactionLeg(
            m,
            leg,
            userId,
            this.accountsService,
          );
        }
      }
    });

    for (const accId of affectedAccountIds) {
      this.triggerNetWorthRecalc(accId, userId);
    }
  }

  /**
   * Delete a transfer whose counterpart belongs to another owner. Connected
   * (delete grant on the counterpart account): both legs and both balances,
   * atomically, under the audited system context. Frozen (no read on the
   * counterpart): the own leg only -- the FK's ON DELETE SET NULL detaches the
   * counterpart, which survives as a one-sided transfer and correctly does not
   * reconnect on reshare. Readable but no delete grant: 403 from
   * resolveCounterpartAccess.
   */
  private async removeCrossOwnerTransfer(
    realUserId: string,
    ownLeg: Transaction,
  ): Promise<void> {
    const counterpart = ownLeg.linkedTransactionId
      ? await this.loadLegById(ownLeg.linkedTransactionId)
      : null;
    const access = counterpart
      ? await this.resolveCounterpartAccess(realUserId, counterpart, "delete")
      : "frozen";

    // Both legs were loaded before this transaction opened, so the amount each
    // reversal subtracts is re-read under the row's own lock and the reversal is
    // gated on this call being the one that removed the row (audit FV4-002).
    const removeLeg = async (m: EntityManager, leg: Transaction) => {
      const locked = await lockTransactionRow(m, leg.id, leg.userId);
      if (!locked) return;
      await removeLockedTransactionLeg(
        m,
        locked,
        leg.userId,
        this.accountsService,
      );
    };

    if (access === "connected" && counterpart) {
      // Ascending id order, not "counterpart then mine".
      //
      // Either owner can start this, and each request names its *own* leg -- so
      // taking the counterpart first meant the two sides locked the same pair in
      // opposite orders, which is a PostgreSQL 40P01 for both (audit RV4-005).
      // Sorting by id is what makes the order the same whoever asks.
      const ordered = [counterpart, ownLeg].sort((a, b) =>
        a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
      );
      await withSystemContext(() =>
        withScopedDb(this.dataSource, async (m) => {
          for (const leg of ordered) {
            await removeLeg(m, leg);
          }
        }),
      );
      this.triggerNetWorthRecalc(counterpart.accountId, counterpart.userId);
    } else {
      await withScopedDb(this.dataSource, (m) => removeLeg(m, ownLeg));
    }
    this.triggerNetWorthRecalc(ownLeg.accountId, ownLeg.userId);
  }

  private async removeTransferFromSplitInTransaction(
    m: EntityManager,
    parentSplit: TransactionSplit,
    transaction: Transaction,
    transactionId: string,
    affectedAccountIds: Set<string>,
  ): Promise<void> {
    const userId = transaction.userId;
    const parentTransactionId = parentSplit.transactionId;

    // The split parent first, on its own, and only then its legs.
    //
    // A single sorted batch over parent-plus-legs looks tidier and deadlocks:
    // `TransactionSplitService.removeSplit` cannot know a leg id before it has
    // read the split, so it necessarily locks the parent and *then* the leg. A
    // batch that sorts the two together takes them in id order instead, which is
    // the opposite order whenever the leg's UUID sorts first -- and two requests
    // in opposite orders is a PostgreSQL 40P01 for both (audit RV4-005).
    //
    // So the ordering rule is by *role*, not by id: parent before legs, legs
    // among themselves ascending. The parent lock is then the serialization
    // point -- any two paths touching the same parent's legs have already
    // queued behind it, so their leg order cannot matter. See common/db/locks.ts.
    const parent = await lockTransactionRow(m, parentTransactionId, userId);

    const allSplits = await m.find(TransactionSplit, {
      where: { transactionId: parentTransactionId },
    });
    const siblingLegIds = allSplits
      .map((split) => split.linkedTransactionId)
      .filter((id): id is string => Boolean(id) && id !== transactionId);

    // Now the legs, in one ascending batch. Locking each as it is reached is what
    // let two removals interleave and each reverse the same amount; every reversal
    // below derives its amount from the locked row and only fires when this call
    // is the one that removed it (audit FV4-002).
    const locked = await lockTransactionRows(
      m,
      [...siblingLegIds, transaction.id],
      userId,
    );

    if (parent) {
      for (const legId of siblingLegIds) {
        const leg = locked.get(legId);
        if (!leg) continue;
        affectedAccountIds.add(leg.accountId);
        await removeLockedTransactionLeg(m, leg, userId, this.accountsService);
      }

      await m.remove(allSplits);

      affectedAccountIds.add(parent.accountId);
      await removeLockedTransactionLeg(m, parent, userId, this.accountsService);
    }

    affectedAccountIds.add(transaction.accountId);
    const ownLeg = locked.get(transaction.id);
    if (ownLeg) {
      await removeLockedTransactionLeg(m, ownLeg, userId, this.accountsService);
    }
  }

  async updateTransfer(
    userId: string,
    transactionId: string,
    updateDto: Partial<UpdateTransferDto>,
    findOne: (userId: string, id: string) => Promise<Transaction>,
    actor?: TransferActor,
  ): Promise<TransferResult> {
    const realUserId = actor?.realUserId ?? userId;
    const transaction = await findOne(userId, transactionId);

    if (!transaction.isTransfer || !transaction.linkedTransactionId) {
      throw new BadRequestException(
        tr("errors.transactions.notATransfer", "Transaction is not a transfer"),
      );
    }

    // When this leg is the counterpart of a SPLIT transfer, its
    // linkedTransactionId points at the split PARENT (whose amount is the sum of
    // all its splits), not at a mirror leg. Routing it through the two-leg
    // update below would overwrite the parent's aggregate amount and fields with
    // this single leg's values. Handle it separately instead.
    const parentSplit = await withScopedDb(this.dataSource, (m) =>
      m.getRepository(TransactionSplit).findOne({
        where: { linkedTransactionId: transactionId },
      }),
    );
    if (parentSplit) {
      return this.updateSplitTransferLeg(
        userId,
        transaction,
        parentSplit,
        updateDto,
        findOne,
      );
    }

    let linkedTransaction: Transaction;
    try {
      linkedTransaction = await findOne(
        userId,
        transaction.linkedTransactionId,
      );
    } catch (err) {
      if (!(err instanceof NotFoundException)) throw err;
      // Cross-owner pair: the counterpart is not the effective user's row.
      return this.updateCrossOwnerTransfer(
        userId,
        realUserId,
        transaction,
        updateDto,
        findOne,
      );
    }

    const isFromTransaction = Number(transaction.amount) < 0;
    const fromTransaction = isFromTransaction ? transaction : linkedTransaction;
    const toTransaction = isFromTransaction ? linkedTransaction : transaction;

    const oldFromAccountId = fromTransaction.accountId;
    const oldToAccountId = toTransaction.accountId;
    const oldFromAmount = Math.abs(Number(fromTransaction.amount));
    const oldToAmount = Number(toTransaction.amount);

    const newFromAccountId = updateDto.fromAccountId ?? oldFromAccountId;
    const newToAccountId = updateDto.toAccountId ?? oldToAccountId;

    if (newFromAccountId === newToAccountId) {
      throw new BadRequestException(
        tr(
          "errors.transactions.transferSameAccount",
          "Source and destination accounts must be different",
        ),
      );
    }

    let newFromAccount = fromTransaction.account;
    let newToAccount = toTransaction.account;

    if (
      updateDto.fromAccountId &&
      updateDto.fromAccountId !== oldFromAccountId
    ) {
      newFromAccount = await this.accountsService.findOne(
        userId,
        updateDto.fromAccountId,
      );
    }
    if (updateDto.toAccountId && updateDto.toAccountId !== oldToAccountId) {
      newToAccount = await this.accountsService.findOne(
        userId,
        updateDto.toAccountId,
      );
    }

    const newAmount = updateDto.amount ?? oldFromAmount;

    const oldDate = fromTransaction.transactionDate;
    const newDate = updateDto.transactionDate ?? oldDate;

    // The same server-authoritative resolution as creation -- currencies come
    // from the (possibly newly chosen) accounts, a same-currency pair must
    // conserve, and a cross-currency pair with no supplied rate resolves one
    // rather than posting 1:1 (audit P5-002) -- but only when this edit actually
    // changes the financial structure. See `resolveTransferFxForUpdate`.
    const updateFx = await this.resolveTransferFxForUpdate({
      fromAccount: newFromAccount as Account,
      toAccount: newToAccount as Account,
      amount: newAmount,
      transactionDate: String(newDate),
      existingFromAccountId: oldFromAccountId,
      existingToAccountId: oldToAccountId,
      existingFromAmount: oldFromAmount,
      existingToAmount: oldToAmount,
      existingExchangeRate: toTransaction.exchangeRate,
      updateDto,
    });
    const newExchangeRate = updateFx.exchangeRate;
    const newToAmount = updateFx.toAmount;
    const oldIsFuture = isTransactionInFuture(oldDate);
    const newIsFuture = isTransactionInFuture(newDate);
    const dateChanged = oldDate !== newDate;
    const anyFuture = oldIsFuture || newIsFuture;

    await this.assertCategoryOwned(userId, updateDto.categoryId);

    const fromUpdateData = this.buildFromUpdateData(
      updateDto,
      newAmount,
      oldFromAccountId,
      oldToAccountId,
      toTransaction.account?.name ?? "",
      fromTransaction.payeeId,
      fromTransaction.payeeName,
      updateFx.fromCurrencyCode,
      fromTransaction.currencyCode,
      oldFromAmount,
    );

    const toUpdateData = this.buildToUpdateData(
      updateDto,
      newToAmount,
      newExchangeRate,
      oldFromAccountId,
      oldToAccountId,
      fromTransaction.account?.name ?? "",
      toTransaction.payeeId,
      toTransaction.payeeName,
      updateFx.toCurrencyCode,
      toTransaction.currencyCode,
      toTransaction.exchangeRate,
      updateFx.repriced,
      oldToAmount,
    );

    // Both legs' field updates and the four possible balance adjustments
    // commit atomically.
    await withScopedDb(this.dataSource, async (m) => {
      // The four balance adjustments below reverse `oldFromAmount` /
      // `oldToAmount` and re-apply the new ones. Those old values were read
      // before this transaction opened, so a concurrent edit of either leg
      // would make them describe a version this write is not replacing -- two
      // updates each reversing the same pair and corrupting both accounts
      // (audit P4-003).
      //
      // Lock both legs in ascending id order and refuse if the committed row no
      // longer matches what was read. A 409 the client can retry is the honest
      // answer; silently applying a delta derived from a superseded snapshot is
      // not.
      const locked = await lockTransactionRows(
        m,
        [fromTransaction.id, toTransaction.id],
        userId,
      );
      const lockedFrom = locked.get(fromTransaction.id);
      const lockedTo = locked.get(toTransaction.id);
      if (!lockedFrom || !lockedTo) {
        throw new NotFoundException(
          tr(
            "errors.transactions.notFoundById",
            `Transaction with ID ${transactionId} not found`,
            { id: transactionId },
          ),
        );
      }
      // Strict reconciled lock, before the concurrency check and before any
      // write: either leg being reconciled refuses the edit of the pair.
      await assertReconciledRowsMutable(m, userId, [lockedFrom, lockedTo]);

      const unchanged =
        Math.abs(lockedFrom.amount) === oldFromAmount &&
        lockedTo.amount === oldToAmount &&
        lockedFrom.accountId === oldFromAccountId &&
        lockedTo.accountId === oldToAccountId &&
        lockedFrom.transactionDate === oldDate;
      if (!unchanged) {
        throw new ConflictException(
          tr(
            "errors.transactions.transferChangedConcurrently",
            "This transfer was changed by another request. Reload it and try again.",
          ),
        );
      }

      // Whether each leg is included in its account's current balance, read from
      // the LOCKED row. A status change alone flips inclusion, and it used not to
      // be part of the balance decision at all: `accountsOrAmountsChanged` omitted
      // `status`, so voiding an existing transfer wrote VOID onto both rows and
      // left both balances carrying the money (audit P5-001). The concurrency
      // guard above compares amount/account/date but not status, so the committed
      // status is taken from `lockedFrom` rather than the pre-transaction
      // snapshot. Mirrors the wasVoid/isVoid handling in transactions.service
      // update().
      const wasVoid = lockedFrom.status === TransactionStatus.VOID;
      const isVoid =
        updateDto.status !== undefined
          ? updateDto.status === TransactionStatus.VOID
          : wasVoid;
      const voidChanged = wasVoid !== isVoid;

      // Reverse the old pair only if it was actually included in the balances.
      // A transfer that was already VOID contributed nothing to reverse, and
      // reversing it would create the money the void was supposed to withhold.
      // The predicate is the resolver's `repriced` (a value change to an account,
      // the source amount, an explicit destination amount or rate), a date
      // change, or a void transition -- replacing the presence-based
      // `accountsOrAmountsChanged` (audit P5-002 / RR3-002 / P5-001).
      if (
        (updateFx.repriced || dateChanged || voidChanged) &&
        !anyFuture &&
        !wasVoid
      ) {
        await this.accountsService.updateBalance(
          oldFromAccountId,
          oldFromAmount,
        );
        await this.accountsService.updateBalance(oldToAccountId, -oldToAmount);
      }

      // The reconciliation status is per-leg unless the transition crosses
      // VOID. The edit form shows one status control for "the transfer" and used
      // to write it onto both rows, but CLEARED and RECONCILED record whether
      // *this* account's statement has recognised *this* leg, and the two
      // statements arrive separately -- copying RECONCILED onto the counterpart
      // removes the transfer from the other account's reconciliation candidates
      // before its own statement contains it, and copying UNRECONCILED over the
      // counterpart discards a reconciliation the user had already completed
      // there (audit P6-RECHECK-004). So for a non-VOID edit the status stays on
      // the leg the user opened and is stripped from the counterpart.
      //
      // A VOID crossing is the exception, and it PAIRS the status onto both
      // legs: VOID decides balance inclusion, and a same-owner pair must be VOID
      // on both legs or neither or its balances diverge. This matches the bulk
      // path exactly -- `expandTransferCounterparts` drags the counterpart in on
      // a VOID crossing only, and the same UPDATE stamps the submitted status
      // onto it -- so the same action reads the same way whether done in the
      // register or in bulk. Keeping the two surfaces in step is deliberate; the
      // un-void sub-status question (a reactivated counterpart inheriting the
      // opened leg's CLEARED/RECONCILED) is a platform-wide decision that must
      // move both surfaces together, not something for one edit path to answer
      // alone. `voidChanged` is read from the locked row above, so the
      // strip-versus-pair choice here is made on the committed status rather
      // than a stale snapshot -- this scopes only that choice, not the wider
      // concurrency guard, which compares amount/account/date.
      if (!voidChanged) {
        // `isFromTransaction` already names which leg the user opened, so the
        // counterpart is the other one.
        delete (isFromTransaction ? toUpdateData : fromUpdateData).status;
      }

      if (Object.keys(fromUpdateData).length > 0) {
        await m.update(Transaction, fromTransaction.id, fromUpdateData);
      }

      if (Object.keys(toUpdateData).length > 0) {
        await m.update(Transaction, toTransaction.id, toUpdateData);
      }

      // Update createdAt via raw query to bypass pg's local-timezone
      // Date serialisation (same approach as transactions.service.ts).
      if ((updateDto as any).createdAt !== undefined) {
        const d = new Date((updateDto as any).createdAt);
        const utc = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")} ${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}:${String(d.getUTCSeconds()).padStart(2, "0")}.${String(d.getUTCMilliseconds()).padStart(3, "0")}`;
        await m.query(`UPDATE transactions SET created_at = $1 WHERE id = $2`, [
          utc,
          fromTransaction.id,
        ]);
        await m.query(`UPDATE transactions SET created_at = $1 WHERE id = $2`, [
          utc,
          toTransaction.id,
        ]);
      }

      if (updateFx.repriced || dateChanged || voidChanged) {
        if (anyFuture) {
          // Sorted: the same fixed lock order every other account-balance
          // writer uses, so two transfers touching the same pair cannot
          // deadlock on each other's second account.
          const allAccounts = [
            ...new Set([
              oldFromAccountId,
              oldToAccountId,
              newFromAccountId,
              newToAccountId,
            ]),
          ].sort();
          for (const accId of allAccounts) {
            await this.accountsService.recalculateCurrentBalance(userId, accId);
          }
        } else if (!isVoid) {
          // Re-apply only when the pair is included after the update. Becoming
          // VOID means the reversal above is the whole change.
          await this.accountsService.updateBalance(
            newFromAccountId,
            -newAmount,
          );
          await this.accountsService.updateBalance(newToAccountId, newToAmount);
        }
      }
    });

    const affectedAccounts = new Set([
      oldFromAccountId,
      oldToAccountId,
      newFromAccountId,
      newToAccountId,
    ]);
    for (const accId of affectedAccounts) {
      this.triggerNetWorthRecalc(accId, userId);
    }

    return {
      fromTransaction: await findOne(userId, fromTransaction.id),
      toTransaction: await findOne(userId, toTransaction.id),
    };
  }

  /**
   * Update a transfer whose counterpart belongs to another owner. Routes to
   * the connected flow (real user holds the edit grant on the counterpart
   * account), the frozen own-leg flow (counterpart unreadable after unshare),
   * or 403 (readable but edit not granted).
   */
  private async updateCrossOwnerTransfer(
    effectiveUserId: string,
    realUserId: string,
    ownLeg: Transaction,
    updateDto: Partial<UpdateTransferDto>,
    findOne: (userId: string, id: string) => Promise<Transaction>,
  ): Promise<TransferResult> {
    const counterpart = await this.loadLegById(ownLeg.linkedTransactionId!);
    if (!counterpart) {
      // The pointer FK is ON DELETE SET NULL, so a live id with no row should
      // not happen; fail like the not-a-transfer guard rather than guessing.
      throw new BadRequestException(
        tr("errors.transactions.notATransfer", "Transaction is not a transfer"),
      );
    }

    const access = await this.resolveCounterpartAccess(
      realUserId,
      counterpart,
      "edit",
    );
    if (access === "frozen") {
      return this.updateFrozenTransferLeg(
        effectiveUserId,
        ownLeg,
        counterpart,
        updateDto,
        findOne,
      );
    }
    return this.updateConnectedCrossOwnerTransfer(
      effectiveUserId,
      ownLeg,
      counterpart,
      updateDto,
      findOne,
    );
  }

  /**
   * Frozen link (real user lost READ on the counterpart account): only
   * presentational own-leg fields may change -- description, reference,
   * status, category, payee -- with no mirroring onto the counterpart.
   * Amount, date, exchange-rate and account changes are rejected: unmirrored
   * they would silently break the two-ledger agreement that makes the pair a
   * transfer. Modeled on the split-transfer-leg lock.
   */
  private async updateFrozenTransferLeg(
    effectiveUserId: string,
    ownLeg: Transaction,
    counterpart: Transaction,
    updateDto: Partial<UpdateTransferDto>,
    findOne: (userId: string, id: string) => Promise<Transaction>,
  ): Promise<TransferResult> {
    const isFromLeg = Number(ownLeg.amount) < 0;
    const fromLeg = isFromLeg ? ownLeg : counterpart;
    const toLeg = isFromLeg ? counterpart : ownLeg;

    // The form resends current values on every edit; only a genuine change is
    // structural.
    const structuralChange =
      (updateDto.amount !== undefined &&
        roundMoney(updateDto.amount) !== Math.abs(Number(fromLeg.amount))) ||
      (updateDto.toAmount !== undefined &&
        roundMoney(updateDto.toAmount) !== roundMoney(Number(toLeg.amount))) ||
      (updateDto.exchangeRate !== undefined &&
        Number(updateDto.exchangeRate) !== Number(toLeg.exchangeRate)) ||
      (!!updateDto.transactionDate &&
        updateDto.transactionDate !== ownLeg.transactionDate) ||
      (!!updateDto.fromAccountId &&
        updateDto.fromAccountId !== fromLeg.accountId) ||
      (!!updateDto.toAccountId && updateDto.toAccountId !== toLeg.accountId);
    if (structuralChange) {
      throw new BadRequestException(
        tr(
          "errors.transactions.crossOwnerTransferLocked",
          "The other side of this transfer is in an account you no longer have access to. You can edit this transaction's own details, but its amount, date, and accounts are locked.",
        ),
      );
    }

    await this.assertCategoryOwned(effectiveUserId, updateDto.categoryId);

    const legData: Partial<Transaction> = {};
    if (updateDto.description !== undefined)
      legData.description = updateDto.description ?? null;
    if (updateDto.referenceNumber !== undefined)
      legData.referenceNumber = updateDto.referenceNumber ?? null;
    if (updateDto.status !== undefined) legData.status = updateDto.status;
    if (updateDto.categoryId !== undefined)
      legData.categoryId = updateDto.categoryId || null;
    if (updateDto.payeeId !== undefined)
      legData.payeeId = updateDto.payeeId || null;
    if (updateDto.payeeName !== undefined)
      legData.payeeName = updateDto.payeeName || null;

    // A status change is presentational for the *counterpart* -- per-ledger
    // reconciliation state does not cross an ownership boundary -- but it is not
    // presentational for this leg's own balance. `VOID` excludes a row from
    // `recalculateCurrentBalance` and from every report, so writing it without
    // moving the balance left the row and the account disagreeing, and the next
    // recompute changed the account with no user action behind it.
    if (Object.keys(legData).length > 0) {
      let voidBoundaryCrossed = false;
      await withScopedDb(this.dataSource, async (m) => {
        // The status the transition is decided from -- and the amount the
        // balance moves by -- come from the row THIS write replaces, read
        // under its lock. Deriving them from the pre-transaction snapshot let
        // two concurrent voids each see ACTIVE and each subtract the amount:
        // an idempotent status write beside a doubled balance move (the same
        // shape applyStatusTransition documents for the same-owner path).
        const lockedLeg = await lockTransactionRow(
          m,
          ownLeg.id,
          effectiveUserId,
        );
        if (!lockedLeg) {
          throw new NotFoundException(
            tr(
              "errors.transactions.notFoundById",
              `Transaction with ID ${ownLeg.id} not found`,
              { id: ownLeg.id },
            ),
          );
        }
        const wasVoid = lockedLeg.status === TransactionStatus.VOID;
        const isVoid =
          updateDto.status !== undefined
            ? updateDto.status === TransactionStatus.VOID
            : wasVoid;
        const ownLegAmount = lockedLeg.amount;
        const ownLegIsFuture = isTransactionInFuture(lockedLeg.transactionDate);

        await m.update(Transaction, ownLeg.id, legData);

        if (wasVoid !== isVoid) {
          voidBoundaryCrossed = true;
          if (ownLegIsFuture) {
            await this.accountsService.recalculateCurrentBalance(
              effectiveUserId,
              ownLeg.accountId,
            );
          } else {
            // Becoming void removes this leg's contribution; leaving void
            // restores it. Only this leg's account -- the counterpart keeps its
            // own owner's status.
            await this.accountsService.updateBalance(
              ownLeg.accountId,
              isVoid ? -ownLegAmount : ownLegAmount,
            );
          }
        }
      });

      if (voidBoundaryCrossed) {
        this.triggerNetWorthRecalc(ownLeg.accountId, ownLeg.userId);
      }
    }

    // Return the edited leg in both slots (the split-leg pattern) so wrapper
    // tag-sync touches only this leg and nothing is mirrored.
    const refreshed = await findOne(effectiveUserId, ownLeg.id);
    return { fromTransaction: refreshed, toTransaction: refreshed };
  }

  /**
   * Connected cross-owner edit: structural fields (date, amounts, exchange
   * rate, description, reference, custom payee label) mirror across both legs
   * exactly like a same-owner transfer; per-user reference data (category,
   * payee link) and per-ledger status stay on effective-user legs only.
   * Account moves are rejected in v1 -- moving a leg between owners changes
   * user_id semantics. The atomic block runs under the audited system context
   * (foreign-leg writes are owner-only under RLS); authorization was fully
   * decided before entry.
   */
  private async updateConnectedCrossOwnerTransfer(
    effectiveUserId: string,
    ownLeg: Transaction,
    counterpart: Transaction,
    updateDto: Partial<UpdateTransferDto>,
    findOne: (userId: string, id: string) => Promise<Transaction>,
  ): Promise<TransferResult> {
    const isFromTransaction = Number(ownLeg.amount) < 0;
    const fromTransaction = isFromTransaction ? ownLeg : counterpart;
    const toTransaction = isFromTransaction ? counterpart : ownLeg;

    const movesFrom =
      !!updateDto.fromAccountId &&
      updateDto.fromAccountId !== fromTransaction.accountId;
    const movesTo =
      !!updateDto.toAccountId &&
      updateDto.toAccountId !== toTransaction.accountId;
    if (movesFrom || movesTo) {
      throw new BadRequestException(
        tr(
          "errors.transactions.crossOwnerAccountMoveLocked",
          "This transfer involves another user's account, so it cannot be moved to different accounts.",
        ),
      );
    }

    await this.assertCategoryOwned(effectiveUserId, updateDto.categoryId);

    const oldFromAmount = Math.abs(Number(fromTransaction.amount));
    const oldToAmount = Number(toTransaction.amount);
    const newAmount = updateDto.amount ?? oldFromAmount;

    const oldDate = fromTransaction.transactionDate;
    const newDate = updateDto.transactionDate ?? oldDate;
    const dateChanged = oldDate !== newDate;
    const anyFuture =
      isTransactionInFuture(oldDate) || isTransactionInFuture(newDate);

    // The same authoritative resolver the same-owner paths use. This branch used
    // to work `newToAmount` out for itself -- an explicit destination amount
    // taken verbatim, otherwise `amount * storedRate` -- so every rule the
    // resolver enforces was reachable again through a delegated transfer: two
    // same-currency accounts could move 100 out and 80 in, and a cross-currency
    // pair could post at a stale or absent rate. Authorization stays separate
    // from arithmetic; only the arithmetic moves here.
    const updateFx = await this.resolveTransferFxForUpdate({
      fromAccount: fromTransaction.account as Account,
      toAccount: toTransaction.account as Account,
      amount: newAmount,
      transactionDate: String(newDate),
      existingFromAccountId: fromTransaction.accountId,
      existingToAccountId: toTransaction.accountId,
      existingFromAmount: oldFromAmount,
      existingToAmount: oldToAmount,
      existingExchangeRate: toTransaction.exchangeRate,
      updateDto,
    });
    const newExchangeRate = updateFx.exchangeRate;
    const newToAmount = updateFx.toAmount;

    const fromUpdateData = this.buildFromUpdateData(
      updateDto,
      newAmount,
      fromTransaction.accountId,
      toTransaction.accountId,
      toTransaction.account?.name ?? "",
      fromTransaction.payeeId,
      fromTransaction.payeeName,
      updateFx.fromCurrencyCode,
      fromTransaction.currencyCode,
      oldFromAmount,
    );
    const toUpdateData = this.buildToUpdateData(
      updateDto,
      newToAmount,
      newExchangeRate,
      fromTransaction.accountId,
      toTransaction.accountId,
      fromTransaction.account?.name ?? "",
      toTransaction.payeeId,
      toTransaction.payeeName,
      updateFx.toCurrencyCode,
      toTransaction.currencyCode,
      toTransaction.exchangeRate,
      updateFx.repriced,
      oldToAmount,
    );

    // Per-user reference data and per-ledger reconciliation state never cross
    // an ownership boundary.
    for (const [leg, data] of [
      [fromTransaction, fromUpdateData],
      [toTransaction, toUpdateData],
    ] as const) {
      if (leg.userId !== effectiveUserId) {
        delete data.categoryId;
        delete data.payeeId;
        delete data.status;
      }
    }

    // Status stays on the effective user's leg (it is stripped from the foreign
    // one above), so a status change moves exactly one balance -- that leg's.
    // `amountsChanged` omitted status entirely, so voiding your own side of a
    // delegated transfer wrote VOID and left the balance carrying the money.
    const ownLegWasVoid = ownLeg.status === TransactionStatus.VOID;
    const ownLegIsVoid =
      updateDto.status !== undefined
        ? updateDto.status === TransactionStatus.VOID
        : ownLegWasVoid;

    // Inclusion is per leg here, unlike every same-owner path. Status is stripped
    // from the foreign leg above, so the two rows hold independent statuses and
    // the pair can sit in any of the four combinations. Using the acting leg's
    // state for both -- which is what the FR-001 fix did -- gets the foreign
    // ledger wrong in two of them (recheck RR2-001): with the own leg VOID and the
    // foreign leg active, an amount edit reversed nothing and re-applied nothing,
    // leaving the foreign balance stale by the whole delta while its active row
    // carried the new amount; with the states swapped, both were reversed and
    // re-applied, moving a foreign balance that excludes its VOID row.
    const legVoidState = (leg: Transaction) =>
      leg.id === ownLeg.id
        ? { wasVoid: ownLegWasVoid, isVoid: ownLegIsVoid }
        : {
            // The foreign leg's status is never written by this path.
            wasVoid: leg.status === TransactionStatus.VOID,
            isVoid: leg.status === TransactionStatus.VOID,
          };
    const fromVoid = legVoidState(fromTransaction);
    const toVoid = legVoidState(toTransaction);

    await withSystemContext(() =>
      withScopedDb(this.dataSource, async (m) => {
        // The VOID transition for the status-only branch below is decided from
        // the row THIS write replaces, read under its lock BEFORE the status
        // write -- two concurrent voids each deriving wasVoid from their
        // pre-transaction snapshots both saw ACTIVE and each moved the
        // balance, an idempotent status write beside a doubled move.
        let lockedOwnLegVoidState: { wasVoid: boolean; amount: number } | null =
          null;
        if (updateDto.status !== undefined) {
          const lockedOwn = await lockTransactionRow(
            m,
            ownLeg.id,
            effectiveUserId,
          );
          if (!lockedOwn) {
            throw new NotFoundException(
              tr(
                "errors.transactions.notFoundById",
                `Transaction with ID ${ownLeg.id} not found`,
                { id: ownLeg.id },
              ),
            );
          }
          lockedOwnLegVoidState = {
            wasVoid: lockedOwn.status === TransactionStatus.VOID,
            amount: lockedOwn.amount,
          };
        }

        if ((updateFx.repriced || dateChanged) && !anyFuture) {
          // Reverse each leg only if that leg was actually included.
          if (!fromVoid.wasVoid) {
            await this.accountsService.updateBalance(
              fromTransaction.accountId,
              oldFromAmount,
            );
          }
          if (!toVoid.wasVoid) {
            await this.accountsService.updateBalance(
              toTransaction.accountId,
              -oldToAmount,
            );
          }
        }

        if (Object.keys(fromUpdateData).length > 0) {
          await m.update(Transaction, fromTransaction.id, fromUpdateData);
        }
        if (Object.keys(toUpdateData).length > 0) {
          await m.update(Transaction, toTransaction.id, toUpdateData);
        }

        if (updateFx.repriced || dateChanged) {
          if (anyFuture) {
            // Cross-owner transfer: the two legs belong to different owners, so
            // each account's balance-write lock is scoped to ITS own leg's
            // owner, never to the acting user (maintainer review, PR #1095).
            // Keyed by account id so a degenerate same-account pair still folds
            // to one recalculation, as the previous Set did.
            const legsByAccount = new Map<string, string>([
              [fromTransaction.accountId, fromTransaction.userId],
              [toTransaction.accountId, toTransaction.userId],
            ]);
            for (const [accId, ownerId] of legsByAccount) {
              await this.accountsService.recalculateCurrentBalance(
                ownerId,
                accId,
              );
            }
          } else {
            // And re-apply each leg only if that leg is included afterwards.
            if (!fromVoid.isVoid) {
              await this.accountsService.updateBalance(
                fromTransaction.accountId,
                -newAmount,
              );
            }
            if (!toVoid.isVoid) {
              await this.accountsService.updateBalance(
                toTransaction.accountId,
                newToAmount,
              );
            }
          }
        } else if (
          lockedOwnLegVoidState !== null &&
          lockedOwnLegVoidState.wasVoid !== ownLegIsVoid
        ) {
          // A status-only change: only this leg's account moves, and only by
          // this leg's amount -- both taken from the locked row, not the
          // pre-transaction snapshot.
          if (isTransactionInFuture(ownLeg.transactionDate)) {
            await this.accountsService.recalculateCurrentBalance(
              effectiveUserId,
              ownLeg.accountId,
            );
          } else {
            await this.accountsService.updateBalance(
              ownLeg.accountId,
              ownLegIsVoid
                ? -lockedOwnLegVoidState.amount
                : lockedOwnLegVoidState.amount,
            );
          }
        }
      }),
    );

    this.triggerNetWorthRecalc(
      fromTransaction.accountId,
      fromTransaction.userId,
    );
    this.triggerNetWorthRecalc(toTransaction.accountId, toTransaction.userId);

    return {
      fromTransaction: await findOne(
        fromTransaction.userId,
        fromTransaction.id,
      ),
      toTransaction: await findOne(toTransaction.userId, toTransaction.id),
    };
  }

  /**
   * Update a single leg of a SPLIT transfer (the counterpart living in the
   * target account) without disturbing the split parent's aggregate amount.
   *
   * Only the counterpart's own presentational fields are edited in place. When
   * the amount changes, the matching split row and the parent's total (sum of
   * all splits) are kept in sync and both accounts rebalanced, so the split set
   * never drifts out of agreement with the parent. Structural edits (moving the
   * transfer to different accounts) are rejected -- those belong to the split
   * editor on the source transaction.
   *
   * The leg's amount is in the TARGET account's currency and the split row's is
   * in the parent's, so a cross-currency pair needs the amount converted back
   * across rather than copied. See `resolveSplitLegSourceAmount`.
   */
  /**
   * Convert an edited split-transfer leg amount back into the split row's
   * currency, which is the split parent's account currency.
   *
   * `TransactionSplitService.createSplits` posts the counterpart as
   * `-splitAmount * rate`, storing that rate (destination units per source unit)
   * on the leg. So the inverse is `-legAmount / rate`, and the same rate is used
   * in both directions -- the pair keeps the relationship it was posted at
   * rather than acquiring a second one from a later edit.
   *
   * FR-006: this was `roundMoney(-newCounterpartAmount)` under a comment
   * asserting that split transfers are always 1:1 same-currency, which stopped
   * being true when the cross-currency conversion went into the create path.
   * A 1,000 PLN split posting a 232 EUR leg, edited to 250 EUR, wrote -250 onto
   * a PLN split row and re-totalled the PLN parent from it: the parent lost 750
   * PLN, the source balance moved by that difference, and both rows still
   * claimed to describe one movement of money.
   *
   * A stored rate that is absent or unusable is resolved from the market for the
   * leg's date (then the latest stored rate), and refused if neither exists --
   * never defaulted to 1, which is the failure this whole finding family is.
   */
  private async resolveSplitLegSourceAmount(
    counterpart: Transaction,
    parentTransaction: Transaction,
    newCounterpartAmount: number,
    transactionDate: string,
  ): Promise<{ amount: number; exchangeRate: number }> {
    const legCurrencyCode =
      counterpart.account?.currencyCode ?? counterpart.currencyCode;
    const parentCurrencyCode =
      parentTransaction.account?.currencyCode ?? parentTransaction.currencyCode;

    if (
      !legCurrencyCode ||
      !parentCurrencyCode ||
      legCurrencyCode === parentCurrencyCode
    ) {
      return { amount: roundMoney(-newCounterpartAmount), exchangeRate: 1 };
    }

    const storedRate = Number(counterpart.exchangeRate);
    let rate: number | null =
      Number.isFinite(storedRate) && storedRate > 0
        ? roundFxRate(storedRate)
        : null;

    if (rate === null) {
      rate = await resolveFxRateOrNull(
        this.exchangeRateService,
        parentCurrencyCode,
        legCurrencyCode,
        transactionDate,
      );
    }
    if (rate === null) {
      throw new BadRequestException(
        tr(
          "errors.transactions.transferRateUnavailable",
          `Could not determine an exchange rate for ${parentCurrencyCode} -> ${legCurrencyCode}. Supply an exchangeRate or a destination amount so the transfer posts correctly.`,
          { from: parentCurrencyCode, to: legCurrencyCode },
        ),
      );
    }

    const exchangeRate = rate;
    return {
      amount: roundMoney(-newCounterpartAmount / exchangeRate),
      exchangeRate,
    };
  }

  private async updateSplitTransferLeg(
    userId: string,
    counterpart: Transaction,
    parentSplit: TransactionSplit,
    updateDto: Partial<UpdateTransferDto>,
    findOne: (userId: string, id: string) => Promise<Transaction>,
  ): Promise<TransferResult> {
    const parentTransaction = await findOne(userId, parentSplit.transactionId);

    // Reject account restructuring from the target side. The form always resends
    // the current accounts (from = source/parent account, to = this leg's
    // account); only a genuine change is blocked.
    const movesSource =
      !!updateDto.fromAccountId &&
      updateDto.fromAccountId !== parentTransaction.accountId;
    const movesTarget =
      !!updateDto.toAccountId &&
      updateDto.toAccountId !== counterpart.accountId;
    if (movesSource || movesTarget) {
      throw new BadRequestException(
        tr(
          "errors.transactions.splitTransferLegAccountLocked",
          "This transfer is part of a split transaction. Change its accounts by editing the split on the source transaction instead.",
        ),
      );
    }

    // Whether each row is included in its account's current balance. A split
    // parent and the legs its transfer children created are one economic event,
    // and this path checked neither row's state: a status-only VOID on the leg
    // wrote VOID and left the balance carrying the money, and an amount edit to an
    // already-VOID leg moved both balances by the delta even though neither row
    // contributes (recheck RR2-002).
    const counterpartIsVoid = counterpart.status === TransactionStatus.VOID;
    const parentIsVoid = parentTransaction.status === TransactionStatus.VOID;

    // Crossing the VOID boundary from one leg is refused rather than applied to
    // that leg alone: the parent's split row and total would still record money
    // leaving the source that never arrived. Inclusion belongs to the parent
    // event, which is why `applyParentStatusToTransferCounterparts` pushes the
    // parent's status down to every counterpart. Reconciliation states
    // (PENDING/CLEARED/RECONCILED) are genuinely per-ledger and pass through.
    const requestedIsVoid =
      updateDto.status !== undefined
        ? updateDto.status === TransactionStatus.VOID
        : counterpartIsVoid;
    if (requestedIsVoid !== counterpartIsVoid) {
      throw new BadRequestException(
        tr(
          "errors.transactions.splitTransferLegStatusLocked",
          "This transfer is part of a split transaction. Void or restore it by editing the split transaction it belongs to, so both sides change together.",
        ),
      );
    }

    await this.assertCategoryOwned(userId, updateDto.categoryId);

    const oldCounterpartAmount = Number(counterpart.amount);
    const sign = oldCounterpartAmount < 0 ? -1 : 1;
    const newCounterpartAmount =
      updateDto.amount !== undefined
        ? roundMoney(sign * Math.abs(updateDto.amount))
        : oldCounterpartAmount;
    const amountChanged = newCounterpartAmount !== oldCounterpartAmount;

    const oldDate = counterpart.transactionDate;
    const newDate = updateDto.transactionDate ?? oldDate;
    const dateChanged = oldDate !== newDate;

    // The counterpart's own editable fields. The currency itself is not editable
    // from here -- it is the leg account's, which this path refuses to change --
    // and neither is the rate, which belongs to the pair rather than to one side.
    const legData: Partial<Transaction> = {};
    if (updateDto.transactionDate)
      legData.transactionDate = updateDto.transactionDate as any;
    if (updateDto.description !== undefined)
      legData.description = updateDto.description ?? null;
    if (updateDto.referenceNumber !== undefined)
      legData.referenceNumber = updateDto.referenceNumber ?? null;
    if (updateDto.status !== undefined) legData.status = updateDto.status;
    if (updateDto.categoryId !== undefined)
      legData.categoryId = updateDto.categoryId || null;
    if (updateDto.payeeId !== undefined)
      legData.payeeId = updateDto.payeeId || null;
    if (updateDto.payeeName !== undefined)
      legData.payeeName = updateDto.payeeName || null;
    if (amountChanged) legData.amount = newCounterpartAmount;

    // The split row on the source transaction is kept in step with the leg: its
    // memo mirrors the leg's description (they are seeded from each other on
    // create), and its amount is the leg's amount converted back into the
    // parent's currency -- which is the leg's negated amount only when the two
    // accounts share a currency.
    const resolvedSource = amountChanged
      ? await this.resolveSplitLegSourceAmount(
          counterpart,
          parentTransaction,
          newCounterpartAmount,
          newDate,
        )
      : undefined;
    const newSplitAmount = resolvedSource?.amount;

    // A leg whose stored rate was missing forced the fallback lookup above, so
    // record what the pair was actually converted at rather than leaving the row
    // unable to answer the same question next time.
    if (
      resolvedSource !== undefined &&
      !(Number(counterpart.exchangeRate) > 0) &&
      resolvedSource.exchangeRate !== 1
    ) {
      legData.exchangeRate = resolvedSource.exchangeRate;
    }

    const splitData: Partial<TransactionSplit> = {};
    if (updateDto.description !== undefined)
      splitData.memo = updateDto.description ?? null;
    if (newSplitAmount !== undefined) splitData.amount = newSplitAmount as any;

    // The leg edit, split-row mirror, parent re-total, and balance updates
    // commit atomically.
    await withScopedDb(this.dataSource, async (m) => {
      if (Object.keys(legData).length > 0) {
        await m.update(Transaction, counterpart.id, legData);
      }

      // Rebalance the counterpart's own account for an amount and/or date change.
      // A VOID leg contributes nothing, so there is no delta to move -- the
      // persisted amount still changes, the balance does not.
      if ((amountChanged || dateChanged) && !counterpartIsVoid) {
        if (isTransactionInFuture(oldDate) || isTransactionInFuture(newDate)) {
          await this.accountsService.recalculateCurrentBalance(
            userId,
            counterpart.accountId,
          );
        } else {
          await this.accountsService.updateBalance(
            counterpart.accountId,
            // Rounded: the difference of two 4dp decimals is not itself a 4dp
            // decimal in binary floating point, and this value is the amount a
            // balance moves by.
            roundMoney(newCounterpartAmount - oldCounterpartAmount),
          );
        }
      }

      // Write the split row (memo mirror and/or amount) in one update.
      if (Object.keys(splitData).length > 0) {
        await m.update(TransactionSplit, parentSplit.id, splitData);
      }

      // When the amount changed, re-total the parent and rebalance the source.
      if (amountChanged && newSplitAmount !== undefined) {
        const siblingSplits = await m.find(TransactionSplit, {
          where: { transactionId: parentTransaction.id },
        });
        const sumCents = siblingSplits.reduce((acc, s) => {
          const amt =
            s.id === parentSplit.id ? newSplitAmount : Number(s.amount);
          return acc + Math.round(amt * 10000);
        }, 0);
        const newParentAmount = sumCents / 10000;
        const oldParentAmount = Number(parentTransaction.amount);

        await m.update(Transaction, parentTransaction.id, {
          amount: newParentAmount,
        });

        // Same rule on the source side: a VOID parent is excluded from its
        // account's balance, so re-totalling it moves the record and not the
        // money.
        if (!parentIsVoid) {
          if (isTransactionInFuture(parentTransaction.transactionDate)) {
            await this.accountsService.recalculateCurrentBalance(
              userId,
              parentTransaction.accountId,
            );
          } else {
            await this.accountsService.updateBalance(
              parentTransaction.accountId,
              roundMoney(newParentAmount - oldParentAmount),
            );
          }
        }
      }
    });

    this.triggerNetWorthRecalc(counterpart.accountId, userId);
    this.triggerNetWorthRecalc(parentTransaction.accountId, userId);

    // Return the edited leg as both slots so the wrapper's tag-sync touches only
    // this leg, never the split parent's tags.
    const refreshedLeg = await findOne(userId, counterpart.id);
    return {
      fromTransaction: refreshedLeg,
      toTransaction: refreshedLeg,
    };
  }

  private buildFromUpdateData(
    updateDto: Partial<UpdateTransferDto>,
    newAmount: number,
    oldFromAccountId: string,
    oldToAccountId: string,
    oldToAccountName: string,
    existingPayeeId: string | null,
    existingPayeeName: string | null,
    /**
     * The currency the row must be denominated in, derived from the account it
     * will belong to after this update.
     *
     * Written whenever it differs from what the row already holds. It used to be
     * written only when the request supplied `fromCurrencyCode`, and once that
     * field became optional -- because the server derives it -- moving a leg to
     * an account in another currency resolved FX correctly, moved the balance in
     * the new currency, and left the row still labelled with the old one.
     *
     * Compared against `existingCurrencyCode` rather than written every time, so
     * an edit that changes nothing still writes nothing.
     */
    derivedCurrencyCode?: string,
    existingCurrencyCode?: string | null,
    /**
     * The source amount the row already holds (positive magnitude).
     *
     * Compared rather than trusting the presence of `updateDto.amount`: the form
     * resends the current amount on every save, so a presence check rewrote the
     * row on an edit that changed nothing financial (recheck RR3-002).
     */
    existingFromAmount?: number,
  ): Partial<Transaction> {
    const data: Partial<Transaction> = {};
    if (updateDto.transactionDate)
      data.transactionDate = updateDto.transactionDate as any;
    if (
      updateDto.amount !== undefined &&
      (existingFromAmount === undefined ||
        roundMoney(newAmount) !== roundMoney(existingFromAmount))
    )
      data.amount = -newAmount;
    if (updateDto.description !== undefined)
      data.description = updateDto.description ?? null;
    if (updateDto.referenceNumber !== undefined)
      data.referenceNumber = updateDto.referenceNumber ?? null;
    if (updateDto.status !== undefined) data.status = updateDto.status;
    if (updateDto.categoryId !== undefined)
      data.categoryId = updateDto.categoryId || null;
    // Only the derived code ever reaches the row: a supplied code either
    // matched the account (so it equals derivedCurrencyCode) or already threw
    // in assertTransactionCurrencyMatchesAccount. There is deliberately no
    // client-authoritative fallback.
    if (derivedCurrencyCode && derivedCurrencyCode !== existingCurrencyCode)
      data.currencyCode = derivedCurrencyCode;
    if (updateDto.payeeId !== undefined)
      data.payeeId = updateDto.payeeId || null;
    if (updateDto.payeeName !== undefined)
      data.payeeName = updateDto.payeeName || null;
    if (
      updateDto.fromAccountId &&
      updateDto.fromAccountId !== oldFromAccountId
    ) {
      data.accountId = updateDto.fromAccountId;
    }

    // A legacy auto-stamped payee -- "Transfer to <oldToAccount>" with no
    // linked Payee entity, written by pre-#1214 code (or re-sent verbatim by
    // the form, which echoes the existing payeeName on every edit) -- is
    // cleared rather than preserved or restamped: blank is the persisted
    // state now, and the display resolves the label from the linked account's
    // current name. A stale stamp (the account was renamed since) no longer
    // matches and is deliberately left alone -- it cannot be told apart from
    // a hand-typed payee.
    const effectivePayeeName =
      updateDto.payeeName !== undefined
        ? updateDto.payeeName
        : existingPayeeName;
    const effectivePayeeId =
      updateDto.payeeId !== undefined ? updateDto.payeeId : existingPayeeId;
    if (
      !effectivePayeeId &&
      effectivePayeeName === autoTransferPayeeName("to", oldToAccountName)
    ) {
      data.payeeName = null;
    }

    return data;
  }

  private buildToUpdateData(
    updateDto: Partial<UpdateTransferDto>,
    newToAmount: number,
    newExchangeRate: number,
    oldFromAccountId: string,
    oldToAccountId: string,
    oldFromAccountName: string,
    existingPayeeId: string | null,
    existingPayeeName: string | null,
    /** As above: the destination row's currency, derived from its account. */
    derivedCurrencyCode?: string,
    existingCurrencyCode?: string | null,
    existingExchangeRate?: number | null,
    /**
     * Whether FX was actually re-resolved for this edit
     * (`resolveTransferFxForUpdate`). The destination account, currency, rate and
     * amount are one tuple: when it is re-resolved every changed member is
     * written, and when it is not, none of them are.
     *
     * Keying `amount` off the request fields instead meant a pure destination
     * account move across currencies wrote the new account, currency and rate and
     * left the old destination *number* on the row -- 90 GBP at 0.80 against a
     * 100 USD source, with the balance already moved by 80, so the next full
     * recompute changed the account by the 10 difference (recheck RR2-003).
     */
    repriced?: boolean,
    existingToAmount?: number,
  ): Partial<Transaction> {
    const data: Partial<Transaction> = {};
    if (updateDto.transactionDate)
      data.transactionDate = updateDto.transactionDate as any;
    if (repriced && newToAmount !== existingToAmount) data.amount = newToAmount;
    if (updateDto.description !== undefined)
      data.description = updateDto.description ?? null;
    if (updateDto.referenceNumber !== undefined)
      data.referenceNumber = updateDto.referenceNumber ?? null;
    if (updateDto.status !== undefined) data.status = updateDto.status;
    if (updateDto.categoryId !== undefined)
      data.categoryId = updateDto.categoryId || null;
    // Same as the from-side: derived only, no client fallback.
    if (derivedCurrencyCode && derivedCurrencyCode !== existingCurrencyCode)
      data.currencyCode = derivedCurrencyCode;
    // The rate the resolver settled on, not only one the client happened to
    // send: a server-resolved rate has to reach the row it describes. Written
    // only when this edit re-priced the transfer and only on a change, so a
    // presentation-only edit cannot rewrite the settlement it did not touch.
    if (
      repriced &&
      newExchangeRate !== undefined &&
      Number(newExchangeRate) !== Number(existingExchangeRate)
    )
      data.exchangeRate = newExchangeRate;
    // No `else if (updateDto.exchangeRate)` fallback: the resolver already honours
    // a supplied positive rate, so anything that reaches here either matches the
    // stored rate or belongs to an edit that did not re-price. Writing it anyway
    // put a rate onto a row from an edit that touched no money.
    if (updateDto.payeeId !== undefined)
      data.payeeId = updateDto.payeeId || null;
    if (updateDto.payeeName !== undefined)
      data.payeeName = updateDto.payeeName || null;
    if (updateDto.toAccountId && updateDto.toAccountId !== oldToAccountId) {
      data.accountId = updateDto.toAccountId;
    }

    // Mirror of the from-side: clear a legacy "Transfer from <oldFromAccount>"
    // stamp instead of restamping; leave anything else alone.
    const effectivePayeeName =
      updateDto.payeeName !== undefined
        ? updateDto.payeeName
        : existingPayeeName;
    const effectivePayeeId =
      updateDto.payeeId !== undefined ? updateDto.payeeId : existingPayeeId;
    if (
      !effectivePayeeId &&
      effectivePayeeName === autoTransferPayeeName("from", oldFromAccountName)
    ) {
      data.payeeName = null;
    }

    return data;
  }
}
