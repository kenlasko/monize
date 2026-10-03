import {
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  forwardRef,
} from "@nestjs/common";
import { DataSource, In } from "typeorm";
import { withScopedDb } from "../../common/db/scoped-db";
import { withUserContext } from "../../common/db/with-context";
import { Account } from "../../accounts/entities/account.entity";
import { Holding } from "../../securities/entities/holding.entity";
import { HoldingsService } from "../../securities/holdings.service";
import { UserPreference } from "../../users/entities/user-preference.entity";
import { UsersService } from "../../users/users.service";
import { CurrenciesService } from "../../currencies/currencies.service";
import { roundMoney, roundToDecimals } from "../../common/round.util";
import { tr } from "../../i18n/translate";
import { ImportPostProcessingService } from "../import-post-processing.service";
import { TransactionRulesApplierService } from "../../transaction-rules/transaction-rules-applier.service";
import { ImportJob } from "./entities/import-job.entity";
import { MnyStagedFileMissingError } from "./mny-errors";
import {
  JOB_FAILED_ERROR_KEY,
  JobRunContext,
  MnyImportJobService,
  importAlreadyRunningException,
} from "./mny-import-job.service";
import { MnyParsedFile, MnyParserService } from "./mny-parser.service";
import { MnyStagingService } from "./mny-staging.service";
import {
  MnyAccountVerification,
  MnyHoldingVerification,
  MnyImportResult,
  balanceMatches,
  quantityMatches,
} from "./model/mny-import-job";
import {
  MnyImportOptions,
  resolveImportOptions,
} from "./model/mny-import-options";
import {
  MnyWarning,
  summarizeWarnings,
  warningLookup,
} from "./model/mny-warnings";
import {
  applyDeferredClosures,
  writeAccounts,
  writeCategories,
  writePayees,
} from "./writers/write-reference";
import {
  writeAccountBalances,
  writeTransactions,
} from "./writers/write-transactions";
import { writeInvestments, writeSecurities } from "./writers/write-investments";
import { applyImportRules } from "./writers/apply-import-rules";
import { writeBills } from "./writers/write-bills";
import { throttleProgress } from "./writers/progress-throttle";
import { writeLoans } from "./writers/write-loans";
import { selectedBills } from "./map/map-bills";
import {
  writeExchangeRates,
  writeSecurityPrices,
} from "./writers/write-prices";
import { preferredCurrency } from "../../common/default-currency.util";

/**
 * Runs a `.mny` import: staged bytes in, Monize rows and a verification report
 * out.
 *
 * The whole **write** is one transaction, so a failure *before it commits*
 * leaves nothing behind. What that transaction does not cover is everything
 * after it: post-processing, verification, staged-byte removal and the terminal
 * status write. A failure there leaves every imported row in place, and the row
 * used to advertise itself as retryable anyway -- so Retry inserted the file a
 * second time under fresh UUIDs, because the mapper generates new ids on every
 * parse and nothing on an imported row identifies its source record (audit
 * P4-002). `writeAll` therefore sets `import_jobs.data_committed` inside its own
 * transaction, and `MnyImportJobService.fail` will not call such a run
 * retryable.
 *
 * Progress still reaches the wizard mid-flight because the job service publishes
 * it on its own connection -- see `runOutsideActiveScopedManager`.
 *
 * The optional "start fresh" wipe happens in `start`, outside the job body, for
 * a security reason as much as an ordering one: `UsersService.deleteData`
 * re-authenticates, and its credentials must never be written into
 * `import_jobs.options`. It runs *after* the job row is inserted, though: the
 * row is this user's import lock, and a destructive operation performed before
 * the lock is held is one two concurrent requests can both perform. A wipe that
 * fails takes the row back out with it.
 */

/** `holdings.quantity` is `decimal(20,8)`. */
const HOLDING_DECIMALS = 8;

/** Credentials the existing delete-my-data operation requires. */
export interface WipeCredentials {
  readonly password?: string;
  readonly oidcIdToken?: string;
}

export interface StartImportInput {
  readonly stagedFileId: string;
  readonly options?: Partial<MnyImportOptions>;
  readonly wipeCredentials?: WipeCredentials;
}

@Injectable()
export class MnyImportService {
  private readonly logger = new Logger(MnyImportService.name);

  constructor(
    private dataSource: DataSource,
    private staging: MnyStagingService,
    private parser: MnyParserService,
    private jobs: MnyImportJobService,
    private postProcessing: ImportPostProcessingService,
    @Inject(forwardRef(() => UsersService))
    private usersService: UsersService,
    @Inject(forwardRef(() => CurrenciesService))
    private currencies: CurrenciesService,
    @Inject(forwardRef(() => HoldingsService))
    private holdings: HoldingsService,
    private rulesApplier: TransactionRulesApplierService,
  ) {}

  /**
   * In order: validate the staged file, acquire this user's single active-import
   * slot, then optionally re-authenticate and wipe, then start the background
   * worker. Returns the job row the wizard polls.
   *
   * The order is the safety property, not an implementation detail. The job row
   * is the lock, so it is taken before anything destructive; a summary that reads
   * "optionally wipes, creates the job" describes the race this method was
   * changed to close, and a maintainer following it would reopen it.
   */
  async start(userId: string, input: StartImportInput): Promise<ImportJob> {
    const staged = await this.staging.findInfo(userId, input.stagedFileId);
    if (!staged) {
      throw new NotFoundException(
        tr(
          "errors.import.mnyStagedFileMissing",
          "The uploaded Money file is no longer available. Please upload it again.",
        ),
      );
    }

    // Advisory: it saves a doomed INSERT and gives the same 409, but it cannot
    // decide anything -- two requests can both read false here. `jobs.create`
    // is what actually refuses, on the database's own unique index.
    if (await this.jobs.hasActiveJob(userId)) {
      throw importAlreadyRunningException();
    }

    const options = resolveImportOptions(input.options);

    // The job row is the lock, so it is taken *before* the destructive wipe:
    // with the wipe first, two concurrent starts could both pass the advisory
    // check and both delete the user's data before either row existed.
    const job = await this.jobs.create(userId, staged.id, options);

    // Still outside the job body, and never with the credentials in tow:
    // `deleteData` re-authenticates, so running it in the body would mean
    // writing the user's password into `import_jobs.options`, and a failed
    // re-authentication must fail the request rather than a background job.
    if (options.wipeExistingData) {
      try {
        await this.usersService.deleteData(
          userId,
          {
            password: input.wipeCredentials?.password,
            oidcIdToken: input.wipeCredentials?.oidcIdToken,
            deleteAccounts: true,
            deleteCategories: true,
            deletePayees: true,
          },
          // Its own re-authentication purpose: this wipe is confirmed in the import
          // wizard, not in Settings, so an artifact obtained for one must not drive
          // the other (P2-005).
          "import-wipe",
          // And its own initiator, which is not the same question.
          //
          // `deleteData` defaults to "user-request", which takes the maintenance
          // lease -- whose active-import check would see the pending job the
          // line above just created and refuse this wipe with a 409, so
          // `wipeExistingData` could never start. The import already holds the
          // exclusion this wipe needs: `MnyImportJobService.create` took
          // `LockScope.UserImport` and its job row is what refuses a concurrent
          // restore or delete-my-data. Taking the lease again here would be a
          // second claim on a slot this request already owns.
          "mny-import",
        );
      } catch (error) {
        // The request is refused, so the slot it took must go back. The stale
        // reap in `create` would clear it on the next start anyway, but only
        // after it has been stale for JOB_STALE_AFTER_MS -- and the user is
        // looking at the failed wipe now, so the retry is immediate.
        await this.jobs.discard(userId, job.id).catch(() => undefined);
        throw error;
      }
      this.logger.log(
        `Wiped existing data for user ${userId} before .mny import`,
      );
    }

    // Unawaited on purpose (design ADR-3): the request returns the job id and
    // the wizard polls. `withUserContext` keeps an identity for the async chain
    // once the request scope is gone.
    void withUserContext(userId, () =>
      this.jobs.runClaimed(userId, job.id, (context) =>
        this.runImport(userId, staged.id, options, context),
      ),
    ).catch(async (error) => {
      const detail = error instanceof Error ? error.message : String(error);
      this.logger.error(`Import job ${job.id} could not be started: ${detail}`);
      // `runClaimed` reports its own body's failures; reaching here means the
      // claim or the status write itself failed, which would otherwise leave the
      // row pending until something reaped it -- and the wizard would poll a row
      // that says `pending` for JOB_STALE_AFTER_MS first. Failing it now turns
      // that wait into an immediate, retryable error.
      await withUserContext(userId, () =>
        this.jobs.fail(job.id, JOB_FAILED_ERROR_KEY, detail, true),
      ).catch(() => undefined);
    });

    return job;
  }

  /**
   * The job body. Parses the staged bytes again rather than trusting a
   * serialized preview, so what is written is provably what the preview showed.
   */
  async runImport(
    userId: string,
    stagedFileId: string,
    options: MnyImportOptions,
    context: JobRunContext,
  ): Promise<MnyImportResult> {
    await context.reportProgress({
      phase: "preparing",
      processed: 0,
      total: 0,
    });

    // Stage timings and peak RSS, logged once at the end. Task M4.1's numbers
    // can only come from a real 200 MB file, which by definition never enters
    // the repository -- so the run that produces them has to report them itself.
    const startedAt = Date.now();
    let peakRss = process.memoryUsage().rss;
    const sampleRss = (): void => {
      peakRss = Math.max(peakRss, process.memoryUsage().rss);
    };

    const bytes = await this.staging.loadBytes(userId, stagedFileId);
    if (!bytes) {
      throw new MnyStagedFileMissingError(stagedFileId);
    }
    const sizeBytes = bytes.length;
    const loadedAt = Date.now();
    sampleRss();

    const parsed = this.parser.parse({
      buffer: bytes,
      options,
      // Staged bytes are stored decrypted, so the password is spent on the
      // parse request and never persisted. Decrypting them again would
      // re-encrypt them -- see `openDecryptedMnyFile`.
      alreadyDecrypted: true,
      userDefaultCurrency: await this.defaultCurrency(userId),
    });
    const parsedAt = Date.now();
    sampleRss();

    // Currencies are global reference data with their own idempotent creation
    // path, so they are ensured before the import transaction opens. Securities
    // and exchange rates reference currencies no account need touch, which is
    // why this list is not just the accounts'.
    for (const code of parsed.currencyCodes) {
      await this.currencies.ensureSystemCurrency(code);
    }

    const written = await this.writeAll(userId, parsed, context);
    const writtenAt = Date.now();
    sampleRss();

    await context.reportProgress({
      phase: "finalizing",
      processed: 0,
      total: 0,
    });
    await this.postProcessing.run(
      userId,
      parsed.investments.transactions.length > 0,
      new Set(written.affectedAccountIds),
    );

    await context.reportProgress({
      phase: "verifying",
      processed: 0,
      total: 0,
    });
    const verification = await this.verify(
      userId,
      parsed,
      written.accountIdByKey,
    );
    const holdings = await this.verifyHoldings(
      userId,
      parsed,
      written.accountIdByKey,
      written.securityIdByHandle,
    );

    // Delete-on-complete: the bytes have done their job, and they are the
    // largest thing this feature stores.
    await this.staging.remove(userId, stagedFileId);
    sampleRss();

    this.logTiming({
      sizeBytes,
      peakRss,
      load: loadedAt - startedAt,
      parse: parsedAt - loadedAt,
      write: writtenAt - parsedAt,
      finalize: Date.now() - writtenAt,
      total: Date.now() - startedAt,
      transactions: written.transactionsCreated,
      investments: written.investmentTransactionsCreated,
      prices: written.pricesImported,
    });

    const warnings: MnyWarning[] = [
      ...parsed.warnings,
      ...verification
        .filter((account) => !account.matches)
        .map((account) => ({
          code: "balanceMismatch" as const,
          subject: account.accountName,
          detail: `delta ${account.delta}`,
        })),
      // The mapper's own LOT check compares against its replay; this one
      // compares against what Monize actually ended up holding, which is the
      // number the user sees in their portfolio.
      ...holdings
        .filter((holding) => !holding.matches)
        .map((holding) => ({
          code: "holdingsMismatch" as const,
          subject: `${holding.accountName}: ${holding.symbol}`,
          detail: `imported ${holding.importedQuantity} vs lots ${holding.lotQuantity}`,
        })),
    ];

    return {
      accountsCreated: written.accountsCreated,
      payeesCreated: written.payeesCreated,
      categoriesCreated: written.categoriesCreated,
      transactionsCreated: written.transactionsCreated,
      splitsCreated: written.splitsCreated,
      transfersLinked: parsed.transactions.transfersLinked,
      securitiesCreated: written.securitiesCreated,
      investmentTransactionsCreated: written.investmentTransactionsCreated,
      pricesImported: written.pricesImported,
      exchangeRatesImported: written.exchangeRatesImported,
      billsCreated: written.billsCreated,
      skipped: {
        accounts: parsed.accounts.skipped,
        payees: parsed.payees.skipped,
        categories: parsed.categories.skipped,
        transactions: parsed.transactions.skipped + parsed.investments.skipped,
        bills: parsed.bills.skipped,
      },
      existingDataRemoved: options.wipeExistingData,
      verification,
      holdings,
      warnings: summarizeWarnings(
        warnings,
        warningLookup({
          accounts: parsed.accounts.accounts,
          payeeNameByHandle: parsed.payees.nameByHandle,
        }),
      ),
    };
  }

  /**
   * One line per import with where the time and the memory went.
   *
   * The acceptance numbers task M4.1 asks for -- 37,000 transactions and 68,000
   * prices inside three minutes, peak RSS under three times the file size --
   * can only be measured on a real Money Plus file, and such a file cannot be
   * committed. So the import reports its own: run one, read the log, record the
   * numbers. It is also the first thing to look at when a real import is slow,
   * because it says which phase to blame.
   */
  private logTiming(timing: {
    sizeBytes: number;
    peakRss: number;
    load: number;
    parse: number;
    write: number;
    finalize: number;
    total: number;
    transactions: number;
    investments: number;
    prices: number;
  }): void {
    const mib = (bytes: number): string => (bytes / (1024 * 1024)).toFixed(1);
    const ratio = (timing.peakRss / Math.max(timing.sizeBytes, 1)).toFixed(1);

    this.logger.log(
      `.mny import timing: ${mib(timing.sizeBytes)} MiB file, ` +
        `${timing.transactions} transactions, ${timing.investments} investment rows, ` +
        `${timing.prices} prices -- ` +
        `load ${timing.load} ms, parse ${timing.parse} ms, write ${timing.write} ms, ` +
        `finalize ${timing.finalize} ms, total ${timing.total} ms; ` +
        `peak rss ${mib(timing.peakRss)} MiB (${ratio}x file size)`,
    );
  }

  /** Everything that has to be atomic, in one transaction. */
  private async writeAll(
    userId: string,
    parsed: MnyParsedFile,
    context: JobRunContext,
  ): Promise<{
    accountIdByKey: ReadonlyMap<string, string>;
    securityIdByHandle: ReadonlyMap<number, string>;
    accountsCreated: number;
    categoriesCreated: number;
    payeesCreated: number;
    transactionsCreated: number;
    splitsCreated: number;
    securitiesCreated: number;
    investmentTransactionsCreated: number;
    billsCreated: number;
    pricesImported: number;
    exchangeRatesImported: number;
    affectedAccountIds: ReadonlySet<string>;
  }> {
    return withScopedDb(this.dataSource, async (manager) => {
      await context.reportProgress({
        phase: "reference",
        processed: 0,
        total: parsed.accounts.accounts.length,
      });

      const accounts = await writeAccounts(
        manager,
        userId,
        parsed.accounts.accounts,
      );
      const categories = await writeCategories(
        manager,
        userId,
        parsed.categories.categories,
      );
      const payees = await writePayees(manager, userId, parsed.payees.payees);

      await context.reportProgress({
        phase: "transactions",
        processed: 0,
        total: parsed.transactions.transactions.length,
      });

      const categoryIdByHandle = this.categoryIdsByHandle(
        parsed,
        categories.idByFullName,
      );
      const payeeIdByHandle = this.payeeIdsByHandle(parsed, payees.idByName);

      // Throttled, not per chunk: a chunk report is a whole extra transaction on
      // a second pool connection, and the wizard only polls every 1500 ms.
      const reportTransactions = throttleProgress(context.reportProgress);
      const transactions = await writeTransactions(manager, userId, {
        transactions: parsed.transactions.transactions,
        accountIdByKey: accounts.idByKey,
        categoryIdByHandle,
        payeeIdByHandle,
        payeeNameByHandle: parsed.payees.nameByHandle,
        onProgress: (processed, total) =>
          reportTransactions({ phase: "transactions", processed, total }),
      });

      // Transaction rules (design 6.3): one bulk pass over the regular rows just
      // inserted, in this transaction. Transfers and the cash rows a trade
      // adopts are not evaluated.
      const ruleResult = await applyImportRules(
        manager,
        this.rulesApplier,
        userId,
        {
          transactions: parsed.transactions.transactions,
          writtenTransactionIds: transactions.writtenTransactionIds,
          payeeNameByHandle: parsed.payees.nameByHandle,
          investmentCashTransactionIds: new Set(
            [...parsed.transactions.investmentCashSources.values()]
              .map((source) => source.transactionId)
              .filter((id): id is string => id !== null),
          ),
        },
      );

      await context.reportProgress({
        phase: "investments",
        processed: 0,
        total: parsed.investments.transactions.length,
      });

      const reportInvestments = throttleProgress(context.reportProgress);
      const securities = await writeSecurities(
        manager,
        userId,
        parsed.securities.securities,
      );
      const investments = await writeInvestments(manager, userId, {
        transactions: parsed.investments.transactions,
        accountIdByKey: accounts.idByKey,
        securityIdByHandle: securities.idByHandle,
        categoryIdByHandle,
        payeeIdByHandle,
        payeeNameByHandle: parsed.payees.nameByHandle,
        symbolByHandle: new Map(
          parsed.securities.securities.map((security) => [
            security.handle,
            security.symbol,
          ]),
        ),
        // A trade whose cash a banking row already records links to that row,
        // or to the split leg it is embedded in. Both are foreign keys, so the
        // writer is told which ids actually landed.
        writtenTransactionIds: transactions.writtenTransactionIds,
        writtenSplitIds: transactions.writtenSplitIds,
        onProgress: (processed, total) =>
          reportInvestments({ phase: "investments", processed, total }),
      });

      // Holdings come only from the canonical rebuild, never from an importer's
      // private fold -- that second opinion is what left PR #192 with negative
      // positions. It runs on this transaction's own manager, so the rebuild
      // commits or rolls back with the rest of the import.
      const brokerageIds = [...investments.brokerageAccountIds];
      if (brokerageIds.length > 0) {
        await this.holdings.rebuildAccountsFromTransactions(
          userId,
          brokerageIds,
          manager,
        );
      }

      // Only the wizard's selection is written: an unchecked bill must be
      // absent from the database, never created inactive.
      const billsToWrite = selectedBills(parsed.bills, parsed.options.bills);
      await context.reportProgress({
        phase: "bills",
        processed: 0,
        total: billsToWrite.length,
      });
      // Loan terms come from the payments and bills that just landed, so this
      // runs after both. Nothing it writes is required for the import to be
      // correct -- it configures the loan schedule and rate detection.
      const bills = await writeBills(manager, userId, {
        bills: billsToWrite,
        accountIdByKey: accounts.idByKey,
        payeeIdByHandle,
        payeeNameByHandle: parsed.payees.nameByHandle,
        categoryIdByHandle,
        securityIdByHandle: securities.idByHandle,
        linkedKeyByKey: new Map(
          parsed.accounts.accounts
            .filter((account) => account.linkedKey !== null)
            .map((account) => [account.key, account.linkedKey as string]),
        ),
      });

      await context.reportProgress({
        phase: "prices",
        processed: 0,
        total: parsed.options.importPrices
          ? parsed.fileCounts.securityPrices
          : 0,
      });

      // The biggest phase in a real file -- 68,000 rows in the maintainer's --
      // and so the one where an unthrottled report per chunk costs the most.
      const reportPrices = throttleProgress(context.reportProgress);
      const pricesImported = parsed.options.importPrices
        ? await writeSecurityPrices(
            manager,
            parsed.rawPrices,
            securities.idByHandle,
            (processed, total) =>
              reportPrices({ phase: "prices", processed, total }),
          )
        : 0;
      const exchangeRatesImported = parsed.options.importExchangeRates
        ? await writeExchangeRates(
            manager,
            parsed.rawExchangeRates,
            parsed.currencyByHandle,
          )
        : 0;

      await writeLoans(manager, userId, {
        loans: parsed.loans.loans,
        accountIdByKey: accounts.idByKey,
        categoryIdByHandle,
      });

      // One balance write from the file-computed totals; post-processing then
      // recomputes the same numbers from the rows as a cross-check.
      await writeAccountBalances(
        manager,
        new Map(
          [...parsed.expectedBalances]
            .map(([key, balance]): [string | undefined, number] => [
              accounts.idByKey.get(key),
              balance,
            ])
            .filter(
              (entry): entry is [string, number] => entry[0] !== undefined,
            ),
        ),
      );

      // Last, because a closed account rejects balance updates.
      await applyDeferredClosures(
        manager,
        userId,
        parsed.accounts.accounts,
        accounts.idByKey,
      );

      const result = {
        accountIdByKey: accounts.idByKey,
        securityIdByHandle: securities.idByHandle,
        accountsCreated: accounts.created,
        categoriesCreated: categories.created,
        payeesCreated: payees.created,
        transactionsCreated: transactions.transactionsCreated,
        splitsCreated: transactions.splitsCreated,
        securitiesCreated: securities.created,
        investmentTransactionsCreated:
          investments.investmentTransactionsCreated,
        billsCreated: bills.created,
        pricesImported,
        exchangeRatesImported,
        affectedAccountIds: new Set([
          ...transactions.affectedAccountIds,
          ...investments.affectedAccountIds,
          // Accounts a structural rule action credited: recomputed and
          // refreshed with the rest after the commit.
          ...ruleResult.affectedAccountIds,
        ]),
      };

      // Last statement before commit, and both halves of the fence in one
      // statement: it refuses unless this job is still `running` under *this*
      // attempt's token -- retired by the one-active-job migration on a database
      // that raced before the index existed, or reaped as stale, or handed to
      // another worker -- and otherwise records that these rows are real.
      //
      // Its refusal throws, which rolls every row above back. Checking anywhere
      // else, including in `complete()`, happens after these rows are already
      // committed, which is how a reaped worker could still double a user's
      // financial history. And because the checkpoint commits with the rows it
      // describes, a rollback leaves it false: past this point a stalled job
      // must not be offered Retry, because the ledger already holds this file.
      await this.jobs.markDataCommitted(
        manager,
        context.jobId,
        context.attemptToken,
      );

      return result;
    });
  }

  /** Money `hcat` -> Monize category id, through the mapper's full names. */
  private categoryIdsByHandle(
    parsed: MnyParsedFile,
    idByFullName: ReadonlyMap<string, string>,
  ): Map<number, string> {
    return new Map(
      [...parsed.categories.byHandle]
        .map(([handle, category]): [number, string | undefined] => [
          handle,
          idByFullName.get(category.fullName),
        ])
        .filter((entry): entry is [number, string] => entry[1] !== undefined),
    );
  }

  /** Money `hpay` -> Monize payee id, through the mapper's names. */
  private payeeIdsByHandle(
    parsed: MnyParsedFile,
    idByName: ReadonlyMap<string, string>,
  ): Map<number, string> {
    return new Map(
      [...parsed.payees.nameByHandle]
        .map(([handle, name]): [number, string | undefined] => [
          handle,
          idByName.get(name),
        ])
        .filter((entry): entry is [number, string] => entry[1] !== undefined),
    );
  }

  /**
   * Compares the balance each account ended up with against the balance computed
   * from the Money file. This is the trust-builder both PR #192 testers asked
   * for: 56 accounts is too many to reconcile by hand.
   */
  private async verify(
    userId: string,
    parsed: MnyParsedFile,
    accountIdByKey: ReadonlyMap<string, string>,
  ): Promise<MnyAccountVerification[]> {
    const ids = [...accountIdByKey.values()];
    if (ids.length === 0) {
      return [];
    }

    const rows = await withScopedDb(this.dataSource, (manager) =>
      manager.getRepository(Account).find({
        where: ids.map((id) => ({ id, userId })),
        select: ["id", "currentBalance"],
      }),
    );
    const balanceById = new Map(
      rows.map((row) => [row.id, Number(row.currentBalance)]),
    );

    return parsed.accounts.accounts.map((account) => {
      const accountId = accountIdByKey.get(account.key) ?? null;
      const expectedBalance = parsed.expectedBalances.get(account.key) ?? 0;
      const importedBalance =
        accountId === null ? 0 : (balanceById.get(accountId) ?? 0);
      const delta = roundMoney(importedBalance - expectedBalance);

      return {
        accountName: account.name,
        accountType: account.accountType,
        accountId,
        expectedBalance,
        importedBalance,
        delta,
        transactionCount: parsed.transactionCounts.get(account.key) ?? 0,
        matches: balanceMatches(delta),
      };
    });
  }

  /**
   * Compares what Monize now holds against Money's open tax lots.
   *
   * The mapper already cross-checked its own replay against the lots; this is
   * the reading that matters to the user, because it is what their portfolio
   * page will show. Both are reported so a disagreement points at the layer that
   * caused it: replay-versus-lots is a mapping problem, imported-versus-replay
   * is a write or holdings-fold problem.
   */
  private async verifyHoldings(
    userId: string,
    parsed: MnyParsedFile,
    accountIdByKey: ReadonlyMap<string, string>,
    securityIdByHandle: ReadonlyMap<number, string>,
  ): Promise<MnyHoldingVerification[]> {
    if (parsed.holdingChecks.length === 0) {
      return [];
    }

    const accountIds = [...accountIdByKey.values()];
    const rows = await withScopedDb(this.dataSource, (manager) =>
      manager.getRepository(Holding).find({
        where: { accountId: In(accountIds) },
        select: ["accountId", "securityId", "quantity"],
      }),
    );
    const quantityByKey = new Map(
      rows.map((row) => [
        `${row.accountId}|${row.securityId}`,
        Number(row.quantity),
      ]),
    );
    const nameByKey = new Map(
      parsed.accounts.accounts.map((account) => [account.key, account.name]),
    );

    return parsed.holdingChecks.map((check) => {
      const accountId = accountIdByKey.get(check.accountKey);
      const securityId = securityIdByHandle.get(check.securityHandle);
      const importedQuantity =
        accountId === undefined || securityId === undefined
          ? 0
          : (quantityByKey.get(`${accountId}|${securityId}`) ?? 0);
      const delta = roundToDecimals(
        importedQuantity - check.lotQuantity,
        HOLDING_DECIMALS,
      );

      return {
        accountName: nameByKey.get(check.accountKey) ?? check.accountKey,
        symbol: check.symbol,
        lotQuantity: check.lotQuantity,
        replayQuantity: check.replayQuantity,
        importedQuantity: roundToDecimals(importedQuantity, HOLDING_DECIMALS),
        delta,
        matches: quantityMatches(delta),
      };
    });
  }

  /** The user's preferred currency, used only when the file names none. */
  private async defaultCurrency(userId: string): Promise<string> {
    const preference = await withScopedDb(this.dataSource, (manager) =>
      manager.getRepository(UserPreference).findOne({ where: { userId } }),
    );
    return preferredCurrency(preference);
  }
}
