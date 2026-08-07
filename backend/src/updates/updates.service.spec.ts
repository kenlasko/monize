import { ConfigService } from "@nestjs/config";
import { Test, TestingModule } from "@nestjs/testing";
import { DataSource } from "typeorm";
import { UserPreference } from "../users/entities/user-preference.entity";
import { createScopedDbMocks } from "../test-helpers/scoped-db-testing";
import {
  createUserPreferenceRepoMock,
  type UserPreferenceRepoMock,
} from "../test-helpers/user-preference-testing";
import {
  UpdatesService,
  isNewerVersion,
  parseVersion,
} from "./updates.service";

jest.mock("../common/db/scoped-db", () =>
  jest.requireActual("../test-helpers/scoped-db-testing").scopedDbMockModule(),
);

// The service reads its own "current version" from backend/package.json at
// module load time. Grab it here so assertions stay in sync if the repo
// version bumps.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const currentVersion = (require("../../package.json") as { version: string })
  .version;

describe("version helpers", () => {
  it("parses semver strings with and without v prefix", () => {
    expect(parseVersion("1.2.3")).toEqual([1, 2, 3]);
    expect(parseVersion("v10.20.30")).toEqual([10, 20, 30]);
    expect(parseVersion("garbage")).toBeNull();
  });

  it("returns true only when latest is strictly newer", () => {
    expect(isNewerVersion("1.2.3", "1.2.4")).toBe(true);
    expect(isNewerVersion("1.2.3", "1.3.0")).toBe(true);
    expect(isNewerVersion("1.2.3", "2.0.0")).toBe(true);
    expect(isNewerVersion("1.2.3", "1.2.3")).toBe(false);
    expect(isNewerVersion("1.2.3", "1.2.2")).toBe(false);
    expect(isNewerVersion("1.2.3", "not-a-version")).toBe(false);
  });
});

describe("UpdatesService", () => {
  let service: UpdatesService;
  let preferencesRepo: Record<string, jest.Mock>;
  let preferencesRow: UserPreferenceRepoMock;
  let configGet: jest.Mock;
  let originalFetch: typeof fetch;
  let fetchMock: jest.Mock;

  const buildRelease = (overrides: Partial<Record<string, unknown>> = {}) => ({
    tag_name: "v99.0.0",
    name: "Monize 99.0.0",
    html_url: "https://github.com/kenlasko/monize/releases/tag/v99.0.0",
    published_at: "2026-01-01T00:00:00Z",
    draft: false,
    prerelease: false,
    ...overrides,
  });

  const mockOkResponse = (body: unknown) =>
    ({
      ok: true,
      status: 200,
      json: async () => body,
    }) as unknown as Response;

  const mockErrorResponse = (status: number) =>
    ({
      ok: false,
      status,
      json: async () => ({}),
    }) as unknown as Response;

  beforeEach(async () => {
    // Behaves like the row: the dismiss path now materializes it with
    // `ON CONFLICT DO NOTHING` and patches one column, so a `save`-recording
    // mock could not tell that from overwriting the whole row.
    preferencesRow = createUserPreferenceRepoMock(null);
    preferencesRepo = preferencesRow.repo;
    configGet = jest.fn().mockReturnValue(undefined);

    const { dataSource } = createScopedDbMocks([
      [UserPreference, preferencesRepo],
    ]);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UpdatesService,
        {
          provide: DataSource,
          useValue: dataSource,
        },
        {
          provide: ConfigService,
          useValue: { get: configGet },
        },
      ],
    }).compile();

    service = module.get<UpdatesService>(UpdatesService);

    originalFetch = global.fetch;
    fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  describe("refreshLatestRelease", () => {
    it("populates cache with latest release data", async () => {
      fetchMock.mockResolvedValueOnce(mockOkResponse(buildRelease()));

      await service.refreshLatestRelease();
      preferencesRepo.findOne.mockResolvedValue(null);

      const status = await service.getStatus("user-1");
      expect(status.latestVersion).toBe("99.0.0");
      expect(status.releaseUrl).toBe(
        "https://github.com/kenlasko/monize/releases/tag/v99.0.0",
      );
      expect(status.releaseName).toBe("Monize 99.0.0");
      expect(status.updateAvailable).toBe(true);
      expect(status.error).toBeNull();
      expect(status.checkedAt).not.toBeNull();
    });

    it("reports updateAvailable=false when upstream is same or older", async () => {
      fetchMock.mockResolvedValueOnce(
        mockOkResponse(buildRelease({ tag_name: `v${currentVersion}` })),
      );

      await service.refreshLatestRelease();
      preferencesRepo.findOne.mockResolvedValue(null);

      const status = await service.getStatus("user-1");
      expect(status.updateAvailable).toBe(false);
      expect(status.dismissed).toBe(false);
    });

    it("ignores draft/prerelease entries but still records checkedAt", async () => {
      fetchMock.mockResolvedValueOnce(
        mockOkResponse(buildRelease({ prerelease: true })),
      );

      await service.refreshLatestRelease();
      preferencesRepo.findOne.mockResolvedValue(null);

      const status = await service.getStatus("user-1");
      expect(status.latestVersion).toBeNull();
      expect(status.updateAvailable).toBe(false);
      expect(status.checkedAt).not.toBeNull();
    });

    it("surfaces GitHub non-200 as error without throwing", async () => {
      fetchMock.mockResolvedValueOnce(mockErrorResponse(429));

      await service.refreshLatestRelease();
      preferencesRepo.findOne.mockResolvedValue(null);

      const status = await service.getStatus("user-1");
      expect(status.error).toBe("github_status_429");
      expect(status.updateAvailable).toBe(false);
    });

    it("surfaces network failures as error=unreachable", async () => {
      fetchMock.mockRejectedValueOnce(new Error("getaddrinfo ENOTFOUND"));

      await service.refreshLatestRelease();
      preferencesRepo.findOne.mockResolvedValue(null);

      const status = await service.getStatus("user-1");
      expect(status.error).toBe("unreachable");
      expect(status.updateAvailable).toBe(false);
    });

    it("handles non-Error throwables in the catch branch", async () => {
      fetchMock.mockRejectedValueOnce("string-thrown-value");

      await service.refreshLatestRelease();
      preferencesRepo.findOne.mockResolvedValue(null);

      const status = await service.getStatus("user-1");
      expect(status.error).toBe("unreachable");
    });

    it("falls back to tag_name when release.name is empty", async () => {
      fetchMock.mockResolvedValueOnce(
        mockOkResponse(buildRelease({ name: "" })),
      );

      await service.refreshLatestRelease();
      preferencesRepo.findOne.mockResolvedValue(null);

      const status = await service.getStatus("user-1");
      expect(status.releaseName).toBe("v99.0.0");
    });
  });

  describe("getStatus dismissal flag", () => {
    it("marks dismissed when preferences.dismissedUpdateVersion matches latest", async () => {
      fetchMock.mockResolvedValueOnce(mockOkResponse(buildRelease()));
      await service.refreshLatestRelease();

      preferencesRepo.findOne.mockResolvedValueOnce({
        userId: "user-1",
        dismissedUpdateVersion: "99.0.0",
      });

      const status = await service.getStatus("user-1");
      expect(status.updateAvailable).toBe(true);
      expect(status.dismissed).toBe(true);
    });

    it("does not mark dismissed when stored version is older than latest", async () => {
      fetchMock.mockResolvedValueOnce(mockOkResponse(buildRelease()));
      await service.refreshLatestRelease();

      preferencesRepo.findOne.mockResolvedValueOnce({
        userId: "user-1",
        dismissedUpdateVersion: "98.0.0",
      });

      const status = await service.getStatus("user-1");
      expect(status.updateAvailable).toBe(true);
      expect(status.dismissed).toBe(false);
    });
  });

  describe("dismiss", () => {
    it("saves latestVersion to user preferences when they exist", async () => {
      fetchMock.mockResolvedValueOnce(mockOkResponse(buildRelease()));
      await service.refreshLatestRelease();

      preferencesRow.seed({
        userId: "user-1",
        theme: "nord",
        dismissedUpdateVersion: null,
      });

      const result = await service.dismiss("user-1");
      expect(result).toEqual({ dismissed: true, version: "99.0.0" });
      expect(preferencesRow.row()!.dismissedUpdateVersion).toBe("99.0.0");
      // Only that column: dismissing an update banner must not drag any other
      // preference back to whatever this request happened to read.
      expect(Object.keys(preferencesRow.patches()[0])).toEqual([
        "dismissedUpdateVersion",
      ]);
      expect(preferencesRow.row()!.theme).toBe("nord");
    });

    it("creates preferences row if none exists", async () => {
      fetchMock.mockResolvedValueOnce(mockOkResponse(buildRelease()));
      await service.refreshLatestRelease();
      preferencesRow.seed(null);

      const result = await service.dismiss("user-1");
      expect(result).toEqual({ dismissed: true, version: "99.0.0" });
      expect(preferencesRow.insertAttempts()).toHaveLength(1);
      expect(preferencesRow.row()!.userId).toBe("user-1");
      expect(preferencesRow.row()!.dismissedUpdateVersion).toBe("99.0.0");
    });

    it("is a no-op when no latest release has been fetched", async () => {
      const result = await service.dismiss("user-1");
      expect(result).toEqual({ dismissed: false, version: null });
      expect(preferencesRow.patches()).toHaveLength(0);
      expect(preferencesRow.insertAttempts()).toHaveLength(0);
    });
  });

  describe("enabled lifecycle", () => {
    it("onModuleInit triggers an initial refresh in the background", async () => {
      fetchMock.mockResolvedValueOnce(mockOkResponse(buildRelease()));

      service.onModuleInit();

      // onModuleInit is fire-and-forget; wait a tick for the microtask queue
      // so the kicked-off refresh can complete.
      await new Promise((resolve) => setImmediate(resolve));

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenCalledWith(
        "https://api.github.com/repos/kenlasko/monize/releases/latest",
        expect.objectContaining({
          headers: expect.objectContaining({
            "User-Agent": "Monize-UpdateCheck",
          }),
        }),
      );
    });

    it("scheduledRefresh hits GitHub when enabled", async () => {
      fetchMock.mockResolvedValueOnce(mockOkResponse(buildRelease()));

      await service.scheduledRefresh();

      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  describe("disabled via UPDATE_CHECK_ENABLED=false", () => {
    it("skips onModuleInit refresh and returns disabled status", async () => {
      configGet.mockReturnValueOnce("false");

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          UpdatesService,
          {
            provide: DataSource,
            useValue: createScopedDbMocks([[UserPreference, preferencesRepo]])
              .dataSource,
          },
          {
            provide: ConfigService,
            useValue: { get: configGet },
          },
        ],
      }).compile();

      const disabledService = module.get<UpdatesService>(UpdatesService);
      disabledService.onModuleInit();

      expect(fetchMock).not.toHaveBeenCalled();

      const status = await disabledService.getStatus("user-1");
      expect(status.disabled).toBe(true);
      expect(status.updateAvailable).toBe(false);
      expect(status.latestVersion).toBeNull();
    });

    it("scheduledRefresh is a no-op when disabled", async () => {
      configGet.mockReturnValueOnce("false");

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          UpdatesService,
          {
            provide: DataSource,
            useValue: createScopedDbMocks([[UserPreference, preferencesRepo]])
              .dataSource,
          },
          {
            provide: ConfigService,
            useValue: { get: configGet },
          },
        ],
      }).compile();

      const disabledService = module.get<UpdatesService>(UpdatesService);
      await disabledService.scheduledRefresh();

      expect(fetchMock).not.toHaveBeenCalled();
    });
  });
});
