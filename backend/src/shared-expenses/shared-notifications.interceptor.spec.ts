import type { CallHandler, ExecutionContext } from "@nestjs/common";
import { lastValueFrom, of, throwError } from "rxjs";
import { SharedNotificationsInterceptor } from "./shared-notifications.interceptor";
import { SharedNotificationsService } from "./shared-notifications.service";

describe("Shared notification response boundary", () => {
  const context = (groupId?: string) =>
    ({
      switchToHttp: () => ({ getRequest: () => ({ params: { groupId } }) }),
    }) as unknown as ExecutionContext;
  it.each(["group", undefined])(
    "delivers only after a successful group command: %s",
    async (groupId) => {
      const deliver = jest.fn().mockResolvedValue(undefined);
      const interceptor = new SharedNotificationsInterceptor({
        deliver,
      } as unknown as SharedNotificationsService);
      expect(
        await lastValueFrom(
          interceptor.intercept(context(groupId), {
            handle: () => of({ id: "entry" }),
          } as CallHandler),
        ),
      ).toEqual({ id: "entry" });
      expect(deliver).toHaveBeenCalledTimes(groupId ? 1 : 0);
    },
  );
  it("emits nothing for a refused command", async () => {
    const deliver = jest.fn();
    const interceptor = new SharedNotificationsInterceptor({
      deliver,
    } as unknown as SharedNotificationsService);
    await expect(
      lastValueFrom(
        interceptor.intercept(context("group"), {
          handle: () => throwError(() => new Error("refused")),
        }),
      ),
    ).rejects.toThrow("refused");
    expect(deliver).not.toHaveBeenCalled();
  });
});
