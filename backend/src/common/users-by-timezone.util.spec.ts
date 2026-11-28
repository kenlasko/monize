import { requestContextStorage } from "./request-context";
import { Logger } from "@nestjs/common";
import { DataSource } from "typeorm";
import {
  getUsersByEffectiveTimezone,
  resolveStoredTimezone,
  userTodayYMD,
} from "./users-by-timezone.util";
import { createScopedDbMocks } from "../test-helpers/scoped-db-testing";

jest.mock("./db/scoped-db", () =>
  jest.requireActual("../test-helpers/scoped-db-testing").scopedDbMockModule(),
);

function makeDataSource(
  rows: Array<{
    user_id: string;
    timezone: string | null;
    last_client_timezone: string | null;
  }>,
): DataSource {
  const { manager, dataSource } = createScopedDbMocks([]);
  manager.query.mockResolvedValue(rows);
  return dataSource as unknown as DataSource;
}

describe("getUsersByEffectiveTimezone", () => {
  it("returns an empty map when no users exist", async () => {
    const ds = makeDataSource([]);
    const result = await getUsersByEffectiveTimezone(ds);
    expect(result.size).toBe(0);
  });

  it("uses explicit timezone when set to a real IANA name", async () => {
    const ds = makeDataSource([
      {
        user_id: "u1",
        timezone: "America/New_York",
        last_client_timezone: "Europe/London",
      },
    ]);
    const result = await getUsersByEffectiveTimezone(ds);
    expect(result.get("America/New_York")).toEqual(["u1"]);
  });

  it("falls back to last_client_timezone when explicit is browser", async () => {
    const ds = makeDataSource([
      {
        user_id: "u1",
        timezone: "browser",
        last_client_timezone: "Europe/London",
      },
    ]);
    const result = await getUsersByEffectiveTimezone(ds);
    expect(result.get("Europe/London")).toEqual(["u1"]);
  });

  it("falls back to UTC when both are missing or browser", async () => {
    const ds = makeDataSource([
      { user_id: "u1", timezone: null, last_client_timezone: null },
      { user_id: "u2", timezone: "browser", last_client_timezone: "browser" },
      { user_id: "u3", timezone: "  ", last_client_timezone: "" },
    ]);
    const result = await getUsersByEffectiveTimezone(ds);
    expect(result.get("UTC")?.sort()).toEqual(["u1", "u2", "u3"]);
  });

  it("buckets multiple users sharing a timezone", async () => {
    const ds = makeDataSource([
      {
        user_id: "u1",
        timezone: "America/New_York",
        last_client_timezone: null,
      },
      {
        user_id: "u2",
        timezone: "America/New_York",
        last_client_timezone: null,
      },
      {
        user_id: "u3",
        timezone: "Europe/London",
        last_client_timezone: null,
      },
    ]);
    const result = await getUsersByEffectiveTimezone(ds);
    expect(result.get("America/New_York")?.sort()).toEqual(["u1", "u2"]);
    expect(result.get("Europe/London")).toEqual(["u3"]);
  });

  it("trims whitespace from timezone strings", async () => {
    const ds = makeDataSource([
      {
        user_id: "u1",
        timezone: "  America/New_York  ",
        last_client_timezone: null,
      },
    ]);
    const result = await getUsersByEffectiveTimezone(ds);
    expect(result.get("America/New_York")).toEqual(["u1"]);
  });
});

describe("resolveStoredTimezone", () => {
  it("skips an invalid stored zone and uses a valid cached one", () => {
    expect(resolveStoredTimezone("Not/AZone", "Asia/Tokyo")).toBe("Asia/Tokyo");
  });

  it("is undefined when neither value is a real zone", () => {
    expect(resolveStoredTimezone("Not/AZone", "browser")).toBeUndefined();
    expect(resolveStoredTimezone(null, " ")).toBeUndefined();
  });

  it("buckets a user with only invalid zones under UTC", async () => {
    const ds = makeDataSource([
      { user_id: "u1", timezone: "Not/AZone", last_client_timezone: null },
    ]);
    expect((await getUsersByEffectiveTimezone(ds)).get("UTC")).toEqual(["u1"]);
  });
});

describe("userTodayYMD", () => {
  // 12:00 UTC on 2026-11-27 is already 02:00 on 2026-11-28 in Kiritimati.
  const now = new Date("2026-11-27T12:00:00Z");
  const managerAnswering = (rows: unknown[]) =>
    ({ query: jest.fn().mockResolvedValue(rows) }) as never;

  it("is the user's day in their own timezone, not the server's", async () => {
    const m = managerAnswering([
      { timezone: "Pacific/Kiritimati", last_client_timezone: null },
    ]);
    expect(await userTodayYMD(m, "u1", now)).toBe("2026-11-28");
  });

  it("falls back to the last client timezone, then to UTC", async () => {
    expect(
      await userTodayYMD(
        managerAnswering([
          { timezone: "browser", last_client_timezone: "Pacific/Kiritimati" },
        ]),
        "u1",
        now,
      ),
    ).toBe("2026-11-28");
    expect(await userTodayYMD(managerAnswering([]), "u1", now)).toBe(
      "2026-11-27",
    );
  });

  it("notes, naming only the user id, when no preference row is visible", async () => {
    const debug = jest
      .spyOn(Logger.prototype, "debug")
      .mockImplementation(() => undefined);
    try {
      await userTodayYMD(managerAnswering([]), "u-hidden", now);
      expect(debug).toHaveBeenCalledWith(expect.stringContaining("u-hidden"));
    } finally {
      debug.mockRestore();
    }
  });

  describe("inside a request that seeded a timezone", () => {
    const stored = [{ timezone: "UTC", last_client_timezone: null }];

    beforeEach(() => {
      jest.useFakeTimers({ now });
    });
    afterEach(() => {
      jest.useRealTimers();
    });

    it("is the request's day for the ambient user, as todayYMD() reads it", async () => {
      const day = await requestContextStorage.run(
        { userId: "u1", timezone: "Pacific/Kiritimati" },
        () => userTodayYMD(managerAnswering(stored), "u1"),
      );
      expect(day).toBe("2026-11-28");
    });

    it("keeps the stored resolution for a delegate's request, whose timezone is the delegate's", async () => {
      // Acting as owner u1: the context's userId is the owner, realUserId the
      // delegate, and the request timezone is the delegate's header.
      const day = await requestContextStorage.run(
        {
          userId: "u1",
          realUserId: "delegate",
          timezone: "Pacific/Kiritimati",
        },
        () => userTodayYMD(managerAnswering(stored), "u1"),
      );
      expect(day).toBe("2026-11-27");
    });

    it("falls through to the stored resolution when the request timezone is invalid", async () => {
      const day = await requestContextStorage.run(
        { userId: "u1", timezone: "Not/AZone" },
        () =>
          userTodayYMD(
            managerAnswering([
              { timezone: "Pacific/Kiritimati", last_client_timezone: null },
            ]),
            "u1",
          ),
      );
      expect(day).toBe("2026-11-28");
    });

    it("honours the `now` it is given", async () => {
      const day = await requestContextStorage.run(
        { userId: "u1", timezone: "Pacific/Kiritimati" },
        () =>
          userTodayYMD(
            managerAnswering(stored),
            "u1",
            new Date("2030-01-01T12:00:00Z"),
          ),
      );
      expect(day).toBe("2030-01-02");
    });

    it("keeps the stored resolution for any other user", async () => {
      const day = await requestContextStorage.run(
        { userId: "u1", timezone: "Pacific/Kiritimati" },
        () => userTodayYMD(managerAnswering(stored), "u2"),
      );
      expect(day).toBe("2026-11-27");
    });
  });
});
