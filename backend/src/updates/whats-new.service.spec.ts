import { DataSource, EntityManager, Repository } from "typeorm";
import { UserPreference } from "../users/entities/user-preference.entity";
import { DemoModeService } from "../common/demo-mode.service";
import { ReleaseNotesService } from "./release-notes.service";
import { ReleaseNotes } from "./release-notes.parser";
import { WhatsNewService } from "./whats-new.service";
import { tenantTx } from "../common/db/tenant-tx";

// Unit-test the service against a mocked tenantTx (its own behaviour -- context
// requirement, GUCs, re-entrancy -- is covered by tenant-tx.spec.ts). The mock
// simply runs the callback with a manager whose repository is our mock repo.
jest.mock("../common/db/tenant-tx");
const mockedTenantTx = tenantTx as jest.MockedFunction<typeof tenantTx>;

const CURRENT_VERSION = "1.12.1";

const SAMPLE_NOTES: ReleaseNotes = {
  version: CURRENT_VERSION,
  intro: "Intro.",
  sections: [{ heading: "Feature", body: "Body.", children: [] }],
  releaseUrl: `https://github.com/kenlasko/monize/releases/tag/v${CURRENT_VERSION}`,
};

describe("WhatsNewService", () => {
  let repo: jest.Mocked<Pick<Repository<UserPreference>, "findOne" | "save">>;
  let releaseNotes: jest.Mocked<
    Pick<ReleaseNotesService, "getForCurrentVersion" | "currentVersion">
  >;
  let demoMode: { isDemo: boolean };
  let service: WhatsNewService;

  beforeEach(() => {
    repo = {
      findOne: jest.fn(),
      save: jest.fn((entity) => Promise.resolve(entity)),
    } as unknown as jest.Mocked<
      Pick<Repository<UserPreference>, "findOne" | "save">
    >;

    const manager = {
      getRepository: jest.fn(() => repo),
    } as unknown as EntityManager;

    // Run the tenantTx callback immediately with our mock manager.
    mockedTenantTx.mockImplementation((_dataSource, fn) => fn(manager));

    releaseNotes = {
      getForCurrentVersion: jest.fn().mockReturnValue(SAMPLE_NOTES),
      currentVersion: CURRENT_VERSION,
    } as unknown as jest.Mocked<
      Pick<ReleaseNotesService, "getForCurrentVersion" | "currentVersion">
    >;
    demoMode = { isDemo: false };

    service = new WhatsNewService(
      {} as DataSource,
      releaseNotes as unknown as ReleaseNotesService,
      demoMode as DemoModeService,
    );
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  function prefs(overrides: Partial<UserPreference> = {}): UserPreference {
    return {
      userId: "user-1",
      showWhatsNew: true,
      lastSeenVersion: null,
      ...overrides,
    } as UserPreference;
  }

  describe("getWhatsNew", () => {
    it("auto-shows for a user who has not seen the current version", async () => {
      repo.findOne.mockResolvedValue(prefs({ lastSeenVersion: "1.11.0" }));

      const status = await service.getWhatsNew("user-1");

      expect(status.currentVersion).toBe(CURRENT_VERSION);
      expect(status.notes).toBe(SAMPLE_NOTES);
      expect(status.autoShow).toBe(true);
      expect(mockedTenantTx).toHaveBeenCalledTimes(1);
    });

    it("auto-shows when the user has no preferences row yet", async () => {
      repo.findOne.mockResolvedValue(null);

      const status = await service.getWhatsNew("user-1");

      expect(status.autoShow).toBe(true);
    });

    it("does not auto-show once the current version has been acknowledged", async () => {
      repo.findOne.mockResolvedValue(
        prefs({ lastSeenVersion: CURRENT_VERSION }),
      );

      const status = await service.getWhatsNew("user-1");

      expect(status.autoShow).toBe(false);
      // Notes are still returned so the modal can open manually.
      expect(status.notes).toBe(SAMPLE_NOTES);
    });

    it("does not auto-show when the user disabled the popup", async () => {
      repo.findOne.mockResolvedValue(prefs({ showWhatsNew: false }));

      const status = await service.getWhatsNew("user-1");

      expect(status.autoShow).toBe(false);
    });

    it("does not auto-show in a demo instance", async () => {
      demoMode.isDemo = true;
      repo.findOne.mockResolvedValue(prefs());

      const status = await service.getWhatsNew("user-1");

      expect(status.autoShow).toBe(false);
    });

    it("does not auto-show when no notes exist for the version", async () => {
      releaseNotes.getForCurrentVersion.mockReturnValue(null);
      repo.findOne.mockResolvedValue(prefs());

      const status = await service.getWhatsNew("user-1");

      expect(status.notes).toBeNull();
      expect(status.autoShow).toBe(false);
    });
  });

  describe("markSeen", () => {
    it("stores the current version on an existing preferences row", async () => {
      const existing = prefs({ lastSeenVersion: "1.11.0" });
      repo.findOne.mockResolvedValue(existing);

      const result = await service.markSeen("user-1");

      expect(existing.lastSeenVersion).toBe(CURRENT_VERSION);
      expect(repo.save).toHaveBeenCalledWith(existing);
      expect(result).toEqual({ seen: true, version: CURRENT_VERSION });
    });

    it("materializes a preferences row when none exists", async () => {
      repo.findOne.mockResolvedValue(null);

      const result = await service.markSeen("user-1");

      expect(repo.save).toHaveBeenCalledTimes(1);
      const saved = repo.save.mock.calls[0][0] as UserPreference;
      expect(saved.userId).toBe("user-1");
      expect(saved.lastSeenVersion).toBe(CURRENT_VERSION);
      expect(result.seen).toBe(true);
    });
  });

  describe("remindNextLogin", () => {
    it("clears an existing acknowledgement so the digest shows again", async () => {
      const existing = prefs({ lastSeenVersion: CURRENT_VERSION });
      repo.findOne.mockResolvedValue(existing);

      const result = await service.remindNextLogin("user-1");

      expect(existing.lastSeenVersion).toBeNull();
      expect(repo.save).toHaveBeenCalledWith(existing);
      expect(result).toEqual({ reminded: true });
    });

    it("does not write when there is nothing to clear", async () => {
      repo.findOne.mockResolvedValue(prefs({ lastSeenVersion: null }));

      const result = await service.remindNextLogin("user-1");

      expect(repo.save).not.toHaveBeenCalled();
      expect(result.reminded).toBe(true);
    });

    it("is a no-op (still succeeds) when no preferences row exists", async () => {
      repo.findOne.mockResolvedValue(null);

      const result = await service.remindNextLogin("user-1");

      expect(repo.save).not.toHaveBeenCalled();
      expect(result.reminded).toBe(true);
    });

    it("re-enables auto-show after an acknowledgement was cleared", async () => {
      // Acknowledged -> would not auto-show...
      repo.findOne.mockResolvedValue(
        prefs({ lastSeenVersion: CURRENT_VERSION }),
      );
      expect((await service.getWhatsNew("user-1")).autoShow).toBe(false);

      // ...clearing it brings the popup back on the next status check.
      const cleared = prefs({ lastSeenVersion: null });
      repo.findOne.mockResolvedValue(cleared);
      expect((await service.getWhatsNew("user-1")).autoShow).toBe(true);
    });
  });
});
