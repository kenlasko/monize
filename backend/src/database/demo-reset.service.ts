import { Injectable, Logger } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { DataSource } from "typeorm";
import * as bcrypt from "bcryptjs";

import { DemoModeService } from "../common/demo-mode.service";
import { DemoSeedService } from "./demo-seed.service";

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
      await queryRunner.query(
        "DELETE FROM custom_reports WHERE user_id = $1",
        [userId],
      );
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
      await this.demoSeedService.seedDemoData(userId);
      this.logger.log("Demo data re-seeded successfully");
    } catch (error) {
      await queryRunner.rollbackTransaction();
      this.logger.error("Demo reset failed", error.stack);
    } finally {
      await queryRunner.release();
    }
  }
}
