import { createHash } from "crypto";
import { DataSource, EntityManager } from "typeorm";
import { withScopedDb } from "../common/db/scoped-db";
import { EncryptionService } from "../common/encryption/encryption.service";
import { SharedInvitationsService } from "./shared-invitations.service";
import {
  requireSharedGroup,
  sharedParticipants,
  sharedCommand,
  sharedActivity,
} from "./shared-db";
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
  advanceSharedRevision: jest.fn(),
  sharedCommand: jest.fn((_m, _u, _g, _id, _dto, work) => work()),
}));

describe("Invitation token privacy and claim preconditions", () => {
  let query: jest.Mock;
  let service: SharedInvitationsService;
  let encrypt: jest.Mock;
  const invite = {
    id: "invite",
    groupId: "group",
    participantId: "anna",
    role: "EDITOR",
    groupName: "Trip",
    participantName: "Anna",
    email: null as string | null,
    consumedBy: null as string | null,
    consumed: false,
    available: true,
  };
  const user = {
    email: "anna@example.test",
    email_verified: true,
    is_active: true,
  };
  const command = { operationId: "operation", expectedRevision: 4 };
  const dto = {
    ...command,
    participantId: "anna",
    role: "EDITOR" as const,
    email: " Anna@Example.Test ",
  };
  const writes = () =>
    query.mock.calls.filter(([sql]) => /^(INSERT|UPDATE|DELETE)/.test(sql));
  const lookup = (sql: string) => {
    if (sql.includes("FROM shared_invitations WHERE token_hash"))
      return [invite];
    if (sql.includes("FROM users")) return [user];
    if (sql.includes("SELECT archived_at")) return [{ archived_at: null }];
    return [];
  };
  beforeEach(() => {
    jest.clearAllMocks();
    query = jest.fn().mockImplementation(async (sql) => lookup(sql));
    jest
      .mocked(withScopedDb)
      .mockImplementation((_s, work) =>
        work({ query } as unknown as EntityManager),
      );
    jest.mocked(requireSharedGroup).mockResolvedValue(sharedGroupFixture());
    jest
      .mocked(sharedParticipants)
      .mockResolvedValue(
        sharedPeopleFixture().map((p) =>
          p.id === "anna" ? { ...p, connected: false, role: null } : p,
        ),
      );
    encrypt = jest.fn().mockReturnValue("opaque-ciphertext");
    service = new SharedInvitationsService(
      {} as DataSource,
      {
        encrypt,
        decrypt: jest.fn().mockReturnValue("decrypted-token"),
      } as unknown as EncryptionService,
    );
  });
  it("stores only a token hash and encrypted replay value, with a normalized email restriction", async () => {
    expect(await service.create("owner", "group", dto)).toMatchObject({
      token: "decrypted-token",
      revision: 5,
    });
    const token = encrypt.mock.calls[0][0] as string;
    const hash = createHash("sha256").update(token).digest("hex");
    const insert = writes().find(([sql]) => sql.startsWith("INSERT"))!;
    expect(insert[1]).toEqual([
      expect.any(String),
      "group",
      "anna",
      "EDITOR",
      hash,
      "anna@example.test",
      "Trip",
      "Anna",
    ]);
    expect(JSON.stringify(query.mock.calls)).not.toContain(token);
    expect(writes()[0][0]).toContain("revoked_at = CURRENT_TIMESTAMP");
  });
  it("keeps an empty optional email unrestricted instead of binding the invite to an empty address", async () => {
    await service.create("owner", "group", { ...dto, email: "" });
    const insert = writes().find(([sql]) => sql.startsWith("INSERT"))!;
    expect(insert[1][5]).toBeNull();
  });
  it("replays the encrypted result without issuing or replacing an invitation", async () => {
    jest.mocked(sharedCommand).mockResolvedValueOnce({
      id: "invite",
      encryptedToken: "opaque-ciphertext",
      revision: 5,
    });
    expect(await service.create("owner", "group", dto)).toEqual({
      id: "invite",
      token: "decrypted-token",
      revision: 5,
    });
    expect(encrypt).not.toHaveBeenCalled();
    expect(writes()).toEqual([]);
  });
  it.each(["missing", "inactive", "connected"])(
    "refuses an invitation to a %s participant",
    async (kind) => {
      jest.mocked(sharedParticipants).mockResolvedValue(
        kind === "missing"
          ? []
          : sharedPeopleFixture().map((p) => ({
              ...p,
              isActive: kind !== "inactive",
              connected: kind === "connected",
            })),
      );
      await expect(service.create("owner", "group", dto)).rejects.toThrow();
      expect(writes()).toEqual([]);
    },
  );
  it("rejects stale issuance before replacing the existing invitation", async () => {
    await expect(
      service.create("owner", "group", { ...dto, expectedRevision: 1 }),
    ).rejects.toMatchObject({ status: 409 });
    expect(writes()).toEqual([]);
  });
  it("inspects only the proposed group identity and role", async () => {
    expect(await service.inspect("other", "token")).toEqual({
      groupName: "Trip",
      participantName: "Anna",
      role: "EDITOR",
      alreadyJoined: false,
    });
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("app.shared_invitation_hash"),
      [createHash("sha256").update("token").digest("hex")],
    );
    expect(writes()).toEqual([]);
  });
  it.each([
    "missing",
    "expired",
    "consumed",
    "inactive-user",
    "missing-user",
    "wrong-email",
    "unverified-email",
  ])(
    "refuses a %s claim before any financial or membership write",
    async (kind) => {
      query.mockImplementation(async (sql: string) => {
        if (sql.includes("FROM shared_invitations WHERE token_hash"))
          return kind === "missing"
            ? []
            : [
                {
                  ...invite,
                  available: kind !== "expired",
                  consumed: kind === "consumed",
                  consumedBy: kind === "consumed" ? "someone-else" : null,
                  email: kind.endsWith("email") ? "anna@example.test" : null,
                },
              ];
        if (sql.includes("FROM users"))
          return kind === "missing-user"
            ? []
            : [
                {
                  ...user,
                  is_active: kind !== "inactive-user",
                  email:
                    kind === "wrong-email"
                      ? "not-anna@example.test"
                      : user.email,
                  email_verified: kind !== "unverified-email",
                },
              ];
        return lookup(sql);
      });
      await expect(service.claim("other", "token")).rejects.toThrow();
      expect(writes()).toEqual([]);
    },
  );
  it("claims the existing participant and consumes the token without changing allocations", async () => {
    expect(await service.claim("other", "token")).toEqual({ id: "group" });
    expect(writes()).toHaveLength(2);
    expect(writes()[0][1]).toEqual(["group", "anna", "other", "EDITOR"]);
    expect(writes()[1][0]).toContain(
      "consumed_at IS NULL AND revoked_at IS NULL",
    );
    expect(sharedActivity).toHaveBeenCalledWith(
      expect.anything(),
      "other",
      "group",
      "MEMBER_JOINED",
      { participantId: "anna" },
    );
  });
  it("rechecks current membership on a repeat claim by the consuming person", async () => {
    query.mockImplementation(async (sql: string) =>
      sql.includes("FROM shared_invitations WHERE token_hash")
        ? [{ ...invite, consumed: true, consumedBy: "other" }]
        : lookup(sql),
    );
    expect(await service.claim("other", "token")).toEqual({ id: "group" });
    expect(requireSharedGroup).toHaveBeenCalledWith(
      expect.anything(),
      "other",
      "group",
    );
    expect(writes()).toEqual([]);
  });
  it.each(["archived", "missing-group", "member", "unique-race"])(
    "refuses a claim when %s wins before membership insertion",
    async (kind) => {
      query.mockImplementation(async (sql: string) => {
        if (sql.includes("SELECT archived_at"))
          return kind === "missing-group"
            ? []
            : [{ archived_at: kind === "archived" ? "2026-01-01" : null }];
        if (sql.includes("SELECT id FROM shared_memberships"))
          return kind === "member" ? [{ id: "existing" }] : [];
        if (
          sql.startsWith("INSERT INTO shared_memberships") &&
          kind === "unique-race"
        )
          throw Object.assign(new Error("unique"), { code: "23505" });
        return lookup(sql);
      });
      await expect(service.claim("other", "token")).rejects.toThrow();
      expect(sharedActivity).not.toHaveBeenCalled();
      expect(
        writes().filter(([sql]) => sql.includes("UPDATE shared_invitations")),
      ).toEqual([]);
    },
  );
  it("does not turn an unrelated storage failure into an invitation error", async () => {
    query.mockRejectedValue(new Error("storage failed"));
    await expect(service.claim("other", "token")).rejects.toThrow(
      "storage failed",
    );
  });
  it("lists owner-only invitation metadata without tokens or email targets", async () => {
    await service.list("owner", "group");
    expect(requireSharedGroup).toHaveBeenCalledWith(
      expect.anything(),
      "owner",
      "group",
      "OWNER",
      true,
    );
    const sql = query.mock.calls[0][0] as string;
    expect(sql).not.toContain("token_hash");
    expect(sql).not.toContain("target_email");
  });
  it.each([true, false])(
    "revokes only an invitation in this group: exists=%s",
    async (exists) => {
      query.mockResolvedValue(exists ? [{ id: "invite" }] : []);
      const result = service.revoke("owner", "group", "invite", command);
      if (exists) {
        expect(await result).toEqual({ id: "invite", revision: 5 });
        expect(writes()[0][1]).toEqual(["invite", "group"]);
      } else {
        await expect(result).rejects.toThrow();
        expect(writes()).toEqual([]);
      }
    },
  );
});
