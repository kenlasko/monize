import { DataSource, EntityManager } from "typeorm";
import {
  TourProgressMap,
  UserPreference,
} from "../users/entities/user-preference.entity";
import { ReleaseNotesService } from "./release-notes.service";
import { ToursService } from "./tours.service";
import { withScopedDb } from "../common/db/scoped-db";
import {
  createUserPreferenceRepoMock,
  type UserPreferenceRepoMock,
} from "../test-helpers/user-preference-testing";

jest.mock("../common/db/scoped-db");
const mockedTenantTx = withScopedDb as jest.MockedFunction<typeof withScopedDb>;

const CURRENT_VERSION = "1.13.0";

describe("ToursService", () => {
  let prefsMock: UserPreferenceRepoMock;
  let query: jest.Mock;
  let manager: EntityManager;
  let service: ToursService;

  beforeEach(() => {
    prefsMock = createUserPreferenceRepoMock(null);

    // The merge is raw SQL, so the double applies it the way Postgres would --
    // against whatever row the insert-if-absent left behind. A `query` mock that
    // just returns a value could not show that the merge landed on a row this
    // call had to create first.
    query = jest.fn(async (sql: string, params: unknown[]) => {
      if (/tour_progress\s*=\s*'\{\}'::jsonb/.test(sql)) {
        const row = prefsMock.row();
        if (row) row.tourProgress = {};
        return [[], row ? 1 : 0];
      }
      if (/tour_progress\s*=\s*COALESCE/.test(sql)) {
        const row = prefsMock.row();
        if (!row) return [[], 0];
        row.tourProgress = {
          ...(row.tourProgress ?? {}),
          ...(JSON.parse(params[0] as string) as TourProgressMap),
        };
        return [[], 1];
      }
      return [[], 0];
    });

    manager = {
      getRepository: jest.fn(() => prefsMock.repo),
      query,
    } as unknown as EntityManager;

    mockedTenantTx.mockImplementation((_dataSource, fn) => fn(manager));

    const releaseNotes = {
      currentVersion: CURRENT_VERSION,
    } as unknown as ReleaseNotesService;

    service = new ToursService({} as DataSource, releaseNotes);
  });

  afterEach(() => jest.clearAllMocks());

  function seed(tourProgress: TourProgressMap = {}): void {
    prefsMock.seed({ userId: "user-1", tourProgress } as UserPreference);
  }

  describe("getProgress", () => {
    it("returns the stored map", async () => {
      const map = { "intro/basics": { status: "completed", updatedAt: "x" } };
      seed(map as TourProgressMap);

      expect(await service.getProgress("user-1")).toEqual(map);
    });

    it("returns an empty map when no row exists", async () => {
      prefsMock.seed(null);

      expect(await service.getProgress("user-1")).toEqual({});
    });
  });

  describe("saveProgress", () => {
    it("atomically merges a single entry without a version for evergreen tours", async () => {
      seed();

      const result = await service.saveProgress(
        "user-1",
        "intro/basics",
        "completed",
      );

      expect(result).toEqual({ saved: true });
      const merge = query.mock.calls.find(([sql]) =>
        String(sql).includes("tour_progress = COALESCE"),
      )!;
      expect(merge[0]).toContain("|| $1::jsonb");
      const patch = JSON.parse(merge[1][0]);
      expect(patch["intro/basics"]).toMatchObject({ status: "completed" });
      expect(patch["intro/basics"].version).toBeUndefined();
      expect(merge[1][1]).toBe("user-1");
      expect(prefsMock.row()!.tourProgress["intro/basics"]).toMatchObject({
        status: "completed",
      });
    });

    it("stamps the running version on release-* tours", async () => {
      seed();

      await service.saveProgress(
        "user-1",
        "release-1.13.0/accounts",
        "dismissed",
      );

      expect(
        prefsMock.row()!.tourProgress["release-1.13.0/accounts"],
      ).toMatchObject({ status: "dismissed", version: CURRENT_VERSION });
    });

    it("keeps entries another tab already recorded", async () => {
      // The merge is `||` in SQL rather than a read-modify-write precisely so two
      // tabs finishing different tours at the same time do not overwrite each
      // other.
      seed({ "already/done": { status: "completed", updatedAt: "x" } });

      await service.saveProgress("user-1", "intro/basics", "completed");

      expect(Object.keys(prefsMock.row()!.tourProgress).sort()).toEqual([
        "already/done",
        "intro/basics",
      ]);
    });

    it("materializes a preferences row and still records the tour", async () => {
      // The regression, and the reason it survived: the service used to read an
      // `UPDATE ... RETURNING` result with `updated.length === 0` to decide
      // whether to create a missing row. TypeORM answers an UPDATE with the tuple
      // `[rows, rowCount]`, so that length is 2 whatever happened and the branch
      // could not run -- the row stayed missing, the progress went nowhere, and
      // the endpoint answered `{ saved: true }`. The old spec passed only because
      // its mock returned a bare `[]`, a shape the driver never produces for an
      // UPDATE.
      prefsMock.seed(null);

      const result = await service.saveProgress(
        "user-1",
        "intro/basics",
        "completed",
      );

      expect(result).toEqual({ saved: true });
      expect(prefsMock.insertAttempts()).toHaveLength(1);
      expect(prefsMock.row()!.tourProgress["intro/basics"]).toMatchObject({
        status: "completed",
      });
    });

    it("does not depend on the driver's result shape at all", async () => {
      // Whatever the UPDATE reports, the row exists by then, so there is no
      // "did it match" question left to answer wrongly.
      prefsMock.seed(null);
      for (const shape of [[[], 0], [[], 1], [], undefined]) {
        const merge = query.getMockImplementation()!;
        query.mockImplementation(async (sql: string, params: unknown[]) => {
          await merge(sql, params);
          return shape;
        });

        await expect(
          service.saveProgress("user-1", "intro/basics", "completed"),
        ).resolves.toEqual({ saved: true });
        expect(prefsMock.row()!.tourProgress["intro/basics"]).toBeDefined();
      }
    });

    it("prunes the oldest entries when the map exceeds the cap", async () => {
      const bloated: TourProgressMap = {};
      for (let i = 0; i < 205; i++) {
        bloated[`tour-${i}`] = {
          status: "completed",
          updatedAt: new Date(2020, 0, 1, 0, i).toISOString(),
        };
      }
      seed(bloated);

      await service.saveProgress("user-1", "tour-999", "completed");

      const written = prefsMock.patches();
      const pruned = written[written.length - 1]
        .tourProgress as TourProgressMap;
      expect(Object.keys(pruned)).toHaveLength(200);
      // Oldest (tour-0) pruned, newest kept.
      expect(pruned["tour-0"]).toBeUndefined();
      expect(pruned["tour-204"]).toBeDefined();
    });

    it("prunes by writing only tour_progress", async () => {
      // The prune is the one read-modify-write left here, so it must not carry
      // any other column back with it.
      const bloated: TourProgressMap = {};
      for (let i = 0; i < 205; i++) {
        bloated[`tour-${i}`] = { status: "completed", updatedAt: `${i}` };
      }
      seed(bloated);

      await service.saveProgress("user-1", "tour-999", "completed");

      const written = prefsMock.patches();
      expect(Object.keys(written[written.length - 1])).toEqual([
        "tourProgress",
      ]);
    });

    it("does not prune when under the cap", async () => {
      seed({ a: { status: "completed", updatedAt: "x" } });

      await service.saveProgress("user-1", "intro/basics", "completed");

      expect(prefsMock.patches()).toHaveLength(0);
    });
  });

  describe("resetProgress", () => {
    it("clears the map via SQL", async () => {
      const result = await service.resetProgress("user-1");

      expect(result).toEqual({ reset: true });
      const [sql, params] = query.mock.calls[0];
      expect(sql).toContain("tour_progress = '{}'::jsonb");
      expect(params[0]).toBe("user-1");
    });
  });
});
