import { Injectable, Logger } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { Transaction } from "../transactions/entities/transaction.entity";
import { Category } from "../categories/entities/category.entity";
import { Account, AccountType } from "./entities/account.entity";
import { AccountsService } from "./accounts.service";

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

interface CsvExportOptions {
  expandSplits?: boolean;
}

@Injectable()
export class AccountExportService {
  private readonly logger = new Logger(AccountExportService.name);

  constructor(
    @InjectRepository(Transaction)
    private transactionsRepository: Repository<Transaction>,
    @InjectRepository(Category)
    private categoriesRepository: Repository<Category>,
    @InjectRepository(Account)
    private accountsRepository: Repository<Account>,
    private accountsService: AccountsService,
  ) {}

  async exportCsv(
    userId: string,
    accountId: string,
    options: CsvExportOptions = {},
  ): Promise<string> {
    const { expandSplits = true } = options;
    const account = await this.accountsService.findOne(userId, accountId);
    const transactions = await this.getExportTransactions(userId, accountId);

    const rows: string[] = [];
    rows.push(this.csvHeader());

    let runningBalance = Number(account.openingBalance) || 0;

    for (const tx of transactions) {
      if (tx.status !== "VOID") {
        runningBalance =
          Math.round((runningBalance + tx.amount) * 10000) / 10000;
      }
      const balance = tx.status === "VOID" ? runningBalance : runningBalance;

      if (tx.isSplit && expandSplits) {
        rows.push(
          this.csvRow(
            tx.date,
            tx.referenceNumber,
            tx.payeeName,
            "-- Split --",
            tx.description,
            tx.amount,
            tx.status,
            balance,
          ),
        );
        for (const split of tx.splits) {
          const categoryLabel = split.isTransfer
            ? `Transfer: ${split.transferAccountName}`
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
          ? `Transfer: ${tx.transferAccountName}`
          : tx.categoryPath;
        rows.push(
          this.csvRow(
            tx.date,
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

  async exportQif(userId: string, accountId: string): Promise<string> {
    const account = await this.accountsService.findOne(userId, accountId);
    const transactions = await this.getExportTransactions(userId, accountId);

    const lines: string[] = [];
    lines.push(`!Type:${this.accountTypeToQif(account.accountType)}`);

    for (const tx of transactions) {
      lines.push(`D${this.formatQifDate(tx.date)}`);
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
  ): Promise<ExportTransaction[]> {
    const rawTransactions = await this.transactionsRepository
      .createQueryBuilder("transaction")
      .leftJoinAndSelect("transaction.payee", "payee")
      .leftJoinAndSelect("transaction.category", "category")
      .leftJoinAndSelect("transaction.splits", "splits")
      .leftJoinAndSelect("splits.category", "splitCategory")
      .leftJoinAndSelect("splits.transferAccount", "splitTransferAccount")
      .leftJoinAndSelect("transaction.linkedTransaction", "linkedTransaction")
      .leftJoinAndSelect("linkedTransaction.account", "linkedAccount")
      .where("transaction.userId = :userId", { userId })
      .andWhere("transaction.accountId = :accountId", { accountId })
      .orderBy("transaction.transactionDate", "ASC")
      .addOrderBy("transaction.createdAt", "ASC")
      .addOrderBy("transaction.id", "ASC")
      .getMany();

    const categoryMap = await this.buildCategoryPathMap(userId);

    return rawTransactions.map((tx) => ({
      date: tx.transactionDate,
      referenceNumber: tx.referenceNumber || "",
      payeeName: tx.payeeName || tx.payee?.name || "",
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
    const categories = await this.categoriesRepository.find({
      where: { userId },
    });

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
    // Guard against CSV formula injection: prefix with single quote if the
    // value starts with a character that spreadsheets interpret as a formula.
    let safe = value;
    if (/^[=+\-@\t\r]/.test(safe)) {
      safe = `'${safe}`;
    }

    if (
      safe.includes(",") ||
      safe.includes('"') ||
      safe.includes("\n") ||
      safe.includes("\r")
    ) {
      return `"${safe.replace(/"/g, '""')}"`;
    }
    return safe;
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

  private formatQifDate(dateStr: string): string {
    const parts = dateStr.split("-");
    if (parts.length === 3) {
      const [year, month, day] = parts;
      return `${month}/${day}/${year}`;
    }
    return dateStr;
  }
}
