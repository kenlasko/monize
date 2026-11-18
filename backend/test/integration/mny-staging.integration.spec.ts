import { Test, TestingModule } from "@nestjs/testing";
import { ConflictException } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { TypeOrmModule } from "@nestjs/typeorm";
import { DataSource, QueryRunner } from "typeorm";

import { MnyStagingService } from "@/import/mny/mny-staging.service";
import { ImportStagedFile } from "@/import/mny/entities/import-staged-file.entity";
import { ImportJob } from "@/import/mny/entities/import-job.entity";
import { withUserContext } from "@/common/db/with-context";

import {
  INTEGRATION_TYPEORM_OPTIONS,
  cleanTables,
  createTestUserDirect,
} from "../helpers/integration-setup";

/**
 * The staging table against a real database, because the two properties that
 * matter cannot be mocked: BYTEA round-trips the exact bytes, and one user can
 * never reach another's staged file.
 *
 * Wired directly rather than through ImportModule: staging needs nothing but the
 * DataSource, and pulling in the whole import graph would drag along the
 * securities/net-worth chain for no coverage.
 */
describe("MnyStagingService (integration)", () => {
  let module: TestingModule;
  let dataSource: DataSource;
  let service: MnyStagingService;
  let userA: string;
  let userB: string;

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        TypeOrmModule.forRoot(INTEGRATION_TYPEORM_OPTIONS),
        TypeOrmModule.forFeature([ImportStagedFile, ImportJob]),
      ],
      providers: [MnyStagingService],
    }).compile();

    dataSource = module.get(DataSource);
    service = module.get(MnyStagingService);

    userA = (await createTestUserDirect(dataSource)).id;
    userB = (await createTestUserDirect(dataSource)).id;
  });

  afterAll(async () => {
    await module?.close();
  });

  beforeEach(async () => {
    await cleanTables(dataSource, ["import_jobs", "import_staged_files"]);
  });

  /** Every staging call runs inside a user context, as the controller's would. */
  const asUser = <T>(userId: string, fn: () => Promise<T>): Promise<T> =>
    withUserContext(userId, fn);

  it("round-trips the exact bytes, including a NUL-heavy binary payload", async () => {
    const data = Buffer.from([0x00, 0xff, 0x4d, 0x53, 0x00, 0x01, 0x7f, 0x80]);

    const info = await asUser(userA, () =>
      service.stage(userA, { filename: "money.mny", data }),
    );
    const loaded = await asUser(userA, () => service.loadBytes(userA, info.id));

    expect(loaded).toEqual(data);
    expect(info.sizeBytes).toBe(data.length);
  });

  it("stores a sha256 that matches the bytes", async () => {
    const data = Buffer.from("money file contents");

    const info = await asUser(userA, () =>
      service.stage(userA, { filename: "money.mny", data }),
    );

    // Same digest the service computed, recomputed from what came back out.
    const loaded = await asUser(userA, () => service.loadBytes(userA, info.id));
    const { createHash } = await import("node:crypto");
    expect(createHash("sha256").update(loaded!).digest("hex")).toBe(
      info.sha256,
    );
  });

  it("keeps the bytes out of a metadata lookup", async () => {
    const info = await asUser(userA, () =>
      service.stage(userA, { filename: "money.mny", data: Buffer.from("x") }),
    );

    const row = await dataSource
      .getRepository(ImportStagedFile)
      .findOne({ where: { id: info.id } });

    expect(row).not.toBeNull();
    expect(row!.data).toBeUndefined();
  });

  describe("cross-user isolation", () => {
    it("does not let another user read the metadata", async () => {
      const info = await asUser(userA, () =>
        service.stage(userA, { filename: "a.mny", data: Buffer.from("a") }),
      );

      expect(
        await asUser(userB, () => service.findInfo(userB, info.id)),
      ).toBeNull();
    });

    it("does not let another user read the bytes", async () => {
      const info = await asUser(userA, () =>
        service.stage(userA, { filename: "a.mny", data: Buffer.from("a") }),
      );

      expect(
        await asUser(userB, () => service.loadBytes(userB, info.id)),
      ).toBeNull();
    });

    it("does not let another user delete the file", async () => {
      const info = await asUser(userA, () =>
        service.stage(userA, { filename: "a.mny", data: Buffer.from("a") }),
      );

      expect(
        await asUser(userB, () => service.remove(userB, info.id, "mny")),
      ).toBe(false);
      expect(
        await asUser(userA, () => service.findInfo(userA, info.id)),
      ).not.toBeNull();
    });

    it("does not drop another user's file when that user stages one", async () => {
      const kept = await asUser(userA, () =>
        service.stage(userA, { filename: "a.mny", data: Buffer.from("a") }),
      );
      await asUser(userB, () =>
        service.stage(userB, { filename: "b.mny", data: Buffer.from("b") }),
      );

      expect(
        await asUser(userA, () => service.findInfo(userA, kept.id)),
      ).not.toBeNull();
    });
  });

  describe("re-staging", () => {
    it("replaces the user's previous file of the same format", async () => {
      const first = await asUser(userA, () =>
        service.stage(userA, { filename: "first.mny", data: Buffer.from("1") }),
      );
      const second = await asUser(userA, () =>
        service.stage(userA, {
          filename: "second.mny",
          data: Buffer.from("2"),
        }),
      );

      expect(
        await asUser(userA, () => service.findInfo(userA, first.id)),
      ).toBeNull();
      expect(
        await asUser(userA, () => service.findInfo(userA, second.id)),
      ).not.toBeNull();
    });

    it("keeps a file a pending job still needs", async () => {
      const staged = await asUser(userA, () =>
        service.stage(userA, { filename: "first.mny", data: Buffer.from("1") }),
      );
      await dataSource.getRepository(ImportJob).save(
        dataSource.getRepository(ImportJob).create({
          userId: userA,
          stagedFileId: staged.id,
          status: "pending",
          options: {} as never,
        }),
      );

      await asUser(userA, () =>
        service.stage(userA, {
          filename: "second.mny",
          data: Buffer.from("2"),
        }),
      );

      expect(
        await asUser(userA, () => service.findInfo(userA, staged.id)),
      ).not.toBeNull();
    });

    it("leaves a different source format alone", async () => {
      const other = await asUser(userA, () =>
        service.stage(userA, {
          filename: "other.bin",
          data: Buffer.from("1"),
          sourceFormat: "future",
        }),
      );
      await asUser(userA, () =>
        service.stage(userA, { filename: "money.mny", data: Buffer.from("2") }),
      );

      expect(
        await asUser(userA, () => service.findInfo(userA, other.id)),
      ).not.toBeNull();
    });
  });

  describe("TTL sweep", () => {
    it("deletes expired files across all users and leaves live ones", async () => {
      const live = await asUser(userA, () =>
        service.stage(userA, { filename: "live.mny", data: Buffer.from("l") }),
      );
      const staleA = await asUser(userA, () =>
        service.stage(userA, {
          filename: "stale.bin",
          data: Buffer.from("s"),
          sourceFormat: "future",
        }),
      );
      const staleB = await asUser(userB, () =>
        service.stage(userB, { filename: "stale.mny", data: Buffer.from("s") }),
      );

      await dataSource.query(
        "UPDATE import_staged_files SET expires_at = CURRENT_TIMESTAMP - INTERVAL '1 hour' WHERE id = ANY($1)",
        [[staleA.id, staleB.id]],
      );

      await service.sweepExpiredFiles();

      expect(
        await asUser(userA, () => service.findInfo(userA, staleA.id)),
      ).toBeNull();
      expect(
        await asUser(userB, () => service.findInfo(userB, staleB.id)),
      ).toBeNull();
      expect(
        await asUser(userA, () => service.findInfo(userA, live.id)),
      ).not.toBeNull();
    });

    it("is idempotent: a second sweep deletes nothing and does not throw", async () => {
      const stale = await asUser(userA, () =>
        service.stage(userA, { filename: "stale.mny", data: Buffer.from("s") }),
      );
      await dataSource.query(
        "UPDATE import_staged_files SET expires_at = CURRENT_TIMESTAMP - INTERVAL '1 hour' WHERE id = $1",
        [stale.id],
      );

      await service.sweepExpiredFiles();
      await expect(service.sweepExpiredFiles()).resolves.toBeUndefined();
    });

    it("nulls the job's reference rather than deleting import history", async () => {
      const staged = await asUser(userA, () =>
        service.stage(userA, { filename: "done.mny", data: Buffer.from("d") }),
      );
      const jobs = dataSource.getRepository(ImportJob);
      const job = await jobs.save(
        jobs.create({
          userId: userA,
          stagedFileId: staged.id,
          status: "completed",
          options: {} as never,
        }),
      );
      await dataSource.query(
        "UPDATE import_staged_files SET expires_at = CURRENT_TIMESTAMP - INTERVAL '1 hour' WHERE id = $1",
        [staged.id],
      );

      await service.sweepExpiredFiles();

      const reloaded = await jobs.findOne({ where: { id: job.id } });
      expect(reloaded).not.toBeNull();
      expect(reloaded!.stagedFileId).toBeNull();
    });
  });

  /**
   * A job INSERT still open on another connection (A26-L14, MON-L04 residual).
   *
   * The INSERT holds a key-share lock on the staged row until it commits. A
   * single `DELETE ... WHERE NOT EXISTS (job)` evaluated its sub-select on a
   * snapshot taken before that INSERT committed, waited on the lock, and then
   * deleted the row without looking again -- so the job ran and found its
   * bytes gone. Each case below holds the INSERT open, starts the deleter,
   * gives it time to block, commits, and asserts the bytes survived.
   */
  describe("a job whose INSERT has not committed yet", () => {
    let runner: QueryRunner | null = null;

    /** Opens a transaction inserting a pending job over `stagedFileId`. */
    async function holdJobInsert(
      userId: string,
      stagedFileId: string,
    ): Promise<QueryRunner> {
      const opened = dataSource.createQueryRunner();
      await opened.connect();
      await opened.startTransaction();
      await opened.query(
        `INSERT INTO import_jobs (user_id, staged_file_id, status, options)
         VALUES ($1, $2, 'pending', '{}'::jsonb)`,
        [userId, stagedFileId],
      );
      runner = opened;
      return opened;
    }

    /** Lets a deleter that is going to block on the row lock reach it. */
    const settle = () => new Promise((resolve) => setTimeout(resolve, 300));

    async function stagedFileOfJob(stagedFileId: string) {
      return dataSource.query(
        `SELECT staged_file_id FROM import_jobs WHERE staged_file_id = $1`,
        [stagedFileId],
      );
    }

    afterEach(async () => {
      if (runner?.isTransactionActive) {
        await runner.rollbackTransaction();
      }
      await runner?.release();
      runner = null;
    });

    it("keeps an expired file the sweep raced a job creation for", async () => {
      const staged = await asUser(userA, () =>
        service.stage(userA, { filename: "x.mny", data: Buffer.from("x") }),
      );
      await dataSource.query(
        "UPDATE import_staged_files SET expires_at = CURRENT_TIMESTAMP - INTERVAL '1 hour' WHERE id = $1",
        [staged.id],
      );
      const open = await holdJobInsert(userA, staged.id);

      const sweep = service.sweepExpiredFiles();
      await settle();
      await open.commitTransaction();
      await sweep;

      expect(
        await asUser(userA, () => service.findInfo(userA, staged.id)),
      ).not.toBeNull();
      expect(await stagedFileOfJob(staged.id)).toHaveLength(1);
    });

    it("keeps an expired file a pending job needs, once committed", async () => {
      const staged = await asUser(userA, () =>
        service.stage(userA, { filename: "x.mny", data: Buffer.from("x") }),
      );
      await dataSource.query(
        "UPDATE import_staged_files SET expires_at = CURRENT_TIMESTAMP - INTERVAL '1 hour' WHERE id = $1",
        [staged.id],
      );
      const open = await holdJobInsert(userA, staged.id);
      await open.commitTransaction();

      await service.sweepExpiredFiles();

      expect(
        await asUser(userA, () => service.findInfo(userA, staged.id)),
      ).not.toBeNull();
    });

    it("keeps a superseded file a job is being created for", async () => {
      const first = await asUser(userA, () =>
        service.stage(userA, { filename: "1.mny", data: Buffer.from("1") }),
      );
      const open = await holdJobInsert(userA, first.id);

      const restage = asUser(userA, () =>
        service.stage(userA, { filename: "2.mny", data: Buffer.from("2") }),
      );
      await settle();
      await open.commitTransaction();
      await restage;

      expect(
        await asUser(userA, () => service.findInfo(userA, first.id)),
      ).not.toBeNull();
      expect(await stagedFileOfJob(first.id)).toHaveLength(1);
    });

    it.each([
      ["mny", "kmy"],
      ["kmy", "mny"],
    ] as const)(
      "a %s route cannot discard a %s file, and leaves it staged",
      async (route, stored) => {
        const info = await asUser(userA, () =>
          service.stage(userA, {
            filename: `a.${stored}`,
            data: Buffer.from("a"),
            sourceFormat: stored,
          }),
        );

        expect(
          await asUser(userA, () => service.remove(userA, info.id, route)),
        ).toBe(false);
        expect(
          await asUser(userA, () => service.findInfo(userA, info.id)),
        ).not.toBeNull();
        expect(
          await asUser(userA, () => service.remove(userA, info.id, stored)),
        ).toBe(true);
      },
    );

    it("refuses a discard while a job is being created for the file", async () => {
      const staged = await asUser(userA, () =>
        service.stage(userA, { filename: "x.mny", data: Buffer.from("x") }),
      );
      const open = await holdJobInsert(userA, staged.id);

      const discard = asUser(userA, () =>
        service.remove(userA, staged.id, "mny"),
      );
      // Attach the handler now: the rejection may land before the commit.
      const outcome = discard.then(
        () => "removed",
        (error: unknown) => error,
      );
      await settle();
      await open.commitTransaction();

      expect(await outcome).toBeInstanceOf(ConflictException);
      expect(
        await asUser(userA, () => service.findInfo(userA, staged.id)),
      ).not.toBeNull();
    });

    it("refuses a discard of a file a pending job needs", async () => {
      const staged = await asUser(userA, () =>
        service.stage(userA, { filename: "x.mny", data: Buffer.from("x") }),
      );
      const open = await holdJobInsert(userA, staged.id);
      await open.commitTransaction();

      await expect(
        asUser(userA, () => service.remove(userA, staged.id, "mny")),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it("still discards a file whose job finished", async () => {
      const staged = await asUser(userA, () =>
        service.stage(userA, { filename: "x.mny", data: Buffer.from("x") }),
      );
      const open = await holdJobInsert(userA, staged.id);
      await open.query(
        `UPDATE import_jobs SET status = 'failed' WHERE staged_file_id = $1`,
        [staged.id],
      );
      await open.commitTransaction();

      expect(
        await asUser(userA, () => service.remove(userA, staged.id, "mny")),
      ).toBe(true);
    });
  });
});
