import {
  NotificationPreferenceService,
  configurableCategoriesFor,
  NOTIFICATION_PREFERENCE_CATEGORIES,
  NOTIFICATION_CATEGORY_CHANNELS,
  NOTIFICATION_CATEGORY_DEFAULTS,
  THROTTLE_MAX_MINUTES,
} from "./notification-preference.service";
import { NotificationCategory } from "./entities/notification.entity";
import { UserPreference } from "../users/entities/user-preference.entity";
import * as scopedDb from "../common/db/scoped-db";

jest.mock("../common/db/scoped-db");

/**
 * What each category delivers on before its user stores a row, written out as a
 * literal and NOT derived from the table under test: a change to a default is a
 * product decision (docs/specs/notification-preferences.md section 3,
 * docs/specs/bank-sync-notifications.md section 2) and must fail here by name.
 * Every category that existed before bank sync keeps today's global rule.
 */
const GLOBAL_DEFAULT = {
  email: true,
  emailNotification: false,
  push: false,
  unifiedpush: false,
};
const PINNED_DEFAULTS: Record<
  NotificationCategory,
  {
    email: boolean;
    emailNotification: boolean;
    push: boolean;
    unifiedpush: boolean;
  }
> = {
  [NotificationCategory.PAYMENTS]: GLOBAL_DEFAULT,
  [NotificationCategory.BUDGETS]: GLOBAL_DEFAULT,
  [NotificationCategory.SYSTEM]: GLOBAL_DEFAULT,
  [NotificationCategory.BALANCES]: GLOBAL_DEFAULT,
  [NotificationCategory.INVESTMENTS]: GLOBAL_DEFAULT,
  [NotificationCategory.STRATEGIES]: GLOBAL_DEFAULT,
  // What needs the user's action: immediate email and push on.
  [NotificationCategory.BANK_SYNC]: {
    email: true,
    emailNotification: true,
    push: true,
    unifiedpush: false,
  },
  // What only reports: the bell alone.
  [NotificationCategory.BANK_SYNC_ACTIVITY]: GLOBAL_DEFAULT,
};

describe("NotificationPreferenceService", () => {
  let service: NotificationPreferenceService;
  let userPrefRepo: Record<string, jest.Mock>;
  let notifPrefRepo: Record<string, jest.Mock>;
  let query: jest.Mock;

  beforeEach(() => {
    userPrefRepo = { findOne: jest.fn().mockResolvedValue(null) };
    notifPrefRepo = {
      findOne: jest.fn().mockResolvedValue(null),
      find: jest.fn().mockResolvedValue([]),
    };
    query = jest.fn().mockResolvedValue([]);
    const manager = {
      query,
      getRepository: (entity: unknown) =>
        entity === UserPreference ? userPrefRepo : notifPrefRepo,
    };
    (scopedDb.withScopedDb as jest.Mock).mockImplementation(
      (_ds: unknown, fn: (m: unknown) => unknown) => fn(manager),
    );
    service = new NotificationPreferenceService(
      {} as ConstructorParameters<typeof NotificationPreferenceService>[0],
    );
  });

  describe("resolveEmail (report-mode email gate)", () => {
    it("defaults on when there is no row and no master preference", async () => {
      expect(
        await service.resolveEmail("u1", NotificationCategory.PAYMENTS),
      ).toBe(true);
    });

    it("returns false when the master switch is off, whatever the category row says", async () => {
      userPrefRepo.findOne.mockResolvedValue({ notificationEmail: false });
      notifPrefRepo.findOne.mockResolvedValue({ email: true });
      expect(
        await service.resolveEmail("u1", NotificationCategory.PAYMENTS),
      ).toBe(false);
      // The master kill short-circuits: the per-category row is never consulted.
      expect(notifPrefRepo.findOne).not.toHaveBeenCalled();
    });

    it("honours an explicit per-category off while the master is on", async () => {
      userPrefRepo.findOne.mockResolvedValue({ notificationEmail: true });
      notifPrefRepo.findOne.mockResolvedValue({ email: false });
      expect(
        await service.resolveEmail("u1", NotificationCategory.BUDGETS),
      ).toBe(false);
    });

    it("treats a NULL master switch as off, like the producers it replaced", async () => {
      userPrefRepo.findOne.mockResolvedValue({ notificationEmail: null });
      notifPrefRepo.findOne.mockResolvedValue({ email: true });
      expect(
        await service.resolveEmail("u1", NotificationCategory.PAYMENTS),
      ).toBe(false);
      expect(notifPrefRepo.findOne).not.toHaveBeenCalled();
    });

    it("is OFF for a category that does not expose report-mode email, whatever is stored", async () => {
      // SYSTEM exposes push only (NOTIFICATION_CATEGORY_CHANNELS). The absent-row
      // default of `true` must not reach it, and neither must a stored `true`:
      // the matrix never shows the cell, so nobody could switch it back off.
      expect(NOTIFICATION_CATEGORY_CHANNELS.SYSTEM.email).toBe(false);
      userPrefRepo.findOne.mockResolvedValue({ notificationEmail: true });
      notifPrefRepo.findOne.mockResolvedValue({ email: true });
      expect(
        await service.resolveEmail("u1", NotificationCategory.SYSTEM),
      ).toBe(false);
      // Decided from the support table alone; no preference read is needed.
      expect(userPrefRepo.findOne).not.toHaveBeenCalled();
      expect(notifPrefRepo.findOne).not.toHaveBeenCalled();
    });
  });

  describe("configurableCategoriesFor", () => {
    it("lists every matrix category for an admin", () => {
      expect(configurableCategoriesFor(true)).toEqual(
        NOTIFICATION_PREFERENCE_CATEGORIES,
      );
    });

    it("omits SYSTEM for everyone else, whose alerts are never raised", () => {
      const categories = configurableCategoriesFor(false);
      expect(categories).not.toContain(NotificationCategory.SYSTEM);
      expect(categories).toEqual(
        NOTIFICATION_PREFERENCE_CATEGORIES.filter(
          (c) => c !== NotificationCategory.SYSTEM,
        ),
      );
      // The other rows are untouched -- this is a filter, not a second list.
      expect(categories.length).toBe(
        NOTIFICATION_PREFERENCE_CATEGORIES.length - 1,
      );
    });

    it("returns only the requested categories from list()", async () => {
      const result = await service.list("u1", configurableCategoriesFor(false));
      expect(result.map((r) => r.category)).not.toContain(
        NotificationCategory.SYSTEM,
      );
      expect(result).toHaveLength(
        NOTIFICATION_PREFERENCE_CATEGORIES.length - 1,
      );
    });
  });

  describe("list", () => {
    it("returns the default shape per category, with each category's supported channels", async () => {
      expect(
        await service.list("u1", NOTIFICATION_PREFERENCE_CATEGORIES),
      ).toEqual(
        NOTIFICATION_PREFERENCE_CATEGORIES.map((category) => ({
          category,
          ...PINNED_DEFAULTS[category],
          throttleMinutes: 0,
          supportedChannels: NOTIFICATION_CATEGORY_CHANNELS[category],
        })),
      );
    });

    it("reflects stored per-category state and is not master-gated", async () => {
      // Master off must NOT bleed into the displayed per-category state.
      userPrefRepo.findOne.mockResolvedValue({ notificationEmail: false });
      notifPrefRepo.find.mockResolvedValue([
        {
          category: NotificationCategory.PAYMENTS,
          email: false,
          emailNotification: true,
          push: true,
          unifiedpush: true,
          throttleMinutes: 30,
        },
      ]);
      const res = await service.list("u1", NOTIFICATION_PREFERENCE_CATEGORIES);
      expect(
        res.find((r) => r.category === NotificationCategory.PAYMENTS),
      ).toEqual({
        category: NotificationCategory.PAYMENTS,
        email: false,
        emailNotification: true,
        push: true,
        unifiedpush: true,
        throttleMinutes: 30,
        supportedChannels:
          NOTIFICATION_CATEGORY_CHANNELS[NotificationCategory.PAYMENTS],
      });
      expect(
        res.find((r) => r.category === NotificationCategory.BUDGETS),
      ).toEqual({
        category: NotificationCategory.BUDGETS,
        email: true,
        emailNotification: false,
        push: false,
        unifiedpush: false,
        throttleMinutes: 0,
        supportedChannels:
          NOTIFICATION_CATEGORY_CHANNELS[NotificationCategory.BUDGETS],
      });
    });

    it("exposes SYSTEM as a push-only category (email channels not applicable, both push wires live)", async () => {
      const system = (
        await service.list("u1", NOTIFICATION_PREFERENCE_CATEGORIES)
      ).find((r) => r.category === NotificationCategory.SYSTEM);
      expect(system).toEqual({
        category: NotificationCategory.SYSTEM,
        email: true,
        emailNotification: false,
        push: false,
        unifiedpush: false,
        throttleMinutes: 0,
        supportedChannels: {
          email: false,
          emailNotification: false,
          push: true,
          unifiedpush: true,
        },
      });
    });

    it("clamps a stored throttle window above the cap", async () => {
      notifPrefRepo.find.mockResolvedValue([
        {
          category: NotificationCategory.BUDGETS,
          email: true,
          emailNotification: false,
          throttleMinutes: THROTTLE_MAX_MINUTES + 500,
        },
      ]);
      const budgets = (
        await service.list("u1", NOTIFICATION_PREFERENCE_CATEGORIES)
      ).find((r) => r.category === NotificationCategory.BUDGETS);
      expect(budgets?.throttleMinutes).toBe(THROTTLE_MAX_MINUTES);
    });
  });

  describe("updatePreference", () => {
    it("upserts with COALESCE so an omitted field keeps its stored value", async () => {
      notifPrefRepo.findOne.mockResolvedValue({
        email: false,
        emailNotification: false,
        push: false,
        unifiedpush: false,
        throttleMinutes: 0,
      });
      const result = await service.updatePreference(
        "u1",
        NotificationCategory.PAYMENTS,
        { email: false },
      );
      const [sql, params] = query.mock.calls[0];
      expect(String(sql)).toContain(
        "ON CONFLICT (user_id, category) DO UPDATE",
      );
      // Only email present -> its param; the others omitted pass NULL, so
      // COALESCE keeps their stored values. Order: email, emailNotification,
      // throttle, push, unifiedpush.
      expect(params).toEqual([
        "u1",
        NotificationCategory.PAYMENTS,
        false,
        null,
        null,
        null,
        null,
        // first-write values: the category's defaults (global for these two)
        true,
        false,
        false,
        false,
      ]);
      expect(result).toEqual({
        category: NotificationCategory.PAYMENTS,
        email: false,
        emailNotification: false,
        push: false,
        unifiedpush: false,
        throttleMinutes: 0,
        supportedChannels:
          NOTIFICATION_CATEGORY_CHANNELS[NotificationCategory.PAYMENTS],
      });
    });

    it("writes each field independently (notification email and throttle)", async () => {
      notifPrefRepo.findOne.mockResolvedValue({
        email: true,
        emailNotification: true,
        push: false,
        throttleMinutes: 15,
      });
      await service.updatePreference("u1", NotificationCategory.BUDGETS, {
        emailNotification: true,
        throttleMinutes: 15,
      });
      const params = query.mock.calls[0][1];
      // email, push and unifiedpush omitted -> NULL; notification email and
      // throttle set.
      expect(params).toEqual([
        "u1",
        NotificationCategory.BUDGETS,
        null,
        true,
        15,
        null,
        null,
        // first-write values: the category's defaults (global for these two)
        true,
        false,
        false,
        false,
      ]);
    });

    it("writes the push channel independently", async () => {
      notifPrefRepo.findOne.mockResolvedValue({
        email: true,
        emailNotification: false,
        push: true,
        throttleMinutes: 0,
      });
      await service.updatePreference("u1", NotificationCategory.PAYMENTS, {
        push: true,
      });
      const params = query.mock.calls[0][1];
      // Only push present -> the sixth param; the rest NULL.
      expect(params).toEqual([
        "u1",
        NotificationCategory.PAYMENTS,
        null,
        null,
        null,
        true,
        null,
        // first-write values: the category's defaults (global for these two)
        true,
        false,
        false,
        false,
      ]);
    });

    it("writes the unifiedpush channel independently (the seventh param)", async () => {
      notifPrefRepo.findOne.mockResolvedValue({
        email: true,
        emailNotification: false,
        push: false,
        unifiedpush: true,
        throttleMinutes: 0,
      });
      await service.updatePreference("u1", NotificationCategory.PAYMENTS, {
        unifiedpush: true,
      });
      const params = query.mock.calls[0][1];
      // Only unifiedpush present -> the seventh param; the rest NULL.
      expect(params).toEqual([
        "u1",
        NotificationCategory.PAYMENTS,
        null,
        null,
        null,
        null,
        true,
        // first-write values: the category's defaults (global for these two)
        true,
        false,
        false,
        false,
      ]);
    });

    it("clamps a throttle window above the cap before writing", async () => {
      notifPrefRepo.findOne.mockResolvedValue({
        email: true,
        emailNotification: false,
        push: false,
        throttleMinutes: THROTTLE_MAX_MINUTES,
      });
      await service.updatePreference("u1", NotificationCategory.BUDGETS, {
        throttleMinutes: THROTTLE_MAX_MINUTES + 999,
      });
      const params = query.mock.calls[0][1];
      expect(params).toEqual([
        "u1",
        NotificationCategory.BUDGETS,
        null,
        null,
        THROTTLE_MAX_MINUTES,
        null,
        null,
        // first-write values: the category's defaults (global for these two)
        true,
        false,
        false,
        false,
      ]);
    });

    it("writes 0 for a throttle window of 0 (disable), not NULL", async () => {
      notifPrefRepo.findOne.mockResolvedValue({
        email: true,
        emailNotification: false,
        push: false,
        throttleMinutes: 0,
      });
      await service.updatePreference("u1", NotificationCategory.BUDGETS, {
        throttleMinutes: 0,
      });
      const params = query.mock.calls[0][1];
      expect(params).toEqual([
        "u1",
        NotificationCategory.BUDGETS,
        null,
        null,
        0,
        null,
        null,
        // first-write values: the category's defaults (global for these two)
        true,
        false,
        false,
        false,
      ]);
    });
  });

  describe("per-category defaults (no stored row)", () => {
    it("pins every category's defaults: the six that existed are unchanged, bank sync is by importance", () => {
      expect(NOTIFICATION_CATEGORY_DEFAULTS).toEqual(PINNED_DEFAULTS);
      // Total over the enum: a new category cannot inherit a default silently.
      expect(Object.keys(NOTIFICATION_CATEGORY_DEFAULTS).sort()).toEqual(
        Object.values(NotificationCategory).sort(),
      );
    });

    it.each(Object.values(NotificationCategory))(
      "resolves %s's immediate channels from the table when no row exists, subject to the channels it exposes",
      async (category) => {
        const support = NOTIFICATION_CATEGORY_CHANNELS[category];
        const pinned = PINNED_DEFAULTS[category];
        expect(
          await service.resolveNotificationDelivery("u1", category),
        ).toEqual({
          emailNotification:
            support.emailNotification && pinned.emailNotification,
          push: support.push && pinned.push,
          unifiedpush: support.unifiedpush && pinned.unifiedpush,
          throttleMinutes: 0,
        });
      },
    );

    it("delivers a bank connection notice by immediate email and push, and a sync report by neither", async () => {
      expect(
        await service.resolveNotificationDelivery(
          "u1",
          NotificationCategory.BANK_SYNC,
        ),
      ).toEqual({
        emailNotification: true,
        push: true,
        unifiedpush: false,
        throttleMinutes: 0,
      });
      expect(
        await service.resolveNotificationDelivery(
          "u1",
          NotificationCategory.BANK_SYNC_ACTIVITY,
        ),
      ).toEqual({
        emailNotification: false,
        push: false,
        unifiedpush: false,
        throttleMinutes: 0,
      });
    });

    it("lets a stored row win over the default, in both directions", async () => {
      notifPrefRepo.findOne.mockResolvedValue({
        emailNotification: false,
        push: false,
        unifiedpush: true,
        throttleMinutes: 0,
      });
      expect(
        await service.resolveNotificationDelivery(
          "u1",
          NotificationCategory.BANK_SYNC,
        ),
      ).toEqual({
        emailNotification: false,
        push: false,
        unifiedpush: true,
        throttleMinutes: 0,
      });
    });

    it("still lets the master email switch kill the default immediate email, and not the default push", async () => {
      userPrefRepo.findOne.mockResolvedValue({ notificationEmail: false });
      expect(
        await service.resolveNotificationDelivery(
          "u1",
          NotificationCategory.BANK_SYNC,
        ),
      ).toMatchObject({ emailNotification: false, push: true });
    });

    it("shows the defaults in the matrix when no row is stored", async () => {
      const rows = await service.list("u1", [
        NotificationCategory.BANK_SYNC,
        NotificationCategory.BANK_SYNC_ACTIVITY,
      ]);
      expect(rows).toEqual([
        {
          category: NotificationCategory.BANK_SYNC,
          email: true,
          emailNotification: true,
          push: true,
          unifiedpush: false,
          throttleMinutes: 0,
          supportedChannels:
            NOTIFICATION_CATEGORY_CHANNELS[NotificationCategory.BANK_SYNC],
        },
        {
          category: NotificationCategory.BANK_SYNC_ACTIVITY,
          email: true,
          emailNotification: false,
          push: false,
          unifiedpush: false,
          throttleMinutes: 0,
          supportedChannels:
            NOTIFICATION_CATEGORY_CHANNELS[
              NotificationCategory.BANK_SYNC_ACTIVITY
            ],
        },
      ]);
    });

    it("keeps the other defaults when a first write names one channel", async () => {
      // Switching push off on a category that defaults push AND email on must
      // not store the email off with it: the first-write value of a channel the
      // patch did not name is the category's default, not a hard-coded false.
      await service.updatePreference("u1", NotificationCategory.BANK_SYNC, {
        push: false,
      });
      const [sql, params] = query.mock.calls[0];
      expect(String(sql)).toContain("COALESCE($4::boolean, $9::boolean)");
      expect(params).toEqual([
        "u1",
        NotificationCategory.BANK_SYNC,
        null, // email: keep the stored value on conflict
        null, // emailNotification
        null, // throttle
        false, // push: the patch
        null, // unifiedpush
        true, // first-write email = default
        true, // first-write emailNotification = default
        true, // first-write push = default (overridden by the patch above)
        false, // first-write unifiedpush = default
      ]);
    });
  });

  describe("resolveNotificationDelivery (the dispatch's one read)", () => {
    it("defaults everything off: no email, no push, no unifiedpush, no throttle", async () => {
      expect(
        await service.resolveNotificationDelivery(
          "u1",
          NotificationCategory.PAYMENTS,
        ),
      ).toEqual({
        emailNotification: false,
        push: false,
        unifiedpush: false,
        throttleMinutes: 0,
      });
    });

    it("returns the stored flags and clamped throttle when the master is on", async () => {
      userPrefRepo.findOne.mockResolvedValue({ notificationEmail: true });
      notifPrefRepo.findOne.mockResolvedValue({
        emailNotification: true,
        push: true,
        unifiedpush: true,
        throttleMinutes: 15,
      });
      expect(
        await service.resolveNotificationDelivery(
          "u1",
          NotificationCategory.BUDGETS,
        ),
      ).toEqual({
        emailNotification: true,
        push: true,
        unifiedpush: true,
        throttleMinutes: 15,
      });
    });

    it("kills the immediate email on the master switch but NOT push or unifiedpush", async () => {
      userPrefRepo.findOne.mockResolvedValue({ notificationEmail: false });
      notifPrefRepo.findOne.mockResolvedValue({
        emailNotification: true,
        push: true,
        unifiedpush: true,
        throttleMinutes: 0,
      });
      expect(
        await service.resolveNotificationDelivery(
          "u1",
          NotificationCategory.BUDGETS,
        ),
      ).toEqual({
        emailNotification: false,
        push: true,
        unifiedpush: true,
        throttleMinutes: 0,
      });
    });

    it("clamps a stored throttle window above the cap", async () => {
      notifPrefRepo.findOne.mockResolvedValue({
        emailNotification: false,
        push: true,
        throttleMinutes: THROTTLE_MAX_MINUTES + 500,
      });
      const res = await service.resolveNotificationDelivery(
        "u1",
        NotificationCategory.BUDGETS,
      );
      expect(res.throttleMinutes).toBe(THROTTLE_MAX_MINUTES);
    });

    it("forces SYSTEM's immediate email off whatever the row says, and honours push", async () => {
      // SYSTEM does not expose email as a user control (NOTIFICATION_CATEGORY_CHANNELS),
      // so a value written to that unsupported cell can never become a delivery --
      // even with the master switch on.
      userPrefRepo.findOne.mockResolvedValue({ notificationEmail: true });
      notifPrefRepo.findOne.mockResolvedValue({
        emailNotification: true,
        push: true,
        unifiedpush: true,
        throttleMinutes: 0,
      });
      expect(
        await service.resolveNotificationDelivery(
          "u1",
          NotificationCategory.SYSTEM,
        ),
      ).toEqual({
        emailNotification: false,
        push: true,
        unifiedpush: true,
        throttleMinutes: 0,
      });
    });
  });
});
