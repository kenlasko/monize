import { Global, Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { TestingModule } from "@nestjs/testing";
import { DataSource } from "typeorm";

import { settlePendingHistoryWrites } from "@/action-history/action-history.service";
import { AiModule } from "@/ai/ai.module";
import { AiService } from "@/ai/ai.service";
import { AiUsageService } from "@/ai/ai-usage.service";
import { AiInsightsService } from "@/ai/insights/ai-insights.service";
import {
  InsightsAggregatorService,
  SpendingAggregates,
} from "@/ai/insights/insights-aggregator.service";
import { AiReviewModule } from "@/ai-review/ai-review.module";
import { AiReviewQueueModule } from "@/ai-review/ai-review-queue.module";
import { withUserContext } from "@/common/db/with-context";
import { EncryptionService } from "@/common/encryption/encryption.service";
import { EVENT_BUS } from "@/common/events/event-bus.interface";
import { MemoryEventBus } from "@/common/events/memory-event-bus";
import { JobClaimModule } from "@/common/jobs/job-claim.module";
import { JobClaimService } from "@/common/jobs/job-claim.service";
import { EmailReceiptsModule } from "@/email-receipts/email-receipts.module";
import { EmailReceiptPollService } from "@/email-receipts/poll/email-receipt-poll.service";
import { TransactionRulesModule } from "@/transaction-rules/transaction-rules.module";
import { TransactionsModule } from "@/transactions/transactions.module";

import {
  cleanTables,
  createEnforcedIntegrationModule,
  createTestUserDirect,
  EnforcedIntegrationHarness,
} from "../helpers/integration-setup";

/** The in-process event bus a `single` deployment binds, without the app's module. */
@Global()
@Module({
  providers: [{ provide: EVENT_BUS, useClass: MemoryEventBus }],
  exports: [EVENT_BUS],
})
class TestEventBusModule {}

/**
 * A lease outrun by the provider call it guards (A26-L13: A26-S08-04 R2 and
 * A26-S11-01 P2; INV-CRON-001, INV-RECEIPT-006, MON-M25).
 *
 * Each case expires the holder's lease by its own token while its provider
 * call is in flight -- what a call longer than the TTL does -- and lets a
 * second run start. The lease outlasting the call (TTL and renewal) is what
 * stops this in production; what is asserted here is the fence behind it:
 *
 * - AI insights: the first generation's save is refused because its lease
 *   token is no longer the row's, so one set of insights is saved, not two.
 * - Receipt poll: the parser-draft step holds its own per-sender claim, so the
 *   second poll does not draft the sender the first is drafting: one provider
 *   call, one draft row.
 */
describe("provider calls outrunning their lease (integration)", () => {
  jest.setTimeout(240000);

  let harness: EnforcedIntegrationHarness;
  let module: TestingModule;
  let db: DataSource;
  let aliceId: string;

  const asAlice = <T>(fn: () => Promise<T>) => withUserContext(aliceId, fn);

  /** A promise and the function that settles it. */
  function deferred(): { promise: Promise<void>; resolve: () => void } {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => {
      resolve = r;
    });
    return { promise, resolve };
  }

  /** Expire a live lease as its own holder would: by its token. */
  async function expireLease(claimType: string): Promise<void> {
    await db.transaction(async (m) => {
      const [row] = await m.query(
        `SELECT lease_token FROM job_claims WHERE claim_type = $1 AND user_id = $2`,
        [claimType, aliceId],
      );
      await m.query(
        `SELECT set_config('app.job_claim_lease_token', $1, true)`,
        [row.lease_token],
      );
      await m.query(
        `UPDATE job_claims SET expires_at = CURRENT_TIMESTAMP - INTERVAL '1 second'
          WHERE claim_type = $1 AND user_id = $2`,
        [claimType, aliceId],
      );
    });
  }

  beforeAll(async () => {
    process.env.JWT_SECRET ??= "integration-test-secret";
    process.env.ENCRYPTION_KEY ??= "x".repeat(40);
    harness = await createEnforcedIntegrationModule([
      JobClaimModule,
      TransactionsModule,
      TransactionRulesModule,
      AiReviewModule,
      AiReviewQueueModule,
      AiModule,
      EmailReceiptsModule,
      TestEventBusModule,
    ]);
    module = harness.module;
    db = harness.owner;
  });

  afterAll(async () => {
    await settlePendingHistoryWrites();
    await harness.close();
  });

  beforeEach(async () => {
    jest.restoreAllMocks();
    await settlePendingHistoryWrites();
    await cleanTables(db, [
      "job_claims",
      "ai_insights",
      "ai_review_requests",
      "email_receipts",
      "email_receipt_parsers",
      "email_receipt_mailboxes",
      "categories",
      "users",
    ]);
    aliceId = (await createTestUserDirect(db, { firstName: "Alice" })).id;
  });

  it("AI insights: a generation whose lease was retaken does not save its set (R2)", async () => {
    const insights = module.get(AiInsightsService);
    // A second replica: its own instance, so its own in-process guard.
    const replica = new AiInsightsService(
      module.get(DataSource),
      module.get(AiService),
      module.get(AiUsageService),
      module.get(InsightsAggregatorService),
      module.get(ConfigService),
      module.get(JobClaimService),
    );
    const aggregates: SpendingAggregates = {
      categorySpending: [
        {
          categoryId: null,
          categoryName: "Groceries",
          currentMonthTotal: 100,
          previousMonthTotal: 90,
          averageMonthlyTotal: 95,
          monthCount: 2,
          transactionCount: 4,
        },
      ],
      monthlySpending: [
        {
          month: "2026-10",
          total: 100,
          categoryBreakdown: [{ categoryName: "Groceries", total: 100 }],
        },
      ],
      recurringCharges: [],
      totalSpendingCurrentMonth: 100,
      totalSpendingPreviousMonth: 90,
      averageMonthlySpending: 95,
      daysElapsedInMonth: 21,
      daysInMonth: 31,
      currency: "USD",
      fxComplete: true,
      missingRatePairs: [],
    };
    jest
      .spyOn(module.get(InsightsAggregatorService), "computeAggregates")
      .mockResolvedValue(aggregates);

    const firstCallEntered = deferred();
    const releaseFirstCall = deferred();
    let calls = 0;
    const reply = (title: string) => ({
      content: JSON.stringify({
        insights: [
          { type: "trend", title, description: "d", severity: "info" },
        ],
      }),
      model: "test",
      usage: { inputTokens: 1, outputTokens: 1 },
    });
    jest
      .spyOn(module.get(AiService), "complete")
      .mockImplementation(async () => {
        calls += 1;
        if (calls === 1) {
          firstCallEntered.resolve();
          await releaseFirstCall.promise;
          return reply("first") as never;
        }
        return reply("second") as never;
      });

    const first = asAlice(() => insights.generateInsights(aliceId));
    await firstCallEntered.promise;
    // The first call has outrun its lease.
    await expireLease("ai_insight_generation");

    await asAlice(() => replica.generateInsights(aliceId));
    releaseFirstCall.resolve();
    await first;

    const rows = (await db.query(
      `SELECT title FROM ai_insights WHERE user_id = $1`,
      [aliceId],
    )) as Array<{ title: string }>;
    expect(calls).toBe(2);
    // One generation window, one saved set: the retaken holder's.
    expect(rows.map((r) => r.title)).toEqual(["second"]);
  });

  it("receipt poll: a second poll does not draft the sender the first is drafting (P2)", async () => {
    const encryption = module.get(EncryptionService);
    const poller = module.get(EmailReceiptPollService);
    const [mailbox] = await db.query(
      `INSERT INTO email_receipt_mailboxes
         (user_id, host, port, security, username, password_enc, enabled, ai_mode, auto_apply)
       VALUES ($1, '8.8.8.8', 993, 'tls', 'receipts@example.com', $2, true, 'automatic', false)
       RETURNING id`,
      [aliceId, encryption.encrypt("secret")],
    );
    await db.query(
      `INSERT INTO email_receipts
         (user_id, mailbox_id, uid_validity, uid, from_address, from_domain,
          subject, received_at, body_text, status)
       VALUES ($1, $2, 1001, 1, 'orders@newshop.example.com', 'newshop.example.com',
               'Your order', CURRENT_TIMESTAMP, 'Order total: 10.00', 'no_parser')`,
      [aliceId, mailbox.id],
    );

    const firstCallEntered = deferred();
    const releaseFirstCall = deferred();
    let calls = 0;
    const parser = {
      content: JSON.stringify({
        version: 2,
        total: ["Order total: {amount}"],
      }),
      model: "test",
      usage: { inputTokens: 1, outputTokens: 1 },
    };
    jest
      .spyOn(module.get(AiService), "complete")
      .mockImplementation(async () => {
        calls += 1;
        if (calls === 1) {
          firstCallEntered.resolve();
          await releaseFirstCall.promise;
        }
        return parser as never;
      });

    const first = asAlice(() => poller.processStoredNow(aliceId));
    await firstCallEntered.promise;
    // The draft call has outrun the poll's lease.
    await expireLease("email_receipt_poll");

    const second = await asAlice(() => poller.processStoredNow(aliceId));
    expect(second.busy).toBe(false);
    releaseFirstCall.resolve();
    await first;

    const drafts = await db.query(
      `SELECT id FROM email_receipt_parsers WHERE user_id = $1`,
      [aliceId],
    );
    expect(calls).toBe(1);
    expect(drafts).toHaveLength(1);
  });
});
