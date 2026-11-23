import { simplefinRedactor } from "./simplefin-redact";
import { tr } from "../../../i18n/translate";
import { Injectable } from "@nestjs/common";
import { AsyncLocalStorage } from "node:async_hooks";
import { DataSource } from "typeorm";
import { hashToken } from "../../../auth/crypto.util";
import {
  withScopedDb,
  getActiveScopedManager,
} from "../../../common/db/scoped-db";
import { todayYMD } from "../../../common/date-utils";
import { FIAT_MONEY_DECIMALS, moneyUnits } from "../../../common/round.util";
import { syncWindow } from "../../bank-sync-window";
import { SimplefinRequestBudgetService } from "../../simplefin-request-budget.service";
import { BankSyncProviderError } from "../bank-sync-provider.errors";
import type {
  BankBalance,
  BankTransaction,
  SimplefinCredentials,
} from "../bank-sync-provider.interface";
import { SimplefinClient } from "./simplefin.client";
import { SimplefinTransportError } from "./simplefin.transport";
import { simplefinAccessRequest } from "./simplefin.urls";
import { simplefinWindows } from "./simplefin.windows";
import {
  mapSimplefinAccountSet,
  simplefinAccountBlocked,
} from "./simplefin.mapper";

interface AccountRead {
  currencyCode: string | null;
  transactions: BankTransaction[];
  balance: BankBalance | null;
  pending: number;
}
interface StoredRead extends AccountRead {
  blocked: boolean;
  balanceAt: number | null;
}
interface ReadScope {
  userId: string;
  window: { dateFrom: string; dateTo: string } | null;
  reads: Map<string, Promise<Map<string, StoredRead>>>;
}

/** The existing planner uses numbers; refuse values that lose a four-decimal unit. */
function fitsPlanner(amount: string): boolean {
  const unsigned = amount.replace(/^[+-]/, "");
  const [whole, fraction = ""] = unsigned.split(".");
  const canonical = BigInt(whole).toString() + "." + fraction.padEnd(4, "0");
  const value = Number(unsigned);
  return (
    Number.isSafeInteger(moneyUnits(value, FIAT_MONEY_DECIMALS)) &&
    value.toFixed(4) === canonical
  );
}

function invalid(): never {
  throw new BankSyncProviderError(
    "invalid_response",
    tr(
      "errors.bankSync.simplefinReadFailed",
      "SimpleFIN could not provide complete account data. Review the connection in SimpleFIN Bridge.",
    ),
  );
}

/** No OAuth/session methods: SimpleFIN's setup-token flow is deliberately separate. */
@Injectable()
export class SimplefinProvider {
  readonly name = "simplefin" as const;
  private readonly scope = new AsyncLocalStorage<ReadScope>();

  constructor(
    private readonly dataSource: DataSource,
    private readonly budget: SimplefinRequestBudgetService,
    private readonly client: SimplefinClient,
  ) {}

  /** A connection sync or daily user run shares one complete read across its eligible accounts. */
  async withReadContext<T>(
    userId: string,
    accountIds: readonly string[],
    run: () => Promise<T>,
  ): Promise<T> {
    if (getActiveScopedManager())
      throw new Error(
        "Plan SimpleFIN reads outside an active database transaction",
      );
    const current = this.scope.getStore();
    if (current) {
      if (current.userId !== userId)
        throw new Error("SimpleFIN read context owner changed");
      return run();
    }
    const rows = accountIds.length
      ? ((await withScopedDb(this.dataSource, (m) =>
          m.query(
            `SELECT TO_CHAR(a.sync_from_date, 'YYYY-MM-DD') AS sync_from_date, a.last_success_at
        FROM bank_sync_accounts a JOIN bank_sync_connections c ON c.id=a.connection_id
        WHERE a.user_id=$1 AND c.user_id=$1 AND a.id=ANY($2::uuid[])
          AND c.provider='simplefin' AND c.status='active' AND a.account_id IS NOT NULL
          AND a.last_success_at IS NOT NULL AND a.backfill_through IS NULL`,
            [userId, accountIds],
          ),
        )) as Array<{ sync_from_date: string | null; last_success_at: Date }>)
      : [];
    const today = todayYMD();
    let window: ReadScope["window"] = null;
    for (const row of rows) {
      const next = syncWindow(
        {
          syncFromDate: row.sync_from_date,
          lastSuccessAt: row.last_success_at,
        },
        today,
      );
      if (!window || next.dateFrom < window.dateFrom) window = next;
    }
    return this.scope.run(
      {
        userId,
        window:
          window && simplefinWindows(window.dateFrom, window.dateTo).length <= 2
            ? window
            : null,
        reads: new Map(),
      },
      run,
    );
  }

  async readAccount(
    userId: string,
    credentials: SimplefinCredentials,
    accountId: string,
    window: { dateFrom: string; dateTo: string },
  ): Promise<AccountRead> {
    if (getActiveScopedManager())
      throw new Error("Read SimpleFIN outside an active database transaction");
    const scope = this.scope.getStore();
    if (scope && scope.userId !== userId)
      throw new Error("SimpleFIN read context owner changed");
    const range =
      scope?.window &&
      scope.window.dateFrom <= window.dateFrom &&
      scope.window.dateTo >= window.dateTo
        ? scope.window
        : window;
    const key = JSON.stringify([
      credentials.credentialId,
      hashToken(credentials.accessUrl),
      range,
    ]);
    let read = scope?.reads.get(key);
    if (!read) {
      read = this.fetchComplete(userId, credentials, range);
      scope?.reads.set(key, read);
    }
    const accounts = await read;
    const account = accounts.get(accountId);
    if (!account || account.blocked || !account.currencyCode) invalid();
    return {
      currencyCode: account.currencyCode,
      transactions: account.transactions.filter(
        (row) =>
          (row.bookingDate === null && row.refusalReason !== undefined) ||
          (row.bookingDate !== null &&
            row.bookingDate >= window.dateFrom &&
            row.bookingDate <= window.dateTo),
      ),
      balance: account.balance,
      pending: account.pending,
    };
  }

  private async fetchComplete(
    userId: string,
    credentials: SimplefinCredentials,
    range: { dateFrom: string; dateTo: string },
  ): Promise<Map<string, StoredRead>> {
    const origin = simplefinAccessRequest(credentials.accessUrl).root.origin;
    const safeText = simplefinRedactor(credentials.accessUrl);
    const windows = simplefinWindows(range.dateFrom, range.dateTo);
    const result = new Map<string, StoredRead>();
    const seenRows = new Map<string, string>();
    const appearances = new Map<string, number>();
    let count = 0;
    // A failed later window rejects this promise before any account is handed
    // to the planner/writer. Reservations are durable and never refunded.
    if (windows.length > 24)
      throw new BankSyncProviderError(
        "rate_limited",
        tr(
          "errors.bankSync.simplefinQuotaExhausted",
          "SimpleFIN request quota exhausted. Wait for quota to replenish and retry the current batch.",
        ),
      );
    const reservation = await this.budget.reserve(
      userId,
      credentials.credentialId,
      windows.length,
    );
    if (!reservation.allowed)
      throw new BankSyncProviderError(
        "rate_limited",
        tr(
          "errors.bankSync.simplefinQuotaExhausted",
          "SimpleFIN request quota exhausted. Wait for quota to replenish and retry the current batch.",
        ),
      );
    for (const window of windows) {
      let payload: unknown;
      try {
        payload = await this.client.accounts(credentials.accessUrl, window);
      } catch (error) {
        const status =
          error instanceof SimplefinTransportError ? error.status : undefined;
        const kind =
          status === 401 || status === 403
            ? "bad_request"
            : status === 402
              ? "bad_request"
              : status === 429
                ? "rate_limited"
                : error instanceof SimplefinTransportError &&
                    error.kind !== "transport" &&
                    (status ?? 0) < 500
                  ? "invalid_response"
                  : "unavailable";
        throw new BankSyncProviderError(
          kind,
          status === 401 || status === 403
            ? tr(
                "errors.bankSync.simplefinCredentialsUnreadable",
                "The stored SimpleFIN credentials cannot be read. Reconnect using a new setup token from SimpleFIN Bridge.",
              )
            : status === 402
              ? tr(
                  "errors.bankSync.simplefinSubscriptionRequired",
                  "SimpleFIN Bridge requires an active subscription. Review billing in SimpleFIN Bridge.",
                )
              : tr(
                  "errors.bankSync.simplefinReadFailed",
                  "SimpleFIN could not provide complete account data. Review the connection in SimpleFIN Bridge.",
                ),
          status ?? null,
        );
      }
      const set = mapSimplefinAccountSet(payload, origin);
      // Unknown/unscoped errors must also refuse a payload containing no accounts.
      if (set.errors.some((e) => !e.connectionId && !e.accountId)) invalid();
      for (const remote of set.accounts) {
        count +=
          remote.transactions.length +
          remote.pendingCount +
          remote.refusedCount;
        if (count > 50_000) invalid();
        const id = remote.descriptor.externalAccountId;
        appearances.set(id, (appearances.get(id) ?? 0) + 1);
        let account = result.get(id);
        if (!account) {
          account = {
            transactions: [],
            balance: null,
            pending: 0,
            blocked: false,
            currencyCode: remote.descriptor.currencyCode,
            balanceAt: null,
          };
          result.set(id, account);
        }
        if (
          !remote.transactionsComplete ||
          simplefinAccountBlocked(
            set.errors,
            remote.connectionId,
            remote.remoteAccountId,
          ) ||
          account.currencyCode !== remote.descriptor.currencyCode
        )
          account.blocked = true;
        account.pending = Math.max(account.pending, remote.pendingCount);
        account.transactions.push(...remote.refusals);
        if (
          remote.balanceTimestamp !== null &&
          (account.balanceAt === null ||
            remote.balanceTimestamp >= account.balanceAt)
        ) {
          account.balanceAt = remote.balanceTimestamp;
          account.balance =
            remote.balance === null
              ? null
              : {
                  ...remote.balance,
                  reportedAt:
                    remote.balanceTimestamp === null
                      ? null
                      : new Date(remote.balanceTimestamp * 1000).toISOString(),
                };
          if (remote.balance && !fitsPlanner(remote.balance.amount))
            account.balance = null;
        }
        for (const row of remote.transactions) {
          if (row.amount === null || !fitsPlanner(row.amount)) {
            account.transactions.push({
              ...row,
              amount: null,
              refusalReason: "invalid_amount",
            });
            continue;
          }
          const content = JSON.stringify(row);
          const previous = seenRows.get(row.externalKey);
          if (previous !== undefined) {
            if (previous !== content) account.blocked = true;
            continue;
          }
          seenRows.set(row.externalKey, content);
          account.transactions.push({
            ...row,
            entryReference: row.externalKey,
            transactionId: null,
            remittance: row.remittance.map((line) => safeText(line) ?? ""),
            counterpartyName: safeText(row.counterpartyName),
            bankReference: safeText(row.bankReference),
          });
        }
      }
    }
    for (const [id, account] of result)
      if (appearances.get(id) !== windows.length) account.blocked = true;
    return result;
  }
}
