import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { Transaction } from "../transactions/entities/transaction.entity";
import { Category } from "../categories/entities/category.entity";
import { ReportCurrencyService } from "./report-currency.service";
import {
  TaxSummaryResponse,
  RecurringExpensesResponse,
  RecurringExpenseItem,
  BillPaymentHistoryResponse,
  BillPaymentItem,
  MonthlyBillTotal,
} from "./dto";
import { formatDateYMD } from "../common/date-utils";

@Injectable()
export class TaxRecurringReportsService {
  constructor(
    @InjectRepository(Transaction)
    private transactionsRepository: Repository<Transaction>,
    @InjectRepository(Category)
    private categoriesRepository: Repository<Category>,
    private currencyService: ReportCurrencyService,
  ) {}

  async getTaxSummary(
    userId: string,
    year: number,
  ): Promise<TaxSummaryResponse> {
    const defaultCurrency =
      await this.currencyService.getDefaultCurrency(userId);
    const rateMap = await this.currencyService.buildRateMap(defaultCurrency);

    const startDate = `${year}-01-01`;
    const endDate = `${year}-12-31`;

    const query = `
      SELECT
        COALESCE(ts.category_id, t.category_id) as category_id,
        t.currency_code,
        COALESCE(ts.amount, t.amount) as amount
      FROM transactions t
      LEFT JOIN transaction_splits ts ON ts.transaction_id = t.id
      LEFT JOIN accounts a ON a.id = t.account_id
      WHERE t.user_id = $1
        AND t.transaction_date >= $2
        AND t.transaction_date <= $3
        AND t.is_transfer = false
        AND (t.status IS NULL OR t.status != 'VOID')
        AND t.parent_transaction_id IS NULL
        AND a.account_type != 'INVESTMENT'
        AND (ts.transfer_account_id IS NULL OR ts.id IS NULL)
    `;

    interface RawTaxRow {
      category_id: string | null;
      currency_code: string;
      amount: string;
    }

    const rawResults: RawTaxRow[] = await this.transactionsRepository.query(
      query,
      [userId, startDate, endDate],
    );

    const categories = await this.categoriesRepository.find({
      where: { userId },
    });
    const categoryMap = new Map(categories.map((c) => [c.id, c]));

    const taxDeductibleKeywords = [
      "medical",
      "health",
      "dental",
      "vision",
      "prescription",
      "pharmacy",
      "donation",
      "charity",
      "charitable",
      "education",
      "tuition",
      "school",
      "course",
      "training",
      "childcare",
      "daycare",
      "moving",
      "union",
      "professional dues",
      "rrsp",
      "retirement",
    ];

    const matchesKeywords = (name: string): boolean => {
      const lowerName = name.toLowerCase();
      return taxDeductibleKeywords.some((keyword) =>
        lowerName.includes(keyword),
      );
    };

    const incomeBySource = new Map<string, number>();
    const deductibleExpenses = new Map<string, number>();
    const allExpensesByCategory = new Map<string, number>();
    let totalIncome = 0;
    let totalExpenses = 0;

    rawResults.forEach((row) => {
      const amount = this.currencyService.convertAmount(
        parseFloat(row.amount) || 0,
        row.currency_code,
        defaultCurrency,
        rateMap,
      );
      const category = row.category_id
        ? categoryMap.get(row.category_id)
        : null;
      const parentCategory = category?.parentId
        ? categoryMap.get(category.parentId)
        : null;
      const catName = parentCategory?.name || category?.name || "Uncategorized";

      if (amount > 0) {
        totalIncome += amount;
        incomeBySource.set(
          catName,
          (incomeBySource.get(catName) || 0) + amount,
        );
      } else {
        const expenseAmt = Math.abs(amount);
        totalExpenses += expenseAmt;
        allExpensesByCategory.set(
          catName,
          (allExpensesByCategory.get(catName) || 0) + expenseAmt,
        );

        if (matchesKeywords(catName)) {
          deductibleExpenses.set(
            catName,
            (deductibleExpenses.get(catName) || 0) + expenseAmt,
          );
        }
      }
    });

    const totalDeductible = Array.from(deductibleExpenses.values()).reduce(
      (sum, v) => sum + v,
      0,
    );

    return {
      incomeBySource: Array.from(incomeBySource.entries())
        .map(([name, total]) => ({
          name,
          total: Math.round(total * 100) / 100,
        }))
        .sort((a, b) => b.total - a.total),
      deductibleExpenses: Array.from(deductibleExpenses.entries())
        .map(([name, total]) => ({
          name,
          total: Math.round(total * 100) / 100,
        }))
        .sort((a, b) => b.total - a.total),
      allExpenses: Array.from(allExpensesByCategory.entries())
        .map(([name, total]) => ({
          name,
          total: Math.round(total * 100) / 100,
        }))
        .sort((a, b) => b.total - a.total),
      totals: {
        income: Math.round(totalIncome * 100) / 100,
        expenses: Math.round(totalExpenses * 100) / 100,
        deductible: Math.round(totalDeductible * 100) / 100,
      },
    };
  }

  async getRecurringExpenses(
    userId: string,
    minOccurrences: number = 3,
  ): Promise<RecurringExpensesResponse> {
    const defaultCurrency =
      await this.currencyService.getDefaultCurrency(userId);
    const rateMap = await this.currencyService.buildRateMap(defaultCurrency);

    const now = new Date();
    const sixMonthsAgo = new Date(now);
    sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
    const startDate = formatDateYMD(sixMonthsAgo);
    const endDate = formatDateYMD(now);

    const query = `
      SELECT
        t.payee_id,
        LOWER(TRIM(COALESCE(p.name, t.payee_name))) as payee_name_normalized,
        COALESCE(p.name, t.payee_name) as payee_name,
        c.name as category_name,
        t.currency_code,
        COUNT(*)::int as occurrences,
        SUM(ABS(t.amount)) as total_amount,
        MAX(t.transaction_date) as last_transaction_date
      FROM transactions t
      LEFT JOIN payees p ON p.id = t.payee_id
      LEFT JOIN categories c ON c.id = t.category_id
      LEFT JOIN accounts a ON a.id = t.account_id
      WHERE t.user_id = $1
        AND t.transaction_date >= $2
        AND t.transaction_date <= $3
        AND t.amount < 0
        AND t.is_transfer = false
        AND (t.status IS NULL OR t.status != 'VOID')
        AND t.parent_transaction_id IS NULL
        AND a.account_type != 'INVESTMENT'
        AND (COALESCE(p.name, t.payee_name) IS NOT NULL AND TRIM(COALESCE(p.name, t.payee_name)) != '')
      GROUP BY t.payee_id, LOWER(TRIM(COALESCE(p.name, t.payee_name))), COALESCE(p.name, t.payee_name), c.name, t.currency_code
      HAVING COUNT(*) >= $4
      ORDER BY SUM(ABS(t.amount)) DESC
    `;

    interface RawRecurring {
      payee_id: string | null;
      payee_name_normalized: string;
      payee_name: string;
      category_name: string | null;
      currency_code: string;
      occurrences: number;
      total_amount: string;
      last_transaction_date: Date;
    }

    const rawResults: RawRecurring[] = await this.transactionsRepository.query(
      query,
      [userId, startDate, endDate, minOccurrences],
    );

    const payeeMerged = new Map<
      string,
      {
        payeeName: string;
        payeeId: string | null;
        occurrences: number;
        totalAmount: number;
        lastTransactionDate: Date;
        categoryName: string | null;
      }
    >();

    for (const row of rawResults) {
      const totalAmount = this.currencyService.convertAmount(
        parseFloat(row.total_amount) || 0,
        row.currency_code,
        defaultCurrency,
        rateMap,
      );
      const key = row.payee_name_normalized;
      const existing = payeeMerged.get(key);
      if (existing) {
        existing.occurrences += row.occurrences;
        existing.totalAmount += totalAmount;
        if (
          new Date(row.last_transaction_date) > existing.lastTransactionDate
        ) {
          existing.lastTransactionDate = new Date(row.last_transaction_date);
        }
      } else {
        payeeMerged.set(key, {
          payeeName: row.payee_name,
          payeeId: row.payee_id,
          occurrences: row.occurrences,
          totalAmount,
          lastTransactionDate: new Date(row.last_transaction_date),
          categoryName: row.category_name,
        });
      }
    }

    const data: RecurringExpenseItem[] = Array.from(payeeMerged.values()).map(
      (row) => {
        const totalAmount = row.totalAmount;
        const occurrences = row.occurrences;

        let frequency = "Irregular";
        if (occurrences >= 24) frequency = "Weekly";
        else if (occurrences >= 12) frequency = "Bi-weekly";
        else if (occurrences >= 5) frequency = "Monthly";
        else if (occurrences >= 3) frequency = "Occasional";

        return {
          payeeName: row.payeeName,
          payeeId: row.payeeId,
          occurrences,
          totalAmount: Math.round(totalAmount * 100) / 100,
          averageAmount: Math.round((totalAmount / occurrences) * 100) / 100,
          lastTransactionDate: formatDateYMD(row.lastTransactionDate),
          frequency,
          categoryName: row.categoryName || "Uncategorized",
        };
      },
    );

    const totalRecurring = data.reduce(
      (sum, item) => sum + item.totalAmount,
      0,
    );

    return {
      data,
      summary: {
        totalRecurring: Math.round(totalRecurring * 100) / 100,
        monthlyEstimate: Math.round((totalRecurring / 6) * 100) / 100,
        uniquePayees: data.length,
      },
    };
  }

  async getBillPaymentHistory(
    userId: string,
    startDate: string | undefined,
    endDate: string,
  ): Promise<BillPaymentHistoryResponse> {
    const defaultCurrency =
      await this.currencyService.getDefaultCurrency(userId);
    const rateMap = await this.currencyService.buildRateMap(defaultCurrency);

    const scheduledQuery = `
      SELECT
        st.id,
        st.name,
        st.amount,
        COALESCE(p.name, st.payee_name) as payee_name
      FROM scheduled_transactions st
      LEFT JOIN payees p ON p.id = st.payee_id
      WHERE st.user_id = $1
        AND st.is_transfer = false
    `;

    interface RawScheduled {
      id: string;
      name: string;
      amount: string;
      payee_name: string | null;
    }

    const scheduledTx: RawScheduled[] = await this.transactionsRepository.query(
      scheduledQuery,
      [userId],
    );

    if (scheduledTx.length === 0) {
      return {
        billPayments: [],
        monthlyTotals: [],
        summary: {
          totalPaid: 0,
          totalPayments: 0,
          uniqueBills: 0,
          monthlyAverage: 0,
        },
      };
    }

    const payeeToScheduled = new Map<
      string,
      { id: string; name: string; amount: number }
    >();
    scheduledTx.forEach((st) => {
      if (st.payee_name) {
        payeeToScheduled.set(st.payee_name.toLowerCase().trim(), {
          id: st.id,
          name: st.name,
          amount: Math.abs(parseFloat(st.amount)),
        });
      }
    });

    let txQuery = `
      SELECT
        t.id,
        t.transaction_date,
        t.currency_code,
        ABS(t.amount) as amount,
        LOWER(TRIM(COALESCE(p.name, t.payee_name))) as payee_name_normalized
      FROM transactions t
      LEFT JOIN payees p ON p.id = t.payee_id
      LEFT JOIN accounts a ON a.id = t.account_id
      WHERE t.user_id = $1
        AND t.transaction_date <= $2
        AND t.is_transfer = false
        AND (t.status IS NULL OR t.status != 'VOID')
        AND t.parent_transaction_id IS NULL
        AND a.account_type != 'INVESTMENT'
    `;

    const params: (string | undefined)[] = [userId, endDate];

    if (startDate) {
      txQuery += ` AND t.transaction_date >= $3`;
      params.push(startDate);
    }

    interface RawTx {
      id: string;
      transaction_date: Date;
      currency_code: string;
      amount: string;
      payee_name_normalized: string | null;
    }

    const transactions: RawTx[] = await this.transactionsRepository.query(
      txQuery,
      params,
    );

    const billPaymentMap = new Map<
      string,
      {
        id: string;
        name: string;
        payeeName: string;
        payments: { date: Date; amount: number }[];
      }
    >();

    transactions.forEach((tx) => {
      if (!tx.payee_name_normalized) return;
      const scheduled = payeeToScheduled.get(tx.payee_name_normalized);
      if (!scheduled) return;

      const txAmount = this.currencyService.convertAmount(
        parseFloat(tx.amount) || 0,
        tx.currency_code,
        defaultCurrency,
        rateMap,
      );
      if (
        txAmount >= scheduled.amount * 0.8 &&
        txAmount <= scheduled.amount * 1.2
      ) {
        let payment = billPaymentMap.get(scheduled.id);
        if (!payment) {
          payment = {
            id: scheduled.id,
            name: scheduled.name,
            payeeName: tx.payee_name_normalized,
            payments: [],
          };
          billPaymentMap.set(scheduled.id, payment);
        }
        payment.payments.push({
          date: new Date(tx.transaction_date),
          amount: txAmount,
        });
      }
    });

    const billPayments: BillPaymentItem[] = Array.from(billPaymentMap.values())
      .filter((bp) => bp.payments.length > 0)
      .map((bp) => {
        const totalPaid = bp.payments.reduce((sum, p) => sum + p.amount, 0);
        const sortedPayments = [...bp.payments].sort(
          (a, b) => b.date.getTime() - a.date.getTime(),
        );
        return {
          scheduledTransactionId: bp.id,
          scheduledTransactionName: bp.name,
          payeeName: bp.payeeName,
          totalPaid: Math.round(totalPaid * 100) / 100,
          paymentCount: bp.payments.length,
          averagePayment:
            Math.round((totalPaid / bp.payments.length) * 100) / 100,
          lastPaymentDate: sortedPayments[0]
            ? formatDateYMD(sortedPayments[0].date)
            : null,
        };
      })
      .sort((a, b) => b.totalPaid - a.totalPaid);

    const monthlyMap = new Map<string, { total: number; label: string }>();
    billPaymentMap.forEach((bp) => {
      bp.payments.forEach((payment) => {
        const monthKey = payment.date.toISOString().slice(0, 7);
        const existing = monthlyMap.get(monthKey);
        if (existing) {
          existing.total += payment.amount;
        } else {
          const d = new Date(payment.date);
          monthlyMap.set(monthKey, {
            total: payment.amount,
            label: d.toLocaleDateString("en-US", {
              month: "short",
              year: "2-digit",
            }),
          });
        }
      });
    });

    const monthlyTotals: MonthlyBillTotal[] = Array.from(monthlyMap.entries())
      .map(([month, data]) => ({
        month,
        label: data.label,
        total: Math.round(data.total * 100) / 100,
      }))
      .sort((a, b) => a.month.localeCompare(b.month));

    const totalPaid = billPayments.reduce((sum, bp) => sum + bp.totalPaid, 0);
    const totalPayments = billPayments.reduce(
      (sum, bp) => sum + bp.paymentCount,
      0,
    );
    const monthCount = monthlyTotals.length || 1;

    return {
      billPayments,
      monthlyTotals,
      summary: {
        totalPaid: Math.round(totalPaid * 100) / 100,
        totalPayments,
        uniqueBills: billPayments.length,
        monthlyAverage: Math.round((totalPaid / monthCount) * 100) / 100,
      },
    };
  }
}
