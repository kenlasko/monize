import { Test, TestingModule } from "@nestjs/testing";
import { DataSource } from "typeorm";
import { ConfigService } from "@nestjs/config";
import { BadRequestException, ConflictException } from "@nestjs/common";
import {
  promises as fs,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  AutoBackupService,
  DEFAULT_BACKUP_CONTAINER_DIR,
  MONTHLY_DAY,
  WEEKLY_DAYS,
} from "./auto-backup.service";
import { BackupService } from "./backup.service";
import { BackupEncryptionService } from "./backup-encryption.service";
import { AutoBackupSettings } from "./entities/auto-backup-settings.entity";
import { User } from "../users/entities/user.entity";
import { DemoModeService } from "../common/demo-mode.service";
import { createScopedDbMocks } from "../test-helpers/scoped-db-testing";
import {
  createUserMaintenanceMock,
  userMaintenanceProvider,
  type UserMaintenanceMock,
} from "../test-helpers/job-claim-testing";

jest.mock("../common/db/scoped-db", () =>
  jest.requireActual("../test-helpers/scoped-db-testing").scopedDbMockModule(),
);

jest.mock("stream/promises", () => ({
  pipeline: jest.fn().mockResolvedValue(undefined),
}));

/**
 * These specs run against a real temporary directory rather than a mocked `fs`.
 *
 * The behaviour under test is filesystem behaviour: whether a final filename can
 * ever name a partial file, whether a symlink inside a permitted directory can
 * redirect a write out of it, whether two users on one root can reach each
 * other's artifacts. A mocked `rename` demonstrates none of that -- it records
 * that the code called rename, which was never the question. The mocked version
 * of this suite passed throughout the period when the daily write truncated its
 * own final filename and every user shared one namespace.
 *
 * The clock, unlike the filesystem, is pinned. `copyToWeeklyIfNeeded` and
 * `copyToMonthlyIfNeeded` read `new Date()`, so on the 1st, 7th, 14th, 21st and
 * 28th a single backup leaves *two* files in the folder -- and every assertion
 * here that counts artifacts or compares the folder listing exactly was
 * therefore green on 24 days a month and red on the other five. That is not a
 * flake to retry: it is the suite reporting the date rather than the code. Ten
 * tests failed this way on 2026-08-07 with no change to the module behind them.
 *
 * So `beforeEach` fixes the system time to an ordinary day, and the tests that
 * are *about* promotion set their own date, as they always did. Faking the
 * clock does not weaken the filesystem claims above: the directory, the writes
 * and the renames stay real.
 */

/**
 * An ordinary day: late enough to be newer than every seeded fixture, and in
 * neither promotion list. Guarded by a test below rather than by this comment.
 */
const SUITE_CLOCK = new Date("2026-04-15T10:00:00Z");

describe("AutoBackupService", () => {
  let service: AutoBackupService;
  let mockSettingsRepo: Record<string, jest.Mock>;
  let mockUsersRepo: Record<string, jest.Mock>;
  let mockBackupService: Record<string, jest.Mock>;
  let mockBackupEncryption: Record<string, jest.Mock>;
  let updateBuilder: Record<string, jest.Mock>;
  let scoped: ReturnType<typeof createScopedDbMocks>;
  let maintenance: UserMaintenanceMock;

  /** A real directory, standing in for the operator's mounted backup volume. */
  let root: string;

  const userId = "55555555-5555-5555-5555-555555555555";
  const otherUserId = "66666666-6666-6666-6666-666666666666";

  /**
   * Where this user's artifacts land: a server-computed, sharded subdirectory
   * of `root` -- `<root>/<ab>/<cd>/<id>`, the same fan-out attachment bytes use.
   */
  const folderFor = (id: string = userId) =>
    join(root, id.slice(0, 2), id.slice(2, 4), id);

  async function listBackups(directory: string): Promise<string[]> {
    try {
      return (await fs.readdir(directory)).sort();
    } catch {
      return [];
    }
  }

  /**
   * Runs `fn` with the clock moved to `date`, then puts it back.
   *
   * The one way to change the date in this file. Fake timers are installed once
   * in `beforeEach` with a deliberately narrow `doNotFake` list, so a test that
   * reinstalls them with a bare `useFakeTimers()` silently takes the default
   * instead -- which fakes `nextTick` and `queueMicrotask` underneath the real
   * `fs.promises` calls these specs depend on. Move the date; do not reinstall
   * the timers.
   */
  async function withClockAt(
    date: string,
    fn: () => Promise<void>,
  ): Promise<void> {
    jest.setSystemTime(new Date(date));
    try {
      await fn();
    } finally {
      jest.setSystemTime(SUITE_CLOCK);
    }
  }
  let isDemo: boolean;

  function createSettings(
    overrides: Partial<AutoBackupSettings> = {},
  ): AutoBackupSettings {
    const s = new AutoBackupSettings();
    s.userId = userId;
    s.enabled = false;
    s.folderPath = "";
    s.frequency = "daily";
    s.backupTime = "02:00";
    s.timezone = "UTC";
    s.retentionDaily = 7;
    s.retentionWeekly = 4;
    s.retentionMonthly = 6;
    s.lastBackupAt = null;
    s.lastBackupStatus = null;
    s.lastBackupError = null;
    s.nextBackupAt = null;
    Object.assign(s, overrides);
    return s;
  }

  async function createService(
    env: Record<string, string> = {},
  ): Promise<AutoBackupService> {
    scoped = createScopedDbMocks([
      [AutoBackupSettings, mockSettingsRepo as never],
      [User, mockUsersRepo as never],
    ]);
    // The cron claims each due window with a guarded
    // `UPDATE ... RETURNING`, which the pg driver answers as
    // `[rows, rowCount]`. Winning by default preserves the behaviour every test
    // written before the claim existed expects; the loser path is asserted
    // explicitly below.
    scoped.manager.query.mockResolvedValue([[{ id: "settings-1" }], 1]);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        {
          provide: DataSource,
          useValue: scoped.dataSource,
        },
        AutoBackupService,
        {
          provide: BackupService,
          useValue: mockBackupService,
        },
        userMaintenanceProvider(maintenance),
        {
          provide: BackupEncryptionService,
          useValue: mockBackupEncryption,
        },
        {
          provide: DemoModeService,
          useValue: {
            get isDemo() {
              return isDemo;
            },
          },
        },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string) =>
              key in env ? env[key] : defaultEnv[key],
            ),
          },
        },
      ],
    }).compile();

    return module.get<AutoBackupService>(AutoBackupService);
  }

  /** Env every service gets unless a test overrides it. */
  let defaultEnv: Record<string, string>;

  beforeEach(async () => {
    // Only `Date` is faked. The timer APIs stay real because the writes below
    // are real filesystem I/O, and a suite that fakes the event loop under
    // `fs.promises` deadlocks rather than failing.
    jest.useFakeTimers({
      doNotFake: [
        "setTimeout",
        "clearTimeout",
        "setInterval",
        "clearInterval",
        "setImmediate",
        "clearImmediate",
        "nextTick",
        "queueMicrotask",
        "performance",
      ],
    });
    jest.setSystemTime(SUITE_CLOCK);

    root = mkdtempSync(join(tmpdir(), "monize-backup-spec-"));
    defaultEnv = { BACKUP_CONTAINER_DIR: root };

    isDemo = false;
    mockSettingsRepo = {
      findOne: jest.fn(),
      find: jest.fn().mockResolvedValue([]),
      create: jest.fn().mockImplementation((data) => {
        const s = new AutoBackupSettings();
        Object.assign(s, data);
        return s;
      }),
      save: jest.fn().mockImplementation((entity) => Promise.resolve(entity)),
      createQueryBuilder: jest.fn(() => updateBuilder),
    };

    updateBuilder = {
      update: jest.fn(() => updateBuilder),
      set: jest.fn(() => updateBuilder),
      where: jest.fn(() => updateBuilder),
      execute: jest.fn().mockResolvedValue({ affected: 1 }),
    };

    mockUsersRepo = {
      findOne: jest.fn().mockImplementation(({ where }) =>
        Promise.resolve({
          id: where.id,
          backupEncryptionEnabled: false,
          backupPasswordEnc: null,
        }),
      ),
      // Managed-user enrollment sweeps every non-admin user; no such users by
      // default, so the cron tests below exercise only the due-backup path.
      find: jest.fn().mockResolvedValue([]),
    };

    maintenance = createUserMaintenanceMock();

    mockBackupService = {
      // The service now returns the buffer alongside a completeness report; the
      // default double reports a complete backup so promotion and retention run
      // exactly as before. The "partial backup" describe overrides it.
      exportToBuffer: jest.fn().mockResolvedValue({
        buffer: Buffer.from("gzipped-export"),
        report: {
          complete: true,
          expectedAttachments: 0,
          includedAttachments: 0,
          missingAttachments: 0,
          inconsistentAttachments: 0,
        },
      }),
    };

    mockBackupEncryption = {
      // Nothing stored by default: an ordinary unencrypted backup.
      resolveBackupPassword: jest.fn().mockResolvedValue({ status: "none" }),
    };

    service = await createService();
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.clearAllMocks();
    rmSync(root, { recursive: true, force: true });
  });

  /**
   * The guard for the defect this pinning exists to stop coming back.
   *
   * A comment saying "15 is an ordinary day" is true until somebody adds 15 to
   * `WEEKLY_DAYS`, at which point ten unrelated assertions start counting an
   * extra file and the failure points at retention or sharding rather than at
   * the calendar. Deriving the check from the service's own constants means
   * that change fails here, once, with a message that names the cause.
   */
  describe("the suite's own clock", () => {
    const pinnedDay = SUITE_CLOCK.getUTCDate();

    it("is pinned to a day that promotes neither weekly nor monthly", () => {
      expect(WEEKLY_DAYS).not.toContain(pinnedDay);
      expect(pinnedDay).not.toBe(MONTHLY_DAY);
    });

    it("actually reaches the code under test", () => {
      // `useFakeTimers` with a `doNotFake` list is easy to over-populate --
      // adding "Date" to it would leave every assertion below back on the wall
      // clock, silently, with the pinning still apparently in place.
      expect(new Date().toISOString()).toBe(SUITE_CLOCK.toISOString());
    });

    it("is installed in exactly one place", () => {
      // A second installation is how the narrow `doNotFake` list gets lost: a
      // new test writes the bare call it finds in every other Jest suite, gets
      // faked microtasks under real `fs.promises`, and hangs -- or reinstates
      // the wall clock for whatever runs after it. Use `withClockAt` to move
      // the date instead.
      const source = readFileSync(__filename, "utf8");
      const installs = source.match(/jest\.useFakeTimers\(/g) ?? [];
      expect(installs).toHaveLength(1);
    });
  });

  describe("getSettings", () => {
    it("should return existing settings when found", async () => {
      const existing = createSettings({
        enabled: true,
        folderPath: root,
      });
      mockSettingsRepo.findOne.mockResolvedValue(existing);

      const result = await service.getSettings(userId);

      expect(result).toStrictEqual(
        Object.assign(new AutoBackupSettings(), existing, {
          resolvedFolderPath: folderFor(),
        }),
      );
      expect(mockSettingsRepo.findOne).toHaveBeenCalledWith({
        where: { userId },
      });
    });

    it("reports the per-user folder the files actually land in", async () => {
      mockSettingsRepo.findOne.mockResolvedValue(
        createSettings({ enabled: true, folderPath: root }),
      );

      const result = await service.getSettings(userId);

      // Sharded by user id, so one deployment folder holds every user's
      // backups without their filenames -- which carry only a tier and a date
      // -- ever colliding.
      expect(result.resolvedFolderPath).toBe(folderFor());
    });

    it("should return defaults when no settings exist", async () => {
      mockSettingsRepo.findOne.mockResolvedValue(null);

      const result = await service.getSettings(userId);

      expect(result.userId).toBe(userId);
      expect(result.enabled).toBe(false);
      expect(result.folderPath).toBe(root);
      expect(result.frequency).toBe("daily");
      expect(result.backupTime).toBe("02:00");
      expect(result.retentionDaily).toBe(7);
      expect(result.retentionWeekly).toBe(4);
      expect(result.retentionMonthly).toBe(6);
    });

    it("should report the default folder for a stored row without one", async () => {
      mockSettingsRepo.findOne.mockResolvedValue(
        createSettings({ enabled: true, folderPath: "" }),
      );

      const result = await service.getSettings(userId);

      expect(result.folderPath).toBe(root);
      expect(result.enabled).toBe(true);
    });

    it("should default the folder path to BACKUP_CONTAINER_DIR when configured", async () => {
      service = await createService({
        BACKUP_CONTAINER_DIR: "/mnt/monize-backups",
      });
      mockSettingsRepo.findOne.mockResolvedValue(null);

      const result = await service.getSettings(userId);

      expect(result.folderPath).toBe("/mnt/monize-backups");
    });

    it("should trim a configured BACKUP_CONTAINER_DIR", async () => {
      service = await createService({
        BACKUP_CONTAINER_DIR: "  /mnt/backups/  ",
      });
      mockSettingsRepo.findOne.mockResolvedValue(null);

      const result = await service.getSettings(userId);

      expect(result.folderPath).toBe("/mnt/backups");
    });

    it("should use the built-in default when BACKUP_CONTAINER_DIR is unset", async () => {
      service = await createService({ BACKUP_CONTAINER_DIR: "" });
      mockSettingsRepo.findOne.mockResolvedValue(null);

      const result = await service.getSettings(userId);

      expect(result.folderPath).toBe(DEFAULT_BACKUP_CONTAINER_DIR);
    });

    it("should fall back to the built-in default for an invalid BACKUP_CONTAINER_DIR", async () => {
      service = await createService({
        BACKUP_CONTAINER_DIR: "relative/backups",
      });
      mockSettingsRepo.findOne.mockResolvedValue(null);

      const result = await service.getSettings(userId);

      expect(result.folderPath).toBe(DEFAULT_BACKUP_CONTAINER_DIR);
    });
  });

  describe("updateSettings", () => {
    it("should create new settings if none exist", async () => {
      mockSettingsRepo.findOne.mockResolvedValue(null);

      await service.updateSettings(userId, {
        folderPath: root,
        frequency: "weekly",
      });

      // The row is built by defaultSettingsFor() and saved directly; the
      // repo.create() round-trip it used to go through was a no-op clone.
      expect(mockSettingsRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          userId,
          folderPath: root,
          frequency: "weekly",
        }),
      );
    });

    it("should update existing settings", async () => {
      const existing = createSettings({ folderPath: "/old" });
      mockSettingsRepo.findOne.mockResolvedValue(existing);

      await service.updateSettings(userId, {
        folderPath: "/new-backups",
        retentionDaily: 14,
      });

      expect(mockSettingsRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          folderPath: "/new-backups",
          retentionDaily: 14,
        }),
      );
    });

    it("should fall back to BACKUP_CONTAINER_DIR when enabling without a folder path", async () => {
      mockSettingsRepo.findOne.mockResolvedValue(null);

      await service.updateSettings(userId, { enabled: true });

      expect(mockSettingsRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          enabled: true,
          folderPath: root,
        }),
      );
    });

    it("should validate folder is writable when enabling", async () => {
      mockSettingsRepo.findOne.mockResolvedValue(
        createSettings({ folderPath: root }),
      );

      await service.updateSettings(userId, { enabled: true });

      expect(mockSettingsRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          enabled: true,
          nextBackupAt: expect.any(Date),
        }),
      );
      // The per-user directory is what has to be writable, and enabling creates
      // it -- the root alone being writable says nothing about where the file
      // actually goes.
      expect((await fs.stat(folderFor())).isDirectory()).toBe(true);
    });

    it("refuses to enable a folder outside the permitted roots", async () => {
      const outside = mkdtempSync(join(tmpdir(), "monize-elsewhere-"));
      try {
        mockSettingsRepo.findOne.mockResolvedValue(
          createSettings({ folderPath: outside }),
        );

        await expect(
          service.updateSettings(userId, { enabled: true }),
        ).rejects.toThrow(/outside the permitted roots/);
        // A rejected command must not have written: the schedule stays off.
        expect(mockSettingsRepo.save).not.toHaveBeenCalled();
      } finally {
        rmSync(outside, { recursive: true, force: true });
      }
    });

    it("should clear nextBackupAt when disabling", async () => {
      const existing = createSettings({
        enabled: true,
        folderPath: root,
        nextBackupAt: new Date(),
      });
      mockSettingsRepo.findOne.mockResolvedValue(existing);

      await service.updateSettings(userId, { enabled: false });

      expect(mockSettingsRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          enabled: false,
          nextBackupAt: null,
        }),
      );
    });

    it("should reject non-absolute paths", async () => {
      mockSettingsRepo.findOne.mockResolvedValue(null);

      await expect(
        service.updateSettings(userId, { folderPath: "relative/path" }),
      ).rejects.toThrow(BadRequestException);
    });

    it("should reject paths with '..'", async () => {
      mockSettingsRepo.findOne.mockResolvedValue(null);

      await expect(
        service.updateSettings(userId, { folderPath: "/backups/../etc" }),
      ).rejects.toThrow(BadRequestException);
    });

    it("should update retention values", async () => {
      const existing = createSettings();
      mockSettingsRepo.findOne.mockResolvedValue(existing);

      await service.updateSettings(userId, {
        retentionDaily: 30,
        retentionWeekly: 12,
        retentionMonthly: 24,
      });

      expect(mockSettingsRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          retentionDaily: 30,
          retentionWeekly: 12,
          retentionMonthly: 24,
        }),
      );
    });

    it("should update backupTime", async () => {
      const existing = createSettings();
      mockSettingsRepo.findOne.mockResolvedValue(existing);

      await service.updateSettings(userId, { backupTime: "14:30" });

      expect(mockSettingsRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ backupTime: "14:30" }),
      );
    });
  });

  describe("validateFolder", () => {
    it("should return valid for a writable directory", async () => {
      const result = await service.validateFolder(root);

      expect(result).toEqual({ valid: true });
    });

    /**
     * `validateFolder` probes the *shared* root, so every user validating the
     * same folder writes a test file into one directory -- and the cron probes a
     * per-user folder that every replica fires for. The probe name was
     * `.monize-write-test-${Date.now()}`, which two calls in the same millisecond
     * pick identically: both writes succeed, the first unlink removes the file,
     * and the second gets ENOENT and reports the folder as not writable.
     *
     * The consequence is a user told to "check container permissions" for a
     * folder that is writable, and -- on the cron path -- an aborted backup.
     */
    it("stays valid when several probes run against one directory at once", async () => {
      const results = await Promise.all(
        Array.from({ length: 12 }, () => service.validateFolder(root)),
      );

      expect(results).toEqual(
        Array.from({ length: 12 }, () => ({ valid: true })),
      );
    });

    it("leaves no probe file behind", async () => {
      await service.validateFolder(root);
      const left = readdirSync(root).filter((name) =>
        name.startsWith(".monize-write-test-"),
      );
      expect(left).toEqual([]);
    });

    it("should return invalid for non-existent directory", async () => {
      const result = await service.validateFolder(join(root, "no-such-dir"));

      expect(result.valid).toBe(false);
      expect(result.error).toContain("does not exist");
    });

    it("should return invalid for non-directory path", async () => {
      const file = join(root, "file.txt");
      await fs.writeFile(file, "");

      const result = await service.validateFolder(file);

      expect(result.valid).toBe(false);
      expect(result.error).toContain("not a directory");
    });

    // chmod cannot demonstrate a permission denial to uid 0, and CI images
    // commonly run as root. Skipped rather than weakened into an assertion that
    // passes for the wrong reason.
    const itUnlessRoot = process.getuid?.() === 0 ? it.skip : it;

    itUnlessRoot(
      "should return invalid for non-writable directory",
      async () => {
        const readOnly = join(root, "read-only");
        await fs.mkdir(readOnly);
        await fs.chmod(readOnly, 0o500);
        service = await createService({ BACKUP_ALLOWED_ROOTS: root });

        try {
          const result = await service.validateFolder(readOnly);

          expect(result.valid).toBe(false);
          expect(result.error).toContain("not writable");
        } finally {
          await fs.chmod(readOnly, 0o700);
        }
      },
    );

    it("should return invalid for relative paths", async () => {
      const result = await service.validateFolder("relative/path");

      expect(result.valid).toBe(false);
      expect(result.error).toContain("absolute path");
    });

    it("should return invalid for paths with '..'", async () => {
      const result = await service.validateFolder(`${root}/../etc`);

      expect(result.valid).toBe(false);
      expect(result.error).toContain("..");
    });
  });

  /**
   * The destination used to be any absolute writable path, chosen through an
   * endpoint that requires authentication and no role. These are the paths that
   * must now be refused, and the one that must not.
   */
  /**
   * The default deployment has `readOnlyRootFilesystem: true` and, unless the
   * operator enables a claim, no mount at `/data/backups`. Enabling a schedule
   * there already fails -- `resolveUserFolder` creates the directory and
   * `assertFolderWritable` probes it -- so a follow-up review's claim that the
   * settings "can be stored" was wrong. What was right is what the user is told:
   * the message named a Docker volume, which is one of the two mechanisms and the
   * wrong one on Kubernetes, and read as a mistyped path rather than as a
   * deployment with nowhere to write.
   */
  describe("a deployment with no writable backup storage", () => {
    /**
     * A default root that cannot be created.
     *
     * EROFS is a property of the mount, not of the code, and this suite runs as
     * root -- so chmod cannot produce it and neither can any real directory here.
     * Only `mkdir` is substituted; the directory, the probe and the containment
     * checks stay real, which is the same trade the short-write tests in
     * `atomic-file.spec.ts` make.
     */
    async function serviceWithUncreatableRoot(): Promise<{
      service: AutoBackupService;
      root: string;
    }> {
      const unusable = join(root, "read-only-mount", "backups");
      const svc = await createService({
        BACKUP_CONTAINER_DIR: unusable,
        BACKUP_ALLOWED_ROOTS: unusable,
      });
      jest.spyOn(fs, "mkdir").mockRejectedValue(
        Object.assign(new Error("EROFS: read-only file system"), {
          code: "EROFS",
        }),
      );
      return { service: svc, root: unusable };
    }

    afterEach(() => {
      jest.restoreAllMocks();
    });

    it("still refuses to store an enabled schedule", async () => {
      const { service: svc } = await serviceWithUncreatableRoot();
      mockSettingsRepo.findOne.mockResolvedValue(createSettings());

      await expect(
        svc.updateSettings(userId, { enabled: true }),
      ).rejects.toThrow(BadRequestException);
      // The point: nothing was written. A schedule that cannot run must not be
      // stored as though it will.
      expect(mockSettingsRepo.save).not.toHaveBeenCalled();
    });

    it("says the deployment has no backup storage, not that a path is missing", async () => {
      const { service: svc, root: unusable } =
        await serviceWithUncreatableRoot();
      mockSettingsRepo.findOne.mockResolvedValue(createSettings());

      const error: Error = await svc
        .updateSettings(userId, { enabled: true })
        .then(
          () => new Error("expected a rejection"),
          (e: Error) => e,
        );

      expect(error.message).toContain("no writable backup storage");
      expect(error.message).toContain(unusable);
      // Both mechanisms, because the code cannot tell which platform it is on --
      // and the Kubernetes one was the half that used to be missing.
      expect(error.message).toMatch(/Docker/);
      expect(error.message).toMatch(/backend\.persistence\.backups/);
    });

    it("reports the capability as unavailable, with a reason", async () => {
      const { service: svc, root: unusable } =
        await serviceWithUncreatableRoot();

      // So a surface can say this before the user configures a frequency, a
      // time and a retention policy and presses save.
      const capability = await svc.describeCapability(userId);
      expect(capability.available).toBe(false);
      expect(capability.folderPath).toBe(unusable);
      expect(capability.reason).toBeTruthy();
    });

    it("reports the capability as available on a writable root", async () => {
      await expect(service.describeCapability(userId)).resolves.toEqual({
        available: true,
        folderPath: root,
      });
    });

    it("probes the configured root, not only the deployment default (F3RB-003)", async () => {
      // BACKUP_ALLOWED_ROOTS exists so an operator can mount somewhere other
      // than /data/backups. Probing only the default reported "no storage" for
      // a working configured root, and the banner then refused to re-arm a
      // schedule that would have saved and run.
      const other = mkdtempSync(join(tmpdir(), "monize-backup-other-"));
      try {
        const svc = await createService({
          BACKUP_CONTAINER_DIR: join(root, "does-not-exist", "nested"),
          BACKUP_ALLOWED_ROOTS: other,
        });
        mockSettingsRepo.findOne.mockResolvedValue(
          createSettings({ folderPath: other }),
        );

        await expect(svc.describeCapability(userId)).resolves.toEqual({
          available: true,
          folderPath: other,
        });
      } finally {
        rmSync(other, { recursive: true, force: true });
      }
    });

    it("refuses a stored root outside the permitted roots, and probes nothing there (F3RB-R1-001)", async () => {
      // `updateSettings` only checks a stored folder's syntax unless the same
      // call enables the schedule, and a deployment upgraded from before
      // confinement can already hold an arbitrary path. Capability must apply
      // the same containment the write does -- before touching the filesystem,
      // or it leaves a probe file outside the approved volume and then reports a
      // configuration available that `resolveUserFolder` refuses.
      const outside = mkdtempSync(join(tmpdir(), "monize-capability-outside-"));
      // Observe the real `writeFile` rather than replacing it: an empty
      // directory afterwards is also what a probe that cleaned up after itself
      // would leave, so the directory listing alone cannot tell "never wrote"
      // from "wrote and unlinked". The spy can.
      const writeFile = jest.spyOn(fs, "writeFile");
      try {
        mockSettingsRepo.findOne.mockResolvedValue(
          createSettings({ folderPath: outside }),
        );

        const capability = await service.describeCapability(userId);

        expect(capability.available).toBe(false);
        expect(capability.reason).toContain("outside the permitted roots");
        expect(
          writeFile.mock.calls.filter(([target]) =>
            String(target).startsWith(outside),
          ),
        ).toEqual([]);
        expect(readdirSync(outside)).toEqual([]);
      } finally {
        writeFile.mockRestore();
        rmSync(outside, { recursive: true, force: true });
      }
    });

    it("refuses a stored root symlinked out of the permitted roots (F3RB-R1-001)", async () => {
      const outside = mkdtempSync(join(tmpdir(), "monize-capability-target-"));
      const link = join(root, "stored-escape");
      try {
        await fs.symlink(outside, link);
        mockSettingsRepo.findOne.mockResolvedValue(
          createSettings({ folderPath: link }),
        );

        const capability = await service.describeCapability(userId);

        expect(capability.available).toBe(false);
        expect(readdirSync(outside)).toEqual([]);
      } finally {
        rmSync(link, { recursive: true, force: true });
        rmSync(outside, { recursive: true, force: true });
      }
    });

    it("still reports an enabled-but-out-of-policy row as unavailable rather than throwing", async () => {
      // The admin has to be able to load the page and switch such a schedule
      // off; capability answering "no" is what the banner needs, not an error.
      const outside = mkdtempSync(join(tmpdir(), "monize-capability-enabled-"));
      try {
        mockSettingsRepo.findOne.mockResolvedValue(
          createSettings({ enabled: true, folderPath: outside }),
        );

        await expect(service.describeCapability(userId)).resolves.toMatchObject(
          { available: false },
        );
      } finally {
        rmSync(outside, { recursive: true, force: true });
      }
    });

    it("leaves no probe file behind when reporting the capability", async () => {
      await service.describeCapability(userId);
      expect(
        readdirSync(root).filter((n) => n.startsWith(".monize-write-test-")),
      ).toEqual([]);
    });
  });

  /**
   * A path that cannot be a directory at all -- a component that is a file, a
   * symlink cycle, an untraversable parent. `realpathOfExistingAncestor` treats
   * only ENOENT as "not created yet" and used to rethrow everything else raw, so
   * these reached the client as a 500 carrying the resolved filesystem path
   * instead of a 400 saying what was wrong.
   */
  describe("a path that cannot be a directory", () => {
    it("answers with a bad request, not a server error", async () => {
      const blocker = join(root, "notes.txt");
      await fs.writeFile(blocker, "not a directory");

      const result = await service.validateFolder(join(blocker, "backups"));

      expect(result.valid).toBe(false);
      expect(result.error).toMatch(/cannot be used as a directory/);
      // The raw errno message and the resolved path do not belong in a response.
      expect(result.error).not.toMatch(/realpath/);
    });

    it("refuses to store a schedule pointing at one", async () => {
      const blocker = join(root, "ledger.csv");
      await fs.writeFile(blocker, "");
      mockSettingsRepo.findOne.mockResolvedValue(createSettings());

      await expect(
        service.updateSettings(userId, {
          enabled: true,
          folderPath: join(blocker, "backups"),
        }),
      ).rejects.toThrow(BadRequestException);
      expect(mockSettingsRepo.save).not.toHaveBeenCalled();
    });
  });

  describe("permitted roots", () => {
    it("refuses a writable directory outside every permitted root", async () => {
      const outside = mkdtempSync(join(tmpdir(), "monize-elsewhere-"));
      try {
        const result = await service.validateFolder(outside);

        expect(result.valid).toBe(false);
        expect(result.error).toContain("outside the permitted roots");
        // The message has to name the way out, or an operator with a legitimate
        // second volume has no idea why their configuration stopped working.
        expect(result.error).toContain("BACKUP_ALLOWED_ROOTS");
      } finally {
        rmSync(outside, { recursive: true, force: true });
      }
    });

    it("refuses the filesystem root, which the folder picker used to offer", async () => {
      await expect(service.browseFolders("/")).rejects.toThrow(
        BadRequestException,
      );
      expect((await service.validateFolder("/tmp")).valid).toBe(false);
    });

    it("accepts a directory an operator has permitted", async () => {
      const second = mkdtempSync(join(tmpdir(), "monize-second-root-"));
      try {
        service = await createService({ BACKUP_ALLOWED_ROOTS: second });

        expect(await service.validateFolder(second)).toEqual({ valid: true });
        // The deployment default stays permitted: excluding it would break the
        // out-of-the-box configuration.
        expect(await service.validateFolder(root)).toEqual({ valid: true });
      } finally {
        rmSync(second, { recursive: true, force: true });
      }
    });

    it("refuses a symlink inside a permitted root that points out of it", async () => {
      const outside = mkdtempSync(join(tmpdir(), "monize-symlink-target-"));
      const escape = join(root, "escape");
      try {
        await fs.symlink(outside, escape);

        // Lexically `escape` is inside `root`; only canonicalisation sees that
        // it is not. This is the case the old `safePath` check could not catch,
        // because it compared strings.
        const result = await service.validateFolder(escape);

        expect(result.valid).toBe(false);
        expect(result.error).toContain("outside the permitted roots");
      } finally {
        rmSync(escape, { recursive: true, force: true });
        rmSync(outside, { recursive: true, force: true });
      }
    });

    it.each([
      ["the user directory itself", (f: string) => f],
      ["the first shard segment", (f: string) => join(f, "..", "..")],
      ["the second shard segment", (f: string) => join(f, "..")],
    ])(
      "refuses a backup when %s is a symlink out of the permitted roots (F3RB-002)",
      async (_label, pick) => {
        // The root is canonicalised before the sharded segments are appended, so
        // a symlink anywhere in `<root>/<ab>/<cd>/<userId>` used to redirect the
        // write while the base still looked clean. The final path has to be
        // canonicalised too.
        const outside = mkdtempSync(join(tmpdir(), "monize-shard-target-"));
        const linkPath = pick(folderFor());
        try {
          await fs.mkdir(join(linkPath, ".."), { recursive: true });
          await fs.symlink(outside, linkPath);
          mockSettingsRepo.findOne.mockResolvedValue(
            createSettings({ folderPath: root }),
          );

          await expect(service.runManualBackup(userId)).rejects.toThrow(
            BadRequestException,
          );
          // Nothing may reach the symlink's target.
          expect(await listBackups(outside)).toEqual([]);
        } finally {
          rmSync(outside, { recursive: true, force: true });
        }
      },
    );

    it("accepts a symlink that stays inside a permitted root", async () => {
      const real = join(root, "real");
      const link = join(root, "link");
      await fs.mkdir(real);
      await fs.symlink(real, link);

      // Containment, not a ban on symlinks: an operator mounting a volume
      // through one has done nothing wrong.
      expect(await service.validateFolder(link)).toEqual({ valid: true });
    });
  });

  describe("default backup folder creation", () => {
    it("should create the configured default folder when it is missing", async () => {
      const missing = join(root, "auto-created");
      service = await createService({ BACKUP_CONTAINER_DIR: missing });

      const result = await service.validateFolder(missing);

      expect(result).toEqual({ valid: true });
      expect((await fs.stat(missing)).isDirectory()).toBe(true);
    });

    it("should not create a user-chosen folder that is missing", async () => {
      const chosen = join(root, "never-created");

      const result = await service.validateFolder(chosen);

      // A typo should surface as an error, not as a new empty directory that
      // silently becomes the backup destination.
      expect(result.valid).toBe(false);
      expect(result.error).toContain("does not exist");
      await expect(fs.stat(chosen)).rejects.toThrow();
    });

    const itUnlessRootHere = process.getuid?.() === 0 ? it.skip : it;

    itUnlessRootHere(
      "should report an error when the default folder cannot be created",
      async () => {
        const parent = join(root, "read-only-parent");
        await fs.mkdir(parent);
        await fs.chmod(parent, 0o500);
        const missing = join(parent, "child");
        service = await createService({ BACKUP_CONTAINER_DIR: missing });

        try {
          const result = await service.validateFolder(missing);

          expect(result.valid).toBe(false);
          expect(result.error).toContain("does not exist");
        } finally {
          await fs.chmod(parent, 0o700);
        }
      },
    );
  });

  describe("browseFolders", () => {
    it("should list subdirectories", async () => {
      await fs.mkdir(join(root, "backups"));
      await fs.mkdir(join(root, "data"));
      await fs.mkdir(join(root, ".hidden"));
      await fs.writeFile(join(root, "file.txt"), "");

      const result = await service.browseFolders(root);

      expect(result.current).toBe(await fs.realpath(root));
      expect(result.directories).toEqual(["backups", "data"]);
    });

    it("hides the per-user directories", async () => {
      await fs.mkdir(folderFor(), { recursive: true });
      await fs.mkdir(folderFor(otherUserId), { recursive: true });
      await fs.mkdir(join(root, "shared"));

      const result = await service.browseFolders(root);

      // Listing them would turn a folder picker into user enumeration, and
      // offering one as a destination would nest a second level inside it.
      expect(result.directories).toEqual(["shared"]);
    });

    it("should throw for non-existent path", async () => {
      await expect(
        service.browseFolders(join(root, "no-such")),
      ).rejects.toThrow(BadRequestException);
    });

    it("should throw for relative paths", async () => {
      await expect(service.browseFolders("relative")).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  describe("runManualBackup", () => {
    // These tests assert the daily-only outcome. The suite-wide clock
    // (SUITE_CLOCK) is already pinned to a plain day-of-month, so no promotion
    // to weekly/monthly interferes; the tests that exercise promotion move the
    // clock with withClockAt.
    it("should back up under BACKUP_CONTAINER_DIR when no settings exist", async () => {
      mockSettingsRepo.findOne.mockResolvedValue(null);

      await service.runManualBackup(userId);

      expect(mockSettingsRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          folderPath: root,
          lastBackupStatus: "success",
        }),
      );
      expect(await listBackups(folderFor())).toEqual([
        expect.stringMatching(/^monize-backup-daily-/),
      ]);
    });

    it("should back up under BACKUP_CONTAINER_DIR when no folder path is set", async () => {
      mockSettingsRepo.findOne.mockResolvedValue(
        createSettings({ folderPath: "" }),
      );

      await service.runManualBackup(userId);

      expect(await listBackups(folderFor())).toEqual([
        expect.stringMatching(
          /^monize-backup-daily-\d{4}-\d{2}-\d{2}\.json\.gz$/,
        ),
      ]);
    });

    it("writes into the user's own sharded folder, not flat into the base", async () => {
      mockSettingsRepo.findOne.mockResolvedValue(
        createSettings({ folderPath: root }),
      );

      const result = await service.runManualBackup(userId);

      expect(await listBackups(folderFor())).toEqual([result.filename]);
      // Nothing lands flat in the base: only the shard directory appears there.
      expect(
        (await listBackups(root)).filter((name) =>
          name.startsWith("monize-backup-"),
        ),
      ).toEqual([]);
    });

    it("creates the per-user folder on first use", async () => {
      mockSettingsRepo.findOne.mockResolvedValue(
        createSettings({ folderPath: root }),
      );
      // The base folder is mounted; the user's own folder is not there yet.
      await expect(fs.access(folderFor())).rejects.toThrow();

      const result = await service.runManualBackup(userId);

      // Created on demand, the way attachment shard directories are -- only
      // the base has to be mounted.
      expect(await listBackups(folderFor())).toEqual([result.filename]);
    });

    it("still refuses to create a missing base folder the operator chose", async () => {
      const missing = join(root, "missing-sub");
      mockSettingsRepo.findOne.mockResolvedValue(
        createSettings({ folderPath: missing }),
      );

      // A typo in the configured folder must surface, not silently create a
      // tree of shard directories somewhere nobody mounted.
      await expect(service.runManualBackup(userId)).rejects.toThrow(
        /does not exist/,
      );
      await expect(fs.access(missing)).rejects.toThrow();
    });

    it("rejects a user id that is not a safe path segment", async () => {
      mockSettingsRepo.findOne.mockResolvedValue(
        createSettings({ folderPath: root }),
      );

      await expect(service.runManualBackup("../../etc")).rejects.toThrow(
        /Path traversal/,
      );
      // Nothing was written anywhere under the root.
      expect(await listBackups(root)).toEqual([]);
    });

    it("refuses rather than writing an empty file mid-maintenance", async () => {
      // The cron defers silently; a manual run has someone watching, so it says
      // why. Writing the file anyway would produce an empty backup and then
      // rotate the last good one out to keep the retention count.
      mockSettingsRepo.findOne.mockResolvedValue(
        createSettings({ enabled: true, folderPath: root }),
      );
      maintenance.isUnderMaintenance.mockResolvedValue(true);

      await expect(service.runManualBackup(userId)).rejects.toThrow(
        ConflictException,
      );
      expect(mockBackupService.exportToBuffer).not.toHaveBeenCalled();
      // Nothing reached the disk: the user's folder holds no backup file.
      expect(await listBackups(folderFor())).toEqual([]);
    });

    it("should run backup and update status on success", async () => {
      mockSettingsRepo.findOne.mockResolvedValue(
        createSettings({ enabled: true, folderPath: root }),
      );

      const result = await service.runManualBackup(userId);

      expect(result.message).toBe("Backup completed successfully");
      expect(result.filename).toMatch(
        /^monize-backup-daily-\d{4}-\d{2}-\d{2}\.json\.gz$/,
      );
      expect(mockSettingsRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          lastBackupStatus: "success",
          lastBackupError: null,
        }),
      );
      // The bytes are on disk under the reported name, not merely written.
      expect(
        await fs.readFile(join(folderFor(), result.filename), "utf-8"),
      ).toBe("gzipped-export");
    });

    it("writes an .mzbe file when the user has encryption enabled", async () => {
      mockSettingsRepo.findOne.mockResolvedValue(
        createSettings({ enabled: true, folderPath: root }),
      );
      mockUsersRepo.findOne.mockResolvedValue({
        id: userId,
        backupEncryptionEnabled: true,
        backupPasswordEnc: "enc:secret",
      });
      mockBackupEncryption.resolveBackupPassword.mockResolvedValue({
        status: "password",
        password: "secret",
      });

      const result = await service.runManualBackup(userId);

      expect(mockBackupService.exportToBuffer).toHaveBeenCalledWith(
        userId,
        "secret",
      );
      expect(result.filename).toMatch(
        /^monize-backup-daily-\d{4}-\d{2}-\d{2}\.mzbe$/,
      );
      expect(await listBackups(folderFor())).toEqual([
        expect.stringMatching(/\.mzbe$/),
      ]);
    });

    it("throws when encryption is enabled but the stored password cannot be decrypted", async () => {
      mockSettingsRepo.findOne.mockResolvedValue(
        createSettings({ enabled: true, folderPath: root }),
      );
      mockUsersRepo.findOne.mockResolvedValue({
        id: userId,
        backupEncryptionEnabled: true,
        backupPasswordEnc: "enc:bad",
      });
      // Cron has no way to recover the password (e.g. master key rotated).
      mockBackupEncryption.resolveBackupPassword.mockResolvedValue({
        status: "unrecoverable",
      });

      await expect(service.runManualBackup(userId)).rejects.toThrow(
        /Re-enable encryption in Security/,
      );
      expect(mockBackupService.exportToBuffer).not.toHaveBeenCalled();
    });

    it("throws when the user row vanishes mid-flight", async () => {
      mockSettingsRepo.findOne.mockResolvedValue(
        createSettings({ enabled: true, folderPath: root }),
      );
      mockUsersRepo.findOne.mockResolvedValue(null);

      await expect(service.runManualBackup(userId)).rejects.toThrow(
        /not found/,
      );
    });
  });

  /**
   * Every user keeping the default folder wrote
   * `monize-backup-daily-<date>.json.gz` to the same path, so the second job of
   * the day replaced the first's artifact -- and retention then enumerated the
   * whole folder and applied whichever user's counts it was running for. One
   * replica and two users was enough.
   */
  describe("tenant isolation on a shared root", () => {
    // These tests assert the daily-only artifact set; the suite-wide SUITE_CLOCK
    // is already a plain day-of-month, so nothing promotes. See runManualBackup.
    it("writes two users' same-day backups to different files", async () => {
      mockSettingsRepo.findOne.mockResolvedValue(
        createSettings({ folderPath: root }),
      );
      const a = await service.runManualBackup(userId);
      const b = await service.runManualBackup(otherUserId);

      // Same filename, different directory: the name is date-based by design,
      // so isolation has to come from the path.
      expect(a.filename).toBe(b.filename);
      expect(await listBackups(folderFor())).toEqual([a.filename]);
      expect(await listBackups(folderFor(otherUserId))).toEqual([b.filename]);
    });

    it("applies one user's retention only to their own artifacts", async () => {
      // A keeps 30 days of history; B keeps one.
      await fs.mkdir(folderFor(), { recursive: true });
      for (const day of ["01", "02", "03"]) {
        await fs.writeFile(
          join(folderFor(), `monize-backup-daily-2026-04-${day}.json.gz`),
          "A",
        );
      }
      mockSettingsRepo.findOne.mockResolvedValue(
        createSettings({
          userId: otherUserId,
          folderPath: root,
          retentionDaily: 1,
          retentionWeekly: 0,
          retentionMonthly: 0,
        }),
      );

      await service.runManualBackup(otherUserId);

      // B's aggressive retention must not touch A's history.
      expect(await listBackups(folderFor())).toEqual([
        "monize-backup-daily-2026-04-01.json.gz",
        "monize-backup-daily-2026-04-02.json.gz",
        "monize-backup-daily-2026-04-03.json.gz",
      ]);
    });
  });

  describe("handleAutoBackupCron", () => {
    // These tests assert the daily-only artifact set; the suite-wide SUITE_CLOCK
    // is already a plain day-of-month, so nothing promotes. Promotion behaviour
    // is covered, with its own dates, in the partial-backup and retention
    // describes below.
    it("should do nothing if no backups are due", async () => {
      mockSettingsRepo.find.mockResolvedValue([]);

      await service.handleAutoBackupCron();

      expect(mockBackupService.exportToBuffer).not.toHaveBeenCalled();
    });

    it("should process due backups and update status", async () => {
      mockSettingsRepo.find.mockResolvedValue([
        createSettings({
          enabled: true,
          folderPath: root,
          nextBackupAt: new Date(Date.now() - 3600000),
        }),
      ]);

      await service.handleAutoBackupCron();

      expect(updateBuilder.set).toHaveBeenCalledWith(
        expect.objectContaining({
          lastBackupStatus: "success",
          lastBackupError: null,
        }),
      );
      expect(await listBackups(folderFor())).toHaveLength(1);
      // The schedule was advanced by the claim, not by re-saving the snapshot.
      const claim = scoped.manager.query.mock.calls.find((call) =>
        String(call[0]).includes("UPDATE auto_backup_settings"),
      );
      expect(claim).toBeDefined();
      expect(claim![1]![0]).toBeInstanceOf(Date);
    });

    it("should write under BACKUP_CONTAINER_DIR when a due row has no folder path", async () => {
      mockSettingsRepo.find.mockResolvedValue([
        createSettings({
          enabled: true,
          folderPath: "",
          nextBackupAt: new Date(Date.now() - 3600000),
        }),
      ]);

      await service.handleAutoBackupCron();

      expect(await listBackups(folderFor())).toEqual([
        expect.stringMatching(/^monize-backup-daily-/),
      ]);
    });

    it("keeps two due users' artifacts apart", async () => {
      mockSettingsRepo.find.mockResolvedValue([
        createSettings({
          folderPath: root,
          enabled: true,
          nextBackupAt: new Date(Date.now() - 3600000),
        }),
        createSettings({
          userId: otherUserId,
          folderPath: root,
          enabled: true,
          nextBackupAt: new Date(Date.now() - 3600000),
        }),
      ]);

      await service.handleAutoBackupCron();

      expect(await listBackups(folderFor())).toHaveLength(1);
      expect(await listBackups(folderFor(otherUserId))).toHaveLength(1);
    });

    it("leaves one artifact and no temp files after two runs on the same day (FV-004)", async () => {
      // #1061 established that a pid-based temp name is not unique: a manual and a
      // scheduled backup for the same user, day and extension collide inside one
      // process, and two replicas sharing a volume can hold the same pid. The
      // loser's rename then fails with ENOENT -- or its cleanup unlinks the file
      // the winner is about to rename -- so a run that was going to succeed fails.
      //
      // That fix now lives in `atomic-file.ts` (a UUID in the temp name), so what
      // is checked here is the observable consequence rather than the call: two
      // runs leave exactly one final artifact, replacing our own same-day file as
      // intended, and no intermediate file behind.
      mockSettingsRepo.find.mockResolvedValue([
        createSettings({
          enabled: true,
          folderPath: "",
          nextBackupAt: new Date(Date.now() - 3600000),
        }),
      ]);

      await service.handleAutoBackupCron();
      await service.handleAutoBackupCron();

      const left = await listBackups(folderFor());
      expect(left).toHaveLength(1);
      expect(left[0]).toMatch(/^monize-backup-daily-/);
      expect(left.filter((n) => n.startsWith("."))).toEqual([]);
    });

    it("should mark status as failed on error and continue", async () => {
      mockSettingsRepo.find.mockResolvedValue([
        createSettings({
          enabled: true,
          folderPath: join(root, "gone"),
          nextBackupAt: new Date(Date.now() - 3600000),
        }),
      ]);

      await service.handleAutoBackupCron();

      expect(updateBuilder.set).toHaveBeenCalledWith(
        expect.objectContaining({
          lastBackupStatus: "failed",
          lastBackupError: expect.any(String),
        }),
      );
    });

    describe("multi-replica coordination", () => {
      function dueSettings() {
        return createSettings({
          enabled: true,
          folderPath: root,
          nextBackupAt: new Date(Date.now() - 3600000),
        });
      }

      it("claims the window by advancing next_backup_at, guarded on it still being due", async () => {
        mockSettingsRepo.find.mockResolvedValue([dueSettings()]);

        await service.handleAutoBackupCron();

        const [sql, params] = scoped.manager.query.mock.calls.find((call) =>
          String(call[0]).includes("UPDATE auto_backup_settings"),
        )!;
        expect(sql).toContain("next_backup_at <= $3");
        expect(sql).toContain("enabled = true");
        expect(sql).toContain("RETURNING id");
        expect(params).toHaveLength(3);
      });

      it("exports nothing when another replica claimed the window", async () => {
        // The regression: every replica fires this cron, so with no claim a
        // two-replica cluster writes each user's backup twice -- and one
        // replica's retention sweep can delete the file the other is writing.
        mockSettingsRepo.find.mockResolvedValue([dueSettings()]);
        scoped.manager.query.mockResolvedValue([[], 0]);

        await service.handleAutoBackupCron();

        expect(mockBackupService.exportToBuffer).not.toHaveBeenCalled();
        expect(updateBuilder.execute).not.toHaveBeenCalled();
      });

      it("does not read a claim result as a win just because the driver returned a tuple", async () => {
        // `[rows, rowCount]` has length 2 whatever happened, so an open-coded
        // `result.length > 0` would make every replica a winner.
        mockSettingsRepo.find.mockResolvedValue([dueSettings()]);
        scoped.manager.query.mockResolvedValue([[], 0]);

        await service.handleAutoBackupCron();

        expect(mockBackupService.exportToBuffer).not.toHaveBeenCalled();
      });

      it("defers, without claiming, while the user's data is being replaced", async () => {
        // A `.mny` import with "start fresh" commits its wipe and then writes
        // rows for minutes. Backing up in that window saves the empty dataset as
        // today's file and then enforces retention -- rotating the last good
        // backup out to make room for one containing nothing (DR-04-02).
        mockSettingsRepo.find.mockResolvedValue([dueSettings()]);
        maintenance.isUnderMaintenance.mockResolvedValue(true);

        await service.handleAutoBackupCron();

        expect(mockBackupService.exportToBuffer).not.toHaveBeenCalled();
        // Not claimed, so next_backup_at stays in the past and the next hour
        // retries rather than skipping the whole period.
        const claim = scoped.manager.query.mock.calls.find((call) =>
          String(call[0]).includes("UPDATE auto_backup_settings"),
        );
        expect(claim).toBeUndefined();
      });

      it("does not enforce retention while deferring", async () => {
        // Retention runs inside the backup path, so deferring has to skip it
        // too: pruning to N files without having written a new one loses a
        // generation for nothing.
        mockSettingsRepo.find.mockResolvedValue([
          createSettings({
            enabled: true,
            folderPath: root,
            nextBackupAt: new Date(Date.now() - 3600000),
            retentionDaily: 1,
          }),
        ]);
        await fs.mkdir(folderFor(), { recursive: true });
        const existing = [
          "monize-backup-daily-2026-04-01.json.gz",
          "monize-backup-daily-2026-04-02.json.gz",
        ];
        for (const name of existing) {
          await fs.writeFile(join(folderFor(), name), "x");
        }
        maintenance.isUnderMaintenance.mockResolvedValue(true);

        await service.handleAutoBackupCron();

        // retentionDaily=1 would prune to a single file if the backup path had
        // run; deferring skips it, so both pre-existing dailies survive.
        expect((await listBackups(folderFor())).sort()).toEqual(existing);
      });

      it("writes only the outcome columns, never the whole snapshot", async () => {
        // `repo.save(settings)` would write back the folder, frequency and
        // retention this sweep read minutes ago, reverting anything the user
        // changed in the meantime.
        mockSettingsRepo.find.mockResolvedValue([dueSettings()]);

        await service.handleAutoBackupCron();

        expect(mockSettingsRepo.save).not.toHaveBeenCalled();
        const written = Object.keys(updateBuilder.set.mock.calls[0][0]);
        expect(written.sort()).toEqual([
          "lastBackupAt",
          "lastBackupError",
          "lastBackupStatus",
        ]);
      });
    });
  });

  /**
   * F3R7-001: an incomplete backup is written (the ledger is captured) but never
   * promoted or used for retention, so it cannot displace or age out a complete
   * copy, and its status is `partial` rather than `success`.
   */
  describe("a partial backup (some attachment bytes could not be included)", () => {
    beforeEach(() => {
      mockBackupService.exportToBuffer.mockResolvedValue({
        buffer: Buffer.from("gzipped-export"),
        report: {
          complete: false,
          expectedAttachments: 3,
          includedAttachments: 2,
          missingAttachments: 1,
          inconsistentAttachments: 0,
        },
      });
    });

    it("publishes it under its own tier name, never a daily one", async () => {
      mockSettingsRepo.findOne.mockResolvedValue(
        createSettings({ enabled: true, folderPath: root }),
      );

      const result = await service.runManualBackup(userId);

      expect(result.filename).toMatch(
        /^monize-backup-partial-\d{4}-\d{2}-\d{2}\.json\.gz$/,
      );
      expect(await listBackups(folderFor())).toEqual([result.filename]);
    });

    async function seed(names: string[]): Promise<void> {
      await fs.mkdir(folderFor(), { recursive: true });
      for (const name of names) {
        await fs.writeFile(join(folderFor(), name), "x");
      }
    }

    it("records `partial` status, not success, and explains why", async () => {
      mockSettingsRepo.findOne.mockResolvedValue(
        createSettings({ enabled: true, folderPath: root }),
      );

      const result = await service.runManualBackup(userId);

      expect(mockSettingsRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ lastBackupStatus: "partial" }),
      );
      const calls = mockSettingsRepo.save.mock.calls;
      const saved = calls[calls.length - 1][0];
      expect(saved.lastBackupError).toMatch(/attachment/i);
      expect(result.message).toMatch(/not promoted|not.*retention|attachment/i);
    });

    it("still writes the artifact so the ledger is captured", async () => {
      mockSettingsRepo.findOne.mockResolvedValue(
        createSettings({ enabled: true, folderPath: root }),
      );

      const result = await service.runManualBackup(userId);

      expect(
        await fs.readFile(join(folderFor(), result.filename), "utf-8"),
      ).toBe("gzipped-export");
    });

    it("does not run retention, so complete copies past the window survive", async () => {
      mockSettingsRepo.findOne.mockResolvedValue(
        createSettings({
          enabled: true,
          folderPath: root,
          retentionDaily: 1,
          retentionWeekly: 0,
          retentionMonthly: 0,
        }),
      );
      // Three complete dailies already on disk, retention set to keep 1.
      await seed([
        "monize-backup-daily-2026-04-01.json.gz",
        "monize-backup-daily-2026-04-02.json.gz",
        "monize-backup-daily-2026-04-03.json.gz",
      ]);

      await service.runManualBackup(userId);

      // A complete backup would have deleted the two oldest; a partial must not.
      const remaining = await listBackups(folderFor());
      expect(remaining).toContain("monize-backup-daily-2026-04-01.json.gz");
      expect(remaining).toContain("monize-backup-daily-2026-04-02.json.gz");
      expect(remaining).toContain("monize-backup-daily-2026-04-03.json.gz");
    });

    it("does not promote a partial to weekly or monthly", async () => {
      // Day 7 would normally trigger a weekly promotion.
      await withClockAt("2026-04-07T12:00:00Z", async () => {
        mockSettingsRepo.findOne.mockResolvedValue(
          createSettings({ enabled: true, folderPath: root }),
        );

        await service.runManualBackup(userId);

        const remaining = await listBackups(folderFor());
        expect(remaining.some((n) => n.includes("weekly"))).toBe(false);
        expect(remaining.some((n) => n.includes("monthly"))).toBe(false);
      });
    });

    it("the cron records partial and preserves complete copies too", async () => {
      mockSettingsRepo.find.mockResolvedValue([
        createSettings({
          enabled: true,
          folderPath: root,
          retentionDaily: 1,
          retentionWeekly: 0,
          retentionMonthly: 0,
          nextBackupAt: new Date("2000-01-01"),
        }),
      ]);
      await seed([
        "monize-backup-daily-2026-04-01.json.gz",
        "monize-backup-daily-2026-04-02.json.gz",
      ]);

      await service.handleAutoBackupCron();

      // The cron records the outcome with a targeted UPDATE (recordBackupOutcome),
      // not a whole-row repo.save, so a concurrent settings edit is never reverted.
      expect(updateBuilder.set).toHaveBeenCalledWith(
        expect.objectContaining({ lastBackupStatus: "partial" }),
      );
      const remaining = await listBackups(folderFor());
      expect(remaining).toContain("monize-backup-daily-2026-04-01.json.gz");
      expect(remaining).toContain("monize-backup-daily-2026-04-02.json.gz");
    });

    it("a later complete backup resumes normal promotion and retention", async () => {
      mockSettingsRepo.findOne.mockResolvedValue(
        createSettings({
          enabled: true,
          folderPath: root,
          retentionDaily: 1,
          retentionWeekly: 0,
          retentionMonthly: 0,
        }),
      );
      await seed([
        "monize-backup-daily-2026-04-01.json.gz",
        "monize-backup-daily-2026-04-02.json.gz",
      ]);
      // First run partial: everything preserved.
      await service.runManualBackup(userId);
      expect(await listBackups(folderFor())).toContain(
        "monize-backup-daily-2026-04-01.json.gz",
      );

      // Storage recovers; the next backup is complete and retention runs.
      mockBackupService.exportToBuffer.mockResolvedValue({
        buffer: Buffer.from("gzipped-export"),
        report: {
          complete: true,
          expectedAttachments: 3,
          includedAttachments: 3,
          missingAttachments: 0,
          inconsistentAttachments: 0,
        },
      });
      await service.runManualBackup(userId);

      const remaining = await listBackups(folderFor());
      expect(remaining).not.toContain("monize-backup-daily-2026-04-01.json.gz");
      expect(mockSettingsRepo.save).toHaveBeenLastCalledWith(
        expect.objectContaining({ lastBackupStatus: "success" }),
      );
    });
  });

  /**
   * F3RB-001 (issue #1069): a partial artifact used to be published under the
   * ordinary `daily-<date>` name and only afterwards *recorded* as partial, in
   * the settings row -- so it replaced that day's complete artifact before
   * anything looked at completeness, and every later retention pass counted it
   * as a complete daily. With `retentionDaily = 3`, three complete recovery
   * points could become one.
   *
   * These tests assert on the artifacts' **bytes**, not on their names. A name
   * is what the previous design got wrong, so a suite that reads names to decide
   * which artifact survived would be asking the defect to grade itself.
   */
  describe("a partial artifact never displaces or ages out a complete one", () => {
    const COMPLETE = {
      complete: true,
      expectedAttachments: 3,
      includedAttachments: 3,
      missingAttachments: 0,
      inconsistentAttachments: 0,
    };
    const PARTIAL = {
      complete: false,
      expectedAttachments: 3,
      includedAttachments: 2,
      missingAttachments: 1,
      inconsistentAttachments: 0,
    };

    /** The next export produces exactly `content`, complete or not. */
    function nextExport(content: string, complete: boolean): void {
      mockBackupService.exportToBuffer.mockResolvedValueOnce({
        buffer: Buffer.from(content),
        report: complete ? COMPLETE : PARTIAL,
      });
    }

    /** An artifact already on disk when this run starts. */
    async function put(name: string, content: string): Promise<void> {
      await fs.mkdir(folderFor(), { recursive: true });
      await fs.writeFile(join(folderFor(), name), content);
    }

    /** The bytes under `name`, or `null` when nothing is there. */
    async function read(name: string): Promise<string | null> {
      try {
        return await fs.readFile(join(folderFor(), name), "utf-8");
      } catch {
        return null;
      }
    }

    /** What every artifact in the user's folder currently holds. */
    async function contents(): Promise<Record<string, string>> {
      const names = await listBackups(folderFor());
      const entries = await Promise.all(
        names.map(async (name) => [name, await read(name)] as const),
      );
      return Object.fromEntries(entries) as Record<string, string>;
    }

    it("a same-day partial run leaves the complete artifact's bytes intact", async () => {
      mockSettingsRepo.findOne.mockResolvedValue(
        createSettings({ enabled: true, folderPath: root }),
      );

      nextExport("complete-02:00", true);
      const complete = await service.runManualBackup(userId);
      nextExport("partial-08:00", false);
      const partial = await service.runManualBackup(userId);

      expect(partial.filename).not.toBe(complete.filename);
      // The whole of the defect: this used to read "partial-08:00".
      expect(await read(complete.filename)).toBe("complete-02:00");
      expect(await read(partial.filename)).toBe("partial-08:00");
    });

    it("every6hours: an 08:00 partial cron run does not replace the 02:00 complete one", async () => {
      mockSettingsRepo.find.mockResolvedValue([
        createSettings({
          enabled: true,
          folderPath: root,
          frequency: "every6hours",
          nextBackupAt: new Date("2000-01-01"),
        }),
      ]);

      nextExport("complete-02:00", true);
      await service.handleAutoBackupCron();
      nextExport("partial-08:00", false);
      await service.handleAutoBackupCron();

      expect(await contents()).toEqual({
        "monize-backup-daily-2026-04-15.json.gz": "complete-02:00",
        "monize-backup-partial-2026-04-15.json.gz": "partial-08:00",
      });
    });

    it("keeps retentionDaily complete recovery points across a run of partial days", async () => {
      // The issue's worked example: days 1-3 complete, days 4-6 partial, a
      // complete backup on day 7 running retention with `retentionDaily = 3`.
      // Under the defect the three partial days occupied the three daily slots
      // and every complete artifact was deleted.
      mockSettingsRepo.findOne.mockResolvedValue(
        createSettings({
          enabled: true,
          folderPath: root,
          retentionDaily: 3,
          retentionWeekly: 0,
          retentionMonthly: 0,
        }),
      );
      await put("monize-backup-daily-2026-04-01.json.gz", "complete-day-1");
      await put("monize-backup-daily-2026-04-02.json.gz", "complete-day-2");
      await put("monize-backup-daily-2026-04-03.json.gz", "complete-day-3");

      for (const day of ["04", "05", "06"]) {
        await withClockAt(`2026-04-${day}T02:00:00Z`, async () => {
          nextExport(`partial-day-${day}`, false);
          await service.runManualBackup(userId);
        });
      }
      await withClockAt("2026-04-10T02:00:00Z", async () => {
        nextExport("complete-day-10", true);
        await service.runManualBackup(userId);
      });

      // Three complete recovery points, judged by what the files hold rather
      // than by what they are called.
      const onDisk = await contents();
      const complete = Object.values(onDisk).filter((body) =>
        body.startsWith("complete-"),
      );
      expect(complete.sort()).toEqual([
        "complete-day-10",
        "complete-day-2",
        "complete-day-3",
      ]);
      // ...and the three partial days are all still there, kept to their own
      // count in their own tier. Neither number is spent on the other's
      // artifacts: three complete recovery points and three partial ones.
      expect(
        Object.values(onDisk)
          .filter((body) => body.startsWith("partial-"))
          .sort(),
      ).toEqual(["partial-day-04", "partial-day-05", "partial-day-06"]);
    });

    it("classifies artifacts on a rescan, with no settings row to consult", async () => {
      // Completeness has to live in the artifact's identity, because the state
      // that used to hold it does not survive a restart, a copied file or a
      // directory somebody else mounted. A fresh service instance and a settings
      // row that remembers nothing must sweep both tiers correctly from the
      // listing alone.
      await put("monize-backup-daily-2026-04-01.json.gz", "complete-day-1");
      await put("monize-backup-daily-2026-04-02.json.gz", "complete-day-2");
      await put("monize-backup-partial-2026-04-03.json.gz", "partial-day-3");
      await put("monize-backup-partial-2026-04-04.json.gz", "partial-day-4");
      mockSettingsRepo.findOne.mockResolvedValue(
        createSettings({
          enabled: true,
          folderPath: root,
          retentionDaily: 1,
          retentionWeekly: 0,
          retentionMonthly: 0,
          lastBackupStatus: null,
        }),
      );

      const restarted = await createService();
      nextExport("complete-today", true);
      await restarted.runManualBackup(userId);

      expect(await contents()).toEqual({
        "monize-backup-daily-2026-04-15.json.gz": "complete-today",
        "monize-backup-partial-2026-04-04.json.gz": "partial-day-4",
      });
    });

    it("publishes a complete and a partial run concurrently without either losing", async () => {
      mockSettingsRepo.findOne.mockResolvedValue(
        createSettings({ enabled: true, folderPath: root }),
      );
      nextExport("complete-bytes", true);
      nextExport("partial-bytes", false);

      await Promise.all([
        service.runManualBackup(userId),
        service.runManualBackup(userId),
      ]);

      // Two replicas, or a manual run beside a cron one: sharing one filename
      // made the outcome a race whose loser was a whole recovery point.
      expect(await contents()).toEqual({
        "monize-backup-daily-2026-04-15.json.gz": "complete-bytes",
        "monize-backup-partial-2026-04-15.json.gz": "partial-bytes",
      });
    });

    it("leaves a promoted weekly copy alone when a later partial run follows", async () => {
      // Derived from the service's own promotion calendar rather than hardcoded,
      // for the reason the suite-clock guard above exists.
      const weeklyDay = String(WEEKLY_DAYS[0]).padStart(2, "0");
      await withClockAt(`2026-04-${weeklyDay}T02:00:00Z`, async () => {
        mockSettingsRepo.findOne.mockResolvedValue(
          createSettings({ enabled: true, folderPath: root }),
        );
        nextExport("complete-promoted", true);
        await service.runManualBackup(userId);
        nextExport("partial-later", false);
        await service.runManualBackup(userId);

        expect(await contents()).toEqual({
          [`monize-backup-daily-2026-04-${weeklyDay}.json.gz`]:
            "complete-promoted",
          [`monize-backup-weekly-2026-04-${weeklyDay}.json.gz`]:
            "complete-promoted",
          [`monize-backup-partial-2026-04-${weeklyDay}.json.gz`]:
            "partial-later",
        });
      });
    });

    it("a partial run bounds older partial artifacts and no complete ones", async () => {
      // The other half of giving partials a tier: they must not accumulate
      // without bound while storage is broken. The only thing a partial run may
      // delete is an older partial.
      await put("monize-backup-daily-2026-04-01.json.gz", "complete-day-1");
      await put("monize-backup-daily-2026-04-02.json.gz", "complete-day-2");
      await put("monize-backup-partial-2026-04-03.json.gz", "partial-day-3");
      await put("monize-backup-partial-2026-04-04.json.gz", "partial-day-4");
      mockSettingsRepo.findOne.mockResolvedValue(
        createSettings({
          enabled: true,
          folderPath: root,
          retentionDaily: 1,
          retentionWeekly: 0,
          retentionMonthly: 0,
        }),
      );

      nextExport("partial-today", false);
      await service.runManualBackup(userId);

      expect(await contents()).toEqual({
        "monize-backup-daily-2026-04-01.json.gz": "complete-day-1",
        "monize-backup-daily-2026-04-02.json.gz": "complete-day-2",
        "monize-backup-partial-2026-04-15.json.gz": "partial-today",
      });
    });
  });

  describe("managed-user enrollment", () => {
    const otherUserId = "77777777-7777-7777-7777-777777777777";

    /**
     * Enrollment reads the settings rows of the non-admin users it found;
     * the due-backup fan-out reads the enabled rows that are due. Both go
     * through `find`, so answer them by their `where` clause.
     */
    function settingsFind({
      managed = [],
      due = [],
    }: {
      managed?: AutoBackupSettings[];
      due?: AutoBackupSettings[];
    }) {
      mockSettingsRepo.find.mockImplementation((options) =>
        Promise.resolve("userId" in (options?.where ?? {}) ? managed : due),
      );
    }

    it("enrolls a non-admin user who has no settings row", async () => {
      mockUsersRepo.find.mockResolvedValue([{ id: otherUserId }]);
      settingsFind({});

      await service.handleAutoBackupCron();

      // Automatic backups are not something a non-admin can switch on, so
      // nothing would ever back them up unless this did.
      expect(mockSettingsRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: otherUserId,
          enabled: true,
          folderPath: root,
          frequency: "daily",
          backupTime: "02:00",
          retentionDaily: 7,
          retentionWeekly: 4,
          retentionMonthly: 6,
          nextBackupAt: expect.any(Date),
        }),
      );
    });

    it("only sweeps active non-admin users", async () => {
      mockUsersRepo.find.mockResolvedValue([]);

      await service.handleAutoBackupCron();

      expect(mockUsersRepo.find).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ isActive: true }),
        }),
      );
      // An admin configures their own; a deactivated account is not backed up.
      const { where } = mockUsersRepo.find.mock.calls[0][0];
      expect(where.role).toEqual(expect.objectContaining({ value: "admin" }));
    });

    it("brings a drifted row back to the deployment defaults", async () => {
      mockUsersRepo.find.mockResolvedValue([{ id: otherUserId }]);
      const drifted = createSettings({
        enabled: false,
        folderPath: "/somewhere/else",
        retentionDaily: 99,
        nextBackupAt: new Date("2026-04-01T02:00:00Z"),
      });
      drifted.userId = otherUserId;
      settingsFind({ managed: [drifted] });

      await service.handleAutoBackupCron();

      expect(mockSettingsRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: otherUserId,
          enabled: true,
          folderPath: root,
          retentionDaily: 7,
          // The schedule's own bookkeeping is not reset, so enrollment does
          // not re-trigger a backup every hour.
          nextBackupAt: drifted.nextBackupAt,
        }),
      );
    });

    it("writes nothing when the managed row already matches", async () => {
      mockUsersRepo.find.mockResolvedValue([{ id: otherUserId }]);
      const settled = createSettings({
        enabled: true,
        folderPath: root,
        nextBackupAt: new Date("2026-04-01T02:00:00Z"),
      });
      settled.userId = otherUserId;
      settingsFind({ managed: [settled] });

      await service.handleAutoBackupCron();

      expect(mockSettingsRepo.save).not.toHaveBeenCalled();
    });

    it("keeps enrolling after one user's row fails to save", async () => {
      const thirdUserId = "88888888-8888-8888-8888-888888888888";
      mockUsersRepo.find.mockResolvedValue([
        { id: otherUserId },
        { id: thirdUserId },
      ]);
      settingsFind({});
      mockSettingsRepo.save.mockImplementationOnce(() =>
        Promise.reject(new Error("db down")),
      );

      await service.handleAutoBackupCron();

      expect(mockSettingsRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ userId: thirdUserId, enabled: true }),
      );
    });

    it("enrolls nobody in demo mode", async () => {
      isDemo = true;
      service = await createService();
      mockUsersRepo.find.mockResolvedValue([{ id: otherUserId }]);
      settingsFind({});

      await service.handleAutoBackupCron();

      // Demo accounts are regenerated daily; backing them up writes throwaway
      // exports for data that is about to be deleted.
      expect(mockUsersRepo.find).not.toHaveBeenCalled();
      expect(mockSettingsRepo.save).not.toHaveBeenCalled();
    });
  });

  describe("retention policy", () => {
    async function seed(names: string[]): Promise<void> {
      await fs.mkdir(folderFor(), { recursive: true });
      for (const name of names) {
        await fs.writeFile(join(folderFor(), name), "x");
      }
    }

    it("should keep the most recent N daily backups", async () => {
      mockSettingsRepo.findOne.mockResolvedValue(
        createSettings({
          enabled: true,
          folderPath: root,
          retentionDaily: 2,
          retentionWeekly: 0,
          retentionMonthly: 0,
        }),
      );
      await seed([
        "monize-backup-daily-2026-04-01.json.gz",
        "monize-backup-daily-2026-04-02.json.gz",
        "monize-backup-daily-2026-04-03.json.gz",
      ]);

      await service.runManualBackup(userId);

      const remaining = await listBackups(folderFor());
      expect(remaining).not.toContain("monize-backup-daily-2026-04-01.json.gz");
      expect(remaining).toContain("monize-backup-daily-2026-04-03.json.gz");
    });

    it("should keep the most recent N weekly backups independently", async () => {
      mockSettingsRepo.findOne.mockResolvedValue(
        createSettings({
          enabled: true,
          folderPath: root,
          retentionDaily: 7,
          retentionWeekly: 2,
          retentionMonthly: 0,
        }),
      );
      await seed([
        "monize-backup-weekly-2026-03-07.json.gz",
        "monize-backup-weekly-2026-03-14.json.gz",
        "monize-backup-weekly-2026-03-21.json.gz",
      ]);

      await service.runManualBackup(userId);

      const remaining = await listBackups(folderFor());
      expect(remaining).not.toContain(
        "monize-backup-weekly-2026-03-07.json.gz",
      );
      expect(remaining).toContain("monize-backup-weekly-2026-03-21.json.gz");
    });

    it("should keep the most recent N monthly backups independently", async () => {
      mockSettingsRepo.findOne.mockResolvedValue(
        createSettings({
          enabled: true,
          folderPath: root,
          retentionDaily: 7,
          retentionWeekly: 4,
          retentionMonthly: 1,
        }),
      );
      await seed([
        "monize-backup-monthly-26-01.json.gz",
        "monize-backup-monthly-26-02.json.gz",
      ]);

      await service.runManualBackup(userId);

      const remaining = await listBackups(folderFor());
      expect(remaining).not.toContain("monize-backup-monthly-26-01.json.gz");
      expect(remaining).toContain("monize-backup-monthly-26-02.json.gz");
    });

    it("counts files left flat in the base folder by an older version", async () => {
      mockSettingsRepo.findOne.mockResolvedValue(
        createSettings({
          enabled: true,
          folderPath: root,
          // Three, not two: the run about to happen writes today's artifact,
          // which is the newest daily and occupies one retention slot itself.
          retentionDaily: 3,
          retentionWeekly: 0,
          retentionMonthly: 0,
        }),
      );
      await seed([
        "monize-backup-daily-2026-04-03.json.gz",
        "monize-backup-daily-2026-04-04.json.gz",
      ]);
      const legacyNames = [
        "monize-backup-daily-2026-04-01.json.gz",
        "monize-backup-daily-2026-04-02.json.gz",
      ];
      for (const name of legacyNames) {
        await fs.writeFile(join(root, name), "legacy");
      }

      await service.runManualBackup(userId);

      // Legacy flat files carry no user id, so nothing new will ever appear
      // beside them: sweeping them with the sharded ones ages them out instead
      // of stranding them under a limit that no longer looks at them.
      for (const name of legacyNames) {
        await expect(fs.access(join(root, name))).rejects.toThrow();
      }
      const remaining = await listBackups(folderFor());
      expect(remaining).toContain("monize-backup-daily-2026-04-03.json.gz");
      expect(remaining).toContain("monize-backup-daily-2026-04-04.json.gz");
    });

    it("keeps the sharded copy over the legacy one on an equal date", async () => {
      mockSettingsRepo.findOne.mockResolvedValue(
        createSettings({
          enabled: true,
          folderPath: root,
          // Today's write takes the first slot; the second is what the two
          // equal-dated copies compete for.
          retentionDaily: 2,
          retentionWeekly: 0,
          retentionMonthly: 0,
        }),
      );
      const legacy = join(root, "monize-backup-daily-2026-04-01.json.gz");
      await fs.writeFile(legacy, "legacy");
      await seed(["monize-backup-daily-2026-04-01.json.gz"]);

      await service.runManualBackup(userId);

      // The sharded file is known to be this user's; the flat one is anyone's.
      await expect(fs.access(legacy)).rejects.toThrow();
      expect(await listBackups(folderFor())).toContain(
        "monize-backup-daily-2026-04-01.json.gz",
      );
    });

    it("should copy daily to weekly on days 7, 14, 21, 28", async () => {
      mockSettingsRepo.findOne.mockResolvedValue(
        createSettings({ enabled: true, folderPath: root }),
      );

      await withClockAt("2026-04-14T10:00:00Z", async () => {
        await service.runManualBackup(userId);

        expect(await listBackups(folderFor())).toEqual([
          "monize-backup-daily-2026-04-14.json.gz",
          "monize-backup-weekly-2026-04-14.json.gz",
        ]);
      });
    });

    it("should copy daily to monthly on day 1", async () => {
      mockSettingsRepo.findOne.mockResolvedValue(
        createSettings({ enabled: true, folderPath: root }),
      );

      await withClockAt("2026-04-01T10:00:00Z", async () => {
        await service.runManualBackup(userId);

        expect(await listBackups(folderFor())).toEqual([
          "monize-backup-daily-2026-04-01.json.gz",
          "monize-backup-monthly-26-04.json.gz",
        ]);
      });
    });

    it("should not delete non-backup files", async () => {
      mockSettingsRepo.findOne.mockResolvedValue(
        createSettings({
          enabled: true,
          folderPath: root,
          retentionDaily: 1,
          retentionWeekly: 0,
          retentionMonthly: 0,
        }),
      );
      await seed(["some-other-file.txt", "readme.md"]);

      await service.runManualBackup(userId);

      const remaining = await listBackups(folderFor());
      expect(remaining).toContain("some-other-file.txt");
      expect(remaining).toContain("readme.md");
    });

    /**
     * A partial write is not a backup. Counting one towards "keep 7 daily" would
     * silently shorten the retention window -- and it would be counted, because
     * a truncated file has a valid name and a plausible date.
     */
    it("does not count an interrupted write towards retention", async () => {
      mockSettingsRepo.findOne.mockResolvedValue(
        createSettings({
          enabled: true,
          folderPath: root,
          retentionDaily: 2,
          retentionWeekly: 0,
          retentionMonthly: 0,
        }),
      );
      await seed([
        "monize-backup-daily-2026-04-01.json.gz",
        ".monize-backup-tmp-999-1-monize-backup-daily-2026-04-02.json.gz",
      ]);

      await service.runManualBackup(userId);

      // Two real artifacts now exist (April 1 and today), which is the limit --
      // so April 1 survives. Had the temp file been counted, it would not have.
      expect(await listBackups(folderFor())).toContain(
        "monize-backup-daily-2026-04-01.json.gz",
      );
    });

    it("leaves another user's folder alone", async () => {
      mockSettingsRepo.findOne.mockResolvedValue(
        createSettings({
          enabled: true,
          folderPath: root,
          retentionDaily: 1,
          retentionWeekly: 0,
          retentionMonthly: 0,
        }),
      );
      await seed(["monize-backup-daily-2026-04-01.json.gz"]);
      await fs.mkdir(folderFor(otherUserId), { recursive: true });
      await fs.writeFile(
        join(folderFor(otherUserId), "monize-backup-daily-2026-04-01.json.gz"),
        "theirs",
      );

      const result = await service.runManualBackup(userId);

      // Retention demonstrably ran -- the caller's own April file is gone --
      // and still never crossed into the other user's folder.
      expect(await listBackups(folderFor())).toEqual([result.filename]);
      expect(await listBackups(folderFor(otherUserId))).toEqual([
        "monize-backup-daily-2026-04-01.json.gz",
      ]);
    });
  });

  describe("frequency calculation with backup time", () => {
    it("should schedule daily backup at configured time", async () => {
      const existing = createSettings({
        folderPath: root,
        backupTime: "03:30",
      });
      mockSettingsRepo.findOne.mockResolvedValue(existing);

      await service.updateSettings(userId, {
        enabled: true,
        frequency: "daily",
      });

      const savedCall = mockSettingsRepo.save.mock.calls[0][0];
      const nextAt = savedCall.nextBackupAt as Date;
      expect(nextAt.getUTCHours()).toBe(3);
      // Minutes are snapped to 0 since the cron fires at minute 0 each hour
      expect(nextAt.getUTCMinutes()).toBe(0);
    });

    it("should schedule next slot for sub-daily frequency", async () => {
      const existing = createSettings({
        folderPath: root,
        backupTime: "00:00",
      });
      mockSettingsRepo.findOne.mockResolvedValue(existing);

      await service.updateSettings(userId, {
        enabled: true,
        frequency: "every6hours",
      });

      const savedCall = mockSettingsRepo.save.mock.calls[0][0];
      const nextAt = savedCall.nextBackupAt as Date;
      // Should be at minute 0 (aligned to configured time)
      expect(nextAt.getUTCMinutes()).toBe(0);
    });

    it("should schedule weekly backup at configured time", async () => {
      const existing = createSettings({
        folderPath: root,
        backupTime: "23:00",
      });
      mockSettingsRepo.findOne.mockResolvedValue(existing);

      await service.updateSettings(userId, {
        enabled: true,
        frequency: "weekly",
      });

      const savedCall = mockSettingsRepo.save.mock.calls[0][0];
      const nextAt = savedCall.nextBackupAt as Date;
      expect(nextAt.getUTCHours()).toBe(23);
      expect(nextAt.getUTCMinutes()).toBe(0);
    });

    it("should convert local timezone backup time to UTC", async () => {
      // America/New_York is UTC-5 (EST) or UTC-4 (EDT)
      const existing = createSettings({
        folderPath: root,
        backupTime: "02:00",
        timezone: "America/New_York",
      });
      mockSettingsRepo.findOne.mockResolvedValue(existing);

      await service.updateSettings(userId, {
        enabled: true,
        frequency: "daily",
      });

      const savedCall = mockSettingsRepo.save.mock.calls[0][0];
      const nextAt = savedCall.nextBackupAt as Date;
      // 02:00 EST = 07:00 UTC, or 02:00 EDT = 06:00 UTC
      expect([6, 7]).toContain(nextAt.getUTCHours());
      expect(nextAt.getUTCMinutes()).toBe(0);
    });

    it("should handle UTC timezone without offset", async () => {
      const existing = createSettings({
        folderPath: root,
        backupTime: "14:30",
        timezone: "UTC",
      });
      mockSettingsRepo.findOne.mockResolvedValue(existing);

      await service.updateSettings(userId, {
        enabled: true,
        frequency: "daily",
      });

      const savedCall = mockSettingsRepo.save.mock.calls[0][0];
      const nextAt = savedCall.nextBackupAt as Date;
      expect(nextAt.getUTCHours()).toBe(14);
      // Minutes are snapped to 0 since the cron fires at minute 0 each hour
      expect(nextAt.getUTCMinutes()).toBe(0);
    });

    it("should handle positive UTC offset timezone", async () => {
      // Europe/Berlin is UTC+1 (CET) or UTC+2 (CEST)
      const existing = createSettings({
        folderPath: root,
        backupTime: "03:00",
        timezone: "Europe/Berlin",
      });
      mockSettingsRepo.findOne.mockResolvedValue(existing);

      await service.updateSettings(userId, {
        enabled: true,
        frequency: "daily",
      });

      const savedCall = mockSettingsRepo.save.mock.calls[0][0];
      const nextAt = savedCall.nextBackupAt as Date;
      // 03:00 CET = 02:00 UTC, or 03:00 CEST = 01:00 UTC
      expect([1, 2]).toContain(nextAt.getUTCHours());
      expect(nextAt.getUTCMinutes()).toBe(0);
    });

    it("should store timezone when updating settings", async () => {
      const existing = createSettings({ folderPath: root });
      mockSettingsRepo.findOne.mockResolvedValue(existing);

      await service.updateSettings(userId, {
        timezone: "Asia/Tokyo",
      });

      const savedCall = mockSettingsRepo.save.mock.calls[0][0];
      expect(savedCall.timezone).toBe("Asia/Tokyo");
    });

    it("should use timezone for sub-daily frequency scheduling", async () => {
      // America/Chicago is UTC-6 (CST) or UTC-5 (CDT)
      const existing = createSettings({
        folderPath: root,
        backupTime: "06:00",
        timezone: "America/Chicago",
      });
      mockSettingsRepo.findOne.mockResolvedValue(existing);

      await service.updateSettings(userId, {
        enabled: true,
        frequency: "every12hours",
      });

      const savedCall = mockSettingsRepo.save.mock.calls[0][0];
      const nextAt = savedCall.nextBackupAt as Date;
      // 06:00 CST = 12:00 UTC, or 06:00 CDT = 11:00 UTC
      // Slots are at 06:00 and 18:00 local, so UTC equivalents vary
      expect(nextAt.getUTCMinutes()).toBe(0);
    });
  });
});
