import { firstValueFrom, of } from "rxjs";
import { RequestContextInterceptor } from "./request-context.interceptor";
import type { RequestContext } from "../request-context";
import { getRequestContext, requestContextStorage } from "../request-context";

describe("RequestContextInterceptor", () => {
  let preferencesRepository: { findOne: jest.Mock; update: jest.Mock };
  let usersRepository: { update: jest.Mock };
  let interceptor: RequestContextInterceptor;

  function makeContext(opts: {
    type?: "http" | "rpc";
    headers?: Record<string, string | string[] | undefined>;
    user?: { id?: string };
  }) {
    const request = {
      headers: opts.headers ?? {},
      user: opts.user,
    };
    return {
      getType: () => opts.type ?? "http",
      switchToHttp: () => ({
        getRequest: () => request,
      }),
    } as any;
  }

  function makeNext(value: unknown = "ok") {
    return {
      handle: jest.fn(() => of(value)),
    };
  }

  beforeEach(() => {
    preferencesRepository = {
      findOne: jest.fn(),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    usersRepository = {
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    interceptor = new RequestContextInterceptor(
      preferencesRepository as any,
      usersRepository as any,
    );
  });

  it("bypasses non-http contexts and returns next.handle() directly", async () => {
    const next = makeNext("rpc-result");
    const ctx = makeContext({ type: "rpc" });

    const result = interceptor.intercept(ctx, next as any);
    await expect(firstValueFrom(result as any)).resolves.toBe("rpc-result");
    expect(preferencesRepository.findOne).not.toHaveBeenCalled();
  });

  it("uses stored timezone when it is a real IANA value", async () => {
    preferencesRepository.findOne.mockResolvedValue({
      timezone: "America/Toronto",
    });
    const next = makeNext();
    const ctx = makeContext({ user: { id: "user-1" } });

    let captured: RequestContext | undefined;
    next.handle.mockImplementation(() => {
      captured = getRequestContext();
      return of("ok");
    });

    const obs$ = (await interceptor.intercept(ctx, next as any)) as any;
    await firstValueFrom(obs$);

    expect(captured).toEqual({ userId: "user-1", timezone: "America/Toronto" });
    expect(preferencesRepository.findOne).toHaveBeenCalledWith({
      where: { userId: "user-1" },
    });
  });

  it("falls back to header timezone when stored value is the 'browser' sentinel", async () => {
    preferencesRepository.findOne.mockResolvedValue({ timezone: "browser" });
    const next = makeNext();
    const ctx = makeContext({
      user: { id: "user-1" },
      headers: { "x-client-timezone": "Europe/Berlin" },
    });

    let captured: RequestContext | undefined;
    next.handle.mockImplementation(() => {
      captured = getRequestContext();
      return of("ok");
    });

    const obs$ = (await interceptor.intercept(ctx, next as any)) as any;
    await firstValueFrom(obs$);

    expect(captured?.timezone).toBe("Europe/Berlin");
  });

  it("falls back to header timezone when stored value is blank", async () => {
    preferencesRepository.findOne.mockResolvedValue({ timezone: "   " });
    const next = makeNext();
    const ctx = makeContext({
      user: { id: "user-1" },
      headers: { "x-client-timezone": "Asia/Tokyo" },
    });

    let captured: RequestContext | undefined;
    next.handle.mockImplementation(() => {
      captured = getRequestContext();
      return of("ok");
    });

    const obs$ = (await interceptor.intercept(ctx, next as any)) as any;
    await firstValueFrom(obs$);

    expect(captured?.timezone).toBe("Asia/Tokyo");
  });

  it("trims the header value and ignores empty header strings", async () => {
    preferencesRepository.findOne.mockResolvedValue(null);
    const next = makeNext();
    const ctx = makeContext({
      user: { id: "user-1" },
      headers: { "x-client-timezone": "   " },
    });

    let captured: RequestContext | undefined;
    next.handle.mockImplementation(() => {
      captured = getRequestContext();
      return of("ok");
    });

    const obs$ = (await interceptor.intercept(ctx, next as any)) as any;
    await firstValueFrom(obs$);

    expect(captured?.timezone).toBeUndefined();
    expect(captured?.userId).toBe("user-1");
  });

  it("ignores non-string header values", async () => {
    preferencesRepository.findOne.mockResolvedValue(null);
    const next = makeNext();
    const ctx = makeContext({
      user: { id: "user-1" },
      headers: { "x-client-timezone": ["dup", "values"] },
    });

    let captured: RequestContext | undefined;
    next.handle.mockImplementation(() => {
      captured = getRequestContext();
      return of("ok");
    });

    const obs$ = (await interceptor.intercept(ctx, next as any)) as any;
    await firstValueFrom(obs$);

    expect(captured?.timezone).toBeUndefined();
  });

  it("does not look up preferences when there is no authenticated user", async () => {
    const next = makeNext();
    const ctx = makeContext({
      headers: { "x-client-timezone": "America/Vancouver" },
    });

    let captured: RequestContext | undefined;
    next.handle.mockImplementation(() => {
      captured = getRequestContext();
      return of("ok");
    });

    const obs$ = (await interceptor.intercept(ctx, next as any)) as any;
    await firstValueFrom(obs$);

    expect(preferencesRepository.findOne).not.toHaveBeenCalled();
    expect(captured?.userId).toBeUndefined();
    expect(captured?.timezone).toBe("America/Vancouver");
  });

  it("propagates errors from the downstream handler", async () => {
    preferencesRepository.findOne.mockResolvedValue(null);
    const ctx = makeContext({ user: { id: "user-1" } });
    const next = {
      handle: jest.fn(() => ({
        subscribe: ({ error }: { error: (e: unknown) => void }) => {
          error(new Error("boom"));
        },
      })),
    };

    const obs$ = (await interceptor.intercept(ctx, next as any)) as any;
    await expect(firstValueFrom(obs$)).rejects.toThrow("boom");
  });

  it("forwards completion to subscribers when downstream completes without value", async () => {
    preferencesRepository.findOne.mockResolvedValue(null);
    const ctx = makeContext({ user: { id: "user-1" } });
    const next = {
      handle: jest.fn(() => ({
        subscribe: ({ complete }: { complete: () => void }) => {
          complete();
        },
      })),
    };

    const completed = await new Promise<boolean>((resolve) => {
      const obs$ = interceptor.intercept(ctx, next as any) as any;
      // The intercept returns a Promise<Observable> when http
      Promise.resolve(obs$).then((observable) => {
        observable.subscribe({
          next: () => resolve(false),
          error: () => resolve(false),
          complete: () => resolve(true),
        });
      });
    });
    expect(completed).toBe(true);
  });

  it("persists a valid X-Client-Timezone header when stored timezone is 'browser'", async () => {
    preferencesRepository.findOne.mockResolvedValue({
      timezone: "browser",
      lastClientTimezone: null,
    });
    const next = makeNext();
    const ctx = makeContext({
      user: { id: "user-1" },
      headers: { "x-client-timezone": "America/Toronto" },
    });

    const obs$ = (await interceptor.intercept(ctx, next as any)) as any;
    await firstValueFrom(obs$);

    expect(preferencesRepository.update).toHaveBeenCalledWith(
      { userId: "user-1" },
      { lastClientTimezone: "America/Toronto" },
    );
  });

  it("does not persist X-Client-Timezone when it matches the cached value", async () => {
    preferencesRepository.findOne.mockResolvedValue({
      timezone: "browser",
      lastClientTimezone: "America/Toronto",
    });
    const next = makeNext();
    const ctx = makeContext({
      user: { id: "user-1" },
      headers: { "x-client-timezone": "America/Toronto" },
    });

    const obs$ = (await interceptor.intercept(ctx, next as any)) as any;
    await firstValueFrom(obs$);

    expect(preferencesRepository.update).not.toHaveBeenCalled();
  });

  it("does not persist when the explicit timezone is already a real IANA value", async () => {
    preferencesRepository.findOne.mockResolvedValue({
      timezone: "America/Toronto",
      lastClientTimezone: null,
    });
    const next = makeNext();
    const ctx = makeContext({
      user: { id: "user-1" },
      headers: { "x-client-timezone": "Europe/Berlin" },
    });

    const obs$ = (await interceptor.intercept(ctx, next as any)) as any;
    await firstValueFrom(obs$);

    expect(preferencesRepository.update).not.toHaveBeenCalled();
  });

  it("ignores invalid X-Client-Timezone header values", async () => {
    preferencesRepository.findOne.mockResolvedValue({
      timezone: "browser",
      lastClientTimezone: null,
    });
    const next = makeNext();
    const ctx = makeContext({
      user: { id: "user-1" },
      headers: { "x-client-timezone": "Not/A_Real_Zone" },
    });

    const obs$ = (await interceptor.intercept(ctx, next as any)) as any;
    await firstValueFrom(obs$);

    expect(preferencesRepository.update).not.toHaveBeenCalled();
  });

  it("swallows persistence failures without breaking the request", async () => {
    preferencesRepository.findOne.mockResolvedValue({
      timezone: "browser",
      lastClientTimezone: null,
    });
    preferencesRepository.update.mockRejectedValue(
      new Error("DB write failed"),
    );
    const next = makeNext("body");
    const ctx = makeContext({
      user: { id: "user-1" },
      headers: { "x-client-timezone": "Europe/Berlin" },
    });

    const obs$ = (await interceptor.intercept(ctx, next as any)) as any;
    // Request still completes successfully even though the side-effect write threw.
    await expect(firstValueFrom(obs$)).resolves.toBe("body");
  });

  it("ALS context is cleared after the request completes", async () => {
    preferencesRepository.findOne.mockResolvedValue({
      timezone: "America/Toronto",
    });
    const next = makeNext();
    const ctx = makeContext({ user: { id: "user-1" } });

    const obs$ = (await interceptor.intercept(ctx, next as any)) as any;
    await firstValueFrom(obs$);

    // Outside of intercept, no ALS context should be active.
    expect(requestContextStorage.getStore()).toBeUndefined();
  });

  describe("last_activity_at tracking", () => {
    it("writes last_activity_at on the first authenticated request", async () => {
      preferencesRepository.findOne.mockResolvedValue(null);
      const next = makeNext();
      const ctx = makeContext({ user: { id: "user-activity-1" } });

      const obs$ = (await interceptor.intercept(ctx, next as any)) as any;
      await firstValueFrom(obs$);

      expect(usersRepository.update).toHaveBeenCalledTimes(1);
      const args = usersRepository.update.mock.calls[0];
      expect(args[0]).toEqual({ id: "user-activity-1" });
      expect(args[1].lastActivityAt).toBeInstanceOf(Date);
    });

    it("throttles repeat writes within the 5-minute window", async () => {
      preferencesRepository.findOne.mockResolvedValue(null);
      const ctx = makeContext({ user: { id: "user-activity-2" } });

      const obs1 = (await interceptor.intercept(ctx, makeNext() as any)) as any;
      await firstValueFrom(obs1);
      const obs2 = (await interceptor.intercept(ctx, makeNext() as any)) as any;
      await firstValueFrom(obs2);

      expect(usersRepository.update).toHaveBeenCalledTimes(1);
    });

    it("does not write activity when there is no authenticated user", async () => {
      preferencesRepository.findOne.mockResolvedValue(null);
      const next = makeNext();
      const ctx = makeContext({});

      const obs$ = (await interceptor.intercept(ctx, next as any)) as any;
      await firstValueFrom(obs$);

      expect(usersRepository.update).not.toHaveBeenCalled();
    });

    it("swallows DB failures and allows the next request to retry", async () => {
      preferencesRepository.findOne.mockResolvedValue(null);
      usersRepository.update.mockRejectedValueOnce(new Error("transient"));
      const ctx = makeContext({ user: { id: "user-activity-3" } });

      const obs1 = (await interceptor.intercept(ctx, makeNext() as any)) as any;
      await expect(firstValueFrom(obs1)).resolves.toBe("ok");
      // Drain the rejection microtask
      await new Promise((r) => setImmediate(r));
      const obs2 = (await interceptor.intercept(ctx, makeNext() as any)) as any;
      await firstValueFrom(obs2);

      expect(usersRepository.update).toHaveBeenCalledTimes(2);
    });
  });
});
