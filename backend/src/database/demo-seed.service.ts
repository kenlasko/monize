import { Injectable } from "@nestjs/common";
import { DataSource } from "typeorm";
import * as bcrypt from "bcryptjs";

import { SeedService } from "./seed.service";
import { demoAccounts } from "./demo-seed-data/accounts";
import { demoPayees } from "./demo-seed-data/payees";
import { generateTransactions } from "./demo-seed-data/transactions";
import { demoScheduledTransactions } from "./demo-seed-data/scheduled";
import { demoSecurities, generatePriceHistory } from "./demo-seed-data/securities";
import { demoReports } from "./demo-seed-data/reports";
import { demoPreferences } from "./demo-seed-data/preferences";

@Injectable()
export class DemoSeedService {
  constructor(
    private dataSource: DataSource,
    private seedService: SeedService,
  ) {}

  /**
   * Full demo seed: currencies + demo user + rich demo data.
   */
  async seedAll(): Promise<void> {
    console.log("🎭 Starting DEMO database seeding...\n");

    // Seed currencies via existing service
    await this.seedService.seedAll();

    // Get the demo user ID (created by seedService)
    const [demoUser] = await this.dataSource.query(
      "SELECT id FROM users WHERE email = $1",
      ["demo@monize.com"],
    );

    if (!demoUser) {
      throw new Error("Demo user not found after base seeding");
    }

    // Delete base seed data so we can replace with richer demo data (FK-safe order)
    await this.dataSource.query("DELETE FROM investment_transactions WHERE user_id = $1", [demoUser.id]);
    await this.dataSource.query("DELETE FROM holdings WHERE account_id IN (SELECT id FROM accounts WHERE user_id = $1)", [demoUser.id]);
    await this.dataSource.query("DELETE FROM security_prices WHERE security_id IN (SELECT id FROM securities WHERE user_id = $1)", [demoUser.id]);
    await this.dataSource.query("DELETE FROM securities WHERE user_id = $1", [demoUser.id]);
    await this.dataSource.query("DELETE FROM transaction_splits WHERE transaction_id IN (SELECT id FROM transactions WHERE user_id = $1)", [demoUser.id]);
    await this.dataSource.query("DELETE FROM transactions WHERE user_id = $1", [demoUser.id]);
    await this.dataSource.query("DELETE FROM scheduled_transaction_splits WHERE scheduled_transaction_id IN (SELECT id FROM scheduled_transactions WHERE user_id = $1)", [demoUser.id]);
    await this.dataSource.query("DELETE FROM scheduled_transactions WHERE user_id = $1", [demoUser.id]);
    await this.dataSource.query("DELETE FROM monthly_account_balances WHERE user_id = $1", [demoUser.id]);
    await this.dataSource.query("DELETE FROM custom_reports WHERE user_id = $1", [demoUser.id]);
    await this.dataSource.query("DELETE FROM payees WHERE user_id = $1", [demoUser.id]);
    await this.dataSource.query("DELETE FROM accounts WHERE user_id = $1", [demoUser.id]);
    await this.dataSource.query("DELETE FROM categories WHERE user_id = $1", [demoUser.id]);
    await this.dataSource.query("DELETE FROM user_preferences WHERE user_id = $1", [demoUser.id]);

    await this.seedDemoData(demoUser.id);

    console.log("\n🎭 DEMO database seeding completed!");
  }

  /**
   * Seed all demo data for a given user ID.
   * Used by both initial seed and daily reset.
   */
  async seedDemoData(userId: string): Promise<void> {
    const categoryMap = await this.seedCategories(userId);
    const accountMap = await this.seedAccounts(userId);
    const payeeMap = await this.seedPayees(userId, categoryMap);
    await this.seedTransactions(userId, accountMap, categoryMap, payeeMap);
    await this.seedScheduledTransactions(userId, accountMap, categoryMap, payeeMap);
    await this.seedSecurities(userId, accountMap);
    await this.seedReports(userId);
    await this.seedPreferences(userId);
  }

  private async seedCategories(
    userId: string,
  ): Promise<Map<string, string>> {
    console.log("📁 Seeding demo categories...");

    const categoryMap = new Map<string, string>();

    // Income categories
    const incomeCategories = [
      { name: "Salary", icon: "💰", color: "#2ECC71" },
      { name: "Freelance", icon: "💼", color: "#1ABC9C" },
      { name: "Investment Income", icon: "📈", color: "#3498DB" },
      { name: "Other Income", icon: "💵", color: "#16A085" },
    ];

    for (const cat of incomeCategories) {
      const result = await this.dataSource.query(
        `INSERT INTO categories (user_id, name, icon, color, is_income)
         VALUES ($1, $2, $3, $4, true) RETURNING id`,
        [userId, cat.name, cat.icon, cat.color],
      );
      categoryMap.set(cat.name, result[0].id);
    }

    // Expense categories with subcategories
    const expenseCategories = [
      {
        name: "Housing",
        icon: "🏠",
        color: "#E74C3C",
        subs: ["Rent/Mortgage", "Utilities", "Property Tax", "Maintenance"],
      },
      {
        name: "Transportation",
        icon: "🚗",
        color: "#3498DB",
        subs: ["Fuel", "Public Transit", "Car Insurance", "Maintenance"],
      },
      {
        name: "Food",
        icon: "🍽️",
        color: "#E67E22",
        subs: ["Groceries", "Restaurants", "Coffee Shops"],
      },
      {
        name: "Shopping",
        icon: "🛍️",
        color: "#9B59B6",
        subs: ["Clothing", "Electronics", "Home Goods"],
      },
      {
        name: "Entertainment",
        icon: "🎬",
        color: "#F39C12",
        subs: ["Movies", "Concerts", "Streaming Services", "Games"],
      },
      {
        name: "Health",
        icon: "⚕️",
        color: "#27AE60",
        subs: ["Insurance", "Doctor Visits", "Pharmacy", "Gym"],
      },
      {
        name: "Education",
        icon: "📚",
        color: "#2980B9",
        subs: ["Tuition", "Books", "Courses"],
      },
      {
        name: "Personal Care",
        icon: "💇",
        color: "#8E44AD",
        subs: ["Haircut", "Cosmetics", "Spa"],
      },
      {
        name: "Bills & Utilities",
        icon: "📄",
        color: "#C0392B",
        subs: ["Phone", "Internet", "Electricity", "Water", "Insurance"],
      },
      { name: "Gifts & Donations", icon: "🎁", color: "#E91E63", subs: [] },
      { name: "Travel", icon: "✈️", color: "#00BCD4", subs: [] },
      { name: "Miscellaneous", icon: "📌", color: "#95A5A6", subs: [] },
    ];

    for (const cat of expenseCategories) {
      const parentResult = await this.dataSource.query(
        `INSERT INTO categories (user_id, name, icon, color, is_income)
         VALUES ($1, $2, $3, $4, false) RETURNING id`,
        [userId, cat.name, cat.icon, cat.color],
      );
      const parentId = parentResult[0].id;
      categoryMap.set(cat.name, parentId);

      for (const subName of cat.subs) {
        const subResult = await this.dataSource.query(
          `INSERT INTO categories (user_id, parent_id, name, is_income)
           VALUES ($1, $2, $3, false) RETURNING id`,
          [userId, parentId, subName],
        );
        categoryMap.set(`${cat.name} > ${subName}`, subResult[0].id);
      }
    }

    console.log(`   ✓ Seeded ${categoryMap.size} categories`);
    return categoryMap;
  }

  private async seedAccounts(
    userId: string,
  ): Promise<Map<string, string>> {
    console.log("💳 Seeding demo accounts...");

    const accountMap = new Map<string, string>();

    // Set created_at to 12 months ago so the net worth service generates
    // monthly balance snapshots starting from the beginning of the demo period
    const createdAt = new Date();
    createdAt.setMonth(createdAt.getMonth() - 12);
    const createdAtStr = createdAt.toISOString();

    for (const acc of demoAccounts) {
      const result = await this.dataSource.query(
        `INSERT INTO accounts (
          user_id, account_type, name, description, currency_code,
          opening_balance, current_balance, credit_limit, interest_rate,
          institution, is_favourite,
          is_canadian_mortgage, is_variable_rate, term_months, amortization_months, original_principal,
          payment_amount, payment_frequency,
          created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
        RETURNING id`,
        [
          userId,
          acc.type,
          acc.name,
          acc.description,
          acc.currency,
          acc.openingBalance,
          acc.openingBalance,
          acc.creditLimit || null,
          acc.interestRate || null,
          acc.institution || null,
          acc.isFavourite || false,
          acc.isCanadianMortgage || false,
          acc.isVariableRate || false,
          acc.termMonths || null,
          acc.amortizationMonths || null,
          acc.originalPrincipal || null,
          acc.paymentAmount || null,
          acc.paymentFrequency || null,
          createdAtStr,
        ],
      );
      accountMap.set(acc.key, result[0].id);
    }

    // Set mortgage term_end_date
    const mortgageId = accountMap.get("mortgage");
    if (mortgageId) {
      const termEnd = new Date();
      termEnd.setFullYear(termEnd.getFullYear() + 3); // 3 years remaining on 5-year term
      await this.dataSource.query(
        "UPDATE accounts SET term_end_date = $1 WHERE id = $2",
        [termEnd.toISOString().split("T")[0], mortgageId],
      );
    }

    console.log(`   ✓ Seeded ${demoAccounts.length} accounts`);
    return accountMap;
  }

  private async seedPayees(
    userId: string,
    categoryMap: Map<string, string>,
  ): Promise<Map<string, string>> {
    console.log("👥 Seeding demo payees...");

    const payeeMap = new Map<string, string>();

    for (const payee of demoPayees) {
      const categoryId = categoryMap.get(payee.categoryPath) || null;
      const result = await this.dataSource.query(
        `INSERT INTO payees (user_id, name, default_category_id)
         VALUES ($1, $2, $3)
         ON CONFLICT (user_id, name) DO NOTHING
         RETURNING id`,
        [userId, payee.name, categoryId],
      );
      if (result.length > 0) {
        payeeMap.set(payee.name, result[0].id);
      }
    }

    // Add Transfer payee
    const transferResult = await this.dataSource.query(
      `INSERT INTO payees (user_id, name)
       VALUES ($1, $2)
       ON CONFLICT (user_id, name) DO NOTHING
       RETURNING id`,
      [userId, "Transfer"],
    );
    if (transferResult.length > 0) {
      payeeMap.set("Transfer", transferResult[0].id);
    }

    console.log(`   ✓ Seeded ${payeeMap.size} payees`);
    return payeeMap;
  }

  private async seedTransactions(
    userId: string,
    accountMap: Map<string, string>,
    categoryMap: Map<string, string>,
    payeeMap: Map<string, string>,
  ): Promise<void> {
    console.log("💸 Seeding demo transactions...");

    const transactions = generateTransactions(new Date());
    let count = 0;
    let splitCount = 0;
    let transferCount = 0;

    for (const tx of transactions) {
      const accountId = accountMap.get(tx.accountKey);
      if (!accountId) continue;

      const categoryId = categoryMap.get(tx.categoryPath) || null;
      const payeeId = payeeMap.get(tx.payeeName) || null;
      const currencyCode = tx.currencyCode || "CAD";

      if (tx.isTransfer && tx.transferAccountKey) {
        // Create transfer: two linked transactions
        const transferAccountId = accountMap.get(tx.transferAccountKey);
        if (!transferAccountId) continue;

        const [fromTx] = await this.dataSource.query(
          `INSERT INTO transactions (
            user_id, account_id, transaction_date, payee_id, payee_name,
            amount, currency_code, description, is_cleared, is_reconciled, status,
            is_transfer
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, true)
          RETURNING id`,
          [
            userId, accountId, tx.date, payeeId, tx.payeeName,
            tx.amount, currencyCode, tx.description,
            tx.isCleared, tx.isReconciled, tx.status,
          ],
        );

        const [toTx] = await this.dataSource.query(
          `INSERT INTO transactions (
            user_id, account_id, transaction_date, payee_id, payee_name,
            amount, currency_code, description, is_cleared, is_reconciled, status,
            is_transfer, linked_transaction_id
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, true, $12)
          RETURNING id`,
          [
            userId, transferAccountId, tx.date, payeeId, tx.payeeName,
            -tx.amount, currencyCode, tx.description,
            tx.isCleared, tx.isReconciled, tx.status,
            fromTx.id,
          ],
        );

        await this.dataSource.query(
          "UPDATE transactions SET linked_transaction_id = $1 WHERE id = $2",
          [toTx.id, fromTx.id],
        );

        transferCount++;
        count += 2;
      } else if (tx.isSplit && tx.splits) {
        // Create split transaction
        const [parentTx] = await this.dataSource.query(
          `INSERT INTO transactions (
            user_id, account_id, transaction_date, payee_id, payee_name,
            amount, currency_code, description, is_cleared, is_reconciled, status,
            is_split
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, true)
          RETURNING id`,
          [
            userId, accountId, tx.date, payeeId, tx.payeeName,
            tx.amount, currencyCode, tx.description,
            tx.isCleared, tx.isReconciled, tx.status,
          ],
        );

        for (const split of tx.splits) {
          const splitCategoryId = categoryMap.get(split.categoryPath) || null;
          await this.dataSource.query(
            `INSERT INTO transaction_splits (transaction_id, category_id, amount, memo)
             VALUES ($1, $2, $3, $4)`,
            [parentTx.id, splitCategoryId, split.amount, split.memo],
          );
        }

        splitCount++;
        count++;
      } else {
        // Regular transaction
        await this.dataSource.query(
          `INSERT INTO transactions (
            user_id, account_id, transaction_date, payee_id, payee_name,
            category_id, amount, currency_code, description,
            is_cleared, is_reconciled, status
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
          [
            userId, accountId, tx.date, payeeId, tx.payeeName,
            categoryId, tx.amount, currencyCode, tx.description,
            tx.isCleared, tx.isReconciled, tx.status,
          ],
        );
        count++;
      }
    }

    // Update account balances based on transactions
    for (const [key, accountId] of accountMap) {
      const [result] = await this.dataSource.query(
        `SELECT COALESCE(SUM(amount), 0) as total FROM transactions
         WHERE account_id = $1 AND user_id = $2`,
        [accountId, userId],
      );
      const openingBalance = demoAccounts.find((a) => a.key === key)?.openingBalance || 0;
      await this.dataSource.query(
        "UPDATE accounts SET current_balance = $1 WHERE id = $2",
        [openingBalance + parseFloat(result.total), accountId],
      );
    }

    console.log(`   ✓ Seeded ${count} transactions (${splitCount} splits, ${transferCount} transfers)`);
  }

  private async seedScheduledTransactions(
    userId: string,
    accountMap: Map<string, string>,
    categoryMap: Map<string, string>,
    payeeMap: Map<string, string>,
  ): Promise<void> {
    console.log("🔄 Seeding scheduled transactions...");

    const now = new Date();

    for (const st of demoScheduledTransactions) {
      const accountId = accountMap.get(st.accountKey);
      if (!accountId) continue;

      const categoryId = categoryMap.get(st.categoryPath) || null;
      const payeeId = payeeMap.get(st.payeeName) || null;
      const transferAccountId = st.transferAccountKey
        ? accountMap.get(st.transferAccountKey) || null
        : null;

      // Calculate next due date
      const nextDue = new Date(now.getFullYear(), now.getMonth(), st.dueDayOfMonth);
      if (nextDue <= now) {
        nextDue.setMonth(nextDue.getMonth() + 1);
      }

      // Start date is 12 months ago
      const startDate = new Date(now);
      startDate.setMonth(startDate.getMonth() - 12);
      startDate.setDate(st.dueDayOfMonth);

      await this.dataSource.query(
        `INSERT INTO scheduled_transactions (
          user_id, account_id, name, payee_id, payee_name,
          category_id, amount, currency_code, frequency,
          next_due_date, start_date, is_active, auto_post,
          is_transfer, transfer_account_id
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, true, $12, $13, $14)`,
        [
          userId,
          accountId,
          st.name,
          payeeId,
          st.payeeName,
          categoryId,
          st.amount,
          "CAD",
          st.frequency,
          nextDue.toISOString().split("T")[0],
          startDate.toISOString().split("T")[0],
          st.autoPost,
          st.isTransfer || false,
          transferAccountId,
        ],
      );
    }

    console.log(`   ✓ Seeded ${demoScheduledTransactions.length} scheduled transactions`);
  }

  private async seedSecurities(
    userId: string,
    accountMap: Map<string, string>,
  ): Promise<void> {
    console.log("📊 Seeding securities, prices, and holdings...");

    const now = new Date();
    let priceCount = 0;

    for (const sec of demoSecurities) {
      const accountId = accountMap.get(sec.accountKey);
      if (!accountId) continue;

      // Create security
      const [security] = await this.dataSource.query(
        `INSERT INTO securities (user_id, symbol, name, security_type, exchange, currency_code)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id`,
        [userId, sec.symbol, sec.name, sec.type, sec.exchange, sec.currency],
      );

      // Generate and insert price history
      const prices = generatePriceHistory(sec, now, 12);
      for (const price of prices) {
        await this.dataSource.query(
          `INSERT INTO security_prices (security_id, price_date, close_price, source)
           VALUES ($1, $2, $3, 'demo-seed')
           ON CONFLICT (security_id, price_date) DO NOTHING`,
          [security.id, price.date, price.close],
        );
        priceCount++;
      }

      // Create holding
      await this.dataSource.query(
        `INSERT INTO holdings (account_id, security_id, quantity, average_cost)
         VALUES ($1, $2, $3, $4)`,
        [accountId, security.id, sec.quantity, sec.averageCost],
      );

      // Create a few BUY investment transactions spread across the year
      const buyDates = [3, 6, 9].map((monthsAgo) => {
        const d = new Date(now);
        d.setMonth(d.getMonth() - monthsAgo);
        d.setDate(10);
        return d;
      });

      const quantityPerBuy = Math.floor(sec.quantity / 3);
      for (const buyDate of buyDates) {
        const qty = quantityPerBuy;
        const total = qty * sec.averageCost;
        await this.dataSource.query(
          `INSERT INTO investment_transactions (
            user_id, account_id, security_id, action, transaction_date,
            quantity, price, commission, total_amount, description
          ) VALUES ($1, $2, $3, 'BUY', $4, $5, $6, $7, $8, $9)`,
          [
            userId,
            accountId,
            security.id,
            buyDate.toISOString().split("T")[0],
            qty,
            sec.averageCost,
            9.99,
            total + 9.99,
            `Buy ${qty} ${sec.symbol}`,
          ],
        );
      }

      // Quarterly dividend (for ETFs)
      if (sec.type === "ETF") {
        for (const monthsAgo of [2, 5, 8, 11]) {
          const divDate = new Date(now);
          divDate.setMonth(divDate.getMonth() - monthsAgo);
          divDate.setDate(15);
          const divAmount = Math.round(sec.quantity * sec.basePrice * 0.005 * 100) / 100;

          await this.dataSource.query(
            `INSERT INTO investment_transactions (
              user_id, account_id, security_id, action, transaction_date,
              quantity, price, total_amount, description
            ) VALUES ($1, $2, $3, 'DIVIDEND', $4, $5, $6, $7, $8)`,
            [
              userId,
              accountId,
              security.id,
              divDate.toISOString().split("T")[0],
              0,
              0,
              divAmount,
              `Dividend - ${sec.symbol}`,
            ],
          );
        }
      }
    }

    console.log(
      `   ✓ Seeded ${demoSecurities.length} securities, ${priceCount} price records, holdings, and investment transactions`,
    );
  }

  private async seedReports(userId: string): Promise<void> {
    console.log("📋 Seeding custom reports...");

    for (const report of demoReports) {
      await this.dataSource.query(
        `INSERT INTO custom_reports (
          user_id, name, description, icon, background_color,
          view_type, timeframe_type, group_by, filters, config,
          is_favourite, sort_order
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [
          userId,
          report.name,
          report.description,
          report.icon,
          report.backgroundColor,
          report.viewType,
          report.timeframeType,
          report.groupBy,
          JSON.stringify(report.filters),
          JSON.stringify(report.config),
          report.isFavourite,
          report.sortOrder,
        ],
      );
    }

    console.log(`   ✓ Seeded ${demoReports.length} custom reports`);
  }

  private async seedPreferences(userId: string): Promise<void> {
    console.log("⚙️ Seeding user preferences...");

    const p = demoPreferences;
    await this.dataSource.query(
      `INSERT INTO user_preferences (
        user_id, default_currency, date_format, number_format, theme,
        timezone, notification_email, notification_browser,
        two_factor_enabled, getting_started_dismissed
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      ON CONFLICT (user_id) DO UPDATE SET
        default_currency = $2, date_format = $3, number_format = $4,
        theme = $5, timezone = $6, notification_email = $7,
        notification_browser = $8, two_factor_enabled = $9,
        getting_started_dismissed = $10`,
      [
        userId,
        p.defaultCurrency,
        p.dateFormat,
        p.numberFormat,
        p.theme,
        p.timezone,
        p.notificationEmail,
        p.notificationBrowser,
        p.twoFactorEnabled,
        p.gettingStartedDismissed,
      ],
    );

    console.log("   ✓ Seeded user preferences");
  }
}
