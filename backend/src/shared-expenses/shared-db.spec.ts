import { EntityManager } from "typeorm";
import { getRequestContext } from "../common/request-context";
import {
  assertSharedPrincipal,
  currencyPlaces,
  requireRevision,
  requireSharedGroup,
  sharedCommand,
  sharedFingerprint,
} from "./shared-db";

jest.mock("../common/request-context", () => ({
  getRequestContext: jest.fn(),
}));
describe("Shared command and access boundary", () => {
  let query: jest.Mock;
  let manager: EntityManager;
  beforeEach(() => {
    query = jest.fn().mockResolvedValue([]);
    manager = { query } as unknown as EntityManager;
    jest.mocked(getRequestContext).mockReturnValue(undefined);
  });
  it("refuses delegated access before querying a group", async () => {
    jest.mocked(getRequestContext).mockReturnValue({
      realUserId: "delegate",
      effectiveUserId: "owner",
    } as never);
    expect(() => assertSharedPrincipal("owner")).toThrow("permission");
    await expect(requireSharedGroup(manager, "owner", "group")).rejects.toThrow(
      "permission",
    );
    expect(query).not.toHaveBeenCalled();
  });
  it("does not distinguish an unknown group from a private one", async () => {
    await expect(requireSharedGroup(manager, "owner", "group")).rejects.toThrow(
      "unavailable",
    );
    expect(query.mock.calls[0][1]).toEqual(["group", "owner"]);
  });
  it.each([
    ["OWNER", "READ", true],
    ["OWNER", "WRITE", true],
    ["OWNER", "OWNER", true],
    ["EDITOR", "READ", true],
    ["EDITOR", "WRITE", true],
    ["EDITOR", "OWNER", false],
    ["VIEWER", "READ", true],
    ["VIEWER", "WRITE", false],
    ["VIEWER", "OWNER", false],
  ] as const)("enforces %s permission on %s", async (role, access, allowed) => {
    query.mockResolvedValue([{ id: "group", role, archivedAt: null }]);
    const result = requireSharedGroup(manager, "owner", "group", access);
    if (allowed) await expect(result).resolves.toMatchObject({ role });
    else await expect(result).rejects.toThrow("permission");
  });
  it("keeps archived reads available and only permits an explicit lifecycle write", async () => {
    query.mockResolvedValue([
      { id: "group", role: "OWNER", archivedAt: "2026-01-01" },
    ]);
    await expect(
      requireSharedGroup(manager, "owner", "group"),
    ).resolves.toMatchObject({ id: "group" });
    await expect(
      requireSharedGroup(manager, "owner", "group", "WRITE"),
    ).rejects.toThrow("Restore the archived group");
    await expect(
      requireSharedGroup(manager, "owner", "group", "OWNER", true),
    ).resolves.toMatchObject({ id: "group" });
  });
  it("hashes nested objects independently of property order but preserves array order", () => {
    expect(sharedFingerprint({ b: 2, a: { y: null, x: 1 } })).toBe(
      sharedFingerprint({ a: { x: 1, y: null }, b: 2 }),
    );
    expect(sharedFingerprint(["a", "b"])).not.toBe(
      sharedFingerprint(["b", "a"]),
    );
    expect(() => requireRevision(3, 2)).toThrow(
      "changed while you were editing",
    );
  });
  it("returns a committed response on a replay without executing effects again", async () => {
    const execute = jest.fn();
    query.mockResolvedValue([
      {
        payload_hash: sharedFingerprint({ amount: "100" }),
        result: { id: "created" },
      },
    ]);
    await expect(
      sharedCommand(
        manager,
        "owner",
        "group",
        "operation",
        { amount: "100" },
        execute,
      ),
    ).resolves.toEqual({ id: "created" });
    expect(execute).not.toHaveBeenCalled();
    expect(query).toHaveBeenCalledTimes(1);
  });
  it("refuses reuse of an operation ID with changed input before executing effects", async () => {
    const execute = jest.fn();
    query.mockResolvedValue([
      {
        payload_hash: sharedFingerprint({ amount: "100" }),
        result: { id: "created" },
      },
    ]);
    await expect(
      sharedCommand(
        manager,
        "owner",
        "group",
        "operation",
        { amount: "101" },
        execute,
      ),
    ).rejects.toThrow("different data");
    expect(execute).not.toHaveBeenCalled();
    expect(query).toHaveBeenCalledTimes(1);
  });
  it("writes the replay result only after execution succeeds, through the caller's manager", async () => {
    const events: string[] = [];
    query.mockImplementation(async (sql: string) => {
      events.push(
        sql.startsWith("UPDATE")
          ? "result"
          : sql.startsWith("INSERT")
            ? "receipt"
            : "lookup",
      );
      return [];
    });
    await sharedCommand(
      manager,
      "owner",
      "group",
      "operation",
      { amount: "100" },
      async () => {
        events.push("effect");
        return { id: "saved" };
      },
    );
    expect(events).toEqual(["lookup", "receipt", "effect", "result"]);
    expect(query.mock.calls[2][1]).toEqual([
      JSON.stringify({ id: "saved" }),
      "operation",
      "owner",
    ]);
  });
  it("propagates rejection to the caller's scoped transaction without storing a successful result", async () => {
    await expect(
      sharedCommand(manager, "owner", "group", "operation", {}, async () => {
        throw new Error("precondition failed");
      }),
    ).rejects.toThrow("precondition failed");
    expect(query.mock.calls.some(([sql]) => sql.startsWith("UPDATE"))).toBe(
      false,
    );
  });
  it.each([0, 2, 3, 4])(
    "uses registered currency precision %i",
    async (decimal_places) => {
      query.mockResolvedValue([{ decimal_places }]);
      expect(await currencyPlaces(manager, "XTS")).toBe(decimal_places);
    },
  );
  it.each([
    { rows: [] },
    { rows: [{ decimal_places: -1 }] },
    { rows: [{ decimal_places: 5 }] },
  ])(
    "refuses unavailable or unsupported currency precision %j",
    async ({ rows }) => {
      query.mockResolvedValue(rows);
      await expect(currencyPlaces(manager, "XTS")).rejects.toThrow(
        "available currency",
      );
    },
  );
});
