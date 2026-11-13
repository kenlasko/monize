import {
  Controller,
  Get,
  Inject,
  Logger,
  ServiceUnavailableException,
} from "@nestjs/common";
import { ApiTags, ApiOperation } from "@nestjs/swagger";
import { tr } from "../i18n/translate";
import { SkipThrottle } from "@nestjs/throttler";
import { PatIgnored } from "../auth/pat-access/pat-access.decorator";
import { InjectDataSource } from "@nestjs/typeorm";
import { DataSource } from "typeorm";
import { CLUSTER_MODE, ClusterMode } from "../common/cluster/cluster-mode";
import {
  PG_LISTENER,
  PG_LISTENER_RECONNECT_MAX_MS,
  PgListener,
} from "../common/cluster/pg-listener.provider";
import { ReplicaCensusService } from "../common/cluster/replica-census.service";
import { PostgresThrottlerStorage } from "../common/throttler/postgres-throttler-storage";

/**
 * How long the wake-up channel may be down before readiness gives up on it.
 *
 * Not zero, and that is the whole point. Every replica's listener session dies
 * at the same instant when the database restarts or fails over, so a probe that
 * failed on the state alone would take every pod out of the Service at once --
 * a total outage of every feature, to avoid at most one poll interval of extra
 * latency on AI-relay turns, which is the only thing a missing wake-up costs
 * (`common/events/event-bus.interface.ts`: the bus is a hint, and every waiter
 * also polls).
 *
 * Comfortably above the reconnect ceiling, so a channel still down after this
 * is one whose reconnect ladder has had several full attempts and is not merely
 * in progress. A genuinely misconfigured replica never reaches here at all:
 * `main.ts` refuses the boot.
 */
export const EVENT_BUS_READINESS_GRACE_MS = PG_LISTENER_RECONNECT_MAX_MS * 4;

@ApiTags("Health")
@SkipThrottle()
@PatIgnored()
@Controller("health")
export class HealthController {
  private readonly logger = new Logger(HealthController.name);

  constructor(
    @InjectDataSource()
    private dataSource: DataSource,
    @Inject(CLUSTER_MODE)
    private readonly clusterMode: ClusterMode,
    @Inject(PG_LISTENER)
    private readonly listener: PgListener | null,
    private readonly throttlerStorage: PostgresThrottlerStorage,
    private readonly census: ReplicaCensusService,
  ) {}

  @Get()
  @ApiOperation({ summary: "Health check endpoint" })
  async check() {
    const dbHealthy = await this.checkDatabase();
    const busHealthy = this.checkNotificationChannel();
    const throttlerDegraded = this.throttlerStorage.degradedReason();
    const replicas = this.countReplicas();

    return {
      status:
        dbHealthy &&
        busHealthy !== false &&
        throttlerDegraded === null &&
        !(replicas !== null && replicas > 1)
          ? "ok"
          : "degraded",
      timestamp: new Date().toISOString(),
      checks: {
        database: dbHealthy ? "healthy" : "unhealthy",
        // Reported only in multi. In single there is no cross-replica channel,
        // and a key that is always "healthy" would invite a dashboard to watch
        // a constant.
        //
        // This reports the channel's *state*, with no grace period: a monitor
        // should see the outage the moment it starts. Readiness is the one that
        // waits, because the cost of acting on it is different.
        ...(busHealthy === null
          ? {}
          : { eventBus: busHealthy ? "healthy" : "unhealthy" }),
        // Only when it is actually broken. A rate limiter that has stopped
        // functioning for a structural reason -- a missing table, a missing
        // grant -- fails open silently and stays green on every other signal,
        // so this is the one place an operator or an alert can see it.
        ...(throttlerDegraded === null ? {} : { rateLimiting: "disabled" }),
        // Reported only in single, the mode that asserts there is one process.
        // In multi peers are expected and handled, and a count there would be
        // a figure to watch with nothing wrong at any value. More than one in
        // single means rate limits and cache invalidation are per process, so
        // it degrades the status (ReplicaCensusService says what is counted).
        ...(replicas === null ? {} : { replicas }),
      },
    };
  }

  @Get("live")
  @ApiOperation({ summary: "Liveness probe - is the app running?" })
  live() {
    return { status: "ok" };
  }

  @Get("ready")
  @ApiOperation({
    summary: "Readiness probe - is the app ready to serve traffic?",
  })
  async ready() {
    const dbHealthy = await this.checkDatabase();

    if (!dbHealthy) {
      throw new ServiceUnavailableException(
        tr("errors.common.serviceNotReady", "Service not ready"),
      );
    }

    // A replica whose notification connection is down still serves every
    // request correctly; what it loses is the shortcut that saves a waiting
    // AI-relay turn one poll interval. So a transient loss must not remove it
    // from the load balancer: the loss is correlated across the fleet, and
    // taking every pod out at once would trade a bounded latency cost on one
    // feature for a total outage of all of them.
    //
    // A channel still down after the grace period is a different thing: the
    // reconnect ladder has had several full attempts, so this replica is
    // probably not coming back on its own and is worth replacing.
    if (this.notificationChannelDownTooLong()) {
      this.logger.warn(
        `Not ready: the notification connection has been down for more than ` +
          `${Math.round(EVENT_BUS_READINESS_GRACE_MS / 1000)}s, so this ` +
          "replica cannot be woken by another and is not recovering.",
      );
      throw new ServiceUnavailableException(
        tr("errors.common.serviceNotReady", "Service not ready"),
      );
    }

    return { status: "ok" };
  }

  private async checkDatabase(): Promise<boolean> {
    try {
      await this.dataSource.query("SELECT 1");
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Backend processes on this database as of the last census, or `null` when
   * there is nothing to report: in `multi`, or when no census was taken
   * recently. Read from the census's cache, never queried: this endpoint is
   * unauthenticated and unthrottled, so a scan of `pg_stat_activity` per
   * request would hand anyone a way to load the database. The fifteen-minute
   * system-alert sweep keeps the cache fresh.
   */
  private countReplicas(): number | null {
    if (this.clusterMode !== "single") {
      return null;
    }
    return this.census.lastKnownCount();
  }

  /**
   * `null` when there is nothing to check (`single`), otherwise whether the
   * channel is live. Three states rather than a boolean, so "no cross-replica
   * channel exists" is never reported as "it is down".
   */
  private checkNotificationChannel(): boolean | null {
    if (this.clusterMode !== "multi") {
      return null;
    }
    return this.listener?.isConnected() ?? false;
  }

  /** Whether the channel has been down long enough to stop serving. */
  private notificationChannelDownTooLong(): boolean {
    if (this.clusterMode !== "multi") {
      return false;
    }
    if (!this.listener) {
      // `multi` with no listener bound is a wiring defect rather than an
      // outage: there is nothing to wait for, so there is no grace to give.
      return true;
    }
    return (
      !this.listener.isConnected() &&
      this.listener.downForMs() > EVENT_BUS_READINESS_GRACE_MS
    );
  }
}
