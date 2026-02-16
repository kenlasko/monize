import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { Transaction } from "../transactions/entities/transaction.entity";
import { ReportCurrencyService } from "./report-currency.service";
import {
  UncategorizedTransactionsResponse,
  UncategorizedTransactionItem,
  DuplicateTransactionsResponse,
  DuplicateGroup,
  DuplicateTransactionItem,
} from "./dto";

@Injectable()
export class DataQualityReportsService {
  constructor(
    @InjectRepository(Transaction)
    private transactionsRepository: Repository<Transaction>,
    private currencyService: ReportCurrencyService,
  ) {}

  async getUncategorizedTransactions(
    userId: string,
    startDate: string | undefined,
    endDate: string,
    limit: number = 500,
  ): Promise<UncategorizedTransactionsResponse> {
    const defaultCurrency =
      await this.currencyService.getDefaultCurrency(userId);
    const rateMap = await this.currencyService.buildRateMap(defaultCurrency);

    let query = `
      SELECT
        t.id,
        t.transaction_date,
        t.currency_code,
        t.amount,
        COALESCE(p.name, t.payee_name) as payee_name,
        t.description,
        a.name as account_name
      FROM transactions t
      LEFT JOIN payees p ON p.id = t.payee_id
      LEFT JOIN accounts a ON a.id = t.account_id
      WHERE t.user_id = $1
        AND t.transaction_date <= $2
        AND t.is_transfer = false
        AND (t.status IS NULL OR t.status != 'VOID')
        AND t.parent_transaction_id IS NULL
        AND a.account_type != 'INVESTMENT'
        AND t.category_id IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM transaction_splits ts
          WHERE ts.transaction_id = t.id
          AND ts.category_id IS NOT NULL
        )
    `;

    const params: (string | number)[] = [userId, endDate];
    let paramIndex = 3;

    if (startDate) {
      query += ` AND t.transaction_date >= $${paramIndex}`;
      params.push(startDate);
      paramIndex++;
    }

    query += ` ORDER BY t.transaction_date DESC LIMIT $${paramIndex}`;
    params.push(limit);

    interface RawUncategorizedTx {
      id: string;
      transaction_date: string;
      currency_code: string;
      amount: string;
      payee_name: string | null;
      description: string | null;
      account_name: string | null;
    }

    const rows: RawUncategorizedTx[] = await this.transactionsRepository.query(
      query,
      params,
    );

    const transactions: UncategorizedTransactionItem[] = rows.map((row) => ({
      id: row.id,
      transactionDate: new Date(row.transaction_date)
        .toISOString()
        .split("T")[0],
      amount: this.currencyService.convertAmount(
        parseFloat(row.amount) || 0,
        row.currency_code,
        defaultCurrency,
        rateMap,
      ),
      payeeName: row.payee_name,
      description: row.description,
      accountName: row.account_name,
    }));

    let summaryQuery = `
      SELECT
        t.currency_code,
        COUNT(*) as total_count,
        COUNT(*) FILTER (WHERE t.amount < 0) as expense_count,
        COALESCE(SUM(ABS(t.amount)) FILTER (WHERE t.amount < 0), 0) as expense_total,
        COUNT(*) FILTER (WHERE t.amount > 0) as income_count,
        COALESCE(SUM(t.amount) FILTER (WHERE t.amount > 0), 0) as income_total
      FROM transactions t
      LEFT JOIN accounts a ON a.id = t.account_id
      WHERE t.user_id = $1
        AND t.transaction_date <= $2
        AND t.is_transfer = false
        AND (t.status IS NULL OR t.status != 'VOID')
        AND t.parent_transaction_id IS NULL
        AND a.account_type != 'INVESTMENT'
        AND t.category_id IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM transaction_splits ts
          WHERE ts.transaction_id = t.id
          AND ts.category_id IS NOT NULL
        )
    `;

    const summaryParams: string[] = [userId, endDate];
    if (startDate) {
      summaryQuery += ` AND t.transaction_date >= $3`;
      summaryParams.push(startDate);
    }

    summaryQuery += ` GROUP BY t.currency_code`;

    interface RawSummary {
      currency_code: string;
      total_count: string;
      expense_count: string;
      expense_total: string;
      income_count: string;
      income_total: string;
    }

    const summaryRows: RawSummary[] = await this.transactionsRepository.query(
      summaryQuery,
      summaryParams,
    );

    let totalCount = 0;
    let expenseCount = 0;
    let expenseTotal = 0;
    let incomeCount = 0;
    let incomeTotal = 0;
    for (const row of summaryRows) {
      totalCount += parseInt(row.total_count, 10);
      expenseCount += parseInt(row.expense_count, 10);
      expenseTotal += this.currencyService.convertAmount(
        parseFloat(row.expense_total) || 0,
        row.currency_code,
        defaultCurrency,
        rateMap,
      );
      incomeCount += parseInt(row.income_count, 10);
      incomeTotal += this.currencyService.convertAmount(
        parseFloat(row.income_total) || 0,
        row.currency_code,
        defaultCurrency,
        rateMap,
      );
    }

    return {
      transactions,
      summary: {
        totalCount,
        expenseCount,
        expenseTotal: Math.round(expenseTotal * 100) / 100,
        incomeCount,
        incomeTotal: Math.round(incomeTotal * 100) / 100,
      },
    };
  }

  async getDuplicateTransactions(
    userId: string,
    startDate: string | undefined,
    endDate: string,
    sensitivity: "high" | "medium" | "low" = "medium",
  ): Promise<DuplicateTransactionsResponse> {
    const maxDaysDiff =
      sensitivity === "high" ? 3 : sensitivity === "medium" ? 1 : 0;
    const checkPayee = sensitivity !== "low";

    const params: string[] = [userId, endDate];
    let paramIndex = 3;

    let dateFilter = `AND t.transaction_date <= $2`;
    if (startDate) {
      dateFilter = `AND t.transaction_date >= $${paramIndex} AND t.transaction_date <= $2`;
      params.push(startDate);
      paramIndex++;
    }

    const query = `
      SELECT
        t.id,
        t.transaction_date,
        t.amount,
        COALESCE(p.name, t.payee_name) as payee_name,
        t.description,
        a.name as account_name
      FROM transactions t
      LEFT JOIN payees p ON p.id = t.payee_id
      LEFT JOIN accounts a ON a.id = t.account_id
      WHERE t.user_id = $1
        ${dateFilter}
        AND t.is_transfer = false
        AND (t.status IS NULL OR t.status != 'VOID')
        AND t.parent_transaction_id IS NULL
      ORDER BY t.transaction_date ASC, t.amount ASC
    `;

    interface RawTx {
      id: string;
      transaction_date: string;
      amount: string;
      payee_name: string | null;
      description: string | null;
      account_name: string | null;
    }

    const rows: RawTx[] = await this.transactionsRepository.query(
      query,
      params,
    );

    const transactions: DuplicateTransactionItem[] = rows.map((row) => ({
      id: row.id,
      transactionDate: new Date(row.transaction_date)
        .toISOString()
        .split("T")[0],
      amount: parseFloat(row.amount),
      payeeName: row.payee_name,
      description: row.description,
      accountName: row.account_name,
    }));

    const groups: DuplicateGroup[] = [];
    const processed = new Set<string>();

    for (let i = 0; i < transactions.length; i++) {
      const tx1 = transactions[i];
      if (processed.has(tx1.id)) continue;

      const date1 = new Date(tx1.transactionDate);
      const payee1 = (tx1.payeeName || "").toLowerCase().trim();

      const matches: DuplicateTransactionItem[] = [tx1];

      for (let j = i + 1; j < transactions.length; j++) {
        const tx2 = transactions[j];
        if (processed.has(tx2.id)) continue;

        const date2 = new Date(tx2.transactionDate);
        const payee2 = (tx2.payeeName || "").toLowerCase().trim();

        const daysDiff = Math.abs(
          Math.floor(
            (date1.getTime() - date2.getTime()) / (1000 * 60 * 60 * 24),
          ),
        );
        if (daysDiff > maxDaysDiff) {
          if (daysDiff > 7) break;
          continue;
        }

        if (Math.abs(tx1.amount - tx2.amount) > 0.01) continue;

        if (checkPayee && payee1 && payee2 && payee1 !== payee2) continue;

        if (tx1.id === tx2.id) continue;

        matches.push(tx2);
      }

      if (matches.length > 1) {
        matches.forEach((m) => processed.add(m.id));

        const allSameDate = matches.every(
          (m) => m.transactionDate === matches[0].transactionDate,
        );
        const allSamePayee = matches.every(
          (m) =>
            (m.payeeName || "").toLowerCase().trim() ===
            (matches[0].payeeName || "").toLowerCase().trim(),
        );

        let confidence: "high" | "medium" | "low" = "low";
        let reason = "Same amount";

        if (allSameDate && allSamePayee) {
          confidence = "high";
          reason = "Same date, amount, and payee";
        } else if (allSameDate) {
          confidence = "medium";
          reason = "Same date and amount";
        } else if (allSamePayee) {
          confidence = "medium";
          reason = `Same payee and amount within ${maxDaysDiff} day(s)`;
        } else {
          reason = `Same amount within ${maxDaysDiff} day(s)`;
        }

        groups.push({
          key: `${matches[0].id}-${matches.length}`,
          transactions: matches,
          reason,
          confidence,
        });
      }
    }

    const confidenceOrder: Record<string, number> = {
      high: 0,
      medium: 1,
      low: 2,
    };
    groups.sort((a, b) => {
      const confDiff =
        confidenceOrder[a.confidence] - confidenceOrder[b.confidence];
      if (confDiff !== 0) return confDiff;
      return (
        Math.abs(b.transactions[0].amount) - Math.abs(a.transactions[0].amount)
      );
    });

    const high = groups.filter((g) => g.confidence === "high");
    const medium = groups.filter((g) => g.confidence === "medium");
    const low = groups.filter((g) => g.confidence === "low");

    const potentialSavings = groups.reduce((sum, group) => {
      const duplicateCount = group.transactions.length - 1;
      return sum + Math.abs(group.transactions[0].amount) * duplicateCount;
    }, 0);

    return {
      groups,
      summary: {
        totalGroups: groups.length,
        highCount: high.length,
        mediumCount: medium.length,
        lowCount: low.length,
        potentialSavings: Math.round(potentialSavings * 100) / 100,
      },
    };
  }
}
