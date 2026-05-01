import { PostgresAdapter } from "./postgres.adapter";

describe("PostgresAdapter", () => {
  function makeAdapter(model = "AccessToken") {
    const repo = {
      upsert: jest.fn(),
      findOne: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    };
    const dataSource = {
      getRepository: jest.fn().mockReturnValue(repo),
    } as any;
    const adapter = new PostgresAdapter(model, dataSource);
    return { adapter, repo };
  }

  it("upserts a payload with the right grant_id for grantable models", async () => {
    const { adapter, repo } = makeAdapter("AccessToken");

    await adapter.upsert(
      "tok-1",
      { grantId: "grant-9", aud: "https://example/mcp" } as any,
      3600,
    );

    expect(repo.upsert).toHaveBeenCalledTimes(1);
    const [entity, options] = repo.upsert.mock.calls[0];
    expect(entity.id).toBe("tok-1");
    expect(entity.model).toBe("AccessToken");
    expect(entity.grantId).toBe("grant-9");
    expect(entity.expiresAt).toBeInstanceOf(Date);
    expect(options).toEqual({ conflictPaths: ["id", "model"] });
  });

  it("does not store grant_id for non-grantable models", async () => {
    const { adapter, repo } = makeAdapter("Client");

    await adapter.upsert("client-1", { grantId: "should-be-ignored" } as any, 0);

    const [entity] = repo.upsert.mock.calls[0];
    expect(entity.grantId).toBeNull();
    expect(entity.expiresAt).toBeNull();
  });

  it("returns undefined for expired payloads", async () => {
    const { adapter, repo } = makeAdapter("AccessToken");
    repo.findOne.mockResolvedValue({
      id: "tok",
      model: "AccessToken",
      payload: { foo: "bar" },
      expiresAt: new Date(Date.now() - 1000),
      consumedAt: null,
    });

    const result = await adapter.find("tok");

    expect(result).toBeUndefined();
  });

  it("returns the payload for non-expired rows and adds consumed claim when consumed", async () => {
    const { adapter, repo } = makeAdapter("AuthorizationCode");
    const consumedAt = new Date();
    repo.findOne.mockResolvedValue({
      id: "code",
      model: "AuthorizationCode",
      payload: { foo: "bar" },
      expiresAt: new Date(Date.now() + 60_000),
      consumedAt,
    });

    const result = await adapter.find("code");

    expect(result).toMatchObject({
      foo: "bar",
      consumed: Math.floor(consumedAt.getTime() / 1000),
    });
  });

  it("revokeByGrantId deletes by grant_id only (not scoped to model)", async () => {
    const { adapter, repo } = makeAdapter("AccessToken");

    await adapter.revokeByGrantId("grant-9");

    expect(repo.delete).toHaveBeenCalledWith({ grantId: "grant-9" });
  });

  it("destroy scopes deletion to the (id, model) tuple", async () => {
    const { adapter, repo } = makeAdapter("Session");

    await adapter.destroy("sess-1");

    expect(repo.delete).toHaveBeenCalledWith({
      id: "sess-1",
      model: "Session",
    });
  });

  it("consume sets consumed_at without removing the row", async () => {
    const { adapter, repo } = makeAdapter("AuthorizationCode");

    await adapter.consume("code-1");

    expect(repo.update).toHaveBeenCalledWith(
      { id: "code-1", model: "AuthorizationCode" },
      expect.objectContaining({ consumedAt: expect.any(Date) }),
    );
  });
});
