import { DataSource, EntityManager, Repository } from "typeorm";
import { UserPreference } from "../users/entities/user-preference.entity";
import { DemoModeService } from "../common/demo-mode.service";
import { ReleaseNotesService } from "./release-notes.service";
import { ReleaseNotes } from "./release-notes.parser";
import { WhatsNewService } from "./whats-new.service";
import { withScopedDb } from "../common/db/scoped-db";
import {
  createUserPreferenceRepoMock,
  type UserPreferenceRepoMock,
} from "../test-helpers/user-preference-testing";

// Unit-test the service against a mocked withScopedDb (its own behaviour -- context
// requirement, GUCs, re-entrancy -- is covered by scoped-db.spec.ts). The mock
// simply runs the callback with a manager whose repository is our mock repo.
jest.mock("../common/db/scoped-db");
const mockedTenantTx = withScopedDb as jest.MockedFunction<typeof withScopedDb>;

const CURRENT_VERSION = "1.12.1";

const SAMPLE_NOTES: ReleaseNotes = {
  version: CURRENT_VERSION,
  intro: "Intro.",
  sections: [{ heading: "Feature", body: "Body.", children: [] }],
  releaseUrl: `https://github.com/kenlasko/monize/releases/tag/v${CURRENT_VERSION}`,
};

describe("WhatsNewService", () => {
  let prefsMock: UserPreferenceRepoMock;
  let repo: jest.Mocked<Pick<Repository<UserPreference>, "findOne" | "save">>;
  let releaseNotes: jest.Mocked<
    Pick<ReleaseNotesService, "getForCurrentVersion" | "currentVersion">
  >;
  let demoMode: { isDemo: boolean };
  let service: WhatsNewService;

  beforeEach(() => {
    // Behaves like the row: the writers now insert-if-absent and patch one
    // column, so a mock that only records `save` could not tell that apart from
    // the whole-entity overwrite it replaced.
    prefsMock = createUserPreferenceRepoMock(null);
    repo = prefsMock.repo as unknown as jest.Mocked<
      Pick<Repository<UserPreference>, "findOne" | "save">
    >;

    const manager = {
      getRepository: jest.fn(() => repo),
    } as unknown as EntityManager;

    // Run the withScopedDb callback immediately with our mock manager.
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

    it("does not auto-show on a first login (no preferences row yet)", async () => {
      repo.findOne.mockResolvedValue(null);

      const status = await service.getWhatsNew("user-1");

      expect(status.autoShow).toBe(false);
      // The notes still come back so the version label can open the modal.
      expect(status.notes).toBe(SAMPLE_NOTES);
    });

    it("auto-shows for a legacy row that predates the digest columns", async () => {
      repo.findOne.mockResolvedValue(
        prefs({
          showWhatsNew: null as unknown as boolean,
          lastSeenVersion: null,
        }),
      );

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
      prefsMock.seed({
        ...prefs({ lastSeenVersion: "1.11.0" }),
        theme: "nord",
      });

      const result = await service.markSeen("user-1");

      expect(prefsMock.row()!.lastSeenVersion).toBe(CURRENT_VERSION);
      expect(result).toEqual({ seen: true, version: CURRENT_VERSION });
      // Only that column: acknowledging a digest must not carry any other
      // preference back to whatever this request happened to read.
      expect(Object.keys(prefsMock.patches()[0])).toEqual(["lastSeenVersion"]);
      expect(prefsMock.row()!.theme).toBe("nord");
    });

    it("materializes a preferences row when none exists", async () => {
      prefsMock.seed(null);

      const result = await service.markSeen("user-1");

      // `ON CONFLICT DO NOTHING`, not read-then-insert: the first page load fires
      // several requests at once, and two of them both finding no row used to
      // mean one failed on a unique violation.
      expect(prefsMock.insertAttempts()).toHaveLength(1);
      expect(prefsMock.row()!.userId).toBe("user-1");
      expect(prefsMock.row()!.lastSeenVersion).toBe(CURRENT_VERSION);
      expect(result.seen).toBe(true);
    });
  });

  describe("remindNextLogin", () => {
    it("clears an existing acknowledgement so the digest shows again", async () => {
      prefsMock.seed(prefs({ lastSeenVersion: CURRENT_VERSION }));

      const result = await service.remindNextLogin("user-1");

      expect(prefsMock.row()!.lastSeenVersion).toBeNull();
      expect(result).toEqual({ reminded: true });
    });

    it("clears unconditionally rather than reading first", async () => {
      // Writing NULL over NULL is a no-op the database settles far more cheaply
      // than a read-compare-write can -- and the read-compare-write was the thing
      // that could revert a concurrent change to another column.
      prefsMock.seed(prefs({ lastSeenVersion: null }));

      const result = await service.remindNextLogin("user-1");

      expect(prefsMock.row()!.lastSeenVersion).toBeNull();
      expect(Object.keys(prefsMock.patches()[0])).toEqual(["lastSeenVersion"]);
      expect(result.reminded).toBe(true);
    });

    it("materializes an unacknowledged row when none exists", async () => {
      prefsMock.seed(null);

      const result = await service.remindNextLogin("user-1");

      expect(prefsMock.insertAttempts()).toHaveLength(1);
      const saved = prefsMock.row()!;
      expect(saved.userId).toBe("user-1");
      // Defaults stamp the running version; the reminder has to clear it, or the
      // digest the user just asked for would be suppressed as a first login.
      expect(saved.lastSeenVersion).toBeNull();
      expect(result.reminded).toBe(true);
    });

    it("re-enables auto-show after an acknowledgement was cleared", async () => {
      // Acknowledged -> would not auto-show...
      prefsMock.seed(prefs({ lastSeenVersion: CURRENT_VERSION }));
      expect((await service.getWhatsNew("user-1")).autoShow).toBe(false);

      // ...clearing it brings the popup back on the next status check.
      prefsMock.seed(prefs({ lastSeenVersion: null }));
      expect((await service.getWhatsNew("user-1")).autoShow).toBe(true);
    });
  });
});
