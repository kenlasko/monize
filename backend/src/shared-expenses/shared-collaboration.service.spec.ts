import { DataSource, EntityManager } from "typeorm";
import { withScopedDb } from "../common/db/scoped-db";
import { SharedCollaborationService } from "./shared-collaboration.service";
import {
  lockSharedGroup,
  requireSharedGroup,
  sharedParticipants,
  sharedActivity,
} from "./shared-db";
import { readSharedJournal } from "./shared-journal";
import { sharedEntryFixture } from "./__fixtures__/shared-entry";
import {
  sharedGroupFixture,
  sharedPeopleFixture,
} from "./__fixtures__/shared-group";

jest.mock("../common/db/scoped-db", () => ({ withScopedDb: jest.fn() }));
jest.mock("./shared-db", () => ({
  ...jest.requireActual("./shared-db"),
  requireSharedGroup: jest.fn(),
  sharedParticipants: jest.fn(),
  sharedActivity: jest.fn(),
  lockSharedGroup: jest.fn(),
  sharedCommand: jest.fn((_m, _u, _g, _id, _dto, work) => work()),
}));
jest.mock("./shared-journal", () => ({
  ...jest.requireActual("./shared-journal"),
  readSharedJournal: jest.fn(),
}));

describe("Shared activity and reminder decisions", () => {
  let query: jest.Mock;
  let service: SharedCollaborationService;
  const command = { operationId: "operation", expectedRevision: 2 };
  beforeEach(() => {
    jest.clearAllMocks();
    query = jest.fn().mockResolvedValue([]);
    jest
      .mocked(withScopedDb)
      .mockImplementation((_s, work) =>
        work({ query } as unknown as EntityManager),
      );
    jest.mocked(requireSharedGroup).mockResolvedValue(sharedGroupFixture());
    jest.mocked(sharedParticipants).mockResolvedValue(sharedPeopleFixture());
    jest.mocked(readSharedJournal).mockResolvedValue([sharedEntryFixture()]);
    service = new SharedCollaborationService({} as DataSource);
  });
  it.each([0, 100, 101])(
    "paginates %i activity rows without dropping the boundary row",
    async (count) => {
      query.mockResolvedValue(
        Array.from({ length: count }, (_, i) => ({ id: String(i) })),
      );
      const result = await service.activity("owner", "group", 100);
      expect(result.items).toHaveLength(Math.min(100, count));
      expect(result.nextOffset).toBe(count > 100 ? 200 : null);
      expect(requireSharedGroup).toHaveBeenCalledWith(
        expect.anything(),
        "owner",
        "group",
      );
    },
  );
  it("records a reminder for a debtor, containing no private bank information", async () => {
    expect(await service.remind("owner", "group", "anna", command)).toEqual({
      id: "anna",
    });
    expect(lockSharedGroup).toHaveBeenCalledWith(expect.anything(), "group");
    expect(sharedActivity).toHaveBeenCalledWith(
      expect.anything(),
      "owner",
      "group",
      "REMINDER_SENT",
      { participantId: "anna" },
    );
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("INTERVAL '1 day'"),
      ["group", "anna"],
    );
  });
  it("rejects a stale financial revision before reading debt or sending a reminder", async () => {
    await expect(
      service.remind("owner", "group", "anna", {
        ...command,
        expectedRevision: 1,
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(readSharedJournal).not.toHaveBeenCalled();
    expect(sharedActivity).not.toHaveBeenCalled();
  });
  it.each(["me", "missing"])(
    "refuses recipient %s before writing activity",
    async (recipient) => {
      await expect(
        service.remind("owner", "group", recipient, command),
      ).rejects.toThrow();
      expect(sharedActivity).not.toHaveBeenCalled();
    },
  );
  it.each(["offline", "detached"])(
    "refuses a %s recipient context",
    async (kind) => {
      if (kind === "offline")
        jest
          .mocked(sharedParticipants)
          .mockResolvedValue(
            sharedPeopleFixture().map((p) => ({ ...p, connected: false })),
          );
      else
        jest
          .mocked(requireSharedGroup)
          .mockResolvedValue(sharedGroupFixture({ isDetachedCopy: true }));
      await expect(
        service.remind("owner", "group", "anna", command),
      ).rejects.toThrow();
      expect(sharedActivity).not.toHaveBeenCalled();
    },
  );
  it("withholds reminders when a missing exchange rate makes debt unknown", async () => {
    jest.mocked(readSharedJournal).mockResolvedValue([
      sharedEntryFixture({
        state: "DRAFT",
        draftReason: "MISSING_RATE",
        groupAmount: null,
        fxRate: null,
        allocations: sharedEntryFixture().allocations.map((row) => ({
          ...row,
          groupAmount: null,
        })),
      }),
    ]);
    await expect(
      service.remind("owner", "group", "anna", command),
    ).rejects.toThrow();
    expect(sharedActivity).not.toHaveBeenCalled();
  });
  it("does not remind a participant who owes zero", async () => {
    jest.mocked(readSharedJournal).mockResolvedValue([]);
    await expect(
      service.remind("owner", "group", "anna", command),
    ).rejects.toThrow();
    expect(sharedActivity).not.toHaveBeenCalled();
  });
  it("keeps the 24-hour throttle even when a different command is submitted", async () => {
    query.mockResolvedValue([{ id: "earlier-reminder" }]);
    await expect(
      service.remind("owner", "group", "anna", command),
    ).rejects.toThrow();
    expect(sharedActivity).not.toHaveBeenCalled();
  });
});
