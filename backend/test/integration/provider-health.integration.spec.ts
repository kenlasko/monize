import { DataSource } from "typeorm";

import { ProviderHealthService } from "@/provider-health/provider-health.service";
import { FAILURE_THRESHOLD } from "@/provider-health/provider-circuit";
import { ProviderOutageAlertService } from "@/notifications/provider-outage-alert.service";

import {
  INTEGRATION_TYPEORM_OPTIONS,
  cleanTables,
  createTestUserDirect,
} from "../helpers/integration-setup";

/**
 * INV-PROVIDER-001's two SQL-resident halves, against a real PostgreSQL.
 *
 * Everything else about the breaker is TypeScript and is covered by unit specs.
 * These two are not:
 *
 * 1. **The episode start survives a restart.** It survives because of a `CASE`
 *    inside the upsert, evaluated by the database against the row already
 *    stored. A mocked manager can only show that the statement text was sent --
 *    and the whole point of the property is what PostgreSQL does with it, since
 *    a restarted process has a fresh in-memory `failingSince` that would
 *    otherwise reset the fifteen-minute alert gate on every restart the outage
 *    provokes (issue #1265).
 *
 * 2. **Two replicas send one email.** The exclusion is a conditional
 *    `UPDATE ... RETURNING` -- the claim *is* the serialization point. Two
 *    mocked sweeps cannot race; two real ones against one database can.
 */
describe("provider health against a real database", () => {
  const PROVIDER = "yahoo_finance";
  let dataSource: DataSource;

  /** A DNS failure in the shape undici produces. */
  const transportError = (): Error =>
    Object.assign(new TypeError("fetch failed"), {
      cause: Object.assign(new Error("getaddrinfo EAI_AGAIN yahoo"), {
        code: "EAI_AGAIN",
      }),
    });

  const row = async (): Promise<{
    state: string;
    recent_failures: number;
    outage_started_at: Date | null;
    outage_notified_at: Date | null;
    last_notified_at: Date | null;
    last_failure_reason: string | null;
  } | null> => {
    const rows = await dataSource.query(
      `SELECT * FROM provider_health WHERE provider = $1`,
      [PROVIDER],
    );
    return rows[0] ?? null;
  };

  /** The health write is fire-and-forget; wait for it rather than guessing. */
  const waitForRow = async (
    predicate: (r: NonNullable<Awaited<ReturnType<typeof row>>>) => boolean,
  ): Promise<NonNullable<Awaited<ReturnType<typeof row>>>> => {
    for (let attempt = 0; attempt < 100; attempt++) {
      const current = await row();
      if (current && predicate(current)) return current;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(
      `provider_health never reached the expected state: ${JSON.stringify(
        await row(),
      )}`,
    );
  };

  /** A replica: its own in-memory breaker, its own clock. */
  const replica = (now: () => number = Date.now): ProviderHealthService =>
    new ProviderHealthService(dataSource, now);

  const driveOpen = (health: ProviderHealthService): void => {
    for (let i = 0; i < FAILURE_THRESHOLD; i++) {
      health.recordFailure(PROVIDER, transportError());
    }
  };

  beforeAll(async () => {
    dataSource = new DataSource(INTEGRATION_TYPEORM_OPTIONS as never);
    await dataSource.initialize();
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) await dataSource.destroy();
  });

  beforeEach(async () => {
    await cleanTables(dataSource, ["provider_health", "users"]);
  });

  describe("the episode start", () => {
    it("is preserved when a second process opens the breaker again", async () => {
      const first = Date.UTC(2026, 7, 26, 19, 3);
      driveOpen(replica(() => first));
      const opened = await waitForRow((r) => r.state === "down");
      expect(opened.outage_started_at?.toISOString()).toBe(
        new Date(first).toISOString(),
      );

      // The container restarts an hour into the outage. Its breaker starts
      // closed, so its `failingSince` is now, not then.
      const later = first + 60 * 60_000;
      driveOpen(replica(() => later));
      await new Promise((resolve) => setTimeout(resolve, 100));

      const after = await row();
      expect(after?.state).toBe("down");
      // Still the original start: the alert's fifteen-minute gate is measured
      // against the outage, not against the last restart.
      expect(after?.outage_started_at?.toISOString()).toBe(
        new Date(first).toISOString(),
      );
    });

    it("moves on when a genuinely new episode opens after a recovery", async () => {
      const first = Date.UTC(2026, 7, 26, 19, 3);
      const health = replica(() => first);
      driveOpen(health);
      await waitForRow((r) => r.state === "down");

      health.recordSuccess(PROVIDER);
      await waitForRow((r) => r.state === "up");

      const second = Date.UTC(2026, 7, 27, 9, 0);
      driveOpen(replica(() => second));
      const reopened = await waitForRow(
        (r) =>
          r.state === "down" &&
          r.outage_started_at?.toISOString() === new Date(second).toISOString(),
      );
      expect(reopened.outage_started_at?.toISOString()).toBe(
        new Date(second).toISOString(),
      );
    });
  });

  describe("two replicas sweeping at once", () => {
    let sent: Array<{ to: string; subject: string }>;

    /** An alert service standing in for one replica. */
    const alertReplica = (): ProviderOutageAlertService =>
      new ProviderOutageAlertService(
        dataSource,
        {
          getStatus: () => ({ configured: true }),
          sendMail: async (to: string, subject: string) => {
            sent.push({ to, subject });
          },
        } as never,
        {
          translate: (_key: string, options?: { defaultValue?: string }) =>
            options?.defaultValue ?? _key,
        } as never,
        // The in-app alert rows have their own integration spec
        // (system-alert-dedupe.integration.spec.ts); this suite is about the
        // provider_health claim and the emails it gates.
        {
          raiseAdminAlert: async () => ({ created: 0, emailed: 0 }),
        } as never,
      );

    beforeEach(async () => {
      sent = [];
      await createTestUserDirect(dataSource, {
        email: "admin@example.com",
        role: "admin",
      });
    });

    it("sends exactly one outage email between them", async () => {
      // An outage that began well before the fifteen-minute gate.
      await dataSource.query(
        `INSERT INTO provider_health (
           provider, state, recent_failures, outage_started_at,
           last_failure_at, last_failure_reason
         ) VALUES ($1, 'down', 137, CURRENT_TIMESTAMP - INTERVAL '2 hours',
                   CURRENT_TIMESTAMP, 'TypeError: fetch failed [code=EAI_AGAIN]')`,
        [PROVIDER],
      );

      await Promise.all([
        alertReplica().sweepProviderHealth(),
        alertReplica().sweepProviderHealth(),
        alertReplica().sweepProviderHealth(),
      ]);

      expect(sent).toHaveLength(1);
      expect(sent[0].to).toBe("admin@example.com");
      const after = await row();
      expect(after?.outage_notified_at).not.toBeNull();
      expect(after?.last_notified_at).not.toBeNull();
    });

    it("does not send a second notice for the same episode", async () => {
      await dataSource.query(
        `INSERT INTO provider_health (
           provider, state, recent_failures, outage_started_at,
           last_failure_at, last_failure_reason
         ) VALUES ($1, 'down', 5, CURRENT_TIMESTAMP - INTERVAL '2 hours',
                   CURRENT_TIMESTAMP, 'down')`,
        [PROVIDER],
      );
      await alertReplica().sweepProviderHealth();
      expect(sent).toHaveLength(1);

      await alertReplica().sweepProviderHealth();
      await alertReplica().sweepProviderHealth();
      expect(sent).toHaveLength(1);
    });

    it("waits out the fifteen-minute gate", async () => {
      await dataSource.query(
        `INSERT INTO provider_health (
           provider, state, recent_failures, outage_started_at,
           last_failure_at, last_failure_reason
         ) VALUES ($1, 'down', 5, CURRENT_TIMESTAMP - INTERVAL '5 minutes',
                   CURRENT_TIMESTAMP, 'down')`,
        [PROVIDER],
      );

      await alertReplica().sweepProviderHealth();

      expect(sent).toHaveLength(0);
      expect((await row())?.outage_notified_at).toBeNull();
    });

    it("ignores a burst that was never re-tested, however old", async () => {
      // Waking from sleep: the failures all land in the first second, then the
      // row sits at down with nothing calling the provider.
      await dataSource.query(
        `INSERT INTO provider_health (
           provider, state, recent_failures, outage_started_at,
           last_failure_at, last_failure_reason
         ) VALUES ($1, 'down', 5, CURRENT_TIMESTAMP - INTERVAL '20 minutes',
                   CURRENT_TIMESTAMP - INTERVAL '20 minutes' + INTERVAL '1 second',
                   'getaddrinfo ENOTFOUND [code=ENOTFOUND]')`,
        [PROVIDER],
      );

      await alertReplica().sweepProviderHealth();

      expect(sent).toHaveLength(0);
      expect((await row())?.outage_notified_at).toBeNull();
    });

    it("sends one all-clear, and clears the episode marker with it", async () => {
      await dataSource.query(
        `INSERT INTO provider_health (
           provider, state, recent_failures, outage_started_at,
           last_failure_at, last_success_at, outage_notified_at, last_notified_at
         ) VALUES ($1, 'up', 0, CURRENT_TIMESTAMP - INTERVAL '3 hours',
                   CURRENT_TIMESTAMP - INTERVAL '1 hour', CURRENT_TIMESTAMP,
                   CURRENT_TIMESTAMP - INTERVAL '1 hour',
                   CURRENT_TIMESTAMP - INTERVAL '1 hour')`,
        [PROVIDER],
      );

      await Promise.all([
        alertReplica().sweepProviderHealth(),
        alertReplica().sweepProviderHealth(),
      ]);

      expect(sent).toHaveLength(1);
      expect((await row())?.outage_notified_at).toBeNull();
    });

    it("holds a second alert behind the six-hour floor", async () => {
      // The provider flapped: down again, but an alert went out an hour ago.
      await dataSource.query(
        `INSERT INTO provider_health (
           provider, state, recent_failures, outage_started_at,
           last_failure_at, last_notified_at
         ) VALUES ($1, 'down', 5, CURRENT_TIMESTAMP - INTERVAL '30 minutes',
                   CURRENT_TIMESTAMP, CURRENT_TIMESTAMP - INTERVAL '1 hour')`,
        [PROVIDER],
      );

      await alertReplica().sweepProviderHealth();

      expect(sent).toHaveLength(0);
    });
  });
});
