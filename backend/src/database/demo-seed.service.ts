import { Injectable, Logger } from "@nestjs/common";
import { DataSource } from "typeorm";
import { withScopedDb } from "../common/db/scoped-db";
import { mapWithConcurrency } from "../common/concurrency.util";
import { todayYMD } from "../common/date-utils";

import { withSystemContext } from "../common/db/with-context";
import { SeedService } from "./seed.service";
import { DEMO_USER_EMAIL } from "./demo-credentials";
import { FaviconService } from "../common/favicon/favicon.service";
import { demoAccounts } from "./demo-seed-data/accounts";
import { demoInstitutions } from "./demo-seed-data/institutions";
import { demoPayees } from "./demo-seed-data/payees";
import { generateTransactions } from "./demo-seed-data/transactions";
import { roundFxRate } from "../common/fx-entry.util";
import { moneyDecimalsFor, sumMoney } from "../common/round.util";
import {
  DEMO_CRYPTO_CURRENCY,
  DEMO_CRYPTO_RATE_SOURCE,
  generateDemoCryptoRates,
  upsertDemoCryptoCurrency,
} from "./demo-seed-data/crypto-rates";
import { ExchangeRateService } from "../currencies/exchange-rate.service";
import {
  DEMO_PAYROLL_BILL_NAME,
  demoScheduledTransactions,
} from "./demo-seed-data/scheduled";
import {
  demoSecurities,
  generatePriceHistory,
} from "./demo-seed-data/securities";
import { demoReports } from "./demo-seed-data/reports";
import { demoPreferences } from "./demo-seed-data/preferences";
import { demoWarranties } from "./demo-seed-data/warranties";
import { demoSharedGroups } from "./demo-seed-data/shared-expenses";
import { demoPayrollDeductions } from "./demo-seed-data/payroll";
import { clearDemoUserData } from "./demo-clear";

/**
 * Favicon fetches in flight while seeding payees. Bounded rather than one
 * `Promise.all` over every payee: the resolver is a third party and a demo
 * seed should not arrive as a burst of forty simultaneous requests.
 */
const PAYEE_LOGO_CONCURRENCY = 6;

/** A demo account's currency, by its key; CAD for a key the demo lacks. */
function demoAccountCurrency(key: string): string {
  return demoAccounts.find((a) => a.key === key)?.currency ?? "CAD";
}

/**
 * The money precision of a demo account's currency: the coin's own eight
 * places for the wallet, four for every fiat account
 * (`docs/specs/money-precision.md` decision 2).
 */
function demoAccountMoneyDecimals(key: string): number {
  return moneyDecimalsFor(
    demoAccountCurrency(key) === DEMO_CRYPTO_CURRENCY.code
      ? DEMO_CRYPTO_CURRENCY.decimals
      : null,
  );
}

/**
 * The counterpart of a transfer (or a split's transfer line) moving `amount`
 * out of, or into, an account in `fromCurrency`: the opposite amount at rate 1
 * when the two accounts share a currency, otherwise the stated received amount
 * signed opposite to `amount`, at `roundFxRate(received / |amount|)`
 * (INV-SPLITFX-001 (a); `transferLegColumns`).
 */
export function counterpartLeg(
  amount: number,
  fromCurrency: string,
  toCurrency: string,
  received: number | undefined,
): { amount: number; currencyCode: string; exchangeRate: number } {
  if (fromCurrency === toCurrency || received === undefined) {
    if (fromCurrency !== toCurrency) {
      throw new Error(
        `Demo transfer ${fromCurrency} -> ${toCurrency} states no received amount`,
      );
    }
    return { amount: -amount, currencyCode: toCurrency, exchangeRate: 1 };
  }
  return {
    amount: amount < 0 ? Math.abs(received) : -Math.abs(received),
    currencyCode: toCurrency,
    exchangeRate: roundFxRate(Math.abs(received) / Math.abs(amount)),
  };
}

@Injectable()
export class DemoSeedService {
  private readonly logger = new Logger(DemoSeedService.name);

  constructor(
    private dataSource: DataSource,
    private seedService: SeedService,
    private logoService: FaviconService,
    private readonly exchangeRates: ExchangeRateService,
  ) {}

  /**
   * Full demo seed: currencies + demo user + rich demo data.
   */
  async seedAll(): Promise<void> {
    this.logger.log("Starting DEMO database seeding");
    // RLS (task C3): cross-user demo seed (clears + re-seeds the demo user's
    // data via raw SQL) -- runs under a system context.
    return withSystemContext(() => this.seedAllWithinContext());
  }

  private async seedAllWithinContext(): Promise<void> {
    // Seed currencies via existing service
    await this.seedService.seedAll();

    // Get the demo user ID (created by seedService)
    const [demoUser] = await withScopedDb(this.dataSource, (manager) =>
      manager.query("SELECT id FROM users WHERE email = $1", [DEMO_USER_EMAIL]),
    );

    if (!demoUser) {
      throw new Error("Demo user not found after base seeding");
    }

    // Delete base seed data so we can replace with richer demo data
    await withScopedDb(this.dataSource, (manager) =>
      clearDemoUserData(manager, demoUser.id),
    );

    await this.seedDemoData(demoUser.id);

    this.logger.log("DEMO database seeding completed");
  }

  /**
   * Seed all demo data for a given user ID.
   * Used by both initial seed and daily reset.
   */
  async seedDemoData(userId: string): Promise<void> {
    // RLS (task C3): also called directly by the daily demo reset -- runs under
    // a system context so its cross-user seeding keeps working.
    return withSystemContext(() => this.seedDemoDataWithinContext(userId));
  }

  private async seedDemoDataWithinContext(userId: string): Promise<void> {
    // The coin first: the Bitcoin Wallet's `currency_code` references it, and
    // the daily reset reaches here without the base seed's currencies.
    const coinSeeded = await this.seedCryptoRates();
    const categoryMap = await this.seedCategories(userId);
    const institutionMap = await this.seedInstitutions(userId);
    const accountMap = await this.seedAccounts(
      userId,
      institutionMap,
      categoryMap,
      coinSeeded,
    );
    const payeeMap = await this.seedPayees(userId, categoryMap);
    await this.seedTransactions(userId, accountMap, categoryMap, payeeMap);
    const scheduledMap = await this.seedScheduledTransactions(
      userId,
      accountMap,
      categoryMap,
      payeeMap,
    );
    await this.seedPayrollDeductionRules(userId, categoryMap, scheduledMap);
    await this.seedWarranties(userId, payeeMap);
    await this.seedSharedExpenses(userId);
    await this.seedSecurities(userId, accountMap);
    await this.seedReports(userId);
    await this.seedPreferences(userId);
  }

  /**
   * The demo coin and its `BTC -> CAD` rates for the demo window, so the
   * wallet converts from the first day of its history. Global rows
   * (`currencies` and `exchange_rates` have no owner); the coin first, since
   * the rates reference it, then the series through the rate writer, which
   * orients each row (INV-FX-003) and replaces the window's days on every
   * reset.
   *
   * Resolves `false` when the code already exists as a FIAT currency, which
   * the upsert leaves alone (INV-CRYPTO-001's kind gate is not bypassed by a
   * seed): no coin rates are stored for it (a fiat code priced under the
   * crypto slug would break INV-CRYPTO-002), and the seed leaves out the
   * wallet and its transactions rather than writing a CRYPTO account in a fiat
   * currency. The rest of the demo seeds as usual.
   */
  private async seedCryptoRates(): Promise<boolean> {
    this.logger.log("Seeding demo cryptocurrency and its exchange rates");
    const coinSeeded = await withScopedDb(this.dataSource, (manager) =>
      upsertDemoCryptoCurrency(manager),
    );
    if (!coinSeeded) {
      this.logger.warn(
        `${DEMO_CRYPTO_CURRENCY.code} exists as a FIAT currency and was not re-typed to CRYPTO; the demo's crypto wallet, its transactions and its ${DEMO_CRYPTO_CURRENCY.code} rates are not seeded`,
      );
      return false;
    }
    await this.exchangeRates.storeRateSeries(
      generateDemoCryptoRates(todayYMD()),
      DEMO_CRYPTO_RATE_SOURCE,
    );
    return true;
  }

  private async seedCategories(userId: string): Promise<Map<string, string>> {
    this.logger.log("Seeding demo categories");

    const categoryMap = new Map<string, string>();

    // Income categories
    const incomeCategories = [
      { name: "Salary", icon: "💰", color: "#2ECC71" },
      { name: "Freelance", icon: "💼", color: "#1ABC9C" },
      { name: "Investment Income", icon: "📈", color: "#3498DB" },
      { name: "Other Income", icon: "💵", color: "#16A085" },
    ];

    for (const cat of incomeCategories) {
      const result = await withScopedDb(this.dataSource, (manager) =>
        manager.query(
          `INSERT INTO categories (user_id, name, icon, color, is_income)
         VALUES ($1, $2, $3, $4, true) RETURNING id`,
          [userId, cat.name, cat.icon, cat.color],
        ),
      );
      categoryMap.set(cat.name, result[0].id);
    }

    // Expense categories with subcategories
    const expenseCategories = [
      {
        name: "Housing",
        icon: "🏠",
        color: "#E74C3C",
        subs: [
          "Rent/Mortgage",
          "Mortgage Interest",
          "Utilities",
          "Property Tax",
          "Maintenance",
        ],
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
      // Withheld from each paycheque; the payroll deduction rules cap CPP and EI.
      {
        name: "Payroll Taxes",
        icon: "🧾",
        color: "#6C5CE7",
        subs: ["Income Tax", "CPP", "EI"],
      },
      { name: "Gifts & Donations", icon: "🎁", color: "#E91E63", subs: [] },
      { name: "Travel", icon: "✈️", color: "#00BCD4", subs: [] },
      { name: "Miscellaneous", icon: "📌", color: "#95A5A6", subs: [] },
      // The Bitcoin Wallet's network fee (crypto-accounts spec decision 9).
      { name: "Fees", icon: null, color: "#7F8C8D", subs: ["Network fee"] },
    ];

    for (const cat of expenseCategories) {
      const parentResult = await withScopedDb(this.dataSource, (manager) =>
        manager.query(
          `INSERT INTO categories (user_id, name, icon, color, is_income)
         VALUES ($1, $2, $3, $4, false) RETURNING id`,
          [userId, cat.name, cat.icon, cat.color],
        ),
      );
      const parentId = parentResult[0].id;
      categoryMap.set(cat.name, parentId);

      for (const subName of cat.subs) {
        const subResult = await withScopedDb(this.dataSource, (manager) =>
          manager.query(
            `INSERT INTO categories (user_id, parent_id, name, is_income)
           VALUES ($1, $2, $3, false) RETURNING id`,
            [userId, parentId, subName],
          ),
        );
        categoryMap.set(`${cat.name} > ${subName}`, subResult[0].id);
      }
    }

    this.logger.log(`Seeded ${categoryMap.size} categories`);
    return categoryMap;
  }

  /**
   * Seed the institutions referenced by the demo accounts and return a map of
   * institution name -> id for linking. Brand logos are fetched best-effort:
   * when the favicon resolver is unreachable the institution simply renders
   * with its letter-badge fallback, exactly as a real best-effort create would.
   */
  private async seedInstitutions(userId: string): Promise<Map<string, string>> {
    this.logger.log("Seeding demo institutions");

    const institutionMap = new Map<string, string>();

    const logos = await Promise.all(
      demoInstitutions.map((inst) =>
        this.logoService.fetchFavicon(inst.website).catch(() => null),
      ),
    );

    for (let i = 0; i < demoInstitutions.length; i++) {
      const inst = demoInstitutions[i];
      const logo = logos[i];
      const result = await withScopedDb(this.dataSource, (manager) =>
        manager.query(
          `INSERT INTO institutions (
          user_id, name, website, country,
          logo_data, logo_content_type, has_logo, logo_fetched_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        RETURNING id`,
          [
            userId,
            inst.name,
            inst.website,
            inst.country,
            logo ? logo.data : null,
            logo ? logo.contentType : null,
            logo ? true : false,
            logo ? new Date().toISOString() : null,
          ],
        ),
      );
      institutionMap.set(inst.name, result[0].id);
    }

    this.logger.log(`Seeded ${institutionMap.size} institutions`);
    return institutionMap;
  }

  private async seedAccounts(
    userId: string,
    institutionMap: Map<string, string>,
    categoryMap: Map<string, string>,
    coinSeeded: boolean,
  ): Promise<Map<string, string>> {
    this.logger.log("Seeding demo accounts");

    const accountMap = new Map<string, string>();

    // Set created_at to 12 months ago so the net worth service generates
    // monthly balance snapshots starting from the beginning of the demo period
    const createdAt = new Date();
    createdAt.setMonth(createdAt.getMonth() - 12);
    const createdAtStr = createdAt.toISOString();

    for (const acc of demoAccounts) {
      // An account in the coin is left out when the coin is not one (see
      // seedCryptoRates); its transactions then find no account and are
      // skipped with it.
      if (!coinSeeded && acc.currency === DEMO_CRYPTO_CURRENCY.code) continue;
      const institutionId = acc.institution
        ? (institutionMap.get(acc.institution) ?? null)
        : null;
      if (acc.isInvestmentPair) {
        // Create investment account pair: cash + brokerage with bidirectional linking
        const [cashAccount] = await withScopedDb(this.dataSource, (manager) =>
          manager.query(
            `INSERT INTO accounts (
            user_id, account_type, account_sub_type, name, description, currency_code,
            opening_balance, current_balance, institution, institution_id, is_favourite, created_at
          ) VALUES ($1, 'INVESTMENT', 'INVESTMENT_CASH', $2, $3, $4, $5, $6, $7, $8, $9, $10)
          RETURNING id`,
            [
              userId,
              `${acc.name} - Cash`,
              acc.description,
              acc.currency,
              acc.openingBalance,
              acc.openingBalance,
              acc.institution || null,
              institutionId,
              acc.isFavourite || false,
              createdAtStr,
            ],
          ),
        );

        const [brokerageAccount] = await withScopedDb(
          this.dataSource,
          (manager) =>
            manager.query(
              `INSERT INTO accounts (
            user_id, account_type, account_sub_type, name, description, currency_code,
            opening_balance, current_balance, institution, institution_id, is_favourite,
            linked_account_id, created_at
          ) VALUES ($1, 'INVESTMENT', 'INVESTMENT_BROKERAGE', $2, $3, $4, 0, 0, $5, $6, $7, $8, $9)
          RETURNING id`,
              [
                userId,
                `${acc.name} - Brokerage`,
                acc.description,
                acc.currency,
                acc.institution || null,
                institutionId,
                acc.isFavourite || false,
                cashAccount.id,
                createdAtStr,
              ],
            ),
        );

        // Link cash account back to brokerage
        await withScopedDb(this.dataSource, (manager) =>
          manager.query(
            "UPDATE accounts SET linked_account_id = $1 WHERE id = $2",
            [brokerageAccount.id, cashAccount.id],
          ),
        );

        // Map the key to the brokerage account (securities/holdings go here)
        accountMap.set(acc.key, brokerageAccount.id);
        // Also store the cash account ID for balance updates
        accountMap.set(`${acc.key}_cash`, cashAccount.id);
      } else {
        const result = await withScopedDb(this.dataSource, (manager) =>
          manager.query(
            `INSERT INTO accounts (
            user_id, account_type, name, description, currency_code,
            opening_balance, current_balance, credit_limit, interest_rate,
            institution, institution_id, is_favourite,
            mortgage_type, term_months, amortization_months, original_principal,
            payment_amount, payment_frequency, interest_category_id,
            created_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)
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
              institutionId,
              acc.isFavourite || false,
              acc.mortgageType ?? "ANNUITY",
              acc.termMonths || null,
              acc.amortizationMonths || null,
              acc.originalPrincipal || null,
              acc.paymentAmount || null,
              acc.paymentFrequency || null,
              acc.interestCategoryPath
                ? (categoryMap.get(acc.interestCategoryPath) ?? null)
                : null,
              createdAtStr,
            ],
          ),
        );
        accountMap.set(acc.key, result[0].id);
      }
    }

    // Set mortgage term_end_date
    const mortgageId = accountMap.get("mortgage");
    if (mortgageId) {
      const termEnd = new Date();
      termEnd.setFullYear(termEnd.getFullYear() + 3); // 3 years remaining on 5-year term
      await withScopedDb(this.dataSource, (manager) =>
        manager.query("UPDATE accounts SET term_end_date = $1 WHERE id = $2", [
          termEnd.toISOString().split("T")[0],
          mortgageId,
        ]),
      );
    }

    this.logger.log(`Seeded ${accountMap.size} accounts`);
    return accountMap;
  }

  /**
   * Seed the demo payees, their contact details and their brand icons.
   *
   * Contact details are written as the user's own: `contact_lookup_at` and
   * `contact_lookup_source` stay NULL, so the demo shows what a filled-in
   * payee looks like rather than one the lookup answered for, and the
   * background enrichment is still free to run on a payee that has none.
   *
   * Logos are fetched best-effort and bounded, like the institutions above:
   * an unreachable favicon resolver leaves the payee on its letter badge,
   * which is what a real create does too.
   */
  private async seedPayees(
    userId: string,
    categoryMap: Map<string, string>,
  ): Promise<Map<string, string>> {
    this.logger.log("Seeding demo payees");

    const payeeMap = new Map<string, string>();

    const logos = await mapWithConcurrency(
      demoPayees,
      PAYEE_LOGO_CONCURRENCY,
      (payee) =>
        payee.website
          ? this.logoService.fetchFavicon(payee.website).catch(() => null)
          : Promise.resolve(null),
    );

    for (let i = 0; i < demoPayees.length; i++) {
      const payee = demoPayees[i];
      const logo = logos[i];
      const categoryId = categoryMap.get(payee.categoryPath) || null;
      const result = await withScopedDb(this.dataSource, (manager) =>
        manager.query(
          `INSERT INTO payees (
           user_id, name, default_category_id, website, address, phone,
           logo_data, logo_content_type, has_logo, logo_fetched_at
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (user_id, name) DO NOTHING
         RETURNING id`,
          [
            userId,
            payee.name,
            categoryId,
            payee.website ?? null,
            payee.address ?? null,
            payee.phone ?? null,
            logo ? logo.data : null,
            logo ? logo.contentType : null,
            logo ? true : false,
            // The column records the last attempt, so a website whose favicon
            // did not resolve is stamped and a payee with no website stays
            // null -- what `brandLogoColumns` writes on a real create.
            payee.website ? new Date().toISOString() : null,
          ],
        ),
      );
      if (result.length > 0) {
        payeeMap.set(payee.name, result[0].id);
      }
    }

    // Add Transfer payee
    const transferResult = await withScopedDb(this.dataSource, (manager) =>
      manager.query(
        `INSERT INTO payees (user_id, name)
       VALUES ($1, $2)
       ON CONFLICT (user_id, name) DO NOTHING
       RETURNING id`,
        [userId, "Transfer"],
      ),
    );
    if (transferResult.length > 0) {
      payeeMap.set("Transfer", transferResult[0].id);
    }

    this.logger.log(`Seeded ${payeeMap.size} payees`);
    return payeeMap;
  }

  private async seedTransactions(
    userId: string,
    accountMap: Map<string, string>,
    categoryMap: Map<string, string>,
    payeeMap: Map<string, string>,
  ): Promise<void> {
    this.logger.log("Seeding demo transactions");

    const transactions = generateTransactions(new Date());
    let count = 0;
    let splitCount = 0;
    let transferCount = 0;

    for (const tx of transactions) {
      const accountId = accountMap.get(tx.accountKey);
      if (!accountId) continue;

      const categoryId = categoryMap.get(tx.categoryPath) || null;
      const payeeId = payeeMap.get(tx.payeeName) || null;
      // A row is in its account's currency (assertTransactionCurrencyMatchesAccount).
      const currencyCode =
        tx.currencyCode || demoAccountCurrency(tx.accountKey);

      if (tx.isTransfer && tx.transferAccountKey) {
        // Create transfer: two linked transactions
        const transferAccountId = accountMap.get(tx.transferAccountKey);
        if (!transferAccountId) continue;
        // The counterpart is in its own account's currency, at the amount that
        // arrived when the two differ, and carries the implied rate, as
        // `transferLegColumns` writes a transfer with a stated `toAmount`.
        const counterpart = counterpartLeg(
          tx.amount,
          currencyCode,
          demoAccountCurrency(tx.transferAccountKey),
          tx.transferToAmount,
        );

        const [fromTx] = await withScopedDb(this.dataSource, (manager) =>
          manager.query(
            `INSERT INTO transactions (
            user_id, account_id, transaction_date, payee_id, payee_name,
            amount, currency_code, description, status, is_transfer
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, true)
          RETURNING id`,
            [
              userId,
              accountId,
              tx.date,
              payeeId,
              tx.payeeName,
              tx.amount,
              currencyCode,
              tx.description,
              tx.status,
            ],
          ),
        );

        const [toTx] = await withScopedDb(this.dataSource, (manager) =>
          manager.query(
            `INSERT INTO transactions (
            user_id, account_id, transaction_date, payee_id, payee_name,
            amount, currency_code, exchange_rate, description, status,
            is_transfer, linked_transaction_id
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, true, $11)
          RETURNING id`,
            [
              userId,
              transferAccountId,
              tx.date,
              payeeId,
              tx.payeeName,
              counterpart.amount,
              counterpart.currencyCode,
              counterpart.exchangeRate,
              tx.description,
              tx.status,
              fromTx.id,
            ],
          ),
        );

        await withScopedDb(this.dataSource, (manager) =>
          manager.query(
            "UPDATE transactions SET linked_transaction_id = $1 WHERE id = $2",
            [toTx.id, fromTx.id],
          ),
        );

        transferCount++;
        count += 2;
      } else if (tx.isSplit && tx.splits) {
        // Create split transaction
        const [parentTx] = await withScopedDb(this.dataSource, (manager) =>
          manager.query(
            `INSERT INTO transactions (
            user_id, account_id, transaction_date, payee_id, payee_name,
            amount, currency_code, description, status, is_split
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, true)
          RETURNING id`,
            [
              userId,
              accountId,
              tx.date,
              payeeId,
              tx.payeeName,
              tx.amount,
              currencyCode,
              tx.description,
              tx.status,
            ],
          ),
        );

        for (const split of tx.splits) {
          if (split.transferAccountKey) {
            // A transfer leg: the split names the target account, and the
            // target holds a linked counterpart for the opposite amount, the
            // shape TransactionSplitService writes for a posted loan payment.
            const transferAccountId = accountMap.get(split.transferAccountKey);
            if (!transferAccountId) continue;
            await this.seedTransferSplit(userId, parentTx.id, {
              transferAccountId,
              amount: split.amount,
              memo: split.memo,
              date: tx.date,
              payeeId,
              payeeName: tx.payeeName,
              currencyCode,
              targetCurrencyCode: demoAccountCurrency(split.transferAccountKey),
              transferTargetAmount: split.transferTargetAmount,
              status: tx.status,
            });
            transferCount++;
            count++;
            continue;
          }
          const splitCategoryId = split.categoryPath
            ? categoryMap.get(split.categoryPath) || null
            : null;
          await withScopedDb(this.dataSource, (manager) =>
            manager.query(
              `INSERT INTO transaction_splits (transaction_id, category_id, amount, memo)
             VALUES ($1, $2, $3, $4)`,
              [parentTx.id, splitCategoryId, split.amount, split.memo],
            ),
          );
        }

        splitCount++;
        count++;
      } else {
        // Regular transaction
        await withScopedDb(this.dataSource, (manager) =>
          manager.query(
            `INSERT INTO transactions (
            user_id, account_id, transaction_date, payee_id, payee_name,
            category_id, amount, currency_code, description, status
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
            [
              userId,
              accountId,
              tx.date,
              payeeId,
              tx.payeeName,
              categoryId,
              tx.amount,
              currencyCode,
              tx.description,
              tx.status,
            ],
          ),
        );
        count++;
      }
    }

    // Update account balances based on transactions
    for (const [key, accountId] of accountMap) {
      // Skip internal keys (e.g., "rrsp_cash") — their balance is set at creation
      if (key.endsWith("_cash")) continue;

      const [result] = await withScopedDb(this.dataSource, (manager) =>
        manager.query(
          `SELECT COALESCE(SUM(amount), 0) as total FROM transactions
         WHERE account_id = $1 AND user_id = $2`,
          [accountId, userId],
        ),
      );
      const openingBalance =
        demoAccounts.find((a) => a.key === key)?.openingBalance || 0;
      // Summed at the account's precision: the column holds eight places, so
      // a float sum written as it stands would keep its noise.
      await withScopedDb(this.dataSource, (manager) =>
        manager.query(
          "UPDATE accounts SET current_balance = $1 WHERE id = $2",
          [
            sumMoney(
              [openingBalance, Number(result.total)],
              demoAccountMoneyDecimals(key),
            ),
            accountId,
          ],
        ),
      );
    }

    this.logger.log(
      `Seeded ${count} transactions (${splitCount} splits, ${transferCount} transfers)`,
    );
  }

  /**
   * One transfer leg of a split parent: the split row (`kind` 'transfer'), the
   * counterpart on the target account linked back to the parent, and the
   * split's link to that counterpart.
   */
  private async seedTransferSplit(
    userId: string,
    parentId: string,
    leg: {
      transferAccountId: string;
      amount: number;
      memo: string;
      date: string;
      payeeId: string | null;
      payeeName: string;
      currencyCode: string;
      /** The target account's currency, which the counterpart is in. */
      targetCurrencyCode: string;
      /** What arrived, unsigned, when the two currencies differ. */
      transferTargetAmount?: number;
      status: string;
    },
  ): Promise<void> {
    // INV-SPLITFX-001 (a): the counterpart is the stated received amount,
    // signed opposite to the line, at the implied rate.
    const counterpartColumns = counterpartLeg(
      leg.amount,
      leg.currencyCode,
      leg.targetCurrencyCode,
      leg.transferTargetAmount,
    );
    const [split] = await withScopedDb(this.dataSource, (manager) =>
      manager.query(
        `INSERT INTO transaction_splits (transaction_id, kind, transfer_account_id, amount, memo)
         VALUES ($1, 'transfer', $2, $3, $4)
         RETURNING id`,
        [parentId, leg.transferAccountId, leg.amount, leg.memo],
      ),
    );
    const [counterpart] = await withScopedDb(this.dataSource, (manager) =>
      manager.query(
        `INSERT INTO transactions (
        user_id, account_id, transaction_date, payee_id, payee_name,
        amount, currency_code, exchange_rate, description, status,
        is_transfer, linked_transaction_id
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, true, $11)
      RETURNING id`,
        [
          userId,
          leg.transferAccountId,
          leg.date,
          leg.payeeId,
          leg.payeeName,
          counterpartColumns.amount,
          counterpartColumns.currencyCode,
          counterpartColumns.exchangeRate,
          leg.memo,
          leg.status,
          parentId,
        ],
      ),
    );
    await withScopedDb(this.dataSource, (manager) =>
      manager.query(
        "UPDATE transaction_splits SET linked_transaction_id = $1 WHERE id = $2",
        [counterpart.id, split.id],
      ),
    );
  }

  private async seedScheduledTransactions(
    userId: string,
    accountMap: Map<string, string>,
    categoryMap: Map<string, string>,
    payeeMap: Map<string, string>,
  ): Promise<Map<string, string>> {
    this.logger.log("Seeding scheduled transactions");

    const now = new Date();
    const scheduledMap = new Map<string, string>();

    for (const st of demoScheduledTransactions) {
      const accountId = accountMap.get(st.accountKey);
      if (!accountId) continue;

      const categoryId = categoryMap.get(st.categoryPath) || null;
      const payeeId = payeeMap.get(st.payeeName) || null;
      const transferAccountId = st.transferAccountKey
        ? accountMap.get(st.transferAccountKey) || null
        : null;

      // Calculate next due date
      const nextDue = new Date(
        now.getFullYear(),
        now.getMonth(),
        st.dueDayOfMonth,
      );
      if (nextDue <= now) {
        nextDue.setMonth(nextDue.getMonth() + 1);
      }

      // Start date is 12 months ago
      const startDate = new Date(now);
      startDate.setMonth(startDate.getMonth() - 12);
      startDate.setDate(st.dueDayOfMonth);

      const scheduledId = await withScopedDb(
        this.dataSource,
        async (manager) => {
          const [row] = await manager.query(
            `INSERT INTO scheduled_transactions (
          user_id, account_id, name, payee_id, payee_name,
          category_id, amount, currency_code, frequency,
          next_due_date, start_date, is_active, auto_post,
          is_transfer, transfer_account_id, is_split
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, true, $12, $13, $14, $15)
        RETURNING id`,
            [
              userId,
              accountId,
              st.name,
              payeeId,
              st.payeeName,
              st.splits ? null : categoryId,
              st.amount,
              "CAD",
              st.frequency,
              nextDue.toISOString().split("T")[0],
              startDate.toISOString().split("T")[0],
              st.autoPost,
              st.isTransfer || false,
              transferAccountId,
              !!st.splits,
            ],
          );
          for (const split of st.splits ?? []) {
            await manager.query(
              `INSERT INTO scheduled_transaction_splits
               (scheduled_transaction_id, kind, category_id, amount, memo)
             VALUES ($1, 'category', $2, $3, $4)`,
              [
                row.id,
                categoryMap.get(split.categoryPath) ?? null,
                split.amount,
                split.memo,
              ],
            );
          }
          return row.id as string;
        },
      );
      scheduledMap.set(st.name, scheduledId);
    }

    this.logger.log(
      `Seeded ${demoScheduledTransactions.length} scheduled transactions`,
    );
    return scheduledMap;
  }

  /**
   * Payroll deduction rules: the yearly maximum CPP and EI collect on the
   * demo's salary bill, anchored to 1 January so the page shows this year's
   * progress against the cap. Income tax has no maximum and so no rule.
   */
  private async seedPayrollDeductionRules(
    userId: string,
    categoryMap: Map<string, string>,
    scheduledMap: Map<string, string>,
  ): Promise<void> {
    this.logger.log("Seeding payroll deduction rules");
    const billId = scheduledMap.get(DEMO_PAYROLL_BILL_NAME);
    if (!billId) return;
    const resetDate = `${new Date().getUTCFullYear()}-01-01`;
    let count = 0;
    for (const d of demoPayrollDeductions) {
      const categoryId = categoryMap.get(d.categoryPath);
      if (d.yearlyMaximum === undefined || !categoryId) continue;
      await withScopedDb(this.dataSource, (manager) =>
        manager.query(
          `INSERT INTO payroll_deduction_rules (
            user_id, scheduled_transaction_id, category_id,
            yearly_maximum, reset_period, reset_date, expected_per_paycheque
          ) VALUES ($1, $2, $3, $4, 'YEARLY', $5, $6)`,
          [
            userId,
            billId,
            categoryId,
            d.yearlyMaximum,
            resetDate,
            d.perPaycheque,
          ],
        ),
      );
      count++;
    }
    this.logger.log(`Seeded ${count} payroll deduction rules`);
  }

  /** Warranties with claims, dated relative to today so the page never goes stale. */
  private async seedWarranties(
    userId: string,
    payeeMap: Map<string, string>,
  ): Promise<void> {
    this.logger.log("Seeding warranties");
    const today = new Date();
    const dayMs = 86_400_000;
    const ymd = (d: Date) => d.toISOString().split("T")[0];
    const daysFromNow = (n: number) =>
      ymd(new Date(today.getTime() + n * dayMs));
    const monthsAgo = (n: number) => {
      const d = new Date(today);
      d.setUTCMonth(d.getUTCMonth() - n);
      return ymd(d);
    };

    for (const w of demoWarranties) {
      const purchaseDate = monthsAgo(w.purchasedMonthsAgo);
      const expiresOn =
        w.isLifetime || w.expiresInDays === undefined
          ? null
          : daysFromNow(w.expiresInDays);
      await withScopedDb(this.dataSource, async (manager) => {
        const [row] = await manager.query(
          `INSERT INTO warranties (
            user_id, name, vendor_name, payee_id, model_number, serial_numbers,
            warranty_kind, purchase_date, expires_on, is_lifetime,
            purchase_price, currency_code, product_url, notes, archived_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
          RETURNING id`,
          [
            userId,
            w.name,
            w.vendorName,
            (w.payeeName && payeeMap.get(w.payeeName)) || null,
            w.modelNumber ?? null,
            w.serialNumbers ?? [],
            w.kind,
            purchaseDate,
            expiresOn,
            !!w.isLifetime,
            w.purchasePrice ?? null,
            w.purchasePrice === undefined ? null : "CAD",
            w.productUrl ?? null,
            w.notes ?? null,
            w.archived ? new Date() : null,
          ],
        );
        for (const c of w.claims ?? []) {
          const claimDate = daysFromNow(-c.openedDaysAgo);
          await manager.query(
            `INSERT INTO warranty_claims (
              user_id, warranty_id, claim_date, status, description,
              resolution, resolved_on
            ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [
              userId,
              row.id,
              claimDate,
              c.status,
              c.description,
              c.resolution ?? null,
              c.resolvedAfterDays === undefined
                ? null
                : daysFromNow(-c.openedDaysAgo + c.resolvedAfterDays),
            ],
          );
        }
      });
    }
    this.logger.log(`Seeded ${demoWarranties.length} warranties`);
  }

  /**
   * Shared expense groups: the demo user owns each and is one of its
   * participants. Each group goes in one transaction because a deferred
   * trigger checks, at commit, that an entry's allocations add up to it.
   */
  private async seedSharedExpenses(userId: string): Promise<void> {
    this.logger.log("Seeding shared expense groups");
    const today = new Date();
    const dateDaysAgo = (n: number) =>
      new Date(today.getTime() - n * 86_400_000).toISOString().split("T")[0];
    const money = (n: number) => n.toFixed(4);

    for (const group of demoSharedGroups) {
      await withScopedDb(this.dataSource, async (manager) => {
        const [g] = await manager.query(
          `INSERT INTO shared_groups (owner_user_id, name, description, currency_code)
           VALUES ($1, $2, $3, $4) RETURNING id`,
          [userId, group.name, group.description, group.currencyCode],
        );
        const participants = new Map<string, string>();
        for (const name of [group.myName, ...group.others]) {
          const [p] = await manager.query(
            "INSERT INTO shared_participants (group_id, name) VALUES ($1, $2) RETURNING id",
            [g.id, name],
          );
          participants.set(name, p.id);
        }
        await manager.query(
          `INSERT INTO shared_memberships (group_id, participant_id, user_id, role)
           VALUES ($1, $2, $3, 'OWNER')`,
          [g.id, participants.get(group.myName), userId],
        );
        // The address book: each person is linked to their seat in this group.
        for (const name of group.others) {
          const [person] = await manager.query(
            `SELECT id FROM shared_people WHERE user_id = $1 AND name = $2`,
            [userId, name],
          );
          const personId =
            person?.id ??
            (
              await manager.query(
                "INSERT INTO shared_people (user_id, name) VALUES ($1, $2) RETURNING id",
                [userId, name],
              )
            )[0].id;
          await manager.query(
            `INSERT INTO shared_person_links (user_id, person_id, group_id, participant_id)
             VALUES ($1, $2, $3, $4)`,
            [userId, personId, g.id, participants.get(name)],
          );
        }

        for (const e of group.entries) {
          const seed = `demo:${group.name}:${e.title}`;
          const date = dateDaysAgo(e.daysAgo);
          const isRepayment = e.type === "REPAYMENT";
          const [entry] = await manager.query(
            `INSERT INTO shared_entries (
              group_id, created_by_user_id, type, state, title, note,
              category_label, entry_date, original_amount, original_currency_code,
              group_amount, fx_rate, fx_rate_date, fx_source, split_mode,
              rounding_seed, from_participant_id, to_participant_id
            ) VALUES ($1, $2, $3, 'POSTED', $4, $5, $6, $7, $8, $9, $8, '1.0000000000', $7, 'IDENTITY', $10, $11, $12, $13)
            RETURNING id`,
            [
              g.id,
              userId,
              e.type,
              e.title,
              e.note ?? null,
              e.categoryLabel ?? null,
              date,
              money(e.amount),
              group.currencyCode,
              e.splitMode ?? "EQUAL",
              seed,
              isRepayment ? participants.get(e.payer) : null,
              isRepayment && e.recipient ? participants.get(e.recipient) : null,
            ],
          );
          if (!isRepayment) {
            for (const share of e.shares ?? []) {
              await manager.query(
                `INSERT INTO shared_allocations (
                  group_id, entry_id, participant_id, kind,
                  original_amount, group_amount, instruction_value
                ) VALUES ($1, $2, $3, 'SHARE', $4, $4, $5)`,
                [
                  g.id,
                  entry.id,
                  participants.get(share.name),
                  money(share.amount),
                  share.instruction ?? null,
                ],
              );
            }
            await manager.query(
              `INSERT INTO shared_allocations (
                group_id, entry_id, participant_id, kind, original_amount, group_amount
              ) VALUES ($1, $2, $3, 'CONTRIBUTION', $4, $4)`,
              [g.id, entry.id, participants.get(e.payer), money(e.amount)],
            );
          }
          await manager.query(
            `INSERT INTO shared_activity (group_id, entry_id, actor_user_id, actor_name, action, detail)
             VALUES ($1, $2, $3, $4, 'ENTRY_CREATED', $5)`,
            [
              g.id,
              entry.id,
              userId,
              group.myName,
              JSON.stringify({ title: e.title, type: e.type }),
            ],
          );
        }
      });
    }
    this.logger.log(`Seeded ${demoSharedGroups.length} shared expense groups`);
  }

  private async seedSecurities(
    userId: string,
    accountMap: Map<string, string>,
  ): Promise<void> {
    this.logger.log("Seeding securities, prices, and holdings");

    const now = new Date();
    let priceCount = 0;

    for (const sec of demoSecurities) {
      const accountId = accountMap.get(sec.accountKey);
      if (!accountId) continue;

      // Create security
      const [security] = await withScopedDb(this.dataSource, (manager) =>
        manager.query(
          `INSERT INTO securities (user_id, symbol, name, security_type, exchange, currency_code)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id`,
          [userId, sec.symbol, sec.name, sec.type, sec.exchange, sec.currency],
        ),
      );

      // Generate and insert price history
      const prices = generatePriceHistory(sec, now, 12);
      for (const price of prices) {
        await withScopedDb(this.dataSource, (manager) =>
          manager.query(
            `INSERT INTO security_prices (security_id, price_date, close_price, source)
           VALUES ($1, $2, $3, 'demo-seed')
           ON CONFLICT (security_id, price_date) DO NOTHING`,
            [security.id, price.date, price.close],
          ),
        );
        priceCount++;
      }

      // Create holding
      await withScopedDb(this.dataSource, (manager) =>
        manager.query(
          `INSERT INTO holdings (account_id, security_id, quantity, average_cost)
         VALUES ($1, $2, $3, $4)`,
          [accountId, security.id, sec.quantity, sec.averageCost],
        ),
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
        await withScopedDb(this.dataSource, (manager) =>
          manager.query(
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
          ),
        );
      }

      // Quarterly dividend (for ETFs)
      if (sec.type === "ETF") {
        for (const monthsAgo of [2, 5, 8, 11]) {
          const divDate = new Date(now);
          divDate.setMonth(divDate.getMonth() - monthsAgo);
          divDate.setDate(15);
          const divAmount =
            Math.round(sec.quantity * sec.basePrice * 0.005 * 100) / 100;

          await withScopedDb(this.dataSource, (manager) =>
            manager.query(
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
            ),
          );
        }
      }
    }

    this.logger.log(
      `Seeded ${demoSecurities.length} securities, ${priceCount} price records, holdings, and investment transactions`,
    );
  }

  private async seedReports(userId: string): Promise<void> {
    this.logger.log("Seeding custom reports");

    for (const report of demoReports) {
      await withScopedDb(this.dataSource, (manager) =>
        manager.query(
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
        ),
      );
    }

    this.logger.log(`Seeded ${demoReports.length} custom reports`);
  }

  private async seedPreferences(userId: string): Promise<void> {
    this.logger.log("Seeding user preferences");

    const p = demoPreferences;
    await withScopedDb(this.dataSource, (manager) =>
      manager.query(
        `INSERT INTO user_preferences (
        user_id, default_currency, date_format, number_format, theme,
        timezone, notification_email,
        two_factor_enabled, getting_started_dismissed,
        dashboard_widgets, dashboard_widget_config
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      ON CONFLICT (user_id) DO UPDATE SET
        default_currency = $2, date_format = $3, number_format = $4,
        theme = $5, timezone = $6, notification_email = $7,
        two_factor_enabled = $8, getting_started_dismissed = $9,
        dashboard_widgets = $10, dashboard_widget_config = $11`,
        [
          userId,
          p.defaultCurrency,
          p.dateFormat,
          p.numberFormat,
          p.theme,
          p.timezone,
          p.notificationEmail,
          p.twoFactorEnabled,
          p.gettingStartedDismissed,
          p.dashboardWidgets,
          JSON.stringify(p.dashboardWidgetConfig),
        ],
      ),
    );

    this.logger.log("Seeded user preferences");
  }
}
