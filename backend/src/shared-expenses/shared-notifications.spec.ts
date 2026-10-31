import { ExecutionContext, Logger } from "@nestjs/common";
import { DataSource, EntityManager } from "typeorm";
import { lastValueFrom, of, throwError } from "rxjs";
import { withScopedDb } from "../common/db/scoped-db";
import { SystemAlertService } from "../system-alerts/system-alert.service";
import { SharedNotificationsService } from "./shared-notifications.service";
import { SharedNotificationsInterceptor } from "./shared-notifications.interceptor";
import { NotifyOptions } from "../notifications/notification-dispatch.service";

jest.mock("../common/db/scoped-db", () => ({ withScopedDb: jest.fn() }));
describe("Shared notification delivery", () => {
  let query: jest.Mock;
  let manager: EntityManager;
  let raise: jest.Mock;
  let service: SharedNotificationsService;
  beforeEach(() => {
    query = jest.fn().mockResolvedValue([]);
    manager = { query } as unknown as EntityManager;
    jest
      .mocked(withScopedDb)
      .mockImplementation(async (_db, body) => body(manager));
    raise = jest.fn().mockResolvedValue(undefined);
    service = new SharedNotificationsService(
      {} as DataSource,
      { raiseUserAlert: raise } as unknown as SystemAlertService,
    );
  });
  it("uses the recipient seam and records delivery inside its notification transaction", async () => {
    query.mockResolvedValueOnce([
      {
        activity_id: "event",
        recipient_id: "recipient",
        group_id: "group",
        revoked: false,
      },
    ]);
    await service.deliver("group");
    expect(raise).toHaveBeenCalledWith(
      "recipient",
      expect.objectContaining({
        target: "/shared-expenses/group",
        dedupeKey: "shared:event",
        data: { groupId: "group", accessChanged: false },
      }),
      expect.objectContaining({
        fanOut: "detached",
        onWritten: expect.any(Function),
      }),
    );
    expect(query).toHaveBeenCalledTimes(1);
    const options = raise.mock.calls[0][2] as NotifyOptions;
    await options.onWritten!(manager, {} as never);
    expect(query.mock.calls[1][0]).toContain("ON CONFLICT");
    expect(query.mock.calls[1][1]).toEqual(["event", "recipient"]);
  });
  it("does not disclose a revoked group in the notification target", async () => {
    query.mockResolvedValueOnce([
      {
        activity_id: "event",
        recipient_id: "recipient",
        group_id: "group",
        revoked: true,
      },
    ]);
    await service.deliver();
    expect(query).toHaveBeenCalledWith(
      "SELECT * FROM shared_pending_notifications($1)",
      [null],
    );
    expect(raise.mock.calls[0][1].target).toBe("/shared-expenses");
  });
  it("leaves undelivered activity recoverable without failing a committed financial operation", async () => {
    const warn = jest
      .spyOn(Logger.prototype, "warn")
      .mockImplementation(() => undefined);
    query.mockRejectedValueOnce(new Error("Database temporarily unavailable"));
    await expect(service.deliver("group")).resolves.toBeUndefined();
    expect(raise).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("retry on the next read"),
    );
    warn.mockRestore();
  });
});
describe("Shared notification interceptor", () => {
  const context = (groupId?: string) =>
    ({
      switchToHttp: () => ({ getRequest: () => ({ params: { groupId } }) }),
    }) as unknown as ExecutionContext;
  it("emits only after a successful command and never on a rejected write", async () => {
    const deliver = jest.fn().mockResolvedValue(undefined);
    const interceptor = new SharedNotificationsInterceptor({
      deliver,
    } as unknown as SharedNotificationsService);
    expect(
      await lastValueFrom(
        interceptor.intercept(context("group"), {
          handle: () => of({ id: "saved" }),
        }),
      ),
    ).toEqual({ id: "saved" });
    expect(deliver).toHaveBeenCalledWith("group");
    deliver.mockClear();
    await expect(
      lastValueFrom(
        interceptor.intercept(context("group"), {
          handle: () => throwError(() => new Error("stale")),
        }),
      ),
    ).rejects.toThrow("stale");
    expect(deliver).not.toHaveBeenCalled();
    await lastValueFrom(
      interceptor.intercept(context(), { handle: () => of([]) }),
    );
    expect(deliver).not.toHaveBeenCalled();
  });
});
