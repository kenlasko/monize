import { DataSource, EntityManager } from "typeorm";
import { withScopedDb } from "../common/db/scoped-db";
import { requireSharedGroup, sharedParticipants } from "./shared-db";
import { SharedPeopleService } from "./shared-people.service";
import { readSharedJournal } from "./shared-journal";
import { sharedEntryFixture } from "./__fixtures__/shared-entry";
jest.mock("../common/db/scoped-db", () => ({ withScopedDb: jest.fn() }));
jest.mock("./shared-db", () => ({
  ...jest.requireActual("./shared-db"),
  requireSharedGroup: jest.fn(),
  sharedParticipants: jest.fn(),
}));
jest.mock("./shared-journal", () => ({
  ...jest.requireActual("./shared-journal"),
  readSharedJournal: jest.fn(),
}));
describe("Private people and their independent group positions", () => {
  let service: SharedPeopleService;
  let query: jest.Mock;
  beforeEach(() => {
    query = jest.fn().mockResolvedValue([]);
    jest
      .mocked(withScopedDb)
      .mockImplementation(async (_db, body) =>
        body({ query } as unknown as EntityManager),
      );
    jest.mocked(sharedParticipants).mockResolvedValue([
      {
        id: "anna",
        name: "Anna",
        isActive: true,
        connected: false,
        role: null,
      },
      { id: "me", name: "Me", isActive: true, connected: true, role: "OWNER" },
    ]);
    jest.mocked(readSharedJournal).mockResolvedValue([sharedEntryFixture()]);
    service = new SharedPeopleService({} as DataSource);
  });
  it("keeps positions grouped by currency and never nets separate groups", async () => {
    query
      .mockResolvedValueOnce([
        { id: "contact", name: "My Anna", payeeId: null },
      ])
      .mockResolvedValueOnce([
        {
          personId: "contact",
          groupId: "group",
          participantId: "anna",
          groupName: "Trip",
          currencyCode: "PLN",
        },
        {
          personId: "contact",
          groupId: "other",
          participantId: "anna",
          groupName: "House",
          currencyCode: "EUR",
        },
      ]);
    const result = await service.list("owner");
    expect(result[0].groups).toEqual([
      expect.objectContaining({
        groupId: "group",
        currencyCode: "PLN",
        position: expect.objectContaining({ balance: "-200.0000" }),
      }),
      expect.objectContaining({
        groupId: "other",
        currencyCode: "EUR",
        position: expect.objectContaining({ balance: "-200.0000" }),
      }),
    ]);
    expect(result[0]).not.toHaveProperty("total");
  });
  it("refuses an empty name or someone else's payee before writing", async () => {
    await expect(service.save("owner", { name: " " })).rejects.toThrow(
      "participants",
    );
    expect(query).not.toHaveBeenCalled();
    await expect(
      service.save("owner", { name: "Anna", payeeId: "foreign" }),
    ).rejects.toThrow("own finances");
    expect(query.mock.calls.every(([sql]) => sql.startsWith("SELECT"))).toBe(
      true,
    );
  });
  it("creates a private person and verifies a payee belongs to the caller", async () => {
    query.mockResolvedValueOnce([{ id: "payee" }]);
    const result = await service.save("owner", {
      name: " Anna ",
      payeeId: "payee",
    });
    expect(result.id).toEqual(expect.any(String));
    expect(query.mock.calls[1][1]).toEqual([
      result.id,
      "owner",
      "Anna",
      "payee",
    ]);
  });
  it("only edits a person after the owned row has been locked", async () => {
    await expect(
      service.save("owner", { name: "Anna" }, "foreign"),
    ).rejects.toThrow("unavailable");
    query.mockClear().mockResolvedValueOnce([{ id: "person" }]);
    await service.save("owner", { name: "Anna" }, "person");
    expect(query.mock.calls[0][0]).toContain("FOR UPDATE");
    expect(query.mock.calls[1][1]).toEqual(["person", "owner", "Anna", null]);
  });
  it("refuses linking one private person to two participants in the same group", async () => {
    query
      .mockResolvedValueOnce([{ id: "person" }])
      .mockResolvedValueOnce([{ participant_id: "me" }]);
    await expect(
      service.link("owner", "group", {
        personId: "person",
        participantId: "anna",
      }),
    ).rejects.toThrow("already belong");
    expect(query.mock.calls.every(([sql]) => sql.startsWith("SELECT"))).toBe(
      true,
    );
  });
  it("requires an owned contact and a group participant before linking", async () => {
    await expect(
      service.link("owner", "group", {
        personId: "foreign",
        participantId: "anna",
      }),
    ).rejects.toThrow("participants");
    query.mockResolvedValueOnce([{ id: "person" }]);
    await expect(
      service.link("owner", "group", {
        personId: "person",
        participantId: "foreign",
      }),
    ).rejects.toThrow("participants");
    query.mockResolvedValueOnce([{ id: "person" }]);
    await service.link("owner", "group", {
      personId: "person",
      participantId: "anna",
    });
    expect(requireSharedGroup).toHaveBeenCalled();
    expect(query.mock.calls[query.mock.calls.length - 1][1]).toEqual([
      "owner",
      "person",
      "group",
      "anna",
    ]);
  });
  it("removes only the private contact, leaving the group's people and journal intact", async () => {
    await service.remove("owner", "person");
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][0]).toContain("DELETE FROM shared_people");
    expect(query.mock.calls[0][1]).toEqual(["person", "owner"]);
  });
});
