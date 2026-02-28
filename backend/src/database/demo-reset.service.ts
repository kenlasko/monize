import { Injectable, Logger } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { DataSource } from "typeorm";
import * as bcrypt from "bcryptjs";

import { DemoModeService } from "../common/demo-mode.service";
import { DemoSeedService } from "./demo-seed.service";
import { INTRADAY_TEMPLATES } from "./demo-seed-data/intraday-templates";

@Injectable()
export class DemoResetService {
  private readonly logger = new Logger(DemoResetService.name);

  constructor(
    private dataSource: DataSource,
    private demoSeedService: DemoSeedService,
    private demoModeService: DemoModeService,
  ) {}

  @Cron("0 4 * * *") // 4:00 AM daily
  async resetDemoData(): Promise<void> {
    if (!this.demoModeService.isDemo) return;

    this.logger.log("Starting daily demo data reset...");

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      // 1. Get demo user ID
      const [demoUser] = await queryRunner.query(
        "SELECT id FROM users WHERE email = 'demo@monize.com'",
      );

      if (!demoUser) {
        this.logger.warn("Demo user not found, skipping reset");
        await queryRunner.rollbackTransaction();
        return;
      }

      const userId = demoUser.id;

      // 2. Delete all user data in FK-safe order
      await queryRunner.query(
        "DELETE FROM investment_transactions WHERE user_id = $1",
        [userId],
      );
      await queryRunner.query(
        `DELETE FROM holdings WHERE account_id IN
         (SELECT id FROM accounts WHERE user_id = $1)`,
        [userId],
      );
      await queryRunner.query(
        `DELETE FROM security_prices WHERE security_id IN
         (SELECT id FROM securities WHERE user_id = $1)`,
        [userId],
      );
      await queryRunner.query("DELETE FROM securities WHERE user_id = $1", [
        userId,
      ]);
      await queryRunner.query(
        `DELETE FROM transaction_splits WHERE transaction_id IN
         (SELECT id FROM transactions WHERE user_id = $1)`,
        [userId],
      );
      await queryRunner.query("DELETE FROM transactions WHERE user_id = $1", [
        userId,
      ]);
      await queryRunner.query(
        `DELETE FROM scheduled_transaction_overrides WHERE scheduled_transaction_id IN
         (SELECT id FROM scheduled_transactions WHERE user_id = $1)`,
        [userId],
      );
      await queryRunner.query(
        `DELETE FROM scheduled_transaction_splits WHERE scheduled_transaction_id IN
         (SELECT id FROM scheduled_transactions WHERE user_id = $1)`,
        [userId],
      );
      await queryRunner.query(
        "DELETE FROM scheduled_transactions WHERE user_id = $1",
        [userId],
      );
      await queryRunner.query(
        "DELETE FROM monthly_account_balances WHERE user_id = $1",
        [userId],
      );
      await queryRunner.query("DELETE FROM custom_reports WHERE user_id = $1", [
        userId,
      ]);
      await queryRunner.query("DELETE FROM payees WHERE user_id = $1", [
        userId,
      ]);
      await queryRunner.query("DELETE FROM accounts WHERE user_id = $1", [
        userId,
      ]);
      await queryRunner.query("DELETE FROM categories WHERE user_id = $1", [
        userId,
      ]);
      await queryRunner.query("DELETE FROM refresh_tokens WHERE user_id = $1", [
        userId,
      ]);
      await queryRunner.query(
        "DELETE FROM trusted_devices WHERE user_id = $1",
        [userId],
      );
      await queryRunner.query(
        "DELETE FROM user_preferences WHERE user_id = $1",
        [userId],
      );

      // 3. Reset user record
      const hashedPassword = await bcrypt.hash("Demo123!", 10);
      await queryRunner.query(
        `UPDATE users SET
          password_hash = $1,
          first_name = 'Demo',
          last_name = 'User',
          must_change_password = false,
          two_factor_secret = NULL,
          reset_token = NULL,
          reset_token_expiry = NULL,
          role = 'user'
        WHERE id = $2`,
        [hashedPassword, userId],
      );

      await queryRunner.commitTransaction();
      this.logger.log("Demo data cleared successfully");

      // 4. Re-seed demo data
      // seedDemoData runs outside the transaction because it uses
      // this.dataSource directly. If seeding fails, retry once before
      // giving up so the database is not left empty.
      let seeded = false;
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          await this.demoSeedService.seedDemoData(userId);
          seeded = true;
          break;
        } catch (seedError) {
          this.logger.error(
            `Demo re-seed attempt ${attempt} failed`,
            seedError instanceof Error ? seedError.stack : String(seedError),
          );
          if (attempt === 2) {
            throw seedError;
          }
        }
      }

      if (seeded) {
        this.logger.log("Demo data re-seeded successfully");
      }
    } catch (error) {
      if (!queryRunner.isReleased) {
        try {
          await queryRunner.rollbackTransaction();
        } catch {
          // Transaction may already be committed; ignore rollback errors
        }
      }
      this.logger.error(
        "Demo reset failed",
        error instanceof Error ? error.stack : String(error),
      );
    } finally {
      if (!queryRunner.isReleased) {
        await queryRunner.release();
      }
    }
  }

  @Cron("0 */3 * * *") // Every 3 hours
  async generateIntradayTransactions(): Promise<void> {
    if (!this.demoModeService.isDemo) return;

    this.logger.log("Generating intra-day demo transactions...");

    try {
      const [demoUser] = await this.dataSource.query(
        "SELECT id FROM users WHERE email = 'demo@monize.com'",
      );
      if (!demoUser) return;

      const userId = demoUser.id;
      const now = new Date();
      const today = now.toISOString().split("T")[0];

      // Deterministic RNG seeded by date + hour (same window = same output)
      const seedStr = `${today}-${now.getUTCHours()}`;
      let seed = 0;
      for (let i = 0; i < seedStr.length; i++) {
        seed = ((seed << 5) - seed + seedStr.charCodeAt(i)) & 0xffffffff;
      }
      const rand = () => {
        seed = (seed * 1664525 + 1013904223) & 0xffffffff;
        return (seed >>> 0) / 0xffffffff;
      };

      const accountNameMap: Record<string, string> = {
        chequing: "Primary Chequing",
        visa: "Visa Rewards",
        mastercard: "Mastercard",
      };

      const count = 1 + Math.floor(rand() * 2); // 1 or 2 transactions

      for (let i = 0; i < count; i++) {
        const template =
          INTRADAY_TEMPLATES[Math.floor(rand() * INTRADAY_TEMPLATES.length)];

        const amount =
          -Math.round(
            (template.minAmount +
              rand() * (template.maxAmount - template.minAmount)) *
              100,
          ) / 100;

        // Look up account
        const accountName = accountNameMap[template.accountKey];
        const [account] = await this.dataSource.query(
          "SELECT id FROM accounts WHERE user_id = $1 AND name = $2",
          [userId, accountName],
        );
        if (!account) continue;

        // Deduplicate: skip if this exact transaction already exists
        const [existing] = await this.dataSource.query(
          `SELECT COUNT(*) as count FROM transactions
           WHERE user_id = $1 AND transaction_date = $2
             AND payee_name = $3 AND amount = $4`,
          [userId, today, template.payeeName, amount],
        );
        if (parseInt(existing.count) > 0) continue;

        // Look up payee
        const [payee] = await this.dataSource.query(
          "SELECT id FROM payees WHERE user_id = $1 AND name = $2",
          [userId, template.payeeName],
        );

        // Look up category (handle "Parent > Child" path)
        let categoryId: string | null = null;
        const parts = template.categoryPath.split(" > ");
        if (parts.length === 2) {
          const [cat] = await this.dataSource.query(
            `SELECT c.id FROM categories c
             JOIN categories p ON c.parent_id = p.id
             WHERE c.user_id = $1 AND p.name = $2 AND c.name = $3`,
            [userId, parts[0], parts[1]],
          );
          categoryId = cat?.id || null;
        } else {
          const [cat] = await this.dataSource.query(
            "SELECT id FROM categories WHERE user_id = $1 AND name = $2 AND parent_id IS NULL",
            [userId, parts[0]],
          );
          categoryId = cat?.id || null;
        }

        // Insert transaction
        await this.dataSource.query(
          `INSERT INTO transactions (
            user_id, account_id, transaction_date, payee_id, payee_name,
            category_id, amount, currency_code, description,
            is_cleared, is_reconciled, status
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'CAD', $8, false, false, 'UNRECONCILED')`,
          [
            userId,
            account.id,
            today,
            payee?.id || null,
            template.payeeName,
            categoryId,
            amount,
            template.description,
          ],
        );

        // Update account balance
        await this.dataSource.query(
          "UPDATE accounts SET current_balance = current_balance + $1 WHERE id = $2",
          [amount, account.id],
        );

        this.logger.log(
          `Added intra-day transaction: ${template.payeeName} $${Math.abs(amount).toFixed(2)}`,
        );
      }
    } catch (error) {
      this.logger.error(
        "Intra-day transaction generation failed",
        error instanceof Error ? error.stack : String(error),
      );
    }
  }
}
