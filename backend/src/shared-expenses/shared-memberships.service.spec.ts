import { DataSource, EntityManager } from "typeorm";
import { withScopedDb } from "../common/db/scoped-db";
import { SharedMembershipsService } from "./shared-memberships.service";
import {
  advanceSharedRevision,
  requireSharedGroup,
  sharedActivity,
} from "./shared-db";
import { sharedGroupFixture } from "./__fixtures__/shared-group";
import type { ChangeSharedMembershipDto } from "./dto/shared-group.dto";

jest.mock("../common/db/scoped-db", () => ({ withScopedDb: jest.fn() }));
jest.mock("./shared-db", () => ({
  ...jest.requireActual("./shared-db"),
  requireSharedGroup: jest.fn(),
  sharedActivity: jest.fn(),
  lockSharedGroup: jest.fn(),
  advanceSharedRevision: jest.fn(),
  sharedCommand: jest.fn((_m, _u, _g, _id, _dto, work) => work()),
}));

describe("Membership changes and recipient-owned handover consent", () => {
  let query: jest.Mock;
  let service: SharedMembershipsService;
  const command = { operationId: "operation", expectedRevision: 4 };
  const member = {
    id: "membership",
    user_id: "other",
    role: "EDITOR",
    active: true,
  };
  const request = {
    requestId: "request",
    participantId: "anna",
    accepted: false,
  };
  const change = (action: ChangeSharedMembershipDto["action"]) =>
    service.change("owner", "group", "anna", { ...command, action });
  const mutations = () =>
    query.mock.calls.filter(([sql]) => /^(UPDATE|INSERT|DELETE)/.test(sql));
  beforeEach(() => {
    jest.clearAllMocks();
    query = jest.fn().mockResolvedValue([member]);
    jest
      .mocked(withScopedDb)
      .mockImplementation((_s, work) =>
        work({ query } as unknown as EntityManager),
      );
    jest.mocked(requireSharedGroup).mockResolvedValue(sharedGroupFixture());
    service = new SharedMembershipsService({} as DataSource);
  });
  it.each([
    { rows: [] },
    { rows: [{ ...member, user_id: "owner" }] },
    { rows: [{ ...member, role: "OWNER" }] },
  ])(
    "refuses a missing, self or owner target without changing access",
    async ({ rows }) => {
      query.mockResolvedValue(rows);
      await expect(change("REVOKE")).rejects.toThrow();
      expect(mutations()).toEqual([]);
      expect(sharedActivity).not.toHaveBeenCalled();
    },
  );
  it.each(["REQUEST_OWNER", "TRANSFER_OWNER"] as const)(
    "refuses %s for an inactive participant",
    async (action) => {
      query.mockResolvedValue([{ ...member, active: false }]);
      await expect(change(action)).rejects.toThrow();
      expect(mutations()).toEqual([]);
    },
  );
  it("requests a new handover without changing the owner or granting consent", async () => {
    await change("REQUEST_OWNER");
    expect(mutations()).toHaveLength(1);
    expect(mutations()[0][0]).toContain("ownership_candidate_id");
    expect(mutations()[0][0]).not.toContain("owner_user_id");
    expect(sharedActivity).toHaveBeenCalledWith(
      expect.anything(),
      "owner",
      "group",
      "OWNERSHIP_REQUESTED",
      { participantId: "anna" },
    );
  });
  it.each([
    undefined,
    request,
    { ...request, accepted: true, participantId: "someone-else" },
  ])(
    "refuses a handover without this recipient's current consent",
    async (ownershipTransfer) => {
      jest
        .mocked(requireSharedGroup)
        .mockResolvedValue(sharedGroupFixture({ ownershipTransfer }));
      await expect(change("TRANSFER_OWNER")).rejects.toThrow();
      expect(mutations()).toEqual([]);
      expect(sharedActivity).not.toHaveBeenCalled();
    },
  );
  it("completes the agreed handover with the old owner retained as editor", async () => {
    jest.mocked(requireSharedGroup).mockResolvedValue(
      sharedGroupFixture({
        ownershipTransfer: { ...request, accepted: true },
      }),
    );
    expect(await change("TRANSFER_OWNER")).toEqual({ id: "anna", revision: 5 });
    expect(mutations().map(([sql]) => sql)).toEqual([
      expect.stringContaining("role = 'EDITOR'"),
      expect.stringContaining("role = 'OWNER'"),
      expect.stringContaining("ownership_request_id = NULL"),
    ]);
    expect(mutations()[2][1]).toEqual(["group", "other"]);
  });
  it("records access removal with its own event and cancels a pending ownership request", async () => {
    jest
      .mocked(requireSharedGroup)
      .mockResolvedValue(sharedGroupFixture({ ownershipTransfer: request }));
    await change("REVOKE");
    expect(sharedActivity).toHaveBeenCalledWith(
      expect.anything(),
      "owner",
      "group",
      "MEMBER_REVOKED",
      { participantId: "anna", action: "REVOKE" },
    );
    expect(mutations()[0][0]).toContain("ownership_request_id = NULL");
    expect(mutations()[1][1]).toEqual(["membership", "REVOKE"]);
    expect(advanceSharedRevision).toHaveBeenCalledWith(
      expect.anything(),
      "group",
      false,
    );
  });
  it.each(["EDITOR", "VIEWER"] as const)(
    "changes the target to %s without changing the financial revision",
    async (action) => {
      await change(action);
      expect(mutations()).toHaveLength(1);
      expect(mutations()[0][1]).toEqual(["membership", action]);
      expect(advanceSharedRevision).toHaveBeenCalledWith(
        expect.anything(),
        "group",
        false,
      );
    },
  );
  it("accepts only the request naming the caller's participant", async () => {
    jest.mocked(requireSharedGroup).mockResolvedValue(
      sharedGroupFixture({
        role: "EDITOR",
        myParticipantId: "anna",
        ownershipTransfer: request,
      }),
    );
    expect(
      await service.acceptOwnership("other", "group", "request", command),
    ).toEqual({ requestId: "request" });
    expect(mutations()[0][1]).toEqual(["group", "other", "request"]);
  });
  it.each(["wrong-request", "wrong-person"])(
    "refuses consent for %s",
    async (kind) => {
      jest.mocked(requireSharedGroup).mockResolvedValue(
        sharedGroupFixture({
          ownershipTransfer: request,
          myParticipantId: kind === "wrong-person" ? "me" : "anna",
        }),
      );
      await expect(
        service.acceptOwnership(
          "other",
          "group",
          kind === "wrong-request" ? "old" : "request",
          command,
        ),
      ).rejects.toThrow();
      expect(mutations()).toEqual([]);
    },
  );
  it("refuses stale consent before storing it", async () => {
    await expect(
      service.acceptOwnership("other", "group", "request", {
        ...command,
        expectedRevision: 1,
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(mutations()).toEqual([]);
  });
  it("changes only the caller's notification preference and keeps the notification boundary", async () => {
    expect(await service.mute("owner", "group", true)).toEqual({ muted: true });
    expect(mutations()[0][0]).toContain("muted IS DISTINCT FROM $3");
    expect(mutations()[0][1]).toEqual(["group", "owner", true]);
  });
  it("requires an owner to transfer ownership before leaving", async () => {
    await expect(service.leave("owner", "group")).rejects.toThrow();
    expect(mutations()).toEqual([]);
  });
  it("leaves the participant's history when a member leaves", async () => {
    jest
      .mocked(requireSharedGroup)
      .mockResolvedValue(
        sharedGroupFixture({ role: "EDITOR", myParticipantId: "anna" }),
      );
    expect(await service.leave("other", "group")).toEqual({ id: "group" });
    expect(mutations()).toHaveLength(1);
    expect(mutations()[0][0]).toContain("revoked_at = CURRENT_TIMESTAMP");
    expect(sharedActivity).toHaveBeenCalledWith(
      expect.anything(),
      "other",
      "group",
      "MEMBER_LEFT",
      { participantId: "anna" },
    );
  });
});
