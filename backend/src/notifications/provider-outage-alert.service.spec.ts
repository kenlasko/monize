import { Logger } from "@nestjs/common";
import {
  ALERT_QUIET_PERIOD_MS,
  MIN_OUTAGE_MS,
  ProviderOutageAlertService,
  formatOutageDuration,
  formatUtcMinute,
} from "./provider-outage-alert.service";
import {
  createScopedDbMocks,
  DataSourceMock,
  ManagerMock,
} from "../test-helpers/scoped-db-testing";

jest.mock("../common/db/scoped-db", () =>
  jest.requireActual("../test-helpers/scoped-db-testing").scopedDbMockModule(),
);

jest.mock("../common/db/with-context", () => ({
  withSystemContext: (fn: () => unknown) => fn(),
}));

/** One `provider_health` row as the driver returns it. */
function healthRow(overrides: Record<string, unknown> = {}) {
  return {
    provider: "yahoo_finance",
    state: "down",
    recent_failures: 137,
    outage_started_at: new Date("2026-08-26T19:03:00Z"),
    last_failure_at: new Date("2026-08-26T21:00:00Z"),
    last_failure_reason:
      "TypeError: fetch failed <- getaddrinfo EAI_AGAIN query1.finance.yahoo.com [code=EAI_AGAIN]",
    last_success_at: new Date("2026-08-26T17:10:00Z"),
    outage_notified_at: null,
    ...overrides,
  };
}

/** What `manager.query` returns for an UPDATE: the `[rows, rowCount]` tuple. */
function updateResult(rows: unknown[]): [unknown[], number] {
  return [rows, rows.length];
}

function adminRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "admin-1",
    email: "ops@example.com",
    first_name: "Ada",
    // Computed by queryAdminRecipients' SQL: address present AND
    // notification_email not disabled.
    email_enabled: true,
    ...overrides,
  };
}

describe("ProviderOutageAlertService", () => {
  let manager: ManagerMock;
  let dataSource: DataSourceMock;
  let emailService: { getStatus: jest.Mock; sendMail: jest.Mock };
  let i18n: { translate: jest.Mock };
  let systemAlerts: { raiseAdminAlert: jest.Mock };
  let service: ProviderOutageAlertService;

  /** Route the four statements the sweep can issue. */
  function route(data: {
    pending?: unknown[];
    outageClaim?: unknown[];
    recoveryClaim?: unknown[];
    admins?: unknown[];
    preferences?: unknown;
  }): void {
    manager.query.mockImplementation((sql: string) => {
      const text = String(sql);
      if (text.includes("SELECT provider, state")) {
        return Promise.resolve(data.pending ?? []);
      }
      // Driver shape, not a convenient one: TypeORM's postgres driver returns
      // `[rows, rowCount]` for an UPDATE, with or without RETURNING. A mock
      // that hands back bare rows lets `result[0]` look like a claimed row --
      // which is exactly the defect that reached a real database, where every
      // field of that "row" was undefined and the send threw with the claim
      // already committed. `A mock must return what the real collaborator
      // returns` (docs/backend/testing.md).
      if (text.includes("SET outage_notified_at = CURRENT_TIMESTAMP")) {
        return Promise.resolve(updateResult(data.outageClaim ?? []));
      }
      if (text.includes("SET outage_notified_at = NULL")) {
        return Promise.resolve(updateResult(data.recoveryClaim ?? []));
      }
      if (text.includes("FROM users u")) {
        return Promise.resolve(data.admins ?? [adminRow()]);
      }
      return Promise.resolve([]);
    });
    manager.getRepository.mockReturnValue({
      findOne: jest.fn().mockResolvedValue(data.preferences ?? null),
    });
  }

  const statements = (): string[] =>
    manager.query.mock.calls.map((call) => String(call[0]));

  beforeEach(() => {
    jest.clearAllMocks();
    const mocks = createScopedDbMocks();
    manager = mocks.manager;
    dataSource = mocks.dataSource;
    emailService = {
      getStatus: jest.fn().mockReturnValue({ configured: true }),
      sendMail: jest.fn().mockResolvedValue(undefined),
    };
    i18n = {
      translate: jest.fn((key: string) => key),
    };
    systemAlerts = {
      raiseAdminAlert: jest.fn().mockResolvedValue({ created: 1, emailed: 0 }),
    };
    service = new ProviderOutageAlertService(
      dataSource as never,
      emailService as never,
      i18n as never,
      systemAlerts as never,
    );
  });

  describe("gating", () => {
    it("still claims and raises the in-app rows without SMTP, and only the email is skipped", async () => {
      // The old shape -- stand down entirely when SMTP is unconfigured -- left
      // an email-less deployment with no notice at all. The in-app alert rows
      // are the delivery now, so the sweep runs, the claim is consumed, and
      // only the email leg skips (inside deliver, per recipient).
      emailService.getStatus.mockReturnValue({ configured: false });
      route({
        pending: [healthRow()],
        outageClaim: [healthRow({ outage_notified_at: new Date() })],
      });
      await service.sweepProviderHealth();
      expect(
        statements().some((s) =>
          s.includes("SET outage_notified_at = CURRENT_TIMESTAMP"),
        ),
      ).toBe(true);
      expect(systemAlerts.raiseAdminAlert).toHaveBeenCalledWith(
        expect.objectContaining({ type: "PROVIDER_OUTAGE", email: false }),
      );
      expect(emailService.sendMail).not.toHaveBeenCalled();
    });

    it("reads only the rows that could produce an email", async () => {
      route({ pending: [] });
      await service.sweepProviderHealth();
      const select = statements()[0];
      expect(select).toContain("state = 'down'");
      expect(select).toContain("outage_notified_at IS NOT NULL");
      expect(emailService.sendMail).not.toHaveBeenCalled();
    });
  });

  describe("outage notice", () => {
    it("claims the episode in SQL with every condition in the WHERE", async () => {
      // Two replicas fire this cron. Reading the conditions and then updating
      // would let both pass -- the shape BudgetAlertService still has.
      route({ pending: [healthRow()], outageClaim: [healthRow()] });
      await service.sweepProviderHealth();

      const claim = statements().find((sql) =>
        sql.includes("SET outage_notified_at = CURRENT_TIMESTAMP"),
      ) as string;
      expect(claim).toContain("AND state = 'down'");
      expect(claim).toContain("AND outage_notified_at IS NULL");
      expect(claim).toContain("outage_started_at <= CURRENT_TIMESTAMP");
      expect(claim).toContain("last_failure_at >= outage_started_at +");
      expect(claim).toContain("last_notified_at IS NULL");
      const params = manager.query.mock.calls.find((call) =>
        String(call[0]).includes("SET outage_notified_at = CURRENT_TIMESTAMP"),
      )?.[1] as unknown[];
      expect(params).toEqual([
        "yahoo_finance",
        String(MIN_OUTAGE_MS),
        String(ALERT_QUIET_PERIOD_MS),
      ]);
    });

    it("sends nothing when another replica won the claim", async () => {
      route({ pending: [healthRow()], outageClaim: [] });
      await service.sweepProviderHealth();
      expect(emailService.sendMail).not.toHaveBeenCalled();
    });

    it("emails the administrators once, with the cause and the timings", async () => {
      route({ pending: [healthRow()], outageClaim: [healthRow()] });
      await service.sweepProviderHealth();

      expect(emailService.sendMail).toHaveBeenCalledTimes(1);
      const [to, subject, html] = emailService.sendMail.mock.calls[0];
      expect(to).toBe("ops@example.com");
      expect(subject).toContain("Yahoo Finance");
      expect(html).toContain("Yahoo Finance");
      expect(html).toContain("2026-08-26 19:03 UTC");
      expect(html).toContain("137");
      expect(html).toContain("EAI_AGAIN");
    });

    it("escapes the provider's own error text before it reaches an inbox", async () => {
      route({
        pending: [healthRow()],
        outageClaim: [
          healthRow({
            last_failure_reason: '<img src=x onerror="alert(1)">',
          }),
        ],
      });
      await service.sweepProviderHealth();
      const html = String(emailService.sendMail.mock.calls[0][2]);
      expect(html).not.toContain("<img src=x");
      expect(html).toContain("&lt;img src=x");
    });

    it("says nothing about a provider that is down but already notified", async () => {
      // The claim's WHERE is what refuses it; the row is still read because it
      // may be the recovery half later.
      route({
        pending: [healthRow({ outage_notified_at: new Date() })],
        outageClaim: [],
      });
      await service.sweepProviderHealth();
      expect(emailService.sendMail).not.toHaveBeenCalled();
    });

    it("does not spend the episode's only notice when nobody can be told", async () => {
      // The claim is consumed once and never retried, so claiming before
      // knowing there is a recipient destroys the alert silently. The state has
      // to survive until somebody can receive it.
      route({
        pending: [healthRow()],
        outageClaim: [healthRow()],
        admins: [],
      });
      await service.sweepProviderHealth();
      expect(emailService.sendMail).not.toHaveBeenCalled();
      expect(
        statements().filter((sql) => sql.includes("SET outage_notified_at")),
      ).toHaveLength(0);
    });

    it("does not query recipients for a row that is plainly not due", async () => {
      route({
        pending: [healthRow({ outage_started_at: new Date() })],
      });
      await service.sweepProviderHealth();
      expect(
        statements().filter((sql) => sql.includes("FROM users u")),
      ).toHaveLength(0);
    });

    it("does not report a single burst that nothing has re-tested", async () => {
      // A PC waking from sleep: every lookup fails with ENOTFOUND in the same
      // second the network returns, then nothing calls the provider again. The
      // row still says down twenty minutes later, but no failure was seen past
      // the first second, so there is no evidence of a fifteen-minute outage.
      const startedAt = new Date(Date.now() - 20 * 60_000);
      route({
        pending: [
          healthRow({
            outage_started_at: startedAt,
            last_failure_at: new Date(startedAt.getTime() + 500),
          }),
        ],
      });
      await service.sweepProviderHealth();
      expect(emailService.sendMail).not.toHaveBeenCalled();
      expect(
        statements().filter((sql) => sql.includes("FROM users u")),
      ).toHaveLength(0);
    });

    it("keeps rendering for the rest when one recipient's locale read fails", async () => {
      // Rendering is inside the per-recipient boundary as much as sending is:
      // the locale comes from a database read, and the claim is already
      // committed, so a throw out of the loop cost every administrator after
      // this one their notice for good.
      route({
        pending: [healthRow()],
        outageClaim: [healthRow()],
        admins: [
          adminRow(),
          adminRow({ id: "admin-2", email: "second@example.com" }),
        ],
      });
      let call = 0;
      manager.getRepository.mockReturnValue({
        findOne: jest.fn(() => {
          call++;
          return call === 1
            ? Promise.reject(new Error("connection terminated"))
            : Promise.resolve({ userId: "admin-2", language: "en" });
        }),
      });

      await service.sweepProviderHealth();

      expect(emailService.sendMail).toHaveBeenCalledTimes(1);
      expect(emailService.sendMail.mock.calls[0][0]).toBe("second@example.com");
    });

    it("emails every administrator, and one bad address costs only itself", async () => {
      route({
        pending: [healthRow()],
        outageClaim: [healthRow()],
        admins: [
          adminRow(),
          adminRow({ id: "admin-2", email: "second@example.com" }),
        ],
      });
      emailService.sendMail
        .mockRejectedValueOnce(new Error("550 mailbox unavailable"))
        .mockResolvedValueOnce(undefined);

      await service.sweepProviderHealth();
      expect(emailService.sendMail).toHaveBeenCalledTimes(2);
    });

    it("renders in each recipient's own language", async () => {
      route({
        pending: [healthRow()],
        outageClaim: [healthRow()],
        preferences: { userId: "admin-1", language: "pl" },
      });
      await service.sweepProviderHealth();
      expect(i18n.translate).toHaveBeenCalledWith(
        "emails.providerOutage.heading",
        expect.objectContaining({ lang: "pl" }),
      );
    });

    it("only offers email to admins who accept it", async () => {
      route({ pending: [healthRow()], outageClaim: [healthRow()] });
      await service.sweepProviderHealth();
      const adminQuery = statements().find((sql) =>
        sql.includes("FROM users u"),
      ) as string;
      expect(adminQuery).toContain("u.role = 'admin'");
      expect(adminQuery).toContain("u.is_active = true");
      expect(adminQuery).toContain("u.is_delegate_only = false");
      expect(adminQuery).toContain(
        "COALESCE(p.notification_email, true) = true",
      );
    });
  });

  describe("recovery notice", () => {
    const recovered = healthRow({
      state: "up",
      outage_notified_at: new Date("2026-08-26T19:20:00Z"),
      last_success_at: new Date("2026-08-26T21:35:00Z"),
    });

    it("clears the episode marker in the same statement that claims it", async () => {
      route({ pending: [recovered], recoveryClaim: [recovered] });
      await service.sweepProviderHealth();
      const claim = statements().find((sql) =>
        sql.includes("SET outage_notified_at = NULL"),
      ) as string;
      expect(claim).toContain("AND state = 'up'");
      expect(claim).toContain("AND outage_notified_at IS NOT NULL");
      // The floor advances too, so a flapping provider cannot mail its way
      // around the quiet period by recovering.
      expect(claim).toContain("last_notified_at = CURRENT_TIMESTAMP");
    });

    it("sends the all-clear with how long the outage lasted", async () => {
      route({ pending: [recovered], recoveryClaim: [recovered] });
      await service.sweepProviderHealth();
      expect(emailService.sendMail).toHaveBeenCalledTimes(1);
      const html = String(emailService.sendMail.mock.calls[0][2]);
      expect(html).toContain("2026-08-26 21:35 UTC");
    });

    it("does not send an all-clear for an outage nobody was told about", async () => {
      route({
        pending: [healthRow({ state: "up", outage_notified_at: null })],
      });
      await service.sweepProviderHealth();
      expect(emailService.sendMail).not.toHaveBeenCalled();
      expect(
        statements().filter((sql) => sql.includes("SET outage_notified_at")),
      ).toHaveLength(0);
    });

    it("renders the all-clear in the recipient's own language too", async () => {
      // The same wiring mistake in the second template would ship English to
      // every recipient and nothing would fail.
      route({
        pending: [recovered],
        recoveryClaim: [recovered],
        preferences: { userId: "admin-1", language: "de" },
      });
      await service.sweepProviderHealth();
      expect(i18n.translate).toHaveBeenCalledWith(
        "emails.providerRecovery.heading",
        expect.objectContaining({ lang: "de" }),
      );
    });

    it("sends nothing when another replica sent the all-clear", async () => {
      route({ pending: [recovered], recoveryClaim: [] });
      await service.sweepProviderHealth();
      expect(emailService.sendMail).not.toHaveBeenCalled();
    });

    it("keeps the episode marker when there is nobody to send it to", async () => {
      // Clearing it with no recipient destroyed both the all-clear and the
      // record that one was owed -- and, unlike the outage path, said nothing.
      route({ pending: [recovered], recoveryClaim: [recovered], admins: [] });
      await service.sweepProviderHealth();
      expect(emailService.sendMail).not.toHaveBeenCalled();
      expect(
        statements().filter((sql) => sql.includes("SET outage_notified_at")),
      ).toHaveLength(0);
    });
  });

  it("says once, not every ten minutes, that there is nobody to tell", async () => {
    // 144 warnings a day about a misconfigured recipient list is the noise this
    // change exists to remove.
    route({ pending: [healthRow()], admins: [] });
    const warn = jest
      .spyOn(Logger.prototype, "warn")
      .mockImplementation(() => undefined);
    try {
      for (let i = 0; i < 5; i++) await service.sweepProviderHealth();
      const lines = warn.mock.calls
        .map((call) => String(call[0]))
        .filter((text) => text.includes("nobody was told"));
      expect(lines).toHaveLength(1);
    } finally {
      warn.mockRestore();
    }
  });

  it("keeps sweeping after one provider's alert throws", async () => {
    manager.query.mockImplementation((sql: string) => {
      const text = String(sql);
      if (text.includes("SELECT provider, state")) {
        return Promise.resolve([
          healthRow({ provider: "msn_finance" }),
          healthRow(),
        ]);
      }
      if (text.includes("SET outage_notified_at = CURRENT_TIMESTAMP")) {
        return Promise.reject(new Error("deadlock detected"));
      }
      return Promise.resolve([adminRow()]);
    });
    await expect(service.sweepProviderHealth()).resolves.toBeUndefined();
    const claims = statements().filter((sql) =>
      sql.includes("SET outage_notified_at = CURRENT_TIMESTAMP"),
    );
    expect(claims).toHaveLength(2);
  });

  describe("in-app companion rows", () => {
    it("raises PROVIDER_OUTAGE only for the claim winner, keyed to the episode, never emailing twice", async () => {
      const startedAt = new Date("2026-08-26T19:03:00Z");
      route({
        pending: [healthRow()],
        outageClaim: [
          healthRow({
            outage_started_at: startedAt,
            outage_notified_at: new Date(),
          }),
        ],
      });
      await service.sweepProviderHealth();
      expect(systemAlerts.raiseAdminAlert).toHaveBeenCalledTimes(1);
      expect(systemAlerts.raiseAdminAlert).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "PROVIDER_OUTAGE",
          // The bespoke outage email above already carries this episode; a
          // second one from the generic template would be the duplicate the
          // claim exists to prevent.
          email: false,
          dedupeKey: `PROVIDER_OUTAGE:yahoo_finance:${startedAt.toISOString()}`,
          data: expect.objectContaining({
            system: true,
            provider: "yahoo_finance",
            providerLabel: expect.any(String),
          }),
        }),
      );
    });

    it("raises no row when the claim is lost", async () => {
      route({ pending: [healthRow()], outageClaim: [] });
      await service.sweepProviderHealth();
      expect(systemAlerts.raiseAdminAlert).not.toHaveBeenCalled();
      expect(emailService.sendMail).not.toHaveBeenCalled();
    });

    it("raises PROVIDER_RECOVERED on the recovery claim, sharing the episode key", async () => {
      const startedAt = new Date("2026-08-26T19:03:00Z");
      route({
        pending: [healthRow({ state: "up", outage_notified_at: new Date() })],
        recoveryClaim: [
          healthRow({
            state: "up",
            outage_started_at: startedAt,
            outage_notified_at: null,
          }),
        ],
      });
      await service.sweepProviderHealth();
      expect(systemAlerts.raiseAdminAlert).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "PROVIDER_RECOVERED",
          email: false,
          dedupeKey: `PROVIDER_RECOVERED:yahoo_finance:${startedAt.toISOString()}`,
        }),
      );
    });

    it("proceeds for admins whose email is off: the claim is consumed, the row raised, nothing mailed", async () => {
      // Before the in-app rows, "no email-enabled admin" meant standing down
      // without consuming the claim. Now the row is the delivery for them.
      route({
        pending: [healthRow()],
        outageClaim: [healthRow({ outage_notified_at: new Date() })],
        admins: [adminRow({ email: null, email_enabled: false })],
      });
      await service.sweepProviderHealth();
      expect(systemAlerts.raiseAdminAlert).toHaveBeenCalledWith(
        expect.objectContaining({ type: "PROVIDER_OUTAGE" }),
      );
      expect(emailService.sendMail).not.toHaveBeenCalled();
    });

    it("stands down entirely, claim unconsumed, only when there is no active administrator at all", async () => {
      route({ pending: [healthRow()], admins: [] });
      await service.sweepProviderHealth();
      expect(
        statements().some((s) => s.includes("SET outage_notified_at")),
      ).toBe(false);
      expect(systemAlerts.raiseAdminAlert).not.toHaveBeenCalled();
    });
  });
});

describe("formatUtcMinute", () => {
  it("is an operator's timestamp: UTC, to the minute, unambiguous", () => {
    expect(formatUtcMinute(new Date("2026-08-26T19:03:47.123Z"))).toBe(
      "2026-08-26 19:03 UTC",
    );
  });
});

describe("formatOutageDuration", () => {
  const t = (_key: string, fallback: string) => fallback;

  it("reports minutes under an hour", () => {
    expect(formatOutageDuration(17 * 60_000, t)).toBe("17 min");
  });

  it("reports hours and minutes above one", () => {
    expect(formatOutageDuration(135 * 60_000, t)).toBe("2 h 15 min");
  });

  it("never reports a negative duration from a clock that disagrees", () => {
    expect(formatOutageDuration(-5000, t)).toBe("0 min");
  });

  it("asks for the recipient's own plural form rather than building one", () => {
    const translate = jest.fn((_key: string, fallback: string) => fallback);
    formatOutageDuration(90 * 60_000, translate);
    expect(translate).toHaveBeenCalledWith(
      "emails.providerOutage.durationHoursMinutes",
      expect.any(String),
      { hours: 1, minutes: 30 },
    );
  });
});
