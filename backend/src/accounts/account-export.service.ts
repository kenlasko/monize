import { escapeCsvCell } from "../common/csv-cell.util";
import { Injectable, Logger } from "@nestjs/common";
import { DataSource } from "typeorm";
import { Transaction } from "../transactions/entities/transaction.entity";
import { applyRegisterOrder } from "../transactions/register-order";
import { Category } from "../categories/entities/category.entity";
import { AccountType } from "./entities/account.entity";
import { AccountsService } from "./accounts.service";
import { CrossOwnerAccessService } from "../delegation/cross-owner-access.service";
import {
  maskTransactionsAgainst,
  payloadHasCrossOwnerTransfer,
} from "../delegation/transfer-mask.util";
import { roundMoney } from "../common/round.util";
import { withScopedDb } from "../common/db/scoped-db";
import { transferPayeeLabel } from "../transactions/transfer-payee-label.util";

interface ExportTransaction {
  date: string;
  referenceNumber: string;
  payeeName: string;
  categoryPath: string;
  description: string;
  amount: number;
  status: string;
  runningBalance: number;
  isSplit: boolean;
  isTransfer: boolean;
  transferAccountName: string;
  splits: ExportSplit[];
}

interface ExportSplit {
  categoryPath: string;
  memo: string;
  amount: number;
  isTransfer: boolean;
  transferAccountName: string;
}

/**
 * Category label on the parent row of a split.
 *
 * It must not open with a character a spreadsheet evaluates. The old
 * `-- Split --` did, so `escapeCsv` neutralized the exporter's own label and
 * every split row in every account export carried a stray apostrophe in front
 * of it. Dropping the guard is not the alternative -- Excel evaluates a leading
 * dash, and an unguarded `-- Split --` reads as `#NAME?`. The fix is a label
 * that needs no guard, which is why the delimiters are parentheses.
 */
export const CSV_SPLIT_CATEGORY_LABEL = "(Split)";

/**
 * Category label for a transfer: `Transfer To Savings`.
 *
 * The direction is a fact about the row being written -- money leaving this
 * account went *to* the counterpart, money arriving came *from* it -- so the
 * two legs of one transfer are labelled differently, and a split line is asked
 * with its own amount rather than the parent's. `Transfer: Savings` named the
 * counterpart without saying which way the money went, which is the half that
 * matters when reading an export away from the register's arrows. Twin of
 * `transferCsvLabel` in `frontend/src/lib/transfer-label.ts`; an amount of
 * exactly zero has no direction and takes the same branch there as here.
 */
export function csvTransferLabel(accountName: string, amount: number): string {
  return `Transfer ${Number(amount) < 0 ? "To" : "From"} ${accountName}`;
}

/**
 * Values a spreadsheet reads as a number rather than as a formula, so the guard
 * in `escapeCsv` leaves them alone: a leading sign followed only by digits,
 * separators, whitespace and currency symbols names no function and no cell,
 * and reaches no DDE server. Twin of the rule in
 * `frontend/src/lib/csv-export.ts`, which is where issue #1134 was reported --
 * a guarded `-67.99` stops a spreadsheet totalling the column it sits in.
 * Amounts here bypass `escapeCsv` entirely, so this is about the text columns
 * that can still hold a number: a cheque number written `-123`, say.
 */

interface CsvExportOptions {
  expandSplits?: boolean;
  dateFormat?: string;
}

interface QifExportOptions {
  dateFormat?: string;
}

@Injectable()
export class AccountExportService {
  private readonly logger = new Logger(AccountExportService.name);

  constructor(
    private dataSource: DataSource,
    private accountsService: AccountsService,
    private crossOwnerAccess: CrossOwnerAccessService,
  ) {}

  async exportCsv(
    userId: string,
    accountId: string,
    options: CsvExportOptions = {},
    realUserId = userId,
  ): Promise<string> {
    const { expandSplits = true, dateFormat = "YYYY-MM-DD" } = options;
    const account = await this.accountsService.findOne(userId, accountId);
    const transactions = await this.getExportTransactions(
      userId,
      accountId,
      realUserId,
    );

    const rows: string[] = [];
    rows.push(this.csvHeader());

    let runningBalance = Number(account.openingBalance) || 0;

    for (const tx of transactions) {
      // A VOID row records something that did not happen, so it moves nothing
      // and simply carries the balance above it down its own line -- which is
      // what the register shows too.
      if (tx.status !== "VOID") {
        runningBalance = roundMoney(runningBalance + tx.amount);
      }
      const balance = runningBalance;

      if (tx.isSplit && expandSplits) {
        rows.push(
          this.csvRow(
            this.formatExportDate(tx.date, dateFormat),
            tx.referenceNumber,
            tx.payeeName,
            CSV_SPLIT_CATEGORY_LABEL,
            tx.description,
            tx.amount,
            tx.status,
            balance,
          ),
        );
        for (const split of tx.splits) {
          const categoryLabel = split.isTransfer
            ? csvTransferLabel(split.transferAccountName, split.amount)
            : split.categoryPath;
          rows.push(
            this.csvRow(
              "",
              "",
              "",
              categoryLabel,
              split.memo,
              split.amount,
              "",
              null,
            ),
          );
        }
      } else {
        const categoryLabel = tx.isTransfer
          ? csvTransferLabel(tx.transferAccountName, tx.amount)
          : tx.isSplit
            ? CSV_SPLIT_CATEGORY_LABEL
            : tx.categoryPath;
        rows.push(
          this.csvRow(
            this.formatExportDate(tx.date, dateFormat),
            tx.referenceNumber,
            tx.payeeName,
            categoryLabel,
            tx.description,
            tx.amount,
            tx.status,
            balance,
          ),
        );
      }
    }

    return rows.join("\n");
  }

  async exportQif(
    userId: string,
    accountId: string,
    options: QifExportOptions = {},
    realUserId = userId,
  ): Promise<string> {
    const { dateFormat = "M/D/YYYY" } = options;
    const account = await this.accountsService.findOne(userId, accountId);
    const transactions = await this.getExportTransactions(
      userId,
      accountId,
      realUserId,
    );

    const lines: string[] = [];
    lines.push(`!Type:${this.accountTypeToQif(account.accountType)}`);

    for (const tx of transactions) {
      lines.push(`D${this.formatExportDate(tx.date, dateFormat)}`);
      lines.push(`T${tx.amount}`);

      if (tx.payeeName) {
        lines.push(`P${tx.payeeName}`);
      }

      if (tx.description) {
        lines.push(`M${tx.description}`);
      }

      if (tx.referenceNumber) {
        lines.push(`N${tx.referenceNumber}`);
      }

      if (tx.status === "CLEARED") {
        lines.push("C*");
      } else if (tx.status === "RECONCILED") {
        lines.push("CX");
      }

      if (tx.isSplit) {
        for (const split of tx.splits) {
          if (split.isTransfer) {
            lines.push(`S[${split.transferAccountName}]`);
          } else {
            lines.push(`S${split.categoryPath}`);
          }
          if (split.memo) {
            lines.push(`E${split.memo}`);
          }
          lines.push(`$${split.amount}`);
        }
      } else if (tx.isTransfer) {
        lines.push(`L[${tx.transferAccountName}]`);
      } else if (tx.categoryPath) {
        lines.push(`L${tx.categoryPath}`);
      }

      lines.push("^");
    }

    return lines.join("\n");
  }

  private async getExportTransactions(
    userId: string,
    accountId: string,
    realUserId = userId,
  ): Promise<ExportTransaction[]> {
    const rawTransactions = await withScopedDb(this.dataSource, (m) => {
      const query = m
        .getRepository(Transaction)
        .createQueryBuilder("transaction")
        .leftJoinAndSelect("transaction.payee", "payee")
        .leftJoinAndSelect("transaction.category", "category")
        .leftJoinAndSelect("transaction.splits", "splits")
        .leftJoinAndSelect("splits.category", "splitCategory")
        .leftJoinAndSelect("splits.transferAccount", "splitTransferAccount")
        .leftJoinAndSelect("transaction.linkedTransaction", "linkedTransaction")
        .leftJoinAndSelect("linkedTransaction.account", "linkedAccount")
        .where("transaction.userId = :userId", { userId })
        .andWhere("transaction.accountId = :accountId", { accountId });
      // The register's own order, oldest first, because the column beside
      // these rows is a running balance. This file used to spell the order out
      // and left off the amount leg: when `created_at` cannot separate two
      // rows -- a whole import shares one value -- their signs do, and an
      // export that ordered a purchase before the transfer funding it showed
      // the account overdrawn on a day it was never short.
      return applyRegisterOrder(query, "transaction", "ASC").getMany();
    });

    // The linkedTransaction.account join is unfiltered, so after unshare the
    // export would leak the counterpart's live account name; the response
    // shape bypasses the HTTP mask interceptor, so the mask is applied here
    // (rewriting the exported auto payee names too). Pure-payload fast path
    // first: same-owner exports never pay the grants query.
    if (payloadHasCrossOwnerTransfer(rawTransactions)) {
      const readable =
        await this.crossOwnerAccess.readableAccountIdSetFor(realUserId);
      maskTransactionsAgainst(readable, rawTransactions);
    }

    const categoryMap = await this.buildCategoryPathMap(userId);

    return rawTransactions.map((tx) => ({
      date: tx.transactionDate,
      referenceNumber: tx.referenceNumber || "",
      // A transfer leg with a blank payee resolves its label from the
      // counterpart account's current name (issue #1214) -- the same string
      // the pre-#1214 write paths stamped, so exports read unchanged. The
      // mask above has already rewritten an unreadable counterpart's name.
      payeeName:
        tx.payeeName ||
        tx.payee?.name ||
        (tx.isTransfer && tx.linkedTransaction?.account?.name
          ? transferPayeeLabel(tx.amount, tx.linkedTransaction.account.name)
          : ""),
      categoryPath: tx.categoryId
        ? categoryMap.get(tx.categoryId) || tx.category?.name || ""
        : "",
      description: tx.description || "",
      amount: Number(tx.amount),
      status: tx.status,
      runningBalance: 0,
      isSplit: tx.isSplit,
      isTransfer: tx.isTransfer,
      transferAccountName: tx.linkedTransaction?.account?.name || "",
      splits: (tx.splits || []).map((split) => ({
        categoryPath: split.categoryId
          ? categoryMap.get(split.categoryId) || split.category?.name || ""
          : "",
        memo: split.memo || "",
        amount: Number(split.amount),
        isTransfer: !!split.transferAccountId,
        transferAccountName: split.transferAccount?.name || "",
      })),
    }));
  }

  private async buildCategoryPathMap(
    userId: string,
  ): Promise<Map<string, string>> {
    const categories = await withScopedDb(this.dataSource, (m) =>
      m.getRepository(Category).find({
        where: { userId },
      }),
    );

    const map = new Map<string, Category>();
    for (const cat of categories) {
      map.set(cat.id, cat);
    }

    const pathMap = new Map<string, string>();
    for (const cat of categories) {
      const parts: string[] = [];
      let current: Category | undefined = cat;
      while (current) {
        parts.unshift(current.name);
        current = current.parentId ? map.get(current.parentId) : undefined;
      }
      pathMap.set(cat.id, parts.join(":"));
    }

    return pathMap;
  }

  private csvHeader(): string {
    return [
      "Date",
      "Reference Number",
      "Payee",
      "Category",
      "Description",
      "Amount",
      "Status",
      "Running Balance",
    ].join(",");
  }

  private csvRow(
    date: string,
    referenceNumber: string,
    payee: string,
    category: string,
    description: string,
    amount: number,
    status: string,
    runningBalance: number | null,
  ): string {
    return [
      this.escapeCsv(date),
      this.escapeCsv(referenceNumber),
      this.escapeCsv(payee),
      this.escapeCsv(category),
      this.escapeCsv(description),
      amount.toString(),
      this.escapeCsv(status),
      runningBalance !== null ? runningBalance.toString() : "",
    ].join(",");
  }

  private escapeCsv(value: string): string {
    return escapeCsvCell(value);
  }

  private accountTypeToQif(accountType: AccountType): string {
    switch (accountType) {
      case AccountType.CHEQUING:
      case AccountType.SAVINGS:
        return "Bank";
      case AccountType.CASH:
        return "Cash";
      case AccountType.CREDIT_CARD:
        return "CCard";
      case AccountType.INVESTMENT:
        return "Invst";
      case AccountType.ASSET:
        return "Oth A";
      case AccountType.LINE_OF_CREDIT:
      case AccountType.LOAN:
      case AccountType.MORTGAGE:
        return "Oth L";
      default:
        return "Bank";
    }
  }

  private formatExportDate(dateStr: string, format: string): string {
    const parts = dateStr.split("-");
    if (parts.length !== 3) {
      return dateStr;
    }

    const [yearStr, monthStr, dayStr] = parts;
    const year = parseInt(yearStr, 10);
    const month = parseInt(monthStr, 10);
    const day = parseInt(dayStr, 10);
    const monthPadded = monthStr;
    const dayPadded = dayStr;

    const monthNames = [
      "Jan",
      "Feb",
      "Mar",
      "Apr",
      "May",
      "Jun",
      "Jul",
      "Aug",
      "Sep",
      "Oct",
      "Nov",
      "Dec",
    ];
    const monthName = monthNames[month - 1] || "Jan";

    switch (format) {
      case "YYYY-MM-DD":
        return `${yearStr}-${monthPadded}-${dayPadded}`;
      case "MM/DD/YYYY":
        return `${monthPadded}/${dayPadded}/${yearStr}`;
      case "DD/MM/YYYY":
        return `${dayPadded}/${monthPadded}/${yearStr}`;
      case "DD-MMM-YYYY":
        return `${dayPadded}-${monthName}-${yearStr}`;
      case "M/D/YYYY":
        return `${month}/${day}/${year}`;
      default: {
        // Custom format: token replacement using placeholders to avoid
        // collisions (e.g. "D" matching the "D" in month name "Dec").
        // Process longest tokens first within each letter group.
        const tokens: Array<[string, string]> = [
          ["YYYY", yearStr],
          ["YY", yearStr.slice(2)],
          ["MMM", monthName],
          ["MM", monthPadded],
          ["M", String(month)],
          ["DD", dayPadded],
          ["D", String(day)],
        ];

        // Replace tokens with indexed placeholders, then resolve
        const placeholders: string[] = [];
        let result = format;
        for (const [token] of tokens) {
          const placeholder = `{${placeholders.length}}`;
          placeholders.push(placeholder);
          result = result.split(token).join(placeholder);
        }
        for (let i = 0; i < tokens.length; i++) {
          result = result.split(`{${i}}`).join(tokens[i][1]);
        }
        return result;
      }
    }
  }
}
