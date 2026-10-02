import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { DataSource } from "typeorm";
import { Account, AccountSubType } from "../accounts/entities/account.entity";
import { withScopedDb } from "../common/db/scoped-db";
import { tr } from "../i18n/translate";
import { matchBankAccounts } from "./bank-account-matcher";
import { BankSyncCredentialsService } from "./bank-sync-credentials.service";
import { describeSyncFailure, toBankSyncException } from "./bank-sync-errors";
import { BankSyncService } from "./bank-sync.service";
import type { BankSyncMatchResult } from "./bank-sync.types";
import { BankSyncAccount } from "./entities/bank-sync-account.entity";
import { BankSyncConnection } from "./entities/bank-sync-connection.entity";
import type { PsuContext } from "./providers/bank-sync-provider.interface";
import { BankSyncProviderRegistry } from "./providers/bank-sync-provider.registry";

/** The two things a match reads from the database, in one transaction. */
interface MatchInput {
  connection: BankSyncConnection;
  bankAccounts: BankSyncAccount[];
  accounts: Account[];
  linkedAccountIds: Set<string>;
}

/**
 * Matching a connection's bank accounts to the user's Monize accounts by account
 * number, and linking the unambiguous ones (docs/specs/bank-sync.md section 5a).
 *
 * **Reads before writes, the provider outside every transaction.** The bank
 * accounts and the candidate Monize accounts are read in one transaction; a bank
 * account stored before identifiers were kept has its details read from the
 * provider (no transaction open) and stored; the matcher runs over the result.
 *
 * **Each link is its own transaction, through `BankSyncService.linkAccount`.**
 * The ordinary link path re-checks ownership, closure, brokerage, currency and
 * "already linked" under the bank-account row's lock, so a candidate that went
 * stale since it was read is refused there; a refusal is logged and skipped, and
 * the others still link. Nothing here writes `account_id` itself.
 */
@Injectable()
export class BankSyncMatchService {
  private readonly logger = new Logger(BankSyncMatchService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly credentials: BankSyncCredentialsService,
    private readonly registry: BankSyncProviderRegistry,
    private readonly bankSync: BankSyncService,
  ) {}

  /**
   * Match and link. With `fetchMissing`, an unlinked bank account without an
   * identifier has its details read from the provider first (the "match on
   * request" action); without it, such an account is left out (the callback,
   * where the session already listed every identifier the bank gave).
   */
  async match(
    userId: string,
    connectionId: string,
    options: { fetchMissing: boolean; psu: PsuContext | null },
  ): Promise<BankSyncMatchResult> {
    let input = await this.load(userId, connectionId);
    if (options.fetchMissing) {
      const fetched = await this.fetchMissingDetails(
        userId,
        input,
        options.psu,
      );
      if (fetched > 0) input = await this.load(userId, connectionId);
    }

    const matches = matchBankAccounts(
      input.bankAccounts
        .filter((row) => row.accountId === null)
        .map((row) => ({
          id: row.id,
          accountIdentifier: row.accountIdentifier,
          currencyCode: row.currencyCode,
        })),
      input.accounts.map((account) => ({
        id: account.id,
        accountNumber: account.accountNumber,
        currencyCode: account.currencyCode,
        isClosed: account.isClosed,
        isInvestmentBrokerage:
          account.accountSubType === AccountSubType.INVESTMENT_BROKERAGE,
      })),
      input.linkedAccountIds,
    );

    const linked: BankSyncMatchResult["linked"] = [];
    for (const pair of matches.linked) {
      try {
        await this.bankSync.linkAccount(userId, pair.bankAccountId, {
          accountId: pair.accountId,
        });
        linked.push(pair);
      } catch (error) {
        this.logger.warn(
          `Bank account ${pair.bankAccountId} was not linked to its matching account: ${describeSyncFailure(error)}`,
        );
      }
    }
    return { linked, suggestions: matches.suggestions };
  }

  private async load(
    userId: string,
    connectionId: string,
  ): Promise<MatchInput> {
    return withScopedDb(this.dataSource, async (m) => {
      const connection = await m
        .getRepository(BankSyncConnection)
        .findOne({ where: { id: connectionId, userId } });
      if (!connection) {
        throw this.connectionNotFound(connectionId);
      }
      const bankAccounts = await m.getRepository(BankSyncAccount).find({
        where: { userId, connectionId },
        order: { createdAt: "ASC", id: "ASC" },
      });
      // Own accounts only: a joint account another owner shared is not the
      // caller's to link.
      const accounts = await m.getRepository(Account).find({
        where: { userId, isClosed: false },
        order: { createdAt: "ASC", id: "ASC" },
      });
      const linkedRows = await m.getRepository(BankSyncAccount).find({
        where: { userId },
        select: { accountId: true },
      });
      return {
        connection,
        bankAccounts,
        accounts,
        linkedAccountIds: new Set(
          linkedRows
            .map((row) => row.accountId)
            .filter((id): id is string => id !== null),
        ),
      };
    });
  }

  /**
   * Read and store the details of every unlinked bank account without an
   * identifier. Returns how many were stored. A provider failure on one account
   * is logged and the others go on; when none could be read, the first failure
   * is the answer, so an unavailable bank is not reported as "no match".
   */
  private async fetchMissingDetails(
    userId: string,
    input: MatchInput,
    psu: PsuContext | null,
  ): Promise<number> {
    const missing = input.bankAccounts.filter(
      (row) => row.accountId === null && row.accountIdentifier === null,
    );
    if (missing.length === 0) return 0;

    const { connection } = input;
    if (
      connection.status !== "active" ||
      (connection.validUntil !== null &&
        connection.validUntil.getTime() <= Date.now())
    ) {
      throw new ConflictException(
        tr(
          "errors.bankSync.connectionNotActive",
          `This bank connection is ${connection.status}. Renew or reconnect it before syncing.`,
          { status: connection.status },
        ),
      );
    }

    const credentials = await this.credentials.resolveCredentials(
      userId,
      connection.provider,
    );
    const provider = this.registry.getByName(connection.provider);
    let stored = 0;
    let firstFailure: unknown = null;
    for (const row of missing) {
      try {
        const details = await provider.fetchAccountDetails(
          credentials,
          row.externalAccountId,
          psu,
        );
        await withScopedDb(this.dataSource, async (m) => {
          await m.query(
            `UPDATE bank_sync_accounts
                SET account_identifier = COALESCE($3, account_identifier),
                    cash_account_type = COALESCE($4, cash_account_type),
                    currency_code = COALESCE(currency_code, $5)
              WHERE id = $1 AND user_id = $2`,
            [
              row.id,
              userId,
              details.accountIdentifier,
              details.cashAccountType,
              details.currencyCode,
            ],
          );
        });
        stored += 1;
      } catch (error) {
        firstFailure ??= error;
        this.logger.warn(
          `Details of bank account ${row.id} could not be read: ${describeSyncFailure(error)}`,
        );
      }
    }
    if (stored === 0 && firstFailure !== null) {
      throw toBankSyncException(firstFailure);
    }
    return stored;
  }

  private connectionNotFound(connectionId: string): NotFoundException {
    return new NotFoundException(
      tr(
        "errors.bankSync.connectionNotFound",
        `Bank connection with ID ${connectionId} not found`,
        { id: connectionId },
      ),
    );
  }
}
