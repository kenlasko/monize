import { firstValueFrom, of } from "rxjs";
import { RequestContextInterceptor } from "./request-context.interceptor";
import type { RequestContext } from "../request-context";
import { getRequestContext, requestContextStorage } from "../request-context";
import { UserPreference } from "../../users/entities/user-preference.entity";
import { User } from "../../users/entities/user.entity";
import { createScopedDbMocks } from "../../test-helpers/scoped-db-testing";

jest.mock("../db/scoped-db", () =>
  jest
    .requireActual("../../test-helpers/scoped-db-testing")
    .scopedDbMockModule(),
);

describe("RequestContextInterceptor", () => {
  let preferencesRepository: { findOne: jest.Mock; update: jest.Mock };
  let usersRepository: { update: jest.Mock };
  let interceptor: RequestContextInterceptor;

  function makeContext(opts: {
    type?: "http" | "rpc";
    headers?: Record<string, string | string[] | undefined>;
    user?: {
      id?: string;
      realUserId?: string;
      pat?: { tokenId: string; scopes: string };
    };
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
    // Both fire-and-forget writes now go through `withScopedDb`, so the
    // repositories are reached via the scoped transaction's manager.
    const { dataSource } = createScopedDbMocks([
      [UserPreference, preferencesRepository as never],
      [User, usersRepository as never],
    ]);
    interceptor = new RequestContextInterceptor(dataSource as never);
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
    const ctx = makeContext({
      user: { id: "11111111-1111-1111-1111-111111111111" },
    });

    let captured: RequestContext | undefined;
    next.handle.mockImplementation(() => {
      captured = getRequestContext();
      return of("ok");
    });

    const obs$ = (await interceptor.intercept(ctx, next as any)) as any;
    await firstValueFrom(obs$);

    expect(captured).toEqual({
      userId: "11111111-1111-1111-1111-111111111111",
      realUserId: "11111111-1111-1111-1111-111111111111",
      timezone: "America/Toronto",
    });
    expect(preferencesRepository.findOne).toHaveBeenCalledWith({
      where: { userId: "11111111-1111-1111-1111-111111111111" },
    });
  });

  it("seeds realUserId from the delegate's own id while acting as an owner", async () => {
    preferencesRepository.findOne.mockResolvedValue({
      timezone: "America/Toronto",
    });
    const next = makeNext();
    // Delegation: jwt.strategy has rewritten `id` to the owner and kept the
    // delegate's own id in `realUserId`.
    const ctx = makeContext({
      user: {
        id: "22222222-2222-2222-2222-222222222222",
        realUserId: "33333333-3333-3333-3333-333333333333",
      },
    });

    let captured: RequestContext | undefined;
    next.handle.mockImplementation(() => {
      captured = getRequestContext();
      return of("ok");
    });

    const obs$ = (await interceptor.intercept(ctx, next as any)) as any;
    await firstValueFrom(obs$);

    expect(captured).toEqual({
      userId: "22222222-2222-2222-2222-222222222222",
      realUserId: "33333333-3333-3333-3333-333333333333",
      timezone: "America/Toronto",
    });
  });

  it("falls back to header timezone when stored value is the 'browser' sentinel", async () => {
    preferencesRepository.findOne.mockResolvedValue({ timezone: "browser" });
    const next = makeNext();
    const ctx = makeContext({
      user: { id: "11111111-1111-1111-1111-111111111111" },
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
      user: { id: "11111111-1111-1111-1111-111111111111" },
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
      user: { id: "11111111-1111-1111-1111-111111111111" },
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
    expect(captured?.userId).toBe("11111111-1111-1111-1111-111111111111");
  });

  it("ignores non-string header values", async () => {
    preferencesRepository.findOne.mockResolvedValue(null);
    const next = makeNext();
    const ctx = makeContext({
      user: { id: "11111111-1111-1111-1111-111111111111" },
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
    const ctx = makeContext({
      user: { id: "11111111-1111-1111-1111-111111111111" },
    });
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
    const ctx = makeContext({
      user: { id: "11111111-1111-1111-1111-111111111111" },
    });
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
      user: { id: "11111111-1111-1111-1111-111111111111" },
      headers: { "x-client-timezone": "America/Toronto" },
    });

    const obs$ = (await interceptor.intercept(ctx, next as any)) as any;
    await firstValueFrom(obs$);

    expect(preferencesRepository.update).toHaveBeenCalledWith(
      { userId: "11111111-1111-1111-1111-111111111111" },
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
      user: { id: "11111111-1111-1111-1111-111111111111" },
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
      user: { id: "11111111-1111-1111-1111-111111111111" },
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
      user: { id: "11111111-1111-1111-1111-111111111111" },
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
      user: { id: "11111111-1111-1111-1111-111111111111" },
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
    const ctx = makeContext({
      user: { id: "11111111-1111-1111-1111-111111111111" },
    });

    const obs$ = (await interceptor.intercept(ctx, next as any)) as any;
    await firstValueFrom(obs$);

    // Outside of intercept, no ALS context should be active.
    expect(requestContextStorage.getStore()).toBeUndefined();
  });

  describe("last_activity_at tracking", () => {
    it("writes last_activity_at on the first authenticated request", async () => {
      preferencesRepository.findOne.mockResolvedValue(null);
      const next = makeNext();
      const ctx = makeContext({
        user: { id: "44444444-4444-4444-4444-444444444441" },
      });

      const obs$ = (await interceptor.intercept(ctx, next as any)) as any;
      await firstValueFrom(obs$);

      expect(usersRepository.update).toHaveBeenCalledTimes(1);
      const args = usersRepository.update.mock.calls[0];
      expect(args[0]).toEqual({ id: "44444444-4444-4444-4444-444444444441" });
      expect(args[1].lastActivityAt).toBeInstanceOf(Date);
    });

    it("does not write last_activity_at for a personal access token request", async () => {
      preferencesRepository.findOne.mockResolvedValue(null);
      const ctx = makeContext({
        user: {
          id: "44444444-4444-4444-4444-444444444443",
          pat: {
            tokenId: "55555555-5555-5555-5555-555555555551",
            scopes: "read",
          },
        },
      });

      const obs$ = (await interceptor.intercept(ctx, makeNext() as any)) as any;
      await firstValueFrom(obs$);
      await new Promise((r) => setImmediate(r));

      expect(usersRepository.update).not.toHaveBeenCalled();
    });

    it("writes last_activity_at for the same user without pat", async () => {
      preferencesRepository.findOne.mockResolvedValue(null);
      const ctx = makeContext({
        user: { id: "44444444-4444-4444-4444-444444444444" },
      });

      const obs$ = (await interceptor.intercept(ctx, makeNext() as any)) as any;
      await firstValueFrom(obs$);

      expect(usersRepository.update).toHaveBeenCalledTimes(1);
    });

    it("throttles repeat writes within the 5-minute window", async () => {
      preferencesRepository.findOne.mockResolvedValue(null);
      const ctx = makeContext({
        user: { id: "44444444-4444-4444-4444-444444444442" },
      });

      const obs1 = (await interceptor.intercept(ctx, makeNext() as any)) as any;
      await firstValueFrom(obs1);
      const obs2 = (await interceptor.intercept(ctx, makeNext() as any)) as any;
      await firstValueFrom(obs2);

      expect(usersRepository.update).toHaveBeenCalledTimes(1);
    });

    // P2-008: an acting JWT resolves `id` to the OWNER and `realUserId` to the
    // delegate. Stamping the owner's row made a delegate's traffic look like the
    // owner signing in, so a delegate making one request every few days held the
    // owner's emergency-access waiting period at zero forever.
    it("stamps the delegate's own row, never the owner's, while acting", async () => {
      preferencesRepository.findOne.mockResolvedValue(null);
      const owner = "44444444-4444-4444-4444-44444444000a";
      const delegate = "44444444-4444-4444-4444-44444444000b";
      const ctx = makeContext({
        user: { id: owner, realUserId: delegate },
      });

      const obs$ = (await interceptor.intercept(ctx, makeNext() as any)) as any;
      await firstValueFrom(obs$);

      expect(usersRepository.update).toHaveBeenCalledTimes(1);
      expect(usersRepository.update.mock.calls[0][0]).toEqual({ id: delegate });
    });

    it("still resets the owner's own clock on the owner's own request", async () => {
      preferencesRepository.findOne.mockResolvedValue(null);
      const owner = "44444444-4444-4444-4444-44444444000c";
      const ctx = makeContext({ user: { id: owner, realUserId: owner } });

      const obs$ = (await interceptor.intercept(ctx, makeNext() as any)) as any;
      await firstValueFrom(obs$);

      expect(usersRepository.update.mock.calls[0][0]).toEqual({ id: owner });
    });

    it("throttles per authenticated user, not per acted-on owner", async () => {
      // Two delegates acting for the same owner are two humans: the throttle
      // must not let one of them silence the other's activity record.
      preferencesRepository.findOne.mockResolvedValue(null);
      const owner = "44444444-4444-4444-4444-44444444000d";
      const first = "44444444-4444-4444-4444-44444444000e";
      const second = "44444444-4444-4444-4444-44444444000f";

      for (const realUserId of [first, second]) {
        const obs$ = (await interceptor.intercept(
          makeContext({ user: { id: owner, realUserId } }),
          makeNext() as any,
        )) as any;
        await firstValueFrom(obs$);
      }

      expect(usersRepository.update.mock.calls.map((c) => c[0])).toEqual([
        { id: first },
        { id: second },
      ]);
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
      const ctx = makeContext({
        user: { id: "44444444-4444-4444-4444-444444444443" },
      });

      const obs1 = (await interceptor.intercept(ctx, makeNext() as any)) as any;
      await expect(firstValueFrom(obs1)).resolves.toBe("ok");
      // Drain the rejection microtask
      await new Promise((r) => setImmediate(r));
      const obs2 = (await interceptor.intercept(ctx, makeNext() as any)) as any;
      await firstValueFrom(obs2);

      expect(usersRepository.update).toHaveBeenCalledTimes(2);
    });

    it("swallows non-Error rejections from the activity write", async () => {
      preferencesRepository.findOne.mockResolvedValue(null);
      usersRepository.update.mockRejectedValueOnce("raw-string-error");
      const ctx = makeContext({
        user: { id: "44444444-4444-4444-4444-444444444444" },
      });

      const obs$ = (await interceptor.intercept(ctx, makeNext() as any)) as any;
      await expect(firstValueFrom(obs$)).resolves.toBe("ok");
      await new Promise((r) => setImmediate(r));
    });
  });

  it("swallows non-Error rejections from the timezone persistence write", async () => {
    preferencesRepository.findOne.mockResolvedValue({
      timezone: "browser",
      lastClientTimezone: null,
    });
    preferencesRepository.update.mockRejectedValueOnce("raw-string-error");
    const next = makeNext("body");
    const ctx = makeContext({
      user: { id: "55555555-5555-5555-5555-555555555555" },
      headers: { "x-client-timezone": "Europe/Berlin" },
    });

    const obs$ = (await interceptor.intercept(ctx, next as any)) as any;
    await expect(firstValueFrom(obs$)).resolves.toBe("body");
    await new Promise((r) => setImmediate(r));
  });

  // RLS (task C6): the interceptor's own writes (last_activity_at, cached
  // client timezone) and its preference read run BEFORE it enters its
  // requestContextStorage scope, so each is wrapped in withUserContext(userId).
  // We assert the ambient context at the moment each DB call fires.
  describe("RLS context wrapping (task C6)", () => {
    const UID = "66666666-6666-6666-6666-666666666666";

    it("reads the timezone preference under a user context", async () => {
      let ctx: RequestContext | undefined;
      preferencesRepository.findOne.mockImplementation(() => {
        ctx = getRequestContext();
        return Promise.resolve({ timezone: "America/Toronto" });
      });
      const ctxObj = makeContext({ user: { id: UID } });

      const obs$ = (await interceptor.intercept(
        ctxObj,
        makeNext() as any,
      )) as any;
      await firstValueFrom(obs$);

      expect(ctx).toEqual({ userId: UID });
    });

    it("writes last_activity_at under a user context", async () => {
      preferencesRepository.findOne.mockResolvedValue(null);
      let ctx: RequestContext | undefined;
      usersRepository.update.mockImplementation(() => {
        ctx = getRequestContext();
        return Promise.resolve({ affected: 1 });
      });
      const ctxObj = makeContext({ user: { id: UID } });

      const obs$ = (await interceptor.intercept(
        ctxObj,
        makeNext() as any,
      )) as any;
      await firstValueFrom(obs$);
      await new Promise((r) => setImmediate(r));

      expect(ctx).toEqual({ userId: UID });
    });

    it("caches the client timezone under a user context", async () => {
      preferencesRepository.findOne.mockResolvedValue({
        timezone: "browser",
        lastClientTimezone: null,
      });
      let ctx: RequestContext | undefined;
      preferencesRepository.update.mockImplementation(() => {
        ctx = getRequestContext();
        return Promise.resolve({ affected: 1 });
      });
      const ctxObj = makeContext({
        user: { id: UID },
        headers: { "x-client-timezone": "Europe/Berlin" },
      });

      const obs$ = (await interceptor.intercept(
        ctxObj,
        makeNext() as any,
      )) as any;
      await firstValueFrom(obs$);
      await new Promise((r) => setImmediate(r));

      expect(ctx).toEqual({ userId: UID });
    });
  });
});
