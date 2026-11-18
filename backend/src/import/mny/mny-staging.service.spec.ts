import { createHash } from "node:crypto";
import { ConflictException } from "@nestjs/common";
import { DataSource, EntityManager } from "typeorm";
import { withScopedDb } from "../../common/db/scoped-db";
import { ImportStagedFile } from "./entities/import-staged-file.entity";
import {
  MnyStagingService,
  STAGED_FILE_TTL_HOURS,
} from "./mny-staging.service";

jest.mock("../../common/db/scoped-db");
const mockedScopedDb = withScopedDb as jest.MockedFunction<typeof withScopedDb>;

jest.mock("../../common/db/with-context", () => ({
  withSystemContext: <T>(fn: () => T): T => fn(),
}));

/**
 * A chainable query-builder double. Every method returns the builder so the
 * service's fluent chains work, and the terminal calls are asserted directly.
 */
function queryBuilder(overrides: Record<string, unknown> = {}) {
  const builder: Record<string, unknown> = {
    addSelect: jest.fn(() => builder),
    where: jest.fn(() => builder),
    andWhere: jest.fn(() => builder),
    delete: jest.fn(() => builder),
    getOne: jest.fn().mockResolvedValue(null),
    execute: jest.fn().mockResolvedValue({ affected: 0 }),
    ...overrides,
  };
  return builder;
}

describe("MnyStagingService", () => {
  let repo: Record<string, jest.Mock>;
  let builder: Record<string, unknown>;
  let query: jest.Mock;
  let service: MnyStagingService;

  /** The SQL text of every raw statement, in order. */
  const statements = (): string[] =>
    query.mock.calls.map((call) => String(call[0]).replace(/\s+/g, " "));

  beforeEach(() => {
    builder = queryBuilder();
    repo = {
      create: jest.fn((entity) => entity),
      save: jest.fn((entity) => Promise.resolve({ id: "staged-1", ...entity })),
      findOne: jest.fn().mockResolvedValue(null),
      delete: jest.fn().mockResolvedValue({ affected: 1 }),
      createQueryBuilder: jest.fn(() => builder),
    };

    query = jest.fn().mockResolvedValue([]);
    const manager = {
      getRepository: jest.fn(() => repo),
      query,
    } as unknown as EntityManager;

    mockedScopedDb.mockImplementation((_dataSource, fn) => fn(manager));

    service = new MnyStagingService({} as DataSource);
  });

  afterEach(() => jest.clearAllMocks());

  describe("stage", () => {
    const data = Buffer.from("decrypted money bytes");

    it("stores the bytes with their digest and size", async () => {
      const info = await service.stage("user-1", {
        filename: "finances.mny",
        data,
      });

      expect(repo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: "user-1",
          filename: "finances.mny",
          sourceFormat: "mny",
          sizeBytes: data.length,
          sha256: createHash("sha256").update(data).digest("hex"),
          data,
        }),
      );
      expect(info.id).toBe("staged-1");
      expect(info.sizeBytes).toBe(data.length);
    });

    it("never returns the bytes in the metadata", async () => {
      const info = await service.stage("user-1", {
        filename: "finances.mny",
        data,
      });

      expect(Object.keys(info)).not.toContain("data");
    });

    it("expires the file a TTL from now", async () => {
      const before = Date.now();
      const info = await service.stage("user-1", {
        filename: "finances.mny",
        data,
      });
      const expected = before + STAGED_FILE_TTL_HOURS * 60 * 60 * 1000;

      expect(info.expiresAt.getTime()).toBeGreaterThanOrEqual(expected - 1000);
      expect(info.expiresAt.getTime()).toBeLessThanOrEqual(expected + 5000);
    });

    it("drops the user's superseded files, but not one a live job still needs", async () => {
      query.mockResolvedValueOnce([{ id: "old-1" }]);

      await service.stage("user-1", { filename: "finances.mny", data });

      // Lock first (A26-L14), skipping a row a job INSERT is holding...
      const [lock, remove] = statements();
      expect(lock).toContain("user_id = $1 AND source_format = $2");
      expect(lock).toContain("FOR UPDATE SKIP LOCKED");
      expect(query.mock.calls[0][1]).toEqual(["user-1", "mny"]);
      // ...then decide on a fresh snapshot, in a second statement.
      expect(remove).toContain("DELETE FROM import_staged_files");
      expect(remove).toContain("NOT EXISTS");
      expect(remove).toContain("'pending', 'running'");
      expect(query.mock.calls[1][1]).toEqual([["old-1"]]);
    });

    it("issues no delete when nothing could be locked", async () => {
      await service.stage("user-1", { filename: "finances.mny", data });

      expect(statements()).toHaveLength(1);
    });

    it("honours an explicit source format", async () => {
      await service.stage("user-1", {
        filename: "other.bin",
        data,
        sourceFormat: "future",
      });

      expect(repo.save).toHaveBeenCalledWith(
        expect.objectContaining({ sourceFormat: "future" }),
      );
    });
  });

  describe("findInfo", () => {
    it("scopes the lookup to the caller", async () => {
      await service.findInfo("user-1", "staged-1");

      // Soft TTL (MR-002): metadata reads carry no `expires_at` predicate, so a
      // started import is never refused because the clock crossed its TTL. TTL
      // enforcement lives in the active-job-aware sweep, asserted below.
      expect(repo.findOne).toHaveBeenCalledWith({
        where: { id: "staged-1", userId: "user-1" },
      });
    });

    it("returns null when the row is gone", async () => {
      expect(await service.findInfo("user-1", "staged-1")).toBeNull();
    });

    it("maps a bigint size back to a number", async () => {
      repo.findOne.mockResolvedValue({
        id: "staged-1",
        filename: "finances.mny",
        sourceFormat: "mny",
        sizeBytes: "1048576" as unknown as number,
        sha256: "abc",
        expiresAt: new Date("2026-07-30T00:00:00Z"),
      } as ImportStagedFile);

      const info = await service.findInfo("user-1", "staged-1");

      expect(info?.sizeBytes).toBe(1048576);
    });
  });

  describe("loadBytes", () => {
    it("explicitly selects the bytea column", async () => {
      const data = Buffer.from("bytes");
      builder = queryBuilder({
        getOne: jest.fn().mockResolvedValue({ data }),
      });
      repo.createQueryBuilder.mockReturnValue(builder);

      expect(await service.loadBytes("user-1", "staged-1")).toBe(data);
      expect(builder.addSelect).toHaveBeenCalledWith("file.data");
    });

    it("returns null when the row is gone", async () => {
      expect(await service.loadBytes("user-1", "staged-1")).toBeNull();
    });
  });

  describe("remove", () => {
    it("reports false when the caller has no such file", async () => {
      expect(await service.remove("user-1", "staged-1")).toBe(false);

      const [lock] = statements();
      expect(lock).toContain("WHERE id = $1 AND user_id = $2");
      expect(lock).toContain("FOR UPDATE");
      expect(query.mock.calls[0][1]).toEqual(["staged-1", "user-1"]);
      expect(statements()).toHaveLength(1);
    });

    it("refuses while a pending or running job needs the bytes, and deletes nothing", async () => {
      query
        .mockResolvedValueOnce([{ id: "staged-1" }])
        .mockResolvedValueOnce([{ needed: true }]);

      await expect(service.remove("user-1", "staged-1")).rejects.toThrow(
        ConflictException,
      );
      expect(statements()[1]).toContain("'pending', 'running'");
      expect(statements().some((sql) => sql.startsWith("DELETE"))).toBe(false);
    });

    it("refuses with the KMyMoney message while a KMyMoney import needs the bytes", async () => {
      query
        .mockResolvedValueOnce([{ id: "staged-1", source_format: "kmy" }])
        .mockResolvedValueOnce([{ needed: true }]);

      await expect(service.remove("user-1", "staged-1")).rejects.toThrow(
        /KMyMoney file is being imported/,
      );
    });

    it("keeps the Money message for a Money staged file", async () => {
      query
        .mockResolvedValueOnce([{ id: "staged-1", source_format: "mny" }])
        .mockResolvedValueOnce([{ needed: true }]);

      await expect(service.remove("user-1", "staged-1")).rejects.toThrow(
        /Money file is being imported/,
      );
    });

    it("deletes the caller's file once no job needs it", async () => {
      query
        .mockResolvedValueOnce([{ id: "staged-1" }])
        .mockResolvedValueOnce([{ needed: false }]);

      expect(await service.remove("user-1", "staged-1")).toBe(true);
      expect(statements()[2]).toContain(
        "DELETE FROM import_staged_files WHERE id = $1 AND user_id = $2",
      );
      expect(query.mock.calls[2][1]).toEqual(["staged-1", "user-1"]);
    });
  });

  describe("removeConsumed", () => {
    it("deletes the caller's file unconditionally", async () => {
      await service.removeConsumed("user-1", "staged-1");

      expect(repo.delete).toHaveBeenCalledWith({
        id: "staged-1",
        userId: "user-1",
      });
    });
  });

  describe("sweepExpiredFiles", () => {
    it("locks only rows already past their expiry", async () => {
      await service.sweepExpiredFiles();

      const [lock] = statements();
      expect(lock).toContain("expires_at < CURRENT_TIMESTAMP");
      expect(lock).toContain("FOR UPDATE SKIP LOCKED");
    });

    it("excludes staged files an active job still needs, after the lock", async () => {
      query
        .mockResolvedValueOnce([{ id: "a" }, { id: "b" }])
        .mockResolvedValueOnce([{ id: "a" }]);

      await service.sweepExpiredFiles();

      // With soft-TTL reads (MR-002), the sweep is the only TTL gate -- so it
      // must not delete the bytes out from under a pending or running import.
      // The FK is ON DELETE SET NULL, so without this the job survives and
      // fails partway through with a missing-file error (audit P4-016). The
      // exclusion is its own statement, after the lock (A26-L14).
      const [, remove] = statements();
      expect(remove).toContain("NOT EXISTS");
      expect(remove).toContain("'pending', 'running'");
      expect(query.mock.calls[1][1]).toEqual([["a", "b"]]);
    });

    it("never throws, so one bad sweep cannot kill the scheduler", async () => {
      query.mockRejectedValue(new Error("connection reset"));

      await expect(service.sweepExpiredFiles()).resolves.toBeUndefined();
    });
  });
});
