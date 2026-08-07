import { Injectable, Logger } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { DataSource } from "typeorm";
import { withScopedDb } from "../common/db/scoped-db";
import * as bcrypt from "bcryptjs";

import { DemoModeService } from "../common/demo-mode.service";
import { DemoSeedService } from "./demo-seed.service";
import { INTRADAY_TEMPLATES } from "./demo-seed-data/intraday-templates";
import { withSystemContext } from "../common/db/with-context";
import {
  JobClaimService,
  JobClaimType,
} from "../common/jobs/job-claim.service";

/**
 * How long one replica may hold the demo reset before another may retake it.
 *
 * A wipe-and-reseed is not idempotent while it is running: a second replica
 * starting halfway through deletes the rows the first is still seeding and both
 * finish with a partial demo. The lease expires so a replica killed mid-reset
 * does not leave the demo un-resettable until someone restarts the cluster.
 */
export const DEMO_RESET_LEASE_MS = 30 * 60 * 1000;

/** Lease and claim keys; one demo user, so the key names the window instead. */
export const DEMO_RESET_CLAIM_KEY = "reset";

@Injectable()
export class DemoResetService {
  private readonly logger = new Logger(DemoResetService.name);

  constructor(
    private dataSource: DataSource,
    private demoSeedService: DemoSeedService,
    private demoModeService: DemoModeService,
    private readonly jobClaims: JobClaimService,
  ) {}

  @Cron("0 4 * * *") // 4:00 AM daily
  async resetDemoData(): Promise<void> {
    if (!this.demoModeService.isDemo) return;

    this.logger.log("Starting daily demo data reset...");

    // RLS (task C3): clears and re-seeds the demo user's data across many
    // tables via raw SQL -- runs under a system context.
    return withSystemContext(() => this.resetDemoDataWithinContext());
  }

  /** The demo user's id, or null when the demo user has not been created. */
  private async findDemoUserId(): Promise<string | null> {
    const [demoUser] = await withScopedDb(this.dataSource, (manager) =>
      manager.query("SELECT id FROM users WHERE email = 'demo@monize.com'"),
    );
    return demoUser?.id ?? null;
  }

  private async resetDemoDataWithinContext(): Promise<void> {
    // The cron must not reject: an unhandled rejection from a scheduled handler
    // takes the process down, and this reset is best-effort.
    try {
      const demoUserId = await this.findDemoUserId();
      if (!demoUserId) {
        this.logger.warn("Demo user not found, skipping reset");
        return;
      }

      // Every replica fires this cron. A wipe-and-reseed is the one shape a
      // duplicate run cannot repair by repeating: the second replica's DELETE
      // lands in the middle of the first replica's seed and both finish with a
      // partial demo. The lease is the exclusion; it expires so a killed replica
      // does not leave the demo un-resettable.
      const leased = await this.jobClaims.claimLease(
        JobClaimType.DemoReset,
        demoUserId,
        DEMO_RESET_CLAIM_KEY,
        DEMO_RESET_LEASE_MS,
      );
      if (!leased) {
        this.logger.log(
          "Another replica is already resetting the demo data; skipping",
        );
        return;
      }

      try {
        await this.performDemoReset(demoUserId);
      } finally {
        await this.jobClaims
          // By token: a reset that outran its lease must not free the one the
          // replica now reseeding holds (DR-RRV4-01).
          .releaseLease(
            JobClaimType.DemoReset,
            demoUserId,
            DEMO_RESET_CLAIM_KEY,
            leased,
          )
          .catch(() => undefined);
      }
    } catch (error) {
      this.logger.error(
        "Demo reset failed",
        error instanceof Error ? error.stack : String(error),
      );
    }
  }

  private async performDemoReset(demoUserId: string): Promise<void> {
    try {
      // The clear runs in one transaction and must COMMIT before the re-seed:
      // seedDemoData opens its own scoped transactions, and the seeded rows
      // have to land on a database the clear has already emptied.
      await withScopedDb(this.dataSource, async (manager) => {
        const userId: string = demoUserId;

        // 1. Delete all user data in FK-safe order
        await manager.query(
          "DELETE FROM investment_transactions WHERE user_id = $1",
          [userId],
        );
        await manager.query(
          `DELETE FROM holdings WHERE account_id IN
         (SELECT id FROM accounts WHERE user_id = $1)`,
          [userId],
        );
        await manager.query(
          `DELETE FROM security_prices WHERE security_id IN
         (SELECT id FROM securities WHERE user_id = $1)`,
          [userId],
        );
        await manager.query("DELETE FROM securities WHERE user_id = $1", [
          userId,
        ]);
        await manager.query(
          `DELETE FROM transaction_splits WHERE transaction_id IN
         (SELECT id FROM transactions WHERE user_id = $1)`,
          [userId],
        );
        await manager.query("DELETE FROM transactions WHERE user_id = $1", [
          userId,
        ]);
        await manager.query(
          `DELETE FROM scheduled_transaction_overrides WHERE scheduled_transaction_id IN
         (SELECT id FROM scheduled_transactions WHERE user_id = $1)`,
          [userId],
        );
        await manager.query(
          `DELETE FROM scheduled_transaction_splits WHERE scheduled_transaction_id IN
         (SELECT id FROM scheduled_transactions WHERE user_id = $1)`,
          [userId],
        );
        await manager.query(
          "DELETE FROM scheduled_transactions WHERE user_id = $1",
          [userId],
        );
        await manager.query(
          "DELETE FROM monthly_account_balances WHERE user_id = $1",
          [userId],
        );
        await manager.query("DELETE FROM custom_reports WHERE user_id = $1", [
          userId,
        ]);
        await manager.query("DELETE FROM payees WHERE user_id = $1", [userId]);
        await manager.query("DELETE FROM accounts WHERE user_id = $1", [
          userId,
        ]);
        // Institutions are referenced by accounts (institution_id FK); delete
        // after accounts so the re-seed recreates them without duplicates.
        await manager.query("DELETE FROM institutions WHERE user_id = $1", [
          userId,
        ]);
        await manager.query("DELETE FROM categories WHERE user_id = $1", [
          userId,
        ]);
        await manager.query("DELETE FROM refresh_tokens WHERE user_id = $1", [
          userId,
        ]);
        await manager.query("DELETE FROM trusted_devices WHERE user_id = $1", [
          userId,
        ]);
        await manager.query("DELETE FROM user_preferences WHERE user_id = $1", [
          userId,
        ]);

        // 2. Reset user record
        const hashedPassword = await bcrypt.hash("Demo123!", 10);
        await manager.query(
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
      });

      const userId = demoUserId;
      this.logger.log("Demo data cleared successfully");

      // 3. Re-seed demo data
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
      // withScopedDb has already rolled its transaction back by the time we
      // land here; the reset is best-effort, so log and let the cron continue.
      this.logger.error(
        "Demo reset failed",
        error instanceof Error ? error.stack : String(error),
      );
    }
  }

  @Cron("0 */3 * * *") // Every 3 hours
  async generateIntradayTransactions(): Promise<void> {
    if (!this.demoModeService.isDemo) return;

    this.logger.log("Generating intra-day demo transactions...");

    // RLS (task C3): raw cross-user SQL over the demo user's data.
    return withSystemContext(() =>
      this.generateIntradayTransactionsWithinContext(),
    );
  }

  private async generateIntradayTransactionsWithinContext(): Promise<void> {
    try {
      const userId = await this.findDemoUserId();
      if (!userId) return;

      const now = new Date();
      const today = now.toISOString().split("T")[0];

      // The generator is seeded by the window, so every replica computes the
      // SAME transactions -- which means the "does this exact row exist yet"
      // check below is a check-then-act two replicas both pass, and the demo
      // gets each transaction twice. The claim is what decides; it is permanent
      // because a window that has been generated must never be generated again,
      // and it is not released on failure because a partial window is better
      // than a doubled one (the next window generates fresh rows anyway).
      const windowKey = `${today}-${String(now.getUTCHours()).padStart(2, "0")}`;
      const claimed = await this.jobClaims.claimOnce(
        JobClaimType.DemoIntraday,
        userId,
        windowKey,
      );
      if (!claimed) {
        this.logger.log(
          `Intra-day demo window ${windowKey} was already generated; skipping`,
        );
        return;
      }

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

        const accountName = accountNameMap[template.accountKey];

        // One transaction for the ledger row and the balance it moves. Split
        // across two, a crash between them leaves a transaction the account
        // balance does not account for -- and the demo then shows a balance that
        // disagrees with its own ledger, which is the exact defect this
        // codebase's balance rules exist to prevent.
        const inserted = await withScopedDb(
          this.dataSource,
          async (manager) => {
            const [account] = await manager.query(
              "SELECT id FROM accounts WHERE user_id = $1 AND name = $2",
              [userId, accountName],
            );
            if (!account) return null;

            const [payee] = await manager.query(
              "SELECT id FROM payees WHERE user_id = $1 AND name = $2",
              [userId, template.payeeName],
            );

            // Category may be given as "Parent > Child".
            const parts = template.categoryPath.split(" > ");
            const [cat] =
              parts.length === 2
                ? await manager.query(
                    `SELECT c.id FROM categories c
                       JOIN categories p ON c.parent_id = p.id
                      WHERE c.user_id = $1 AND p.name = $2 AND c.name = $3`,
                    [userId, parts[0], parts[1]],
                  )
                : await manager.query(
                    "SELECT id FROM categories WHERE user_id = $1 AND name = $2 AND parent_id IS NULL",
                    [userId, parts[0]],
                  );

            await manager.query(
              `INSERT INTO transactions (
                user_id, account_id, transaction_date, payee_id, payee_name,
                category_id, amount, currency_code, description, status
              ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'CAD', $8, 'UNRECONCILED')`,
              [
                userId,
                account.id,
                today,
                payee?.id || null,
                template.payeeName,
                cat?.id || null,
                amount,
                template.description,
              ],
            );

            await manager.query(
              "UPDATE accounts SET current_balance = ROUND(CAST(current_balance AS numeric) + $1, 4) WHERE id = $2",
              [amount, account.id],
            );

            return account.id as string;
          },
        );

        if (!inserted) continue;

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
