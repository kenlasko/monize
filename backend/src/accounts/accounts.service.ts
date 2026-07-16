import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Inject,
  forwardRef,
  Logger,
} from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository, DataSource, QueryRunner, In } from "typeorm";
import {
  Account,
  AccountType,
  AccountSubType,
} from "./entities/account.entity";
import { Transaction } from "../transactions/entities/transaction.entity";
import { InvestmentTransaction } from "../securities/entities/investment-transaction.entity";
import { Institution } from "../institutions/entities/institution.entity";
import { CreateAccountDto } from "./dto/create-account.dto";
import { UpdateAccountDto } from "./dto/update-account.dto";
import { CategoriesService } from "../categories/categories.service";
import { ScheduledTransactionsService } from "../scheduled-transactions/scheduled-transactions.service";
import { NetWorthService } from "../net-worth/net-worth.service";
import { PortfolioService } from "../securities/portfolio.service";
import { LoanMortgageAccountService } from "./loan-mortgage-account.service";
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
  stripBrokerageSuffix,
} from "./account-name.util";
import { formatDateYMD, todayInTimezone, todayYMD } from "../common/date-utils";
import { getUsersByEffectiveTimezone } from "../common/users-by-timezone.util";
import { didYouMean } from "../common/name-suggestions.util";
import { ActionHistoryService } from "../action-history/action-history.service";

@Injectable()
export class AccountsService {
  private readonly logger = new Logger(AccountsService.name);

  constructor(
    @InjectRepository(Account)
    private accountsRepository: Repository<Account>,
    @InjectRepository(Transaction)
    private transactionRepository: Repository<Transaction>,
    @InjectRepository(InvestmentTransaction)
    private investmentTransactionRepository: Repository<InvestmentTransaction>,
    @InjectRepository(Institution)
    private institutionsRepository: Repository<Institution>,
    @Inject(forwardRef(() => CategoriesService))
    private categoriesService: CategoriesService,
    @Inject(forwardRef(() => ScheduledTransactionsService))
    private scheduledTransactionsService: ScheduledTransactionsService,
    @Inject(forwardRef(() => NetWorthService))
    private netWorthService: NetWorthService,
    @Inject(forwardRef(() => PortfolioService))
    private portfolioService: PortfolioService,
    private loanMortgageService: LoanMortgageAccountService,
    private dataSource: DataSource,
    private actionHistoryService: ActionHistoryService,
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
    const institution = await this.institutionsRepository.findOne({
      where: { id: institutionId, userId },
      select: { id: true },
    });
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
      ...accountData
    } = createAccountDto;

    await this.assertInstitutionOwned(userId, accountData.institutionId);

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

    // Strip credit card statement fields for non-credit-card accounts
    if (accountData.accountType !== AccountType.CREDIT_CARD) {
      delete accountData.statementDueDay;
      delete accountData.statementSettlementDay;
    }

    const account = this.accountsRepository.create({
      ...accountData,
      userId,
      openingBalance,
      currentBalance: openingBalance,
    });

    const saved = await this.accountsRepository.save(account);

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
    const { openingBalance = 0, name, ...accountData } = createAccountDto;

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      const repo = queryRunner.manager.getRepository(Account);

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

      await queryRunner.commitTransaction();

      return { cashAccount, brokerageAccount };
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
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
    const queryBuilder = this.accountsRepository
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

    const [txCounts, invTxCounts, futureSums, currentSums] = await Promise.all([
      this.transactionRepository
        .createQueryBuilder("t")
        .select("t.accountId", "accountId")
        .addSelect("COUNT(t.id)", "cnt")
        .where("t.accountId IN (:...accountIds)", { accountIds })
        .groupBy("t.accountId")
        .getRawMany(),
      this.investmentTransactionRepository
        .createQueryBuilder("it")
        .select("it.accountId", "accountId")
        .addSelect("COUNT(it.id)", "cnt")
        .where("it.accountId IN (:...accountIds)", { accountIds })
        .groupBy("it.accountId")
        .getRawMany(),
      this.dataSource.query(
        `SELECT t.account_id as "accountId",
                COALESCE(SUM(t.amount), 0) as "futureSum"
         FROM transactions t
         WHERE t.account_id = ANY($1)
           AND t.transaction_date > $2
           AND (t.status IS NULL OR t.status != 'VOID')
           AND t.parent_transaction_id IS NULL
         GROUP BY t.account_id`,
        [accountIds, today],
      ) as Promise<Array<{ accountId: string; futureSum: string }>>,
      // Compute currentBalance live rather than trusting the stored column.
      // The stored value can lag the TZ-aware definition of "today" (e.g.
      // after a timezone change, or after a future-dated create that ran
      // under the old server-UTC logic), and if it does, adding it to the
      // live futureTransactionsSum below would double-count any transactions
      // that wandered across the boundary.
      this.dataSource.query(
        `SELECT a.id as "accountId",
                COALESCE(a.opening_balance, 0) + COALESCE(SUM(t.amount), 0) as "currentBalance"
         FROM accounts a
         LEFT JOIN transactions t ON t.account_id = a.id
           AND (t.status IS NULL OR t.status != 'VOID')
           AND t.parent_transaction_id IS NULL
           AND t.transaction_date <= $2
         WHERE a.id = ANY($1)
         GROUP BY a.id, a.opening_balance`,
        [accountIds, today],
      ) as Promise<Array<{ accountId: string; currentBalance: string }>>,
    ]);

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
   * Find a single account by ID
   */
  async findOne(userId: string, id: string): Promise<Account> {
    const account = await this.accountsRepository.findOne({
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

    return account;
  }

  /**
   * Find multiple accounts by IDs for a user (batch lookup).
   * Silently skips IDs that don't belong to the user.
   */
  async findByIds(userId: string, ids: string[]): Promise<Account[]> {
    if (ids.length === 0) return [];
    return this.accountsRepository.find({
      where: { id: In(ids), userId },
    });
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
  ): Promise<Account> {
    await this.findOne(userId, createAccountDto.sourceAccountId!);
    return this.loanMortgageService.createLoanAccount(userId, createAccountDto);
  }

  async createMortgageAccount(
    userId: string,
    createAccountDto: CreateAccountDto,
  ): Promise<Account> {
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
    isCanadian: boolean,
    isVariableRate: boolean,
  ): MortgageAmortizationResult {
    return this.loanMortgageService.previewMortgageAmortization(
      mortgageAmount,
      interestRate,
      amortizationMonths,
      paymentFrequency,
      paymentStartDate,
      isCanadian,
      isVariableRate,
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
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      // Use pessimistic lock to prevent concurrent balance modifications
      const account = await queryRunner.manager.findOne(Account, {
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
          tr("errors.accounts.updateClosed", "Cannot update a closed account"),
        );
      }

      // Currency is locked once the account has transactions. Allowing it to
      // change after that would silently re-denominate existing balances.
      if (
        updateAccountDto.currencyCode !== undefined &&
        updateAccountDto.currencyCode !== account.currencyCode
      ) {
        const [transactionCount, investmentTransactionCount] =
          await Promise.all([
            queryRunner.manager.count(Transaction, {
              where: { accountId: id },
            }),
            queryRunner.manager.count(InvestmentTransaction, {
              where: { accountId: id },
            }),
          ]);

        if (transactionCount > 0 || investmentTransactionCount > 0) {
          throw new BadRequestException(
            tr(
              "errors.accounts.changeCurrencyWithTransactions",
              "Cannot change the currency of an account that has transactions.",
            ),
          );
        }
      }

      const beforeData = { ...account };

      // If openingBalance is being changed, we need to recalculate currentBalance
      // currentBalance = openingBalance + sum(all transaction amounts)
      if (
        updateAccountDto.openingBalance !== undefined &&
        updateAccountDto.openingBalance !== account.openingBalance
      ) {
        const oldOpeningBalance = Number(account.openingBalance) || 0;
        const newOpeningBalance = Number(updateAccountDto.openingBalance) || 0;
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
      if (updateAccountDto.isFavourite !== undefined)
        account.isFavourite = updateAccountDto.isFavourite;
      if (updateAccountDto.excludeFromNetWorth !== undefined)
        account.excludeFromNetWorth = updateAccountDto.excludeFromNetWorth;
      if (updateAccountDto.favouriteSortOrder !== undefined)
        account.favouriteSortOrder = updateAccountDto.favouriteSortOrder;
      // Credit card statement fields (only for credit card accounts)
      const effectiveType = updateAccountDto.accountType ?? account.accountType;
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
      if (updateAccountDto.sourceAccountId !== undefined)
        account.sourceAccountId = updateAccountDto.sourceAccountId;
      if (updateAccountDto.principalCategoryId !== undefined)
        account.principalCategoryId = updateAccountDto.principalCategoryId;
      if (updateAccountDto.interestCategoryId !== undefined)
        account.interestCategoryId = updateAccountDto.interestCategoryId;
      if (updateAccountDto.interestBookingMode !== undefined)
        account.interestBookingMode = updateAccountDto.interestBookingMode;
      if (updateAccountDto.overpaymentCategoryId !== undefined)
        account.overpaymentCategoryId = updateAccountDto.overpaymentCategoryId;
      if (updateAccountDto.overpaymentMemo !== undefined)
        account.overpaymentMemo = updateAccountDto.overpaymentMemo?.trim()
          ? updateAccountDto.overpaymentMemo.trim()
          : null;
      if (updateAccountDto.overpaymentPayeeId !== undefined)
        account.overpaymentPayeeId = updateAccountDto.overpaymentPayeeId;
      if (updateAccountDto.assetCategoryId !== undefined)
        account.assetCategoryId = updateAccountDto.assetCategoryId;
      if (updateAccountDto.dateAcquired !== undefined)
        account.dateAcquired = updateAccountDto.dateAcquired
          ? new Date(updateAccountDto.dateAcquired)
          : null;
      if (updateAccountDto.linkedLoanAccountId !== undefined)
        account.linkedLoanAccountId = updateAccountDto.linkedLoanAccountId;
      // Mortgage-specific fields
      if (updateAccountDto.isCanadianMortgage !== undefined)
        account.isCanadianMortgage = updateAccountDto.isCanadianMortgage;
      if (updateAccountDto.isVariableRate !== undefined)
        account.isVariableRate = updateAccountDto.isVariableRate;
      if (updateAccountDto.termMonths !== undefined) {
        account.termMonths = updateAccountDto.termMonths || null;
        // Recalculate termEndDate when termMonths changes
        if (updateAccountDto.termMonths > 0 && account.paymentStartDate) {
          const termEndDate = new Date(account.paymentStartDate);
          termEndDate.setMonth(
            termEndDate.getMonth() + updateAccountDto.termMonths,
          );
          account.termEndDate = termEndDate;
        } else {
          account.termEndDate = null;
        }
      }
      if (updateAccountDto.amortizationMonths !== undefined)
        account.amortizationMonths = updateAccountDto.amortizationMonths;

      const savedAccount = await queryRunner.manager.save(account);

      // Keep a linked investment pair (cash <-> brokerage) in sync. Both halves
      // represent one real-world account, so shared attributes -- currency and
      // institution -- propagate to the partner automatically.
      const currencyChanged = updateAccountDto.currencyCode !== undefined;
      const institutionChanged = updateAccountDto.institutionId !== undefined;
      if (
        (currencyChanged || institutionChanged) &&
        account.linkedAccountId &&
        account.accountType === AccountType.INVESTMENT
      ) {
        const linkedAccount = await queryRunner.manager.findOne(Account, {
          where: { id: account.linkedAccountId, userId },
        });
        if (linkedAccount) {
          if (updateAccountDto.currencyCode !== undefined) {
            linkedAccount.currencyCode = updateAccountDto.currencyCode;
          }
          if (updateAccountDto.institutionId !== undefined) {
            linkedAccount.institutionId = updateAccountDto.institutionId;
          }
          await queryRunner.manager.save(linkedAccount);
        }
      }

      await queryRunner.commitTransaction();

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
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  /**
   * Close an account (soft delete)
   */
  async close(userId: string, id: string): Promise<Account> {
    // M19: Use pessimistic_write lock to prevent race condition
    // between balance check and close
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      const account = await queryRunner.manager.findOne(Account, {
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

      // Check if balance is not zero (under lock, so no race)
      if (Number(account.currentBalance) !== 0) {
        throw new BadRequestException(
          tr(
            "errors.accounts.closeNonZeroBalance",
            `Cannot close account with non-zero balance. Current balance: ${account.currentBalance}`,
            { currentBalance: account.currentBalance },
          ),
        );
      }

      account.isClosed = true;
      account.closedDate = new Date();

      const saved = await queryRunner.manager.save(account);

      // If this is an investment cash account, also close the linked brokerage account
      if (
        account.accountSubType === AccountSubType.INVESTMENT_CASH &&
        account.linkedAccountId
      ) {
        const brokerageAccount = await queryRunner.manager.findOne(Account, {
          where: { id: account.linkedAccountId, userId },
        });
        if (brokerageAccount && !brokerageAccount.isClosed) {
          brokerageAccount.isClosed = true;
          brokerageAccount.closedDate = new Date();
          await queryRunner.manager.save(brokerageAccount);
        }
      }

      await queryRunner.commitTransaction();
      return saved;
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  /**
   * Reopen a closed account
   */
  async reopen(userId: string, id: string): Promise<Account> {
    // Mirror close(): reopen the account and any linked brokerage account in a
    // single transaction so the pair cannot end up in mismatched states.
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      const account = await queryRunner.manager.findOne(Account, {
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

      const saved = await queryRunner.manager.save(account);

      // If this is an investment cash account, also reopen the linked brokerage account
      if (
        account.accountSubType === AccountSubType.INVESTMENT_CASH &&
        account.linkedAccountId
      ) {
        const brokerageAccount = await queryRunner.manager.findOne(Account, {
          where: { id: account.linkedAccountId, userId },
        });
        if (brokerageAccount && brokerageAccount.isClosed) {
          brokerageAccount.isClosed = false;
          brokerageAccount.closedDate = null;
          await queryRunner.manager.save(brokerageAccount);
        }
      }

      await queryRunner.commitTransaction();
      return saved;
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
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
   * Uses atomic SQL UPDATE to prevent race conditions from concurrent requests.
   */
  async updateBalance(
    accountId: string,
    amount: number,
    queryRunner?: QueryRunner,
  ): Promise<Account> {
    const account = await this.accountsRepository.findOne({
      where: { id: accountId },
    });

    if (!account) {
      throw new NotFoundException(
        tr(
          "errors.accounts.accountWithIdNotFound",
          `Account with ID ${accountId} not found`,
          { id: accountId },
        ),
      );
    }

    if (account.isClosed) {
      throw new BadRequestException(
        tr(
          "errors.accounts.modifyBalanceClosed",
          "Cannot modify balance of a closed account",
        ),
      );
    }

    const sql = `UPDATE accounts SET current_balance = ROUND(CAST(current_balance AS numeric) + $1, 4) WHERE id = $2`;

    if (queryRunner) {
      await queryRunner.query(sql, [amount, accountId]);
      // M20: Re-query within transaction to return fresh balance
      const updated = await queryRunner.manager.findOneOrFail(Account, {
        where: { id: accountId },
      });
      return updated;
    }

    // Atomic update at the database level to avoid read-modify-write race conditions
    await this.accountsRepository.query(sql, [amount, accountId]);

    return this.accountsRepository.findOneOrFail({ where: { id: accountId } });
  }

  /**
   * Recalculate currentBalance from source-of-truth transactions,
   * only including transactions dated on or before today.
   * Used when future-dated transactions are created/modified/deleted
   * to ensure the balance is always correct regardless of history.
   */
  async recalculateCurrentBalance(
    accountId: string,
    queryRunner?: QueryRunner,
  ): Promise<Account> {
    const account = await this.accountsRepository.findOne({
      where: { id: accountId },
    });

    if (!account) {
      throw new NotFoundException(
        tr(
          "errors.accounts.accountWithIdNotFound",
          `Account with ID ${accountId} not found`,
          { id: accountId },
        ),
      );
    }

    const balanceSql = `SELECT COALESCE($2::NUMERIC, 0) + COALESCE(SUM(t.amount), 0) as balance
       FROM transactions t
       WHERE t.account_id = $1
         AND (t.status IS NULL OR t.status != 'VOID')
         AND t.parent_transaction_id IS NULL
         AND t.transaction_date <= $3`;

    const today = todayYMD();
    const result: { balance: string }[] = queryRunner
      ? await queryRunner.query(balanceSql, [
          accountId,
          account.openingBalance,
          today,
        ])
      : await this.dataSource.query(balanceSql, [
          accountId,
          account.openingBalance,
          today,
        ]);

    const newBalance =
      result.length > 0
        ? roundMoney(Number(result[0].balance))
        : roundMoney(Number(account.openingBalance));

    if (queryRunner) {
      await queryRunner.query(
        `UPDATE accounts SET current_balance = $1 WHERE id = $2`,
        [newBalance, accountId],
      );
      return { ...account, currentBalance: newBalance } as Account;
    }

    account.currentBalance = newBalance;
    return this.accountsRepository.save(account);
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
    const result: { balance: string }[] = await this.dataSource.query(
      `SELECT COALESCE(a.opening_balance, 0) + COALESCE(SUM(t.amount), 0) AS balance
         FROM accounts a
         LEFT JOIN transactions t ON t.account_id = a.id
           AND t.user_id = $2
           AND (t.status IS NULL OR t.status != 'VOID')
           AND t.parent_transaction_id IS NULL
        WHERE a.id = $1 AND a.user_id = $2
        GROUP BY a.id, a.opening_balance`,
      [accountId, userId],
    );
    return roundMoney(Number(result?.[0]?.balance ?? 0));
  }

  /**
   * Get account summary statistics for a user
   */
  async getSummary(userId: string): Promise<{
    totalAccounts: number;
    totalBalance: number;
    totalAssets: number;
    totalLiabilities: number;
    netWorth: number;
  }> {
    const accounts = await this.findAll(userId, false);

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

    const latest = await this.netWorthService.getLatestNetWorth(userId);

    return {
      totalAccounts: accounts.length,
      totalBalance,
      totalAssets: roundMoney(latest?.assets ?? 0),
      totalLiabilities: roundMoney(latest?.liabilities ?? 0),
      netWorth: roundMoney(latest?.netWorth ?? 0),
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
   */
  async getLlmAccounts(
    userId: string,
    opts?: {
      accountNames?: string[];
      accountIds?: string[];
      nameQuery?: string;
      status?: "open" | "closed" | "all";
      accountTypes?: AccountType[];
    },
  ): Promise<{
    accounts: Array<{
      id: string;
      name: string;
      type: AccountType;
      subType: string | null;
      balance: number;
      currentBalance: number;
      creditLimit: number | null;
      interestRate: number | null;
      currency: string;
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
    }>;
    totalAssets: number;
    totalLiabilities: number;
    netWorth: number;
    totalAccounts: number;
  }> {
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
      const institutions = await this.institutionsRepository.find({
        where: { id: In(institutionIds), userId },
        select: { id: true, name: true },
      });
      for (const inst of institutions) {
        institutionNameMap.set(inst.id, inst.name);
      }
    }

    const accountList = accounts.map((a) => {
      const balance =
        a.accountSubType === AccountSubType.INVESTMENT_BROKERAGE
          ? (marketValues.get(a.id) ?? 0)
          : Number(a.currentBalance) + Number(a.futureTransactionsSum ?? 0);
      return {
        id: a.id,
        name: a.name,
        type: a.accountType,
        subType: a.accountSubType ?? null,
        balance: roundMoney(balance),
        currentBalance: roundMoney(Number(a.currentBalance)),
        creditLimit: a.creditLimit ?? null,
        interestRate: a.interestRate ?? null,
        currency: a.currencyCode,
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
      };
    });

    const latest = await this.netWorthService.getLatestNetWorth(userId);

    return {
      accounts: accountList,
      totalAssets: roundMoney(latest?.assets ?? 0),
      totalLiabilities: roundMoney(latest?.liabilities ?? 0),
      netWorth: roundMoney(latest?.netWorth ?? 0),
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

    const transactionCount = await this.transactionRepository.count({
      where: { accountId },
    });

    const investmentTransactionCount =
      await this.investmentTransactionRepository.count({
        where: { accountId },
      });

    return {
      transactionCount,
      investmentTransactionCount,
      canDelete: transactionCount === 0 && investmentTransactionCount === 0,
    };
  }

  /**
   * Permanently delete an account (only if it has no transactions)
   */
  async delete(userId: string, id: string): Promise<void> {
    const account = await this.findOne(userId, id);

    // Check for regular transactions
    const transactionCount = await this.transactionRepository.count({
      where: { accountId: id },
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

    // Check for investment transactions
    const investmentTransactionCount =
      await this.investmentTransactionRepository.count({
        where: { accountId: id },
      });

    if (investmentTransactionCount > 0) {
      throw new BadRequestException(
        tr(
          "errors.accounts.deleteWithInvestmentTransactions",
          `Cannot delete account with ${investmentTransactionCount} investment transaction(s). Close the account instead.`,
          { investmentTransactionCount },
        ),
      );
    }

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
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();
    try {
      if (account.linkedAccountId) {
        const linkedAccount = await queryRunner.manager.findOne(Account, {
          where: { id: account.linkedAccountId },
        });
        if (linkedAccount) {
          linkedAccount.linkedAccountId = null;
          await queryRunner.manager.save(linkedAccount);
        }
      }

      await queryRunner.manager.remove(account);

      await queryRunner.commitTransaction();
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }

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
    const result = await this.accountsRepository.update(
      {
        userId,
        accountType: AccountType.INVESTMENT,
        accountSubType: AccountSubType.INVESTMENT_BROKERAGE,
      },
      { currentBalance: 0 },
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

    let end = endDate || todayYMD();

    // When no explicit endDate, extend to include future transactions
    if (!endDate) {
      const maxDateResult = await this.dataSource.query(
        `SELECT MAX(t.transaction_date)::TEXT as max_date
         FROM transactions t
         JOIN accounts a ON a.id = t.account_id
         WHERE a.user_id = $1
           AND ($2::UUID[] IS NULL OR t.account_id = ANY($2::UUID[]))
           AND (t.status IS NULL OR t.status != 'VOID')
           AND t.parent_transaction_id IS NULL
           AND t.transaction_date > $3`,
        [userId, accountIdsParam, end],
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
      // begin at the account's earliest transaction. Falls back to the
      // one-year default when the account has no transactions yet.
      const minDateResult = await this.dataSource.query(
        `SELECT MIN(t.transaction_date)::TEXT as min_date
         FROM transactions t
         JOIN accounts a ON a.id = t.account_id
         WHERE a.user_id = $1
           AND ($2::UUID[] IS NULL OR t.account_id = ANY($2::UUID[]))
           AND (t.status IS NULL OR t.status != 'VOID')
           AND t.parent_transaction_id IS NULL`,
        [userId, accountIdsParam],
      );
      start = minDateResult?.[0]?.min_date || oneYearAgo();
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
    }> = await this.dataSource.query(
      `WITH target_accounts AS (
          SELECT id, opening_balance, currency_code
          FROM accounts
          WHERE user_id = $1
            AND ($2::UUID[] IS NULL OR id = ANY($2::UUID[]))
        ),
        pre_period AS (
          SELECT t.account_id,
                 SUM(t.amount) as total
          FROM transactions t
          JOIN target_accounts ta ON ta.id = t.account_id
          WHERE (t.status IS NULL OR t.status != 'VOID')
            AND t.parent_transaction_id IS NULL
            AND t.transaction_date < $3
          GROUP BY t.account_id
        ),
        daily_tx AS (
          SELECT t.account_id,
                 t.transaction_date::DATE as tx_date,
                 SUM(t.amount) as total
          FROM transactions t
          JOIN target_accounts ta ON ta.id = t.account_id
          WHERE (t.status IS NULL OR t.status != 'VOID')
            AND t.parent_transaction_id IS NULL
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
        -- share the same date series) plus always the final/latest point.
        SELECT date::TEXT, balance::NUMERIC, account_id, currency_code
        FROM numbered
        WHERE $5::int <= 1 OR idx % $5::int = 0 OR idx = cnt - 1
        ORDER BY date, account_id`,
      [userId, accountIdsParam, start, end, step],
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

        const accountRows: { account_id: string }[] =
          await this.dataSource.query(
            `SELECT DISTINCT t.account_id
               FROM transactions t
               JOIN accounts a ON a.id = t.account_id
               WHERE a.user_id = ANY($1)
                 AND t.transaction_date = $2
                 AND (t.status IS NULL OR t.status != 'VOID')
                 AND t.parent_transaction_id IS NULL`,
            [userIds, today],
          );

        if (accountRows.length === 0) continue;

        const accountIds = accountRows.map((r) => r.account_id);
        const balances: { account_id: string; balance: string }[] =
          await this.dataSource.query(
            `SELECT a.id as account_id,
                    COALESCE(a.opening_balance, 0) + COALESCE(SUM(t.amount), 0) as balance
               FROM accounts a
               LEFT JOIN transactions t ON t.account_id = a.id
                 AND (t.status IS NULL OR t.status != 'VOID')
                 AND t.parent_transaction_id IS NULL
                 AND t.transaction_date <= $2
               WHERE a.id = ANY($1)
               GROUP BY a.id, a.opening_balance`,
            [accountIds, today],
          );

        if (balances.length > 0) {
          // Apply all recomputed balances in a single statement instead of one
          // UPDATE per account.
          const valuesClause = balances
            .map((_, i) => `($${i * 2 + 1}::uuid, $${i * 2 + 2}::numeric)`)
            .join(", ");
          const params = balances.flatMap((row) => [
            row.account_id,
            roundMoney(Number(row.balance)),
          ]);
          await this.dataSource.query(
            `UPDATE accounts SET current_balance = v.balance
               FROM (VALUES ${valuesClause}) AS v(id, balance)
               WHERE accounts.id = v.id`,
            params,
          );
        }

        totalApplied += balances.length;
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
          "errors.accounts.accountIdsMustBeArray",
          "accountIds must be an array",
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
    await this.accountsRepository.query(sql, [...accountIds, userId]);
  }
}
