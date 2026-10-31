import { DataSource, EntityManager } from "typeorm";
import { withScopedDb } from "../common/db/scoped-db";
import { SharedGroupsService } from "./shared-groups.service";
import {
  requireSharedGroup,
  sharedParticipants,
  currencyPlaces,
  sharedActivity,
} from "./shared-db";
import { readSharedJournal } from "./shared-journal";
import { sharedEntryFixture } from "./__fixtures__/shared-entry";
import { SharedGroup, SharedParticipant } from "./shared-types";

jest.mock("../common/db/scoped-db", () => ({ withScopedDb: jest.fn() }));
jest.mock("./shared-db", () => ({
  ...jest.requireActual("./shared-db"),
  requireSharedGroup: jest.fn(),
  sharedParticipants: jest.fn(),
  currencyPlaces: jest.fn(),
  sharedActivity: jest.fn(),
  lockSharedGroup: jest.fn(),
  advanceSharedRevision: jest.fn(),
  sharedCommand: jest.fn((_m, _user, _group, _operation, _dto, execute) =>
    execute(),
  ),
}));
jest.mock("./shared-journal", () => ({
  ...jest.requireActual("./shared-journal"),
  readSharedJournal: jest.fn(),
}));
const group: SharedGroup = {
  id: "group",
  ownerUserId: "owner",
  name: "Weekend",
  description: null,
  currencyCode: "PLN",
  decimalPlaces: 2,
  revision: 4,
  financialRevision: 2,
  archivedAt: null,
  role: "OWNER",
  myParticipantId: "me",
};
const people: SharedParticipant[] = [
  { id: "me", name: "Me", isActive: true, connected: true, role: "OWNER" },
  { id: "anna", name: "Anna", isActive: true, connected: false, role: null },
];
const command = { operationId: "operation", expectedRevision: 4 };

describe("Shared groups and private contact boundaries", () => {
  let query: jest.Mock;
  let service: SharedGroupsService;
  beforeEach(() => {
    jest.clearAllMocks();
    query = jest.fn().mockResolvedValue([]);
    const manager = { query } as unknown as EntityManager;
    jest
      .mocked(withScopedDb)
      .mockImplementation(async (_source, work) => work(manager));
    jest.mocked(requireSharedGroup).mockResolvedValue({ ...group });
    jest.mocked(sharedParticipants).mockResolvedValue(people);
    jest.mocked(currencyPlaces).mockResolvedValue(2);
    jest.mocked(readSharedJournal).mockResolvedValue([sharedEntryFixture()]);
    service = new SharedGroupsService({} as DataSource);
  });
  const writes = (query: jest.Mock) =>
    query.mock.calls.filter(([sql]) => /^(INSERT|UPDATE|DELETE)/.test(sql));
  it("returns a consistent per-currency overview without disclosing owner IDs", async () => {
    query.mockResolvedValue([{ id: "group" }]);
    const result = await service.overview("owner");
    expect(result.groups[0]).toMatchObject({
      participantCount: 2,
      myPosition: { balance: "200.0000" },
    });
    expect(result.groups[0]).not.toHaveProperty("ownerUserId");
    expect(withScopedDb).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(Function),
      "REPEATABLE READ",
    );
    expect(result.totals).toEqual([
      expect.objectContaining({
        currencyCode: "PLN",
        receivable: "200.0000",
        payable: "0.0000",
      }),
    ]);
  });
  it("filters the timeline without changing balances or losing missing-rate repairs", async () => {
    jest.mocked(readSharedJournal).mockResolvedValue([
      sharedEntryFixture(),
      sharedEntryFixture({
        id: "missing",
        title: "Train",
        state: "DRAFT",
        draftReason: "MISSING_RATE",
        groupAmount: null,
        currencyCode: "EUR",
      }),
    ]);
    const result = await service.detail("owner", "group", 0, {
      search: "DINNER",
      type: "EXPENSE",
      startDate: "2026-01-01",
      endDate: "2026-01-31",
      participantId: "anna",
    });
    expect(result.entries.map((entry) => entry.id)).toEqual(["entry"]);
    expect(result.entryCount).toBe(1);
    expect(result.nextOffset).toBeNull();
    expect(result.unresolvedEntries).toEqual([
      expect.objectContaining({ id: "missing", currencyCode: "EUR" }),
    ]);
    expect(result.balances.settlementReady).toBe(false);
  });
  it("exports the whole journal while the timeline paginates", async () => {
    jest
      .mocked(readSharedJournal)
      .mockResolvedValue(
        Array.from({ length: 101 }, (_, i) =>
          sharedEntryFixture({ id: `entry-${i}` }),
        ),
      );
    expect((await service.detail("owner", "group")).nextOffset).toBe(100);
    expect((await service.detail("owner", "group", 100)).entries).toHaveLength(
      1,
    );
    const exported = await service.export("owner", "group");
    expect(exported.entries).toHaveLength(101);
    expect(exported.group).not.toHaveProperty("ownerUserId");
  });
  it("rejects a foreign contact before creating a group or participant", async () => {
    await expect(
      service.create("owner", {
        ...command,
        name: "Trip",
        myName: "Me",
        currencyCode: "PLN",
        participants: [{ name: "Anna", personId: "foreign" }],
      }),
    ).rejects.toThrow("participants");
    expect(writes(query)).toEqual([]);
    await expect(
      service.participant("owner", "group", undefined, {
        ...command,
        name: "Anna",
        personId: "foreign",
      }),
    ).rejects.toThrow("participants");
    expect(writes(query)).toEqual([]);
  });
  it("checks and locks private contacts before inserting, trimming names and reusing identities", async () => {
    query.mockImplementation(async (sql: string) =>
      sql.includes("FROM shared_people") ? [{ id: "contact" }] : [],
    );
    await service.create("owner", {
      ...command,
      name: " Trip ",
      myName: " Me ",
      currencyCode: "PLN",
      participants: [{ name: " Anna ", personId: "contact" }],
    });
    const contactRead = query.mock.calls.findIndex(([sql]) =>
      sql.includes("FROM shared_people"),
    );
    const insert = query.mock.calls.findIndex(([sql]) =>
      sql.startsWith("INSERT"),
    );
    expect(contactRead).toBeLessThan(insert);
    expect(query.mock.calls[contactRead]).toEqual([
      expect.stringContaining("FOR KEY SHARE"),
      [["contact"], "owner"],
    ]);
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO shared_groups"),
      ["operation", "owner", "Trip", null, "PLN"],
    );
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO shared_person_links"),
      ["owner", "contact", "operation", expect.any(String)],
    );
  });
  it.each([
    ["occupied", true],
    ["empty", false],
  ])(
    "deletes only an %s group after checking revision",
    async (_label, present) => {
      query.mockResolvedValue([{ present }]);
      if (present) {
        await expect(
          service.removeEmpty("owner", "group", command),
        ).rejects.toThrow("empty group");
        expect(writes(query)).toEqual([]);
      } else {
        await expect(
          service.removeEmpty("owner", "group", command),
        ).resolves.toEqual({ id: "group" });
        expect(query).toHaveBeenCalledWith(
          expect.stringContaining("DELETE FROM shared_groups"),
          ["group", "owner"],
        );
      }
    },
  );
  it("rejects stale settings and fixed-currency changes before any update", async () => {
    await expect(
      service.update("owner", "group", {
        ...command,
        expectedRevision: 3,
        name: "New",
      }),
    ).rejects.toThrow("changed while");
    expect(writes(query)).toEqual([]);
    query.mockResolvedValue([{ id: "entry" }]);
    await expect(
      service.update("owner", "group", { ...command, currencyCode: "EUR" }),
    ).rejects.toThrow("currency is fixed");
    expect(writes(query)).toEqual([]);
  });
  it.each([true, false, undefined])(
    "changes archive state %s with the matching activity",
    async (archived) => {
      await expect(
        service.update("owner", "group", {
          ...command,
          name: " New ",
          archived,
        }),
      ).resolves.toEqual({ id: "group", revision: 5 });
      expect(query).toHaveBeenCalledWith(
        expect.stringContaining("UPDATE shared_groups"),
        ["group", "New", null, "PLN", archived ?? null, "null"],
      );
      expect(sharedActivity).toHaveBeenCalledWith(
        expect.anything(),
        "owner",
        "group",
        archived === true
          ? "GROUP_ARCHIVED"
          : archived === false
            ? "GROUP_RESTORED"
            : "GROUP_UPDATED",
      );
    },
  );
  it("refuses a template referencing an inactive person and accepts a complete weighted template", async () => {
    await expect(
      service.update("owner", "group", {
        ...command,
        splitTemplate: {
          mode: "WEIGHT",
          shares: [{ participantId: "other", value: "1" }],
        },
      }),
    ).rejects.toThrow("participants");
    expect(writes(query)).toEqual([]);
    const splitTemplate = {
      mode: "WEIGHT" as const,
      shares: [
        { participantId: "me", value: "2" },
        { participantId: "anna", value: "1" },
      ],
    };
    await service.update("owner", "group", { ...command, splitTemplate });
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("UPDATE shared_groups"),
      expect.arrayContaining([JSON.stringify(splitTemplate)]),
    );
  });
  it("keeps claimed people active and caps additions without changing existing people", async () => {
    await expect(
      service.participant("owner", "group", "me", {
        ...command,
        name: "Me",
        isActive: false,
      }),
    ).rejects.toThrow("already belong");
    jest.mocked(sharedParticipants).mockResolvedValue(
      Array.from({ length: 50 }, (_, i) => ({
        ...people[1],
        id: `person-${i}`,
      })),
    );
    await expect(
      service.participant("owner", "group", undefined, {
        ...command,
        name: "New",
      }),
    ).rejects.toThrow("50");
    expect(writes(query)).toEqual([]);
    await service.participant("owner", "group", "person-1", {
      ...command,
      name: " Renamed ",
      isActive: false,
    });
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("UPDATE shared_participants"),
      ["person-1", "group", "Renamed", false],
    );
  });
});
