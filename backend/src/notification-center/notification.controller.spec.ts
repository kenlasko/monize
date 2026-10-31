import { Test } from "@nestjs/testing";

import { NotificationController } from "./notification.controller";
import { NotificationService } from "./notification.service";
import { BudgetsService } from "../budgets/budgets.service";
import { SharedNotificationsService } from "../shared-expenses/shared-notifications.service";

describe("NotificationController", () => {
  const notifications = {
    list: jest.fn(),
    markRead: jest.fn(),
    markAllRead: jest.fn(),
    dismiss: jest.fn(),
    dismissAll: jest.fn(),
  };
  const budgets = { ensureBillDueNotifications: jest.fn() };
  const shared = { deliver: jest.fn() };
  const req = { user: { id: "user-1" } };
  let controller: NotificationController;

  beforeEach(async () => {
    jest.clearAllMocks();
    notifications.list.mockResolvedValue([]);
    budgets.ensureBillDueNotifications.mockResolvedValue(undefined);
    shared.deliver.mockResolvedValue(undefined);
    const module = await Test.createTestingModule({
      controllers: [NotificationController],
      providers: [
        { provide: NotificationService, useValue: notifications },
        { provide: BudgetsService, useValue: budgets },
        { provide: SharedNotificationsService, useValue: shared },
      ],
    }).compile();
    controller = module.get(NotificationController);
  });

  describe("list", () => {
    it("does not materialize notifications while a delegate reads the feed", async () => {
      await controller.list({ user: { id: "owner-1", isActing: true } });
      expect(budgets.ensureBillDueNotifications).not.toHaveBeenCalled();
      expect(shared.deliver).not.toHaveBeenCalled();
      expect(notifications.list).toHaveBeenCalledWith("owner-1", {
        unreadOnly: false,
      });
    });

    it("materializes pending bill reminders before reading", async () => {
      await controller.list(req);

      expect(budgets.ensureBillDueNotifications).toHaveBeenCalledWith("user-1");
      expect(shared.deliver).toHaveBeenCalledTimes(1);
      expect(notifications.list).toHaveBeenCalledWith("user-1", {
        unreadOnly: false,
      });
    });

    // The bell polls the unread count. Producing rows on every poll would make
    // a read endpoint a writer on the hot path.
    it("does not materialize anything for an unread-only read", async () => {
      await controller.list(req, true);

      expect(budgets.ensureBillDueNotifications).not.toHaveBeenCalled();
      expect(shared.deliver).not.toHaveBeenCalled();
      expect(notifications.list).toHaveBeenCalledWith("user-1", {
        unreadOnly: true,
      });
    });

    it("materializes when the flag is absent, not merely when it is false", async () => {
      await controller.list(req, undefined);

      expect(budgets.ensureBillDueNotifications).toHaveBeenCalledWith("user-1");
    });

    it("returns what the service returned", async () => {
      notifications.list.mockResolvedValue([{ id: "n-1" }]);

      await expect(controller.list(req)).resolves.toEqual([{ id: "n-1" }]);
    });
  });

  // The userId comes from the JWT on every one of these, never from the path or
  // the body.
  it.each([
    ["markRead", () => controller.markRead(req, "n-1"), ["user-1", "n-1"]],
    ["dismiss", () => controller.dismiss(req, "n-1"), ["user-1", "n-1"]],
    ["markAllRead", () => controller.markAllRead(req), ["user-1"]],
  ])("%s delegates with the caller's own id", async (method, call, args) => {
    await call();

    expect(
      (notifications as Record<string, jest.Mock>)[method],
    ).toHaveBeenCalledWith(...(args as unknown[]));
  });

  describe("dismissAll", () => {
    it("passes the active filter through unchanged", async () => {
      await controller.dismissAll(req, {
        severity: undefined,
        category: "system",
      });

      expect(notifications.dismissAll).toHaveBeenCalledWith("user-1", {
        severity: undefined,
        category: "system",
      });
    });

    it("passes an empty filter through rather than inventing one", async () => {
      await controller.dismissAll(req, {});

      expect(notifications.dismissAll).toHaveBeenCalledWith("user-1", {});
    });
  });
});
