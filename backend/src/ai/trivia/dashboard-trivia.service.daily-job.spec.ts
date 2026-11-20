import {
  manager,
  useServiceHarness,
  userId,
} from "./dashboard-trivia.service.harness";
import { DashboardTriviaService } from "./dashboard-trivia.service";
import { withUserContext } from "../../common/db/with-context";
import {
  getEffectiveTimezoneOfUser,
  getUsersByEffectiveTimezone,
} from "../../common/users-by-timezone.util";

describe("DashboardTriviaService", () => {
  const h = useServiceHarness();
  let selectQb: Record<string, jest.Mock>;
  let ledger: Record<string, jest.Mock>;
  let daily: Record<string, jest.Mock>;
  let service: DashboardTriviaService;

  beforeEach(() => {
    ({ selectQb, ledger, daily, service } = h);
  });

  describe("handleDailyGeneration", () => {
    const at = (iso: string) =>
      jest.useFakeTimers().setSystemTime(new Date(iso));
    beforeEach(() => {
      manager.createQueryBuilder = jest.fn(() => selectQb);
      jest.spyOn(service, "generateForUser").mockResolvedValue(undefined);
      (getEffectiveTimezoneOfUser as jest.Mock).mockClear();
    });
    afterEach(() => jest.useRealTimers());

    it("builds only for readers in the first hours of their local day", async () => {
      // 08:17Z: 00:17 in Los Angeles, 03:17 in Panama, 08:17 in UTC, 17:17 in Tokyo.
      at("2026-11-19T08:17:00Z");
      (getUsersByEffectiveTimezone as jest.Mock).mockResolvedValue(
        new Map([
          ["America/Los_Angeles", [userId]],
          ["America/Panama", ["user-2"]],
          ["UTC", ["user-3"]],
          ["Asia/Tokyo", ["user-4"]],
        ]),
      );
      selectQb.getRawMany.mockResolvedValue(
        ["user-1", "user-2", "user-3", "user-4"].map((id) => ({ userId: id })),
      );
      await service.handleDailyGeneration();
      expect((service.generateForUser as jest.Mock).mock.calls.sort()).toEqual([
        ["user-1", "America/Los_Angeles"],
        ["user-2", "America/Panama"],
      ]);
    });

    it("reaches a UTC+13 reader at their local midnight, not mid-afternoon", async () => {
      (getUsersByEffectiveTimezone as jest.Mock).mockResolvedValue(
        new Map([["Pacific/Auckland", [userId]]]),
      );
      // 06:17Z is 19:17 in Auckland: the old 06:30 UTC run built it here.
      at("2026-11-19T06:17:00Z");
      await service.handleDailyGeneration();
      expect(service.generateForUser).not.toHaveBeenCalled();
      // 11:17Z is 00:17 on the 20th there.
      at("2026-11-19T11:17:00Z");
      await service.handleDailyGeneration();
      expect(service.generateForUser).toHaveBeenCalledWith(
        userId,
        "Pacific/Auckland",
      );
    });

    it("does not build for US Pacific while it is still the previous local day", async () => {
      (getUsersByEffectiveTimezone as jest.Mock).mockResolvedValue(
        new Map([["America/Los_Angeles", [userId]]]),
      );
      at("2026-11-19T06:17:00Z"); // 22:17 on the 18th in Los Angeles
      await service.handleDailyGeneration();
      expect(service.generateForUser).not.toHaveBeenCalled();
    });

    it("leaves out inactive users, and reads none when no zone is in its window", async () => {
      (getUsersByEffectiveTimezone as jest.Mock).mockResolvedValue(
        new Map([["UTC", [userId, "user-2"]]]),
      );
      at("2026-11-19T12:17:00Z");
      await service.handleDailyGeneration();
      expect(selectQb.getRawMany).not.toHaveBeenCalled();
      at("2026-11-19T01:17:00Z");
      selectQb.getRawMany.mockResolvedValue([{ userId: "user-2" }]);
      await service.handleDailyGeneration();
      expect(selectQb.where).toHaveBeenCalledWith("u.is_active = true");
      expect(service.generateForUser).toHaveBeenCalledTimes(1);
      expect(service.generateForUser).toHaveBeenCalledWith("user-2", "UTC");
    });

    it("counts a zone it cannot resolve in UTC", async () => {
      (getUsersByEffectiveTimezone as jest.Mock).mockResolvedValue(
        new Map([["Not/AZone", [userId]]]),
      );
      selectQb.getRawMany.mockResolvedValue([{ userId }]);
      at("2026-11-19T02:17:00Z");
      await service.handleDailyGeneration();
      expect(service.generateForUser).toHaveBeenCalledTimes(1);
    });

    it("isolates one user's failure and runs each body under the bucket's zone", async () => {
      at("2026-11-19T01:17:00Z");
      (getUsersByEffectiveTimezone as jest.Mock).mockResolvedValue(
        new Map([["UTC", [userId, "user-2"]]]),
      );
      selectQb.getRawMany.mockResolvedValue([{ userId }, { userId: "user-2" }]);
      (service.generateForUser as jest.Mock)
        .mockRejectedValueOnce(new Error("first fails"))
        .mockResolvedValue(undefined);
      await expect(service.handleDailyGeneration()).resolves.toBeUndefined();
      expect(service.generateForUser).toHaveBeenCalledTimes(2);
      const bodyCalls = (withUserContext as jest.Mock).mock.calls;
      expect(bodyCalls).toHaveLength(2);
      expect(bodyCalls.every((call) => call[2] === "UTC")).toBe(true);
      // The zone comes from the bucket: no second lookup per user.
      expect(getEffectiveTimezoneOfUser).not.toHaveBeenCalled();
    });

    it("builds the pool for the reader's day, with bills, on the cron path", async () => {
      jest.restoreAllMocks();
      at("2026-11-19T11:17:00Z");
      await service.generateForUser(userId, "Pacific/Auckland");
      // 11:17 UTC on the 19th is the 20th in Auckland (UTC+13).
      expect(ledger.load).toHaveBeenCalledWith(
        userId,
        "CAD",
        "2026-11-20",
        expect.any(Object),
      );
      expect(daily.load).toHaveBeenCalledWith(
        userId,
        "CAD",
        "2026-11-20",
        expect.objectContaining({ bills: true }),
      );
    });
  });
});
