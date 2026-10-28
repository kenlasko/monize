import { ReportingRead } from "../accruals/reporting-basis";
import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Inject,
  forwardRef,
  Logger,
} from "@nestjs/common";
import { DataSource, EntityManager, In, Not } from "typeorm";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
import {
  Account,
  AccountType,
  AccountSubType,
} from "./entities/account.entity";
import { Transaction } from "../transactions/entities/transaction.entity";
import { InvestmentTransaction } from "../securities/entities/investment-transaction.entity";
import { Holding } from "../securities/entities/holding.entity";
import { Institution } from "../institutions/entities/institution.entity";
import { CreateAccountDto } from "./dto/create-account.dto";
import { UpdateAccountDto } from "./dto/update-account.dto";
import { ScheduledTransactionsService } from "../scheduled-transactions/scheduled-transactions.service";
import { NetWorthService } from "../net-worth/net-worth.service";
import {
  AccountMarketValue,
  PortfolioService,
} from "../securities/portfolio.service";
import { ExchangeRateService } from "../currencies/exchange-rate.service";
import { resolveUserDefaultCurrency } from "../common/default-currency.util";
import { memoizedRateResolver } from "../common/converting-total";
import {
  DetectMortgageTypeDto,
  MortgageTypeHistoryDetectionResponseDto,
} from "./dto/detect-mortgage-type.dto";
import { MortgageTypeDetection } from "./mortgage-type-detection.util";
import {
  CreatedLoanAccount,
  LoanMortgageAccountService,
} from "./loan-mortgage-account.service";
import { mortgageTermEndDate } from "./payment-frequency.util";
import { PaymentFrequency, AmortizationResult } from "./loan-amortization.util";
import {
  MortgagePaymentFrequency,
  MortgageAmortizationResult,
} from "./mortgage-amortization.util";
import { Cron } from "@nestjs/schedule";
import { roundMoney, sumMoney } from "../common/round.util";
import { tr } from "../i18n/translate";
import {
  brokerageSuffix,
  cashSuffix,
  pairHalfName,
  stripBrokerageSuffix,
  stripPairSuffix,
} from "./account-name.util";
import { formatDateYMD, todayInTimezone, todayYMD } from "../common/date-utils";
import { getUsersByEffectiveTimezone } from "../common/users-by-timezone.util";
import { didYouMean } from "../common/name-suggestions.util";
import { ActionHistoryService } from "../action-history/action-history.service";
import { withSystemContext } from "../common/db/with-context";
import { withScopedDb } from "../common/db/scoped-db";
import { lockAccountsForBalanceWrite } from "../common/db/locks";
import { affectedRowCount } from "../common/db/query-result";
import {
  LEDGER_MOVEMENT_PREDICATE,
  ledgerMovementPredicate,
} from "../common/ledger-balance.sql";
import {
  MortgageType,
  PrepaymentMode,
  mortgageTypeOf,
  prepaymentModeColumn,
  prepaymentModeOf,
  storesConstantPayment,
} from "./mortgage-type.util";
import { assertMortgageMethodTerms } from "./mortgage-installment.util";
import { applyMortgageMethodColumns } from "./mortgage-method-columns.util";
import {
  assertLoanSourceAccount,
  reassignLoanSourceAccount,
} from "./loan-source-account";
import {
  applyLoanInterestRelink,
  assertLoanInterestCategory,
  LoanInterestRelinkPlan,
  planLoanInterestRelink,
} from "./loan-interest-category";
import {
  DatedInstallment,
  derivedInstallmentFacts,
} from "./mortgage-installment-facts";
import { ScheduledOccurrenceService } from "../scheduled-transactions/scheduled-occurrence.service";

/**
 * Assets, liabilities and net worth as the summary and the LLM shape state them.
 *
 * A subtotal is not a total (`docs/financial-calculation-contract.md` section
 * 1): each `total*` / `netWorth` is `null` unless every component converted into
 * the reporting currency AND every held position was priced, and the sum of what
 * did is in its own `known*` field. `valuationComplete` is `fxComplete &&
 * pricesComplete`; read each flag as `=== false`.
 */
export interface NetWorthTotals {
  totalAssets: number | null;
  totalLiabilities: number | null;
  netWorth: number | null;
  knownAssetsSubtotal: number;
  knownLiabilitiesSubtotal: number;
  knownNetWorthSubtotal: number;
  fxComplete: boolean;
  pricesComplete: boolean;
  valuationComplete: boolean;
  /** `"CAD->USD"` for each pair with no rate; empty when `fxComplete`. */
  missingRatePairs: string[];
  /** The securities behind `pricesComplete: false`. */
  unpricedSecurityIds: string[];
  unpricedSymbols: string[];
}

/**
 * One account as the AI Assistant and the MCP server describe it.
 */
export interface LlmAccountRow {
  id: string;
  name: string;
  type: AccountType;
  subType: string | null;
  /**
   * The account's balance in its own currency. `null` for a brokerage account
   * whose holdings are not all priced and converted (`valuationComplete`
   * false): its market value is unknown, not zero, and the sum of what was
   * valued is `knownBalanceSubtotal`.
   */
  balance: number | null;
  /** Equal to `balance` when `valuationComplete`; otherwise the partial sum. */
  knownBalanceSubtotal: number;
  /** False when a held position had no price or no rate into the account's currency. */
  valuationComplete: boolean;
  currentBalance: number;
  creditLimit: number | null;
  interestRate: number | null;
  currency: string;
  /**
   * `balance` / `currentBalance` expressed in `defaultCurrency`, so a
   * reader never converts a foreign account itself. Equal to the account's
   * own figure (at `exchangeRate` 1) when the currencies match; `null` --
   * with the pair named in `missingRatePairs` -- when no rate exists. A
   * zero balance is zero in every currency and needs no rate.
   */
  balanceInDefaultCurrency: number | null;
  currentBalanceInDefaultCurrency: number | null;
  /** `currency -> defaultCurrency`, as applied; 1 for the same currency. */
  exchangeRate: number | null;
  isClosed: boolean;
  excludeFromNetWorth: boolean;
  institutionName: string | null;
  accountNumber: string | null;
  // Loan/mortgage fields, so an assistant can reason about a loan's
  // schedule (null on non-debt accounts).
  paymentAmount: number | null;
  paymentFrequency: string | null;
  paymentStartDate: string | null;
  amortizationMonths: number | null;
  originalPrincipal: number | null;
  /**
   * How a mortgage's rate compounds and its principal amortizes
   * (`mortgage-type.util.ts`); null on every other account type.
   */
  mortgageType: MortgageType | null;
  /** A LINEAR mortgage's prepayment mode; null on every other account. */
  prepaymentMode: PrepaymentMode | null;
  /**
   * A LINEAR or INTEREST_ONLY mortgage has no constant payment, so
   * `paymentAmount` is null for it (docs/specs/mortgage-types.md, decision 11)
   * and this carries the next installment of its scheduled payment with its
   * due date instead. Null on every other account, and when the mortgage has
   * no active scheduled payment.
   */
  nextInstallment: DatedInstallment | null;
  /**
   * An INTEREST_ONLY mortgage's final payment (the whole debt plus that
   * period's interest) and its date, which an installment of interest alone
   * would otherwise hide. Null on every other account.
   */
  bullet: { dueDate: string; amount: number } | null;
}

/**
 * The one statement that moves `accounts.current_balance` by a delta
 * (`docs/concurrency-and-idempotency.md` section 2, row 1). PostgreSQL does the
 * arithmetic after it wins the row lock, so two concurrent deltas compose
 * instead of one overwriting the other; a `findOne` followed by an absolute
 * write could not promise that.
 *
 * `openOnly` makes `is_closed = false` a predicate of the write itself (see
 * `AccountsService.updateBalance` for why a separate check is not enough). The
 * import passes `false`: it already holds the account it is writing into and
 * treats a missing row as a no-op.
 *
 * Returns the number of rows the statement changed, so the caller decides what
 * zero means (a refusal to report, or nothing to do).
 */
export async function applyAccountBalanceDelta(
  m: EntityManager,
  accountId: string,
  delta: number,
  options: { openOnly: boolean },
): Promise<number> {
  const closedPredicate = options.openOnly ? " AND is_closed = false" : "";
  const updated: unknown = await m.query(
    `UPDATE accounts
        SET current_balance = ROUND(CAST(current_balance AS numeric) + $1, 4)
      WHERE id = $2${closedPredicate}
      RETURNING id`,
    [delta, accountId],
  );
  return affectedRowCount(updated);
}

@Injectable()
export class AccountsService {
  private readonly logger = new Logger(AccountsService.name);

  constructor(
    @Inject(forwardRef(() => ScheduledTransactionsService))
    private scheduledTransactionsService: ScheduledTransactionsService,
    @Inject(forwardRef(() => NetWorthService))
    private netWorthService: NetWorthService,
    @Inject(forwardRef(() => PortfolioService))
    private portfolioService: PortfolioService,
    // AccountsModule reaches CurrenciesModule through a forwardRef, so the
    // provider it lends is injected the same way (`src/module-graph.spec.ts`).
    @Inject(forwardRef(() => ExchangeRateService))
    private exchangeRateService: ExchangeRateService,
    private loanMortgageService: LoanMortgageAccountService,
    private dataSource: DataSource,
    private actionHistoryService: ActionHistoryService,
    @Inject(forwardRef(() => ScheduledOccurrenceService))
    private scheduledOccurrenceService: ScheduledOccurrenceService,
  ) {}

  /**
   * Verify that an institution id (if provided) exists and belongs to the user.
   * Prevents assigning an account to another user's institution.
   */
  private async assertInstitutionOwned(
    userId: string,
    institutionId: string | null | undefined,
  ): Promise<void> {
    if (!institutionId) return;
    const institution = await withScopedDb(this.dataSource, (m) =>
      m.getRepository(Institution).findOne({
        where: { id: institutionId, userId },
        select: { id: true },
      }),
    );
    if (!institution) {
      throw new BadRequestException(
        tr("errors.accounts.institutionNotFound", "Institution not found", {
          id: institutionId,
        }),
      );
    }
  }

  /**
   * Create a new account for a user
   */
  async create(
    userId: string,
    createAccountDto: CreateAccountDto,
  ): Promise<Account | { cashAccount: Account; brokerageAccount: Account }> {
    const {
      openingBalance = 0,
      createInvestmentPair,
      paymentMatching,
      ...accountData
    } = createAccountDto;

    await this.assertInstitutionOwned(userId, accountData.institutionId);

    // Payment matching settles mortgages and loans only (docs/specs/
    // loan-installment-settlement.md decision 4); refused before any write.
    if (
      paymentMatching &&
      accountData.accountType !== AccountType.MORTGAGE &&
      accountData.accountType !== AccountType.LOAN
    ) {
      throw new BadRequestException(
        tr(
          "errors.accounts.paymentMatchingLoanOnly",
          "Payment matching applies to mortgages and loans only",
        ),
      );
    }

    // If creating an investment account pair, delegate to the pair creation method
    if (
      createInvestmentPair &&
      accountData.accountType === AccountType.INVESTMENT
    ) {
      return this.createInvestmentAccountPair(userId, createAccountDto);
    }

    // If creating a loan account with payment details, delegate to loan creation method
    if (
      accountData.accountType === AccountType.LOAN &&
      createAccountDto.paymentAmount &&
      createAccountDto.paymentFrequency &&
      createAccountDto.paymentStartDate &&
      createAccountDto.sourceAccountId
    ) {
      return this.createLoanAccount(userId, createAccountDto);
    }

    // If creating a mortgage account with payment details, delegate to mortgage creation method
    if (
      accountData.accountType === AccountType.MORTGAGE &&
      createAccountDto.mortgagePaymentFrequency &&
      createAccountDto.paymentStartDate &&
      createAccountDto.sourceAccountId &&
      createAccountDto.amortizationMonths
    ) {
      return this.createMortgageAccount(userId, createAccountDto);
    }

    // The rule matches the bank debits of the loan's scheduled payment, which
    // only the two paths above create.
    if (paymentMatching) {
      throw new BadRequestException(
        tr(
          "errors.accounts.paymentMatchingRequiresSchedule",
          "Payment matching needs the loan's scheduled payment. Set up its payments first.",
        ),
      );
    }

    // Strip credit card statement fields for non-credit-card accounts
    if (accountData.accountType !== AccountType.CREDIT_CARD) {
      delete accountData.statementDueDay;
      delete accountData.statementSettlementDay;
    }

    // Only a mortgage takes a requested type; a request naming none is the
    // default type, as is every other account type's row (the column
    // default). LINEAR and INTEREST_ONLY are refused without the terms their
    // method prices from (spec section 8), store no constant payment
    // (decision 11), and only LINEAR keeps a prepayment mode (decision 10).
    const mortgageType =
      accountData.accountType === AccountType.MORTGAGE
        ? (accountData.mortgageType ?? "ANNUITY")
        : null;
    const prepaymentMode = mortgageType
      ? prepaymentModeColumn(mortgageType, accountData.prepaymentMode)
      : null;
    const derivesInstallment =
      mortgageType !== null && !storesConstantPayment(mortgageType);
    // A LINEAR or INTEREST_ONLY request carrying only the mortgage form's
    // cadence (it skipped the full mortgage path for want of a source account)
    // has that cadence stored, so the row is one the method can price and the
    // refusal below never names a field the client did not send. The column
    // holds both spellings (`periodsPerYearForStoredFrequency`).
    const paymentFrequency: string | undefined =
      accountData.paymentFrequency ??
      (derivesInstallment ? accountData.mortgagePaymentFrequency : undefined);
    const mortgageColumns = mortgageType
      ? {
          mortgageType,
          prepaymentMode,
          ...(derivesInstallment ? { paymentFrequency } : {}),
        }
      : {};
    if (derivesInstallment) {
      assertMortgageMethodTerms(mortgageType, {
        ...accountData,
        paymentFrequency,
        prepaymentMode,
        openingBalance,
      });
      delete accountData.paymentAmount;
    }
    delete accountData.mortgageType;
    delete accountData.prepaymentMode;

    const saved = await withScopedDb(this.dataSource, (m) => {
      const repo = m.getRepository(Account);
      const account = repo.create({
        ...accountData,
        ...mortgageColumns,
        userId,
        openingBalance,
        currentBalance: openingBalance,
      });
      return repo.save(account);
    });

    this.actionHistoryService.record(userId, {
      entityType: "account",
      entityId: saved.id,
      action: "create",
      afterData: { ...saved },
      description: `Created account "${saved.name}"`,
      descriptionKey: "createdAccount",
      descriptionParams: { name: saved.name },
    });

    return saved;
  }

  /**
   * Create a linked investment account pair (cash + brokerage).
   * Wrapped in a QueryRunner transaction for atomicity.
   */
  async createInvestmentAccountPair(
    userId: string,
    createAccountDto: CreateAccountDto,
  ): Promise<{ cashAccount: Account; brokerageAccount: Account }> {
    const {
      openingBalance = 0,
      name,
      // Only a mortgage has a type.
      mortgageType: _mortgageType,
      prepaymentMode: _prepaymentMode,
      ...accountData
    } = createAccountDto;

    return withScopedDb(this.dataSource, async (m) => {
      const repo = m.getRepository(Account);

      // Suffixes are localized to the requester's language so the generated
      // pair names read naturally (e.g. "TFSA - Bargeld") instead of always
      // appending the English words.
      const cashSuffixWord = cashSuffix();
      const brokerageSuffixWord = brokerageSuffix();

      // Create the cash account first
      const cashAccount = repo.create({
        ...accountData,
        name: `${name} - ${cashSuffixWord}`,
        userId,
        openingBalance,
        currentBalance: openingBalance,
        accountType: AccountType.INVESTMENT,
        accountSubType: AccountSubType.INVESTMENT_CASH,
      });
      await repo.save(cashAccount);

      // Create the brokerage account linked to the cash account
      const brokerageAccount = repo.create({
        ...accountData,
        name: `${name} - ${brokerageSuffixWord}`,
        userId,
        openingBalance: 0,
        currentBalance: 0,
        accountType: AccountType.INVESTMENT,
        accountSubType: AccountSubType.INVESTMENT_BROKERAGE,
        linkedAccountId: cashAccount.id,
      });
      await repo.save(brokerageAccount);

      // Update cash account to link back to brokerage
      cashAccount.linkedAccountId = brokerageAccount.id;
      await repo.save(cashAccount);

      return { cashAccount, brokerageAccount };
    });
  }

  /**
   * Find all accounts for a user
   */
  async findAll(
    userId: string,
    includeInactive = false,
  ): Promise<
    (Account & { canDelete?: boolean; futureTransactionsSum?: number })[]
  > {
    return withScopedDb(this.dataSource, async (m) => {
      const queryBuilder = m
        .getRepository(Account)
        .createQueryBuilder("account")
        .where("account.userId = :userId", { userId })
        .orderBy("account.createdAt", "DESC");

      if (!includeInactive) {
        queryBuilder.andWhere("account.isClosed = :isClosed", {
          isClosed: false,
        });
      }

      const accounts = await queryBuilder.getMany();

      if (accounts.length === 0) return [];

      // Batch check deletability: count transactions + investment transactions per account in 2 queries
      const accountIds = accounts.map((a) => a.id);

      const today = todayYMD();

      const txCounts = await m
        .getRepository(Transaction)
        .createQueryBuilder("t")
        .select("t.accountId", "accountId")
        .addSelect("COUNT(t.id)", "cnt")
        .where("t.accountId IN (:...accountIds)", { accountIds })
        .groupBy("t.accountId")
        .getRawMany();
      const invTxCounts = await m
        // includes VOID rows: records read -- an activity count, not an effect.
        .getRepository(InvestmentTransaction)
        .createQueryBuilder("it")
        .select("it.accountId", "accountId")
        .addSelect("COUNT(it.id)", "cnt")
        .where("it.accountId IN (:...accountIds)", { accountIds })
        .groupBy("it.accountId")
        .getRawMany();
      const futureSums: Array<{ accountId: string; futureSum: string }> =
        await m.query(
          `SELECT t.account_id as "accountId",
                COALESCE(SUM(t.amount), 0) as "futureSum"
         FROM transactions t
         WHERE t.account_id = ANY($1)
           AND t.transaction_date > $2
           AND ${LEDGER_MOVEMENT_PREDICATE}
         GROUP BY t.account_id`,
          [accountIds, today],
        );
      // Compute currentBalance live rather than trusting the stored column.
      // The stored value can lag the TZ-aware definition of "today" (e.g.
      // after a timezone change, or after a future-dated create that ran
      // under the old server-UTC logic), and if it does, adding it to the
      // live futureTransactionsSum below would double-count any transactions
      // that wandered across the boundary.
      const currentSums: Array<{ accountId: string; currentBalance: string }> =
        await m.query(
          `SELECT a.id as "accountId",
                COALESCE(a.opening_balance, 0) + COALESCE(SUM(t.amount), 0) as "currentBalance"
         FROM accounts a
         LEFT JOIN transactions t ON t.account_id = a.id
           AND ${LEDGER_MOVEMENT_PREDICATE}
           AND t.transaction_date <= $2
         WHERE a.id = ANY($1)
         GROUP BY a.id, a.opening_balance`,
          [accountIds, today],
        );

      const txCountMap = new Map<string, number>();
      for (const row of txCounts)
        txCountMap.set(row.accountId, parseInt(row.cnt, 10));
      const invTxCountMap = new Map<string, number>();
      for (const row of invTxCounts)
        invTxCountMap.set(row.accountId, parseInt(row.cnt, 10));
      const futureSumMap = new Map<string, number>();
      for (const row of futureSums)
        futureSumMap.set(row.accountId, roundMoney(Number(row.futureSum)));
      const currentBalanceMap = new Map<string, number>();
      for (const row of currentSums)
        currentBalanceMap.set(
          row.accountId,
          roundMoney(Number(row.currentBalance)),
        );

      return accounts.map((account) => ({
        ...account,
        currentBalance:
          currentBalanceMap.get(account.id) ?? account.currentBalance,
        canDelete:
          !(txCountMap.get(account.id) || 0) &&
          !(invTxCountMap.get(account.id) || 0),
        futureTransactionsSum: futureSumMap.get(account.id) ?? 0,
      }));
    });
  }

  /**
   * Resolve a single account name to its id, canonical name, and currency.
   * Case-insensitive exact match over the user's OPEN accounts. Returns
   * undefined when no open account matches the given name.
   */
  async resolveByName(
    userId: string,
    name: string,
  ): Promise<{ id: string; name: string; currencyCode: string } | undefined> {
    const accounts = await this.findAll(userId, false);
    const match = accounts.find(
      (a) => a.name.toLowerCase() === name.toLowerCase(),
    );
    return match
      ? { id: match.id, name: match.name, currencyCode: match.currencyCode }
      : undefined;
  }

  /**
   * Resolve a list of account names to an account-id filter. Case-insensitive
   * exact match over the user's OPEN accounts. Returns:
   * - `{ accountIds: undefined }` when no names are supplied (treat as "all
   *   accounts");
   * - `{ accountIds }` when every name resolves;
   * - `{ error }` with a "did you mean" hint when one or more names do not
   *   match, so the caller can surface a self-correcting message instead of
   *   silently dropping the unknown name (which would scope the answer to the
   *   wrong set of accounts).
   *
   * Shared by the AI Assistant tool executor and the MCP investment tools so
   * both accept friendly account names with consistent error messaging.
   */
  async resolveAccountFilter(
    userId: string,
    names?: string[],
  ): Promise<{ accountIds?: string[]; error?: string }> {
    if (!names || names.length === 0) return { accountIds: undefined };

    const accounts = await this.findAll(userId, false);
    const nameMap = new Map(accounts.map((a) => [a.name.toLowerCase(), a.id]));

    const accountIds: string[] = [];
    const unresolved: string[] = [];
    for (const name of names) {
      const id = nameMap.get(name.toLowerCase());
      if (id) accountIds.push(id);
      else unresolved.push(name);
    }

    if (unresolved.length > 0) {
      const suggestion = didYouMean(
        unresolved[0],
        accounts.map((a) => a.name),
      );
      return {
        error: `Unknown account${unresolved.length === 1 ? "" : "s"}: ${unresolved.join(", ")}.${suggestion} Call list_accounts to look up valid names.`,
      };
    }

    return { accountIds };
  }

  /**
   * Resolve an account name for an investment transaction, preferring the
   * brokerage half of a linked investment pair. Investment transactions must be
   * booked against the brokerage account, which is auto-named "<name> -
   * Brokerage", but users (and the AI) naturally refer to the pair by its base
   * name (e.g. "RRSP"). So: try an exact case-insensitive match first (existing
   * behaviour); failing that, match the base name against open brokerage
   * accounts with the " - Brokerage" suffix stripped. Returns the resolved
   * account, plus the candidate names when the base name is ambiguous (more than
   * one brokerage account shares it) so the caller can surface a clear error.
   */
  async resolveBrokerageByName(
    userId: string,
    name: string,
  ): Promise<{
    match: { id: string; name: string; currencyCode: string } | undefined;
    candidates: { id: string; name: string }[];
  }> {
    const accounts = await this.findAll(userId, false);
    const target = name.trim().toLowerCase();

    const exact = accounts.find((a) => a.name.toLowerCase() === target);
    if (exact) {
      return {
        match: {
          id: exact.id,
          name: exact.name,
          currencyCode: exact.currencyCode,
        },
        candidates: [],
      };
    }

    const brokerageMatches = accounts.filter(
      (a) =>
        a.accountType === AccountType.INVESTMENT &&
        a.accountSubType === AccountSubType.INVESTMENT_BROKERAGE &&
        stripBrokerageSuffix(a.name).toLowerCase() === target,
    );
    if (brokerageMatches.length === 1) {
      const match = brokerageMatches[0];
      return {
        match: {
          id: match.id,
          name: match.name,
          currencyCode: match.currencyCode,
        },
        candidates: [],
      };
    }

    return {
      match: undefined,
      candidates: brokerageMatches.map((a) => ({ id: a.id, name: a.name })),
    };
  }

  /**
   * Resolve an account given as either its UUID or its name. A UUID matches
   * the user's open accounts by id; anything else goes through
   * `resolveBrokerageByName`, so a base name ("RRSP") still reaches its
   * brokerage. Same result shape as `resolveBrokerageByName`.
   */
  async resolveBrokerageByNameOrId(
    userId: string,
    nameOrId: string,
  ): Promise<{
    match: { id: string; name: string; currencyCode: string } | undefined;
    candidates: { id: string; name: string }[];
  }> {
    const value = nameOrId.trim();
    if (UUID_RE.test(value)) {
      const accounts = await this.findAll(userId, false);
      const byId = accounts.find(
        (a) => a.id.toLowerCase() === value.toLowerCase(),
      );
      if (byId) {
        return {
          match: {
            id: byId.id,
            name: byId.name,
            currencyCode: byId.currencyCode,
          },
          candidates: [],
        };
      }
    }
    return this.resolveBrokerageByName(userId, value);
  }

  /**
   * Find a single account by ID
   */
  async findOne(userId: string, id: string): Promise<Account> {
    const account = await withScopedDb(this.dataSource, (m) =>
      m.getRepository(Account).findOne({
        where: { id, userId },
      }),
    );

    if (!account) {
      throw new NotFoundException(
        tr(
          "errors.accounts.accountWithIdNotFound",
          `Account with ID ${id} not found`,
          { id },
        ),
      );
    }

    return account;
  }

  /**
   * Find multiple accounts by IDs for a user (batch lookup).
   * Silently skips IDs that don't belong to the user.
   */
  async findByIds(userId: string, ids: string[]): Promise<Account[]> {
    if (ids.length === 0) return [];
    return withScopedDb(this.dataSource, (m) =>
      m.getRepository(Account).find({
        where: { id: In(ids), userId },
      }),
    );
  }

  /**
   * Get the linked investment account pair for a given account ID
   */
  async getInvestmentAccountPair(
    userId: string,
    accountId: string,
  ): Promise<{ cashAccount: Account; brokerageAccount: Account }> {
    const account = await this.findOne(userId, accountId);

    // Check if this is an investment account with a sub-type
    if (
      account.accountType !== AccountType.INVESTMENT ||
      !account.accountSubType
    ) {
      throw new BadRequestException(
        tr(
          "errors.accounts.notInvestmentPair",
          "This account is not part of an investment account pair",
        ),
      );
    }

    // Get the linked account
    if (!account.linkedAccountId) {
      throw new BadRequestException(
        tr(
          "errors.accounts.noLinkedInvestmentAccount",
          "This investment account does not have a linked account",
        ),
      );
    }

    const linkedAccount = await this.findOne(userId, account.linkedAccountId);

    // Return in correct order based on sub-type
    if (account.accountSubType === AccountSubType.INVESTMENT_CASH) {
      return { cashAccount: account, brokerageAccount: linkedAccount };
    } else {
      return { cashAccount: linkedAccount, brokerageAccount: account };
    }
  }

  async createLoanAccount(
    userId: string,
    createAccountDto: CreateAccountDto,
  ): Promise<CreatedLoanAccount> {
    await this.findOne(userId, createAccountDto.sourceAccountId!);
    return this.loanMortgageService.createLoanAccount(userId, createAccountDto);
  }

  async createMortgageAccount(
    userId: string,
    createAccountDto: CreateAccountDto,
  ): Promise<CreatedLoanAccount> {
    await this.findOne(userId, createAccountDto.sourceAccountId!);
    return this.loanMortgageService.createMortgageAccount(
      userId,
      createAccountDto,
    );
  }

  previewMortgageAmortization(
    mortgageAmount: number,
    interestRate: number,
    amortizationMonths: number,
    paymentFrequency: MortgagePaymentFrequency,
    paymentStartDate: Date,
    mortgageType: MortgageType,
  ): MortgageAmortizationResult {
    return this.loanMortgageService.previewMortgageAmortization(
      mortgageAmount,
      interestRate,
      amortizationMonths,
      paymentFrequency,
      paymentStartDate,
      mortgageType,
    );
  }

  async updateMortgageRate(
    userId: string,
    accountId: string,
    newRate: number,
    effectiveDate: Date,
    newPaymentAmount?: number,
  ) {
    const account = await this.findOne(userId, accountId);
    return this.loanMortgageService.updateMortgageRate(
      account,
      userId,
      newRate,
      effectiveDate,
      newPaymentAmount,
    );
  }

  detectMortgageTypeFromSamples(
    dto: DetectMortgageTypeDto,
  ): MortgageTypeDetection {
    return this.loanMortgageService.detectMortgageTypeFromSamples(dto);
  }

  async detectMortgageTypeFromHistory(
    userId: string,
    accountId: string,
  ): Promise<MortgageTypeHistoryDetectionResponseDto> {
    const account = await this.findOne(userId, accountId);
    return this.loanMortgageService.detectMortgageTypeFromHistory(
      account,
      userId,
    );
  }

  previewLoanAmortization(
    loanAmount: number,
    interestRate: number,
    paymentAmount: number,
    paymentFrequency: PaymentFrequency,
    paymentStartDate: Date,
  ): AmortizationResult {
    return this.loanMortgageService.previewLoanAmortization(
      loanAmount,
      interestRate,
      paymentAmount,
      paymentFrequency,
      paymentStartDate,
    );
  }

  /**
   * Update an account
   */
  async update(
    userId: string,
    id: string,
    updateAccountDto: UpdateAccountDto,
  ): Promise<Account> {
    const { savedAccount, beforeData } = await withScopedDb(
      this.dataSource,
      async (m) => {
        // Use pessimistic lock to prevent concurrent balance modifications
        const account = await m.findOne(Account, {
          where: { id, userId },
          lock: { mode: "pessimistic_write" },
        });

        if (!account) {
          throw new NotFoundException(
            tr("errors.accounts.notFound", "Account not found"),
          );
        }

        if (account.isClosed) {
          throw new BadRequestException(
            tr(
              "errors.accounts.updateClosed",
              "Cannot update a closed account",
            ),
          );
        }

        // Currency is locked once the account has transactions. Allowing it to
        // change after that would silently re-denominate existing balances.
        if (
          updateAccountDto.currencyCode !== undefined &&
          updateAccountDto.currencyCode !== account.currencyCode
        ) {
          const transactionCount = await m.count(Transaction, {
            where: { accountId: id },
          });
          // includes VOID rows: records read -- a VOID row still stores
          // figures denominated in the old currency.
          const investmentTransactionCount = await m.count(
            InvestmentTransaction,
            { where: { accountId: id } },
          );

          if (transactionCount > 0 || investmentTransactionCount > 0) {
            throw new BadRequestException(
              tr(
                "errors.accounts.changeCurrencyWithTransactions",
                "Cannot change the currency of an account that has transactions.",
              ),
            );
          }
        }

        const before = { ...account };

        // If openingBalance is being changed, we need to recalculate currentBalance
        // currentBalance = openingBalance + sum(all transaction amounts)
        if (
          updateAccountDto.openingBalance !== undefined &&
          updateAccountDto.openingBalance !== account.openingBalance
        ) {
          const oldOpeningBalance = Number(account.openingBalance) || 0;
          const newOpeningBalance =
            Number(updateAccountDto.openingBalance) || 0;
          const difference = newOpeningBalance - oldOpeningBalance;

          // Adjust currentBalance by the difference
          account.currentBalance = roundMoney(
            Number(account.currentBalance) + difference,
          );
        }

        // SECURITY: Explicit property mapping instead of Object.assign to prevent mass assignment
        if (updateAccountDto.name !== undefined)
          account.name = updateAccountDto.name;
        if (updateAccountDto.accountType !== undefined)
          account.accountType = updateAccountDto.accountType;
        if (updateAccountDto.currencyCode !== undefined)
          account.currencyCode = updateAccountDto.currencyCode;
        if (updateAccountDto.openingBalance !== undefined)
          account.openingBalance = updateAccountDto.openingBalance;
        if (updateAccountDto.description !== undefined)
          account.description = updateAccountDto.description;
        if (updateAccountDto.accountNumber !== undefined)
          account.accountNumber = updateAccountDto.accountNumber;
        if (updateAccountDto.institution !== undefined)
          account.institution = updateAccountDto.institution;
        if (updateAccountDto.institutionId !== undefined) {
          await this.assertInstitutionOwned(
            userId,
            updateAccountDto.institutionId,
          );
          account.institutionId = updateAccountDto.institutionId;
          // Clear the loaded relation so TypeORM persists the scalar FK change
          // rather than re-deriving it from a stale relation object.
          account.institutionRef = null;
        }
        if (updateAccountDto.creditLimit !== undefined)
          account.creditLimit = updateAccountDto.creditLimit;
        if (updateAccountDto.interestRate !== undefined)
          account.interestRate = updateAccountDto.interestRate;
        // Balance thresholds: reset the latch when the threshold changes, so a
        // newly set threshold arms cleanly on the next crossing (spec 4.1).
        if (updateAccountDto.lowBalanceThreshold !== undefined) {
          if (
            account.lowBalanceThreshold !== updateAccountDto.lowBalanceThreshold
          )
            account.lowAlertArmed = false;
          account.lowBalanceThreshold = updateAccountDto.lowBalanceThreshold;
        }
        if (updateAccountDto.highBalanceThreshold !== undefined) {
          if (
            account.highBalanceThreshold !==
            updateAccountDto.highBalanceThreshold
          )
            account.highAlertArmed = false;
          account.highBalanceThreshold = updateAccountDto.highBalanceThreshold;
        }
        if (updateAccountDto.isFavourite !== undefined)
          account.isFavourite = updateAccountDto.isFavourite;
        if (updateAccountDto.excludeFromNetWorth !== undefined)
          account.excludeFromNetWorth = updateAccountDto.excludeFromNetWorth;
        if (updateAccountDto.favouriteSortOrder !== undefined)
          account.favouriteSortOrder = updateAccountDto.favouriteSortOrder;
        // Credit card statement fields (only for credit card accounts)
        const effectiveType =
          updateAccountDto.accountType ?? account.accountType;
        if (effectiveType === AccountType.CREDIT_CARD) {
          if (updateAccountDto.statementDueDay !== undefined)
            account.statementDueDay = updateAccountDto.statementDueDay;
          if (updateAccountDto.statementSettlementDay !== undefined)
            account.statementSettlementDay =
              updateAccountDto.statementSettlementDay;
        } else {
          // Clear statement fields if account type is changed away from credit card
          account.statementDueDay = null;
          account.statementSettlementDay = null;
        }
        if (updateAccountDto.paymentAmount !== undefined)
          account.paymentAmount = updateAccountDto.paymentAmount;
        if (updateAccountDto.paymentFrequency !== undefined)
          account.paymentFrequency = updateAccountDto.paymentFrequency;
        if (updateAccountDto.paymentStartDate !== undefined)
          account.paymentStartDate = updateAccountDto.paymentStartDate
            ? new Date(updateAccountDto.paymentStartDate)
            : null;
        // A value difference, not the field being sent: the form resends it.
        // The schedule and the settlement rules follow it after the save.
        const sourceAccountChanged =
          updateAccountDto.sourceAccountId !== undefined &&
          updateAccountDto.sourceAccountId !== account.sourceAccountId;
        if (sourceAccountChanged) {
          await assertLoanSourceAccount(
            m,
            userId,
            id,
            updateAccountDto.sourceAccountId!,
          );
          account.sourceAccountId = updateAccountDto.sourceAccountId!;
        }
        if (updateAccountDto.principalCategoryId !== undefined)
          account.principalCategoryId = updateAccountDto.principalCategoryId;
        // A value difference, as above. The template's interest line follows
        // it after the save, or the whole update is refused (INV-LOAN-010).
        const interestCategoryChanged =
          updateAccountDto.interestCategoryId !== undefined &&
          (updateAccountDto.interestCategoryId ?? null) !==
            (account.interestCategoryId ?? null);
        let interestRelink: LoanInterestRelinkPlan | null = null;
        if (interestCategoryChanged) {
          const nextInterestCategoryId =
            updateAccountDto.interestCategoryId ?? null;
          if (nextInterestCategoryId !== null) {
            await assertLoanInterestCategory(m, userId, nextInterestCategoryId);
          }
          interestRelink = await planLoanInterestRelink(
            m,
            userId,
            account,
            before.interestCategoryId ?? null,
            nextInterestCategoryId,
          );
          account.interestCategoryId = nextInterestCategoryId;
        }
        if (updateAccountDto.interestBookingMode !== undefined)
          account.interestBookingMode = updateAccountDto.interestBookingMode;
        if (updateAccountDto.overpaymentCategoryId !== undefined)
          account.overpaymentCategoryId =
            updateAccountDto.overpaymentCategoryId;
        if (updateAccountDto.overpaymentMemo !== undefined)
          account.overpaymentMemo = updateAccountDto.overpaymentMemo?.trim()
            ? updateAccountDto.overpaymentMemo.trim()
            : null;
        if (updateAccountDto.overpaymentPayeeId !== undefined)
          account.overpaymentPayeeId = updateAccountDto.overpaymentPayeeId;
        if (updateAccountDto.fxFeePercent !== undefined)
          account.fxFeePercent = updateAccountDto.fxFeePercent;
        if (updateAccountDto.assetCategoryId !== undefined)
          account.assetCategoryId = updateAccountDto.assetCategoryId;
        if (updateAccountDto.dateAcquired !== undefined)
          account.dateAcquired = updateAccountDto.dateAcquired
            ? new Date(updateAccountDto.dateAcquired)
            : null;
        if (updateAccountDto.linkedLoanAccountId !== undefined)
          account.linkedLoanAccountId = updateAccountDto.linkedLoanAccountId;
        // Mortgage-specific fields. Only a mortgage takes a requested type;
        // any other account type carries the column's default (reset when an
        // edit moves a mortgage to another type, as every non-mortgage row
        // holds it).
        if (effectiveType === AccountType.MORTGAGE) {
          // `@IsOptional()` admits null; like an absent field it leaves the
          // stored type alone, never a null the NOT NULL column refuses.
          if (updateAccountDto.mortgageType != null)
            account.mortgageType = updateAccountDto.mortgageType;
        } else {
          account.mortgageType = "ANNUITY";
        }
        if (updateAccountDto.termMonths !== undefined) {
          account.termMonths = updateAccountDto.termMonths || null;
          // Recalculate termEndDate when termMonths changes
          if (updateAccountDto.termMonths > 0 && account.paymentStartDate) {
            account.termEndDate = mortgageTermEndDate(
              new Date(account.paymentStartDate),
              updateAccountDto.termMonths,
            );
          } else {
            account.termEndDate = null;
          }
        }
        if (updateAccountDto.amortizationMonths !== undefined)
          account.amortizationMonths = updateAccountDto.amortizationMonths;
        // The amount originally borrowed, apart from the opening balance
        // (docs/specs/loan-installment-settlement.md section 14.3). A value
        // difference, not the field being sent: the form resends it.
        const amountOrNull = (value: number | string | null | undefined) =>
          value == null ? null : roundMoney(Number(value));
        const originalPrincipalChanged =
          updateAccountDto.originalPrincipal !== undefined &&
          amountOrNull(updateAccountDto.originalPrincipal) !==
            amountOrNull(account.originalPrincipal);
        if (updateAccountDto.originalPrincipal !== undefined)
          account.originalPrincipal = updateAccountDto.originalPrincipal;
        // The prepayment mode and the stored payment follow the saved type,
        // in this transaction (spec section 5.6).
        const { repriceTemplate: methodRepriced } =
          await applyMortgageMethodColumns(
            m,
            account,
            {
              type:
                before.accountType === AccountType.MORTGAGE
                  ? mortgageTypeOf(before)
                  : null,
              mode: before.prepaymentMode ?? null,
            },
            updateAccountDto.prepaymentMode,
          );
        // A LINEAR constant principal is the amount originally borrowed over
        // the payment count (`constantLinearPrincipal`), so the template's
        // installment moves with it.
        const repriceTemplate =
          methodRepriced ||
          (originalPrincipalChanged &&
            account.accountType === AccountType.MORTGAGE &&
            mortgageTypeOf(account) === "LINEAR");

        // Keep a linked investment pair (cash <-> brokerage) in sync. Both halves
        // represent one real-world account, so shared attributes -- currency,
        // institution and the name -- propagate to the partner automatically.
        const currencyChanged = updateAccountDto.currencyCode !== undefined;
        const institutionChanged = updateAccountDto.institutionId !== undefined;
        const nameChanged = updateAccountDto.name !== undefined;
        const linkedAccount =
          (currencyChanged || institutionChanged || nameChanged) &&
          account.linkedAccountId &&
          account.accountType === AccountType.INVESTMENT
            ? await m.findOne(Account, {
                where: { id: account.linkedAccountId, userId },
              })
            : null;
        let linkedChanged = false;

        // A pair has one name, stored twice with different suffixes, so a
        // rename re-derives both halves from the submitted base -- whichever
        // half was addressed. The base is stripped first so a client sending
        // either the bare name or a suffixed one lands in the same place
        // instead of stacking a second suffix.
        if (
          nameChanged &&
          linkedAccount &&
          account.accountSubType &&
          linkedAccount.accountSubType
        ) {
          const baseName = stripPairSuffix(account.name);
          account.name = pairHalfName(baseName, account.accountSubType);
          linkedAccount.name = pairHalfName(
            baseName,
            linkedAccount.accountSubType,
          );
          linkedChanged = true;
        }

        const saved = await m.save(account);
        if (interestRelink) {
          await applyLoanInterestRelink(m, interestRelink);
        }
        if (sourceAccountChanged) {
          await reassignLoanSourceAccount(
            m,
            userId,
            saved,
            before.sourceAccountId,
            saved.sourceAccountId!,
          );
        }
        // A changed method leaves the template at the previous rule's
        // installment; reprice it in this transaction, after the account row
        // it reads (spec section 5.6).
        if (repriceTemplate && saved.scheduledTransactionId) {
          await this.scheduledTransactionsService.repriceLoanTemplate(
            saved.scheduledTransactionId,
          );
        }

        if (linkedAccount) {
          if (updateAccountDto.currencyCode !== undefined) {
            linkedAccount.currencyCode = updateAccountDto.currencyCode;
            linkedChanged = true;
          }
          if (updateAccountDto.institutionId !== undefined) {
            linkedAccount.institutionId = updateAccountDto.institutionId;
            linkedChanged = true;
          }
          if (linkedChanged) {
            // The changed columns only. The other half was read without a lock,
            // and `save` writes every column that differs from a fresh read --
            // its snapshot `current_balance` among them, so a posting that
            // landed in between was erased: cash half 1,010.00 back to 1,000.00
            // beside a 1,010.00 ledger (A26-M13).
            await m.update(Account, linkedAccount.id, {
              name: linkedAccount.name,
              currencyCode: linkedAccount.currencyCode,
              institutionId: linkedAccount.institutionId,
            });
          }
        }

        return { savedAccount: saved, beforeData: before };
      },
    );

    this.actionHistoryService.record(userId, {
      entityType: "account",
      entityId: id,
      action: "update",
      beforeData,
      afterData: { ...savedAccount },
      description: `Updated account "${savedAccount.name}"`,
      descriptionKey: "updatedAccount",
      descriptionParams: { name: savedAccount.name },
    });

    // Trigger net worth recalculation if balance-affecting fields changed
    const needsRecalc =
      updateAccountDto.openingBalance !== undefined ||
      updateAccountDto.dateAcquired !== undefined;
    if (needsRecalc) {
      this.netWorthService
        .recalculateAccount(userId, id)
        .catch((err) =>
          this.logger.warn(
            `Net worth recalc failed for account ${id}: ${err.message}`,
          ),
        );
    }

    return savedAccount;
  }

  /** Refuses the delete of an account that holds any ledger row. */
  private async assertAccountEmpty(
    m: EntityManager,
    accountId: string,
  ): Promise<void> {
    const transactionCount = await m.getRepository(Transaction).count({
      where: { accountId },
    });
    if (transactionCount > 0) {
      throw new BadRequestException(
        tr(
          "errors.accounts.deleteWithTransactions",
          `Cannot delete account with ${transactionCount} transaction(s). Close the account instead.`,
          { transactionCount },
        ),
      );
    }

    // includes VOID rows: records read -- a VOID row is still a row the
    // delete would destroy.
    const investmentTransactionCount = await m
      .getRepository(InvestmentTransaction)
      .count({ where: { accountId } });
    if (investmentTransactionCount > 0) {
      throw new BadRequestException(
        tr(
          "errors.accounts.deleteWithInvestmentTransactions",
          `Cannot delete account with ${investmentTransactionCount} investment transaction(s). Close the account instead.`,
          { investmentTransactionCount },
        ),
      );
    }
  }

  /**
   * The other half of a linked investment pair, locked for update.
   *
   * A pair is one account to the user, so closing or reopening either half has
   * to decide for both -- and every check that can refuse must see both halves
   * before anything is written.
   */
  private async findLinkedInvestmentHalf(
    m: EntityManager,
    userId: string,
    account: Account,
  ): Promise<Account | null> {
    if (
      account.accountType !== AccountType.INVESTMENT ||
      !account.linkedAccountId
    ) {
      return null;
    }
    return m.findOne(Account, {
      where: { id: account.linkedAccountId, userId },
      lock: { mode: "pessimistic_write" },
    });
  }

  /**
   * Close an account (soft delete). A linked investment pair closes together
   * from either half.
   */
  async close(userId: string, id: string): Promise<Account> {
    // M19: Use pessimistic_write lock to prevent race condition
    // between balance check and close
    return withScopedDb(this.dataSource, async (m) => {
      const account = await m.findOne(Account, {
        where: { id, userId },
        lock: { mode: "pessimistic_write" },
      });

      if (!account) {
        throw new NotFoundException(
          tr(
            "errors.accounts.accountWithIdNotFound",
            `Account with ID ${id} not found`,
            { id },
          ),
        );
      }

      if (account.isClosed) {
        throw new BadRequestException(
          tr("errors.accounts.alreadyClosed", "Account is already closed"),
        );
      }

      const linkedHalf = await this.findLinkedInvestmentHalf(
        m,
        userId,
        account,
      );
      // The pair closes as one, so both ledgers have to be empty -- checking
      // only the addressed half would let a brokerage close over a cash
      // balance the user still has.
      const halves = linkedHalf ? [account, linkedHalf] : [account];

      // Check if balance is not zero (under lock, so no race)
      for (const half of halves) {
        if (Number(half.currentBalance) !== 0) {
          throw new BadRequestException(
            tr(
              "errors.accounts.closeNonZeroBalance",
              `Cannot close account with non-zero balance. Current balance: ${half.currentBalance}`,
              { currentBalance: half.currentBalance },
            ),
          );
        }
      }

      // A row dated after today is not in `current_balance` yet, so "zero now"
      // is not "zero including what is already booked": an empty account with
      // a -25.00 row dated next week closed, and on that date the due-balance
      // pass moved the closed account to -25.00, a balance the user cannot
      // touch without reopening it (A26-M12). Checked under the row lock
      // above, over both halves of a pair; a VOID row moves nothing.
      const [pending]: { n: number }[] = await m.query(
        `SELECT count(*)::int AS n
           FROM transactions
          WHERE account_id = ANY($1)
            AND user_id = $2
            AND ${ledgerMovementPredicate("")}
            AND transaction_date > $3`,
        [halves.map((half) => half.id), userId, todayYMD()],
      );
      if (pending.n > 0) {
        throw new BadRequestException(
          tr(
            "errors.accounts.closeWithFutureTransactions",
            `Cannot close an account with future-dated transactions. It has ${pending.n} transaction(s) dated after today; delete or void them first.`,
            { count: pending.n },
          ),
        );
      }

      // A brokerage's `current_balance` is deliberately kept at 0 and its worth
      // lives in its holdings, so the balance check above says nothing about
      // whether it still holds securities. Without this, closing an account
      // full of positions succeeded silently.
      if (account.accountType === AccountType.INVESTMENT) {
        const openPositions = await m.count(Holding, {
          where: {
            accountId: In(halves.map((half) => half.id)),
            quantity: Not(0),
          },
        });
        if (openPositions > 0) {
          throw new BadRequestException(
            tr(
              "errors.accounts.closeWithHoldings",
              `Cannot close an investment account that still holds securities. It has ${openPositions} holding(s) with a non-zero quantity; sell or transfer them first.`,
              { holdingCount: openPositions },
            ),
          );
        }
      }

      const closedDate = new Date();
      account.isClosed = true;
      account.closedDate = closedDate;

      const saved = await m.save(account);

      // Either half of an investment pair closes the other.
      if (linkedHalf && !linkedHalf.isClosed) {
        linkedHalf.isClosed = true;
        linkedHalf.closedDate = closedDate;
        await m.save(linkedHalf);
      }

      return saved;
    });
  }

  /**
   * Reopen a closed account. A linked investment pair reopens together from
   * either half.
   */
  async reopen(userId: string, id: string): Promise<Account> {
    // Mirror close(): reopen the account and its linked half in a single
    // transaction so the pair cannot end up in mismatched states.
    return withScopedDb(this.dataSource, async (m) => {
      const account = await m.findOne(Account, {
        where: { id, userId },
      });

      if (!account) {
        throw new NotFoundException(
          tr(
            "errors.accounts.accountWithIdNotFound",
            `Account with ID ${id} not found`,
            { id },
          ),
        );
      }

      if (!account.isClosed) {
        throw new BadRequestException(
          tr("errors.accounts.notClosed", "Account is not closed"),
        );
      }

      account.isClosed = false;
      account.closedDate = null;

      const saved = await m.save(account);

      // Either half of an investment pair reopens the other.
      const linkedHalf = await this.findLinkedInvestmentHalf(
        m,
        userId,
        account,
      );
      if (linkedHalf && linkedHalf.isClosed) {
        linkedHalf.isClosed = false;
        linkedHalf.closedDate = null;
        await m.save(linkedHalf);
      }

      return saved;
    });
  }

  /**
   * Get the current balance of an account
   */
  async getBalance(userId: string, id: string): Promise<{ balance: number }> {
    const account = await this.findOne(userId, id);
    return { balance: account.currentBalance };
  }

  /**
   * Update account balance (called internally by transactions).
   *
   * The arithmetic is done by PostgreSQL, so two concurrent deltas compose: the
   * `UPDATE` re-reads `current_balance` after it wins the row lock. Two things
   * make that guarantee real rather than nominal:
   *
   * - `is_closed = false` is a predicate of the **write**, not of a read that
   *   preceded it. A separate check-then-update let a mutation of an existing
   *   transaction read the account as open, wait behind `close()`, and then add
   *   its delta to a row that had since been closed with a zero balance -- a
   *   closed account holding `-10.00` (audit P4-008). Re-evaluating the
   *   predicate after the lock is what refuses instead.
   * - the refusal has to reach the caller, which is why this returns 0 rows into
   *   a throw rather than reporting success. The ledger mutation shares this
   *   transaction, so the throw rolls it back too.
   */
  async updateBalance(accountId: string, amount: number): Promise<Account> {
    // One statement: lock, re-check `is_closed`, apply the delta, report back.
    return withScopedDb(this.dataSource, async (m) => {
      const affected = await applyAccountBalanceDelta(m, accountId, amount, {
        openOnly: true,
      });
      if (affected === 0) {
        // No row matched: either the account is gone or it is closed. Tell those
        // apart so the caller gets 404 vs 400 rather than one ambiguous error.
        const exists = await m.getRepository(Account).findOne({
          where: { id: accountId },
        });
        if (!exists) {
          throw new NotFoundException(
            tr(
              "errors.accounts.accountWithIdNotFound",
              `Account with ID ${accountId} not found`,
              { id: accountId },
            ),
          );
        }
        throw new BadRequestException(
          tr(
            "errors.accounts.modifyBalanceClosed",
            "Cannot modify balance of a closed account",
          ),
        );
      }
      return m.getRepository(Account).findOneOrFail({
        where: { id: accountId },
      });
    });
  }

  /**
   * Advance an account's `updated_at` without touching its balance.
   *
   * `NetWorthService.sweepStaleSnapshots` derives snapshot staleness from
   * `accounts.updated_at > MAX(monthly_account_balances.updated_at)`, which only
   * works because every write that can change a snapshot also touches the account
   * row. One transaction edit breaks that on its own: moving a past-dated row to
   * another past month leaves `current_balance` identical (the running total is
   * unchanged) yet changes the intervening months' `monthly_account_balances`. No
   * balance write runs, so nothing bumps `updated_at`, and if the in-memory
   * debounce is lost the sweep can never find the stale snapshot (audit
   * DR-04-03). This keeps the invariant true for that one case: a snapshot-only
   * change still advances the account's timestamp.
   *
   * Owner-scoped and a no-op on a missing row -- it only advances a timestamp, so
   * there is nothing to refuse and no balance to protect with a lock.
   */
  async touchAccount(userId: string, accountId: string): Promise<void> {
    await withScopedDb(this.dataSource, (m) =>
      m.query(
        `UPDATE accounts SET updated_at = now() WHERE id = $1 AND user_id = $2`,
        [accountId, userId],
      ),
    );
  }

  /**
   * Recalculate currentBalance from source-of-truth transactions,
   * only including transactions dated on or before today.
   * Used when future-dated transactions are created/modified/deleted
   * to ensure the balance is always correct regardless of history.
   *
   * This writes an **absolute** balance, which is the protocol that cannot race
   * an atomic delta unaided: under `READ COMMITTED` the ledger `SELECT` and the
   * account `UPDATE` are separate statement snapshots, so a delta committing
   * between them was silently overwritten by a total that never saw it (audit
   * P4-005). `lockAccountsForBalanceWrite` closes that window from the front --
   * see the protocol note in `common/db/locks.ts` for why locking before the
   * ledger read makes the two protocols compose.
   *
   * The write is a targeted `UPDATE` of one column. Saving the `Account` entity
   * loaded before the transaction would also write back every other column from
   * that snapshot, so a concurrent rename or opening-balance edit would be
   * reverted by a balance recalculation.
   */
  async recalculateCurrentBalance(
    userId: string,
    accountId: string,
  ): Promise<Account> {
    const balanceSql = `SELECT COALESCE(a.opening_balance, 0) + COALESCE(SUM(t.amount), 0) as balance
       FROM accounts a
       LEFT JOIN transactions t ON t.account_id = a.id
         AND ${LEDGER_MOVEMENT_PREDICATE}
         AND t.transaction_date <= $2
      WHERE a.id = $1
      GROUP BY a.id, a.opening_balance`;

    const today = todayYMD();

    return withScopedDb(this.dataSource, async (m) => {
      // First statement of the transaction, before the ledger is read.
      await lockAccountsForBalanceWrite(m, [accountId], userId);

      const result: { balance: string }[] = await m.query(balanceSql, [
        accountId,
        today,
      ]);
      if (result.length === 0) {
        throw new NotFoundException(
          tr(
            "errors.accounts.accountWithIdNotFound",
            `Account with ID ${accountId} not found`,
            { id: accountId },
          ),
        );
      }

      const newBalance = roundMoney(Number(result[0].balance));
      await m.query(`UPDATE accounts SET current_balance = $1 WHERE id = $2`, [
        newBalance,
        accountId,
      ]);
      return m.getRepository(Account).findOneOrFail({
        where: { id: accountId },
      });
    });
  }

  /**
   * Projected balance: opening balance plus every non-void, non-child
   * transaction regardless of date. Derived live from raw transactions so
   * the result does not depend on the stored `account.currentBalance`
   * column, which can lag the TZ-aware "today" after a timezone change or
   * a future-dated create that ran under the old server-UTC logic.
   */
  async getProjectedBalance(
    userId: string,
    accountId: string,
  ): Promise<number> {
    const result: { balance: string }[] = await withScopedDb(
      this.dataSource,
      (m) =>
        m.query(
          `SELECT COALESCE(a.opening_balance, 0) + COALESCE(SUM(t.amount), 0) AS balance
         FROM accounts a
         LEFT JOIN transactions t ON t.account_id = a.id
           AND t.user_id = $2
           AND ${LEDGER_MOVEMENT_PREDICATE}
        WHERE a.id = $1 AND a.user_id = $2
        GROUP BY a.id, a.opening_balance`,
          [accountId, userId],
        ),
    );
    return roundMoney(Number(result?.[0]?.balance ?? 0));
  }

  /**
   * The latest month's assets, liabilities and net worth as totals only where
   * they are known (`NetWorthTotals`). Shared by `getSummary` and
   * `getLlmAccounts` so the two surfaces state the same figure.
   *
   * The monthly snapshot stores one converted figure per account and month, so
   * it cannot see an unpriced position or a gap between a security's currency
   * and its account's: those arrive as the per-account `AccountMarketValue`s of
   * the accounts that count towards net worth and are unioned in here.
   */
  private async latestNetWorthTotals(
    userId: string,
    accounts: Account[],
    marketValues: Map<string, AccountMarketValue>,
  ): Promise<NetWorthTotals> {
    const latest = await this.netWorthService.getLatestNetWorth(userId);
    // No snapshot at all means the user has no balance history to sum: a known
    // zero, which the market-value flags below can still qualify.
    const month = latest ?? {
      assets: 0,
      liabilities: 0,
      netWorth: 0,
      fxComplete: true,
      missingRatePairs: [],
      assetsFxComplete: true,
      liabilitiesFxComplete: true,
    };

    const pairs = new Set(month.missingRatePairs);
    const unpriced = new Map<string, string>();
    let pricesComplete = true;
    let accountsFxComplete = true;
    for (const account of accounts) {
      if (account.excludeFromNetWorth) continue;
      const value = marketValues.get(account.id);
      // Absent means the account holds no position: zero, not unknown.
      if (!value) continue;
      if (!value.pricesComplete) pricesComplete = false;
      if (!value.fxComplete) accountsFxComplete = false;
      for (const pair of value.missingRatePairs) pairs.add(pair);
      value.unpricedSecurityIds.forEach((id, i) =>
        unpriced.set(id, value.unpricedSymbols[i] ?? id),
      );
    }

    const assetsComplete =
      month.assetsFxComplete && accountsFxComplete && pricesComplete;
    const liabilitiesComplete = month.liabilitiesFxComplete;
    const fxComplete = month.fxComplete && accountsFxComplete;
    const knownAssetsSubtotal = roundMoney(month.assets);
    const knownLiabilitiesSubtotal = roundMoney(month.liabilities);
    const knownNetWorthSubtotal = roundMoney(month.netWorth);

    return {
      totalAssets: assetsComplete ? knownAssetsSubtotal : null,
      totalLiabilities: liabilitiesComplete ? knownLiabilitiesSubtotal : null,
      netWorth:
        assetsComplete && liabilitiesComplete ? knownNetWorthSubtotal : null,
      knownAssetsSubtotal,
      knownLiabilitiesSubtotal,
      knownNetWorthSubtotal,
      fxComplete,
      pricesComplete,
      valuationComplete: fxComplete && pricesComplete,
      missingRatePairs: [...pairs].sort(),
      unpricedSecurityIds: [...unpriced.keys()].sort(),
      unpricedSymbols: [...unpriced.values()].sort(),
    };
  }

  /**
   * Get account summary statistics for a user
   */
  async getSummary(
    userId: string,
  ): Promise<{ totalAccounts: number; totalBalance: number } & NetWorthTotals> {
    // Closed accounts are not counted or summed below, but their snapshots
    // still count towards net worth, so their positions qualify it too.
    const allAccounts = await this.findAll(userId, true);
    const accounts = allAccounts.filter((account) => !account.isClosed);

    // totalBalance is the raw book-balance sum across accounts. Assets,
    // liabilities and net worth are derived from the same canonical source as
    // the dashboard Net Worth widget and the `get_account_balances` tool
    // (the latest monthly net-worth snapshot) so every surface reports an
    // identical net worth. The previous naive currentBalance classification
    // here ignored brokerage market value and futureTransactionsSum, producing
    // a different number than the rest of the app.
    const totalBalance = sumMoney(
      accounts.map((account) => Number(account.currentBalance)),
    );

    const marketValues =
      await this.portfolioService.getAccountMarketValues(userId);
    const totals = await this.latestNetWorthTotals(
      userId,
      allAccounts,
      marketValues,
    );

    return {
      totalAccounts: accounts.length,
      totalBalance,
      ...totals,
    };
  }

  /**
   * Accounts shaped for LLM tools. Shared by the AI Assistant's `list_accounts`
   * tool and the MCP server's matching tool so both surfaces return the same
   * data. Supersedes the former `getLlmBalances` (and the old per-account
   * lookup tools): it returns full per-account details plus the assets /
   * liabilities / net-worth / count summary, with rich filtering.
   *
   * Filters (all optional, AND-combined):
   *   - status: "open" (default) | "closed" | "all"
   *   - accountTypes: restrict to specific AccountType values
   *   - accountNames: exact, case-insensitive name match
   *   - accountIds: exact account UUID match
   *   - nameQuery: case-insensitive substring match on the account name
   *
   * Per-account balance mirrors the Account List UI: brokerage accounts show
   * market value of holdings; every other account shows
   * currentBalance + futureTransactionsSum. The totals (totalAssets,
   * totalLiabilities, netWorth) stay GLOBAL -- derived from the latest net-worth
   * snapshot, the same source as the dashboard Net Worth widget -- so every
   * surface agrees regardless of the filters applied. totalAccounts is the
   * number of accounts returned AFTER filtering.
   *
   * The totals are `NetWorthTotals`: null unless complete, with the subtotal in
   * a `known*` field. A brokerage row's `balance` is null while one of its
   * positions is unpriced or unconverted. `missingRatePairs` is the union of
   * the per-row pairs and the totals' pairs.
   */
  @ReportingRead("cash")
  async getLlmAccounts(
    userId: string,
    opts?: {
      accountNames?: string[];
      accountIds?: string[];
      nameQuery?: string;
      status?: "open" | "closed" | "all";
      accountTypes?: AccountType[];
    },
  ): Promise<
    NetWorthTotals & {
      accounts: LlmAccountRow[];
      /**
       * The user's reporting currency: what the three totals and every
       * `*InDefaultCurrency` figure are denominated in.
       */
      defaultCurrency: string;
      totalAccounts: number;
    }
  > {
    const {
      accountNames,
      accountIds,
      nameQuery,
      status = "open",
      accountTypes,
    } = opts ?? {};

    // findAll(userId, true) returns every account; we then narrow by status
    // so "open" / "closed" / "all" all go through a single query path.
    const allAccounts = await this.findAll(userId, true);
    const marketValues =
      await this.portfolioService.getAccountMarketValues(userId);

    let accounts = allAccounts;
    if (status === "open") {
      accounts = accounts.filter((a) => !a.isClosed);
    } else if (status === "closed") {
      accounts = accounts.filter((a) => a.isClosed);
    }

    if (accountTypes && accountTypes.length > 0) {
      const typeSet = new Set(accountTypes);
      accounts = accounts.filter((a) => typeSet.has(a.accountType));
    }

    if (accountNames && accountNames.length > 0) {
      const lowerNames = new Set(accountNames.map((n) => n.toLowerCase()));
      accounts = accounts.filter((a) => lowerNames.has(a.name.toLowerCase()));
    }

    if (accountIds && accountIds.length > 0) {
      const idSet = new Set(accountIds);
      accounts = accounts.filter((a) => idSet.has(a.id));
    }

    if (nameQuery && nameQuery.trim().length > 0) {
      const needle = nameQuery.trim().toLowerCase();
      accounts = accounts.filter((a) => a.name.toLowerCase().includes(needle));
    }

    // Resolve institution names for the filtered set in a single batch query
    // rather than relying on a relation findAll does not load. Skip the query
    // entirely when none of the remaining accounts reference an institution.
    const institutionIds = Array.from(
      new Set(
        accounts.map((a) => a.institutionId).filter((id): id is string => !!id),
      ),
    );
    const institutionNameMap = new Map<string, string>();
    if (institutionIds.length > 0) {
      const institutions = await withScopedDb(this.dataSource, (m) =>
        m.getRepository(Institution).find({
          where: { id: In(institutionIds), userId },
          select: { id: true, name: true },
        }),
      );
      for (const inst of institutions) {
        institutionNameMap.set(inst.id, inst.name);
      }
    }

    // A foreign account's figure is shown in both its own currency and the
    // reader's, priced by the server: a model handed only the native figure
    // either leaves it unconverted beside a total in another currency or
    // converts it at a rate it invented. Today's rate through the same ladder
    // the upcoming-bills rollup uses, one lookup per currency pair.
    const defaultCurrency = await resolveUserDefaultCurrency(
      this.dataSource,
      userId,
    );
    const rateFor = memoizedRateResolver(
      this.exchangeRateService,
      defaultCurrency,
      todayYMD(),
    );
    const missingPairs = new Set<string>();
    const inDefaultCurrency = (
      amount: number,
      rate: number | null,
      currency: string,
    ): number | null => {
      // Zero is zero at any rate, so an empty foreign account never reports
      // itself as unconvertible.
      if (amount === 0) return 0;
      if (rate === null) {
        missingPairs.add(`${currency}->${defaultCurrency}`);
        return null;
      }
      return roundMoney(amount * rate);
    };

    // A brokerage's figure is its market value. An account absent from the map
    // holds no position, which is zero rather than an unpriced holding; one
    // present with a null `marketValue` is unknown, and its balance is null.
    const marketValueOf = (
      a: (typeof accounts)[number],
    ): AccountMarketValue | undefined =>
      a.accountSubType === AccountSubType.INVESTMENT_BROKERAGE
        ? marketValues.get(a.id)
        : undefined;
    const isBrokerage = (a: (typeof accounts)[number]): boolean =>
      a.accountSubType === AccountSubType.INVESTMENT_BROKERAGE;
    const ledgerBalance = (a: (typeof accounts)[number]): number =>
      roundMoney(
        Number(a.currentBalance) + Number(a.futureTransactionsSum ?? 0),
      );
    const balanceOf = (a: (typeof accounts)[number]): number | null => {
      if (!isBrokerage(a)) return ledgerBalance(a);
      const value = marketValueOf(a);
      if (!value) return 0;
      return value.marketValue === null ? null : roundMoney(value.marketValue);
    };
    const knownBalanceOf = (a: (typeof accounts)[number]): number => {
      if (!isBrokerage(a)) return ledgerBalance(a);
      return roundMoney(marketValueOf(a)?.knownMarketValueSubtotal ?? 0);
    };
    // LINEAR and INTEREST_ONLY mortgages carry a dated installment in place of
    // the payment they do not store (spec section 5.6). Only loan balances feed
    // it, and a loan is never a brokerage, so the known value is the balance.
    const installmentFacts = await derivedInstallmentFacts(
      this.dataSource,
      this.scheduledOccurrenceService,
      userId,
      accounts,
      new Map(accounts.map((a) => [a.id, -knownBalanceOf(a)])),
    );

    const accountList: LlmAccountRow[] = [];
    for (const a of accounts) {
      const balance = balanceOf(a);
      const knownBalanceSubtotal = knownBalanceOf(a);
      const currentBalance = roundMoney(Number(a.currentBalance));
      // Same currency is 1:1 by definition and asks the rate table nothing.
      const exchangeRate =
        a.currencyCode === defaultCurrency ? 1 : await rateFor(a.currencyCode);
      accountList.push({
        id: a.id,
        name: a.name,
        type: a.accountType,
        subType: a.accountSubType ?? null,
        balance,
        knownBalanceSubtotal,
        valuationComplete: marketValueOf(a)?.valuationComplete ?? true,
        currentBalance,
        creditLimit: a.creditLimit ?? null,
        interestRate: a.interestRate ?? null,
        currency: a.currencyCode,
        // An unknown balance has no converted figure either, and names no
        // pair: the gap is a missing price, not a missing rate.
        balanceInDefaultCurrency:
          balance === null
            ? null
            : inDefaultCurrency(balance, exchangeRate, a.currencyCode),
        currentBalanceInDefaultCurrency: inDefaultCurrency(
          currentBalance,
          exchangeRate,
          a.currencyCode,
        ),
        exchangeRate,
        isClosed: a.isClosed,
        excludeFromNetWorth: a.excludeFromNetWorth,
        institutionName: a.institutionId
          ? (institutionNameMap.get(a.institutionId) ?? null)
          : null,
        accountNumber: a.accountNumber ?? null,
        paymentAmount: a.paymentAmount ?? null,
        paymentFrequency: a.paymentFrequency ?? null,
        // The global pg DATE parser returns date columns as YYYY-MM-DD
        // strings; guard the type and trim any time component defensively.
        paymentStartDate: a.paymentStartDate
          ? String(a.paymentStartDate).slice(0, 10)
          : null,
        amortizationMonths: a.amortizationMonths ?? null,
        originalPrincipal: a.originalPrincipal ?? null,
        mortgageType:
          a.accountType === AccountType.MORTGAGE ? mortgageTypeOf(a) : null,
        prepaymentMode:
          a.accountType === AccountType.MORTGAGE &&
          mortgageTypeOf(a) === "LINEAR"
            ? prepaymentModeOf(a)
            : null,
        nextInstallment: installmentFacts.get(a.id)?.nextInstallment ?? null,
        bullet: installmentFacts.get(a.id)?.bullet ?? null,
      });
    }

    // The totals are global: every account counts, whatever the filters kept.
    const totals = await this.latestNetWorthTotals(
      userId,
      allAccounts,
      marketValues,
    );

    return {
      accounts: accountList,
      ...totals,
      defaultCurrency,
      missingRatePairs: [
        ...new Set([...missingPairs, ...totals.missingRatePairs]),
      ].sort(),
      totalAccounts: accountList.length,
    };
  }

  /**
   * Get transaction count for an account (regular and investment transactions)
   */
  async getTransactionCount(
    userId: string,
    accountId: string,
  ): Promise<{
    transactionCount: number;
    investmentTransactionCount: number;
    canDelete: boolean;
  }> {
    // Verify account belongs to user
    await this.findOne(userId, accountId);

    return withScopedDb(this.dataSource, async (m) => {
      const transactionCount = await m.getRepository(Transaction).count({
        where: { accountId },
      });

      // includes VOID rows: records read -- a VOID row is still a row the
      // delete would destroy.
      const investmentTransactionCount = await m
        .getRepository(InvestmentTransaction)
        .count({
          where: { accountId },
        });

      return {
        transactionCount,
        investmentTransactionCount,
        canDelete: transactionCount === 0 && investmentTransactionCount === 0,
      };
    });
  }

  /**
   * Permanently delete an account (only if it has no transactions)
   */
  async delete(userId: string, id: string): Promise<void> {
    const account = await this.findOne(userId, id);

    // Answered once up front, so a refusal comes before the loan schedule
    // below is removed; asked again, under the account lock, in the deleting
    // transaction itself.
    await withScopedDb(this.dataSource, (m) => this.assertAccountEmpty(m, id));

    // If this is a loan or mortgage account with an associated scheduled
    // transaction, delete it first. This runs in the scheduled-transactions
    // service's own transaction and is best-effort, so it stays outside the
    // account-deletion transaction below.
    if (
      (account.accountType === AccountType.LOAN ||
        account.accountType === AccountType.MORTGAGE) &&
      account.scheduledTransactionId
    ) {
      try {
        await this.scheduledTransactionsService.remove(
          userId,
          account.scheduledTransactionId,
        );
      } catch (error) {
        // Scheduled transaction may have already been deleted, continue with account deletion
        this.logger.warn(
          `Could not delete scheduled transaction ${account.scheduledTransactionId}: ${error.message}`,
        );
      }
    }

    const beforeData = { ...account };

    // Unlink the paired account and remove this account atomically, so a
    // failure cannot leave a dangling link pointing at a deleted account.
    await withScopedDb(this.dataSource, async (m) => {
      // The check above ran in another transaction, so a bank sync or import
      // that wrote into the account since was cascaded away with it, leaving
      // its transfer legs in other accounts one-sided (A26-M19). The account
      // row lock is the one every writer of its balance takes, and a row
      // insert's foreign-key lock conflicts with it, so after it no row can
      // land before the removal: a writer either committed (and the count
      // sees it) or waits for this delete.
      await lockAccountsForBalanceWrite(m, [id], userId);
      await this.assertAccountEmpty(m, id);

      if (account.linkedAccountId) {
        // One column, by a targeted update: a `save` of the unlocked read
        // wrote its snapshot balance back as well (A26-M13).
        await m.update(
          Account,
          { id: account.linkedAccountId, userId },
          { linkedAccountId: null },
        );
      }

      await m.remove(account);
    });

    this.actionHistoryService.record(userId, {
      entityType: "account",
      entityId: beforeData.id,
      action: "delete",
      beforeData,
      description: `Deleted account "${beforeData.name}"`,
      descriptionKey: "deletedAccount",
      descriptionParams: { name: beforeData.name },
    });
  }

  /**
   * Reset all brokerage account balances to 0 for a user.
   * Used when clearing investment data for re-import.
   */
  async resetBrokerageBalances(userId: string): Promise<number> {
    const result = await withScopedDb(this.dataSource, (m) =>
      m.getRepository(Account).update(
        {
          userId,
          accountType: AccountType.INVESTMENT,
          accountSubType: AccountSubType.INVESTMENT_BROKERAGE,
        },
        { currentBalance: 0 },
      ),
    );

    return result.affected ?? 0;
  }

  /**
   * Get daily running balances for one or more accounts over a date range.
   * Computes balance from opening_balance + cumulative transaction sums.
   */
  async getDailyBalances(
    userId: string,
    startDate?: string,
    endDate?: string,
    accountIds?: string[],
    allTime = false,
    jointAccountIds: string[] = [],
  ): Promise<
    Array<{
      date: string;
      balance: number;
      accountId: string;
      currencyCode: string;
    }>
  > {
    const accountIdsParam =
      accountIds && accountIds.length > 0 ? accountIds : null;
    // Joint accounts (already authorized by the controller): widen the
    // ownership predicate to include these exact ids. Empty for acting
    // context and non-delegates, which keeps the query byte-equivalent.
    const jointIdsParam = jointAccountIds;

    let end = endDate || todayYMD();

    // When no explicit endDate, extend to include future transactions. Skipped
    // in all-time mode, where the MIN/MAX probe below already yields the last
    // transaction date (future-dated ones included) and clamps `end` to it.
    if (!endDate && !allTime) {
      const maxDateResult = await withScopedDb(this.dataSource, (m) =>
        m.query(
          `SELECT MAX(t.transaction_date)::TEXT as max_date
         FROM transactions t
         JOIN accounts a ON a.id = t.account_id
         WHERE (a.user_id = $1 OR a.id = ANY($4::UUID[]))
           AND ($2::UUID[] IS NULL OR t.account_id = ANY($2::UUID[]))
           AND ${LEDGER_MOVEMENT_PREDICATE}
           AND t.transaction_date > $3`,
          [userId, accountIdsParam, end, jointIdsParam],
        ),
      );
      const maxFutureDate = maxDateResult?.[0]?.max_date;
      if (maxFutureDate && maxFutureDate > end) {
        end = maxFutureDate;
      }
    }

    const oneYearAgo = () => {
      const d = new Date();
      d.setFullYear(d.getFullYear() - 1);
      return formatDateYMD(d);
    };

    let start: string;
    if (startDate) {
      start = startDate;
    } else if (allTime) {
      // "All time" mirrors the transaction list's default (no start filter):
      // span the account's actual activity, from its earliest to its latest
      // transaction. Ending at the last transaction (rather than today) keeps a
      // closed or dormant account from trailing a long flat line to today; the
      // unbounded MAX still includes future-dated transactions, so projections
      // remain visible. Both fall back to the one-year default / today when the
      // account has no transactions yet.
      const range = await withScopedDb(this.dataSource, (m) =>
        m.query(
          `SELECT MIN(t.transaction_date)::TEXT as min_date,
                MAX(t.transaction_date)::TEXT as max_date
         FROM transactions t
         JOIN accounts a ON a.id = t.account_id
         WHERE (a.user_id = $1 OR a.id = ANY($3::UUID[]))
           AND ($2::UUID[] IS NULL OR t.account_id = ANY($2::UUID[]))
           AND ${LEDGER_MOVEMENT_PREDICATE}`,
          [userId, accountIdsParam, jointIdsParam],
        ),
      );
      start = range?.[0]?.min_date || oneYearAgo();
      const maxDate = range?.[0]?.max_date;
      if (!endDate && maxDate) {
        end = maxDate;
      }
    } else {
      start = oneYearAgo();
    }

    // Downsample wide ranges so the series stays light to transfer and render.
    // A running balance is a point-in-time value, so we thin by keeping every
    // Nth day (plus always the final/latest point) rather than averaging.
    // Ranges up to MAX_POINTS days (including a full year) keep every day, so
    // callers that rely on the one-year default are byte-identical.
    const MAX_POINTS = 400;
    const totalDays =
      Math.round(
        (new Date(`${end}T00:00:00Z`).getTime() -
          new Date(`${start}T00:00:00Z`).getTime()) /
          86_400_000,
      ) + 1;
    const step =
      totalDays <= MAX_POINTS ? 1 : Math.ceil(totalDays / MAX_POINTS);

    const rows: Array<{
      date: string;
      balance: string;
      account_id: string;
      currency_code: string;
    }> = await withScopedDb(this.dataSource, (m) =>
      m.query(
        `WITH target_accounts AS (
          SELECT id, opening_balance, currency_code
          FROM accounts
          WHERE (user_id = $1 OR id = ANY($6::UUID[]))
            AND ($2::UUID[] IS NULL OR id = ANY($2::UUID[]))
        ),
        pre_period AS (
          SELECT t.account_id,
                 SUM(t.amount) as total
          FROM transactions t
          JOIN target_accounts ta ON ta.id = t.account_id
          WHERE ${LEDGER_MOVEMENT_PREDICATE}
            AND t.transaction_date < $3
          GROUP BY t.account_id
        ),
        daily_tx AS (
          SELECT t.account_id,
                 t.transaction_date::DATE as tx_date,
                 SUM(t.amount) as total
          FROM transactions t
          JOIN target_accounts ta ON ta.id = t.account_id
          WHERE ${LEDGER_MOVEMENT_PREDICATE}
            AND t.transaction_date >= $3
            AND t.transaction_date <= $4
          GROUP BY t.account_id, t.transaction_date::DATE
        ),
        account_daily AS (
          SELECT d.dt::DATE as date,
                 ta.id as account_id,
                 ta.currency_code,
                 (ta.opening_balance + COALESCE(pp.total, 0) +
                   COALESCE(SUM(dtx.total) OVER (
                     PARTITION BY ta.id ORDER BY d.dt
                     ROWS UNBOUNDED PRECEDING
                   ), 0)
                 ) as balance
          FROM target_accounts ta
          CROSS JOIN generate_series($3::TIMESTAMP, $4::TIMESTAMP, '1 day') d(dt)
          LEFT JOIN pre_period pp ON pp.account_id = ta.id
          LEFT JOIN daily_tx dtx ON dtx.account_id = ta.id AND dtx.tx_date = d.dt::DATE
        ),
        numbered AS (
          SELECT date, balance, account_id, currency_code,
                 ROW_NUMBER() OVER (PARTITION BY account_id ORDER BY date) - 1 AS idx,
                 COUNT(*) OVER (PARTITION BY account_id) AS cnt
          FROM account_daily
        )
        -- Downsample: keep every $5th day (aligned across accounts, since all
        -- share the same date series) plus always the final/latest point and
        -- today. With future-dated transactions the final point is in the
        -- future, and a thinned-out today would leave callers reading
        -- "current" off an earlier sampled day.
        SELECT date::TEXT, balance::NUMERIC, account_id, currency_code
        FROM numbered
        WHERE $5::int <= 1 OR idx % $5::int = 0 OR idx = cnt - 1
           OR date = $7::DATE
        ORDER BY date, account_id`,
        [userId, accountIdsParam, start, end, step, jointIdsParam, todayYMD()],
      ),
    );

    return rows.map((r) => ({
      date: r.date,
      balance: Number(r.balance),
      accountId: r.account_id,
      currencyCode: r.currency_code,
    }));
  }

  /**
   * Hourly cron that rolls deferred balance effects into currentBalance as
   * transactions become due. "Due" is evaluated per-user in their local
   * timezone: an EDT user's midnight is 04:00 UTC, so we re-check every
   * hour and process each timezone as its local day rolls over.
   *
   * Running hourly (and re-applying if a user has already been processed
   * that day) is idempotent because recalculation derives currentBalance
   * from scratch against transaction_date <= local_today.
   */
  @Cron("0 * * * *")
  async applyDueTransactionBalances(): Promise<void> {
    // RLS (task C2): fully cross-user -- timezone-bucketed bulk reads and a
    // single multi-user UPDATE, with no per-user isolation body. The whole job
    // runs under a system context.
    return withSystemContext(() =>
      this.applyDueTransactionBalancesWithinContext(),
    );
  }

  private async applyDueTransactionBalancesWithinContext(): Promise<void> {
    try {
      const userIdsByTz = await getUsersByEffectiveTimezone(this.dataSource);
      if (userIdsByTz.size === 0) return;

      let totalApplied = 0;

      for (const [tz, userIds] of userIdsByTz) {
        const today = todayInTimezone(tz);
        if (!today) {
          this.logger.warn(
            `Skipping ${userIds.length} user(s) with invalid timezone "${tz}"`,
          );
          continue;
        }

        // One read-modify-write block per timezone bucket: find due accounts,
        // recompute their balances, apply them in a single UPDATE.
        //
        // The recomputation writes absolute balances, so it must hold the
        // account rows from before it reads the ledger -- otherwise an
        // interactive transaction committing between the SELECT and the UPDATE
        // is overwritten by a total that never saw it (audit P4-005). Locking
        // in ascending id order keeps it deadlock-free against a transfer
        // touching two of the same accounts.
        const applied = await withScopedDb(this.dataSource, async (m) => {
          const accountRows: { account_id: string }[] = await m.query(
            `SELECT DISTINCT t.account_id
               FROM transactions t
               JOIN accounts a ON a.id = t.account_id
               WHERE a.user_id = ANY($1)
                 AND t.transaction_date = $2
                 AND ${LEDGER_MOVEMENT_PREDICATE}`,
            [userIds, today],
          );

          if (accountRows.length === 0) return 0;

          const accountIds = accountRows.map((r) => r.account_id);
          await lockAccountsForBalanceWrite(m, accountIds);

          const balances: { account_id: string; balance: string }[] =
            await m.query(
              `SELECT a.id as account_id,
                    COALESCE(a.opening_balance, 0) + COALESCE(SUM(t.amount), 0) as balance
               FROM accounts a
               LEFT JOIN transactions t ON t.account_id = a.id
                 AND ${LEDGER_MOVEMENT_PREDICATE}
                 AND t.transaction_date <= $2
               WHERE a.id = ANY($1)
               GROUP BY a.id, a.opening_balance`,
              [accountIds, today],
            );

          if (balances.length > 0) {
            // Apply all recomputed balances in a single statement instead of
            // one UPDATE per account.
            const valuesClause = balances
              .map((_, i) => `($${i * 2 + 1}::uuid, $${i * 2 + 2}::numeric)`)
              .join(", ");
            const params = balances.flatMap((row) => [
              row.account_id,
              roundMoney(Number(row.balance)),
            ]);
            await m.query(
              `UPDATE accounts SET current_balance = v.balance
               FROM (VALUES ${valuesClause}) AS v(id, balance)
               WHERE accounts.id = v.id`,
              params,
            );
          }

          return balances.length;
        });

        totalApplied += applied;
      }

      if (totalApplied > 0) {
        this.logger.log(
          `Applied deferred balances for ${totalApplied} account(s)`,
        );
      }
    } catch (error) {
      this.logger.error(
        `Failed to apply deferred transaction balances: ${(error as Error).message}`,
      );
    }
  }

  async reorderFavourites(userId: string, accountIds: string[]): Promise<void> {
    // Defensive: reject anything that isn't a proper array. An attacker could
    // submit {length: 1e100} and force an unbounded loop (CWE-834). The DTO
    // layer already validates this via @IsArray, but we re-check here so the
    // invariant is visible to static analysis.
    if (!Array.isArray(accountIds)) {
      throw new BadRequestException(
        tr(
          "errors.params.mustBeArray",
          'The value of "accountIds" must be an array',
          { param: "accountIds" },
        ),
      );
    }
    if (accountIds.length === 0) {
      return;
    }

    // Apply the new ordering in a single statement instead of one UPDATE per
    // account. favouriteSortOrder is the array index; ids are parameterized and
    // the user_id predicate keeps the update scoped to the caller's accounts.
    const valuesClause = accountIds
      .map((_, i) => `($${i + 1}::uuid, ${i})`)
      .join(", ");
    const userParam = `$${accountIds.length + 1}`;
    const sql = `UPDATE accounts SET favourite_sort_order = c.ord
       FROM (VALUES ${valuesClause}) AS c(id, ord)
       WHERE accounts.id = c.id AND accounts.user_id = ${userParam}`;
    await withScopedDb(this.dataSource, (m) =>
      m.query(sql, [...accountIds, userId]),
    );
  }
}

/**
 * Set an account's opening balance and move `current_balance` by exactly the
 * change, inside the caller's transaction.
 *
 * The opening balance is part of the balance, so a new one moves it by
 * `new - old`, both read under the balance-write lock, as one atomic delta.
 * The import path used to compute an absolute `current_balance` from an
 * account row read in an earlier transaction, rounded to 2dp: a posting that
 * committed in between was overwritten, and a file's 100.1234 was stored as
 * 100.12 (A26-M13). The import calls this; it lives here because this file is
 * the sanctioned writer of `current_balance`.
 */
export async function applyOpeningBalanceChange(
  m: EntityManager,
  userId: string,
  accountId: string,
  openingBalance: number,
): Promise<void> {
  await lockAccountsForBalanceWrite(m, [accountId], userId);
  const rows: { opening_balance: string | null }[] = await m.query(
    `SELECT opening_balance FROM accounts WHERE id = $1 AND user_id = $2`,
    [accountId, userId],
  );
  if (rows.length === 0) return;
  const newOpening = roundMoney(openingBalance);
  const delta = roundMoney(newOpening - Number(rows[0].opening_balance ?? 0));
  await m.query(
    `UPDATE accounts
        SET opening_balance = $3,
            current_balance = ROUND(CAST(current_balance AS numeric) + $4, 4)
      WHERE id = $1 AND user_id = $2`,
    [accountId, userId, newOpening, delta],
  );
}
